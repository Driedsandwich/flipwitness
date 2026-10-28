import { isValidName } from '@entry';
import { test, expect } from '@patchwitness/harness';

test('ordinary name is accepted', () => { expect(isValidName('Mira')).toBe(true); });
test('empty name is rejected', () => { expect(isValidName('')).toBe(false); });
test('non-string is rejected', () => { expect(isValidName(null)).toBe(false); });
