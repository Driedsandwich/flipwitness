// Shared by the app and the reviewer smoke page. Model/code content stays text.
export const sampleCost = 'Session cost $0 — sample result (scripted, not a live model run)';
export const recordedCost = 'Session cost $0 — recorded live run (NVIDIA Nemotron via Nebius Token Factory)';
export const usd = amount => `$${amount.toFixed(6)}`;
const verdicts = {
  supported: ['✓', 'A test failed before the patch and passed after it. This patch has a witness.'],
  patch_suspect: ['!', 'At least one assertion still fails after the patch. Inspect it, even if other tests are witnesses.'],
  no_evidence: ['○', 'No test establishes a witness. Passing both versions does not demonstrate the bug was fixed.'],
};
const classifications = { witness: 'Witness', passes_both: 'Pass both', fails_after: 'Fail after', errors: 'Inconclusive' };

export function createRenderer(root) {
  const doc = root.ownerDocument ?? root;
  const element = id => root.querySelector(`#${id}`);
  const node = (tag, text, className) => {
    const item = doc.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  function code(pre, source, diff = false) {
    let before = 0, after = 0;
    pre.replaceChildren(...source.split('\n').map((text, index) => {
      const hunk = diff && text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      let number = String(index + 1), tone = '';
      if (diff) {
        number = '';
        if (hunk) { before = Number(hunk[1]); after = Number(hunk[2]); }
        else if (text.startsWith('---') || text.startsWith('+++') || text.startsWith('\\')) { /* diff metadata */ }
        else if (text.startsWith('-')) { number = `${before++} /`; tone = 'removed'; }
        else if (text.startsWith('+')) { number = `/ ${after++}`; tone = 'added'; }
        else if (text.startsWith(' ')) number = `${before++}/${after++}`;
      }
      const line = node('span', undefined, `code-line ${tone}`);
      const gutter = node('span', number, 'line-number');
      gutter.setAttribute('aria-hidden', 'true');
      line.append(gutter, node('span', text || ' '));
      return line;
    }));
  }
  function input(value) {
    element('source').replaceChildren();
    for (const [path, text] of Object.entries(value.moduleFiles)) {
      const block = node('span');
      code(block, text);
      element('source').append(node('span', path, 'file-label'), block);
    }
    code(element('diff'), value.patch, true);
    element('report').textContent = value.bug_report;
  }
  function rows(card) {
    return card.tests.map(item => {
      const row = node('tr');
      const name = node('th', item.name); name.scope = 'row'; row.append(name);
      for (const result of [item.before, item.after]) {
        const cell = node('td');
        const icon = result.status === 'pass' ? '✓ ' : result.status === 'fail' ? '✗ ' : '! ';
        cell.append(node('span', icon + result.status.toUpperCase(), `badge ${result.status}`));
        if (result.message) cell.append(node('small', result.message));
        row.append(cell);
      }
      row.append(node('td', classifications[item.classification] ?? item.classification));
      return row;
    });
  }
  function counts(summary) {
    element('counts').replaceChildren(...[
      [summary.witnesses, 'Witnesses'], [summary.passesBoth, 'Pass both'],
      [summary.failsAfter, 'Fail after'], [summary.errors, 'Inconclusive'],
    ].map(([count, label]) => {
      const item = node('div', undefined, 'count');
      item.append(node('strong', String(count)), node('span', label));
      return item;
    }));
  }
  function evidence(card) {
    const [icon, description] = verdicts[card.verdict];
    element('precomputed').dataset.verdict = card.verdict;
    element('verdict').textContent = card.verdict;
    element('verdict-icon').textContent = icon;
    element('verdict-icon').className = card.verdict;
    element('verdict-description').textContent = description;
    counts(card.summary);
    element('results').replaceChildren(...rows(card));
  }
  function extraction(value) {
    const facts = node('dl', undefined, 'facts');
    for (const [label, content] of [
      ['Expected', value.expected], ['Actual', value.actual], ['Reproduce', value.repro_steps],
      ['Inputs', value.inputs], ['Suspected area', value.suspected_area],
    ]) {
      const definition = node('dd');
      if (Array.isArray(content)) {
        const list = node(label === 'Reproduce' ? 'ol' : 'ul');
        list.append(...content.map(text => node('li', text)));
        definition.append(list);
      } else definition.textContent = content ?? 'Not specified';
      facts.append(node('dt', label), definition);
    }
    element('extraction').replaceChildren(facts);
  }
  function hypotheses(values) {
    element('hypotheses').replaceChildren(...values.map(value => {
      const item = node('article', undefined, 'hypothesis');
      item.append(node('h4', `${value.id} · ${value.statement}`),
        node('p', value.file + (value.line_hint ? ` · line ${value.line_hint}` : ''), 'helper'),
        node('p', value.why_patch_addresses_it));
      if (value.edge_cases_to_test.length) {
        item.append(node('p', 'Edge cases to test', 'helper'));
        const list = node('ul'); list.append(...value.edge_cases_to_test.map(text => node('li', text))); item.append(list);
      }
      return item;
    }));
    if (!values.length) element('hypotheses').append(node('p', 'No hypothesis matched a supplied file.', 'helper'));
  }
  // sample: undefined for a live session, 'mock' for scripted fixtures, 'recorded' for a saved live run.
  function step(value, total, sample) {
    const mock = sample === true || sample === 'mock';
    element(`${value.stage}-meta`).append(node('span', `${value.model} · ${mock ? 'Scripted sample · $0'
      : usd(value.cost) + (value.estimated ? ' (estimated)' : '') + (sample === 'recorded' ? ' · recorded run' : '')}`));
    element('cost').textContent = mock ? sampleCost : sample === 'recorded' ? recordedCost : `Session cost ${usd(total)} · live API`;
  }
  function round(value, sample) {
    const mock = sample === true || sample === 'mock';
    const item = node('article', undefined, 'round');
    const title = node('div', undefined, 'round-title');
    title.append(node('h4', value.round === 0 ? 'Round 0 · initial tests' : `Round ${value.round} · rewrite ${value.round}`),
      node('span', `${verdicts[value.card.verdict][0]} ${value.card.verdict}`, `badge ${value.card.verdict}`));
    const s = value.card.summary;
    item.append(title, node('p', `${s.witnesses} witnesses · ${s.passesBoth} pass both · ${s.failsAfter} fail after · ${s.errors} inconclusive`, 'helper'));
    const details = node('details');
    details.append(node('summary', 'Inspect this round: rationale, tests and before/after results'));
    const rationale = node('ul'); rationale.append(...value.rationale.map(text => node('li', text)));
    const pre = node('pre', value.tests_source); pre.tabIndex = 0; pre.setAttribute('aria-label', `Round ${value.round} test source, scrollable`);
    const wrap = node('div', undefined, 'table-wrap'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `Round ${value.round} results, scrollable`);
    const table = node('table'); table.append(node('caption', `Round ${value.round} · ${mock ? '$0 scripted sample' : usd(value.cost) + ' session total' + (sample === 'recorded' ? ' (recorded run)' : '')}`));
    const head = node('thead'), header = node('tr');
    for (const text of ['Test', 'Before', 'After', 'Evidence']) { const th = node('th', text); th.scope = 'col'; header.append(th); }
    head.append(header);
    const body = node('tbody'); body.append(...rows(value.card)); table.append(head, body); wrap.append(table);
    details.append(rationale, pre, wrap); item.append(details); element('rounds').append(item);
    element('tests').textContent = value.tests_source;
    element('tests-label').textContent = `${mock ? 'Scripted candidate' : 'Generated candidate'} tests · round ${value.round}`;
    element('rewrite-note').textContent = s.witnesses > 0
      ? `Stopped after round ${value.round}: a witness was found. Any assertion failing after the patch still makes the patch suspect.`
      : value.round < 3 ? `No witness in round ${value.round}. Results feed into the next rewrite (at most three rewrites).`
        : 'Stopped after three rewrites. No witness was found; this patch has no supporting witness from these tests.';
    evidence(value.card);
  }
  function reset() {
    for (const id of ['extract-meta', 'hypothesize-meta', 'tests-meta', 'rounds', 'results', 'tests']) element(id).replaceChildren();
    element('extraction').replaceChildren(node('p', 'Waiting for report extraction.', 'helper'));
    element('hypotheses').replaceChildren(node('p', 'Waiting for root-cause hypotheses.', 'helper'));
    delete element('precomputed').dataset.verdict;
    element('verdict').textContent = 'Not run yet';
    element('verdict-icon').textContent = '○'; element('verdict-icon').className = '';
    element('verdict-description').textContent = 'Before-and-after results will determine whether a test is a witness.';
    counts({ witnesses: 0, passesBoth: 0, failsAfter: 0, errors: 0 });
    element('cost').textContent = 'Session cost $0';
    element('tests-label').textContent = 'Candidate tests · latest round';
    element('rewrite-note').textContent = 'If no witness is found, results feed into test generation. At most three rewrites.';
    element('precomputed-link').hidden = true;
  }
  function precomputed(result, meta = {}) {
    const sample = meta.source === 'live' ? 'recorded' : 'mock';
    const when = typeof meta.recorded_at === 'string' ? meta.recorded_at.slice(0, 10) : 'an earlier date';
    reset();
    extraction(result.extraction); hypotheses(result.hypotheses);
    for (const value of result.steps) step(value, 0, sample);
    for (const value of result.rounds) round(value, sample);
    element('pipeline-note').textContent = sample === 'recorded'
      ? `NVIDIA Nemotron via Nebius Token Factory · a live run recorded on ${when}. Results vary between runs.`
      : 'NVIDIA Nemotron via Nebius Token Factory · sample stages are scripted fixtures, not live model output.';
    element('execution-note').textContent = 'Saved before/after results are shown below. No tests or models run when you view a sample.';
    element('status').textContent = sample === 'recorded'
      ? `Sample ready. Recorded live model run (${when}); viewing it costs $0.`
      : 'Sample ready. These results are scripted fixtures, not a live model run.';
  }
  return { input, evidence, extraction, hypotheses, step, round, reset, precomputed };
}
