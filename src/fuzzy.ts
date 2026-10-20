// Fuzzy matching for file, folder and symbol names.
//
// Every space separated term must match. A term matches the basename first (contiguous
// substring, then subsequence) and falls back to the whole path. Contiguous runs, word
// boundaries and camelCase humps score higher; long paths score slightly lower.

export interface FuzzyQuery {
  terms: string[];
  raw: string;
}

export interface FuzzyMatch {
  score: number;
  positions: number[];
}

export function prepareQuery(query: string): FuzzyQuery {
  const raw = query.trim().replace(/\\/g, '/');
  return { raw: raw.toLowerCase(), terms: raw.toLowerCase().split(/\s+/).filter(Boolean) };
}

const SEPARATORS = '/\\_-. ';

function isUpper(c: string): boolean {
  return c >= 'A' && c <= 'Z';
}

function isLower(c: string): boolean {
  return c >= 'a' && c <= 'z';
}

function scorePositions(text: string, positions: number[]): number {
  let score = 0;
  let prev = -2;
  for (const p of positions) {
    let s = 1;
    if (p === prev + 1) s += 6;
    const before = p > 0 ? text[p - 1] : '/';
    if (SEPARATORS.includes(before)) s += 8;
    else if (isUpper(text[p]) && isLower(before)) s += 6;
    score += s;
    prev = p;
  }
  const span = positions[positions.length - 1] - positions[0] + 1;
  score -= Math.min(15, (span - positions.length) * 0.5);
  return score;
}

/** Subsequence match of `term` in `lower[from..to)`, preferring a tight window. */
function subsequence(term: string, lower: string, from: number, to: number): number[] | null {
  let ti = 0;
  let end = -1;
  for (let i = from; i < to; i++) {
    if (lower[i] === term[ti]) {
      ti++;
      if (ti === term.length) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  // Walk back from the end to find the tightest start.
  ti = term.length - 1;
  let start = from;
  for (let i = end; i >= from; i--) {
    if (lower[i] === term[ti]) {
      ti--;
      if (ti < 0) {
        start = i;
        break;
      }
    }
  }
  const positions: number[] = [];
  ti = 0;
  for (let i = start; i <= end && ti < term.length; i++) {
    if (lower[i] === term[ti]) {
      positions.push(i);
      ti++;
    }
  }
  return positions;
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i);
}

function matchTerm(term: string, text: string, lower: string, baseStart: number, strict: boolean): FuzzyMatch | null {
  const inPath = term.includes('/');
  if (!inPath) {
    const idx = lower.indexOf(term, baseStart);
    if (idx >= 0) {
      const positions = range(idx, term.length);
      return { score: scorePositions(text, positions) + 20, positions };
    }
    const sub = subsequence(term, lower, baseStart, lower.length);
    if (sub) {
      return { score: scorePositions(text, sub) + 10, positions: sub };
    }
  }
  const idx = lower.indexOf(term);
  if (idx >= 0) {
    const positions = range(idx, term.length);
    return { score: scorePositions(text, positions), positions };
  }
  if (strict) return null;
  const sub = subsequence(term, lower, 0, lower.length);
  return sub ? { score: scorePositions(text, sub) - 5, positions: sub } : null;
}

/**
 * `strict` drops subsequences scattered across the whole path (e.g. "peer" in
 * "public/rnnoise-processor"), which are useful in the files picker but noise next to text results.
 */
export function fuzzyMatch(query: FuzzyQuery, text: string, lower = text.toLowerCase(), strict = false): FuzzyMatch | null {
  if (!query.terms.length) {
    return { score: 0, positions: [] };
  }
  const baseStart = lower.lastIndexOf('/') + 1;
  let score = 0;
  const positions: number[] = [];
  for (const term of query.terms) {
    const m = matchTerm(term, text, lower, baseStart, strict);
    if (!m) return null;
    score += m.score;
    positions.push(...m.positions);
  }
  const base = lower.slice(baseStart);
  const stem = base.replace(/\.[^.]*$/, '');
  if (query.terms.length === 1) {
    const t = query.terms[0];
    if (base === t || stem === t) score += 60;
    else if (base.startsWith(t)) score += 30;
  }
  score -= text.length * 0.05;
  return { score, positions: [...new Set(positions)].sort((a, b) => a - b) };
}

export interface Ranked<T> {
  item: T;
  match: FuzzyMatch;
}

/** Returns the best `limit` matches, sorted by score. */
export function rank<T>(
  query: FuzzyQuery,
  items: readonly T[],
  text: (item: T) => string,
  lower: (item: T) => string,
  limit: number,
  strict = false,
): { results: Ranked<T>[]; total: number } {
  const results: Ranked<T>[] = [];
  let total = 0;
  let minScore = -Infinity;
  for (const item of items) {
    const m = fuzzyMatch(query, text(item), lower(item), strict);
    if (!m) continue;
    total++;
    if (results.length >= limit && m.score <= minScore) continue;
    results.push({ item, match: m });
    if (results.length > limit * 2) {
      results.sort((a, b) => b.match.score - a.match.score);
      results.length = limit;
      minScore = results[results.length - 1].match.score;
    }
  }
  results.sort((a, b) => b.match.score - a.match.score || text(a.item).localeCompare(text(b.item)));
  if (results.length > limit) results.length = limit;
  return { results, total };
}
