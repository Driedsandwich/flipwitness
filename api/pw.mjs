// Vercel Function for POST /api/pw. Vercel's Node.js runtime accepts a named HTTP-method
// export taking a Web Request (https://vercel.com/docs/functions/runtimes/node-js).
import { handlePOST } from '../server/serverless.mjs';
import { createRuntime } from '../server/runtime.mjs';

const handler = createRuntime(process.env);

export function POST(request) {
  return handlePOST(request, { handler });
}
