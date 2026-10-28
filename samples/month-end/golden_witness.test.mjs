import { periodEnd } from '@entry';
import { test, expect } from '@patchwitness/harness';

test('January 31 clamps to February 28', () => {
  expect(periodEnd('2025-01-31')).toBe('2025-02-28');
});
test('leap-year February keeps February 29', () => {
  expect(periodEnd('2024-01-31')).toBe('2024-02-29');
});
test('March 31 clamps to April 30', () => {
  expect(periodEnd('2025-03-31')).toBe('2025-04-30');
});
