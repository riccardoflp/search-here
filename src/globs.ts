// Translation of user-facing patterns into ripgrep `--glob` arguments.
//
// Syntax accepted in the Include / Exclude fields (comma separated):
//   name          anywhere in the tree (file or folder), like .gitignore
//   a/b           relative to the root (anything containing a slash is anchored)
//   ./name        relative to the root
//   name/         folders only
//   **/*.test.ts  any glob is passed through
//
// ripgrep quirks handled here (verified against rg 15):
//   - a positive glob matching a folder does not include its files, so `dir/**` is added
//   - `/name` anchors only when the pattern contains a glob character, so the last
//     character of a literal single-segment name is wrapped in brackets (`/nam[e]`)

const GLOB_CHARS = /[*?[\]{}]/;

export function splitPatterns(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((v) => v.trim()).filter(Boolean);
  }
  // Split on commas that are not inside {a,b} groups.
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((v) => v.trim()).filter(Boolean);
}

export function escapeGlob(path: string): string {
  return path.replace(/[*?[\]{}]/g, (c) => `[${c}]`);
}

/** A pattern that targets exactly this workspace-relative path (used by the Explorer menu). */
export function patternForPath(rel: string, isDir: boolean): string {
  return './' + escapeGlob(rel.replace(/\\/g, '/')) + (isDir ? '/' : '');
}

function anchorSingle(segment: string): string {
  if (GLOB_CHARS.test(segment)) {
    return '/' + segment;
  }
  const last = segment[segment.length - 1];
  return '/' + segment.slice(0, -1) + `[${last}]`;
}

interface Parsed {
  body: string;
  anchored: boolean;
  dirOnly: boolean;
  hasGlob: boolean;
}

function parse(raw: string): Parsed | undefined {
  let p = raw.trim().replace(/\\/g, '/');
  let anchored = false;
  if (p.startsWith('./')) {
    p = p.slice(2);
    anchored = true;
  } else if (p.startsWith('/')) {
    p = p.slice(1);
    anchored = true;
  }
  const dirOnly = p.endsWith('/');
  p = p.replace(/\/+$/, '');
  if (!p || p === '.') {
    return undefined;
  }
  if (p.includes('/')) {
    anchored = true;
  }
  return { body: p, anchored, dirOnly, hasGlob: GLOB_CHARS.test(p) };
}

export function includeGlobs(patterns: string[]): string[] {
  const out: string[] = [];
  for (const raw of patterns) {
    const p = parse(raw);
    if (!p) continue;
    const { body, anchored, dirOnly } = p;
    if (anchored) {
      const multi = body.includes('/');
      out.push(body + '/**');
      if (!dirOnly) out.push(multi ? body : anchorSingle(body));
    } else {
      const base = body.startsWith('**/') ? body : '**/' + body;
      out.push(base + '/**');
      if (!dirOnly) out.push(body);
    }
  }
  return dedupe(out);
}

export function excludeGlobs(patterns: string[]): string[] {
  const out: string[] = [];
  for (const raw of patterns) {
    const p = parse(raw);
    if (!p) continue;
    const { body, anchored, dirOnly } = p;
    if (dirOnly) {
      // Folder only: exclude its content. `a/**` is anchored because it contains a slash.
      const dir = anchored || body.startsWith('**/') ? body : '**/' + body;
      out.push('!' + dir + '/**');
    } else if (anchored) {
      out.push('!' + (body.includes('/') ? body : anchorSingle(body)));
    } else {
      out.push('!' + body);
    }
  }
  return dedupe(out);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Adds a pattern to a comma separated list, unless it is already there. */
export function addPattern(list: string, pattern: string): string {
  const items = splitPatterns(list);
  if (!items.includes(pattern)) items.push(pattern);
  return items.join(', ');
}

export function removePattern(list: string, pattern: string): string {
  return splitPatterns(list)
    .filter((p) => p !== pattern)
    .join(', ');
}
