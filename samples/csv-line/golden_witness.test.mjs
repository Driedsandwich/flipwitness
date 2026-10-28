import { splitCSVLine } from '@entry';
import { test, expect } from '@patchwitness/harness';

test('quoted comma belongs to one field', () => {
  expect(splitCSVLine('pear,"red, green",plum')).toEqual(['pear', 'red, green', 'plum']);
});
test('doubled quote becomes a literal quote', () => {
  expect(splitCSVLine('"say ""hi"", now",tail')).toEqual(['say "hi", now', 'tail']);
});
test('quoted empty field and trailing empty field', () => {
  expect(splitCSVLine('"",')).toEqual(['', '']);
});
