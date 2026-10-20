import * as fs from 'fs';
import * as vscode from 'vscode';
import { relativeInside, SearchEngine } from './engine';
import { patternForPath, splitPatterns } from './globs';
import { DirEntry, FromWebview, Options, PreviewData, ScopeDef, ToWebview } from './protocol';
import { Store } from './state';

export interface Services {
  ctx: vscode.ExtensionContext;
  store: Store;
  engine: SearchEngine;
}

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_DIR_ENTRIES = 1000;

/**
 * Drives one search webview (the editor tab or the bottom panel view): answers its
 * messages, runs searches and streams the results back.
 */
export class SearchController implements vscode.Disposable {
  private search?: vscode.CancellationTokenSource;
  private readonly subs: vscode.Disposable[] = [];
  private ready = false;
  private pendingFocus?: { query?: string };

  constructor(
    private readonly webview: vscode.Webview,
    private readonly services: Services,
    /** Editor column where files are opened by default. */
    private readonly openColumn: () => vscode.ViewColumn,
    /** Called with the query of every search (editor tabs show it in their title). */
    private readonly onQuery?: (query: string) => void,
  ) {
    const dist = vscode.Uri.joinPath(services.ctx.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = this.html(dist);
    this.subs.push(
      webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg)),
      services.store.onDidChange((e) => {
        if (e.options) this.post({ type: 'options', options: services.store.options, rerun: !!e.rerun });
        if (e.scopes) this.post({ type: 'scopes', scopes: services.store.scopes() });
      }),
    );
  }

  focus(query?: string): void {
    if (this.ready) this.post({ type: 'focus', query });
    else this.pendingFocus = { query };
  }

  /** Replaces this view's options (e.g. when a search moves between the panel and a tab) and searches. */
  load(options: Options): void {
    if (this.ready) this.post({ type: 'options', options, rerun: true });
  }

  notifyActiveFolder(): void {
    this.post({ type: 'activeFolder', rel: this.activeFolderLabel() });
  }

  private post(msg: ToWebview): void {
    void this.webview.postMessage(msg);
  }

  private activeFolderLabel(): string | null {
    const dir = this.services.engine.activeFolder;
    return dir ? vscode.workspace.asRelativePath(dir, true) : null;
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    const { store } = this.services;
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.post({ type: 'init', options: store.options, scopes: store.scopes(), activeFolder: this.activeFolderLabel() });
        if (this.pendingFocus) {
          this.post({ type: 'focus', ...this.pendingFocus });
          this.pendingFocus = undefined;
        }
        break;
      case 'options':
        await store.setOptions(msg.options);
        break;
      case 'search':
        await store.setOptions(msg.options);
        await this.runSearch(msg.searchId);
        break;
      case 'preview':
        this.post({ type: 'preview', reqId: msg.reqId, data: await readPreview(msg.path, msg.folder) });
        break;
      case 'open':
        await this.open(msg);
        break;
      case 'reveal':
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.path));
        break;
      case 'copyPath':
        await vscode.env.clipboard.writeText(msg.relative ? vscode.workspace.asRelativePath(msg.path) : msg.path);
        vscode.window.setStatusBarMessage('Path copied', 2000);
        break;
      case 'searchIn': {
        const rel = vscode.workspace.asRelativePath(msg.path, false);
        await store.setOptions({ include: patternForPath(rel, msg.folder), scopeId: 'project' }, { rerun: true });
        break;
      }
      case 'saveScope':
        await saveCurrentAsScope(this.services, this.services.engine.activeFolder);
        break;
      case 'editScope':
        await editScope(this.services, msg.id);
        break;
      case 'deleteScope': {
        const scope = store.scope(msg.id);
        const ok = await vscode.window.showWarningMessage(`Delete the scope "${scope.name}"?`, { modal: true }, 'Delete');
        if (ok) await store.deleteScope(msg.id);
        break;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'searchHere');
        break;
    }
  }

  private async runSearch(searchId: number): Promise<void> {
    this.search?.cancel();
    this.search?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.search = cts;
    const { store, engine } = this.services;
    const options = store.options;
    this.onQuery?.(options.query);
    try {
      const stats = await engine.search(
        options,
        store.scope(options.scopeId),
        (items) => {
          if (!cts.token.isCancellationRequested) this.post({ type: 'results', searchId, items });
        },
        cts.token,
      );
      if (!cts.token.isCancellationRequested) this.post({ type: 'done', searchId, stats });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.post({ type: 'done', searchId, stats: { matches: 0, files: 0, ms: 0, truncated: false, error } });
    }
  }

  private async open(msg: Extract<FromWebview, { type: 'open' }>): Promise<void> {
    const uri = vscode.Uri.file(msg.path);
    if (msg.folder) {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    const viewColumn = msg.side ? vscode.ViewColumn.Beside : this.openColumn();
    const selection =
      msg.line !== undefined
        ? new vscode.Range(msg.line, msg.col ?? 0, msg.line, msg.endCol ?? msg.col ?? 0)
        : undefined;
    try {
      await vscode.window.showTextDocument(uri, { viewColumn, selection, preview: false });
    } catch {
      // Not a text document (image, PDF…): let VS Code pick the editor.
      await vscode.commands.executeCommand('vscode.open', uri, { viewColumn });
    }
  }

  private html(dist: vscode.Uri): string {
    const w = this.webview;
    const uri = (p: string) => w.asWebviewUri(vscode.Uri.joinPath(dist, p)).toString();
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; font-src ${w.cspSource}; img-src ${w.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons/codicon.css')}">
<link rel="stylesheet" href="${uri('webview.css')}">
<title>Search Here</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.search?.cancel();
    this.search?.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}

async function readPreview(abs: string, folder: boolean): Promise<PreviewData> {
  const rel = vscode.workspace.asRelativePath(abs, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
  try {
    const stat = await fs.promises.stat(abs);
    if (stat.isDirectory() || folder) {
      const dirents = await fs.promises.readdir(abs, { withFileTypes: true });
      const entries: DirEntry[] = dirents
        .map((d) => ({ name: d.name, dir: d.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return {
        kind: 'folder',
        path: abs,
        rel,
        entries: entries.slice(0, MAX_DIR_ENTRIES),
        truncated: entries.length > MAX_DIR_ENTRIES,
      };
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs);
    if (open?.isDirty) {
      return { kind: 'file', path: abs, rel, content: open.getText() };
    }
    if (stat.size > MAX_PREVIEW_BYTES) {
      return { kind: 'error', path: abs, rel, message: `File too large to preview (${(stat.size / 1048576).toFixed(1)} MB).` };
    }
    const buf = await fs.promises.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) {
      return { kind: 'error', path: abs, rel, message: 'Binary file: no preview available.' };
    }
    return { kind: 'file', path: abs, rel, content: buf.toString('utf8').replace(/^﻿/, '') };
  } catch (err) {
    return { kind: 'error', path: abs, rel, message: err instanceof Error ? err.message : String(err) };
  }
}

async function saveCurrentAsScope(services: Services, activeFolder: string | null): Promise<void> {
  const { store } = services;
  const options = store.options;
  const current = store.scope(options.scopeId);
  const include = splitPatterns(options.include);
  const exclude = splitPatterns(options.exclude);

  let paths = [...current.paths];
  if (current.id === 'activeFolder' && activeFolder) {
    const root = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(activeFolder));
    const rel = root ? relativeInside(root.uri.fsPath, activeFolder) : null;
    if (rel) paths = [rel];
  }
  if (!include.length && !exclude.length && !paths.length && current.kind === 'builtin') {
    const go = await vscode.window.showInformationMessage(
      'There are no filters to save: this scope would search the whole project. Save it anyway?',
      'Save',
    );
    if (!go) return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Save as Scope',
    prompt: describeScope(paths, include.length ? include : current.include, [...current.exclude, ...exclude]),
    placeHolder: 'Tab name, e.g. "Backend" or "Tests only"',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
  });
  if (!name) return;
  const where = await vscode.window.showQuickPick(
    [
      { label: '$(bookmark) This project', description: 'saved in the workspace', target: 'workspace' as const },
      { label: '$(globe) All projects', description: 'saved for the user', target: 'global' as const },
    ],
    { title: `Where should "${name.trim()}" be saved?` },
  );
  if (!where) return;

  const scope: ScopeDef = {
    id: `${where.target}:${Date.now().toString(36)}`,
    name: name.trim(),
    kind: where.target,
    icon: '',
    paths,
    include: include.length ? include : current.include,
    exclude: [...new Set([...current.exclude, ...exclude])],
  };
  await store.saveScope(scope);
  await store.setOptions({ scopeId: scope.id, include: '', exclude: '' }, { rerun: true });
}

async function editScope(services: Services, id: string): Promise<void> {
  const { store } = services;
  const scope = store.scope(id);
  if (scope.kind === 'settings') {
    await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
    return;
  }
  if (scope.kind === 'builtin') return;

  const ask = async (title: string, value: string, placeHolder: string) =>
    vscode.window.showInputBox({ title: `Edit "${scope.name}" — ${title}`, value, placeHolder, prompt: 'Comma separated' });
  const name = await vscode.window.showInputBox({ title: `Edit "${scope.name}" — name`, value: scope.name });
  if (name === undefined) return;
  const paths = await ask('folders/files to search in', scope.paths.join(', '), 'empty = whole project, e.g. src, docs/api');
  if (paths === undefined) return;
  const include = await ask('include', scope.include.join(', '), 'e.g. *.ts, ./src/');
  if (include === undefined) return;
  const exclude = await ask('exclude', scope.exclude.join(', '), 'e.g. **/*.test.ts, dist/');
  if (exclude === undefined) return;

  await store.saveScope({
    ...scope,
    name: name.trim() || scope.name,
    paths: splitPatterns(paths),
    include: splitPatterns(include),
    exclude: splitPatterns(exclude),
  });
  if (store.options.scopeId === id) {
    await store.setOptions({}, { rerun: true });
  }
}

function describeScope(paths: string[], include: string[], exclude: string[]): string {
  const parts: string[] = [];
  parts.push(paths.length ? `Folders: ${paths.join(', ')}` : 'Whole project');
  if (include.length) parts.push(`Include: ${include.join(', ')}`);
  if (exclude.length) parts.push(`Exclude: ${exclude.join(', ')}`);
  return parts.join(' · ');
}

export function columnBesides(column: vscode.ViewColumn | undefined): vscode.ViewColumn {
  // Prefer an editor group other than the one hosting the search tab.
  const groups = vscode.window.tabGroups.all;
  const other = groups.find((g) => g.viewColumn !== column);
  return other ? other.viewColumn : vscode.ViewColumn.Active;
}
