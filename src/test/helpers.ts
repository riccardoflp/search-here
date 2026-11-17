import * as path from 'path';
import * as vscode from 'vscode';
import type { SearchHereApi } from '../extension';
import type { Options, ResultItem, SearchStats } from '../protocol';

export const EXTENSION_ID = 'RiccardoFilippozzi.search-here';

export async function api(): Promise<SearchHereApi> {
  const ext = vscode.extensions.getExtension<SearchHereApi>(EXTENSION_ID);
  if (!ext) throw new Error(`${EXTENSION_ID} is not loaded`);
  return ext.activate();
}

export function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('The tests need the test-fixtures/workspace folder open');
  return folder.uri.fsPath;
}

export function fixture(...parts: string[]): string {
  return path.join(workspaceRoot(), ...parts);
}

export const DEFAULTS: Options = {
  query: '',
  mode: 'all',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  respectIgnore: true,
  useVSCodeExcludes: true,
  hidden: false,
  include: '',
  exclude: '',
  scopeId: 'project',
  project: '',
};

export interface Run {
  items: ResultItem[];
  stats: SearchStats;
  /** Workspace relative paths of the text matches, sorted and without duplicates. */
  textFiles: string[];
  files: string[];
  folders: string[];
}

export async function search(patch: Partial<Options>): Promise<Run> {
  const { engine, store } = await api();
  const options = { ...DEFAULTS, ...patch };
  const items: ResultItem[] = [];
  const cts = new vscode.CancellationTokenSource();
  const stats = await engine.search(options, store.scope(options.scopeId), (batch) => items.push(...batch), cts.token);
  cts.dispose();
  const rels = (kind: ResultItem['kind']) => [...new Set(items.filter((i) => i.kind === kind).map((i) => i.rel))].sort();
  return { items, stats, textFiles: rels('match'), files: rels('file'), folders: rels('folder') };
}

/** Webview tabs of the search view that are open in the editor area. */
export function searchTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('searchHere.editor'));
}

export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check` returns true (VS Code applies some UI changes asynchronously). */
export async function waitFor(check: () => boolean, what: string, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}
