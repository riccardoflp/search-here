import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { excludeGlobs } from './globs';
import { normalizeRgPath, runRg } from './rg';

/** A folder that can be picked to restrict the search: a workspace folder or a project found inside one. */
export interface Project {
  /** Absolute path of the project folder. */
  path: string;
  /** Workspace folder that contains it. */
  root: string;
  /** Shown in the selector: the folder name for workspace folders, else the workspace relative path. */
  name: string;
  kind: 'folder' | 'sub';
  /** The marker file that identified a sub-project (e.g. `package.json`). */
  marker?: string;
}

/** `Options.project` values besides an absolute project path. */
export const ALL_PROJECTS = '';
export const CURRENT_PROJECT = 'current';

export const DEFAULT_MARKERS = [
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  '*.csproj',
  'composer.json',
  'Gemfile',
  'pubspec.yaml',
  'mix.exs',
  '.git',
];

const MAX_PROJECTS = 1000;
const GIT_HEAD = '.git/HEAD';

function settings() {
  const config = vscode.workspace.getConfiguration('searchHere.projects');
  return {
    workspaceFolders: config.get('workspaceFolders', true),
    detect: config.get('detect', true),
    markers: config.get<string[]>('markers', DEFAULT_MARKERS).map((m) => m.trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean),
    followActiveFile: config.get('followActiveFile', true),
  };
}

export function followActiveFileEnabled(): boolean {
  return settings().followActiveFile;
}

function fileRoots(): vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
}

/** Path of `abs` relative to `root` with forward slashes; '' for the root itself; null if outside. */
function inside(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function isDir(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Turns a project reference into the absolute path of its folder, or null when it does not exist.
 * A reference is an absolute path, a workspace folder name, a path relative to a workspace folder
 * (`packages/api`), or both (`backend/packages/api`) in a multi-root workspace.
 */
export function resolveProjectRef(ref: string): string | null {
  if (!ref.trim()) return null;
  if (path.isAbsolute(ref)) return isDir(ref) ? path.normalize(ref) : null;
  const rel = ref.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const roots = fileRoots();
  for (const f of roots) {
    if (rel === f.name) return f.uri.fsPath;
    if (rel.startsWith(f.name + '/')) {
      const abs = path.join(f.uri.fsPath, rel.slice(f.name.length + 1));
      if (isDir(abs)) return abs;
    }
  }
  for (const f of roots) {
    const abs = path.join(f.uri.fsPath, rel);
    if (isDir(abs)) return abs;
  }
  return null;
}

/** How a project folder is shown and stored in workspace scopes: folder name or workspace relative path. */
export function projectLabel(abs: string): string {
  const roots = fileRoots();
  const folder = roots.find((f) => inside(f.uri.fsPath, abs) === '');
  if (folder) return folder.name;
  return vscode.workspace.asRelativePath(abs, roots.length > 1);
}

/** Simple glob test for one file name: `*` and `?` only, as used by marker and `requires` patterns. */
function nameMatches(pattern: string, name: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern === name;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(name);
}

/** True when `dir` contains one of the files or folders in `patterns` (names, simple globs, or relative paths). */
export function folderHasAny(dir: string, patterns: string[]): boolean {
  let names: string[] | undefined;
  for (const raw of patterns) {
    const p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!p) continue;
    if (p.includes('/') || !/[*?]/.test(p)) {
      if (fs.existsSync(path.join(dir, p))) return true;
      continue;
    }
    try {
      names ??= fs.readdirSync(dir);
    } catch {
      return false;
    }
    if (names.some((n) => nameMatches(p, n))) return true;
  }
  return false;
}

/**
 * The projects of the workspace: its folders (in a multi-root workspace) and the folders below them
 * that hold a marker file such as `package.json` or `.git` (`searchHere.projects.*`). The list is
 * built with one `rg --files` per workspace folder, honoring `.gitignore`, and rebuilt when a
 * marker file is created or deleted.
 */
export class ProjectIndex implements vscode.Disposable {
  /** The last list built; empty until the first one is ready. */
  snapshot: Project[] = [];
  private loading?: Promise<Project[]>;
  private refreshTimer?: NodeJS.Timeout;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fired when the list changes. */
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    const onFile = (uri: vscode.Uri) => {
      const p = uri.fsPath.replace(/\\/g, '/');
      const name = path.basename(p);
      if (p.endsWith('/' + GIT_HEAD) || settings().markers.some((m) => nameMatches(path.basename(m), name))) {
        this.invalidate();
      }
    };
    this.subs.push(
      watcher,
      watcher.onDidCreate(onFile),
      watcher.onDidDelete(onFile),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('searchHere.projects') || e.affectsConfiguration('searchHere.exclude')) this.invalidate();
      }),
    );
    void this.list();
  }

  list(): Promise<Project[]> {
    if (!this.loading) {
      const loading = this.detect().then(
        (list) => {
          if (this.loading === loading && JSON.stringify(list) !== JSON.stringify(this.snapshot)) {
            this.snapshot = list;
            this.emitter.fire();
          }
          return list;
        },
        () => this.snapshot,
      );
      this.loading = loading;
    }
    return this.loading;
  }

  /** Drops the list and builds it again shortly (several files often change at once). */
  invalidate(): void {
    this.loading = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.list(), 400);
  }

  /** The innermost project that contains `abs`. */
  containing(abs: string | null, list = this.snapshot): Project | undefined {
    if (!abs) return undefined;
    let best: Project | undefined;
    for (const p of list) {
      if (inside(p.path, abs) !== null && (!best || p.path.length > best.path.length)) best = p;
    }
    return best;
  }

  private async detect(): Promise<Project[]> {
    const { workspaceFolders, detect, markers } = settings();
    const roots = fileRoots();
    const out: Project[] = [];
    if (workspaceFolders && roots.length > 1) {
      for (const f of roots) out.push({ path: f.uri.fsPath, root: f.uri.fsPath, name: f.name, kind: 'folder' });
    }
    if (detect && markers.length) {
      for (const f of roots) {
        for (const sub of await this.detectIn(f, markers, roots.length > 1)) {
          if (out.length >= MAX_PROJECTS) break;
          if (!out.some((p) => p.path === sub.path)) out.push(sub);
        }
      }
    }
    return out;
  }

  private async detectIn(folder: vscode.WorkspaceFolder, markers: string[], multiRoot: boolean): Promise<Project[]> {
    const root = folder.uri.fsPath;
    const globs: string[] = [];
    let hidden = false;
    for (const m of markers) {
      if (m === '.git') {
        // A repository (`.git/HEAD`), or a submodule or worktree (a `.git` file).
        globs.push('.git', '**/' + GIT_HEAD);
      } else {
        globs.push(m.includes('/') ? '**/' + m : m);
      }
      if (m.startsWith('.')) hidden = true;
    }
    // Later globs win in ripgrep: skip what is inside .git and node_modules, then the user's exclusions.
    globs.push('!**/.git/*/', '!node_modules/');
    globs.push(...excludeGlobs(vscode.workspace.getConfiguration('searchHere', vscode.Uri.file(root)).get<string[]>('exclude', [])));

    const args = ['--files', '--no-config', '--no-require-git'];
    if (hidden) args.push('--hidden');
    for (const g of globs) args.push('-g', g);
    args.push('--', '.');

    const found = new Map<string, string>();
    await runRg(args, root, undefined, (line) => {
      if (!line) return;
      const rel = normalizeRgPath(line);
      let dir: string;
      let marker: string;
      if (rel === GIT_HEAD || rel.endsWith('/' + GIT_HEAD)) {
        dir = rel.slice(0, -GIT_HEAD.length).replace(/\/$/, '');
        marker = '.git';
      } else {
        dir = path.posix.dirname(rel);
        marker = path.posix.basename(rel);
        if (dir === '.') dir = '';
      }
      // The workspace folder itself is already "All projects"; dot folders hold tooling, not projects.
      if (!dir || dir.split('/').some((s) => s.startsWith('.'))) return;
      if (!found.has(dir)) found.set(dir, marker);
      return found.size < MAX_PROJECTS;
    });

    return [...found]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, marker]) => {
        const abs = path.join(root, dir);
        return { path: abs, root, name: multiRoot ? `${folder.name}/${dir}` : dir, kind: 'sub' as const, marker };
      });
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.subs.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}
