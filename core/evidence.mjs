import { classify, summarise } from './classify.mjs';

export function buildEvidenceCard(beforeResults, afterResults) {
  function index(results) {
    const map = new Map();
    for (const result of results) {
      if (map.has(result.name)) throw new Error(`Duplicate result name: ${result.name}`);
      map.set(result.name, result);
    }
    return map;
  }
  const before = index(beforeResults);
  const after = index(afterResults);
  const tests = [...new Set([...before.keys(), ...after.keys()])].map(name => {
    const missing = { name, status: 'error', message: 'Test did not produce a result in this run' };
    const pair = { name, before: before.get(name) ?? missing, after: after.get(name) ?? missing };
    return { ...pair, classification: classify(pair.before, pair.after) };
  });
  const summary = summarise(tests);
  const verdict = summary.failsAfter ? 'patch_suspect' : summary.witnesses ? 'supported' : 'no_evidence';
  return { verdict, summary, tests };
}
