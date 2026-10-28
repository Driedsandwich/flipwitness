import { isValidName } from '@entry';
import { test, expect } from '@patchwitness/harness';

test('spaces alone are rejected', () => { expect(isValidName('  ')).toBe(false); });
test('tabs and newlines alone are rejected', () => { expect(isValidName('\t\n')).toBe(false); });
test('surrounding whitespace preserves a name', () => { expect(isValidName('  Mira\t')).toBe(true); });
