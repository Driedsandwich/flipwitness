import { BASE_URL } from './models.mjs';

export class UpstreamError extends Error {
  constructor(status = 0, attempts = 1) {
    super(status ? `Upstream request failed (HTTP ${status})` : 'Upstream request failed');
    this.name = 'UpstreamError';
    this.code = 'upstream_error';
    this.status = status;
    this.attempts = attempts;
  }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function usageFields(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const safe = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
    .filter(name => Number.isSafeInteger(usage[name]) && usage[name] >= 0).map(name => [name, usage[name]]));
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (Number.isSafeInteger(cached) && cached >= 0) safe.prompt_tokens_details = { cached_tokens: cached };
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (Number.isSafeInteger(reasoning) && reasoning >= 0) safe.completion_tokens_details = { reasoning_tokens: reasoning };
  return safe;
}
const rateNames = ['x-ratelimit-remaining-requests', 'x-ratelimit-remaining-tokens', 'x-ratelimit-over-limit'];

export class HttpChatClient {
  constructor({ baseURL = BASE_URL, env = process.env, fetchImpl = fetch, maxRetries = 2,
    totalTimeoutMs = 8000, sleep = delay, now = Date.now } = {}) {
    this.url = new URL('chat/completions', baseURL.endsWith('/') ? baseURL : baseURL + '/');
    Object.assign(this, { env, fetchImpl, maxRetries, totalTimeoutMs, sleep, now });
  }
  async complete({ model, messages, responseFormat, maxTokens, temperature = 0.2 }) {
    // Read the key at call time. Never retain response bodies or transport errors in exceptions.
    const key = this.env.NEBIUS_API_KEY;
    if (typeof key !== 'string' || !key) throw new UpstreamError();
    const body = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature,
      ...(responseFormat ? { response_format: responseFormat } : {}) });
    const deadline = this.now() + this.totalTimeoutMs;
    const signal = AbortSignal.timeout(this.totalTimeoutMs);
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(this.url, { method: 'POST', signal, redirect: 'error',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
      } catch { throw new UpstreamError(0, attempt + 1); }
      if (response.ok) {
        let data;
        try { data = await response.json(); } catch { throw new UpstreamError(response.status, attempt + 1); }
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length > 100_000) throw new UpstreamError(response.status, attempt + 1);
        // reasoning_content is deliberately ignored. Never expose provider diagnostics.
        const safe = value => {
          for (const secret of [key, this.env.PW_JUDGE_PASSPHRASE]) {
            if (typeof secret === 'string' && secret) value = value.replaceAll(secret, '[redacted]');
          }
          return value;
        };
        const rateHeaders = Object.fromEntries(rateNames.flatMap(name => {
          const value = response.headers.get(name);
          return value === null ? [] : [[name, safe(value).slice(0, 200)]];
        }));
        return { content: safe(content), usage: usageFields(data.usage), model, rateHeaders, attempts: attempt + 1,
          finishReason: typeof data.choices[0].finish_reason === 'string' ? data.choices[0].finish_reason.slice(0, 40) : null };
      }
      try { await response.body?.cancel(); }
      catch { throw new UpstreamError(response.status, attempt + 1); }
      if (attempt >= this.maxRetries || (response.status !== 429 && (response.status < 500 || response.status > 599))) {
        throw new UpstreamError(response.status, attempt + 1);
      }
      const retry = response.headers.get('retry-after');
      const seconds = retry === null || retry.trim() === '' ? NaN : Number(retry);
      const wait = retry === null ? 100 * 2 ** attempt
        : Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
          : Math.max(0, Date.parse(retry) - this.now());
      const waitMs = Number.isFinite(wait) ? wait : 100 * 2 ** attempt;
      if (this.now() + waitMs >= deadline || signal.aborted) throw new UpstreamError(response.status, attempt + 1);
      await this.sleep(waitMs);
      if (this.now() >= deadline || signal.aborted) throw new UpstreamError(response.status, attempt + 1);
    }
  }
}

export class MockChatClient {
  constructor(script) { this.script = structuredClone(script); this.requests = []; }
  async complete(request) {
    this.requests.push(structuredClone(request));
    const next = this.script.shift();
    if (!next) throw new UpstreamError();
    if (next.error) throw new UpstreamError(next.status);
    if (next.model && next.model !== request.model) throw new UpstreamError();
    return { content: typeof next.content === 'string' ? next.content : JSON.stringify(next.content),
      model: request.model, usage: next.usage, rateHeaders: next.rateHeaders ?? {} };
  }
}
