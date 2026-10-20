import * as assert from 'assert';
import { fuzzyMatch, prepareQuery, rank } from '../fuzzy';

const best = (query: string, paths: string[], strict = false) =>
  rank(prepareQuery(query), paths, (p) => p, (p) => p.toLowerCase(), 10, strict).results.map((r) => r.item);

suite('Fuzzy matching', () => {
  test('prefers a match in the file name over one in the folders', () => {
    assert.deepStrictEqual(best('socket', ['socket/index.ts', 'client/src/hooks/useSocket.ts'])[0], 'client/src/hooks/useSocket.ts');
  });

  test('ranks an exact file name first', () => {
    assert.strictEqual(best('app', ['src/application.ts', 'src/app.ts', 'apps/x/main.ts'])[0], 'src/app.ts');
  });

  test('matches subsequences and camelCase humps', () => {
    const m = fuzzyMatch(prepareQuery('usock'), 'src/hooks/useSocket.ts');
    assert.ok(m, 'usock should match useSocket');
    assert.deepStrictEqual(best('uss', ['src/hooks/useSocket.ts', 'src/unused/style.css']).length, 2);
  });

  test('every space separated term must match', () => {
    assert.deepStrictEqual(best('hooks socket', ['client/src/hooks/useSocket.ts', 'server/socket.ts']), ['client/src/hooks/useSocket.ts']);
  });

  test('returns the highlighted positions', () => {
    const m = fuzzyMatch(prepareQuery('app'), 'src/app.ts');
    assert.deepStrictEqual(m?.positions, [4, 5, 6]);
  });

  test('strict mode drops letters scattered across the whole path', () => {
    const paths = ['client/public/rnnoise-processor.js'];
    assert.deepStrictEqual(best('peer', paths), paths);
    assert.deepStrictEqual(best('peer', paths, true), []);
  });

  test('a term with a slash matches against the path', () => {
    assert.deepStrictEqual(best('hooks/use', ['src/hooks/useSocket.ts', 'src/useless.ts']), ['src/hooks/useSocket.ts']);
  });
});
