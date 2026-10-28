// Only assertions are failures. Runtime/setup errors and timeouts are inconclusive.
export function classify(before, after) {
  if (!before || !after) return 'errors';
  if (after.status === 'fail') return 'fails_after';
  const assertionBefore = before.status === 'fail' ||
    (before.status === 'error' && /^AssertionError:/.test(before.message ?? ''));
  if (after.status === 'pass' && assertionBefore) return 'witness';
  if (before.status === 'pass' && after.status === 'pass') return 'passes_both';
  return 'errors';
}

export function summarise(pairs) {
  const summary = { witnesses: 0, passesBoth: 0, failsAfter: 0, errors: 0 };
  const keys = { witness: 'witnesses', passes_both: 'passesBoth', fails_after: 'failsAfter', errors: 'errors' };
  for (const { before, after } of pairs) summary[keys[classify(before, after)]]++;
  return summary;
}
