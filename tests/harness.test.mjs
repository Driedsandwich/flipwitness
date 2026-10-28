import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expect, AssertionError, test as register, runRegisteredTests } from '../core/harness.mjs';

test('toBe uses identity, including NaN and signed zero', () => {
  expect(NaN).toBe(NaN);
  const item = {}; expect(item).toBe(item);
  assert.throws(() => expect({}).toBe({}), AssertionError);
  assert.throws(() => expect(-0).toBe(0), AssertionError);
});

test('deep equality supports nested objects, arrays, Dates and cycles', () => {
  expect({ a: [1, { when: new Date('2024-02-29') }] }).toEqual({ a: [1, { when: new Date('2024-02-29') }] });
  expect(Object.assign(Object.create(null), { x: 1 })).toEqual({ x: 1 });
  const a = {}; a.self = a;
  const b = {}; b.self = b;
  expect(a).toEqual(b);
  const shared = { x: 1 };
  expect([shared, shared]).toEqual([{ x: 1 }, { x: 1 }]);
  for (const [left, right] of [
    [[1, 2], [2, 1]], [{ x: undefined }, {}], [new Date(0), new Date(1)],
    [[1], { 0: 1 }], [new Array(1), []], [new Map(), new Map()],
  ]) assert.throws(() => expect(left).toEqual(right), AssertionError);
});

test('throw and close-to matchers report assertion failures', () => {
  expect(() => { throw new Error('expected'); }).toThrow();
  expect(0.1 + 0.2).toBeCloseTo(0.3, 12);
  expect(Infinity).toBeCloseTo(Infinity);
  assert.throws(() => expect(() => {}).toThrow(), AssertionError);
  assert.throws(() => expect(3).toThrow(), AssertionError);
  assert.throws(() => expect(0.31).toBeCloseTo(0.3, 2), AssertionError);
  assert.throws(() => expect(NaN).toBeCloseTo(0), AssertionError);
  assert.throws(() => expect(NaN).toBeCloseTo(NaN), AssertionError);
  assert.throws(() => expect(1).toBeCloseTo(1, -1), AssertionError);
});

test('async tests are awaited and assertions differ from runtime errors', async () => {
  register('async pass', async () => { await Promise.resolve(); expect(2).toBe(2); });
  register('assertion', () => expect(1).toBe(2));
  register('runtime', () => { throw new TypeError('broken'); });
  assert.throws(() => register('runtime', () => {}), /Duplicate/);
  assert.throws(() => register('[suite]', () => {}), /reserved/);
  assert.deepEqual((await runRegisteredTests()).map(item => item.status), ['pass', 'fail', 'error']);
});
