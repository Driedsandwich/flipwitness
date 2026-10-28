import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { createRenderer, sampleCost } from '../web/render.mjs';

const web = new URL('../web/', import.meta.url);
const html = await readFile(new URL('index.html', web), 'utf8');

test('web HTML and modules embed no absolute HTTP URLs outside visible HTML text', async () => {
  const files = (await readdir(web)).filter(name => /\.(html|mjs)$/.test(name));
  assert.ok(files.length >= 5);
  for (const name of files) {
    const source = await readFile(new URL(name, web), 'utf8');
    // Visible HTML prose may mention a URL. Tags, attributes, comments, styles,
    // scripts and module source must stay origin-independent.
    const executable = name.endsWith('.html')
      ? [...source.matchAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<[^>]*>/gi)].map(match => match[0]).join('\n')
      : source;
    assert.doesNotMatch(executable, /https?:\/\//i, name);
    assert.doesNotMatch(executable, /(?:127\.0\.0\.1|localhost)/i, `${name} hard-codes a host`);
  }
});

test('index assets are relative, exist locally, and required IDs are unique', async () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const assets = [...html.matchAll(/<(?:script|link|img|source)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  assert.ok(assets.includes('./app.mjs'));
  for (const path of assets) {
    assert.match(path, /^\.\.?\//, path);
    await access(new URL(path, web));
  }
  for (const file of ['app.mjs', 'render.mjs']) {
    const source = await readFile(new URL(file, web), 'utf8');
    for (const [, id] of source.matchAll(/element\('([^']+)'\)/g)) assert.ok(ids.includes(id), `${file} references missing #${id}`);
  }
});

// An element-only test double exercises rendering/data wiring without a browser
// or third-party DOM. It cannot establish layout or browser compatibility.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.value = ''; }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.value = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}
function fixture() {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element('div')]));
  const document = { createElement: tag => new Element(tag), querySelector: selector => elements.get(selector.slice(1)) };
  return { view: createRenderer(document), get: id => elements.get(id) };
}
const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);

test('shared renderer shows all six sample/patch verdicts, counts, rounds and before/after rows', async () => {
  const { view, get } = fixture();
  for (const sample of ['month-end', 'name-check', 'csv-line']) {
    // Fixed verdicts come from the scripted fixtures; recorded live samples are checked below.
    const data = JSON.parse(await readFile(new URL(`./fixtures/precomputed_mock/${sample}.json`, import.meta.url), 'utf8'));
    for (const patch of ['good', 'incomplete']) {
      const result = data.patches[patch], card = result.rounds.at(-1).card;
      view.precomputed(result);
      assert.equal(get('verdict').textContent, patch === 'good' ? 'supported' : 'patch_suspect');
      assert.equal(get('precomputed').dataset.verdict, card.verdict);
      assert.equal(get('results').children.length, card.tests.length);
      assert.deepEqual(get('counts').children.map(count => count.children[0].textContent),
        [card.summary.witnesses, card.summary.passesBoth, card.summary.failsAfter, card.summary.errors].map(String));
      for (const [index, row] of get('results').children.entries()) {
        const item = card.tests[index];
        assert.equal(row.children[0].textContent, item.name);
        for (const [column, status] of [[1, item.before], [2, item.after]]) {
          assert.ok(row.children[column].textContent.includes(status.status.toUpperCase()));
          if (status.message) assert.ok(row.children[column].textContent.includes(status.message));
        }
      }
      assert.equal(get('rounds').children.length, result.rounds.length);
      assert.equal(get('tests').textContent, result.rounds.at(-1).tests_source);
      assert.ok(get('extraction').textContent.includes(result.extraction.expected));
      assert.ok(get('extraction').textContent.includes(result.extraction.actual));
      assert.ok(get('hypotheses').textContent.includes(result.hypotheses[0].statement));
      assert.equal(get('cost').textContent, sampleCost);
      if (sample === 'month-end') {
        assert.ok(get('rounds').children[0].textContent.includes('no_evidence'));
        assert.ok(get('rounds').children[1].textContent.includes('rewrite 1'));
      }
    }
  }
});

test('renderer preserves untrusted text, diff signs, messages and inconclusive results', () => {
  const { view, get } = fixture();
  const payload = '<img src=x onerror=alert(1)>';
  view.input({ moduleFiles: { 'a.mjs': payload }, bug_report: payload, patch: '@@ -1 +1 @@\n-old\n+new' });
  assert.ok(get('source').textContent.includes(payload));
  assert.equal(get('report').textContent, payload);
  const lines = get('diff').children;
  assert.equal(lines[1].className.trim(), 'code-line removed');
  assert.equal(lines[2].className.trim(), 'code-line added');
  assert.ok(lines[1].textContent.includes('-old'));
  assert.ok(lines[2].textContent.includes('+new'));
  view.evidence({ verdict: 'no_evidence', summary: { witnesses: 0, passesBoth: 0, failsAfter: 0, errors: 1 },
    tests: [{ name: payload, before: { status: 'error', message: payload }, after: { status: 'timeout', message: 'deadline' }, classification: 'errors' }] });
  assert.equal(get('verdict').textContent, 'no_evidence');
  assert.ok(get('results').textContent.includes('Inconclusive'));
  assert.ok(get('results').textContent.includes(payload));
  assert.ok(descendants(get('results')).every(item => item.tagName !== 'img'));
  view.reset();
  assert.equal(get('results').children.length, 0);
  assert.equal(get('rounds').children.length, 0);
  assert.equal(get('verdict').textContent, 'Not run yet');
  assert.equal(get('precomputed').dataset.verdict, undefined);
});

test('shipped sample results render the verdict recorded in their last round', async () => {
  const { view, get } = fixture();
  for (const sample of ['month-end', 'name-check', 'csv-line']) {
    const data = JSON.parse(await readFile(new URL(`../samples/${sample}/precomputed.json`, import.meta.url), 'utf8'));
    assert.ok(['mock', 'live'].includes(data.source)); assert.equal(data.cost, 0);
    for (const patch of ['good', 'incomplete']) {
      const card = data.patches[patch].rounds.at(-1).card;
      view.precomputed(data.patches[patch], data);
      assert.equal(get('verdict').textContent, card.verdict);
      if (data.source === 'live') assert.match(get('status').textContent, /Recorded live model run/);
      assert.equal(get('results').children.length, card.tests.length);
    }
  }
});
