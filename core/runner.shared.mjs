export const HARNESS = '@patchwitness/harness';
export const TEST_FILE = '__patchwitness_tests__.mjs';

export function normalisePath(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error(`Import escapes module root: ${path}`);
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

export function resolveModule(specifier, importer, entry, files) {
  if (specifier === HARNESS) return HARNESS;
  let path;
  if (specifier === '@entry') path = entry;
  else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    path = normalisePath(`${importer.slice(0, importer.lastIndexOf('/') + 1)}${specifier}`);
  } else throw new Error(`External import is disabled: ${specifier}`);
  if (!Object.hasOwn(files, path)) throw new Error(`Module not supplied: ${path}`);
  return path;
}

export function validateOptions(options) {
  const { moduleFiles, entry, testSource, timeoutMs = 1000 } = options;
  if (!moduleFiles || typeof moduleFiles !== 'object' || Array.isArray(moduleFiles)) throw new TypeError('moduleFiles must be an object');
  for (const [path, source] of Object.entries(moduleFiles)) {
    if (!path || path.startsWith('/') || path.includes('\\') || normalisePath(path) !== path ||
        path === HARNESS || path === TEST_FILE || typeof source !== 'string') {
      throw new TypeError(`Invalid module file: ${path}`);
    }
  }
  if (!Object.hasOwn(moduleFiles, entry)) throw new Error(`Entry not supplied: ${entry}`);
  if (typeof testSource !== 'string') throw new TypeError('testSource must be a string');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new RangeError('timeoutMs must be from 1 to 30000');
  return { moduleFiles, entry, testSource, timeoutMs };
}

// The deadline covers setup, module evaluation and every test in the suite.
export function collectRun(launch, timeoutMs) {
  return new Promise(resolve => {
    const completed = [];
    let names = [];
    let active = '[suite]';
    let finished = false;
    let stop = () => {};
    const finish = results => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      Promise.resolve().then(stop).catch(() => {}).finally(() => resolve(results));
    };
    const timer = setTimeout(() => {
      const pending = names.filter(name => !completed.some(result => result.name === name));
      finish([...completed, ...(pending.length ? pending : [active]).map(name => ({
        name, status: 'timeout', message: name === active ? `Suite exceeded ${timeoutMs} ms` : `Not run: suite exceeded ${timeoutMs} ms`,
      }))]);
    }, timeoutMs);
    const receive = event => {
      if (finished) return;
      if (event.type === 'registered') names = event.names;
      if (event.type === 'start') active = event.name;
      if (event.type === 'result') completed.push(event.result);
      if (event.type === 'done') finish(completed);
      if (event.type === 'error') finish([...completed, { name: '[suite]', status: 'error', message: event.message }]);
    };
    try { stop = launch(receive); }
    catch (error) { receive({ type: 'error', message: `${error.name}: ${error.message}` }); }
  });
}
