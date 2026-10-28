import { splitCSVLine } from '@entry';
import { test, expect } from '@patchwitness/harness';

test('ordinary fields', () => { expect(splitCSVLine('pear,plum')).toEqual(['pear', 'plum']); });
test('empty trailing field', () => { expect(splitCSVLine('pear,')).toEqual(['pear', '']); });
test('empty line', () => { expect(splitCSVLine('')).toEqual(['']); });
