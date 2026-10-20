import * as path from 'path';
import * as vscode from 'vscode';
import { Services } from './controller';
import { Mode, ResultItem } from './protocol';

const MODES: Mode[] = ['all', 'text', 'files', 'folders', 'symbols'];
const MODE_LABELS: Record<Mode, string> = {
  all: 'All',
  text: 'Text',
  files: 'Files',
  folders: 'Folders',
  symbols: 'Symbols',
};
const MAX_TEXT_ITEMS = 500;

const SYMBOL_ICONS: Record<number, string> = {
  [vscode.SymbolKind.Class]: 'symbol-class',
  [vscode.SymbolKind.Method]: 'symbol-method',
  [vscode.SymbolKind.Function]: 'symbol-function',
  [vscode.SymbolKind.Constructor]: 'symbol-method',
  [vscode.SymbolKind.Interface]: 'symbol-interface',
  [vscode.SymbolKind.Enum]: 'symbol-enum',
  [vscode.SymbolKind.Variable]: 'symbol-variable',
  [vscode.SymbolKind.Constant]: 'symbol-constant',
  [vscode.SymbolKind.Property]: 'symbol-property',
  [vscode.SymbolKind.Field]: 'symbol-field',
  [vscode.SymbolKind.Module]: 'symbol-namespace',
  [vscode.SymbolKind.Namespace]: 'symbol-namespace',
  [vscode.SymbolKind.Struct]: 'symbol-structure',
  [vscode.SymbolKind.TypeParameter]: 'symbol-parameter',
};

interface Item extends vscode.QuickPickItem {
  result?: ResultItem;
}

const openBeside: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open to the Side' };

let current: { nextMode(): void } | undefined;

/** Cycles the mode of the open quick search (bound to Ctrl+Alt+P while it is open). */
export function nextQuickMode(): void {
  current?.nextMode();
}

/** Dialog search with live preview in the editor while moving through the results. */
export function quickSearch(
  services: Services,
  initial: string | undefined,
  openFull: (query: string, mode: Mode, where: 'panel' | 'editor') => void,
): void {
  const { store, engine } = services;
  const qp = vscode.window.createQuickPick<Item>();
  let mode: Mode = 'all';
  qp.placeholder = 'Search files, folders, text and symbols…  (Ctrl+Alt+P switches mode)';
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.value = initial ?? '';

  const modeButton = (): vscode.QuickInputButton => ({
    iconPath: new vscode.ThemeIcon('list-filter'),
    tooltip: `Mode: ${MODE_LABELS[mode]} (click to switch)`,
  });
  const panelButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('layout-panel'),
    tooltip: 'Open in the Panel (filters, preview, scopes)',
  };
  const editorButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('link-external'),
    tooltip: 'Open in an Editor Tab (filters, preview, scopes)',
  };
  const updateChrome = (status = '') => {
    const scope = store.scope(store.options.scopeId);
    qp.title = `Search Here · ${MODE_LABELS[mode]} · ${scope.name}${status ? ' · ' + status : ''}`;
    qp.buttons = [modeButton(), panelButton, editorButton];
  };

  // Remember what was open so a cancelled search leaves the editor as it was.
  const original = vscode.window.activeTextEditor;
  const openBefore = new Set(
    vscode.window.tabGroups.all.flatMap((g) => g.tabs).flatMap((t) => (t.input instanceof vscode.TabInputText ? [t.input.uri.toString()] : [])),
  );
  let previewed: vscode.Uri | undefined;
  let accepted = false;

  let cts: vscode.CancellationTokenSource | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let renderTimer: NodeJS.Timeout | undefined;
  let results: ResultItem[] = [];

  const render = () => {
    renderTimer = undefined;
    const folders: Item[] = [];
    const files: Item[] = [];
    const symbols: Item[] = [];
    const text: Item[] = [];
    for (const r of results) {
      const dir = path.posix.dirname(r.rel);
      const where = dir === '.' ? '' : dir;
      switch (r.kind) {
        case 'folder':
          folders.push({ label: `$(folder) ${path.posix.basename(r.rel)}`, description: where, alwaysShow: true, result: r });
          break;
        case 'file':
          files.push({ label: `$(file) ${path.posix.basename(r.rel)}`, description: where, alwaysShow: true, result: r, buttons: [openBeside] });
          break;
        case 'symbol':
          symbols.push({
            label: `$(${SYMBOL_ICONS[r.symbolKind] ?? 'symbol-misc'}) ${r.name}`,
            description: [r.container, `${r.rel}:${r.line + 1}`].filter(Boolean).join(' · '),
            alwaysShow: true,
            result: r,
            buttons: [openBeside],
          });
          break;
        case 'match':
          if (text.length < MAX_TEXT_ITEMS) {
            text.push({
              label: r.text.trim() || ' ',
              description: `${r.rel}:${r.line + 1}`,
              alwaysShow: true,
              result: r,
              buttons: [openBeside],
            });
          }
          break;
      }
    }
    const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const items: Item[] = [];
    if (folders.length) items.push(sep('Folders'), ...folders);
    if (files.length) items.push(sep('Files'), ...files);
    if (symbols.length) items.push(sep('Symbols'), ...symbols);
    if (text.length) items.push(sep('Text'), ...text);
    const active = qp.activeItems[0]?.result;
    qp.items = items;
    // Keep the highlighted item while results stream in.
    if (active) {
      const same = items.find((i) => i.result && sameResult(i.result, active));
      if (same) qp.activeItems = [same];
    }
  };

  const run = () => {
    cts?.cancel();
    cts = new vscode.CancellationTokenSource();
    const token = cts.token;
    const options = { ...store.options, query: qp.value, mode };
    results = [];
    if (!qp.value.trim() && (mode === 'all' || mode === 'text' || mode === 'symbols')) {
      qp.items = [];
      qp.busy = false;
      updateChrome();
      return;
    }
    qp.busy = true;
    engine
      .search(
        options,
        store.scope(options.scopeId),
        (items) => {
          if (token.isCancellationRequested) return;
          results.push(...items);
          renderTimer ??= setTimeout(render, 50);
        },
        token,
      )
      .then((stats) => {
        if (token.isCancellationRequested) return;
        if (renderTimer) clearTimeout(renderTimer);
        render();
        qp.busy = false;
        updateChrome(stats.error ?? `${stats.matches}${stats.truncated ? '+' : ''} results, ${stats.ms} ms`);
      });
  };

  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(run, 120);
  };

  let previewTimer: NodeJS.Timeout | undefined;
  const preview = (item: Item | undefined) => {
    if (previewTimer) clearTimeout(previewTimer);
    const r = item?.result;
    if (!r || r.kind === 'folder') return;
    previewTimer = setTimeout(async () => {
      const uri = vscode.Uri.file(r.path);
      try {
        await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, selection: selectionOf(r) });
        previewed = uri;
      } catch {
        // binary or unreadable: no preview
      }
    }, 80);
  };

  const open = async (r: ResultItem, side: boolean) => {
    if (r.kind === 'folder') {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(r.path));
      return;
    }
    const uri = vscode.Uri.file(r.path);
    try {
      await vscode.window.showTextDocument(uri, {
        preview: false,
        selection: selectionOf(r),
        viewColumn: side ? vscode.ViewColumn.Beside : undefined,
      });
    } catch {
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  };

  current = {
    nextMode() {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      updateChrome();
      run();
    },
  };
  void vscode.commands.executeCommand('setContext', 'searchHere.quickOpen', true);

  qp.onDidChangeValue(schedule);
  qp.onDidChangeActive((items) => preview(items[0]));
  qp.onDidTriggerButton((b) => {
    if (b === panelButton || b === editorButton) {
      accepted = true;
      qp.hide();
      openFull(qp.value, mode, b === panelButton ? 'panel' : 'editor');
    } else {
      current?.nextMode();
    }
  });
  qp.onDidTriggerItemButton(async (e) => {
    if (!e.item.result) return;
    accepted = true;
    qp.hide();
    await open(e.item.result, true);
  });
  qp.onDidAccept(async () => {
    const r = qp.selectedItems[0]?.result ?? qp.activeItems[0]?.result;
    if (!r) return;
    accepted = true;
    qp.hide();
    await open(r, false);
  });
  qp.onDidHide(async () => {
    current = undefined;
    void vscode.commands.executeCommand('setContext', 'searchHere.quickOpen', false);
    cts?.cancel();
    if (previewTimer) clearTimeout(previewTimer);
    qp.dispose();
    if (accepted || !previewed) return;
    // Cancelled: close the preview tab we opened and go back to the original editor.
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.isPreview &&
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === previewed.toString() &&
          !openBefore.has(previewed.toString())
        ) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
    if (original) {
      await vscode.window.showTextDocument(original.document, { viewColumn: original.viewColumn, selection: original.selection });
    }
  });

  updateChrome();
  qp.show();
  if (qp.value) run();
}

function selectionOf(r: ResultItem): vscode.Range | undefined {
  if (r.kind === 'match') {
    const [start, end] = r.ranges[0] ?? [0, 0];
    return new vscode.Range(r.line, start, r.line, end);
  }
  if (r.kind === 'symbol') {
    return new vscode.Range(r.line, r.col, r.line, r.col);
  }
  return undefined;
}

function sameResult(a: ResultItem, b: ResultItem): boolean {
  if (a.kind !== b.kind || a.path !== b.path) return false;
  if (a.kind === 'match' && b.kind === 'match') return a.line === b.line;
  if (a.kind === 'symbol' && b.kind === 'symbol') return a.line === b.line && a.name === b.name;
  return true;
}
