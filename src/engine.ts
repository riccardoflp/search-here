import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildIndexData, FileIndex, IndexData } from './fileIndex';
import { prepareQuery, rank } from './fuzzy';
import { excludeGlobs, includeGlobs, splitPatterns } from './globs';
import { MatchItem, Options, PathItem, ResultItem, ScopeDef, SearchStats, SymbolItem } from './protocol';
import { chunkPaths, normalizeRgPath, runRg, stderrSummary } from './rg';

/** Where to search inside one workspace root. */
interface Target {
  root: string;
  /** ignore / hidden / follow flags, shared by listing and text search. */
  flags: string[];
  globs: string[];
  /** Folders or files relative to root (empty = whole root). */
  paths: string[];
  /** When set, the exact list of files to search (already filtered). */
  files: string[] | null;
}

export type Sink = (items: ResultItem[]) => void;

const LIMITS = {
  allFolders: 50,
  allFiles: 100,
  allSymbols: 50,
  names: 2000,
  symbols: 500,
};

const MAX_LINE_DISPLAY = 240;

export class SearchEngine {
  /** Folder of the last focused text editor (the search view itself steals focus). */
  activeFolder: string | null = null;

  constructor(private readonly index: FileIndex) {}

  async search(opts: Options, scope: ScopeDef, sink: Sink, token: vscode.CancellationToken): Promise<SearchStats> {
    const started = Date.now();
    const stats: SearchStats = { matches: 0, files: 0, ms: 0, truncated: false };
    const query = opts.query;
    const targets = await this.targets(opts, scope);
    if (token.isCancellationRequested) return stats;
    if (!targets.length) {
      stats.warning = noTargetMessage(scope);
      return stats;
    }

    const wantNames = opts.mode === 'files' || opts.mode === 'folders' || opts.mode === 'all';
    const wantText = (opts.mode === 'text' || opts.mode === 'all') && query.length > 0;
    const wantSymbols = (opts.mode === 'symbols' || opts.mode === 'all') && query.trim().length > 0;

    const tasks: Promise<unknown>[] = [];
    if (wantNames && (query.trim() || opts.mode !== 'all')) {
      tasks.push(this.searchNames(opts, targets, sink, stats));
    }
    if (wantSymbols) {
      tasks.push(this.searchSymbols(opts, targets, sink, token));
    }
    if (wantText) {
      tasks.push(this.searchText(opts, targets, sink, stats, token));
    }
    const settled = await Promise.allSettled(tasks);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      stats.error = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
    }
    stats.ms = Date.now() - started;
    return stats;
  }

  // ---------------------------------------------------------------- targets

  private async targets(opts: Options, scope: ScopeDef): Promise<Target[]> {
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => f.uri.fsPath);
    if (!roots.length && this.activeFolder) {
      roots.push(this.activeFolder);
    }

    const config = vscode.workspace.getConfiguration('searchHere');
    const flags: string[] = [];
    // --no-require-git: honor .gitignore files even in folders that are not git repositories.
    flags.push(opts.respectIgnore ? '--no-require-git' : '--no-ignore');
    if (opts.hidden) flags.push('--hidden', '-g', '!.git');
    if (config.get('followSymlinks', false)) flags.push('--follow');

    const workInclude = includeGlobs(splitPatterns(opts.include));
    const scopeInclude = includeGlobs(scope.include);

    const explicit = await this.explicitFiles(scope.id);
    const targets: Target[] = [];

    for (const root of roots) {
      const rootUri = vscode.Uri.file(root);
      const negatives = excludeGlobs([
        ...splitPatterns(opts.exclude),
        ...scope.exclude,
        ...vscode.workspace.getConfiguration('searchHere', rootUri).get<string[]>('exclude', []),
      ]);
      if (opts.useVSCodeExcludes) {
        negatives.push(...vscodeExcludes(rootUri));
      }

      let paths: string[] = [];
      if (scope.id === 'activeFolder') {
        const rel = this.activeFolder ? relativeInside(root, this.activeFolder) : null;
        if (rel === null) continue;
        paths = rel ? [rel] : [];
      } else if (scope.paths.length) {
        paths = scope.paths
          .map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
          .filter((p) => p && fs.existsSync(path.join(root, p)));
        if (!paths.length) continue;
      }

      const primary = scopeInclude.length ? scopeInclude : workInclude;
      const globs = [...primary, ...negatives];
      const target: Target = { root, flags, globs, paths, files: null };

      // ripgrep ORs positive globs together and ignores globs for files passed explicitly,
      // so intersections are computed from cached listings instead.
      const needsIntersection = (scopeInclude.length > 0 && workInclude.length > 0) || explicit !== null;
      if (needsIntersection) {
        const base = await this.index.get(root, flags, globs, paths);
        let files = base.files;
        if (scopeInclude.length && workInclude.length) {
          const second = await this.index.get(root, flags, [...workInclude, ...negatives], paths);
          files = files.filter((f) => second.fileSet.has(f));
        }
        if (explicit) {
          const wanted = new Set<string>();
          for (const abs of explicit) {
            const rel = relativeInside(root, abs);
            if (rel) wanted.add(rel);
          }
          files = files.filter((f) => wanted.has(f));
        }
        target.files = files;
        if (!files.length) continue;
      }
      targets.push(target);
    }
    return targets;
  }

  private async explicitFiles(scopeId: string): Promise<string[] | null> {
    if (scopeId === 'open') {
      const files: string[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          let uri: vscode.Uri | undefined;
          if (input instanceof vscode.TabInputText) uri = input.uri;
          else if (input instanceof vscode.TabInputTextDiff) uri = input.modified;
          else if (input instanceof vscode.TabInputNotebook) uri = input.uri;
          if (uri?.scheme === 'file') files.push(uri.fsPath);
        }
      }
      return files;
    }
    if (scopeId === 'git') {
      return gitChangedFiles();
    }
    return null;
  }

  private async listing(t: Target): Promise<IndexData> {
    if (t.files) {
      return buildIndexData(t.files);
    }
    return this.index.get(t.root, t.flags, t.globs, t.paths);
  }

  // ---------------------------------------------------------------- names

  private async searchNames(opts: Options, targets: Target[], sink: Sink, stats: SearchStats): Promise<void> {
    const q = prepareQuery(opts.query);
    const all = opts.mode === 'all';
    const wantFiles = opts.mode !== 'folders';
    const wantFolders = opts.mode !== 'files';
    const multiRoot = targets.length > 1;

    type Entry = { root: string; rel: string; lower: string; display: string; displayLower: string };
    const files: Entry[] = [];
    const folders: Entry[] = [];
    for (const t of targets) {
      const data = await this.listing(t);
      if (data.truncated) stats.truncated = true;
      const prefix = multiRoot ? path.basename(t.root) + '/' : '';
      const push = (list: Entry[], rels: string[], lowers: string[]) => {
        for (let i = 0; i < rels.length; i++) {
          list.push({
            root: t.root,
            rel: rels[i],
            lower: lowers[i],
            display: prefix + rels[i],
            displayLower: prefix ? (prefix + rels[i]).toLowerCase() : lowers[i],
          });
        }
      };
      if (wantFiles) push(files, data.files, data.filesLower);
      if (wantFolders) push(folders, data.folders, data.foldersLower);
    }

    const toItem = (kind: 'file' | 'folder', e: Entry, hl: number[]): PathItem => ({
      kind,
      path: path.join(e.root, e.rel),
      rel: e.display,
      hl,
    });

    const items: PathItem[] = [];
    const run = (kind: 'file' | 'folder', list: Entry[], limit: number) => {
      if (!q.terms.length) {
        items.push(...list.slice(0, limit).map((e) => toItem(kind, e, [])));
        return;
      }
      const { results } = rank(q, list, (e) => e.display, (e) => e.displayLower, limit, all);
      items.push(...results.map((r) => toItem(kind, r.item, r.match.positions)));
    };
    if (wantFolders) run('folder', folders, all ? LIMITS.allFolders : LIMITS.names);
    if (wantFiles) run('file', files, all ? LIMITS.allFiles : LIMITS.names);
    if (opts.mode !== 'all') {
      stats.matches += items.length;
    }
    sink(items);
  }

  // ---------------------------------------------------------------- symbols

  private async searchSymbols(opts: Options, targets: Target[], sink: Sink, token: vscode.CancellationToken): Promise<void> {
    const query = opts.query.trim();
    const symbols = await Promise.race([
      vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query),
      new Promise<vscode.SymbolInformation[]>((resolve) => setTimeout(() => resolve([]), 4000)),
    ]);
    if (token.isCancellationRequested || !symbols?.length) return;

    const listings = await Promise.all(targets.map(async (t) => ({ t, data: await this.listing(t) })));
    const q = prepareQuery(query);
    const candidates: { s: vscode.SymbolInformation; rel: string }[] = [];
    for (const s of symbols) {
      if (s.location.uri.scheme !== 'file') continue;
      const abs = s.location.uri.fsPath;
      for (const { t, data } of listings) {
        const rel = relativeInside(t.root, abs);
        if (rel && data.fileSet.has(rel)) {
          candidates.push({ s, rel: vscode.workspace.asRelativePath(abs, targets.length > 1) });
          break;
        }
      }
    }
    const limit = opts.mode === 'all' ? LIMITS.allSymbols : LIMITS.symbols;
    const { results } = rank(q, candidates, (c) => c.s.name, (c) => c.s.name.toLowerCase(), limit);
    sink(
      results.map<SymbolItem>(({ item: { s, rel }, match }) => ({
        kind: 'symbol',
        path: s.location.uri.fsPath,
        rel,
        name: s.name,
        container: s.containerName,
        symbolKind: s.kind,
        line: s.location.range.start.line,
        col: s.location.range.start.character,
        hl: match.positions,
      })),
    );
  }

  // ---------------------------------------------------------------- text

  private async searchText(
    opts: Options,
    targets: Target[],
    sink: Sink,
    stats: SearchStats,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('searchHere');
    const maxResults = config.get('maxResults', 5000);
    const multiRoot = targets.length > 1;

    const common = ['--json', '--no-config', '--max-filesize', config.get('maxFileSize', '10M')];
    common.push(opts.caseSensitive ? '--case-sensitive' : '--ignore-case');
    if (opts.wholeWord) common.push('--word-regexp');
    if (opts.regex) common.push('--engine', 'auto');
    else common.push('--fixed-strings');

    let buffer: ResultItem[] = [];
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (buffer.length) {
        sink(buffer);
        buffer = [];
      }
    };
    const seenFiles = new Set<string>();
    const warnings: string[] = [];

    for (const t of targets) {
      const base = [...common, ...t.flags];
      for (const g of t.globs) base.push('-g', g);
      base.push('-e', opts.query, '--');
      const runs = t.files ? chunkPaths(t.files) : [t.paths.length ? t.paths : ['.']];

      for (const paths of runs) {
        if (token.isCancellationRequested || stats.truncated) break;
        const run = await runRg([...base, ...paths], t.root, token, (line) => {
          const item = parseMatch(line, t.root, multiRoot);
          if (!item) return;
          if (!seenFiles.has(item.path)) {
            seenFiles.add(item.path);
            stats.files++;
          }
          stats.matches++;
          buffer.push(item);
          if (buffer.length >= 400) flush();
          else if (!timer) timer = setTimeout(flush, 40);
          if (stats.matches >= maxResults) {
            stats.truncated = true;
            return false;
          }
        });
        // Exit code 2 with output means some files could not be read; without output it's a real error.
        if (run.code === 2 && !run.stopped) {
          const msg = stderrSummary(run.stderr);
          if (msg && stats.matches === 0 && /regex|parse|syntax/i.test(msg)) {
            throw new Error(opts.regex ? `Invalid regular expression: ${msg}` : msg);
          }
          if (msg) warnings.push(msg);
        }
      }
    }
    flush();
    if (warnings.length && !stats.warning) {
      stats.warning = warnings[0];
    }
  }
}

interface RgMatch {
  type: string;
  data: {
    path: { text?: string; bytes?: string };
    lines: { text?: string; bytes?: string };
    line_number: number;
    submatches: { start: number; end: number }[];
  };
}

function decode(field: { text?: string; bytes?: string }): string {
  return field.text ?? Buffer.from(field.bytes ?? '', 'base64').toString('utf8');
}

function parseMatch(line: string, root: string, multiRoot: boolean): MatchItem | undefined {
  if (!line.startsWith('{"type":"match"')) return undefined;
  let msg: RgMatch;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }
  const d = msg.data;
  const rel = normalizeRgPath(decode(d.path));
  let text = decode(d.lines).replace(/\r?\n$/, '');

  // rg reports byte offsets; convert them to UTF-16 offsets unless the line is ASCII.
  let ranges: [number, number][];
  const buf = Buffer.from(text, 'utf8');
  if (buf.length === text.length) {
    ranges = d.submatches.map((m) => [m.start, m.end]);
  } else {
    const toChar = (byte: number) => buf.subarray(0, byte).toString('utf8').length;
    ranges = d.submatches.map((m) => [toChar(m.start), toChar(m.end)]);
  }

  // Display slice: drop indentation and keep long lines around the first match.
  const first = ranges[0]?.[0] ?? 0;
  let offset = Math.min(text.length - text.trimStart().length, first);
  let cut = false;
  if (text.length - offset > MAX_LINE_DISPLAY && first - 60 > offset) {
    offset = first - 60;
    cut = true;
  }
  text = text.slice(offset, offset + MAX_LINE_DISPLAY);

  const abs = path.join(root, rel);
  return {
    kind: 'match',
    path: abs,
    rel: multiRoot ? path.basename(root) + '/' + rel : rel,
    line: d.line_number - 1,
    text,
    offset,
    cut,
    ranges,
  };
}

/** files.exclude + search.exclude entries that are simply `true` (conditional ones are skipped). */
function vscodeExcludes(rootUri: vscode.Uri): string[] {
  const globs: string[] = [];
  for (const section of ['files', 'search']) {
    const map = vscode.workspace.getConfiguration(section, rootUri).get<Record<string, unknown>>('exclude', {});
    for (const [glob, value] of Object.entries(map)) {
      if (value === true) globs.push('!' + glob.replace(/^\.\//, ''));
    }
  }
  return [...new Set(globs)];
}

/** Path of `abs` relative to `root` with forward slashes; '' for the root itself; null if outside. */
export function relativeInside(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

interface GitChange {
  uri: vscode.Uri;
}
interface GitRepository {
  state: {
    workingTreeChanges: GitChange[];
    indexChanges: GitChange[];
    mergeChanges: GitChange[];
    untrackedChanges?: GitChange[];
  };
}

async function gitChangedFiles(): Promise<string[]> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): { repositories: GitRepository[] } }>('vscode.git');
  if (!ext) return [];
  const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  const files = new Set<string>();
  for (const repo of api.repositories) {
    const s = repo.state;
    for (const change of [...s.workingTreeChanges, ...s.indexChanges, ...s.mergeChanges, ...(s.untrackedChanges ?? [])]) {
      files.add(change.uri.fsPath);
    }
  }
  return [...files];
}

function noTargetMessage(scope: ScopeDef): string {
  switch (scope.id) {
    case 'open':
      return 'No open file matches the filters.';
    case 'git':
      return 'No changed files (or the Git repository has not loaded yet).';
    case 'activeFolder':
      return 'Open a file of the project to use "Active Folder".';
    default:
      return vscode.workspace.workspaceFolders?.length
        ? 'No file matches this scope.'
        : 'Open a folder or a workspace to search.';
  }
}
