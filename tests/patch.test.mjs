import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUnifiedDiff } from '../core/patch.mjs';

test('multiple hunks and files verify context without mutating input', () => {
  const files = { 'a.mjs': 'one\ntwo\nthree\nfour\nfive\n', 'b.mjs': 'old\n' };
  const diff = '--- a/a.mjs\n+++ b/a.mjs\n@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+extra\n@@ -4,2 +5,2 @@\n four\n-five\n+FIVE\n--- a/b.mjs\n+++ b/b.mjs\n@@ -1 +1 @@\n-old\n+new\n';
  assert.deepEqual(applyUnifiedDiff(files, diff), { 'a.mjs': 'one\nTWO\nextra\nthree\nfour\nFIVE\n', 'b.mjs': 'new\n' });
  assert.equal(files['b.mjs'], 'old\n');
});

test('context mismatch names file and hunk; failed application is atomic', () => {
  const files = { 'a.mjs': 'a\nb\nc\n' };
  const diff = '--- a/a.mjs\n+++ b/a.mjs\n@@ -1 +1 @@\n-a\n+A\n@@ -3 +3 @@\n-wrong\n+C\n';
  assert.throws(() => applyUnifiedDiff(files, diff), /a\.mjs, hunk 2 .*Context mismatch/);
  assert.equal(files['a.mjs'], 'a\nb\nc\n');
});

test('create, insert at start, delete, and no-final-newline markers', () => {
  assert.deepEqual(applyUnifiedDiff({}, '--- /dev/null\n+++ b/new.mjs\n@@ -0,0 +1 @@\n+hello\n'), { 'new.mjs': 'hello\n' });
  assert.equal(applyUnifiedDiff({ f: 'b\n' }, '--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n+a\n').f, 'a\nb\n');
  assert.deepEqual(applyUnifiedDiff({ f: 'bye\n' }, '--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n'), {});
  assert.equal(applyUnifiedDiff({ f: 'old' }, '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n').f, 'new');
});

test('CRLF files preserve their newline convention', () => {
  assert.equal(applyUnifiedDiff({ f: 'a\r\nb\r\n' }, '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n').f, 'a\r\nB\r\n');
});

test('reject bad ranges, truncated hunks, traversal, and conflicting sections', () => {
  for (const diff of [
    '--- a/f\n+++ b/f\n@@ -2 +1 @@\n-a\n+b\n',
    '--- a/f\n+++ b/f\n@@ -1,2 +1 @@\n-a\n+b\n',
    '--- a/../f\n+++ b/../f\n@@ -1 +1 @@\n-a\n+b\n',
    '--- /dev/null\n+++ "b/f"\n@@ -0,0 +1 @@\n+b\n',
    '--- a/f\n+++ b/f\n@@ -1 +4 @@\n-a\n+b\n',
    '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+c\n',
  ]) assert.throws(() => applyUnifiedDiff({ f: 'a\n' }, diff));
});
