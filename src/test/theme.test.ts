import * as assert from 'assert';
import * as vscode from 'vscode';
import { resolveStyle, TokenRule } from '../theme';
import { api } from './helpers';

/** The CSS declarations generated for one highlight.js selector. */
function ruleFor(css: string, selector: string): string {
  const line = css.split('\n').find((l) => l.startsWith(`.code-view.hljs ${selector}{`));
  assert.ok(line, `no rule for ${selector} in:\n${css}`);
  return line.slice(line.indexOf('{'));
}

suite('Theme syntax colors', () => {
  test('the most specific selector wins, later rules win ties', () => {
    const rules: TokenRule[] = [
      { scope: 'keyword', settings: { foreground: '#111111' } },
      { scope: ['keyword.control'], settings: { foreground: '#222222' } },
      { scope: 'keyword.control, string', settings: { foreground: '#333333' } },
      { scope: 'source.js keyword.control', settings: { foreground: '#444444' } },
    ];
    assert.strictEqual(resolveStyle(rules, ['keyword.control.import']).color, '#333333');
    assert.strictEqual(resolveStyle(rules, ['keyword.other']).color, '#111111');
    assert.strictEqual(resolveStyle(rules, ['keywords']).color, undefined);
  });

  test('exclusions, fallback scopes and font styles', () => {
    const rules: TokenRule[] = [
      { scope: 'keyword - keyword.operator', settings: { foreground: '#111111' } },
      { scope: 'entity.name', settings: { foreground: '#222222', fontStyle: 'bold' } },
      { scope: 'entity.name.function', settings: { fontStyle: 'italic' } },
      { scope: 'comment', settings: { foreground: 'not a color' } },
    ];
    assert.strictEqual(resolveStyle(rules, ['keyword.operator']).color, undefined);
    assert.deepStrictEqual(resolveStyle(rules, ['entity.name.function']), { color: '#222222', fontStyle: 'italic' });
    assert.strictEqual(resolveStyle(rules, ['support.class', 'entity.name.type']).color, '#222222');
    assert.strictEqual(resolveStyle(rules, ['comment']).color, undefined);
  });

  teardown(async () => {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('editor').update('tokenColorCustomizations', undefined, vscode.ConfigurationTarget.Global);
  });

  test('follows the color theme, reading it through its includes', async () => {
    const workbench = vscode.workspace.getConfiguration('workbench');
    // Dark+ takes its base colors from Dark (Visual Studio) through "include".
    await workbench.update('colorTheme', 'Dark+', vscode.ConfigurationTarget.Global);
    let css = await themeCss((c) => /#c586c0/i.test(c));
    assert.match(ruleFor(css, '.hljs-string'), /color:#ce9178;/i);
    assert.match(ruleFor(css, '.hljs-comment'), /color:#6a9955;/i);
    assert.match(ruleFor(css, '.hljs-keyword'), /color:#569cd6;/i);
    assert.match(ruleFor(css, '.hljs-keyword.sh-control'), /color:#c586c0;/i);
    assert.match(ruleFor(css, '.hljs-title.function_'), /color:#dcdcaa;/i);

    await workbench.update('colorTheme', 'Light+', vscode.ConfigurationTarget.Global);
    css = await themeCss((c) => /#af00db/i.test(c));
    assert.match(ruleFor(css, '.hljs-string'), /color:#a31515;/i);
  });

  test('applies editor.tokenColorCustomizations', async () => {
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
    assert.match(ruleFor(css, '.hljs-comment'), /color:#123456;/);
    assert.match(ruleFor(css, '.hljs-string'), /color:#abcdef;font-style:italic;/);
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
