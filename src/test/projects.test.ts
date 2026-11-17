import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { api, fixture, search, waitFor } from './helpers';

suite('Projects', () => {
  teardown(async () => {
    const { store } = await api();
    await store.setOptions({ project: '', scopeId: 'project' });
    await store.deleteScope('workspace:projects-test');
  });

  test('finds the projects inside the workspace folder by their marker files', async () => {
    const { projects } = await api();
    const list = await projects.list();
    assert.deepStrictEqual(
      list.map((p) => [p.name, p.kind, p.marker]),
      [['lib', 'sub', 'package.json']],
    );
    assert.strictEqual(projects.containing(fixture('lib', 'src'))?.name, 'lib');
    assert.strictEqual(projects.containing(fixture('src')), undefined);
  });

  test('a picked project restricts every search to its folder', async () => {
    const lib = fixture('lib');
    assert.deepStrictEqual((await search({ query: 'needle', mode: 'text', project: lib })).textFiles, ['lib/src/other.ts']);
    assert.deepStrictEqual((await search({ query: '', mode: 'files', project: lib })).files, ['lib/package.json', 'lib/src/other.ts']);
  });

  test('scope folders are relative to the picked project', async () => {
    const { store } = await api();
    await store.saveScope({ id: 'workspace:projects-test', name: 'Sources', kind: 'workspace', icon: '', paths: ['src'], include: [], exclude: [] });
    const scopeId = 'workspace:projects-test';
    assert.deepStrictEqual((await search({ query: 'needle', mode: 'text', scopeId })).textFiles, ['src/app.ts', 'src/util/helpers.ts']);
    assert.deepStrictEqual((await search({ query: 'needle', mode: 'text', scopeId, project: fixture('lib') })).textFiles, ['lib/src/other.ts']);
  });

  test('Current project follows the active file', async () => {
    const { engine } = await api();
    const before = engine.activeFolder;
    try {
      engine.activeFolder = fixture('lib', 'src');
      assert.deepStrictEqual((await search({ query: 'needle', mode: 'text', project: 'current' })).textFiles, ['lib/src/other.ts']);
      // Outside every project: the whole workspace.
      engine.activeFolder = fixture('src');
      assert.ok((await search({ query: 'needle', mode: 'text', project: 'current' })).textFiles.includes('src/app.ts'));
    } finally {
      engine.activeFolder = before;
    }
  });

  test('a scope bound to a project searches in it and hides while another project is picked', async () => {
    const { store } = await api();
    const scopeId = 'workspace:projects-test';
    await store.saveScope({ id: scopeId, name: 'Lib', kind: 'workspace', icon: '', paths: ['src'], include: [], exclude: [], project: 'lib' });
    // The scope's project wins over the selector.
    assert.deepStrictEqual((await search({ query: 'needle', mode: 'text', scopeId, project: '' })).textFiles, ['lib/src/other.ts']);
    assert.ok(store.scopes().some((s) => s.id === scopeId));
    await store.setOptions({ project: fixture('src') });
    assert.ok(!store.scopes().some((s) => s.id === scopeId));
    await store.setOptions({ project: fixture('lib') });
    assert.ok(store.scopes().some((s) => s.id === scopeId));
  });

  test('a scope bound to a missing project says so', async () => {
    const { store } = await api();
    const scopeId = 'workspace:projects-test';
    await store.saveScope({ id: scopeId, name: 'Gone', kind: 'workspace', icon: '', paths: [], include: [], exclude: [], project: 'gone' });
    const { stats, items } = await search({ query: 'needle', mode: 'text', scopeId });
    assert.strictEqual(items.length, 0);
    assert.match(stats.warning ?? '', /"gone".*not found/);
  });

  test('a scope that requires a file shows only where a project has it', async () => {
    const { store } = await api();
    const scopeId = 'workspace:projects-test';
    const shown = () => store.scopes().some((s) => s.id === scopeId);
    await store.saveScope({ id: scopeId, name: 'Rust', kind: 'workspace', icon: '', paths: [], include: [], exclude: [], requires: ['Cargo.toml'] });
    assert.ok(!shown());
    await store.saveScope({ id: scopeId, name: 'Node', kind: 'workspace', icon: '', paths: [], include: [], exclude: [], requires: ['*.json'] });
    assert.ok(shown());
    await store.setOptions({ project: fixture('src') });
    assert.ok(!shown());
  });

  test('the detection follows its settings and new marker files', async () => {
    const { projects } = await api();
    const config = vscode.workspace.getConfiguration('searchHere.projects');
    await config.update('detect', false, vscode.ConfigurationTarget.Global);
    try {
      assert.deepStrictEqual(await projects.list(), []);
    } finally {
      await config.update('detect', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.strictEqual((await projects.list()).length, 1);

    const marker = fixture('docs', 'go.mod');
    fs.writeFileSync(marker, 'module docs\n');
    try {
      await waitFor(() => projects.snapshot.some((p) => p.name === 'docs'), 'the new project', 8000);
    } finally {
      fs.unlinkSync(marker);
    }
    await waitFor(() => !projects.snapshot.some((p) => p.name === 'docs'), 'the project to go away', 8000);
  });
});
