// Types shared by the extension host and the webview.

export type Mode = 'all' | 'text' | 'files' | 'folders' | 'symbols';

export interface Options {
  query: string;
  mode: Mode;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Respect .gitignore / .ignore / .rgignore. */
  respectIgnore: boolean;
  /** Apply VS Code's files.exclude and search.exclude. */
  useVSCodeExcludes: boolean;
  hidden: boolean;
  /** Comma separated patterns, exactly as typed. */
  include: string;
  exclude: string;
  scopeId: string;
  /**
   * Project the search is restricted to: '' all of them, 'current' the one of the active file,
   * else the absolute path of its folder.
   */
  project: string;
}

export type ScopeKind = 'builtin' | 'workspace' | 'global' | 'settings';

export interface ScopeDef {
  id: string;
  name: string;
  kind: ScopeKind;
  icon: string;
  /** Folders or files, relative to the workspace root. Empty = the whole root. */
  paths: string[];
  include: string[];
  exclude: string[];
  /**
   * Project the scope always searches in (its paths are relative to it): an absolute path, a
   * workspace folder name or a workspace relative path.
   */
  project?: string;
  /** Show the scope only in projects that contain one of these files (e.g. `package.json`). */
  requires?: string[];
  /** Display name of `project`, filled in by the extension. */
  projectLabel?: string;
}

/** The project selector of the search view. */
export interface ProjectView {
  label: string;
  tooltip: string;
  /** The active scope is bound to a project, which wins over the selector. */
  locked: boolean;
}

interface ItemBase {
  /** Absolute file system path. */
  path: string;
  /** Workspace relative path with forward slashes. */
  rel: string;
}

export interface PathItem extends ItemBase {
  kind: 'file' | 'folder';
  /** Highlighted character indexes in `rel`. */
  hl: number[];
}

export interface MatchItem extends ItemBase {
  kind: 'match';
  /** 0-based line number. */
  line: number;
  /** Displayed slice of the line, starting at `offset` in the original line. */
  text: string;
  offset: number;
  /** True when the displayed text was cut beyond the indentation. */
  cut: boolean;
  /** Match ranges (UTF-16) in the original line. */
  ranges: [number, number][];
}

export interface SymbolItem extends ItemBase {
  kind: 'symbol';
  name: string;
  container: string;
  symbolKind: number;
  line: number;
  col: number;
  hl: number[];
}

export type ResultItem = PathItem | MatchItem | SymbolItem;

export interface SearchStats {
  matches: number;
  files: number;
  ms: number;
  truncated: boolean;
  error?: string;
  warning?: string;
}

export interface DirEntry {
  name: string;
  dir: boolean;
}

/**
 * Bits of a token style holding the index of its color in the theme CSS (`.mtk<index>`); the
 * font style is above them (1 italic, 2 bold, 4 underline, 8 strikethrough).
 */
export const STYLE_COLOR_BITS = 9;

export type PreviewData =
  | {
      kind: 'file';
      path: string;
      rel: string;
      content: string;
      /**
       * Syntax tokens of each line, as pairs of start column and style; missing when no grammar
       * applies, and lines past its end are not tokenized.
       */
      tokens?: number[][];
    }
  | { kind: 'folder'; path: string; rel: string; entries: DirEntry[]; truncated: boolean }
  | { kind: 'error'; path: string; rel: string; message: string };

export type ToWebview =
  | { type: 'init'; options: Options; scopes: ScopeDef[]; activeFolder: string | null }
  | { type: 'options'; options: Options; rerun: boolean }
  | { type: 'scopes'; scopes: ScopeDef[] }
  | { type: 'activeFolder'; rel: string | null }
  /** null hides the selector (nothing to choose from). */
  | { type: 'project'; project: ProjectView | null }
  | { type: 'results'; searchId: number; items: ResultItem[] }
  | { type: 'done'; searchId: number; stats: SearchStats }
  | { type: 'preview'; reqId: number; data: PreviewData }
  | { type: 'focus'; query?: string }
  /** Token colors of the active color theme, as CSS; previews tokenized before it are out of date. */
  | { type: 'syntax'; css: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'search'; searchId: number; options: Options }
  | { type: 'options'; options: Options }
  | { type: 'preview'; reqId: number; path: string; folder: boolean }
  | { type: 'open'; path: string; line?: number; col?: number; endCol?: number; side?: boolean; folder?: boolean }
  | { type: 'reveal'; path: string }
  | { type: 'copyPath'; path: string; relative: boolean }
  | { type: 'searchIn'; path: string; folder: boolean }
  | { type: 'saveScope' }
  | { type: 'editScope'; id: string }
  | { type: 'deleteScope'; id: string }
  | { type: 'pickProject' }
  | { type: 'openSettings' };
