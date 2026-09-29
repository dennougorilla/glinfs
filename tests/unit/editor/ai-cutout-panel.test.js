/**
 * Copy helpers of the AI cutout section: every line about a model comes
 * from its registry entry.
 */

import { describe, expect, it } from 'vitest';
import { MODEL_REGISTRY } from '../../../src/features/ai-cutout/model-registry.js';
import {
  formatEdge,
  getAiIntro,
  getWebgpuWarning,
} from '../../../src/features/editor/panels/ai-cutout-panel.js';

describe('getAiIntro', () => {
  it('says what each registered model finds, its name and its download size', () => {
    for (const entry of MODEL_REGISTRY) {
      const intro = getAiIntro(entry.id);
      expect(intro).toContain(`Finds ${entry.finds} in every frame with the ${entry.label} model`);
      expect(intro).toContain(`downloads ${Math.round(entry.bytes / 1_000_000)} MB once`);
    }
    expect(getAiIntro('anime')).toContain('Finds the characters');
    expect(getAiIntro('general')).toContain('Finds the people, pets and objects');
  });
});

describe('getWebgpuWarning', () => {
  it('names the model that failed on WebGPU, else says the browser has none', () => {
    expect(getWebgpuWarning({ needsWasmChoice: true, webgpuModelFailed: true }, 'General')).toMatch(
      /^The General model could not run on WebGPU in this browser\./,
    );
    expect(
      getWebgpuWarning({ needsWasmChoice: true, webgpuModelFailed: false }, 'General'),
    ).toMatch(/^The analysis needs WebGPU, which this browser does not provide\./);
    expect(
      getWebgpuWarning({ needsWasmChoice: false, webgpuModelFailed: false }, 'General'),
    ).toMatch(/^WebGPU is not available in this browser\./);
  });
});

describe('formatEdge', () => {
  it('signs the edge in pixels', () => {
    expect(formatEdge(0)).toBe('0 px');
    expect(formatEdge(2)).toBe('+2 px');
    expect(formatEdge(-3)).toBe('−3 px');
  });
});
