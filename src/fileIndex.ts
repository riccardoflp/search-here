import * as vscode from 'vscode';
import { normalizeRgPath, runRg } from './rg';

export interface IndexData {
  /** Root relative paths with forward slashes. */
  files: string[];
  filesLower: string[];
  fileSet: Set<string>;
  folders: string[];
  foldersLower: string[];
  truncated: boolean;
}

const MAX_FILES = 1_000_000;

export function buildIndexData(files: string[], truncated = false): IndexData {
  const folderSet = new Set<string>();
  for (const f of files) {
    let i = f.lastIndexOf('/');
    while (i > 0) {
      const dir = f.slice(0, i);
      if (folderSet.has(dir)) break;
      folderSet.add(dir);
      i = dir.lastIndexOf('/');
    }
  }
  const folders = [...folderSet].sort();
  return {
    files,
    filesLower: files.map((f) => f.toLowerCase()),
    fileSet: new Set(files),
    folders,
    foldersLower: folders.map((f) => f.toLowerCase()),
    truncated,
  };
}

/**
 * Cached `rg --files` listings. Folders are derived from the file paths, so they follow the
 * same ignore/include/exclude rules. Created or deleted files invalidate the cache.
 */
export class FileIndex implements vscode.Disposable {
  private readonly cache = new Map<string, Promise<IndexData>>();
  private readonly watcher: vscode.FileSystemWatcher;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    this.watcher.onDidCreate(() => this.invalidate());
    this.watcher.onDidDelete(() => this.invalidate());
  }

  invalidate(): void {
    this.cache.clear();
  }

  get(root: string, flags: string[], globs: string[], paths: string[]): Promise<IndexData> {
    const key = JSON.stringify([root, flags, globs, paths]);
    let entry = this.cache.get(key);
    if (!entry) {
      entry = this.build(root, flags, globs, paths);
      entry.catch(() => this.cache.delete(key));
      this.cache.set(key, entry);
      // Keep the cache small: listings for big trees can weigh tens of MB.
      if (this.cache.size > 12) {
        this.cache.delete(this.cache.keys().next().value!);
      }
    }
    return entry;
  }

  private async build(root: string, flags: string[], globs: string[], paths: string[]): Promise<IndexData> {
    const files: string[] = [];
    const args = ['--files', '--no-config', ...flags];
    for (const g of globs) args.push('-g', g);
    args.push('--', ...(paths.length ? paths : ['.']));
    const run = await runRg(args, root, undefined, (line) => {
      if (line) files.push(normalizeRgPath(line));
      return files.length < MAX_FILES;
    });
    files.sort();
    return buildIndexData(files, run.stopped);
  }

  dispose(): void {
    this.watcher.dispose();
    this.cache.clear();
  }
}
