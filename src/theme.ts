import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

export interface TokenStyle {
  color?: string;
  fontStyle?: string;
}

/**
 * highlight.js classes and the TextMate scopes that color them in VS Code themes, most
 * specific first: the first scope the theme has a color for is used.
 */
const CATEGORIES: { selector: string; scopes: string[]; fontStyle?: string }[] = [
  { selector: '.hljs-keyword', scopes: ['storage.type', 'keyword'] },
  { selector: '.hljs-keyword.sh-control', scopes: ['keyword.control'] },
  { selector: '.hljs-built_in', scopes: ['support.class', 'support.function'] },
  { selector: '.hljs-type', scopes: ['entity.name.type', 'support.type'] },
  { selector: '.hljs-literal', scopes: ['constant.language'] },
  { selector: '.hljs-number', scopes: ['constant.numeric'] },
  { selector: '.hljs-operator', scopes: ['keyword.operator'] },
  { selector: '.hljs-punctuation', scopes: ['punctuation'] },
  { selector: '.hljs-property', scopes: ['variable.other.property', 'variable'] },
  { selector: '.hljs-regexp', scopes: ['string.regexp'] },
  { selector: '.hljs-string', scopes: ['string.quoted', 'string'] },
  { selector: '.hljs-char.escape_', scopes: ['constant.character.escape'] },
  { selector: '.hljs-subst', scopes: ['meta.template.expression'] },
  { selector: '.hljs-symbol', scopes: ['constant.other.symbol', 'constant.other'] },
  { selector: '.hljs-variable, .hljs-template-variable', scopes: ['variable.other.readwrite', 'variable'] },
  { selector: '.hljs-variable.language_', scopes: ['variable.language'] },
  { selector: '.hljs-variable.constant_', scopes: ['variable.other.constant', 'constant'] },
  { selector: '.hljs-title', scopes: ['entity.name'] },
  { selector: '.hljs-title.class_', scopes: ['entity.name.type.class', 'entity.name.type', 'entity.name.class'] },
  { selector: '.hljs-title.class_.inherited__', scopes: ['entity.other.inherited-class', 'entity.name.type'] },
  { selector: '.hljs-title.function_', scopes: ['entity.name.function'] },
  { selector: '.hljs-params', scopes: ['variable.parameter'] },
  { selector: '.hljs-comment', scopes: ['comment'] },
  { selector: '.hljs-doctag', scopes: ['storage.type.class.jsdoc', 'comment.block.documentation'] },
  { selector: '.hljs-meta', scopes: ['meta.preprocessor', 'keyword.control.directive'] },
  { selector: '.hljs-meta .hljs-keyword', scopes: ['keyword.control.directive', 'keyword'] },
  { selector: '.hljs-meta .hljs-string', scopes: ['string'] },
  { selector: '.hljs-section', scopes: ['markup.heading', 'entity.name.section'] },
  { selector: '.hljs-tag', scopes: ['punctuation.definition.tag'] },
  { selector: '.hljs-name', scopes: ['entity.name.tag'] },
  { selector: '.hljs-attr', scopes: ['entity.other.attribute-name', 'support.type.property-name'] },
  { selector: '.hljs-attribute', scopes: ['support.type.property-name', 'entity.other.attribute-name'] },
  { selector: '.hljs-selector-tag', scopes: ['entity.name.tag.css', 'entity.name.tag'] },
  { selector: '.hljs-selector-id', scopes: ['entity.other.attribute-name.id.css', 'entity.other.attribute-name'] },
  { selector: '.hljs-selector-class', scopes: ['entity.other.attribute-name.class.css', 'entity.other.attribute-name'] },
  { selector: '.hljs-selector-attr, .hljs-selector-pseudo', scopes: ['entity.other.attribute-name.pseudo-class.css', 'entity.other.attribute-name'] },
  { selector: '.hljs-template-tag', scopes: ['punctuation.definition.template-expression', 'keyword'] },
  { selector: '.hljs-bullet', scopes: ['punctuation.definition.list.begin.markdown', 'markup.list'] },
  { selector: '.hljs-code', scopes: ['markup.inline.raw', 'markup.raw'] },
  { selector: '.hljs-emphasis', scopes: ['markup.italic'], fontStyle: 'italic' },
  { selector: '.hljs-strong', scopes: ['markup.bold'], fontStyle: 'bold' },
  { selector: '.hljs-link', scopes: ['markup.underline.link'] },
  { selector: '.hljs-quote', scopes: ['markup.quote'] },
  { selector: '.hljs-addition', scopes: ['markup.inserted'] },
  { selector: '.hljs-deletion', scopes: ['markup.deleted'] },
];

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

const COLOR = /^#[0-9a-f]{3,8}$/i;

/**
 * Turns the syntax colors of the active color theme into CSS for the highlight.js classes of
 * the preview, so that code looks as it does in the editor.
 */
export class SyntaxTheme implements vscode.Disposable {
  private css?: Promise<string>;
  private generation = 0;
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[];

  constructor() {
    const refresh = () => {
      this.css = undefined;
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

  /** CSS for the active theme, or '' when its colors cannot be read (the preview then keeps its default colors). */
  get(): Promise<string> {
    return (this.css ??= buildCss().catch(() => ''));
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }
}

async function buildCss(): Promise<string> {
  const theme = activeTheme();
  if (!theme) return '';
  const rules = [...(await loadRules(theme.file)), ...customizationRules(theme.settingsId)];
  return CATEGORIES.map(({ selector, scopes, fontStyle }) => {
    const style = resolveStyle(rules, scopes);
    const fs = style.fontStyle ?? fontStyle ?? '';
    const css = [
      `color:${style.color ?? 'var(--vscode-editor-foreground)'}`,
      `font-style:${fs.includes('italic') ? 'italic' : 'normal'}`,
      `font-weight:${fs.includes('bold') ? 'bold' : 'normal'}`,
      `text-decoration:${[fs.includes('underline') && 'underline', fs.includes('strikethrough') && 'line-through'].filter(Boolean).join(' ') || 'none'}`,
    ];
    const selectors = selector.split(',').map((s) => `.code-view.hljs ${s.trim()}`);
    return `${selectors.join(',')}{${css.join(';')}}`;
  }).join('\n');
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

/** The token color rules of a theme file, following `include` and tmTheme references. */
async function loadRules(file: string, depth = 0): Promise<TokenRule[]> {
  if (depth > 10) return [];
  const text = await fs.promises.readFile(file, 'utf8');
  if (/\.tmTheme$/i.test(file) || text.trimStart().startsWith('<')) {
    const plist = parsePlist(text) as { settings?: TokenRule[] } | undefined;
    return Array.isArray(plist?.settings) ? plist.settings : [];
  }
  const json = parseJsonc(text) as { include?: unknown; tokenColors?: unknown };
  const dir = path.dirname(file);
  const rules: TokenRule[] = [];
  if (typeof json.include === 'string') rules.push(...(await loadRules(path.resolve(dir, json.include), depth + 1)));
  if (typeof json.tokenColors === 'string') rules.push(...(await loadRules(path.resolve(dir, json.tokenColors), depth + 1)));
  else if (Array.isArray(json.tokenColors)) rules.push(...json.tokenColors);
  return rules;
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

/**
 * The style a theme gives to the first of `scopes` it has a color for, matching rule selectors
 * as TextMate does for a token with that single scope: the selector with the longest matching
 * prefix wins and later rules win ties. Color and font style are resolved separately.
 */
export function resolveStyle(rules: TokenRule[], scopes: string[]): TokenStyle {
  for (const scope of scopes) {
    const color = bestSetting(rules, scope, 'foreground');
    if (color) return { color, fontStyle: bestSetting(rules, scope, 'fontStyle') };
  }
  return { fontStyle: scopes.length ? bestSetting(rules, scopes[0], 'fontStyle') : undefined };
}

function bestSetting(rules: TokenRule[], scope: string, key: 'foreground' | 'fontStyle'): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  for (const rule of rules) {
    const value = rule.settings?.[key];
    if (typeof value !== 'string' || (key === 'foreground' && !COLOR.test(value)) || !rule.scope) continue;
    const selectors = Array.isArray(rule.scope) ? rule.scope : rule.scope.split(',');
    for (const selector of selectors) {
      const score = selectorScore(selector, scope);
      if (score && score >= bestScore) {
        best = value;
        bestScore = score;
      }
    }
  }
  return best;
}

/** How specifically `selector` matches `scope` (dot-separated segments), 0 when it does not. */
function selectorScore(selector: string, scope: string): number {
  const [include, ...excludes] = selector.split(/\s+-\s+/).map((s) => s.trim());
  // Selectors with parent scopes need the token's full scope stack, which the preview does not have.
  if (!include || /\s/.test(include)) return 0;
  const prefixOf = (sel: string) => scope === sel || scope.startsWith(sel + '.');
  if (!prefixOf(include) || excludes.some(prefixOf)) return 0;
  return include.split('.').length;
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
