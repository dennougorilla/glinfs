import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRegistry,
  createDetector,
  getAvailableDetectors,
  getDefaultDetectorId,
  isDetectorAvailable,
  registerDetector,
  setDefaultDetector,
  unregisterDetector,
} from '../../../src/features/scene-detection/registry.js';

function createFactory(id) {
  const detector = {
    metadata: { id, name: `${id} detector` },
    detect: vi.fn(),
    dispose: vi.fn(),
  };
  return { detector, factory: vi.fn(() => detector) };
}

describe('scene detector registry production API', () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    clearRegistry();
    vi.restoreAllMocks();
  });

  it('uses the first registration as default and creates it through its factory', () => {
    const { detector, factory } = createFactory('first');
    registerDetector('first', factory);

    expect(getDefaultDetectorId()).toBe('first');
    expect(isDetectorAvailable('first')).toBe(true);
    expect(createDetector()).toBe(detector);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('switches defaults explicitly and validates unknown detector IDs', () => {
    registerDetector('first', createFactory('first').factory);
    registerDetector('second', createFactory('second').factory, true);

    expect(getDefaultDetectorId()).toBe('second');
    setDefaultDetector('first');
    expect(getDefaultDetectorId()).toBe('first');
    expect(() => setDefaultDetector('missing')).toThrow('Detector "missing" not found');
    expect(() => createDetector('missing')).toThrow('Detector "missing" not found');
  });

  it('moves the default to the next detector when the current one is removed', () => {
    registerDetector('first', createFactory('first').factory);
    registerDetector('second', createFactory('second').factory);

    expect(unregisterDetector('first')).toBe(true);
    expect(getDefaultDetectorId()).toBe('second');
    expect(unregisterDetector('second')).toBe(true);
    expect(getDefaultDetectorId()).toBeNull();
    expect(unregisterDetector('missing')).toBe(false);
    expect(() => createDetector()).toThrow('No detector registered');
  });

  it('collects metadata, disposes temporary instances, and skips broken factories', () => {
    const first = createFactory('first');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerDetector('first', first.factory);
    registerDetector('broken', () => {
      throw new Error('Factory failed');
    });

    expect(getAvailableDetectors()).toEqual([first.detector.metadata]);
    expect(first.detector.dispose).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('Failed to get detector metadata:', expect.any(Error));
  });
});
