import * as path from 'path';
import * as vscode from 'vscode';

interface LanguageDef {
  id: string;
  extensions: string[];
  filenames: string[];
  patterns: { glob: string; re: RegExp }[];
  firstLine?: RegExp;
}

interface LanguageContribution {
  id?: string;
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
  firstLine?: string;
}

interface GrammarContribution {
  language?: string;
  scopeName?: string;
  path?: string;
  injectTo?: string[];
}

/**
 * The languages and TextMate grammars contributed by the installed extensions: the ones the
 * editor uses, so that the preview is tokenized as the editor tokenizes the file.
 */
export class Grammars {
  /** In registration order: later contributions win ties, as in VS Code. */
  private readonly languages: LanguageDef[] = [];
  private readonly scopeOfLanguage = new Map<string, string>();
  private readonly fileOfScope = new Map<string, string>();
  private readonly injections = new Map<string, string[]>();

  constructor() {
    for (const ext of vscode.extensions.all) {
      const contributes = ext.packageJSON?.contributes ?? {};
      for (const l of (contributes.languages ?? []) as LanguageContribution[]) {
        if (!l.id) continue;
        let firstLine: RegExp | undefined;
        try {
          if (l.firstLine) firstLine = new RegExp(l.firstLine);
        } catch {
          // Invalid pattern: ignored, as VS Code does.
        }
        this.languages.push({
          id: l.id,
          extensions: (l.extensions ?? []).map((e) => e.toLowerCase()),
          filenames: (l.filenames ?? []).map((f) => f.toLowerCase()),
          patterns: (l.filenamePatterns ?? []).map((g) => ({ glob: g, re: globToRegExp(g.toLowerCase()) })),
          firstLine,
        });
      }
      for (const g of (contributes.grammars ?? []) as GrammarContribution[]) {
        if (!g.scopeName || !g.path) continue;
        this.fileOfScope.set(g.scopeName, path.join(ext.extensionPath, g.path));
        if (g.language) this.scopeOfLanguage.set(g.language, g.scopeName);
        for (const target of g.injectTo ?? []) this.injections.set(target, [...(this.injections.get(target) ?? []), g.scopeName]);
      }
    }
  }

  /** The root scope of the grammar for a file, or undefined when no grammar applies to it. */
  scopeFor(file: string, firstLine: string, languageId = this.languageOf(file, firstLine)): string | undefined {
    return languageId && this.scopeOfLanguage.get(languageId);
  }

  fileOf(scope: string): string | undefined {
    return this.fileOfScope.get(scope);
  }

  injectionsFor(scope: string): string[] {
    return this.injections.get(scope) ?? [];
  }

  /**
   * The language VS Code gives a file: `files.associations` first, then the file names, file
   * name patterns and extensions of the languages (the longest match wins), then their first line.
   */
  languageOf(file: string, firstLine: string): string | undefined {
    const base = path.basename(file).toLowerCase();
    const full = file.replace(/\\/g, '/').toLowerCase();
    const target = (glob: string) => (glob.includes('/') ? full : base);

    const associations = vscode.workspace.getConfiguration('files').get<Record<string, string>>('associations') ?? {};
    let best: { id: string; length: number } | undefined;
    for (const [glob, id] of Object.entries(associations)) {
      const lower = glob.toLowerCase();
      if (typeof id === 'string' && (!best || lower.length > best.length) && globToRegExp(lower).test(target(lower))) {
        best = { id, length: lower.length };
      }
    }
    if (best) return best.id;

    const latest = [...this.languages].reverse();
    const byName = latest.find((l) => l.filenames.includes(base));
    if (byName) return byName.id;
    for (const l of latest) {
      for (const p of l.patterns) {
        if ((!best || p.glob.length > best.length) && p.re.test(target(p.glob))) best = { id: l.id, length: p.glob.length };
      }
    }
    if (best) return best.id;
    for (const l of latest) {
      for (const e of l.extensions) {
        if ((!best || e.length > best.length) && base.endsWith(e)) best = { id: l.id, length: e.length };
      }
    }
    if (best) return best.id;
    return latest.find((l) => l.firstLine?.test(firstLine))?.id;
  }
}

/** The glob syntax of `files.associations` and `filenamePatterns`: `**`, `*`, `?`, `{a,b}` and `[...]`. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces) {
      braces--;
      re += ')';
    } else if (c === ',' && braces) {
      re += '|';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) {
        re += '\\[';
      } else {
        re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}
