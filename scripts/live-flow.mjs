// Run the samples live through the same handler and flow as the web app, and write
// samples/<name>/precomputed.json (source "live") when both patches finished.
// NEBIUS_API_KEY is read from the environment. PW_GRANTED_CREDITS_USD is the credit
// actually granted, shared by both apps; the shared ledger enforces it with the other caps.
// Usage: NEBIUS_API_KEY=... PW_GRANTED_CREDITS_USD=0.50 node scripts/live-flow.mjs <log.json> [sample ...]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpChatClient } from '../server/llm.mjs';
import { FileLedger, defaultLedgerPath } from '../server/budget.mjs';
import { handle } from '../server/api.mjs';
import { runModelFlow } from '../web/flow.mjs';
import { runSuite } from '../core/runner.node.mjs';
import { sampleInput } from './mock-flow.mjs';

const SAMPLES = fileURLToPath(new URL('../samples/', import.meta.url));
const [logPath, ...requested] = process.argv.slice(2);
const credits = Number(process.env.PW_GRANTED_CREDITS_USD);
if (!logPath || !(credits > 0)) throw new Error('Usage: live-flow.mjs <log.json> [sample ...] with PW_GRANTED_CREDITS_USD > 0');

// Pass-through client that keeps per-call metadata only (never message text).
const inner = new HttpChatClient({ totalTimeoutMs: 60_000, maxRetries: 1 });
const calls = [];
const client = {
  maxRetries: inner.maxRetries,
  async complete(request) {
    const started = Date.now(), row = { model: request.model, maxTokens: request.maxTokens };
    try {
      const result = await inner.complete(request);
      calls.push({ ...row, finishReason: result.finishReason, usage: result.usage, attempts: result.attempts, seconds: (Date.now() - started) / 1000 });
      return result;
    } catch (error) {
      calls.push({ ...row, error: error.status ?? error.name, seconds: (Date.now() - started) / 1000 });
      throw error;
    }
  },
};
const deps = { client, ledger: new FileLedger(defaultLedgerPath(process.env)), source: 'live', creditsUSD: credits };
const env = { NEBIUS_API_KEY: process.env.NEBIUS_API_KEY };
const log = [];
for (const sample of requested.length ? requested : ['month-end', 'name-check', 'csv-line']) {
  const patches = {};
  for (const patchKind of ['good', 'incomplete']) {
    const first = calls.length;
    try {
      patches[patchKind] = await runModelFlow({ input: await sampleInput(sample, patchKind), runSuite,
        callStage: request => handle(request, env, deps) });
      const rounds = patches[patchKind].rounds;
      log.push({ sample, patch: patchKind, ok: true, verdicts: rounds.map(r => r.card.verdict),
        witnesses: rounds.map(r => r.card.summary.witnesses), cost: rounds.at(-1).cost, calls: calls.slice(first) });
    } catch (error) {
      log.push({ sample, patch: patchKind, ok: false, code: error.code, message: error.message, cost: error.cost, calls: calls.slice(first) });
    }
    const row = log.at(-1);
    console.log(sample, patchKind, row.ok ? 'ok' : `stopped (${row.code})`, row.verdicts ?? '', `$${(row.cost ?? 0).toFixed(6)}`,
      row.calls.map(c => c.finishReason ?? c.error).join(','));
    if (!row.ok) break;
  }
  if (Object.keys(patches).length === 2) {
    await writeFile(resolve(SAMPLES, sample, 'precomputed.json'), JSON.stringify({ source: 'live', cost: 0,
      recorded_at: new Date().toISOString(), recorded_cost_usd: patches.good.rounds.at(-1).cost + patches.incomplete.rounds.at(-1).cost,
      note: 'Recorded live run (NVIDIA Nemotron via Nebius Token Factory). Viewing costs $0; the saved before/after results are shown and nothing re-runs.', patches }, null, 2) + '\n');
  } else break;
}
await mkdir(dirname(resolve(logPath)), { recursive: true });
await writeFile(resolve(logPath), JSON.stringify(log, null, 2) + '\n');
