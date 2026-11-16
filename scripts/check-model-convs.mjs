#!/usr/bin/env node
/**
 * Check the app's model files for Convs that onnxruntime-web's WebGPU
 * backend computes wrong (src/features/ai-cutout/onnx-graph.js: kernel above
 * 1 × 1, input channels divisible by 3, not by 4, more than 3).
 *
 *   npm run models:check-convs                  the files in public/models
 *   npm run models:check-convs -- --dir <path>  the files in another directory
 *
 * Every file of every registry model is looked up by its file name, its
 * SHA-256 compared with the pin (a different file is reported, not
 * scanned), and its graph read; the run fails when a pinned file has such a
 * Conv. Files that are not there are listed as missing (the BiRefNet ones
 * are not in the models-v1 release: `npm run models:fetch` does not
 * download them). The model files are too large for the repository, so CI
 * cannot run this; the unit test (tests/unit/ai-cutout/onnx-graph.test.js)
 * scans public/models when the files are present.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModelFiles, MODEL_REGISTRY } from '../src/features/ai-cutout/model-registry.js';
import {
  findWebgpuConvHazards,
  listConvs,
  readOnnxGraph,
} from '../src/features/ai-cutout/onnx-graph.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = process.argv.indexOf('--dir');
const dir = at > 0 ? resolve(process.argv[at + 1]) : join(root, 'public/models');

let failed = false;
let missing = 0;
console.log(`WebGPU Conv check of the registry models in ${dir}`);
for (const entry of MODEL_REGISTRY) {
  for (const file of getModelFiles(entry)) {
    const path = join(dir, file.fileName);
    const label = `${entry.id.padEnd(17)} ${file.fileName.padEnd(30)}`;
    if (!existsSync(path)) {
      console.log(`${label} missing`);
      missing++;
      continue;
    }
    const bytes = new Uint8Array(readFileSync(path));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== file.sha256) {
      console.log(`${label} NOT the pinned file (SHA-256 ${sha256.slice(0, 12)}…): not scanned`);
      failed = true;
      continue;
    }
    const convs = listConvs(readOnnxGraph(bytes));
    const hazards = findWebgpuConvHazards(bytes);
    if (hazards.length > 0) failed = true;
    console.log(
      `${label} pinned, ${String(convs.length).padStart(3)} Convs: ${
        hazards.length === 0
          ? 'none WebGPU computes wrong'
          : hazards
              .map((h) => `${h.name} (${h.inputChannels} channels, ${h.kernel.join(' × ')})`)
              .join(', ')
      }`,
    );
  }
}
if (missing > 0) console.log(`${missing} file(s) missing (not checked)`);
if (failed) {
  console.error('FAILED: a model file has a Conv WebGPU computes wrong, or is not the pinned file');
  process.exit(1);
}
console.log('OK');
