import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { evaluateSample } from '../cli.mjs';

for (const sample of ['month-end', 'name-check', 'csv-line']) {
  test(`${sample}: existing tests pass both versions for both patches`, async () => {
    for (const patch of ['good', 'incomplete']) {
      const card = await evaluateSample(fileURLToPath(new URL(`../samples/${sample}`, import.meta.url)), patch, 'existing');
      assert.equal(card.verdict, 'no_evidence');
      assert.ok(card.tests.length > 0);
      assert.ok(card.tests.every(item => item.classification === 'passes_both'));
    }
  });
  test(`${sample}: golden tests support good and expose incomplete`, async () => {
    const good = await evaluateSample(fileURLToPath(new URL(`../samples/${sample}`, import.meta.url)), 'good', 'golden');
    const incomplete = await evaluateSample(fileURLToPath(new URL(`../samples/${sample}`, import.meta.url)), 'incomplete', 'golden');
    assert.equal(good.verdict, 'supported');
    assert.ok(good.summary.witnesses >= 1);
    assert.equal(good.summary.errors, 0);
    assert.equal(incomplete.verdict, 'patch_suspect');
    assert.ok(incomplete.summary.failsAfter >= 1);
    assert.equal(incomplete.summary.errors, 0);
  });
}

test('CLI prints JSON with exit zero even when patch is suspect', () => {
  const run = spawnSync(process.execPath, ['cli.mjs', 'samples/name-check', '--patch', 'incomplete', '--tests', 'golden'], { encoding: 'utf8', timeout: 2000, cwd: fileURLToPath(new URL('..', import.meta.url)) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).verdict, 'patch_suspect');
});
