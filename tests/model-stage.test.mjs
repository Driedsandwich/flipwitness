import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpChatClient, MockChatClient } from '../server/llm.mjs';
import { MODELS, BASE_URL, PRICES } from '../server/models.mjs';
import { responseFormat, parseJSON, validate, staticGate, structuredComplete } from '../server/jsonout.mjs';
import { runStage, extractionSchema } from '../server/stages.mjs';
import { handle } from '../server/api.mjs';
import { MemoryLedger } from '../server/budget.mjs';
import { runModelFlow } from '../web/flow.mjs';
import { runSuite } from '../core/runner.node.mjs';
import { loadScript, sampleInput, mockFlow } from '../scripts/mock-flow.mjs';

const key = 'FAKE_API_KEY_DO_NOT_LEAK';
const passphrase = 'FAKE_JUDGES_PASSPHRASE_DO_NOT_LEAK';
const usage = { prompt_tokens: 200, completion_tokens: 100 };
const request = { model: MODELS.nano, messages: [{ role: 'user', content: 'Return JSON' }], maxTokens: 700 };
const extracted = (await loadScript('month-end'))[0].content;
const success = content => ({ content: typeof content === 'string' ? content : JSON.stringify(content), usage });
const depsFor = client => ({ client, ledger: new MemoryLedger(), creditsUSD: 45,
  now: () => new Date('2026-10-24T00:00:00Z'), source: 'mock' });

async function stub(t, script) {
  const calls = [], errors = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls.push(body);
      const item = script.shift();
      assert.ok(item, 'Unexpected HTTP request');
      if (item.model) assert.equal(body.model, item.model);
      if (item.check) item.check(body);
      res.writeHead(item.status ?? 200, { 'Content-Type': 'application/json',
        'x-ratelimit-remaining-requests': '17', 'x-ratelimit-remaining-tokens': '1234',
        'x-ratelimit-over-limit': 'false', ...item.headers });
      res.end(JSON.stringify(item.status ? { error: `${key} ${passphrase}` } : {
        choices: [{ message: { content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content), reasoning_content: `${key} ${passphrase}` } }],
        usage: item.usage ?? usage,
      }));
    } catch (error) { errors.push(error); res.writeHead(500).end('{}'); }
  });
  // Skip only when the actual loopback bind fails, never on assertion failures.
  const bindError = await new Promise(resolve => {
    server.once('error', resolve);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', resolve); resolve(null); });
  });
  if (bindError) { t.skip(`Loopback bind failed: ${bindError.code ?? 'unknown'}`); return null; }
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
    assert.equal(script.length, 0, 'Unconsumed stub responses');
  });
  return { calls, baseURL: `http://127.0.0.1:${server.address().port}/v1/` };
}

test('catalog snapshot and all response format switches are exact', () => {
  assert.equal(BASE_URL, 'https://api.tokenfactory.nebius.com/v1/');
  assert.equal(MODELS.nano, 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
  assert.equal(MODELS.super, 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(MODELS.ultra, 'nvidia/Nemotron-3-Ultra-550b-a55b');
  assert.deepEqual(PRICES[MODELS.nano], { input: .06, output: .24 });
  assert.deepEqual(PRICES[MODELS.super], { input: .30, cached: .06, output: .90 });
  assert.deepEqual(PRICES[MODELS.ultra], { input: 1, cached: .12, output: 3 });
  assert.equal(responseFormat(extractionSchema).json_schema.name, 'patchwitness');
  assert.equal(responseFormat(extractionSchema, 'nebius_doc').json_schema, extractionSchema);
  assert.deepEqual(responseFormat(extractionSchema, 'json_object'), { type: 'json_object' });
  assert.equal(responseFormat(extractionSchema, 'none'), undefined);
  assert.throws(() => responseFormat(extractionSchema, 'invented'));
});

test('HTTP stub checks every schema style, Authorization, model and rate headers', async t => {
  const styles = ['openai', 'nebius_doc', 'json_object', 'none'];
  const server = await stub(t, styles.map(style => ({ model: MODELS.nano, content: extracted,
    check: body => {
      assert.deepEqual(body.response_format, responseFormat(extractionSchema, style));
      assert.equal(body.max_tokens, 3000);
      assert.equal(body.temperature, .2);
    } })));
  if (!server) return;
  const client = new HttpChatClient({ baseURL: server.baseURL, env: { NEBIUS_API_KEY: key } });
  for (const schemaStyle of styles) {
    const result = await runStage('extract', { bug_report: 'Month-end date overflow.' }, { client, schemaStyle });
    assert.deepEqual(result.data, extracted);
    assert.deepEqual(result.rateHeaders, { 'x-ratelimit-remaining-requests': '17',
      'x-ratelimit-remaining-tokens': '1234', 'x-ratelimit-over-limit': 'false' });
  }
});

test('HTTP 429 honors Retry-After before success; other 4xx never retry', async t => {
  const server = await stub(t, [{ status: 429, headers: { 'Retry-After': '0.01' } },
    { content: '{}' }, { status: 401 }, { status: 400 }]);
  if (!server) return;
  const sleeps = [];
  const client = new HttpChatClient({ baseURL: server.baseURL, env: { NEBIUS_API_KEY: key }, sleep: async ms => sleeps.push(ms) });
  await client.complete(request);
  assert.deepEqual(sleeps, [10]);
  for (const status of [401, 400]) await assert.rejects(client.complete(request), error => {
    assert.equal(error.status, status);
    assert.ok(!error.message.includes(key) && !error.message.includes(passphrase));
    return true;
  });
  assert.equal(server.calls.length, 4);
});

test('HTTP 500 twice exhausts retry policy; excessive Retry-After refuses immediately', async t => {
  const server = await stub(t, [{ status: 500 }, { status: 500 },
    { status: 429, headers: { 'Retry-After': '99999' } }]);
  if (!server) return;
  const client = new HttpChatClient({ baseURL: server.baseURL, env: { NEBIUS_API_KEY: key }, maxRetries: 1, sleep: async () => {} });
  await assert.rejects(client.complete(request), /HTTP 500/);
  await assert.rejects(client.complete(request), /HTTP 429/);
  assert.equal(server.calls.length, 3);
});

test('HTTP key is read at call time; transport errors and reflected content redact it', async () => {
  const env = {};
  const client = new HttpChatClient({ env, fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    return Response.json({ choices: [{ message: { content: key, reasoning_content: passphrase } }] });
  } });
  await assert.rejects(client.complete(request), /Upstream request failed/);
  env.NEBIUS_API_KEY = key;
  assert.equal((await client.complete(request)).content, '[redacted]');
  const unsafe = new HttpChatClient({ env, fetchImpl: async () => { throw new Error(`${key} ${passphrase}`); } });
  await assert.rejects(unsafe.complete(request), error => !error.message.includes(key) && !error.message.includes(passphrase));
});

test('JSON parsing handles think, fences, escaped braces, prose; validator is strict', () => {
  assert.deepEqual(parseJSON('<think>not JSON {}</think>\n```json\n{"x":"a}\\\"b"}\n```'), { x: 'a}"b' });
  assert.deepEqual(parseJSON('Here: {"x":{"y":1}} done'), { x: { y: 1 } });
  assert.throws(() => parseJSON('<think>unfinished {"x":1}'));
  assert.deepEqual(validate(extracted, extractionSchema), []);
  for (const value of [{}, { ...extracted, extra: 1 }, { ...extracted, expected: 'x'.repeat(1501) },
    { ...extracted, inputs: [42] }, { ...extracted, suspected_area: 1 }]) assert.ok(validate(value, extractionSchema).length);
  assert.ok(validate('x', { type: 'string', enum: ['a'] }).length);
  assert.ok(validate(Infinity, { type: 'number' }).length);
});

test('invalid HTTP JSON gets exactly one repair; repeated invalid output is structured failure', async t => {
  const server = await stub(t, [{ content: 'not JSON' }, { content: `<think>ignore this</think>\n\`\`\`json\n${JSON.stringify(extracted)}\n\`\`\`` }]);
  if (!server) return;
  const client = new HttpChatClient({ baseURL: server.baseURL, env: { NEBIUS_API_KEY: key } });
  const result = await runStage('extract', { bug_report: 'Date overflow' }, { client });
  assert.deepEqual(result.data, extracted);
  assert.match(server.calls[1].messages.at(-1).content, /Repair.*valid JSON/s);
  const mock = new MockChatClient([{ content: '{}' }, { content: '{}' }]);
  await assert.rejects(structuredComplete(mock, request, extractionSchema), error => {
    assert.equal(error.code, 'upstream_error'); assert.ok(error.errors.length); return true;
  });
  assert.equal(mock.requests.length, 2);
});

test('static gate rejects every forbidden token and external imports; accepts golden source', async () => {
  const clean = (await loadScript('month-end')).at(-1).content.tests_source;
  assert.deepEqual(staticGate(clean), []);
  for (const token of ['process', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts',
    'import(', 'eval', 'Function(', 'globalThis', 'self.', 'postMessage']) assert.ok(staticGate(`${clean}\n${token}`).length, token);
  for (const extra of ["import x from 'node:fs';", "import 'evil';", "export * from 'https://invalid';", "import /* x */ ('evil')"]) assert.ok(staticGate(clean + '\n' + extra).length);
  assert.ok(staticGate('//' + 'test(\n').length);
  assert.ok(staticGate(clean + ' '.repeat(8192)).length);
  assert.ok(staticGate(clean + '// ' + 'あ'.repeat(3000)).length);
});

test('gate violation is repaired once before execution and never echoed as executable code', async () => {
  const script = await loadScript('name-check');
  const client = new MockChatClient(script);
  const deps = depsFor(client);
  let executed = 0;
  const result = await runModelFlow({ input: await sampleInput('name-check', 'good'),
    callStage: r => handle(r, {}, deps), runSuite: options => { executed++; assert.ok(!options.testSource.includes('fetch')); return runSuite(options); } });
  assert.equal(result.rounds[0].card.verdict, 'supported');
  assert.equal(client.requests.length, 4);
  assert.match(client.requests[3].messages.at(-1).content, /Forbidden token: fetch/);
  assert.equal(executed, 2);
});

test('hypothesis stage drops non-existent paths', async () => {
  const script = await loadScript('month-end');
  const h = script[1].content.hypotheses[0];
  const input = await sampleInput('month-end', 'good');
  const result = await runStage('hypothesize', { extraction: extracted, moduleFiles: input.moduleFiles, patch: input.patch },
    { client: new MockChatClient([{ content: { hypotheses: [h, { ...h, id: 'bad', file: 'missing.mjs' }] } }]) });
  assert.deepEqual(result.data.hypotheses, [h]);
});

for (const patch of ['good', 'incomplete']) test(`full HTTP month-end flow, ${patch} patch, uses Node runner and rewrite feedback`, async t => {
  const script = await loadScript('month-end');
  const server = await stub(t, script);
  if (!server) return;
  const client = new HttpChatClient({ baseURL: server.baseURL, env: { NEBIUS_API_KEY: key } });
  const deps = depsFor(client);
  const result = await runModelFlow({ input: await sampleInput('month-end', patch), runSuite,
    callStage: request => handle(request, {}, deps) });
  assert.deepEqual(result.steps.map(step => step.model), [MODELS.nano, MODELS.ultra, MODELS.super, MODELS.super]);
  assert.equal(result.rounds[0].card.verdict, 'no_evidence');
  assert.equal(result.rounds[1].card.verdict, patch === 'good' ? 'supported' : 'patch_suspect');
  assert.equal(result.rounds[1].card.summary.witnesses, patch === 'good' ? 3 : 2);
  assert.ok(result.cost > 0 && result.cost < .08);
  const payload = JSON.parse(server.calls[3].messages[1].content);
  assert.ok(payload.previous.results.every(r => r.before === 'pass' && r.after === 'pass'));
  assert.match(server.calls[3].messages[0].content, /pass\/pass is not evidence/);
});

test('all mock sample flows and precomputed data agree on verdict and source', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const sample of ['month-end', 'name-check', 'csv-line']) {
    const pre = JSON.parse(await readFile(new URL(`./fixtures/precomputed_mock/${sample}.json`, import.meta.url), 'utf8'));
    assert.equal(pre.source, 'mock'); assert.equal(pre.cost, 0);
    for (const patch of ['good', 'incomplete']) {
      const result = await mockFlow(sample, patch);
      assert.deepEqual(result.rounds.map(r => r.card), pre.patches[patch].rounds.map(r => r.card));
      assert.equal(result.rounds.at(-1).card.verdict, patch === 'good' ? 'supported' : 'patch_suspect');
    }
  }
});

test('the controller requests at most three rewrites when no witness exists', async () => {
  const script = await loadScript('month-end');
  script[3] = structuredClone(script[2]); script.push(structuredClone(script[2]), structuredClone(script[2]), structuredClone(script[2]));
  const deps = depsFor(new MockChatClient(script));
  const calls = [];
  const result = await runModelFlow({ input: await sampleInput('month-end', 'good'), runSuite,
    callStage: request => { calls.push(request); return handle(request, {}, deps); } });
  assert.equal(result.rounds.length, 4);
  assert.ok(result.rounds.every(r => r.card.verdict === 'no_evidence'));
  assert.equal(deps.client.requests.length, 6);
  // A fifth test round in the same session is refused by the API, before any model call.
  const refused = await handle(calls.at(-1), {}, deps);
  assert.equal(refused.status, 400);
  assert.equal(deps.client.requests.length, 6);
});

function scriptedFetch(script, calls = []) {
  return async (url, init) => {
    assert.equal(url.href, 'http://127.0.0.1:1/v1/chat/completions');
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    calls.push(body);
    const next = script.shift();
    assert.ok(next, 'Unexpected in-process transport request');
    if (next.model) assert.equal(body.model, next.model);
    if (next.check) next.check(body);
    return Response.json(next.status ? { error: `${key} ${passphrase}` } : {
      choices: [{ message: { content: typeof next.content === 'string' ? next.content : JSON.stringify(next.content), reasoning_content: passphrase } }],
      usage: next.usage ?? usage,
    }, { status: next.status ?? 200, headers: { 'x-ratelimit-remaining-requests': '17',
      'x-ratelimit-remaining-tokens': '1234', 'x-ratelimit-over-limit': 'false', ...next.headers } });
  };
}

test('in-process HTTP transport covers schema styles, retries, date Retry-After, caps, repairs and safe errors', async () => {
  const styles = ['openai', 'nebius_doc', 'json_object', 'none'];
  const script = styles.map(style => ({ model: MODELS.nano, content: extracted,
    check: body => assert.deepEqual(body.response_format, responseFormat(extractionSchema, style)) }));
  script.push({ status: 429, headers: { 'Retry-After': '0.01' } }, { content: '{}' },
    { status: 429, headers: { 'Retry-After': 'Sat, 24 Oct 2026 00:00:01 GMT' } }, { content: '{}' },
    { status: 500 }, { status: 500 }, { status: 401 },
    { status: 429, headers: { 'Retry-After': '99999' } }, { content: 'invalid JSON' },
    { content: `<think>private</think>\n\`\`\`json\n${JSON.stringify(extracted)}\n\`\`\`` });
  const calls = [], sleeps = [];
  const client = new HttpChatClient({ baseURL: 'http://127.0.0.1:1/v1/', env: { NEBIUS_API_KEY: key },
    fetchImpl: scriptedFetch(script, calls), maxRetries: 1,
    now: () => Date.parse('2026-10-24T00:00:00Z'), sleep: async ms => sleeps.push(ms) });
  for (const schemaStyle of styles) {
    const result = await runStage('extract', { bug_report: 'Date overflow' }, { client, schemaStyle });
    assert.deepEqual(result.data, extracted);
    assert.equal(result.rateHeaders['x-ratelimit-remaining-requests'], '17');
  }
  assert.equal((await client.complete(request)).attempts, 2);
  await client.complete(request);
  assert.deepEqual(sleeps, [10, 1000]);
  await assert.rejects(client.complete(request), /HTTP 500/);
  await assert.rejects(client.complete(request), /HTTP 401/);
  await assert.rejects(client.complete(request), /HTTP 429/);
  const repaired = await runStage('extract', { bug_report: 'Date overflow' }, { client });
  assert.deepEqual(repaired.data, extracted);
  assert.match(calls.at(-1).messages.at(-1).content, /Repair/);
  assert.equal(script.length, 0);
});

for (const patch of ['good', 'incomplete']) test(`full HttpChatClient flow with in-process transport, ${patch} patch`, async () => {
  const script = await loadScript('month-end');
  const calls = [];
  const client = new HttpChatClient({ baseURL: 'http://127.0.0.1:1/v1/', env: { NEBIUS_API_KEY: key }, fetchImpl: scriptedFetch(script, calls) });
  const deps = depsFor(client);
  const result = await runModelFlow({ input: await sampleInput('month-end', patch), runSuite,
    callStage: request => handle(request, { NEBIUS_API_KEY: key, PW_JUDGE_PASSPHRASE: passphrase }, deps) });
  assert.deepEqual(result.steps.map(s => s.model), [MODELS.nano, MODELS.ultra, MODELS.super, MODELS.super]);
  assert.deepEqual(result.rounds.map(r => r.card.verdict), ['no_evidence', patch === 'good' ? 'supported' : 'patch_suspect']);
  assert.ok(JSON.parse(calls[3].messages[1].content).previous.results.every(r => r.before === 'pass' && r.after === 'pass'));
  assert.equal(script.length, 0);
});

test('repeated static-gate rejection returns a structured failure and never runs tests', async () => {
  const script = await loadScript('name-check');
  script[3] = structuredClone(script[2]);
  const deps = depsFor(new MockChatClient(script));
  let ran = false;
  await assert.rejects(runModelFlow({ input: await sampleInput('name-check', 'good'),
    callStage: request => handle(request, {}, deps), runSuite: async () => { ran = true; return []; } }), error => error.code === 'upstream_error');
  assert.equal(ran, false);
  assert.equal(deps.client.requests.length, 4);
});

test('two invalid model answers fail after one JSON repair with sanitized validation reasons', async () => {
  const client = new MockChatClient([{ content: 'invalid' }, { content: '{}' }]);
  await assert.rejects(runStage('extract', { bug_report: 'Overflow' }, { client }), error => {
    assert.equal(error.code, 'upstream_error'); assert.ok(error.errors.length); return true;
  });
  assert.equal(client.requests.length, 2);
});

test('HTTP transport passes one total deadline signal and sanitizes an aborted body read', async () => {
  let signal;
  const client = new HttpChatClient({ env: { NEBIUS_API_KEY: key }, totalTimeoutMs: 20,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return { ok: true, status: 200, json: async () => { throw new Error(`${key} ${passphrase}`); } };
    } });
  await assert.rejects(client.complete(request), error => {
    assert.ok(!error.message.includes(key) && !error.message.includes(passphrase)); return true;
  });
  assert.ok(signal instanceof AbortSignal);
});

test('HTTP response metadata and failing body cancellation cannot echo secrets or request bodies', async () => {
  const env = { NEBIUS_API_KEY: key, PW_JUDGE_PASSPHRASE: passphrase };
  const client = new HttpChatClient({ env, fetchImpl: async () => Response.json({
    choices: [{ message: { content: `${key} ${passphrase}` } }],
    usage: { prompt_tokens: 200, completion_tokens: 100, diagnostics: `${key} ${passphrase}` },
  }) });
  const result = JSON.stringify(await client.complete(request));
  assert.ok(!result.includes(key) && !result.includes(passphrase));
  const failing = new HttpChatClient({ env, fetchImpl: async () => ({ ok: false, status: 500,
    body: { cancel: async () => { throw new Error(JSON.stringify(request)); } } }) });
  await assert.rejects(failing.complete(request), error => !error.message.includes('Return JSON'));
});

test('static gate also rejects the browser runner\'s other disabled globals and constructor chains', () => {
  const head = "import { periodEnd } from '@entry';\nimport { test, expect } from '@patchwitness/harness';\n";
  for (const body of ["test('a', () => { [].constructor.constructor('return 1')(); });",
    "test('a', () => { new EventSource('https://x.example'); });",
    "test('a', () => { new Worker('data:text/javascript,1'); });",
    "test('a', () => { new SharedWorker('x'); });",
    "test('a', () => { new WebTransport('https://x.example'); });"]) {
    assert.ok(staticGate(head + body).length > 0, body);
  }
  assert.deepEqual(staticGate(head + "test('a', () => { expect(periodEnd('2025-01-31')).toBe('2025-02-28'); });"), []);
});
