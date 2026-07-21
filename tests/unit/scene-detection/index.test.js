import { describe, expect, it } from 'vitest';
import {
  createDetector,
  createSceneDetectionManager,
  DEFAULT_DETECTOR_OPTIONS,
  getAvailableDetectors,
  getDefaultDetectorId,
  initSceneDetection,
  isDetectorAvailable,
  registerDetector,
  SceneDetectionManager,
  setDefaultDetector,
  unregisterDetector,
} from '../../../src/features/scene-detection/index.js';

describe('scene-detection public module', () => {
  it('re-exports the manager factory and class from manager.js', () => {
    expect(createSceneDetectionManager).toBeTypeOf('function');
    expect(SceneDetectionManager).toBeTypeOf('function');
  });

  it('re-exports the registry functions from registry.js', () => {
    expect(createDetector).toBeTypeOf('function');
    expect(getAvailableDetectors).toBeTypeOf('function');
    expect(getDefaultDetectorId).toBeTypeOf('function');
    expect(isDetectorAvailable).toBeTypeOf('function');
    expect(registerDetector).toBeTypeOf('function');
    expect(setDefaultDetector).toBeTypeOf('function');
    expect(unregisterDetector).toBeTypeOf('function');
  });

  it('re-exports DEFAULT_DETECTOR_OPTIONS from types.js', () => {
    expect(DEFAULT_DETECTOR_OPTIONS).toBeTypeOf('object');
  });

  it('auto-registers the histogram detector as default on import', () => {
    // The module runs initSceneDetection() as a side effect of being
    // imported, before this test body executes.
    expect(isDetectorAvailable('histogram')).toBe(true);
    expect(getDefaultDetectorId()).toBe('histogram');

    const detector = createDetector('histogram');
    expect(detector.metadata.id).toBe('histogram');
    detector.dispose();
  });

  it('initSceneDetection() is idempotent and keeps histogram registered as default', () => {
    initSceneDetection();

    expect(isDetectorAvailable('histogram')).toBe(true);
    expect(getDefaultDetectorId()).toBe('histogram');
  });
});
