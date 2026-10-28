import { applyUnifiedDiff } from '../core/patch.mjs';
import { runSuite } from '../core/runner.browser.mjs';
import { buildEvidenceCard } from '../core/evidence.mjs';
import { runModelFlow } from './flow.mjs';
import { createRenderer, usd } from './render.mjs';

const element = id => document.getElementById(id);
const view = createRenderer(document);
const choice = name => document.querySelector(`input[name="${name}"]:checked`).value;
let loaded, precomputed, busy = false, revision = 0, mode = 'sample';
const pasted = () => mode === 'paste';
function controls() {
  for (const control of document.querySelectorAll('button, input, textarea')) control.disabled = busy;
  for (const id of ['generate', 'live']) element(id).disabled = busy || (!pasted() && !loaded);
  for (const control of document.querySelectorAll('#sample input, #patch input')) control.disabled = busy || pasted();
  element('run').disabled = busy || pasted() || !loaded;
  element('run').hidden = pasted();
  element('live').hidden = pasted();
  element('generate').textContent = pasted() ? 'Generate tests with Nemotron' : 'View sample result';
  element('generate').setAttribute('aria-describedby', 'action-help');
  element('sample-form').hidden = pasted();
  element('paste-form').hidden = !pasted();
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const active = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
  }
  element('action-help').textContent = pasted()
    ? 'Generating tests calls the live API and requires configured access and credits.'
    : 'Samples show recorded results for $0. Run live calls the API. Golden tests are hand-written and run locally.';
  // Keep the progress live region outside the busy input panels.
  for (const id of ['sample-form', 'paste-form']) element(id).setAttribute('aria-busy', String(busy));
}
async function text(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cannot load sample (${response.status})`);
  return response.text();
}
function showPrecomputed() {
  if (precomputed) view.precomputed(precomputed.patches[choice('patch')], precomputed);
}
async function load() {
  const current = ++revision;
  loaded = precomputed = undefined;
  controls();
  view.reset();
  element('status').textContent = 'Loading sample…';
  try {
    const root = new URL(`../samples/${choice('sample')}/`, import.meta.url);
    const manifest = JSON.parse(await text(new URL('sample.json', root)));
    const [files, report, diff, testSource, pre] = await Promise.all([
      Promise.all(manifest.files.map(async path => [path, await text(new URL(path, root))])),
      text(new URL('bug_report.md', root)), text(new URL(`patch_${choice('patch')}.diff`, root)),
      text(new URL('golden_witness.test.mjs', root)), text(new URL('precomputed.json', root)),
    ]);
    if (current !== revision) return;
    loaded = { entry: manifest.entry, moduleFiles: Object.fromEntries(files), patch: diff, bug_report: report, testSource };
    precomputed = JSON.parse(pre);
    view.input(loaded);
    showPrecomputed();
  } catch (error) { if (current === revision) element('status').textContent = error.message; }
  finally { if (current === revision) controls(); }
}
function pasteInput() {
  let moduleFiles;
  try { moduleFiles = JSON.parse(element('paste-files').value); } catch { throw new Error('Files must be a JSON object mapping file paths to source strings.'); }
  if (!moduleFiles || Array.isArray(moduleFiles) || typeof moduleFiles !== 'object' ||
      !Object.keys(moduleFiles).length || Object.keys(moduleFiles).length > 20 ||
      Object.values(moduleFiles).some(source => typeof source !== 'string')) throw new Error('Provide 1–20 module files.');
  if (Object.values(moduleFiles).reduce((size, source) => size + new TextEncoder().encode(source).length, 0) > 12000) throw new Error('Module files exceed 12 KB.');
  const input = { moduleFiles, entry: element('paste-entry').value, bug_report: element('paste-report').value, patch: element('paste-patch').value };
  if (!Object.hasOwn(moduleFiles, input.entry)) throw new Error('Entry must name one of the files.');
  if (!input.bug_report.trim() || input.bug_report.length > 4000) throw new Error('Provide a bug report up to 4,000 characters.');
  if (new TextEncoder().encode(input.patch).length > 16000) throw new Error('Patch exceeds 16 KB.');
  return input;
}
async function live() {
  if (busy) return;
  busy = true; controls(); view.reset();
  element('status').textContent = 'Extracting the report with Nemotron Nano…';
  element('pipeline-note').textContent = 'Live API · NVIDIA Nemotron via Nebius Token Factory.';
  element('execution-note').textContent = 'Candidate tests run on both versions in your browser Web Workers.';
  try {
    const input = pasted() ? pasteInput() : loaded;
    view.input(input);
    await runModelFlow({ input, runSuite,
      callStage: async request => {
        const passphrase = element('passphrase').value;
        const response = await fetch('/api/pw', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, ...(passphrase ? { passphrase } : {}) }) });
        const body = await response.json();
        if (response.ok) {
          if (request.stage === 'extract') view.extraction(body);
          if (request.stage === 'hypothesize') view.hypotheses(body.hypotheses);
        }
        return { status: response.status, body };
      },
      onStep: (step, state) => {
        view.step(step, state.cost);
        element('status').textContent = step.stage === 'extract' ? 'Hypothesizing the root cause with Nemotron Ultra…'
          : step.stage === 'hypothesize' ? 'Writing candidate tests with Nemotron Super…'
            : 'Running candidate tests before and after the patch in browser Web Workers…';
      },
      onRound: round => { view.round(round); element('status').textContent = `Round ${round.round}: ${round.card.verdict}.`; },
    });
    element('status').textContent = 'Finished. All candidate tests ran in browser Web Workers. At most three rewrites were requested.';
  } catch (error) {
    element('status').textContent = error.code === 'budget' ? 'Budget refused. This live run cannot continue within the configured allowance. Return to the free sample results below.' : error.message;
    element('precomputed-link').hidden = false;
    if (error.cost !== undefined) element('cost').textContent = `Session cost ${usd(error.cost)} · live API`;
  } finally { busy = false; controls(); }
}
element('live').addEventListener('click', live);
element('generate').addEventListener('click', () => pasted() ? live() : showPrecomputed());
element('precomputed-link').addEventListener('click', async event => {
  event.preventDefault();
  if (busy) return;
  mode = 'sample'; await load();
  element('precomputed').scrollIntoView({ block: 'start' });
  element('evidence-title').focus({ preventScroll: true });
});
element('run').addEventListener('click', async () => {
  if (!loaded || busy) return;
  busy = true; controls(); view.reset();
  element('status').textContent = 'Running hand-written golden tests in Web Workers…';
  element('cost').textContent = 'Session cost $0 — hand-written golden tests, run locally';
  element('pipeline-note').textContent = 'Golden test run · no model stages were called.';
  element('extraction').textContent = 'Not used for hand-written golden tests.';
  element('hypotheses').textContent = 'Not used for hand-written golden tests.';
  element('execution-note').textContent = 'Hand-written tests run before and after the patch in your browser Web Workers.';
  element('rewrite-note').textContent = 'Golden tests are hand-written. No model rewrites are requested.';
  try {
    const options = { entry: loaded.entry, testSource: loaded.testSource, timeoutMs: 1500 };
    const before = await runSuite({ ...options, moduleFiles: loaded.moduleFiles });
    const after = await runSuite({ ...options, moduleFiles: applyUnifiedDiff(loaded.moduleFiles, loaded.patch) });
    view.evidence(buildEvidenceCard(before, after));
    element('tests').textContent = loaded.testSource;
    element('tests-label').textContent = 'Golden tests (hand-written)';
    element('status').textContent = 'Golden tests finished. Cost $0.';
  } catch (error) { element('status').textContent = error.message; }
  finally { busy = false; controls(); }
});
function setMode(value) {
  if (busy || mode === value) return;
  mode = value; revision++;
  controls();
  if (pasted()) {
    view.reset();
    for (const id of ['source', 'diff']) element(id).replaceChildren();
    element('report').textContent = 'Your bug report will appear here when you generate tests.';
    element('pipeline-note').textContent = 'Live API · generation starts only when you select Generate tests with Nemotron.';
    element('execution-note').textContent = 'Generated tests will run before and after the patch in your browser Web Workers.';
    element('status').textContent = 'Paste code, a report and a patch, then generate tests. Live API access and credits must be configured.';
    element('cost').textContent = 'Session cost $0 — live run not started';
  } else load();
}
const tabs = [...document.querySelectorAll('[role="tab"]')];
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[1 - index];
    next.focus(); setMode(next.dataset.mode);
  });
}
element('sample').addEventListener('change', load);
element('patch').addEventListener('change', load);
load();
