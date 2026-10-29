import { createServer } from 'node:http';
import { createRuntime } from './server/runtime.mjs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional local preview; never opens a browser automatically.
const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.json': 'application/json', '.md': 'text/plain', '.diff': 'text/plain' };
export function createLocalServer({ handleAPI = createRuntime() } = {}) {
  return createServer(async (request, response) => {
    try {
      if (request.url === '/api/pw' && request.method === 'POST') {
        let size = 0;
        const chunks = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 64000) { response.writeHead(413, { 'Content-Type': 'application/json' }).end('{"error":"too_large"}'); return; }
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { response.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"bad_request"}'); return; }
        const result = await handleAPI(input);
        response.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result.body));
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      // The page loads its modules with relative URLs, so serve it from /web/, not from /.
      if (path === '/') { response.writeHead(302, { Location: '/web/index.html' }).end(); return; }
      if (path !== '/' && !/^\/(web|core|samples)\//.test(path)) { response.writeHead(404).end(); return; }
      const target = await realpath(resolve(root, '.' + (path === '/' ? '/web/index.html' : path)));
      const local = relative(root, target);
      if (local === '..' || local.startsWith(`..${sep}`) || local.split(sep).some(part => part.startsWith('.')) || !['web', 'core', 'samples'].includes(local.split(sep)[0])) {
        response.writeHead(403).end(); return;
      }
      if (!(await stat(target)).isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': `${types[extname(target)] ?? 'text/plain'}; charset=utf-8`, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : await readFile(target));
    } catch { response.writeHead(404).end(); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createLocalServer();
  server.listen(4173, '127.0.0.1', () => console.log('FlipWitness: http://127.0.0.1:4173'));
  server.on('error', () => { console.error('Local server could not start'); process.exitCode = 1; });
}
