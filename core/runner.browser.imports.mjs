// A deliberately small static-import scanner, not a JavaScript parser.
// Interpolated templates and escaped module specifiers are rejected conservatively.
export function rewriteImports(source, resolve) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const start = i;
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unclosed comment');
      i = end + 2; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i++;
      while (i < source.length && source[i] !== ch) {
        if (ch === '`' && source.startsWith('${', i)) throw new Error('Browser runner does not support interpolated templates');
        if (source[i] === '\\') i++;
        i++;
      }
      if (i >= source.length) throw new Error('Unclosed string');
      i++;
      tokens.push({ type: 'string', value: source.slice(start + 1, i - 1), start, end: i });
    } else if (/[A-Za-z_$]/.test(ch)) {
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      tokens.push({ type: 'word', value: source.slice(start, i), start, end: i });
    } else { tokens.push({ type: 'punct', value: ch, start, end: ++i }); }
  }
  const replacements = [];
  for (let n = 0; n < tokens.length; n++) {
    const token = tokens[n];
    if (token.type !== 'word' || !['import', 'export'].includes(token.value)) continue;
    if (tokens[n - 1]?.value === '.') continue;
    if (token.value === 'export' && !['{', '*'].includes(tokens[n + 1]?.value)) continue;
    if (token.value === 'import' && ['(', '.'].includes(tokens[n + 1]?.value)) {
      throw new Error('Dynamic imports and import.meta are disabled in the browser runner');
    }
    let specifier;
    if (token.value === 'import' && tokens[n + 1]?.type === 'string') specifier = tokens[n + 1];
    else {
      for (let j = n + 1; j < tokens.length && tokens[j].value !== ';'; j++) {
        if (tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') {
          specifier = tokens[j + 1]; break;
        }
        if (tokens[j].value === 'import' || tokens[j].value === 'export') break;
      }
    }
    if (specifier) {
      if (specifier.value.includes('\\')) throw new Error('Escaped module specifiers are not supported');
      replacements.push({ ...specifier, replacement: JSON.stringify(resolve(specifier.value)) });
    }
  }
  for (const item of replacements.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, item.start) + item.replacement + source.slice(item.end);
  }
  return source;
}
