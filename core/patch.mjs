function safePath(header) {
  const path = header.split('\t')[0];
  if (path === '/dev/null') return null;
  const clean = path.replace(/^[ab]\//, '');
  if (!clean || clean.startsWith('/') || clean.startsWith('"') || clean.includes('\0') || clean.includes('\\') ||
      clean.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe patch path: ${path}`);
  }
  return clean;
}

function sourceLines(text) {
  const parts = text.split('\n');
  return parts.flatMap((part, i) => {
    if (i === parts.length - 1 && part === '') return [];
    const ending = i < parts.length - 1 ? (part.endsWith('\r') ? '\r\n' : '\n') : '';
    return [{ text: ending === '\r\n' ? part.slice(0, -1) : part, ending }];
  });
}

/** Apply exact unified hunks atomically; the input object is never modified. */
export function applyUnifiedDiff(files, diffText) {
  const result = Object.assign(Object.create(null), files);
  const lines = diffText.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let fileCount = 0;
  const touched = new Set();
  while (i < lines.length) {
    if (!lines[i].startsWith('--- ')) {
      if (lines[i] === '' || /^(diff --git |index |new file mode |deleted file mode )/.test(lines[i])) {
        i++;
        continue;
      }
      throw new Error(`Unexpected diff line ${i + 1}: ${lines[i]}`);
    }
    const oldPath = safePath(lines[i++].slice(4));
    if (!lines[i]?.startsWith('+++ ')) throw new Error('Missing +++ file header');
    const newPath = safePath(lines[i++].slice(4));
    const path = newPath ?? oldPath;
    if (!path || (oldPath && newPath && oldPath !== newPath)) {
      throw new Error('Renames are not supported; use delete/add sections');
    }
    if (touched.has(path)) throw new Error(`Duplicate file section: ${path}`);
    touched.add(path);
    if (oldPath && !Object.hasOwn(files, oldPath)) throw new Error(`Missing file: ${oldPath}`);
    if (!oldPath && Object.hasOwn(files, newPath)) throw new Error(`File already exists: ${newPath}`);
    const original = sourceLines(oldPath ? files[oldPath] : '');
    const newline = original.find(line => line.ending)?.ending ?? '\n';
    const output = [];
    let cursor = 0;
    let hunk = 0;
    while (i < lines.length && lines[i].startsWith('@@')) {
      const header = lines[i++];
      hunk++;
      const problem = reason => { throw new Error(`${path}, hunk ${hunk} (${header}): ${reason}`); };
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(header);
      if (!match) problem('Malformed hunk header');
      const [, a, b, c, d] = match;
      const oldCount = b === undefined ? 1 : Number(b);
      const newCount = d === undefined ? 1 : Number(d);
      const oldStart = Number(a) - (oldCount ? 1 : 0);
      const newStart = Number(c) - (newCount ? 1 : 0);
      if (oldStart < cursor || oldStart > original.length) problem('Invalid or overlapping source range');
      output.push(...original.slice(cursor, oldStart));
      cursor = oldStart;
      if (newStart !== output.length) problem('New line coordinate does not match output');
      let removed = 0;
      let added = 0;
      while (removed < oldCount || added < newCount) {
        const raw = lines[i++];
        if (raw === undefined || !/^[ +\-]/.test(raw)) problem('Missing hunk body lines');
        const kind = raw[0];
        const content = raw.slice(1);
        let hasNewline = true;
        if (lines[i] === '\\ No newline at end of file') { hasNewline = false; i++; }
        if (kind !== '+') {
          removed++;
          const current = original[cursor++];
          if (!current || current.text !== content || Boolean(current.ending) !== hasNewline) {
            problem(`Context mismatch at original line ${cursor}`);
          }
          if (kind === ' ') output.push(current);
        }
        if (kind !== '-') {
          added++;
          if (kind === '+') output.push({ text: content, ending: hasNewline ? newline : '' });
        }
        if (removed > oldCount || added > newCount) problem('Hunk line count mismatch');
      }
    }
    if (!hunk) throw new Error(`${path}: No hunks found`);
    output.push(...original.slice(cursor));
    if (output.slice(0, -1).some(line => !line.ending)) throw new Error(`${path}: Non-final line has no newline`);
    if (!newPath) {
      if (output.length) throw new Error(`${path}: Deletion leaves content`);
      delete result[oldPath];
    } else {
      result[newPath] = output.map(line => line.text + line.ending).join('');
    }
    fileCount++;
  }
  if (!fileCount && diffText.trim()) throw new Error('No unified diff sections found');
  return { ...result };
}
