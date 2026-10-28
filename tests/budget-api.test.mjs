import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryLedger, FileLedger, BudgetClient, BudgetError, jstDay, measuredCost, callCost, remaining, defaultLedgerPath } from '../server/budget.mjs';
import { MODELS } from '../server/models.mjs';
import { MockChatClient } from '../server/llm.mjs';
import { handle, chooseLane } from '../server/api.mjs';
import { handlePOST } from '../server/serverless.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { loadScript, sampleInput } from '../scripts/mock-flow.mjs';
import { runModelFlow } from '../web/flow.mjs';
import { runSuite } from '../core/runner.node.mjs';

const key = 'FAKE_KEY_API_BUDGET_TEST';
const passphrase = 'FAKE_PASSPHRASE_API_BUDGET_TEST';
const env = { NEBIUS_API_KEY: key, PW_JUDGE_PASSPHRASE: passphrase };
const request = { model: MODELS.nano, messages: [{ role: 'user', content: 'Test' }], maxTokens: 700 };
const record = (amount, extra = {}) => ({ app: 'pw', lane: 'public', day: '2026-10-24', amount, ...extra });
const depsFor = (script, extra = {}) => ({ client: new MockChatClient(script), ledger: new MemoryLedger(), creditsUSD: 45,
  now: () => new Date('2026-10-24T00:00:00Z'), source: 'mock', ...extra });
const budget = (ledger, extra = {}) => new BudgetClient(new MockChatClient([{ content: '{}', usage: { prompt_tokens: 200, completion_tokens: 100 } }]),
  { ledger, session: 's', lane: 'public', stage: 'extract', now: () => new Date('2026-10-24T00:00:00Z'), creditsUSD: 45, ...extra });
async function refused(records, overrides = {}) {
  const client = budget(new MemoryLedger(records), overrides);
  await assert.rejects(client.complete(request), error => error.code === 'budget');
  assert.equal(client.client.requests.length, 0);
}

test('cost uses catalog prices, cached usage, and marked character estimates when usage is absent', () => {
  assert.equal(callCost(MODELS.nano, 1e6, 1e6), .30);
  assert.equal(callCost(MODELS.super, 1e6, 1e6, 1e6), .96);
  assert.equal(callCost(MODELS.ultra, 1e6, 1e6, 1e6), 3.12);
  const cost = measuredCost(request, { content: 'abcabc' });
  assert.ok(cost.estimated && cost.amount > 0);
  const known = measuredCost({ ...request, model: MODELS.super }, { usage: {
    prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 500 },
  } });
  assert.equal(known.estimated, false);
  assert.ok(Math.abs(known.amount - .00027) < 1e-12);
});

test('session admission uses maxTokens and refuses before calling the model', async () => {
  await refused([record(.07999, { session: 's' })]);
  const client = budget(new MemoryLedger());
  await assert.rejects(client.complete({ ...request, maxTokens: 1e9 }), BudgetError);
  assert.equal(client.client.requests.length, 0);
});

test('build cap counts pw for the whole build period but not ek toward the pw cap', async () => {
  await refused([record(2.5, { day: '2026-10-23' }), record(2.49999, { day: '2026-10-30' })]);
  const client = budget(new MemoryLedger([record(5, { app: 'ek' })]));
  await client.complete(request);
  assert.equal(client.client.requests.length, 1);
});

test('November daily pw cap counts both lanes and resets at JST midnight', async () => {
  await refused([record(.05, { day: '2026-11-01' }), record(.04999, { day: '2026-11-01', lane: 'judge' })],
    { now: () => new Date('2026-11-01T00:00:00Z') });
  const client = budget(new MemoryLedger([record(.10, { day: '2026-11-01' })]),
    { now: () => new Date('2026-11-01T15:00:00Z') });
  await client.complete(request);
  assert.equal(client.ledger.records.at(-1).day, '2026-11-02');
  assert.equal(jstDay('2026-10-30T14:59:59Z'), '2026-10-30');
  assert.equal(jstDay('2026-10-30T15:00:00Z'), '2026-10-31');
});

test('judging public and judge daily caps are independent', async () => {
  for (const [lane, cap] of [['public', .15], ['judge', .40]]) await refused([
    record(cap - .00001, { lane, day: '2026-12-01' }),
  ], { lane, now: () => new Date('2026-12-01T00:00:00Z') });
  const client = budget(new MemoryLedger([record(.15, { day: '2026-12-01' })]),
    { lane: 'judge', now: () => new Date('2026-12-01T00:00:00Z') });
  await client.complete(request);
});

test('global cap includes ek and pw across all dates and lanes', async () => {
  await refused([record(40, { app: 'ek', day: '2026-01-01' }), record(4.99999, { lane: 'judge', day: '2026-09-01' })]);
});

test('outside allowed periods and without a configured credit grant no calls are admitted', async () => {
  for (const now of ['2026-10-22', '2026-12-17', '2027-01-01']) await refused([], { now: () => new Date(now) });
  for (const creditsUSD of [0, NaN, -.1]) await refused([], { creditsUSD });
  await refused([record(.99999, { app: 'ek' })], { creditsUSD: 1 });
  assert.equal(defaultLedgerPath({ X129_LEDGER_PATH: '/custom/ledger.jsonl' }), '/custom/ledger.jsonl');
  assert.ok(defaultLedgerPath({}).endsWith('/.x129/ledger.jsonl'));
});

test('invalid shared ledger records fail closed, including other-app records', async () => {
  for (const bad of [record(-1), record(NaN), record(Infinity), record('1'), record(1, { app: 'other' }),
    record(1, { lane: 'other' }), record(1, { day: '2026-02-30' }), { app: 'ek' }, null]) await refused([bad]);
});

test('failed model calls are conservatively charged without storing error contents', async () => {
  const ledger = new MemoryLedger();
  const client = new BudgetClient({ complete: async () => { throw new Error(`${key} ${passphrase}`); } },
    { ledger, session: 's', lane: 'public', stage: 'extract', creditsUSD: 45, now: () => new Date('2026-10-24') });
  await assert.rejects(client.complete(request));
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].estimated, true);
  assert.ok(ledger.records[0].amount > 0);
  assert.ok(!JSON.stringify(ledger.records).includes(key));
});

test('file ledger persists across instances, counts ek, rejects invalid JSONL, and reclaims stale locks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pw-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.jsonl');
  const a = new FileLedger(path), b = new FileLedger(path);
  await a.exclusive(async () => { await a.append(record(2, { app: 'ek' })); await a.append(record(.01, { session: 's' })); });
  assert.equal((await b.read()).length, 2);
  await budget(b).complete(request);
  assert.equal((await a.read()).length, 3);
  const raw = await readFile(path, 'utf8');
  assert.ok(raw.endsWith('\n'));
  await writeFile(path + '.lock', 'dead owner');
  await utimes(path + '.lock', new Date(0), new Date(0));
  await b.exclusive(async () => assert.equal((await b.read()).length, 3));
  await writeFile(path, raw + 'not JSON\n');
  await assert.rejects(budget(a).complete(request), /invalid ledger/);
  await writeFile(path, raw + '\n');
  await assert.rejects(budget(b).complete(request), /invalid ledger/);
});

test('file lock spans admission through recording across two instances', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pw-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.jsonl');
  let active = 0, maxActive = 0;
  const client = { complete: async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 15)); active--;
    return { content: '{}', usage: { prompt_tokens: 1, completion_tokens: 20000 } };
  } };
  const deps = { session: 's', lane: 'public', stage: 'tests', creditsUSD: 45, now: () => new Date('2026-10-24') };
  const a = new BudgetClient(client, { ...deps, ledger: new FileLedger(path) });
  const b = new BudgetClient(client, { ...deps, ledger: new FileLedger(path) });
  const results = await Promise.allSettled([a.complete({ ...request, model: MODELS.ultra, maxTokens: 20000 }),
    b.complete({ ...request, model: MODELS.ultra, maxTokens: 20000 })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(maxActive, 1);
  assert.ok((await a.ledger.read())[0].amount <= .08);
});

test('session cap stops the actual rewrite loop before another HTTP/model call', async () => {
  const deps = depsFor(await loadScript('month-end'));
  await assert.rejects(runModelFlow({ input: await sampleInput('month-end', 'good'), runSuite,
    callStage: request => handle(request, {}, deps), onRound: round => {
      if (round.round === 0) deps.ledger.records.push(record(.079, { session: deps.ledger.records[0].session }));
    } }), error => {
    assert.equal(error.code, 'budget'); assert.equal(error.rounds.length, 1); return true;
  });
  assert.equal(deps.client.requests.length, 3);
});

test('API validates size, shapes, stage, session, and env schema override', async () => {
  const deps = depsFor(await loadScript('month-end'));
  for (const input of [null, [], {}, { stage: 'other', payload: {} },
    { stage: 'extract', payload: { bug_report: 1 } },
    { stage: 'extract', session: 'attacker', payload: { bug_report: 'x' } },
    { stage: 'tests', session: 'unknown', payload: {} }]) assert.equal((await handle(input, env, deps)).status, 400);
  assert.equal((await handle({ stage: 'extract', payload: { bug_report: 'x'.repeat(4001) } }, env, deps)).body.error, 'too_large');
  assert.equal((await handle({ stage: 'extract', payload: { bug_report: 'x' }, passphrase: 'x'.repeat(65000) }, env, deps)).status, 413);
  const extracted = (await loadScript('month-end'))[0].content;
  const input = await sampleInput('month-end', 'good');
  const base = { stage: 'hypothesize', session: '0'.repeat(36), payload: { extraction: extracted, moduleFiles: input.moduleFiles, patch: input.patch } };
  assert.equal((await handle({ ...base, payload: { ...base.payload, moduleFiles: { 'x.mjs': 'x'.repeat(12001) } } }, env, deps)).body.error, 'too_large');
  assert.equal((await handle({ ...base, payload: { ...base.payload, patch: 'x'.repeat(16001) } }, env, deps)).body.error, 'too_large');
  assert.equal((await handle({ ...base, payload: { ...base.payload, moduleFiles: { '../escape.mjs': 'x' } } }, env, deps)).status, 400);
  assert.equal(deps.client.requests.length, 0);
  const result = await handle({ stage: 'extract', payload: { bug_report: 'x' } }, { ...env, PW_SCHEMA_STYLE: 'json_object' }, deps);
  assert.equal(result.status, 200);
  assert.match(result.body.session, /^[a-f0-9-]{36}$/);
  assert.deepEqual(deps.client.requests[0].responseFormat, { type: 'json_object' });
});

test('API passphrase chooses lane with a constant-size digest comparison; no secret leaks in success, errors or logs', async t => {
  const logs = [];
  for (const name of ['log', 'warn', 'error']) t.mock.method(console, name, (...args) => logs.push(args));
  assert.equal(chooseLane('wrong', env), 'public');
  assert.equal(chooseLane(passphrase, env), 'judge');
  assert.equal(chooseLane('', {}), 'public');
  for (const supplied of ['wrong', passphrase]) {
    const script = await loadScript('month-end');
    script[0].content.expected = `${key} ${passphrase}`;
    const deps = depsFor(script);
    const result = await handle({ stage: 'extract', payload: { bug_report: 'Date overflow' }, passphrase: supplied }, env, deps);
    assert.equal(result.status, 200);
    assert.ok(!JSON.stringify(result).includes(key) && !JSON.stringify(result).includes(passphrase));
    assert.equal(deps.ledger.records[0].lane, supplied === passphrase ? 'judge' : 'public');
    assert.ok(!JSON.stringify(deps.ledger.records).includes(key) && !JSON.stringify(deps.ledger.records).includes(passphrase));
  }
  const deps = depsFor([]);
  deps.client = { complete: async () => { throw new Error(`${key} ${passphrase}`); } };
  const failed = await handle({ stage: 'extract', passphrase, payload: { bug_report: 'x' } }, env, deps);
  assert.equal(failed.body.error, 'upstream_error');
  assert.ok(!JSON.stringify(failed).includes(key) && !JSON.stringify(failed).includes(passphrase));
  assert.ok(!JSON.stringify(logs).includes(key) && !JSON.stringify(logs).includes(passphrase));
});

test('API enforces session stage order, lane binding, and maximum four test rounds', async () => {
  const script = await loadScript('month-end');
  script.push(structuredClone(script.at(-1)), structuredClone(script.at(-1)), structuredClone(script.at(-1)));
  const deps = depsFor(script);
  const input = await sampleInput('month-end', 'good');
  const extract = await handle({ stage: 'extract', payload: { bug_report: input.bug_report } }, env, deps);
  const { expected, actual, repro_steps, inputs, suspected_area, session } = extract.body;
  const extraction = { expected, actual, repro_steps, inputs, suspected_area };
  const payload = { extraction, moduleFiles: input.moduleFiles, patch: input.patch };
  const early = await handle({ stage: 'tests', session, payload: { ...payload, hypotheses: [] } }, env, deps);
  assert.equal(early.status, 400);
  const switched = await handle({ stage: 'hypothesize', session, passphrase, payload }, env, deps);
  assert.equal(switched.status, 400);
  const hypotheses = await handle({ stage: 'hypothesize', session, payload }, env, deps);
  assert.equal(hypotheses.status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await handle({ stage: 'tests', session, payload: { ...payload, hypotheses: hypotheses.body.hypotheses } }, env, deps)).status, 200);
  assert.equal((await handle({ stage: 'tests', session, payload: { ...payload, hypotheses: hypotheses.body.hypotheses } }, env, deps)).status, 400);
});

test('Web adapter parses requests and rejects oversized/malformed bodies; live is disabled by default', async () => {
  let seen;
  const handler = async request => { seen = request; return { status: 200, body: { ok: true } }; };
  const response = await handlePOST(new Request('http://127.0.0.1/api/pw', { method: 'POST', body: '{"stage":"extract"}' }), { handler });
  assert.equal(response.status, 200); assert.equal(seen.stage, 'extract');
  assert.equal((await handlePOST(new Request('http://127.0.0.1/api/pw'), { handler })).status, 405);
  assert.equal((await handlePOST(new Request('http://127.0.0.1/api/pw', { method: 'POST', body: 'x' }), { handler })).status, 400);
  assert.equal((await handlePOST(new Request('http://127.0.0.1/api/pw', { method: 'POST', body: 'x'.repeat(64001) }), { handler })).status, 413);
  assert.equal((await createRuntime({})({})).body.error, 'budget');
});

test('retry attempts are reserved before admission and failed attempts are conservatively recorded', async () => {
  const client = { maxRetries: 2, complete: async () => ({ content: '{}', usage: { prompt_tokens: 200, completion_tokens: 100 }, attempts: 2 }) };
  const ledger = new MemoryLedger();
  const wrapped = new BudgetClient(client, { ledger, session: 's', lane: 'public', stage: 'extract', creditsUSD: 45,
    now: () => new Date('2026-10-24') });
  await wrapped.complete(request);
  const charge = ledger.records[0];
  assert.equal(charge.estimated, true);
  assert.ok(charge.amount > callCost(MODELS.nano, 200, 100));
  ledger.records.push(record(.0797, { session: 's' }));
  await assert.rejects(wrapped.complete(request), BudgetError);
});

test('local Node adapter routes POST, limits bodies and serves only public assets without opening a socket', async () => {
  const { createLocalServer } = await import('../serve.mjs');
  let received;
  const server = createLocalServer({ handleAPI: async body => { received = body; return { status: 200, body: { expected: 'safe' } }; } });
  const listener = server.listeners('request')[0];
  async function dispatch(url, method = 'GET', body = '') {
    const req = { url, method, async *[Symbol.asyncIterator]() { yield Buffer.from(body); } };
    const res = { status: 0, writeHead(status) { this.status = status; return this; }, end(body) { this.body = body; } };
    await listener(req, res);
    return res;
  }
  assert.equal((await dispatch('/api/pw', 'POST', '{"stage":"extract"}')).status, 200);
  assert.equal(received.stage, 'extract');
  assert.equal((await dispatch('/api/pw', 'POST', 'bad')).status, 400);
  assert.equal((await dispatch('/api/pw', 'POST', 'x'.repeat(64001))).status, 413);
  assert.equal((await dispatch('/api/pw', 'PUT')).status, 405);
  assert.equal((await dispatch('/')).status, 302);  // redirected to /web/index.html so relative module URLs resolve
  assert.equal((await dispatch('/web/index.html')).status, 200);
  assert.equal((await dispatch('/server/api.mjs')).status, 404);
  assert.equal((await dispatch('/web/%2e%2e%2fserver/api.mjs')).status, 403);
});

test('file ledger handles a valid last line without a newline and refuses an active lock', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pw-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.jsonl');
  await writeFile(path, JSON.stringify(record(.01, { app: 'ek' })));
  const ledger = new FileLedger(path, { lockWaitMs: 0 });
  await ledger.exclusive(() => ledger.append(record(.01)));
  assert.equal((await ledger.read()).length, 2);
  await writeFile(path + '.lock', 'active owner');
  await assert.rejects(budget(ledger).complete(request), /ledger busy/);
});

test('live default asks for the strict json_schema; PW_SCHEMA_STYLE still overrides it', async () => {
  for (const [env, type] of [[{}, 'json_schema'], [{ PW_SCHEMA_STYLE: 'json_object' }, 'json_object']]) {
    const deps = depsFor((await loadScript('month-end')).slice(0, 1)), { client } = deps;
    await handle({ stage: 'extract', payload: { bug_report: 'Month-end date overflow.' } }, env, deps);
    assert.equal(client.requests[0].responseFormat.type, type);
  }
});
