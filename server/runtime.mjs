import { FileLedger, RedisLedger, defaultLedgerPath, redisConfigured } from './budget.mjs';
import { HttpChatClient } from './llm.mjs';
import { handle } from './api.mjs';

export function createRuntime(env = process.env) {
  // Serverless instances share no files: on Vercel only the Redis ledger may admit live calls.
  const shared = redisConfigured(env);
  const deps = { ledger: shared ? new RedisLedger({ env }) : new FileLedger(defaultLedgerPath(env)), client: new HttpChatClient({
    // Live calls took up to 30.5 s (2026-10-24); keep this under the platform's function limit.
    baseURL: env.PW_BASE_URL, env, totalTimeoutMs: 55_000,
  }) };
  return request => {
    // No key is required for precomputed viewing. Live is explicitly opt-in.
    if (env.PW_LIVE !== '1' || (env.VERCEL && !shared)) return Promise.resolve({ status: 429, body: { error: 'budget',
      message: 'Live calls are disabled. Use the precomputed results (cost $0).' } });
    return handle(request, env, deps);
  };
}
