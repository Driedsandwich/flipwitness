import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { HARNESS, TEST_FILE, resolveModule } from './runner.shared.mjs';

// Keep unresolved promises alive until the parent deadline terminates this worker.
parentPort.on('message', () => {});

try {
  const { moduleFiles, entry, testSource } = workerData;
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  // Define blockers inside the context: no host functions are passed into tested code.
  vm.runInContext(`
    for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'Worker', 'SharedWorker']) {
      Object.defineProperty(globalThis, key, {
        value: () => { throw new Error(key + ' is disabled'); }, writable: false, configurable: false
      });
    }
  `, context);
  const sources = { ...moduleFiles, [TEST_FILE]: testSource,
    [HARNESS]: await readFile(new URL('./harness.mjs', import.meta.url), 'utf8') };
  const modules = new Map();
  function getModule(path) {
    if (!modules.has(path)) {
      modules.set(path, new vm.SourceTextModule(sources[path], {
        context, identifier: path,
        importModuleDynamically() { throw new Error('Dynamic imports are disabled'); },
      }));
    }
    return modules.get(path);
  }
  const linker = (specifier, referencing) =>
    getModule(resolveModule(specifier, referencing.identifier, entry, sources));
  const harness = getModule(HARNESS);
  await harness.link(linker);
  await harness.evaluate();
  context.test = harness.namespace.test;
  context.expect = harness.namespace.expect;
  const suite = getModule(TEST_FILE);
  await suite.link(linker);
  await suite.evaluate();
  // The callback is only held by trusted harness code, never exposed as a global.
  await harness.namespace.runRegisteredTests(event => parentPort.postMessage(event));
  parentPort.postMessage({ type: 'done' });
} catch (error) {
  parentPort.postMessage({ type: 'error', message: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` });
}
