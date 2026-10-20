import hljs from 'highlight.js/lib/common';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import type {
  FromWebview,
  MatchItem,
  Mode,
  Options,
  PathItem,
  PreviewData,
  ResultItem,
  ScopeDef,
  SearchStats,
  SymbolItem,
  ToWebview,
} from '../src/protocol';

hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('dockerfile', dockerfile);

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();
const post = (msg: FromWebview) => vscode.postMessage(msg);

// ====================================================================== state

const MODES: { id: Mode; label: string; icon: string; hint: string }[] = [
  { id: 'all', label: 'All', icon: 'search', hint: 'Folders, files, symbols and text' },
  { id: 'text', label: 'Text', icon: 'symbol-string', hint: 'File contents' },
  { id: 'files', label: 'Files', icon: 'file', hint: 'File names (fuzzy)' },
  { id: 'folders', label: 'Folders', icon: 'folder', hint: 'Folder names (fuzzy)' },
  { id: 'symbols', label: 'Symbols', icon: 'symbol-class', hint: 'Classes, functions, variables… from language servers' },
];

const SECTION_LIMITS: Record<string, number> = { folders: 5, files: 10, symbols: 8 };
const ROW_HEIGHT = 22;

interface Group {
  path: string;
  rel: string;
  matches: MatchItem[];
}

type Row =
  | { t: 'section'; key: string; label: string; count: string }
  | { t: 'more'; key: string; section: string; hidden: number }
  | { t: 'group'; key: string; g: Group }
  | { t: 'item'; key: string; item: ResultItem };

let options: Options;
let scopes: ScopeDef[] = [];
let activeFolder: string | null = null;

let searchId = 0;
let searching = false;
let staleResults = false;
let stats: SearchStats | null = null;

let folders: PathItem[] = [];
let files: PathItem[] = [];
let symbols: SymbolItem[] = [];
const groups = new Map<string, Group>();
let groupOrder: Group[] = [];
let matchCount = 0;
const collapsed = new Set<string>();
const expanded = new Set<string>();

let rows: Row[] = [];
let selected = -1;
let selectedKey: string | null = null;
let userMoved = false;

const saved = vscode.getState() ?? {};
const ui: { split: number; showFilters: boolean } = { split: 0.42, showFilters: true, ...saved.ui };
const saveUi = () => vscode.setState({ ...vscode.getState(), ui });

// ====================================================================== DOM

const app = document.getElementById('app')!;
app.innerHTML = `
<div class="top">
  <div class="search-row">
    <div class="input-box" id="qbox">
      <i class="codicon codicon-search lead"></i>
      <input id="q" type="text" spellcheck="false" autocomplete="off" placeholder="Search files, folders, text, symbols…" aria-label="Search">
      <button class="opt" data-opt="caseSensitive" title="Match Case (Alt+C)"><i class="codicon codicon-case-sensitive"></i></button>
      <button class="opt" data-opt="wholeWord" title="Match Whole Word (Alt+W)"><i class="codicon codicon-whole-word"></i></button>
      <button class="opt" data-opt="regex" title="Use Regular Expression (Alt+R)"><i class="codicon codicon-regex"></i></button>
    </div>
    <button class="icon-btn" id="toggleFilters" title="Toggle Filters"><i class="codicon codicon-filter"></i></button>
    <button class="icon-btn" id="settings" title="Settings"><i class="codicon codicon-settings-gear"></i></button>
  </div>
  <div class="bar">
    <div class="modes" id="modes" role="tablist"></div>
    <div class="flex"></div>
    <button class="chip" data-opt="respectIgnore" title="Respect .gitignore, .ignore and .rgignore (Alt+I)"><i class="codicon codicon-source-control"></i><span>.gitignore</span></button>
    <button class="chip" data-opt="useVSCodeExcludes" title="Apply VS Code files.exclude and search.exclude (Alt+E)"><i class="codicon codicon-exclude"></i><span>VS Code Excludes</span></button>
    <button class="chip" data-opt="hidden" title="Include hidden files and folders (Alt+H)"><i class="codicon codicon-eye"></i><span>Hidden</span></button>
  </div>
  <div class="scopes" id="scopes" role="tablist"></div>
  <div class="filters" id="filters">
    <div class="field">
      <label for="include">Include</label>
      <input id="include" type="text" spellcheck="false" placeholder="e.g. src, *.ts, ./docs/">
    </div>
    <div class="field">
      <label for="exclude">Exclude</label>
      <input id="exclude" type="text" spellcheck="false" placeholder="e.g. **/*.test.ts, dist/, ./vendor">
    </div>
    <button class="icon-btn" id="clearFilters" title="Clear Filters"><i class="codicon codicon-clear-all"></i></button>
  </div>
  <div class="scope-info" id="scopeInfo"></div>
</div>
<div class="main" id="main">
  <div class="results">
    <div class="status" id="status"></div>
    <div class="progress" id="progress"></div>
    <div class="list" id="list" tabindex="0">
      <div class="spacer" id="spacer"></div>
      <div class="rows" id="rows"></div>
      <div class="empty" id="empty"></div>
    </div>
  </div>
  <div class="splitter" id="splitter"></div>
  <div class="preview">
    <div class="preview-head" id="phead"></div>
    <div class="preview-body" id="pbody"></div>
  </div>
</div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const qInput = $<HTMLInputElement>('q');
const includeInput = $<HTMLInputElement>('include');
const excludeInput = $<HTMLInputElement>('exclude');
const listEl = $('list');
const rowsEl = $('rows');
const spacerEl = $('spacer');
const emptyEl = $('empty');
const statusEl = $('status');
const progressEl = $('progress');
const mainEl = $('main');
const pHead = $('phead');
const pBody = $('pbody');

// ====================================================================== helpers

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const icon = (name: string, extra = '') => `<i class="codicon codicon-${name} ${extra}"></i>`;

function basename(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(i + 1) : rel;
}

function dirname(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

function highlightChars(text: string, positions: number[], offset = 0): string {
  if (!positions.length) return esc(text);
  const set = new Set(positions);
  let out = '';
  let inMark = false;
  for (let i = 0; i < text.length; i++) {
    const on = set.has(i + offset);
    if (on !== inMark) {
      out += on ? '<b class="hl">' : '</b>';
      inMark = on;
    }
    out += esc(text[i]);
  }
  return out + (inMark ? '</b>' : '');
}

const FILE_ICONS: [RegExp, string][] = [
  [/\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/i, 'file-media'],
  [/\.(md|markdown|mdx)$/i, 'markdown'],
  [/\.(json|jsonc|json5)$/i, 'json'],
  [/\.(zip|tar|gz|tgz|7z|rar)$/i, 'file-zip'],
  [/\.pdf$/i, 'file-pdf'],
  [/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|vue|svelte|css|scss|less|html|xml|sh|ps1|sql|lua|dart|scala)$/i, 'file-code'],
];

function fileIcon(rel: string): string {
  for (const [re, name] of FILE_ICONS) if (re.test(rel)) return name;
  return 'file';
}

const SYMBOL_ICONS: Record<number, string> = {
  0: 'symbol-file', 1: 'symbol-namespace', 2: 'symbol-namespace', 3: 'package', 4: 'symbol-class',
  5: 'symbol-method', 6: 'symbol-property', 7: 'symbol-field', 8: 'symbol-method', 9: 'symbol-enum',
  10: 'symbol-interface', 11: 'symbol-function', 12: 'symbol-variable', 13: 'symbol-constant', 14: 'symbol-string',
  15: 'symbol-numeric', 16: 'symbol-boolean', 17: 'symbol-array', 18: 'symbol-namespace', 19: 'symbol-key',
  20: 'symbol-misc', 21: 'symbol-enum-member', 22: 'symbol-structure', 23: 'symbol-event', 24: 'symbol-operator',
  25: 'symbol-parameter',
};

// ====================================================================== top bar

$('modes').innerHTML = MODES.map(
  (m, i) => `<button class="mode" role="tab" data-mode="${m.id}" title="${esc(m.hint)} (Alt+${i + 1})">${icon(m.icon)}<span>${m.label}</span></button>`,
).join('');

function syncUi(): void {
  if (qInput.value !== options.query) qInput.value = options.query;
  if (includeInput.value !== options.include) includeInput.value = options.include;
  if (excludeInput.value !== options.exclude) excludeInput.value = options.exclude;
  document.querySelectorAll<HTMLElement>('[data-opt]').forEach((el) => {
    const on = !!options[el.dataset.opt as keyof Options];
    el.classList.toggle('on', on);
    el.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll<HTMLElement>('[data-mode]').forEach((el) => {
    el.classList.toggle('on', el.dataset.mode === options.mode);
    el.setAttribute('aria-selected', String(el.dataset.mode === options.mode));
  });
  $('filters').classList.toggle('hidden', !ui.showFilters);
  $('toggleFilters').classList.toggle('on', ui.showFilters || !!(options.include || options.exclude));
  $('toggleFilters').classList.toggle('badge', !ui.showFilters && !!(options.include || options.exclude));
  renderScopes();
}

function scopeTooltip(s: ScopeDef): string {
  if (s.id === 'project') return 'All files in the workspace';
  if (s.id === 'open') return 'Only files open in editor tabs';
  if (s.id === 'git') return 'Only modified, staged or untracked files (Git)';
  if (s.id === 'activeFolder') return activeFolder ? `Folder of the active file: ${activeFolder}` : 'Folder of the active file (no file open)';
  const parts = [s.paths.length ? `Folders: ${s.paths.join(', ')}` : 'Whole project'];
  if (s.include.length) parts.push(`Include: ${s.include.join(', ')}`);
  if (s.exclude.length) parts.push(`Exclude: ${s.exclude.join(', ')}`);
  const where = s.kind === 'global' ? 'all projects' : s.kind === 'settings' ? 'settings.json' : 'this project';
  return `${parts.join('\n')}\n(saved in ${where})`;
}

function renderScopes(): void {
  const html = scopes.map((s) => {
    const on = s.id === options.scopeId;
    const editable = s.kind !== 'builtin';
    const actions = editable
      ? `<span class="tab-actions"><i class="codicon codicon-edit" data-scope-edit="${esc(s.id)}" title="Edit"></i>${
          s.kind === 'settings' ? '' : `<i class="codicon codicon-close" data-scope-del="${esc(s.id)}" title="Delete"></i>`
        }</span>`
      : '';
    return `<button class="scope${on ? ' on' : ''}" role="tab" aria-selected="${on}" data-scope="${esc(s.id)}" title="${esc(scopeTooltip(s))}">${icon(s.icon)}<span>${esc(s.name)}</span>${actions}</button>`;
  });
  html.push(`<button class="scope add" id="saveScope" title="Save the current scope and filters as a new tab">${icon('add')}<span>Save Scope</span></button>`);
  $('scopes').innerHTML = html.join('');

  const s = scopes.find((x) => x.id === options.scopeId);
  const info = $('scopeInfo');
  if (s && s.kind !== 'builtin') {
    info.textContent = scopeTooltip(s).split('\n').slice(0, -1).join(' · ');
    info.classList.remove('hidden');
  } else if (s?.id === 'activeFolder') {
    info.textContent = activeFolder ? `In: ${activeFolder}` : 'Open a file to pick its folder';
    info.classList.remove('hidden');
  } else {
    info.classList.add('hidden');
  }
}

let typingTimer: number | undefined;
function scheduleSearch(delay: number): void {
  clearTimeout(typingTimer);
  typingTimer = window.setTimeout(doSearch, delay);
}

qInput.addEventListener('input', () => {
  options.query = qInput.value;
  scheduleSearch(130);
});
includeInput.addEventListener('input', () => {
  options.include = includeInput.value;
  syncUi();
  scheduleSearch(350);
});
excludeInput.addEventListener('input', () => {
  options.exclude = excludeInput.value;
  syncUi();
  scheduleSearch(350);
});

function toggleOption(key: keyof Options): void {
  (options as any)[key] = !options[key];
  syncUi();
  doSearch();
}

function setMode(mode: Mode): void {
  if (options.mode === mode) return;
  options.mode = mode;
  syncUi();
  doSearch();
}

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const opt = target.closest<HTMLElement>('[data-opt]');
  if (opt) return toggleOption(opt.dataset.opt as keyof Options);
  const mode = target.closest<HTMLElement>('[data-mode]');
  if (mode) return setMode(mode.dataset.mode as Mode);

  const edit = target.closest<HTMLElement>('[data-scope-edit]');
  if (edit) return post({ type: 'editScope', id: edit.dataset.scopeEdit! });
  const del = target.closest<HTMLElement>('[data-scope-del]');
  if (del) return post({ type: 'deleteScope', id: del.dataset.scopeDel! });
  if (target.closest('#saveScope')) return post({ type: 'saveScope' });
  const scope = target.closest<HTMLElement>('[data-scope]');
  if (scope && scope.dataset.scope !== options.scopeId) {
    options.scopeId = scope.dataset.scope!;
    syncUi();
    return doSearch();
  }

  if (target.closest('#toggleFilters')) {
    ui.showFilters = !ui.showFilters;
    saveUi();
    syncUi();
    if (ui.showFilters) includeInput.focus();
    return;
  }
  if (target.closest('#clearFilters')) {
    options.include = '';
    options.exclude = '';
    syncUi();
    return doSearch();
  }
  if (target.closest('#settings')) return post({ type: 'openSettings' });
});

// ====================================================================== search

function resetResults(): void {
  folders = [];
  files = [];
  symbols = [];
  groups.clear();
  groupOrder = [];
  matchCount = 0;
  expanded.clear();
  previewCache.clear();
}

function doSearch(): void {
  clearTimeout(typingTimer);
  searchId++;
  searching = true;
  staleResults = true;
  stats = null;
  userMoved = false;
  selectedKey = null;
  renderStatus();
  post({ type: 'search', searchId, options: { ...options } });
}

function addResults(items: ResultItem[]): void {
  if (staleResults) {
    resetResults();
    staleResults = false;
  }
  for (const item of items) {
    switch (item.kind) {
      case 'folder':
        folders.push(item);
        break;
      case 'file':
        files.push(item);
        break;
      case 'symbol':
        symbols.push(item);
        break;
      case 'match': {
        let g = groups.get(item.path);
        if (!g) {
          g = { path: item.path, rel: item.rel, matches: [] };
          groups.set(item.path, g);
          groupOrder.push(g);
        }
        g.matches.push(item);
        matchCount++;
        break;
      }
    }
  }
  scheduleRebuild();
}

let rebuildQueued = false;
function scheduleRebuild(): void {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    rebuildQueued = false;
    rebuildRows();
  });
}

function rowKey(item: ResultItem): string {
  if (item.kind === 'match') return `m:${item.path}:${item.line}`;
  if (item.kind === 'symbol') return `s:${item.path}:${item.line}:${item.name}`;
  return `${item.kind[0]}:${item.path}`;
}

function rebuildRows(): void {
  const all = options.mode === 'all';
  const out: Row[] = [];
  const section = (id: string, label: string, list: ResultItem[]) => {
    if (!list.length) return;
    if (all) out.push({ t: 'section', key: `sec:${id}`, label, count: String(list.length) });
    const limit = all && !expanded.has(id) ? SECTION_LIMITS[id] : Infinity;
    for (const item of list.slice(0, limit)) out.push({ t: 'item', key: rowKey(item), item });
    if (list.length > limit) out.push({ t: 'more', key: `more:${id}`, section: id, hidden: list.length - limit });
  };
  section('folders', 'Folders', folders);
  section('files', 'Files', files);
  section('symbols', 'Symbols', symbols);
  if (groupOrder.length) {
    if (all) {
      out.push({ t: 'section', key: 'sec:text', label: 'Text', count: `${matchCount} in ${plural(groupOrder.length, 'file')}` });
    }
    for (const g of groupOrder) {
      out.push({ t: 'group', key: `g:${g.path}`, g });
      if (!collapsed.has(g.path)) {
        for (const m of g.matches) out.push({ t: 'item', key: rowKey(m), item: m });
      }
    }
  }
  rows = out;

  // Keep the selection on the same result; otherwise select the first one.
  let index = selectedKey ? rows.findIndex((r) => r.key === selectedKey) : -1;
  if (index < 0 && !userMoved) index = firstSelectable(0, 1);
  if (index !== selected || (index >= 0 && rows[index].key !== selectedKey)) {
    select(index, { scroll: false, user: false });
  }
  renderList();
  renderStatus();
}

const isSelectable = (r: Row | undefined) => !!r && r.t !== 'section';

function firstSelectable(from: number, dir: 1 | -1): number {
  for (let i = from; i >= 0 && i < rows.length; i += dir) if (isSelectable(rows[i])) return i;
  return -1;
}

// ====================================================================== list rendering

function rowHtml(r: Row, i: number): string {
  const sel = i === selected ? ' sel' : '';
  switch (r.t) {
    case 'section':
      return `<div class="row section" data-i="${i}"><span>${esc(r.label)}</span><span class="count">${esc(r.count)}</span></div>`;
    case 'more':
      return `<div class="row more${sel}" data-i="${i}">${icon('ellipsis')}<span>Show ${r.hidden} more</span></div>`;
    case 'group': {
      const g = r.g;
      const open = !collapsed.has(g.path);
      return `<div class="row group${sel}" data-i="${i}" title="${esc(g.rel)}">${icon(open ? 'chevron-down' : 'chevron-right', 'twisty')}${icon(fileIcon(g.rel))}<span class="name">${esc(basename(g.rel))}</span><span class="dir">${esc(dirname(g.rel))}</span><span class="badge">${g.matches.length}</span>${rowActions(g.path, false)}</div>`;
    }
    case 'item':
      return itemHtml(r.item, i, sel);
  }
}

function rowActions(path: string, folder: boolean): string {
  const btns = folder
    ? `<i class="codicon codicon-search" data-act="searchIn" title="Search Here"></i><i class="codicon codicon-folder-opened" data-act="reveal" title="Reveal in Explorer"></i>`
    : `<i class="codicon codicon-split-horizontal" data-act="side" title="Open to the Side (Ctrl+Enter)"></i><i class="codicon codicon-folder-opened" data-act="reveal" title="Reveal in Explorer"></i>`;
  return `<span class="actions" data-path="${esc(path)}">${btns}<i class="codicon codicon-copy" data-act="copy" title="Copy Relative Path"></i></span>`;
}

function itemHtml(item: ResultItem, i: number, sel: string): string {
  switch (item.kind) {
    case 'file':
    case 'folder': {
      const name = basename(item.rel);
      const dir = dirname(item.rel);
      const start = item.rel.length - name.length;
      const ic = item.kind === 'folder' ? 'folder' : fileIcon(item.rel);
      return `<div class="row path${sel}" data-i="${i}" title="${esc(item.rel)}">${icon(ic)}<span class="name">${highlightChars(name, item.hl, start)}</span><span class="dir">${highlightChars(dir, item.hl)}</span>${rowActions(item.path, item.kind === 'folder')}</div>`;
    }
    case 'symbol':
      return `<div class="row symbol${sel}" data-i="${i}" title="${esc(item.rel)}:${item.line + 1}">${icon(SYMBOL_ICONS[item.symbolKind] ?? 'symbol-misc', 'sym')}<span class="name">${highlightChars(item.name, item.hl)}</span><span class="dir">${esc(item.container ? item.container + ' · ' : '')}${esc(basename(item.rel))}:${item.line + 1}</span>${rowActions(item.path, false)}</div>`;
    case 'match': {
      const marks: [number, number][] = item.ranges
        .map(([s, e]) => [s - item.offset, e - item.offset] as [number, number])
        .filter(([s, e]) => e > 0 && s < item.text.length);
      let html = '';
      let pos = 0;
      for (const [s, e] of marks) {
        const a = Math.max(0, s);
        const b = Math.min(item.text.length, e);
        if (a < pos) continue;
        html += esc(item.text.slice(pos, a)) + `<mark>${esc(item.text.slice(a, b))}</mark>`;
        pos = b;
      }
      html += esc(item.text.slice(pos));
      const lead = item.cut ? '…' : '';
      return `<div class="row match${sel}" data-i="${i}"><span class="lnum">${item.line + 1}</span><span class="text">${lead}${html}</span></div>`;
    }
  }
}

let listQueued = false;
function renderList(): void {
  spacerEl.style.height = `${rows.length * ROW_HEIGHT}px`;
  const top = listEl.scrollTop;
  const height = listEl.clientHeight || 600;
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 8);
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW_HEIGHT) + 8);
  rowsEl.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
  let html = '';
  for (let i = first; i < last; i++) html += rowHtml(rows[i], i);
  rowsEl.innerHTML = html;
  renderEmpty();
}

listEl.addEventListener('scroll', () => {
  if (listQueued) return;
  listQueued = true;
  requestAnimationFrame(() => {
    listQueued = false;
    renderList();
  });
});

function renderEmpty(): void {
  let text = '';
  if (!rows.length) {
    const q = options.query.trim();
    if (!q && (options.mode === 'all' || options.mode === 'text' || options.mode === 'symbols')) {
      text = `<div class="hint-title">What are you looking for?</div>
<div>Type to search in <b>${esc(scopes.find((s) => s.id === options.scopeId)?.name ?? '')}</b>.</div>
<ul>
<li><kbd>↑</kbd> <kbd>↓</kbd> move through results with the preview on the right</li>
<li><kbd>Enter</kbd> opens · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> opens to the side</li>
<li><kbd>Alt</kbd>+<kbd>1…5</kbd> modes · <kbd>Alt</kbd>+<kbd>C</kbd>/<kbd>W</kbd>/<kbd>R</kbd> options</li>
<li>Filters: <code>src</code> anywhere · <code>./src</code> from the root · <code>dist/</code> folders only · <code>**/*.test.ts</code></li>
<li>Right-click in the Explorer → <b>Search Here</b> to include or exclude</li>
</ul>`;
    } else if (!searching && stats) {
      text = stats.error ? '' : `<div class="hint-title">No results</div>${stats.warning ? `<div>${esc(stats.warning)}</div>` : ''}`;
    }
  }
  emptyEl.innerHTML = text;
  emptyEl.classList.toggle('hidden', !text);
}

function renderStatus(): void {
  progressEl.classList.toggle('active', searching);
  let html = '';
  if (stats?.error) {
    html = `<span class="error">${icon('error')} ${esc(stats.error)}</span>`;
  } else {
    const parts: string[] = [];
    if (folders.length) parts.push(plural(folders.length, 'folder'));
    if (files.length) parts.push(plural(files.length, 'file'));
    if (symbols.length) parts.push(plural(symbols.length, 'symbol'));
    if (groupOrder.length) parts.push(`${matchCount}${stats?.truncated ? '+' : ''} ${matchCount === 1 ? 'line' : 'lines'} in ${plural(groupOrder.length, 'file')}`);
    if (searching) parts.push('searching…');
    else if (stats) {
      if (!parts.length && rows.length === 0 && options.query) parts.push('no results');
      parts.push(`${stats.ms} ms`);
    }
    html = esc(parts.join(' · '));
    if (stats?.truncated) html += ` <span class="warn" title="searchHere.maxResults reached: narrow the search">${icon('warning')} truncated</span>`;
    else if (stats?.warning && rows.length) html += ` <span class="muted" title="${esc(stats.warning)}">${icon('info')}</span>`;
  }
  statusEl.innerHTML = html;
}

// ====================================================================== selection & keyboard

function select(index: number, opts: { scroll?: boolean; user?: boolean } = {}): void {
  selected = index;
  selectedKey = index >= 0 ? rows[index]?.key ?? null : null;
  if (opts.user) userMoved = true;
  if (opts.scroll !== false && index >= 0) {
    const top = index * ROW_HEIGHT;
    if (top < listEl.scrollTop) listEl.scrollTop = top;
    else if (top + ROW_HEIGHT > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = top + ROW_HEIGHT - listEl.clientHeight;
  }
  renderList();
  schedulePreview();
}

function move(delta: number): void {
  if (!rows.length) return;
  const dir = delta > 0 ? 1 : -1;
  let i = selected < 0 ? (dir > 0 ? -1 : rows.length) : selected;
  let target = Math.max(0, Math.min(rows.length - 1, i + delta));
  target = firstSelectable(target, dir as 1 | -1);
  if (target < 0) target = firstSelectable(dir > 0 ? rows.length - 1 : 0, (-dir) as 1 | -1);
  if (target >= 0) select(target, { user: true });
}

function activate(index: number, side: boolean): void {
  const r = rows[index];
  if (!r) return;
  if (r.t === 'more') {
    expanded.add(r.section);
    rebuildRows();
    return;
  }
  if (r.t === 'group') {
    const m = r.g.matches[0];
    if (m) openItem(m, side);
    return;
  }
  if (r.t === 'item') openItem(r.item, side);
}

function openItem(item: ResultItem, side: boolean): void {
  switch (item.kind) {
    case 'folder':
      post({ type: 'open', path: item.path, folder: true });
      break;
    case 'file':
      post({ type: 'open', path: item.path, side });
      break;
    case 'symbol':
      post({ type: 'open', path: item.path, line: item.line, col: item.col, side });
      break;
    case 'match': {
      const [s, e] = item.ranges[0] ?? [0, 0];
      post({ type: 'open', path: item.path, line: item.line, col: s, endCol: e, side });
      break;
    }
  }
}

function toggleGroup(path: string, open?: boolean): void {
  const isOpen = !collapsed.has(path);
  const next = open ?? !isOpen;
  if (next === isOpen) return;
  if (next) collapsed.delete(path);
  else collapsed.add(path);
  selectedKey = `g:${path}`;
  rebuildRows();
}

rowsEl.addEventListener('mousedown', (e) => {
  // Keep focus where it is (usually the search box) while clicking results.
  if (document.activeElement === qInput) e.preventDefault();
});

rowsEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const rowEl = target.closest<HTMLElement>('[data-i]');
  if (!rowEl) return;
  const i = Number(rowEl.dataset.i);
  const r = rows[i];
  const act = target.closest<HTMLElement>('[data-act]');
  if (act) {
    const path = act.closest<HTMLElement>('[data-path]')!.dataset.path!;
    const kind = act.dataset.act;
    if (kind === 'reveal') post({ type: 'reveal', path });
    else if (kind === 'copy') post({ type: 'copyPath', path, relative: true });
    else if (kind === 'searchIn') post({ type: 'searchIn', path, folder: true });
    else if (kind === 'side') {
      if (r?.t === 'item') openItem(r.item, true);
      else if (r?.t === 'group') activate(i, true);
    }
    return;
  }
  if (r?.t === 'group' && target.closest('.twisty')) {
    toggleGroup(r.g.path);
    return;
  }
  if (r?.t === 'more') {
    activate(i, false);
    return;
  }
  if (isSelectable(r)) select(i, { user: true, scroll: false });
});

rowsEl.addEventListener('dblclick', (e) => {
  const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
  if (!rowEl || (e.target as HTMLElement).closest('[data-act]')) return;
  const i = Number(rowEl.dataset.i);
  if (rows[i]?.t === 'group') return toggleGroup((rows[i] as { g: Group }).g.path);
  activate(i, e.ctrlKey || e.metaKey);
});

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    const map: Record<string, keyof Options> = { c: 'caseSensitive', w: 'wholeWord', r: 'regex', i: 'respectIgnore', e: 'useVSCodeExcludes', h: 'hidden' };
    const code = e.code.replace(/^Key/, '').toLowerCase();
    const opt = map[code] ?? map[k];
    if (opt) {
      e.preventDefault();
      return toggleOption(opt);
    }
    const digit = /^Digit([1-5])$/.exec(e.code);
    if (digit) {
      e.preventDefault();
      return setMode(MODES[Number(digit[1]) - 1].id);
    }
  }
  const navigable = t === qInput || t === listEl || t === document.body;
  if (!navigable) {
    if ((t === includeInput || t === excludeInput) && e.key === 'Enter') doSearch();
    return;
  }
  const page = Math.max(1, Math.floor(listEl.clientHeight / ROW_HEIGHT) - 1);
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      return move(1);
    case 'ArrowUp':
      e.preventDefault();
      return move(-1);
    case 'PageDown':
      e.preventDefault();
      return move(page);
    case 'PageUp':
      e.preventDefault();
      return move(-page);
    case 'Enter':
      e.preventDefault();
      if (typingTimer && t === qInput) {
        // Enter right after typing: search now instead of opening a stale result.
        return doSearch();
      }
      return activate(selected, e.ctrlKey || e.metaKey || e.altKey);
    case 'ArrowRight':
    case 'ArrowLeft': {
      if (t === qInput) return;
      const r = rows[selected];
      if (r?.t === 'group') {
        e.preventDefault();
        toggleGroup(r.g.path, e.key === 'ArrowRight');
      } else if (r?.t === 'item' && r.item.kind === 'match' && e.key === 'ArrowLeft') {
        e.preventDefault();
        const g = selectedGroupIndex();
        if (g >= 0) select(g, { user: true });
      }
      return;
    }
    case 'Escape':
      if (t === listEl) qInput.focus();
      return;
  }
});

function selectedGroupIndex(): number {
  for (let i = selected; i >= 0; i--) if (rows[i].t === 'group') return i;
  return -1;
}

// ====================================================================== preview

interface PreviewTarget {
  path: string;
  folder: boolean;
  line?: number;
  /** Ranges for the current line, if any (UTF-16). */
  ranges?: [number, number][];
  title: string;
}

const previewCache = new Map<string, PreviewData>();
let previewReq = 0;
let shown: { path: string; data: PreviewData; start: number; end: number } | null = null;
let currentTarget: PreviewTarget | null = null;
let previewTimer: number | undefined;

function targetFor(r: Row | undefined): PreviewTarget | null {
  if (!r) return null;
  if (r.t === 'group') {
    const m = r.g.matches[0];
    return { path: r.g.path, folder: false, line: m?.line, ranges: m?.ranges, title: r.g.rel };
  }
  if (r.t !== 'item') return null;
  const item = r.item;
  switch (item.kind) {
    case 'folder':
      return { path: item.path, folder: true, title: item.rel };
    case 'file':
      return { path: item.path, folder: false, title: item.rel };
    case 'symbol':
      return { path: item.path, folder: false, line: item.line, ranges: [[item.col, item.col + item.name.length]], title: `${item.rel}:${item.line + 1}` };
    case 'match':
      return { path: item.path, folder: false, line: item.line, ranges: item.ranges, title: `${item.rel}:${item.line + 1}` };
  }
}

function schedulePreview(): void {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => showPreview(targetFor(rows[selected])), 40);
}

function showPreview(target: PreviewTarget | null): void {
  currentTarget = target;
  if (!target) {
    shown = null;
    pHead.innerHTML = '';
    pBody.innerHTML = `<div class="preview-empty">${icon('eye')}<div>The preview of the selected result shows up here</div></div>`;
    return;
  }
  renderHead(target);
  if (shown && shown.path === target.path && shown.data.kind === 'file' && !target.folder) {
    updateCursor(target);
    return;
  }
  const cached = previewCache.get(target.path);
  if (cached) {
    renderPreview(cached, target);
    return;
  }
  const reqId = ++previewReq;
  const loading = window.setTimeout(() => {
    if (reqId === previewReq) pBody.innerHTML = `<div class="preview-empty">${icon('loading', 'codicon-modifier-spin')}</div>`;
  }, 150);
  pending.set(reqId, () => clearTimeout(loading));
  post({ type: 'preview', reqId, path: target.path, folder: target.folder });
}

const pending = new Map<number, () => void>();

function onPreview(reqId: number, data: PreviewData): void {
  pending.get(reqId)?.();
  pending.delete(reqId);
  previewCache.set(data.path, data);
  if (previewCache.size > 40) previewCache.delete(previewCache.keys().next().value!);
  if (reqId !== previewReq || !currentTarget || currentTarget.path !== data.path) return;
  renderPreview(data, currentTarget);
}

function renderHead(target: PreviewTarget): void {
  const actions = target.folder
    ? `<button class="icon-btn" data-pact="searchIn" title="Search in This Folder">${icon('search')}</button>
       <button class="icon-btn" data-pact="reveal" title="Reveal in Explorer">${icon('folder-opened')}</button>`
    : `<button class="icon-btn" data-pact="open" title="Open (Enter)">${icon('go-to-file')}</button>
       <button class="icon-btn" data-pact="side" title="Open to the Side (Ctrl+Enter)">${icon('split-horizontal')}</button>
       <button class="icon-btn" data-pact="reveal" title="Reveal in Explorer">${icon('folder-opened')}</button>`;
  pHead.innerHTML = `${icon(target.folder ? 'folder' : fileIcon(target.title))}<span class="ptitle" title="${esc(target.path)}">${esc(target.title)}</span>
    <span class="flex"></span>${actions}
    <button class="icon-btn" data-pact="copy" title="Copy Relative Path">${icon('copy')}</button>`;
}

pHead.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-pact]');
  if (!btn || !currentTarget) return;
  const t = currentTarget;
  const [s, end] = t.ranges?.[0] ?? [0, 0];
  switch (btn.dataset.pact) {
    case 'open':
    case 'side':
      post({ type: 'open', path: t.path, line: t.line, col: t.line !== undefined ? s : undefined, endCol: t.line !== undefined ? end : undefined, side: btn.dataset.pact === 'side' });
      break;
    case 'reveal':
      post({ type: 'reveal', path: t.path });
      break;
    case 'copy':
      post({ type: 'copyPath', path: t.path, relative: true });
      break;
    case 'searchIn':
      post({ type: 'searchIn', path: t.path, folder: true });
      break;
  }
});

const LANG_ALIASES: Record<string, string> = {
  tsx: 'typescript', mts: 'typescript', cts: 'typescript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  vue: 'xml', svelte: 'xml', htm: 'xml', html: 'xml', xaml: 'xml', csproj: 'xml', props: 'xml', svg: 'xml', resx: 'xml',
  jsonc: 'json', json5: 'json', toml: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'bash', zsh: 'bash',
  psm1: 'powershell', psd1: 'powershell', gradle: 'kotlin', kts: 'kotlin', h: 'cpp', hpp: 'cpp', cc: 'cpp', mdx: 'markdown',
};

function guessLanguage(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop()!.toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  const name = LANG_ALIASES[ext] ?? ext;
  return name && hljs.getLanguage(name) ? name : undefined;
}

/** Splits highlight.js HTML into per-line HTML, closing and reopening spans at line breaks. */
function splitHtmlLines(html: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let cur = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      stack.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      stack.pop();
      cur += m[2];
    } else if (m[3]) {
      out.push(cur + '</span>'.repeat(stack.length));
      cur = stack.join('');
    } else {
      cur += m[4];
    }
  }
  out.push(cur + '</span>'.repeat(stack.length));
  return out;
}

const MAX_RENDERED_LINES = 4000;
const MAX_HIGHLIGHT_CHARS = 400_000;

function renderPreview(data: PreviewData, target: PreviewTarget): void {
  if (data.kind === 'error') {
    shown = null;
    pBody.innerHTML = `<div class="preview-empty">${icon('info')}<div>${esc(data.message)}</div></div>`;
    return;
  }
  if (data.kind === 'folder') {
    shown = null;
    const sep = data.path.includes('\\') ? '\\' : '/';
    pBody.innerHTML = `<div class="dir-list">${data.entries
      .map(
        (e) =>
          `<div class="dir-entry" data-entry="${esc(data.path + sep + e.name)}" data-dir="${e.dir}">${icon(e.dir ? 'folder' : fileIcon(e.name))}<span>${esc(e.name)}</span></div>`,
      )
      .join('')}${data.truncated ? '<div class="muted">…</div>' : ''}${data.entries.length ? '' : '<div class="muted">Empty folder</div>'}</div>`;
    return;
  }

  const lines = data.content.split(/\r?\n/);
  const line = target.line ?? 0;
  let start = 0;
  let end = lines.length;
  if (lines.length > MAX_RENDERED_LINES) {
    start = Math.max(0, line - MAX_RENDERED_LINES / 2);
    end = Math.min(lines.length, start + MAX_RENDERED_LINES);
  }
  const slice = lines.slice(start, end);
  const text = slice.join('\n');
  const lang = guessLanguage(data.path);
  let html: string[];
  if (lang && text.length <= MAX_HIGHLIGHT_CHARS) {
    try {
      html = splitHtmlLines(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value);
    } catch {
      html = slice.map(esc);
    }
  } else {
    html = slice.map(esc);
  }
  const width = String(end).length;
  let out = '';
  if (start > 0) out += `<div class="cut">… ${start} lines above</div>`;
  for (let i = 0; i < html.length; i++) {
    out += `<div class="ln" data-ln="${start + i}"><span class="gutter">${String(start + i + 1).padStart(width, ' ')}</span><span class="code">${html[i] || ' '}</span></div>`;
  }
  if (end < lines.length) out += `<div class="cut">… ${lines.length - end} more lines</div>`;
  pBody.innerHTML = `<div class="code-view${lang ? ' hljs' : ''}">${out}</div>`;
  shown = { path: data.path, data, start, end };

  // Mark every match of this file that is in the results.
  const group = groups.get(data.path);
  if (group) {
    for (const m of group.matches) {
      const el = lineEl(m.line);
      if (el) markRanges(el, m.ranges, 'match');
    }
  }
  updateCursor(target);
}

function lineEl(line: number): HTMLElement | null {
  return pBody.querySelector<HTMLElement>(`.ln[data-ln="${line}"] .code`);
}

function updateCursor(target: PreviewTarget): void {
  if (!shown) return;
  if (target.line !== undefined && (target.line < shown.start || target.line >= shown.end)) {
    renderPreview(shown.data, target);
    return;
  }
  pBody.querySelectorAll('.ln.cur').forEach((el) => el.classList.remove('cur'));
  pBody.querySelectorAll('mark.current').forEach((el) => el.classList.remove('current'));
  if (target.line === undefined) {
    pBody.scrollTop = 0;
    return;
  }
  const code = lineEl(target.line);
  const row = code?.parentElement;
  if (!row) return;
  row.classList.add('cur');
  const marks = code.querySelectorAll('mark.match');
  if (marks.length) marks.forEach((m) => m.classList.add('current'));
  else if (target.ranges?.length) markRanges(code, target.ranges, 'symbol current');
  const top = row.offsetTop - pBody.clientHeight / 3;
  pBody.scrollTop = Math.max(0, top);
  // Long lines: bring the match into view horizontally.
  const mark = code.querySelector<HTMLElement>('mark');
  if (mark) {
    const left = mark.offsetLeft - pBody.clientWidth / 3;
    pBody.scrollLeft = left > 0 ? left : 0;
  } else {
    pBody.scrollLeft = 0;
  }
}

function markRanges(el: HTMLElement, ranges: [number, number][], cls: string): void {
  const sorted = [...ranges].sort((a, b) => b[0] - a[0]);
  for (const [s, e] of sorted) wrapRange(el, s, e, cls);
}

function wrapRange(el: HTMLElement, s: number, e: number, cls: string): void {
  if (e <= s) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const segments: [Text, number, number][] = [];
  let pos = 0;
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const len = node.data.length;
    if (pos + len > s && pos < e) segments.push([node, Math.max(s, pos) - pos, Math.min(e, pos + len) - pos]);
    pos += len;
    if (pos >= e) break;
  }
  for (const [n, a, b] of segments) {
    let target = n;
    if (a > 0) target = target.splitText(a);
    if (b - a < target.data.length) target.splitText(b - a);
    const mark = document.createElement('mark');
    mark.className = cls;
    target.parentNode!.insertBefore(mark, target);
    mark.appendChild(target);
  }
}

pBody.addEventListener('click', (e) => {
  const entry = (e.target as HTMLElement).closest<HTMLElement>('[data-entry]');
  if (!entry) return;
  const path = entry.dataset.entry!;
  const folder = entry.dataset.dir === 'true';
  const base = currentTarget?.title ?? '';
  showPreview({ path, folder, title: `${base}/${entry.textContent}` });
});

pBody.addEventListener('dblclick', (e) => {
  const entry = (e.target as HTMLElement).closest<HTMLElement>('[data-entry]');
  if (entry) {
    post({ type: 'open', path: entry.dataset.entry!, folder: entry.dataset.dir === 'true' });
    return;
  }
  // Double click on a code line opens the file there.
  const ln = (e.target as HTMLElement).closest<HTMLElement>('.ln');
  if (ln && shown) post({ type: 'open', path: shown.path, line: Number(ln.dataset.ln), col: 0 });
});

// ====================================================================== layout

function applySplit(): void {
  const stacked = app.classList.contains('stacked');
  const pct = `${(ui.split * 100).toFixed(1)}%`;
  mainEl.style.gridTemplateColumns = stacked ? '' : `minmax(160px, ${pct}) 4px minmax(160px, 1fr)`;
  mainEl.style.gridTemplateRows = stacked ? `minmax(80px, ${pct}) 4px minmax(80px, 1fr)` : '';
}

new ResizeObserver(() => {
  const stacked = app.clientWidth < 620;
  if (stacked !== app.classList.contains('stacked')) {
    app.classList.toggle('stacked', stacked);
    applySplit();
  }
  renderList();
}).observe(app);

$('splitter').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const rect = mainEl.getBoundingClientRect();
  const stacked = app.classList.contains('stacked');
  const onMove = (ev: MouseEvent) => {
    const ratio = stacked ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
    ui.split = Math.min(0.85, Math.max(0.15, ratio));
    applySplit();
    renderList();
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.classList.remove('dragging');
    saveUi();
  };
  document.body.classList.add('dragging');
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

// ====================================================================== messages

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      options = msg.options;
      scopes = msg.scopes;
      activeFolder = msg.activeFolder;
      syncUi();
      applySplit();
      showPreview(null);
      if (options.query) doSearch();
      else renderList();
      break;
    case 'options':
      options = msg.options;
      syncUi();
      if (msg.rerun) doSearch();
      break;
    case 'scopes':
      scopes = msg.scopes;
      renderScopes();
      break;
    case 'activeFolder':
      activeFolder = msg.rel;
      renderScopes();
      if (options.scopeId === 'activeFolder') doSearch();
      break;
    case 'results':
      if (msg.searchId === searchId) addResults(msg.items);
      break;
    case 'done':
      if (msg.searchId !== searchId) break;
      searching = false;
      stats = msg.stats;
      if (staleResults) {
        resetResults();
        staleResults = false;
      }
      rebuildRows();
      break;
    case 'preview':
      onPreview(msg.reqId, msg.data);
      break;
    case 'focus':
      if (msg.query !== undefined && msg.query !== options.query) {
        options.query = msg.query;
        qInput.value = msg.query;
        doSearch();
      }
      qInput.focus();
      qInput.select();
      break;
  }
});

post({ type: 'ready' });
