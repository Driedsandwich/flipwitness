import { periodEnd } from '@entry';
import { test, expect } from '@patchwitness/harness';

test('ordinary monthly period', () => {
  expect(periodEnd('2025-01-15')).toBe('2025-02-15');
});
test('year rollover', () => {
  expect(periodEnd('2025-12-10')).toBe('2026-01-10');
});
