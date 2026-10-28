import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, summarise } from '../core/classify.mjs';
import { buildEvidenceCard } from '../core/evidence.mjs';

const result = (status, message = '') => ({ name: 'case', status, message });
test('complete 4 by 4 classifier truth table', () => {
  const statuses = ['pass', 'fail', 'error', 'timeout'];
  const expected = [
    ['passes_both', 'fails_after', 'errors', 'errors'],
    ['witness', 'fails_after', 'errors', 'errors'],
    ['errors', 'fails_after', 'errors', 'errors'],
    ['errors', 'fails_after', 'errors', 'errors'],
  ];
  statuses.forEach((before, i) => statuses.forEach((after, j) => {
    assert.equal(classify(result(before), result(after)), expected[i][j], `${before}/${after}`);
  }));
  assert.equal(classify(result('error', 'AssertionError: mismatch'), result('pass')), 'witness');
});

test('summaries count every pair once', () => {
  const pairs = [['fail', 'pass'], ['pass', 'pass'], ['fail', 'fail'], ['error', 'pass']]
    .map(([before, after]) => ({ before: result(before), after: result(after) }));
  assert.deepEqual(summarise(pairs), { witnesses: 1, passesBoth: 1, failsAfter: 1, errors: 1 });
});

test('evidence verdicts and messages include missing, reordered and errored tests', () => {
  assert.equal(buildEvidenceCard([result('fail')], [result('pass')]).verdict, 'supported');
  assert.equal(buildEvidenceCard([result('pass')], [result('fail')]).verdict, 'patch_suspect');
  assert.equal(buildEvidenceCard([result('pass')], [result('pass')]).verdict, 'no_evidence');
  assert.equal(buildEvidenceCard([], []).verdict, 'no_evidence');
  const card = buildEvidenceCard([result('error', 'TypeError: setup')], []);
  assert.equal(card.verdict, 'no_evidence');
  assert.equal(card.summary.errors, 1);
  assert.equal(card.tests[0].before.message, 'TypeError: setup');
  assert.match(card.tests[0].after.message, /did not produce/);
  const first = { name: 'one', status: 'fail', message: 'assertion' };
  const second = { name: 'two', status: 'pass', message: '' };
  assert.deepEqual(buildEvidenceCard([first, second], [second, { ...first, status: 'pass' }])
    .tests.map(item => item.classification), ['witness', 'passes_both']);
  assert.throws(() => buildEvidenceCard([first, first], []), /Duplicate/);
});

test('one fails_after overrides an otherwise supported patch', () => {
  const original = [{ ...result('fail'), name: 'witness' }, result('pass')];
  const patched = [{ ...result('pass'), name: 'witness' }, result('fail')];
  assert.equal(buildEvidenceCard(original, patched).verdict, 'patch_suspect');
});
