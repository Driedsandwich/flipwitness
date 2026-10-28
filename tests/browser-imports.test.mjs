import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteImports } from '../core/runner.browser.imports.mjs';

test('browser rewrite handles static imports, reexports, comments and ordinary strings', () => {
  const source = `// import 'fake';
    import { x } from './x.mjs';
    import './side.mjs';
    export { y } from './y.mjs';
    export * from './all.mjs';
    export function f() { return "import('still fake')"; }
  `;
  const paths = [];
  const rewritten = rewriteImports(source, path => { paths.push(path); return 'blob:' + path; });
  assert.deepEqual(paths, ['./x.mjs', './side.mjs', './y.mjs', './all.mjs']);
  assert.match(rewritten, /from "blob:\.\/x.mjs"/);
  assert.match(rewritten, /import 'fake'/);
});

test('browser scanner rejects dynamic import, interpolation and escaped specifiers', () => {
  for (const source of ["import('https://invalid.example/x')", 'import.meta.url',
    '`hello ${import("./x")} world`', "import './x\\u002emjs'"]) {
    assert.throws(() => rewriteImports(source, value => value));
  }
});
