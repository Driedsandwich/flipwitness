import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSuite } from '../core/runner.mjs';

const base = { moduleFiles: { 'src/main.mjs': 'export const value = 42;' }, entry: 'src/main.mjs', timeoutMs: 800 };
test('links several supplied ES modules, harness imports, globals, and async tests', async () => {
  const results = await runSuite({ ...base, moduleFiles: {
    'src/main.mjs': "export { value } from './value.mjs';",
    'src/value.mjs': 'export const value = 42;',
  }, testSource: `
    import { value } from './src/main.mjs';
    import { test, expect } from '@patchwitness/harness';
    test('async module', async () => { await Promise.resolve(); expect(value).toBe(42); });
    test('bad assertion', () => expect(value).toBe(0));
    test('bad runtime', () => { throw new TypeError('oops'); });
  ` });
  assert.deepEqual(results.map(item => item.status), ['pass', 'fail', 'error']);
  assert.match(results[1].message, /^AssertionError:/);
});

test('infinite synchronous loop terminates within two seconds', async () => {
  const start = performance.now();
  const results = await runSuite({ ...base, timeoutMs: 200,
    testSource: "test('loop', () => { while (true) {} }); test('pending', () => {});" });
  assert.ok(performance.now() - start < 2000);
  assert.deepEqual(results.map(item => [item.name, item.status]), [['loop', 'timeout'], ['pending', 'timeout']]);
});

test('unresolved async test times out and preserves completed results', async () => {
  const results = await runSuite({ ...base, timeoutMs: 200, testSource: `
    test('finished', () => expect(1).toBe(1));
    test('waiting', async () => await new Promise(() => {}));
  ` });
  assert.deepEqual(results.map(item => item.status), ['pass', 'timeout']);
});

test('infinite loop during module evaluation is bounded', async () => {
  const results = await runSuite({ ...base, timeoutMs: 150, testSource: 'while (true) {}' });
  assert.equal(results[0].name, '[suite]');
  assert.equal(results[0].status, 'timeout');
});

test('process, require and network attempts produce errors, not assertions', async () => {
  const results = await runSuite({ ...base, testSource: `
    test('process', () => process.cwd());
    test('require', () => require('fs').readFileSync('/etc/hosts'));
    test('fetch', async () => await fetch('https://invalid.example'));
    test('XMLHttpRequest', () => new XMLHttpRequest());
    test('WebSocket', () => new WebSocket('wss://invalid.example'));
    test('eval', () => eval('1'));
    test('Function', () => Function('return process')());
  ` });
  assert.deepEqual(results.map(item => item.status), Array(7).fill('error'));
  assert.match(results[0].message, /process is not defined/);
  assert.match(results[1].message, /require is not defined/);
  assert.match(results[2].message, /fetch is disabled/);
});

test('external, builtin, traversal and dynamic imports are rejected', async () => {
  for (const source of [
    "import fs from 'node:fs';", "import x from 'https://invalid.example/code.mjs';",
    "import x from '../outside.mjs';", "test('dynamic', async () => await import('node:fs'));",
  ]) {
    const results = await runSuite({ ...base, testSource: source });
    assert.equal(results[0].status, 'error', source);
  }
});

test('fresh contexts do not leak globals, and no-test/syntax errors stay errors', async () => {
  assert.equal((await runSuite({ ...base, testSource: "globalThis.secret = 3; test('set', () => {});" }))[0].status, 'pass');
  assert.equal((await runSuite({ ...base, testSource: "test('fresh', () => expect(typeof secret).toBe('undefined'));" }))[0].status, 'pass');
  for (const testSource of ['', 'this is invalid javascript']) {
    assert.equal((await runSuite({ ...base, testSource }))[0].status, 'error');
  }
  await assert.rejects(runSuite({ ...base, testSource: '', timeoutMs: 0 }), /timeoutMs/);
});
