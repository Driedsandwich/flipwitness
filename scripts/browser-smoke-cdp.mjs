// Usage: start 'node serve.mjs' and a headless Chrome with --remote-debugging-port=<port>, then
//   node scripts/browser-smoke-cdp.mjs <port> http://127.0.0.1:4173/web/dev-smoke.html
// Drive a headless Chrome over CDP until the smoke page writes its result.
const port = process.argv[2], url = process.argv[3];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Page.navigate', { url });
let text = 'pending';
for (let i = 0; i < 120 && text === 'pending'; i++) {
  await sleep(250);
  const r = await send('Runtime.evaluate', { expression: "document.getElementById('out')?.textContent ?? 'pending'", returnByValue: true });
  text = r.result?.result?.value ?? 'pending';
}
console.log(text);
ws.close();
