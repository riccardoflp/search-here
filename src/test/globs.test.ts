import * as assert from 'assert';
import { addPattern, escapeGlob, excludeGlobs, includeGlobs, patternForPath, removePattern, splitPatterns } from '../globs';

suite('Patterns to ripgrep globs', () => {
  test('splits on commas but not inside {a,b} groups', () => {
    assert.deepStrictEqual(splitPatterns(' src, *.{js,ts} ,, docs/ '), ['src', '*.{js,ts}', 'docs/']);
    assert.deepStrictEqual(splitPatterns(undefined), []);
    assert.deepStrictEqual(splitPatterns([' a ', '', 'b']), ['a', 'b']);
  });

  test('a bare name is included anywhere, with its content', () => {
    assert.deepStrictEqual(includeGlobs(['src']), ['**/src/**', 'src']);
  });

  test('a path with a slash or ./ is anchored to the root', () => {
    assert.deepStrictEqual(includeGlobs(['src/app']), ['src/app/**', 'src/app']);
    assert.deepStrictEqual(includeGlobs(['./src']), ['src/**', '/sr[c]']);
  });

  test('a trailing slash means folders only', () => {
    assert.deepStrictEqual(includeGlobs(['./docs/']), ['docs/**']);
    assert.deepStrictEqual(excludeGlobs(['dist/']), ['!**/dist/**']);
    assert.deepStrictEqual(excludeGlobs(['./dist/']), ['!dist/**']);
  });

  test('exclusions keep gitignore semantics', () => {
    assert.deepStrictEqual(excludeGlobs(['node_modules', '*.min.js']), ['!node_modules', '!*.min.js']);
    assert.deepStrictEqual(excludeGlobs(['src/gen']), ['!src/gen']);
    // ripgrep only anchors "/name" when it contains a glob character.
    assert.deepStrictEqual(excludeGlobs(['./Dockerfile']), ['!/Dockerfil[e]']);
    assert.deepStrictEqual(excludeGlobs(['./*.log']), ['!/*.log']);
  });

  test('backslashes from Windows paths become slashes', () => {
    assert.deepStrictEqual(excludeGlobs(['.\\src\\gen']), ['!src/gen']);
  });

  test('Explorer paths are escaped and anchored', () => {
    assert.strictEqual(escapeGlob('pages/[id].tsx'), 'pages/[[]id[]].tsx');
    assert.strictEqual(patternForPath('src\\util', true), './src/util/');
    assert.strictEqual(patternForPath('pages/[id].tsx', false), './pages/[[]id[]].tsx');
  });

  test('adds and removes patterns in a comma separated list', () => {
    assert.strictEqual(addPattern('a, b', 'c'), 'a, b, c');
    assert.strictEqual(addPattern('a, b', 'b'), 'a, b');
    assert.strictEqual(removePattern('a, b, c', 'b'), 'a, c');
  });
});
