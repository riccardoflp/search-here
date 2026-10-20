import * as assert from 'assert';
import * as vscode from 'vscode';
import { MatchItem } from '../protocol';
import { ripgrepPath } from '../rg';
import { api, fixture, search } from './helpers';

suite('Search engine (real ripgrep)', () => {
  test("finds VS Code's bundled ripgrep", () => {
    const rg = ripgrepPath();
    assert.notStrictEqual(rg, 'rg', 'expected the binary shipped with VS Code, not the PATH fallback');
    assert.ok(rg.startsWith(vscode.env.appRoot), rg);
  });

  test('finds text, skipping ignored and hidden files by default', async () => {
    const { textFiles, stats } = await search({ query: 'needle', mode: 'text' });
    assert.strictEqual(stats.error, undefined);
    assert.deepStrictEqual(textFiles, ['Dockerfile', 'dist/bundle.js', 'docs/Dockerfile', 'docs/guide.md', 'lib/src/other.ts', 'src/app.ts', 'src/util/helpers.ts']);
  });

  test('the ignore toggle searches ignored files too', async () => {
    const { textFiles } = await search({ query: 'needle', mode: 'text', respectIgnore: false });
    assert.ok(textFiles.includes('ignored/secret.ts'), textFiles.join());
  });

  test('the hidden toggle searches dot folders', async () => {
    const { textFiles } = await search({ query: 'needle', mode: 'text', hidden: true });
    assert.ok(textFiles.includes('.hidden/config.txt'), textFiles.join());
  });

  test('reports lines and match ranges in UTF-16, after accented characters', async () => {
    const { items } = await search({ query: 'needle after', mode: 'text' });
    const m = items.find((i): i is MatchItem => i.kind === 'match');
    assert.ok(m);
    assert.strictEqual(m.rel, 'src/app.ts');
    assert.strictEqual(m.line, 3);
    const line = '// città: needle after accented characters';
    assert.deepStrictEqual(m.ranges, [[line.indexOf('needle'), line.indexOf('needle') + 'needle after'.length]]);
  });

  test('case sensitive and whole word options', async () => {
    const upper = await search({ query: 'NEEDLE', mode: 'text', caseSensitive: true });
    assert.deepStrictEqual(upper.textFiles, ['src/app.ts']);
    const word = await search({ query: 'needle', mode: 'text', wholeWord: true, include: './src' });
    const lines = word.items.filter((i): i is MatchItem => i.kind === 'match').map((i) => `${i.rel}:${i.line}`);
    // "needlework" and "findNeedle" are not whole words.
    assert.deepStrictEqual(lines.sort(), ['src/app.ts:1', 'src/app.ts:3', 'src/util/helpers.ts:0']);
  });

  test('regular expressions, with lookaround through PCRE2', async () => {
    const { textFiles } = await search({ query: 'need(?=le in lib)', mode: 'text', regex: true });
    assert.deepStrictEqual(textFiles, ['lib/src/other.ts']);
  });

  test('an invalid regular expression is reported, not thrown', async () => {
    const { stats } = await search({ query: 'needle(', mode: 'text', regex: true });
    assert.match(stats.error ?? '', /Invalid regular expression/);
  });

  test('include: a bare name matches anywhere, ./ anchors to the root', async () => {
    assert.deepStrictEqual((await search({ query: 'needle', mode: 'text', include: 'src' })).textFiles, [
      'lib/src/other.ts',
      'src/app.ts',
      'src/util/helpers.ts',
    ]);
    assert.deepStrictEqual((await search({ query: 'needle', mode: 'text', include: './src' })).textFiles, ['src/app.ts', 'src/util/helpers.ts']);
  });

  test('exclude: ./file only at the root, folder/ anywhere', async () => {
    const root = await search({ query: 'needle', mode: 'text', exclude: './Dockerfile' });
    assert.ok(!root.textFiles.includes('Dockerfile'));
    assert.ok(root.textFiles.includes('docs/Dockerfile'));
    const dist = await search({ query: 'needle', mode: 'text', exclude: 'dist/, docs' });
    assert.deepStrictEqual(dist.textFiles, ['Dockerfile', 'lib/src/other.ts', 'src/app.ts', 'src/util/helpers.ts']);
  });

  test('the searchHere.exclude setting always applies', async () => {
    const config = vscode.workspace.getConfiguration('searchHere');
    await config.update('exclude', ['lib'], vscode.ConfigurationTarget.Global);
    try {
      const { textFiles } = await search({ query: 'needle', mode: 'text' });
      assert.ok(!textFiles.includes('lib/src/other.ts'), textFiles.join());
    } finally {
      await config.update('exclude', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('file names: fuzzy, best match first', async () => {
    const { files } = await search({ query: 'helpers', mode: 'files' });
    assert.deepStrictEqual(files, ['src/util/helpers.ts']);
    const { items } = await search({ query: 'dockerfile', mode: 'files' });
    assert.strictEqual(items[0].rel, 'Dockerfile');
  });

  test('folder names, derived from the files that pass the filters', async () => {
    assert.deepStrictEqual((await search({ query: 'util', mode: 'folders' })).folders, ['src/util']);
    assert.deepStrictEqual((await search({ query: 'ignored', mode: 'folders' })).folders, []);
    assert.deepStrictEqual((await search({ query: 'ignored', mode: 'folders', respectIgnore: false })).folders, ['ignored']);
  });

  test('an empty query lists every file in Files mode', async () => {
    const { files } = await search({ query: '', mode: 'files' });
    assert.strictEqual(files.length, 7);
  });

  test('All mode returns names and text together', async () => {
    const { files, folders, textFiles } = await search({ query: 'util', mode: 'all' });
    assert.deepStrictEqual(folders, ['src/util']);
    assert.deepStrictEqual(files, ['src/util/helpers.ts']);
    assert.deepStrictEqual(textFiles, []);
  });

  test('Active Folder scope searches the folder of the last editor', async () => {
    const { engine } = await api();
    const before = engine.activeFolder;
    engine.activeFolder = fixture('src', 'util');
    try {
      const { textFiles } = await search({ query: 'needle', mode: 'text', scopeId: 'activeFolder' });
      assert.deepStrictEqual(textFiles, ['src/util/helpers.ts']);
    } finally {
      engine.activeFolder = before;
    }
  });

  test('a saved scope combines its folders and filters with the ones typed in the view', async () => {
    const { store } = await api();
    await store.saveScope({ id: 'workspace:test', name: 'Sources', kind: 'workspace', icon: '', paths: ['src', 'lib'], include: [], exclude: ['**/other.ts'] });
    try {
      assert.deepStrictEqual((await search({ query: 'needle', mode: 'text', scopeId: 'workspace:test' })).textFiles, ['src/app.ts', 'src/util/helpers.ts']);
      // Scope include and view include must both match (ripgrep alone would OR them).
      await store.saveScope({ id: 'workspace:test', name: 'Sources', kind: 'workspace', icon: '', paths: [], include: ['./src'], exclude: [] });
      assert.deepStrictEqual((await search({ query: 'needle', mode: 'text', scopeId: 'workspace:test', include: 'helpers.ts' })).textFiles, [
        'src/util/helpers.ts',
      ]);
    } finally {
      await store.deleteScope('workspace:test');
    }
  });

  test('Open Files scope searches only the open editors', async () => {
    await vscode.window.showTextDocument(vscode.Uri.file(fixture('docs', 'guide.md')));
    try {
      const { textFiles } = await search({ query: 'needle', mode: 'text', scopeId: 'open' });
      assert.deepStrictEqual(textFiles, ['docs/guide.md']);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
