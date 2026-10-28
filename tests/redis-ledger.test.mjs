import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisLedger, BudgetClient, BudgetError, redisConfigured } from '../server/budget.mjs';
import { MODELS } from '../server/models.mjs';
import { MockChatClient } from '../server/llm.mjs';
import { handle } from '../server/api.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { runModelFlow } from '../web/flow.mjs';
import { runSuite } from '../core/runner.node.mjs';
import { loadScript, sampleInput } from '../scripts/mock-flow.mjs';

const TOKEN = 'fake-redis-token-123';
const env = { UPSTASH_REDIS_REST_URL: 'https://fake.upstash.invalid', UPSTASH_REDIS_REST_TOKEN: TOKEN };

// In-memory stand-in for the four Upstash REST commands the ledger uses.
function fakeRedis({ failWith } = {}) {
  const state = { kv: new Map(), lists: new Map(), calls: [] };
  const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });
  state.fetchImpl = async (url, init) => {
    if (init.headers.Authorization !== `Bearer ${TOKEN}`) return reply(401, { error: 'WRONGPASS invalid password' });
    const [name, ...args] = JSON.parse(init.body);
    state.calls.push(name);
    if (failWith) return reply(200, failWith);
    if (name === 'SET') {
      const [key, value] = args;
      if (args.includes('NX') && state.kv.has(key)) return reply(200, { result: null });
      state.kv.set(key, value); return reply(200, { result: 'OK' });
    }
    if (name === 'EVAL') {
      const [, , key, token] = args;
      if (state.kv.get(key) === token) { state.kv.delete(key); return reply(200, { result: 1 }); }
      return reply(200, { result: 0 });
    }
    if (name === 'RPUSH') {
      const [key, value] = args;
      const list = state.lists.get(key) ?? []; list.push(value); state.lists.set(key, list);
      return reply(200, { result: list.length });
    }
    if (name === 'LRANGE') return reply(200, { result: [...(state.lists.get(args[0]) ?? [])] });
    return reply(200, { error: 'ERR unknown command' });
  };
  return state;
}

test('Redis ledger round-trips records and reads Exception Keeper records in the shared list', async () => {
  const redis = fakeRedis();
  const ledger = new RedisLedger({ env, fetchImpl: redis.fetchImpl });
  // Python's json.dumps puts spaces after separators; both forms must parse.
  redis.lists.set('x129:ledger:records', ['{"app": "ek", "lane": "public", "day": "2026-10-28", "amount": 0.25, "session": "e", "stage": "judge", "event": "usage", "estimated": false}']);
  await ledger.exclusive(() => ledger.append({ app: 'pw', lane: 'public', day: '2026-10-28', amount: 0, session: 's', stage: 'extract', event: 'started' }));
  const records = await ledger.exclusive(() => ledger.read());
  assert.deepEqual(records.map(r => r.app), ['ek', 'pw']);
  assert.equal(redis.kv.has('x129:ledger:lock'), false);
  assert.ok(redisConfigured(env) && !redisConfigured({ KV_REST_API_URL: 'u' }));
  assert.ok(redisConfigured({ KV_REST_API_URL: 'u', KV_REST_API_TOKEN: 't' }));
});

test('Redis ledger fails closed on invalid records, error replies and a held lock, without leaking the token', async () => {
  const bad = fakeRedis();
  bad.lists.set('x129:ledger:records', ['{"app":"pw","lane":"public","day":"2026-10-28","amount":-1}']);
  const badLedger = new RedisLedger({ env, fetchImpl: bad.fetchImpl });
  await assert.rejects(badLedger.exclusive(() => badLedger.read()), e => e instanceof BudgetError);
  assert.equal(bad.kv.has('x129:ledger:lock'), false);
  await assert.rejects(new RedisLedger({ env, fetchImpl: bad.fetchImpl }).read(), e => e.message === 'Budget refused: invalid ledger');
  const broken = fakeRedis({ failWith: { error: `boom ${TOKEN}` } });
  await assert.rejects(new RedisLedger({ env, fetchImpl: broken.fetchImpl }).exclusive(async () => 1),
    e => e instanceof BudgetError && !e.message.includes(TOKEN));
  const held = fakeRedis();
  held.kv.set('x129:ledger:lock', 'someone-else');
  let clock = 0;
  const waiting = new RedisLedger({ env, fetchImpl: held.fetchImpl, lockWaitMs: 1000, pollMs: 400, now: () => clock, sleep: async ms => { clock += ms; } });
  await assert.rejects(waiting.exclusive(async () => 1), e => e.message === 'Budget refused: ledger busy');
  assert.equal(held.kv.get('x129:ledger:lock'), 'someone-else');
  await assert.rejects(new RedisLedger({ env: {}, fetchImpl: held.fetchImpl }).exclusive(async () => 1), e => e instanceof BudgetError);
});

test('Redis ledger serialises callers in one instance and the shared total enforces granted credits across apps', async () => {
  const redis = fakeRedis();
  const ledger = new RedisLedger({ env, fetchImpl: redis.fetchImpl });
  const order = [];
  await Promise.all([1, 2, 3].map(n => ledger.exclusive(async () => { order.push(`in${n}`); await new Promise(r => setTimeout(r, 5)); order.push(`out${n}`); })));
  assert.deepEqual(order, ['in1', 'out1', 'in2', 'out2', 'in3', 'out3']);
  redis.lists.set('x129:ledger:records', [JSON.stringify({ app: 'ek', lane: 'public', day: '2026-10-28', amount: 9.9999 })]);
  const client = new BudgetClient(new MockChatClient([{ model: MODELS.nano, content: '{}' }]),
    { ledger, session: 's', lane: 'public', stage: 'extract', now: () => new Date('2026-10-28T03:00:00Z'), creditsUSD: 10 });
  await assert.rejects(client.complete({ model: MODELS.nano, messages: [{ role: 'user', content: 'x' }], maxTokens: 3000 }),
    e => e instanceof BudgetError);
});

test('the full mock flow runs through the API on the Redis ledger and leaves no lock behind', async () => {
  const redis = fakeRedis();
  const ledger = new RedisLedger({ env, fetchImpl: redis.fetchImpl });
  const deps = { client: new MockChatClient(await loadScript('month-end')), ledger, creditsUSD: 45, source: 'mock',
    now: () => new Date('2026-10-28T03:00:00Z') };
  const result = await runModelFlow({ input: await sampleInput('month-end', 'good'), runSuite,
    callStage: request => handle(request, {}, deps) });
  assert.equal(result.rounds.at(-1).card.verdict, 'supported');
  const records = redis.lists.get('x129:ledger:records').map(item => JSON.parse(item));
  assert.ok(records.some(r => r.event === 'started') && records.some(r => r.amount > 0));
  assert.equal(redis.kv.has('x129:ledger:lock'), false);
});

test('on Vercel, live stays disabled unless the shared Redis ledger is configured', async () => {
  const off = await createRuntime({ VERCEL: '1', PW_LIVE: '1', PW_GRANTED_CREDITS_USD: '20' })({ stage: 'extract', payload: { bug_report: 'x' } });
  assert.equal(off.status, 429);
  assert.match(off.body.message, /disabled/);
});
