import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

let cachedPath: string | undefined;

/**
 * Finds the ripgrep binary that ships with VS Code (and its forks), so nothing has to be
 * installed. The layout changed across versions, so several locations are probed.
 */
export function ripgrepPath(): string {
  const configured = vscode.workspace.getConfiguration('searchHere').get<string>('ripgrepPath');
  if (configured) {
    return configured;
  }
  if (cachedPath) {
    return cachedPath;
  }
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const appRoot = vscode.env.appRoot;
  const platformDir = `${process.platform}-${process.arch}`;
  const bases = ['node_modules.asar.unpacked', 'node_modules'];

  const candidates: string[] = [];
  for (const base of bases) {
    candidates.push(path.join(appRoot, base, '@vscode', 'ripgrep-universal', 'bin', platformDir, exe));
    candidates.push(path.join(appRoot, base, '@vscode', 'ripgrep', 'bin', exe));
    candidates.push(path.join(appRoot, base, 'vscode-ripgrep', 'bin', exe));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return (cachedPath = candidate);
    }
  }
  // Platform folders with a suffix (e.g. linux-x64-musl).
  for (const base of bases) {
    const dir = path.join(appRoot, base, '@vscode', 'ripgrep-universal', 'bin');
    try {
      for (const sub of fs.readdirSync(dir)) {
        const candidate = path.join(dir, sub, exe);
        if (sub.startsWith(platformDir) && fs.existsSync(candidate)) {
          return (cachedPath = candidate);
        }
      }
    } catch {
      // not there
    }
  }
  // Last resort: an rg on the PATH.
  return (cachedPath = 'rg');
}

export interface RgRun {
  code: number | null;
  stderr: string;
  /** True when the run was stopped early (cancelled or `onLine` returned false). */
  stopped: boolean;
}

/**
 * Runs ripgrep and calls `onLine` for each stdout line. Returning `false` from `onLine`
 * kills the process.
 */
export function runRg(
  args: string[],
  cwd: string,
  token: vscode.CancellationToken | undefined,
  onLine: (line: string) => boolean | void,
): Promise<RgRun> {
  return new Promise((resolve, reject) => {
    let stopped = false;
    let stderr = '';
    let rest = '';
    // stdin must not be a pipe, otherwise rg may decide to search it.
    const child = cp.spawn(ripgrepPath(), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    const stop = () => {
      if (!stopped) {
        stopped = true;
        child.kill();
      }
    };
    const sub = token?.onCancellationRequested(stop);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (onLine(line.endsWith('\r') ? line.slice(0, -1) : line) === false) {
          stop();
          return;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      sub?.dispose();
      if (err.code === 'ENOENT') {
        reject(new Error(`ripgrep not found (${ripgrepPath()}). Set "searchHere.ripgrepPath".`));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      sub?.dispose();
      if (!stopped && rest) onLine(rest);
      resolve({ code, stderr, stopped });
    });
  });
}

/** Splits a list of paths into chunks that stay under the Windows command line limit. */
export function chunkPaths(paths: string[], maxChars = 24000): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const p of paths) {
    if (cur.length && len + p.length + 3 > maxChars) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += p.length + 3;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Normalizes a path printed by rg (relative to cwd) to forward slashes, without "./". */
export function normalizeRgPath(p: string): string {
  p = p.replace(/\\/g, '/');
  return p.startsWith('./') ? p.slice(2) : p;
}

/** First stderr line worth showing (rg prints per-file errors such as permission denied). */
export function stderrSummary(stderr: string): string | undefined {
  const line = stderr.split(/\r?\n/).find((l) => l.trim());
  return line ? line.replace(/^rg: /, '') : undefined;
}
