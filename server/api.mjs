import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { BudgetClient, jstDay } from './budget.mjs';
import { runStage, validatePayload, InputError } from './stages.mjs';

// Live 2026-10-24: strict json_schema answers never contained a newline, a double quote or a
// backslash inside tests_source (the tests prompt now avoids them). json_object answers kept them but
// ran to the 8,000-token limit or broke the gate, so the strict schema stays the default.
export const DEFAULT_SCHEMA_STYLE = 'openai';
const hash = text => createHash('sha256').update(text).digest();
export function chooseLane(passphrase, env) {
  const expected = env.PW_JUDGE_PASSPHRASE;
  const supplied = typeof passphrase === 'string' ? passphrase : '';
  const equal = timingSafeEqual(hash(supplied), hash(typeof expected === 'string' ? expected : ''));
  return expected && equal ? 'judge' : 'public';
}
function redact(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets) if (typeof secret === 'string' && secret) value = value.replaceAll(secret, '[redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), redact(item, secrets)]));
  return value;
}
const spent = (records, session) => records.filter(r => r.app === 'pw' && r.session === session).reduce((s, r) => s + r.amount, 0);

// Pure transport boundary: all clock, storage and model effects are injected.
export async function handle(requestJson, env, deps) {
  let session, client, started;
  const now = deps.now ?? (() => new Date());
  const { ledger } = deps;
  const secrets = [env.NEBIUS_API_KEY, env.PW_JUDGE_PASSPHRASE, requestJson?.passphrase];
  const reply = (status, body) => ({ status, body: redact(body, secrets) });
  try {
    const request = requestJson;
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(key => !['stage', 'session', 'payload', 'passphrase'].includes(key))) throw new InputError();
    if (Buffer.byteLength(JSON.stringify(request)) > 64000) throw new InputError('too_large');
    if (request.passphrase !== undefined && (typeof request.passphrase !== 'string' || request.passphrase.length > 1000)) throw new InputError();
    validatePayload(request.stage, request.payload);
    if (env.PW_SCHEMA_STYLE !== undefined && !['openai', 'nebius_doc', 'json_object', 'none'].includes(env.PW_SCHEMA_STYLE)) throw new InputError();
    const lane = chooseLane(request.passphrase, env);
    if (request.stage === 'extract') {
      if (request.session !== undefined && request.session !== null) throw new InputError();
      session = randomUUID();
    } else {
      if (typeof request.session !== 'string' || !/^[a-f0-9-]{36}$/.test(request.session)) throw new InputError();
      session = request.session;
    }
    await ledger.exclusive(async () => {
      const records = await ledger.read();
      const mine = records.filter(r => r.app === 'pw' && r.session === session);
      if (request.stage !== 'extract') {
        if (!mine.length || mine[0].lane !== lane) throw new InputError();
        const begins = mine.filter(r => r.event === 'started');
        const ends = mine.filter(r => r.event === 'finished');
        if (begins.length !== ends.length) throw new InputError();
        const completed = mine.filter(r => r.event === 'finished' && r.success);
        if (request.stage === 'hypothesize' && (!completed.some(r => r.stage === 'extract') || completed.some(r => r.stage === 'hypothesize'))) throw new InputError();
        if (request.stage === 'tests' && !completed.some(r => r.stage === 'hypothesize')) throw new InputError();
        // One initial round plus three rewrites (web/flow.mjs MAX_REWRITES).
        if (request.stage === 'tests' && begins.filter(r => r.stage === 'tests').length >= 4) throw new InputError();
      }
      await ledger.append({ app: 'pw', lane, day: jstDay(now()), amount: 0, session, stage: request.stage, event: 'started' });
      started = { lane, stage: request.stage };
    });
    client = new BudgetClient(deps.client, { ledger, session, lane, stage: request.stage, now,
      creditsUSD: deps.creditsUSD ?? Number(env.PW_GRANTED_CREDITS_USD ?? 0) });
    const result = await runStage(request.stage, request.payload, { client, schemaStyle: env.PW_SCHEMA_STYLE ?? DEFAULT_SCHEMA_STYLE });
    await finish(true);
    const remaining = Math.max(0, 0.08 - spent(await ledger.read(), session));
    return reply(200, { ...result.data, session, model: result.model, rateHeaders: result.rateHeaders,
      cost: client.cost, cost_estimated: client.estimated, remaining_session_usd: remaining, source: deps.source ?? 'live' });
  } catch (error) {
    if (started) { try { await finish(false); } catch { /* Fail closed below; never expose storage errors. */ } }
    const code = ['budget', 'too_large', 'bad_request'].includes(error.code) ? error.code : 'upstream_error';
    let remaining = 0;
    try { if (session) remaining = Math.max(0, 0.08 - spent(await ledger.read(), session)); } catch { /* Fail closed. */ }
    return reply(code === 'too_large' ? 413 : code === 'bad_request' ? 400 : code === 'budget' ? 429 : 502,
      { error: code, message: code === 'budget' ? 'Budget refused. Use the precomputed results (cost $0).'
        : code === 'upstream_error' ? 'Model service unavailable or output rejected.' : 'Invalid input or size limit exceeded.',
      ...(session ? { session } : {}), cost: client?.cost ?? 0, cost_estimated: client?.estimated ?? false, remaining_session_usd: remaining });
  }
  async function finish(success) {
    const marker = started;
    if (!marker) return;
    await ledger.exclusive(async () => ledger.append({ app: 'pw', ...marker, day: jstDay(now()), amount: 0,
      session, event: 'finished', success }));
    started = undefined;
  }
}
