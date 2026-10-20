import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

// Copy the codicon font + stylesheet next to the webview bundle.
mkdirSync('dist/codicons', { recursive: true });
cpSync('node_modules/@vscode/codicons/dist/codicon.css', 'dist/codicons/codicon.css');
cpSync('node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/codicons/codicon.ttf');

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/style.css'],
    outfile: 'dist/webview.css',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
