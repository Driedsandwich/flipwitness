import { open, readFile, mkdir, unlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PRICES } from './models.mjs';

export class BudgetError extends Error {
  constructor(reason = 'limit') { super(`Budget refused: ${reason}`); this.code = 'budget'; this.reason = reason; }
}
export const jstDay = date => new Date(new Date(date).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
export const defaultLedgerPath = (env = process.env) => env.X129_LEDGER_PATH || join(homedir(), '.x129', 'ledger.jsonl');
const sum = records => records.reduce((total, r) => total + r.amount, 0);
export function validateRecords(records) {
  for (const r of records) {
    if (!r || !['pw', 'ek'].includes(r.app) || !['public', 'judge'].includes(r.lane) ||
      typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) ||
      !Number.isFinite(Date.parse(r.day)) || new Date(r.day).toISOString().slice(0, 10) !== r.day ||
      typeof r.amount !== 'number' || !Number.isFinite(r.amount) || r.amount < 0) throw new BudgetError('invalid ledger');
  }
  return records;
}
export class MemoryLedger {
  constructor(records = []) { this.records = structuredClone(records); this.tail = Promise.resolve(); }
  async exclusive(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  async read() { return structuredClone(validateRecords(this.records)); }
  async append(record) { validateRecords([record]); this.records.push(structuredClone(record)); }
}
export class FileLedger {
  constructor(path = defaultLedgerPath(), { staleLockMs = 120_000, lockWaitMs = 1000, now = Date.now } = {}) {
    Object.assign(this, { path, staleLockMs, lockWaitMs, now });
  }
  async exclusive(fn) {
    const lockPath = this.path + '.lock';
    const token = randomUUID();
    const deadline = this.now() + this.lockWaitMs;
    try { await mkdir(dirname(this.path), { recursive: true }); }
    catch { throw new BudgetError('ledger unavailable'); }
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        try { await handle.writeFile(token); } finally { await handle.close(); }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw new BudgetError('ledger unavailable');
        try {
          if (this.now() - (await stat(lockPath)).mtimeMs > this.staleLockMs) { await unlink(lockPath); continue; }
        } catch (error) { if (error.code === 'ENOENT') continue; throw new BudgetError('ledger unavailable'); }
        if (this.now() >= deadline) throw new BudgetError('ledger busy');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try { return await fn(); }
    finally {
      try { if (await readFile(lockPath, 'utf8') === token) await unlink(lockPath); }
      catch (error) { if (error.code !== 'ENOENT') throw new BudgetError('ledger unavailable'); }
    }
  }
  async read() {
    let source;
    try { source = await readFile(this.path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new BudgetError('ledger unavailable'); }
    if (!source) return [];
    const lines = source.split('\n');
    if (lines.at(-1) === '') lines.pop();
    try { return validateRecords(lines.map(line => JSON.parse(line))); }
    catch { throw new BudgetError('invalid ledger'); }
  }
  async append(record) {
    validateRecords([record]);
    try {
      const handle = await open(this.path, 'a+', 0o600);
      try {
        const { size } = await handle.stat();
        const last = Buffer.alloc(1);
        if (size) await handle.read(last, 0, 1, size - 1);
        await handle.writeFile((size && last[0] !== 10 ? '\n' : '') + JSON.stringify(record) + '\n');
        await handle.sync();
      }
      finally { await handle.close(); }
    } catch { throw new BudgetError('ledger unavailable'); }
  }
}
// Shared durable ledger for serverless deployments: an Upstash Redis list reached over its
// REST API (POST a JSON array command to the base URL with a Bearer token; replies are
// {"result": ...} or {"error": ...}, https://upstash.com/docs/redis/features/restapi).
// Exception Keeper uses the same keys and record format, so the global cap counts both apps.
// The lock spans admission through recording, like the file lock: live sessions are serialised.
const UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
export const redisConfigured = (env = process.env) =>
  Boolean((env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL) && (env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN));
export class RedisLedger {
  constructor({ env = process.env, fetchImpl = fetch, lockWaitMs = 100_000, lockTtlMs = 120_000, pollMs = 500,
    now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const prefix = env.X129_LEDGER_PREFIX || 'x129:ledger';
    Object.assign(this, { url: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN, fetchImpl, lockWaitMs, lockTtlMs, pollMs,
      now, sleep, list: `${prefix}:records`, lockKey: `${prefix}:lock`, tail: Promise.resolve() });
  }
  async command(...args) {
    // Never put the URL, token or provider text into errors.
    let body;
    try {
      const response = await this.fetchImpl(this.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args.map(String)) });
      body = await response.json();
      if (!response.ok || !body || typeof body !== 'object' || 'error' in body || !('result' in body)) throw new Error();
    } catch { throw new BudgetError('ledger unavailable'); }
    return body.result;
  }
  async exclusive(fn) {
    if (!this.url || !this.token) throw new BudgetError('ledger unavailable');
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const token = randomUUID(), deadline = this.now() + this.lockWaitMs;
      while (await this.command('SET', this.lockKey, token, 'NX', 'PX', this.lockTtlMs) !== 'OK') {
        if (this.now() >= deadline) throw new BudgetError('ledger busy');
        await this.sleep(this.pollMs);
      }
      try { return await fn(); }
      finally { await this.command('EVAL', UNLOCK, 1, this.lockKey, token); }
    } finally { release(); }
  }
  async read() {
    const items = await this.command('LRANGE', this.list, 0, -1);
    if (!Array.isArray(items)) throw new BudgetError('invalid ledger');
    try { return validateRecords(items.map(item => JSON.parse(item))); }
    catch { throw new BudgetError('invalid ledger'); }
  }
  async append(record) {
    validateRecords([record]);
    await this.command('RPUSH', this.list, JSON.stringify(record));
  }
}
export function promptTokens(request) { return Math.ceil(JSON.stringify(request).length / 3); }
export function callCost(model, input, output, cached = 0) {
  const p = PRICES[model];
  if (!p) throw new BudgetError('unknown model');
  return ((input - cached) * p.input + cached * (p.cached ?? p.input) + output * p.output) / 1e6;
}
export function measuredCost(request, result) {
  const u = result.usage;
  if (u && Number.isInteger(u.prompt_tokens) && u.prompt_tokens >= 0 &&
      Number.isInteger(u.completion_tokens) && u.completion_tokens >= 0) {
    const cached = u.prompt_tokens_details?.cached_tokens;
    return { amount: callCost(request.model, u.prompt_tokens, u.completion_tokens,
      Number.isInteger(cached) && cached >= 0 && cached <= u.prompt_tokens ? cached : 0), estimated: false };
  }
  return { amount: callCost(request.model, promptTokens(request), Math.ceil(result.content.length / 3)), estimated: true };
}
export function remaining(records, { session, lane, day, creditsUSD = 0 }) {
  if (!Number.isFinite(creditsUSD) || creditsUSD <= 0) throw new BudgetError('granted credits not configured');
  let period;
  if (day >= '2026-10-23' && day <= '2026-10-30') period = { cap: 5,
    records: records.filter(r => r.app === 'pw' && r.day >= '2026-10-23' && r.day <= '2026-10-30') };
  else if (day >= '2026-10-31' && day <= '2026-11-30') period = { cap: 0.10,
    records: records.filter(r => r.app === 'pw' && r.day === day) };
  else if (day >= '2026-12-01' && day <= '2026-12-16') period = { cap: lane === 'judge' ? 0.40 : 0.15,
    records: records.filter(r => r.app === 'pw' && r.day === day && r.lane === lane) };
  else throw new BudgetError('outside allowed dates');
  return Math.max(0, Math.min(0.08 - sum(records.filter(r => r.app === 'pw' && r.session === session)),
    period.cap - sum(period.records), 45 - sum(records), creditsUSD - sum(records)));
}
export class BudgetClient {
  constructor(client, { ledger, session, lane, stage, now = () => new Date(), creditsUSD = 0 }) {
    Object.assign(this, { client, ledger, session, lane, stage, now, creditsUSD });
    this.cost = 0;
    this.estimated = false;
  }
  async complete(request) {
    return this.ledger.exclusive(async () => {
      const records = await this.ledger.read();
      const day = jstDay(this.now());
      const available = remaining(records, { ...this, day });
      const perAttempt = callCost(request.model, promptTokens(request), request.maxTokens);
      const maxAttempts = (this.client.maxRetries ?? 0) + 1;
      const worst = perAttempt * maxAttempts;
      if (!Number.isFinite(worst) || worst < 0 || worst > available + 1e-12) throw new BudgetError('limit');
      // The lock spans admission, HTTP/retries, and durable recording. A failed request
      // is conservatively charged at its admission estimate, since billing is unknown.
      let result;
      try { result = await this.client.complete(request); }
      catch (error) {
        const amount = perAttempt * Math.min(maxAttempts, Math.max(1, error.attempts ?? maxAttempts));
        await this.ledger.append({ app: 'pw', lane: this.lane, day, amount,
          session: this.session, stage: this.stage, estimated: true, failed: true });
        this.cost += amount;
        this.estimated = true;
        throw error;
      }
      const charge = measuredCost(request, result);
      if (result.attempts > 1) {
        charge.amount += perAttempt * (result.attempts - 1);
        charge.estimated = true;
      }
      await this.ledger.append({ app: 'pw', lane: this.lane, day, ...charge, session: this.session, stage: this.stage });
      this.cost += charge.amount;
      this.estimated ||= charge.estimated;
      return result;
    });
  }
}
