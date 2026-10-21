import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import { INITIAL, IOnigLib, IRawTheme, parseRawGrammar, Registry, StateStack } from 'vscode-textmate';
import * as vscode from 'vscode';
import { Grammars } from './grammars';
import { STYLE_COLOR_BITS } from './protocol';

export type TokenRule = IRawTheme['settings'][number];

/** Scopes behind the shorthand keys of `editor.tokenColorCustomizations`, as VS Code defines them. */
const CUSTOMIZATION_SCOPES: Record<string, string[]> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

/** Built-in themes renamed by VS Code: the settings may still hold the old name. */
const RENAMED_THEMES: Record<string, string> = {
  'Default Dark Modern': 'Dark Modern',
  'Default Light Modern': 'Light Modern',
  'Default Dark+': 'Dark+',
  'Default Light+': 'Light+',
};

const THEME_SETTINGS = [
  'workbench.colorTheme',
  'workbench.preferredDarkColorTheme',
  'workbench.preferredLightColorTheme',
  'workbench.preferredHighContrastColorTheme',
  'workbench.preferredHighContrastLightColorTheme',
  'window.autoDetectColorScheme',
  'editor.tokenColorCustomizations',
];

/** Time spent tokenizing one file: the lines after it are shown without colors. */
const TOKENIZE_BUDGET_MS = 1000;
/** How long to tokenize before letting other work of the extension host run. */
const TOKENIZE_SLICE_MS = 10;

/** Layout of the token metadata of vscode-textmate. */
const FONT_STYLE_MASK = 0x7800;
const FONT_STYLE_OFFSET = 11;
const FOREGROUND_MASK = 0xff8000;
const FOREGROUND_OFFSET = 15;

interface Syntax {
  registry: Registry;
  grammars: Grammars;
  css: string;
}

/**
 * Colors code as the editor does: the file is tokenized with the TextMate grammars of the
 * installed extensions and styled with the token colors of the active color theme.
 */
export class SyntaxTheme implements vscode.Disposable {
  private syntax?: Promise<Syntax | undefined>;
  private generation = 0;
  private readonly emitter = new vscode.EventEmitter<string>();
  /** Fires the CSS of the new theme; tokens computed before it no longer match it. */
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[];

  constructor(private readonly extensionPath: string) {
    const refresh = () => {
      this.syntax = undefined;
      const generation = ++this.generation;
      void this.get().then((css) => {
        if (generation === this.generation) this.emitter.fire(css);
      });
    };
    this.subs = [
      this.emitter,
      vscode.window.onDidChangeActiveColorTheme(refresh),
      vscode.extensions.onDidChange(refresh),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (THEME_SETTINGS.some((s) => e.affectsConfiguration(s))) refresh();
      }),
    ];
  }

  /** CSS for the token colors of the active theme (`.mtk<index>` classes), or '' when it cannot be read. */
  async get(): Promise<string> {
    return (await this.load())?.css ?? '';
  }

  /** The tokens of each line of `text`, as the `tokens` of a file preview describes them. */
  async tokenize(file: string, text: string, languageId?: string): Promise<number[][] | undefined> {
    try {
      const syntax = await this.load();
      if (!syntax) return undefined;
      const lines = text.split(/\r?\n/);
      const scope = syntax.grammars.scopeFor(file, lines[0], languageId);
      const grammar = scope && (await syntax.registry.loadGrammar(scope));
      if (!grammar) return undefined;
      const maxLineLength = vscode.workspace.getConfiguration('editor').get<number>('maxTokenizationLineLength') ?? 20000;
      const deadline = Date.now() + TOKENIZE_BUDGET_MS;
      let sliceEnd = Date.now() + TOKENIZE_SLICE_MS;
      let state: StateStack = INITIAL;
      const out: number[][] = [];
      for (const line of lines) {
        if (Date.now() > sliceEnd) {
          if (Date.now() > deadline) break;
          await new Promise((resolve) => setImmediate(resolve));
          sliceEnd = Date.now() + TOKENIZE_SLICE_MS;
        }
        // Like the editor, very long lines are not tokenized and keep the state of the previous line.
        if (line.length > maxLineLength) {
          out.push([]);
          continue;
        }
        const result = grammar.tokenizeLine2(line, state, 500);
        if (!result.stoppedEarly) state = result.ruleStack;
        out.push(lineStyles(result.tokens));
      }
      return out;
    } catch {
      return undefined;
    }
  }

  private load(): Promise<Syntax | undefined> {
    return (this.syntax ??= loadSyntax(this.extensionPath).catch(() => undefined));
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }
}

/** Token pairs of vscode-textmate (start, metadata) as pairs of start and style, adjacent equal styles merged. */
function lineStyles(tokens: Uint32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const meta = tokens[i + 1];
    const style =
      ((meta & FOREGROUND_MASK) >>> FOREGROUND_OFFSET) | (((meta & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET) << STYLE_COLOR_BITS);
    if (out.length && out[out.length - 1] === style) continue;
    out.push(tokens[i], style);
  }
  return out;
}

let onigLib: Promise<IOnigLib> | undefined;

function loadOniguruma(extensionPath: string): Promise<IOnigLib> {
  return (onigLib ??= fs.promises.readFile(path.join(extensionPath, 'dist', 'onig.wasm')).then(async (wasm) => {
    await oniguruma.loadWASM(wasm);
    return {
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    };
  }));
}

async function loadSyntax(extensionPath: string): Promise<Syntax | undefined> {
  const theme = activeTheme();
  if (!theme) return undefined;
  const { rules, colors } = await loadTheme(theme.file);
  const settings: TokenRule[] = [];
  // As in VS Code, tokens that no rule colors take the editor foreground.
  const foreground = colors['editor.foreground'];
  if (typeof foreground === 'string') settings.push({ settings: { foreground } });
  settings.push(...rules, ...customizationRules(theme.settingsId));
  const grammars = new Grammars();
  const registry = new Registry({
    onigLib: loadOniguruma(extensionPath),
    theme: { settings },
    loadGrammar: async (scope) => {
      const file = grammars.fileOf(scope);
      return file ? parseRawGrammar(await fs.promises.readFile(file, 'utf8'), file) : null;
    },
    getInjections: (scope) => grammars.injectionsFor(scope),
  });
  // Index 1 is the default color: left to the editor foreground of the workbench, which also
  // follows `workbench.colorCustomizations`.
  const css = registry
    .getColorMap()
    .map((color, i) => (i > 1 ? `.code-view .mtk${i}{color:${color}}` : ''))
    .filter(Boolean)
    .join('\n');
  return { registry, grammars, css };
}

/** The color theme in use, found among the themes contributed by the installed extensions. */
function activeTheme(): { file: string; settingsId: string } | undefined {
  const workbench = vscode.workspace.getConfiguration('workbench');
  const kind = vscode.window.activeColorTheme.kind;
  const uiTheme = {
    [vscode.ColorThemeKind.Light]: 'vs',
    [vscode.ColorThemeKind.Dark]: 'vs-dark',
    [vscode.ColorThemeKind.HighContrast]: 'hc-black',
    [vscode.ColorThemeKind.HighContrastLight]: 'hc-light',
  }[kind];
  const candidates = [workbench.get<string>('colorTheme')];
  if (kind === vscode.ColorThemeKind.HighContrast) candidates.push(workbench.get<string>('preferredHighContrastColorTheme'));
  if (kind === vscode.ColorThemeKind.HighContrastLight) candidates.push(workbench.get<string>('preferredHighContrastLightColorTheme'));
  if (vscode.workspace.getConfiguration('window').get<boolean>('autoDetectColorScheme')) {
    if (kind === vscode.ColorThemeKind.Dark) candidates.unshift(workbench.get<string>('preferredDarkColorTheme'));
    if (kind === vscode.ColorThemeKind.Light) candidates.unshift(workbench.get<string>('preferredLightColorTheme'));
  }
  for (const name of candidates) {
    if (!name) continue;
    const names = new Set([name, RENAMED_THEMES[name], ...Object.keys(RENAMED_THEMES).filter((k) => RENAMED_THEMES[k] === name)]);
    for (const ext of vscode.extensions.all) {
      const themes: { id?: string; label?: string; uiTheme?: string; path?: string }[] = ext.packageJSON?.contributes?.themes ?? [];
      // A theme that does not fit the kind VS Code reports is not the one in use.
      const theme = themes.find((t) => t.path && names.has(t.id ?? t.label ?? '') && (t.uiTheme ?? 'vs-dark') === uiTheme);
      if (theme) return { file: path.join(ext.extensionPath, theme.path!), settingsId: name };
    }
  }
  return undefined;
}

/** The token color rules and the workbench colors of a theme file, following `include` and tmTheme references. */
async function loadTheme(file: string, depth = 0): Promise<{ rules: TokenRule[]; colors: Record<string, unknown> }> {
  if (depth > 10) return { rules: [], colors: {} };
  const text = await fs.promises.readFile(file, 'utf8');
  if (/\.tmTheme$/i.test(file) || text.trimStart().startsWith('<')) {
    const plist = parsePlist(text) as { settings?: TokenRule[] } | undefined;
    return { rules: Array.isArray(plist?.settings) ? plist.settings : [], colors: {} };
  }
  const json = parseJsonc(text) as { include?: unknown; tokenColors?: unknown; colors?: unknown };
  const dir = path.dirname(file);
  const rules: TokenRule[] = [];
  const colors: Record<string, unknown> = {};
  if (typeof json.include === 'string') {
    const base = await loadTheme(path.resolve(dir, json.include), depth + 1);
    rules.push(...base.rules);
    Object.assign(colors, base.colors);
  }
  if (typeof json.tokenColors === 'string') rules.push(...(await loadTheme(path.resolve(dir, json.tokenColors), depth + 1)).rules);
  else if (Array.isArray(json.tokenColors)) rules.push(...json.tokenColors);
  if (json.colors && typeof json.colors === 'object') Object.assign(colors, json.colors);
  return { rules, colors };
}

/** Rules from `editor.tokenColorCustomizations`: the general ones, then the ones for this theme. */
function customizationRules(settingsId: string): TokenRule[] {
  const custom = vscode.workspace.getConfiguration('editor').get<Record<string, unknown>>('tokenColorCustomizations') ?? {};
  const toRules = (block: Record<string, unknown>): TokenRule[] => {
    const rules: TokenRule[] = [];
    for (const [key, scopes] of Object.entries(CUSTOMIZATION_SCOPES)) {
      const value = block[key];
      if (typeof value === 'string') rules.push({ scope: scopes, settings: { foreground: value } });
      else if (value && typeof value === 'object') rules.push({ scope: scopes, settings: value as TokenRule['settings'] });
    }
    if (Array.isArray(block.textMateRules)) rules.push(...block.textMateRules);
    return rules;
  };
  const rules = toRules(custom);
  for (const [key, block] of Object.entries(custom)) {
    if (key.startsWith('[') && key.endsWith(']') && block && typeof block === 'object') {
      const matches = key
        .slice(1, -1)
        .split('][')
        .some((pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(settingsId));
      if (matches) rules.push(...toRules(block as Record<string, unknown>));
    }
  }
  return rules;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** JSON with comments and trailing commas, as theme files are written. */
function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1, i + 200))) {
      // Trailing comma: dropped.
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
}

/** The subset of XML property lists used by tmTheme files. */
function parsePlist(xml: string): unknown {
  const decode = (s: string) =>
    s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e]!);
  // Each open container, with the key it will be stored under in its parent.
  const stack: { value: Record<string, unknown> | unknown[]; key?: string }[] = [];
  let root: unknown;
  let key: string | undefined;
  let last = 0;
  const add = (value: unknown) => {
    const top = stack[stack.length - 1]?.value;
    if (!top) root ??= value;
    else if (Array.isArray(top)) top.push(value);
    else if (key !== undefined) top[key] = value;
    key = undefined;
  };
  for (const m of xml.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
    const inner = xml.slice(last, m.index);
    last = m.index! + m[0].length;
    const [, close, tag, selfClosing] = m;
    if (tag === 'dict' || tag === 'array') {
      if (selfClosing) add(tag === 'dict' ? {} : []);
      else if (!close) {
        stack.push({ value: tag === 'dict' ? {} : [], key });
        key = undefined;
      } else {
        const done = stack.pop();
        key = done?.key;
        add(done?.value);
      }
    } else if (tag === 'true' || tag === 'false') {
      add(tag === 'true');
    } else if (tag === 'key' && close) {
      key = decode(inner);
    } else if ((tag === 'string' || tag === 'integer' || tag === 'real') && (close || selfClosing)) {
      add(selfClosing ? '' : decode(inner));
    }
  }
  return root;
}
