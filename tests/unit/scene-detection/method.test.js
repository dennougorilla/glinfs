import { afterEach, describe, expect, it } from 'vitest';
import { SCENE_METHODS } from '../../../src/features/scene-detection/algorithms/scene-breaks.js';
import {
  getSceneMethod,
  SCENE_METHOD_ENTRY,
} from '../../../src/features/scene-detection/method.js';
import { DEFAULT_DETECTOR_OPTIONS } from '../../../src/features/scene-detection/types.js';
import { listMethods, setMethod } from '../../../src/shared/methods.js';

afterEach(() => localStorage.clear());

describe('the scene detection switch', () => {
  it('is registered once, with colour and shape as the default', () => {
    const entries = listMethods().filter((e) => e.id === 'scenes');
    expect(entries).toHaveLength(1);
    expect(entries[0].area).toBe('scenes');
    expect(entries[0].options.map((o) => o.id)).toEqual(['combined', 'fixed', 'adaptive', 'hash']);
    expect(getSceneMethod()).toBe('combined');
    expect(DEFAULT_DETECTOR_OPTIONS.method).toBe('combined');
  });

  it('offers only methods that exist, and follows the stored choice', () => {
    for (const option of SCENE_METHOD_ENTRY.options)
      expect(SCENE_METHODS[option.id]).toBeTypeOf('function');
    setMethod('scenes', 'fixed');
    expect(getSceneMethod()).toBe('fixed');
  });
});
