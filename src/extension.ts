import * as path from 'path';
import * as vscode from 'vscode';
import { SearchController, Services } from './controller';
import { relativeInside, SearchEngine } from './engine';
import { FileIndex } from './fileIndex';
import { addPattern, patternForPath, removePattern } from './globs';
import { Mode } from './protocol';
import { nextQuickMode, quickSearch } from './quickPick';
import { Store } from './state';
import { SyntaxTheme } from './theme';

/** Returned by `activate`; used by the integration tests to reach the engine and the stored options. */
export interface SearchHereApi {
  store: Store;
  engine: SearchEngine;
  index: FileIndex;
  theme: SyntaxTheme;
}

export function activate(ctx: vscode.ExtensionContext): SearchHereApi {
  const index = new FileIndex();
  const store = new Store(ctx);
  const engine = new SearchEngine(index);
  const theme = new SyntaxTheme(ctx.extensionPath);
  const services: Services = { ctx, store, engine, theme };
  const controllers = new Set<SearchController>();
  ctx.subscriptions.push(index, store, theme);

  // "Active Folder" follows the last focused text editor.
  const trackEditor = (editor: vscode.TextEditor | undefined) => {
    if (editor?.document.uri.scheme !== 'file') return;
    const dir = path.dirname(editor.document.uri.fsPath);
    if (dir !== engine.activeFolder) {
      engine.activeFolder = dir;
      controllers.forEach((c) => c.notifyActiveFolder());
    }
  };
  trackEditor(vscode.window.activeTextEditor);
  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(trackEditor));

  // ------------------------------------------------------------ bottom panel view
  let viewController: SearchController | undefined;
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'searchHere.view',
      {
        resolveWebviewView(view) {
          const controller = new SearchController(view.webview, services, () => vscode.ViewColumn.Active);
          viewController = controller;
          controllers.add(controller);
          view.onDidDispose(() => {
            controller.dispose();
            controllers.delete(controller);
            if (viewController === controller) viewController = undefined;
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ------------------------------------------------------------ editor tabs
  interface EditorTab {
    panel: vscode.WebviewPanel;
    controller: SearchController;
  }
  /** Open search tabs, most recently focused first. */
  const editorTabs: EditorTab[] = [];
  const touch = (tab: EditorTab) => {
    const i = editorTabs.indexOf(tab);
    if (i > 0) {
      editorTabs.splice(i, 1);
      editorTabs.unshift(tab);
    }
  };

  const createEditorTab = (query?: string): EditorTab => {
    const panel = vscode.window.createWebviewPanel('searchHere.editor', 'Search Here', vscode.ViewColumn.Active, {
      retainContextWhenHidden: true,
    });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
    const controller = new SearchController(
      panel.webview,
      services,
      // Results open as a new tab in the search tab's own group.
      () => panel.viewColumn ?? vscode.ViewColumn.Active,
      (q) => (panel.title = q.trim() ? `Search: ${q.trim()}` : 'Search Here'),
    );
    const tab: EditorTab = { panel, controller };
    editorTabs.unshift(tab);
    controllers.add(controller);
    controller.focus(query);
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) touch(tab);
    });
    panel.onDidDispose(() => {
      controller.dispose();
      controllers.delete(controller);
      editorTabs.splice(editorTabs.indexOf(tab), 1);
    });
    return tab;
  };

  /** Opens the search in an editor tab: the last used one or a new one (`searchHere.editorTab`). */
  const openEditor = (query?: string, forceNew = false): EditorTab => {
    const reuse = vscode.workspace.getConfiguration('searchHere').get<string>('editorTab', 'reuse') === 'reuse';
    const existing = editorTabs[0];
    if (existing && reuse && !forceNew) {
      existing.panel.reveal();
      existing.controller.focus(query);
      return existing;
    }
    return createEditorTab(query);
  };

  const openView = async (query?: string) => {
    await vscode.commands.executeCommand('searchHere.view.focus');
    viewController?.focus(query);
  };

  type Location = 'panel' | 'editor' | 'dialog';
  const defaultOpen = () => vscode.workspace.getConfiguration('searchHere').get<Location>('defaultOpen', 'panel');

  /** Opens the full search view: in an editor tab if that is the default, otherwise in the bottom panel. */
  const openTab = async (query?: string) => {
    if (defaultOpen() === 'editor') openEditor(query);
    else await openView(query);
  };

  /** From the dialog to a full view, keeping query and mode. */
  const openFull = async (query: string, mode: Mode, where: 'panel' | 'editor') => {
    await store.setOptions({ query, mode });
    if (where === 'editor') {
      openEditor(query).controller.load(store.options);
    } else {
      await openView(query);
      viewController?.load(store.options);
    }
  };

  /** What Ctrl+Alt+F and the status bar button open (`searchHere.defaultOpen`). */
  const openSearch = async (query?: string) => {
    switch (defaultOpen()) {
      case 'dialog':
        quickSearch(services, query, openFull);
        break;
      case 'editor':
        openEditor(query);
        break;
      default:
        await openView(query);
    }
  };

  /** Brings up whichever search tab is already visible, else the default view. */
  const showSearch = async () => {
    const visible = editorTabs.find((t) => t.panel.visible);
    if (visible) visible.panel.reveal(undefined, true);
    else await openTab();
  };

  /** Moves the bottom panel search into an editor tab (and hides the panel), keeping its options. */
  const moveToEditor = async () => {
    const options = store.options;
    openEditor(options.query).controller.load(options);
    await vscode.commands.executeCommand('workbench.action.closePanel');
  };

  /** Moves the active search tab back into the bottom panel. */
  const moveToPanel = async () => {
    const tab = editorTabs.find((t) => t.panel.active) ?? editorTabs[0];
    const options = store.options;
    await openView(options.query);
    viewController?.load(options);
    tab?.panel.dispose();
  };

  // ------------------------------------------------------------ status bar
  const statusItem = vscode.window.createStatusBarItem('searchHere.status', vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Search Here';
  statusItem.text = '$(search) Search';
  statusItem.tooltip = 'Search Here (Ctrl+Alt+F)';
  statusItem.command = 'searchHere.open';
  const updateStatusItem = () => {
    if (vscode.workspace.getConfiguration('searchHere').get('showStatusBarItem', true)) statusItem.show();
    else statusItem.hide();
  };
  updateStatusItem();
  ctx.subscriptions.push(
    statusItem,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('searchHere.showStatusBarItem')) updateStatusItem();
    }),
  );

  // ------------------------------------------------------------ explorer helpers
  const explorerTargets = async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const list = uris?.length ? uris : uri ? [uri] : [];
    const out: { pattern: string; isRoot: boolean }[] = [];
    for (const u of list) {
      const folder = vscode.workspace.getWorkspaceFolder(u);
      const rel = folder ? relativeInside(folder.uri.fsPath, u.fsPath) : null;
      if (rel === null) continue;
      if (rel === '') {
        out.push({ pattern: '', isRoot: true });
        continue;
      }
      const stat = await vscode.workspace.fs.stat(u);
      out.push({ pattern: patternForPath(rel, (stat.type & vscode.FileType.Directory) !== 0), isRoot: false });
    }
    return out;
  };

  const register = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('searchHere.open', () => openSearch(selectedText()));
  register('searchHere.openView', () => openView(selectedText()));
  register('searchHere.openNewEditor', () => openEditor(selectedText(), true));
  register('searchHere.moveToEditor', moveToEditor);
  register('searchHere.moveToPanel', moveToPanel);
  register('searchHere.openEditor', () => openEditor(selectedText()));
  register('searchHere.quickSearch', () => quickSearch(services, selectedText(), openFull));
  register('searchHere.quickNextMode', () => nextQuickMode());

  register('searchHere.searchInFolder', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const targets = await explorerTargets(uri, uris);
    const include = targets.filter((t) => !t.isRoot).map((t) => t.pattern).join(', ');
    await store.setOptions({ include, scopeId: 'project' }, { rerun: true });
    await openTab();
  });

  register('searchHere.includeInSearch', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const targets = (await explorerTargets(uri, uris)).filter((t) => !t.isRoot);
    if (!targets.length) return;
    let { include, exclude } = store.options;
    for (const t of targets) {
      include = addPattern(include, t.pattern);
      exclude = removePattern(exclude, t.pattern);
    }
    await store.setOptions({ include, exclude }, { rerun: true });
    vscode.window.setStatusBarMessage(`Search Here: included ${targets.map((t) => t.pattern).join(', ')}`, 3000);
    await showSearch();
  });

  register('searchHere.excludeFromSearch', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const targets = (await explorerTargets(uri, uris)).filter((t) => !t.isRoot);
    if (!targets.length) return;
    let { include, exclude } = store.options;
    for (const t of targets) {
      exclude = addPattern(exclude, t.pattern);
      include = removePattern(include, t.pattern);
    }
    await store.setOptions({ include, exclude }, { rerun: true });
    vscode.window.setStatusBarMessage(`Search Here: excluded ${targets.map((t) => t.pattern).join(', ')}`, 3000);
    await showSearch();
  });

  register('searchHere.excludeAlways', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const targets = (await explorerTargets(uri, uris)).filter((t) => !t.isRoot);
    if (!targets.length) return;
    const config = vscode.workspace.getConfiguration('searchHere');
    const current = config.get<string[]>('exclude', []);
    const next = [...new Set([...current, ...targets.map((t) => t.pattern)])];
    await config.update('exclude', next, vscode.ConfigurationTarget.Workspace);
    await store.setOptions({}, { rerun: true });
    vscode.window.showInformationMessage(
      `Added to "searchHere.exclude" in the workspace settings: ${targets.map((t) => t.pattern).join(', ')}`,
    );
  });

  register('searchHere.clearFilters', () => store.setOptions({ include: '', exclude: '' }, { rerun: true }));

  return { store, engine, index, theme };
}

function selectedText(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return undefined;
  const text = editor.document.getText(editor.selection);
  return text.includes('\n') || text.length > 200 ? undefined : text;
}

export function deactivate(): void {}
