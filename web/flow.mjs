import { applyUnifiedDiff } from '../core/patch.mjs';
import { buildEvidenceCard } from '../core/evidence.mjs';

// The shared controller never executes code on a server: the UI injects its
// browser Worker runner; the offline CLI/tests inject the isolated Node runner.
export const MAX_REWRITES = 3;

export async function runModelFlow({ input, callStage, runSuite, onStep = () => {}, onRound = () => {} }) {
  const { moduleFiles, entry, bug_report, patch } = input;
  const patched = applyUnifiedDiff(moduleFiles, patch);
  let session;
  let cost = 0;
  const steps = [], rounds = [];
  async function call(stage, payload) {
    const result = await callStage({ stage, ...(session ? { session } : {}), payload });
    const body = result.body;
    cost += body.cost ?? 0;
    if (body.session) session = body.session;
    if (result.status !== 200) {
      const error = new Error(body.message ?? 'Model request failed');
      Object.assign(error, { code: body.error, cost, session, rounds, steps });
      throw error;
    }
    steps.push({ stage, model: body.model, cost: body.cost, source: body.source, estimated: body.cost_estimated, rateHeaders: body.rateHeaders });
    onStep(steps.at(-1), { cost, session });
    return body;
  }
  const { expected, actual, repro_steps, inputs, suspected_area } = await call('extract', { bug_report });
  const extraction = { expected, actual, repro_steps, inputs, suspected_area };
  const { hypotheses } = await call('hypothesize', { extraction, moduleFiles, entry, patch });
  let previous;
  // Owner 2026-10-24: up to three rewrites (four test rounds); server/api.mjs admits the same.
  for (let round = 0; round <= MAX_REWRITES; round++) {
    const generated = await call('tests', { extraction, hypotheses, moduleFiles, entry, patch, ...(previous ? { previous } : {}) });
    const options = { entry, testSource: generated.tests_source, timeoutMs: 1500 };
    const before = await runSuite({ ...options, moduleFiles });
    const after = await runSuite({ ...options, moduleFiles: patched });
    const card = buildEvidenceCard(before, after);
    const result = { round, card, tests_source: generated.tests_source, rationale: generated.rationale, cost };
    rounds.push(result);
    onRound(result);
    if (card.summary.witnesses > 0) break;
    previous = { tests_source: generated.tests_source, results: card.tests.map(t => ({
      name: t.name.slice(0, 300), before: t.before.status, after: t.after.status,
      message: [t.before.message, t.after.message].filter(Boolean).join(' | ').slice(0, 1000),
    })) };
  }
  return { session, cost, extraction, hypotheses, steps, rounds };
}
