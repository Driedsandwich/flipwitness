import { Worker } from 'node:worker_threads';
import { collectRun, validateOptions } from './runner.shared.mjs';

export function runSuite(options) {
  const input = validateOptions(options);
  return collectRun(receive => {
    const worker = new Worker(new URL('./runner.node.worker.mjs', import.meta.url), {
      workerData: input,
      execArgv: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'],
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    });
    worker.on('message', receive);
    worker.on('error', error => receive({ type: 'error', message: `${error.name}: ${error.message}` }));
    worker.on('exit', code => receive({ type: 'error', message: `Worker exited before completion (code ${code})` }));
    return () => worker.terminate();
  }, input.timeoutMs);
}
