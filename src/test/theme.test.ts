import * as assert from 'assert';
import * as vscode from 'vscode';
import { STYLE_COLOR_BITS } from '../protocol';
import { api } from './helpers';

const CODE = 'const s = "x"; // note\nif (s) return;';

/** The color and font style of the token at `line`:`col`, as the theme CSS gives them. */
function styleAt(css: string, tokens: number[][] | undefined, line: number, col: number): { color: string; fontStyle: number } {
  const pairs = tokens?.[line];
  assert.ok(pairs, `no tokens for line ${line}`);
  let style = 0;
  for (let i = 0; i < pairs.length && pairs[i] <= col; i += 2) style = pairs[i + 1];
  const index = style & ((1 << STYLE_COLOR_BITS) - 1);
  const color = index === 1 ? 'default' : new RegExp(`\\.mtk${index}\\{color:(#[0-9a-f]+)\\}`, 'i').exec(css)?.[1].toLowerCase();
  assert.ok(color, `no color for .mtk${index} in:\n${css}`);
  return { color, fontStyle: style >> STYLE_COLOR_BITS };
}

suite('Theme syntax colors', () => {
  teardown(async () => {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('editor').update('tokenColorCustomizations', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('files').update('associations', undefined, vscode.ConfigurationTarget.Global);
  });

  test('tokenizes with the grammar of the file and the colors of the theme', async () => {
    const { theme } = await api();
    const workbench = vscode.workspace.getConfiguration('workbench');
    // Dark+ takes its base colors from Dark (Visual Studio) through "include".
    await workbench.update('colorTheme', 'Dark+', vscode.ConfigurationTarget.Global);
    let css = await themeCss((c) => /#c586c0/i.test(c));
    let tokens = await theme.tokenize('/w/app.ts', CODE);
    assert.strictEqual(styleAt(css, tokens, 0, 0).color, '#569cd6');
    assert.strictEqual(styleAt(css, tokens, 0, 6).color, '#4fc1ff');
    assert.strictEqual(styleAt(css, tokens, 0, 10).color, '#ce9178');
    assert.strictEqual(styleAt(css, tokens, 0, 15).color, '#6a9955');
    assert.strictEqual(styleAt(css, tokens, 1, 0).color, '#c586c0');
    assert.strictEqual(styleAt(css, tokens, 1, 3).color, 'default');

    await workbench.update('colorTheme', 'Light+', vscode.ConfigurationTarget.Global);
    css = await themeCss((c) => /#af00db/i.test(c));
    tokens = await theme.tokenize('/w/app.ts', CODE);
    assert.strictEqual(styleAt(css, tokens, 0, 10).color, '#a31515');
    assert.strictEqual(styleAt(css, tokens, 1, 0).color, '#af00db');
  });

  test('applies editor.tokenColorCustomizations', async () => {
    const { theme } = await api();
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Dark+', vscode.ConfigurationTarget.Global);
    await themeCss((c) => /#c586c0/i.test(c));
    await vscode.workspace.getConfiguration('editor').update(
      'tokenColorCustomizations',
      {
        comments: '#123456',
        '[Light*]': { strings: '#000001' },
        '[Dark+]': { textMateRules: [{ scope: 'string', settings: { foreground: '#abcdef', fontStyle: 'italic' } }] },
      },
      vscode.ConfigurationTarget.Global,
    );
    const css = await themeCss((c) => /#123456/.test(c));
    const tokens = await theme.tokenize('/w/app.ts', CODE);
    assert.strictEqual(styleAt(css, tokens, 0, 15).color, '#123456');
    assert.deepStrictEqual(styleAt(css, tokens, 0, 10), { color: '#abcdef', fontStyle: 1 });
  });

  test('finds the language as VS Code does', async () => {
    const { theme } = await api();
    await themeCss((c) => c !== '');
    assert.ok(await theme.tokenize('/w/Dockerfile', 'FROM node:20'));
    assert.ok(await theme.tokenize('/w/script', '#!/bin/bash\necho hi'));
    assert.strictEqual(await theme.tokenize('/w/notes.unknown', 'const s = 1;'), undefined);
    assert.ok(await theme.tokenize('/w/notes.unknown', 'const s = 1;', 'typescript'));
    await vscode.workspace.getConfiguration('files').update('associations', { '*.unknown': 'typescript' }, vscode.ConfigurationTarget.Global);
    assert.ok(await theme.tokenize('/w/notes.unknown', 'const s = 1;'));
  });
});

/** Waits for the theme CSS to satisfy `ready`: changes reach it through events. */
async function themeCss(ready: (css: string) => boolean): Promise<string> {
  const { theme } = await api();
  return new Promise<string>((resolve, reject) => {
    const done = (css: string) => {
      if (!ready(css)) return;
      clearTimeout(timer);
      sub.dispose();
      resolve(css);
    };
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error('the theme CSS did not change as expected'));
    }, 10000);
    const sub = theme.onDidChange(done);
    void theme.get().then(done);
  });
}
