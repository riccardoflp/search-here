import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, closeAllEditors, EXTENSION_ID, fixture, searchTabs, sleep, waitFor } from './helpers';

suite('Commands and views', () => {
  suiteSetup(async () => {
    await api();
  });

  teardown(async () => {
    await vscode.workspace.getConfiguration('searchHere').update('editorTab', undefined, vscode.ConfigurationTarget.Global);
    const { store } = await api();
    await store.setOptions({ include: '', exclude: '', scopeId: 'project', query: '' });
    await closeAllEditors();
  });

  test('registers every command declared in package.json', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(vscode.extensions.getExtension(EXTENSION_ID)!.extensionPath, 'package.json'), 'utf8'));
    const declared: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.deepStrictEqual(declared.filter((c) => !registered.has(c)), []);
  });

  test('editor tab: reuses the open tab by default', async () => {
    await vscode.commands.executeCommand('searchHere.openEditor');
    await waitFor(() => searchTabs().length === 1, 'the first search tab');
    await vscode.commands.executeCommand('searchHere.openEditor');
    await sleep(300);
    assert.strictEqual(searchTabs().length, 1);
  });

  test('editor tab: searchHere.editorTab = new opens a tab every time', async () => {
    await vscode.workspace.getConfiguration('searchHere').update('editorTab', 'new', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('searchHere.openEditor');
    await vscode.commands.executeCommand('searchHere.openEditor');
    await waitFor(() => searchTabs().length === 2, 'two search tabs');
  });

  test('Open Search in New Editor Tab always adds a tab', async () => {
    await vscode.commands.executeCommand('searchHere.openEditor');
    await vscode.commands.executeCommand('searchHere.openNewEditor');
    await waitFor(() => searchTabs().length === 2, 'two search tabs');
  });

  test('Move to Panel closes the search tab, Move to Editor Tab opens one', async () => {
    await vscode.commands.executeCommand('searchHere.openEditor');
    await waitFor(() => searchTabs().length === 1, 'the search tab');
    await vscode.commands.executeCommand('searchHere.moveToPanel');
    await waitFor(() => searchTabs().length === 0, 'the search tab to close');
    await vscode.commands.executeCommand('searchHere.moveToEditor');
    await waitFor(() => searchTabs().length === 1, 'the search tab to come back');
  });

  test('defaultOpen = editor makes Open Search use an editor tab', async () => {
    const config = vscode.workspace.getConfiguration('searchHere');
    await config.update('defaultOpen', 'editor', vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('searchHere.open');
      await waitFor(() => searchTabs().length === 1, 'the search tab');
    } finally {
      await config.update('defaultOpen', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('the quick search dialog opens and closes', async () => {
    await vscode.commands.executeCommand('searchHere.quickSearch');
    await sleep(300);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  });

  test('Explorer: include and exclude add anchored patterns to the filters', async () => {
    const { store } = await api();
    await vscode.commands.executeCommand('searchHere.includeInSearch', vscode.Uri.file(fixture('src')));
    assert.strictEqual(store.options.include, './src/');
    await vscode.commands.executeCommand('searchHere.excludeFromSearch', vscode.Uri.file(fixture('src', 'util')), [
      vscode.Uri.file(fixture('src', 'util')),
      vscode.Uri.file(fixture('Dockerfile')),
    ]);
    assert.strictEqual(store.options.exclude, './src/util/, ./Dockerfile');
    // Excluding what is included moves it from one list to the other.
    await vscode.commands.executeCommand('searchHere.excludeFromSearch', vscode.Uri.file(fixture('src')));
    assert.strictEqual(store.options.include, '');
    assert.strictEqual(store.options.exclude, './src/util/, ./Dockerfile, ./src/');
  });

  test('Explorer: Search Here restricts the search to the item', async () => {
    const { store } = await api();
    await store.setOptions({ scopeId: 'git' });
    await vscode.commands.executeCommand('searchHere.searchInFolder', vscode.Uri.file(fixture('docs')));
    assert.strictEqual(store.options.include, './docs/');
    assert.strictEqual(store.options.scopeId, 'project');
  });

  test('Clear Filters empties include and exclude', async () => {
    const { store } = await api();
    await store.setOptions({ include: 'a', exclude: 'b' });
    await vscode.commands.executeCommand('searchHere.clearFilters');
    assert.strictEqual(store.options.include, '');
    assert.strictEqual(store.options.exclude, '');
  });
});
