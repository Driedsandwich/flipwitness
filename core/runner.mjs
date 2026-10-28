import { validateOptions } from './runner.shared.mjs';

export async function runSuite(options) {
  const input = validateOptions(options);
  const adapter = typeof globalThis.Worker === 'function'
    ? await import('./runner.browser.mjs')
    : await import('./runner.node.mjs');
  return adapter.runSuite(input);
}
