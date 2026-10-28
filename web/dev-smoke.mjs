// Browser smoke check for the Web Worker runner: sample verdicts and isolation probes.
// A probe that ends as `pass` means the worker reached something it should not.
import { applyUnifiedDiff } from '../core/patch.mjs';
import { runSuite } from '../core/runner.browser.mjs';
import { buildEvidenceCard } from '../core/evidence.mjs';
import { createRenderer } from './render.mjs';

const text = async url => { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.text(); };
const head = "import { test, expect } from '@patchwitness/harness';\n";
// Compute URLs in the main thread, then embed them as quoted test data.
const target = new URL('/web/index.html', location.origin);
const targetLiteral = JSON.stringify(target.href);
const importTarget = JSON.stringify(new URL('/core/patch.mjs', location.origin).href);
const socketTarget = new URL(target);
socketTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const probes = {
  direct_fetch: `await fetch(${targetLiteral});`,
  bracket_fetch: `await globalThis['fe' + 'tch'](${targetLiteral});`,
  escaped_fetch: `await \\u0066etch(${targetLiteral});`,
  prototype_fetch: `const f = Object.getPrototypeOf(globalThis).fetch; await f.call(globalThis, ${targetLiteral});`,
  delete_then_fetch: `delete globalThis.fetch; await fetch(${targetLiteral});`,
  xhr: `const x = new XMLHttpRequest(); x.open('GET', ${targetLiteral}, false); x.send();`,
  websocket: `new WebSocket(${JSON.stringify(socketTarget.href)});`,
  event_source: `new EventSource(${targetLiteral});`,
  nested_worker: "new Worker(URL.createObjectURL(new Blob(['1'])));",
  dynamic_import: `await import(${importTarget});`,
  prototype_fetch_absolute: `const f = Object.getPrototypeOf(globalThis).fetch; await f.call(globalThis, ${targetLiteral});`,
  prototype_post_message: "Object.getPrototypeOf(globalThis).postMessage.call(globalThis, { type: 'result', name: 'forged', status: 'pass' });",
  prototype_chain_xhr: `let o = globalThis, C; while (o && !C) { C = Object.getOwnPropertyDescriptor(o, 'XMLHttpRequest')?.value; o = Object.getPrototypeOf(o); } C = Object.getPrototypeOf(globalThis).XMLHttpRequest ?? C; const x = new C(); x.open('GET', ${targetLiteral}, false); x.send();`,
};

async function main() {
  const out = {};
  const markup = new DOMParser().parseFromString(await text(target), 'text/html');
  document.head.append(document.importNode(markup.querySelector('style'), true));
  const preview = document.createElement('details');
  const title = document.createElement('summary');
  title.textContent = 'Last rendered sample (shared app renderer, no live calls)';
  const fixture = document.createElement('div'); fixture.className = 'shell';
  fixture.append(document.importNode(markup.querySelector('#workspace'), true));
  preview.append(title, fixture); document.body.append(preview);
  const view = createRenderer(fixture);
  for (const sample of ['month-end', 'name-check', 'csv-line']) {
    const base = `../samples/${sample}/`;
    const manifest = JSON.parse(await text(base + 'sample.json'));
    const files = {};
    for (const path of manifest.files) files[path] = await text(base + path);
    const tests = await text(base + 'golden_witness.test.mjs');
    const precomputed = JSON.parse(await text(base + 'precomputed.json'));
    for (const kind of ['good', 'incomplete']) {
      const patch = await text(base + `patch_${kind}.diff`);
      view.input({ moduleFiles: files, bug_report: await text(base + 'bug_report.md'), patch });
      view.precomputed(precomputed.patches[kind], precomputed);
      const verdictShown = fixture.querySelector('#verdict').textContent;
      const tableRows = fixture.querySelector('#results').rows.length;
      const expected = precomputed.patches[kind].rounds.at(-1).card;
      out[`render/${sample}/${kind}`] = {
        verdictShown, evidenceTableRendered: tableRows > 0, tableRows,
        matchesExpected: verdictShown === expected.verdict && tableRows === expected.tests.length,
      };
      const patched = applyUnifiedDiff(files, patch);
      const before = await runSuite({ moduleFiles: files, entry: manifest.entry, testSource: tests, timeoutMs: 3000 });
      const after = await runSuite({ moduleFiles: patched, entry: manifest.entry, testSource: tests, timeoutMs: 3000 });
      out[`${sample}/${kind}`] = buildEvidenceCard(before, after).verdict;
    }
  }
  const files = { 'src/m.mjs': 'export const one = 1;' };
  for (const [name, body] of Object.entries(probes)) {
    const source = head + `test('${name}', async () => { ${body} expect(1).toBe(1); });`;
    const results = await runSuite({ moduleFiles: files, entry: 'src/m.mjs', testSource: source, timeoutMs: 2000 });
    out['probe/' + name] = results.map(r => `${r.status}: ${String(r.message ?? '').slice(0, 80)}`).join(' / ');
  }
  const started = performance.now();
  const loop = await runSuite({ moduleFiles: files, entry: 'src/m.mjs', timeoutMs: 500,
    testSource: head + "test('loop', () => { for (;;) {} });" });
  out['probe/infinite_loop'] = loop.map(r => r.status).join(',') + ` in ${Math.round(performance.now() - started)} ms`;
  return out;
}
main().then(out => { document.getElementById('out').textContent = JSON.stringify(out, null, 1); },
  error => { document.getElementById('out').textContent = 'SMOKE_ERROR ' + error.stack; });
