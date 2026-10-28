import { HARNESS, TEST_FILE, collectRun, normalisePath, resolveModule, validateOptions } from './runner.shared.mjs';
import { rewriteImports } from './runner.browser.imports.mjs';

export async function runSuite(options) {
  const input = validateOptions(options);
  // This trusted asset is fetched by the caller, never by the tested worker.
  const response = await fetch(new URL('./harness.mjs', import.meta.url));
  if (!response.ok) throw new Error(`Cannot load harness: ${response.status}`);
  const harnessSource = await response.text();
  return collectRun(receive => {
    const workerSource = `
      const send = globalThis.postMessage.bind(globalThis);
      const listen = globalThis.addEventListener.bind(globalThis);
      const makeURL = URL.createObjectURL.bind(URL);
      const revokeURL = URL.revokeObjectURL.bind(URL);
      const urls = [];
      const HARNESS = ${JSON.stringify(HARNESS)};
      const TEST_FILE = ${JSON.stringify(TEST_FILE)};
      const normalisePath = ${normalisePath.toString()};
      const resolveModule = ${resolveModule.toString()};
      const rewriteImports = ${rewriteImports.toString()};
      // Shadowing on globalThis alone is not enough: Chrome keeps fetch on
      // WorkerGlobalScope.prototype, reachable via Object.getPrototypeOf(globalThis).
      // Disable each key on the global object and on every prototype that owns it.
      for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts',
                         'Worker', 'SharedWorker', 'EventSource', 'WebTransport', 'postMessage']) {
        const disabled = { value: function () { throw new Error(key + ' is disabled'); },
                           writable: false, configurable: false };
        for (let owner = globalThis; owner; owner = Object.getPrototypeOf(owner)) {
          if (owner === globalThis || Object.prototype.hasOwnProperty.call(owner, key)) {
            Object.defineProperty(owner, key, disabled);
          }
        }
      }
      listen('message', async ({ data }) => {
        try {
          const sources = { ...data.moduleFiles, [HARNESS]: data.harnessSource, [TEST_FILE]: data.testSource };
          const cache = new Map();
          const visiting = new Set();
          function build(path) {
            if (cache.has(path)) return cache.get(path);
            if (visiting.has(path)) throw new Error('Browser runner does not support circular imports: ' + path);
            visiting.add(path);
            const source = path === HARNESS ? sources[path] : rewriteImports(sources[path], specifier =>
              build(resolveModule(specifier, path, data.entry, sources)));
            const url = makeURL(new Blob([source], { type: 'text/javascript' }));
            urls.push(url); cache.set(path, url); visiting.delete(path);
            return url;
          }
          const harness = await import(build(HARNESS));
          globalThis.test = harness.test;
          globalThis.expect = harness.expect;
          await import(build(TEST_FILE));
          await harness.runRegisteredTests(send);
          send({ type: 'done' });
        } catch (error) {
          send({ type: 'error', message: (error?.name ?? 'Error') + ': ' + (error?.message ?? String(error)) });
        } finally { urls.forEach(revokeURL); }
      }, { once: true });
    `;
    const blobURL = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    let worker;
    try {
      worker = new Worker(blobURL, { type: 'module' });
      worker.onmessage = event => receive(event.data);
      worker.onerror = event => { event.preventDefault(); receive({ type: 'error', message: event.message }); };
      worker.postMessage({ ...input, harnessSource });
    } catch (error) { URL.revokeObjectURL(blobURL); throw error; }
    return () => { worker.terminate(); URL.revokeObjectURL(blobURL); };
  }, input.timeoutMs);
}

