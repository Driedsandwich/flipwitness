import { createRuntime } from './runtime.mjs';

// Web Request -> Web Response adapter, used by api/pw.mjs on Vercel (a `POST(request)` export).
// The shared ledger there is the Redis ledger (server/runtime.mjs); live stays off without it.
export async function handlePOST(request, { env = process.env, handler = createRuntime(env) } = {}) {
  if (request.method !== 'POST') return Response.json({ error: 'bad_request' }, { status: 405 });
  let size = 0, input;
  const chunks = [];
  try {
    for await (const chunk of request.body ?? []) {
      size += chunk.byteLength;
      if (size > 64000) return Response.json({ error: 'too_large' }, { status: 413 });
      chunks.push(Buffer.from(chunk));
    }
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return Response.json({ error: 'bad_request' }, { status: 400 }); }
  try {
    const result = await handler(input);
    return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'upstream_error' }, { status: 502 }); }
}
