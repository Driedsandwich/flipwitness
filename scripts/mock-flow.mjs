import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSample } from '../cli.mjs';
import { MockChatClient } from '../server/llm.mjs';
import { MemoryLedger } from '../server/budget.mjs';
import { handle } from '../server/api.mjs';
import { runModelFlow } from '../web/flow.mjs';
import { runSuite } from '../core/runner.node.mjs';

// Resolve samples against the project root so callers may run from any directory.
const SAMPLES = fileURLToPath(new URL('../samples/', import.meta.url));

export async function sampleInput(sample, patchKind) {
  const directory = resolve(SAMPLES, sample);
  const loaded = await loadSample(directory);
  return { ...loaded, bug_report: await readFile(resolve(directory, 'bug_report.md'), 'utf8'),
    patch: await readFile(resolve(directory, `patch_${patchKind}.diff`), 'utf8') };
}
export async function loadScript(sample) {
  return JSON.parse(await readFile(new URL(`../tests/fixtures/mock_scripts/${sample}.json`, import.meta.url), 'utf8'));
}
export async function mockFlow(sample, patchKind) {
  const client = new MockChatClient(await loadScript(sample));
  const ledger = new MemoryLedger();
  const deps = { client, ledger, source: 'mock', creditsUSD: 45, now: () => new Date('2026-10-24T00:00:00Z') };
  return runModelFlow({ input: await sampleInput(sample, patchKind), runSuite,
    callStage: request => handle(request, {}, deps) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = [];
  for (const sample of ['month-end', 'name-check', 'csv-line']) {
    const patches = {};
    for (const patchKind of ['good', 'incomplete']) {
      const result = await mockFlow(sample, patchKind);
      patches[patchKind] = result;
      for (const r of result.rounds) rows.push({ sample, patch: patchKind, round: r.round,
        witnesses: r.card.summary.witnesses, verdict: r.card.verdict, cost: '$0', simulated_usd: r.cost.toFixed(6) });
    }
    if (process.argv.includes('--write')) await writeFile(fileURLToPath(new URL(`../tests/fixtures/precomputed_mock/${sample}.json`, import.meta.url)),
      JSON.stringify({ source: 'mock', cost: 0, note: 'Scripted fixtures, not real model output. Costs inside patches are simulated USD.', patches }, null, 2) + '\n');
  }
  console.table(rows);
}
