export class AssertionError extends Error {
  constructor(message) { super(message); this.name = 'AssertionError'; }
}

function display(value) {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function equal(a, b, seen = new Map()) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const plain = value => Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null;
  if (!plain(a) || !plain(b)) return false;
  if (seen.get(a)?.has(b)) return true;
  if (!seen.has(a)) seen.set(a, new Set());
  seen.get(a).add(b);
  if (Array.isArray(a) && a.length !== b.length) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key], seen));
}

export function expect(actual) {
  const check = (ok, message) => { if (!ok) throw new AssertionError(message); };
  return {
    toBe(expected) {
      check(Object.is(actual, expected), `Expected ${display(actual)} to be ${display(expected)}`);
    },
    toEqual(expected) {
      check(equal(actual, expected), `Expected ${display(actual)} to equal ${display(expected)}`);
    },
    toThrow() {
      check(typeof actual === 'function', 'toThrow requires a function');
      let threw = false;
      try { actual(); } catch { threw = true; }
      check(threw, 'Expected function to throw');
    },
    toBeCloseTo(expected, digits = 2) {
      check(Number.isInteger(digits) && digits >= 0 && digits <= 100, 'digits must be an integer from 0 to 100');
      check(typeof actual === 'number' && typeof expected === 'number' &&
        (actual === expected || (Number.isFinite(actual) && Number.isFinite(expected) &&
        Math.abs(actual - expected) < 0.5 * 10 ** -digits)),
      `Expected ${display(actual)} to be close to ${display(expected)} (${digits} digits)`);
    },
  };
}

// A fresh module instance belongs to each suite, so registries cannot leak between runs.
const tests = [];
export function test(name, fn) {
  if (typeof name !== 'string' || !name || typeof fn !== 'function') throw new TypeError('test requires a name and function');
  if (name === '[suite]') throw new Error('The test name [suite] is reserved for setup errors');
  if (tests.some(item => item.name === name)) throw new Error(`Duplicate test name: ${name}`);
  tests.push({ name, fn });
}

export async function runRegisteredTests(emit = () => {}) {
  const results = [];
  emit({ type: 'registered', names: tests.map(item => item.name) });
  for (const { name, fn } of tests) {
    emit({ type: 'start', name });
    let result;
    try {
      await fn();
      result = { name, status: 'pass', message: '' };
    } catch (error) {
      result = {
        name,
        status: error instanceof AssertionError ? 'fail' : 'error',
        message: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      };
    }
    results.push(result);
    emit({ type: 'result', result });
  }
  if (!tests.length) throw new Error('Suite registered no tests');
  return results;
}
