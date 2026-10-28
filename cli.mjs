import { readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyUnifiedDiff } from './core/patch.mjs';
import { runSuite } from './core/runner.mjs';
import { buildEvidenceCard } from './core/evidence.mjs';

export async function loadSample(directory) {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(resolve(root, 'sample.json'), 'utf8'));
  const moduleFiles = {};
  for (const path of manifest.files) {
    const target = resolve(root, path);
    if (relative(root, target).startsWith(`..${sep}`) || relative(root, target) === '..' || target === root) {
      throw new Error(`Sample path escapes its directory: ${path}`);
    }
    moduleFiles[path] = await readFile(target, 'utf8');
  }
  return { ...manifest, moduleFiles };
}

export async function evaluateSample(directory, patchKind, testKind) {
  const sample = await loadSample(directory);
  if (!['good', 'incomplete'].includes(patchKind) || !['golden', 'existing'].includes(testKind)) {
    throw new Error('Use --patch good|incomplete --tests golden|existing');
  }
  const testName = testKind === 'golden' ? 'golden_witness.test.mjs' : 'existing.test.mjs';
  const [diff, testSource] = await Promise.all([
    readFile(resolve(directory, `patch_${patchKind}.diff`), 'utf8'),
    readFile(resolve(directory, testName), 'utf8'),
  ]);
  const patched = applyUnifiedDiff(sample.moduleFiles, diff);
  const options = { entry: sample.entry, testSource, timeoutMs: 1000 };
  const before = await runSuite({ ...options, moduleFiles: sample.moduleFiles });
  const after = await runSuite({ ...options, moduleFiles: patched });
  return buildEvidenceCard(before, after);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, ...flags] = process.argv.slice(2);
    if (!directory || flags.length !== 4 || flags[0] !== '--patch' || flags[2] !== '--tests') {
      throw new Error('Usage: node cli.mjs samples/<name> --patch good|incomplete --tests golden|existing');
    }
    console.log(JSON.stringify(await evaluateSample(directory, flags[1], flags[3]), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
