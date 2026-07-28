/**
 * Encoder Module Tests
 * @module tests/unit/export/encoders
 */

import { describe, expect, it } from 'vitest';
import {
  createGifencEncoder,
  getGifencMetadata,
} from '../../../src/features/export/encoders/gifenc-encoder.js';

describe('gifenc Encoder', () => {
  describe('getGifencMetadata', () => {
    it('should return correct metadata', () => {
      const metadata = getGifencMetadata();

      expect(metadata.id).toBe('gifenc-js');
      expect(metadata.name).toBe('gifenc (JavaScript)');
      expect(metadata.isWasm).toBe(false);
      expect(metadata.version).toBeDefined();
    });
  });

  describe('createGifencEncoder', () => {
    it('should create encoder with correct metadata', () => {
      const encoder = createGifencEncoder();

      expect(encoder.metadata.id).toBe('gifenc-js');
      expect(encoder.metadata.isWasm).toBe(false);

      encoder.dispose();
    });

    it('should throw error when addFrame called before init', () => {
      const encoder = createGifencEncoder();
      const frameData = {
        rgba: new Uint8ClampedArray(100 * 100 * 4),
        width: 100,
        height: 100,
      };

      expect(() => encoder.addFrame(frameData, 0)).toThrow('Encoder not initialized');

      encoder.dispose();
    });

    it('should throw error when finish called before init', () => {
      const encoder = createGifencEncoder();

      expect(() => encoder.finish()).toThrow('Encoder not initialized');

      encoder.dispose();
    });

    it('should encode single frame GIF', () => {
      const encoder = createGifencEncoder();

      // Create test frame (10x10 red pixels)
      const width = 10;
      const height = 10;
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = 255; // R
        rgba[i + 1] = 0; // G
        rgba[i + 2] = 0; // B
        rgba[i + 3] = 255; // A
      }

      encoder.init({
        width,
        height,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      encoder.addFrame({ rgba, width, height }, 0);

      const bytes = encoder.finish();

      // GIF magic number: GIF89a
      expect(bytes[0]).toBe(0x47); // G
      expect(bytes[1]).toBe(0x49); // I
      expect(bytes[2]).toBe(0x46); // F
      expect(bytes[3]).toBe(0x38); // 8
      expect(bytes[4]).toBe(0x39); // 9
      expect(bytes[5]).toBe(0x61); // a

      encoder.dispose();
    });

    it('should encode multiple frames', () => {
      const encoder = createGifencEncoder();

      const width = 10;
      const height = 10;

      encoder.init({
        width,
        height,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      // Add 3 frames with different colors
      const colors = [
        [255, 0, 0], // Red
        [0, 255, 0], // Green
        [0, 0, 255], // Blue
      ];

      colors.forEach((color, index) => {
        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < rgba.length; i += 4) {
          rgba[i] = color[0];
          rgba[i + 1] = color[1];
          rgba[i + 2] = color[2];
          rgba[i + 3] = 255;
        }
        encoder.addFrame({ rgba, width, height }, index);
      });

      const bytes = encoder.finish();

      // Should produce valid GIF
      expect(bytes[0]).toBe(0x47); // G
      expect(bytes.length).toBeGreaterThan(100); // Should have content

      encoder.dispose();
    });

    it('should dispose properly', () => {
      const encoder = createGifencEncoder();

      encoder.init({
        width: 10,
        height: 10,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      encoder.dispose();

      // After dispose, should throw on operations
      const frameData = {
        rgba: new Uint8ClampedArray(100),
        width: 10,
        height: 10,
      };
      expect(() => encoder.addFrame(frameData, 0)).toThrow();
    });

    it('should accept rgb565 quantize format', () => {
      const encoder = createGifencEncoder();

      encoder.init({
        width: 10,
        height: 10,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
        quantizeFormat: 'rgb565',
      });

      const rgba = new Uint8ClampedArray(10 * 10 * 4).fill(255);
      encoder.addFrame({ rgba, width: 10, height: 10 }, 0);

      const bytes = encoder.finish();
      expect(bytes[0]).toBe(0x47); // G

      encoder.dispose();
    });

    it('should accept rgb444 quantize format', () => {
      const encoder = createGifencEncoder();

      encoder.init({
        width: 10,
        height: 10,
        maxColors: 64,
        frameDelayMs: 100,
        loopCount: 0,
        quantizeFormat: 'rgb444',
      });

      const rgba = new Uint8ClampedArray(10 * 10 * 4).fill(255);
      encoder.addFrame({ rgba, width: 10, height: 10 }, 0);

      const bytes = encoder.finish();
      expect(bytes[0]).toBe(0x47); // G

      encoder.dispose();
    });

    it('should default to rgb565 when quantize format not specified', () => {
      const encoder = createGifencEncoder();

      // No quantizeFormat specified
      encoder.init({
        width: 10,
        height: 10,
        maxColors: 256,
        frameDelayMs: 100,
        loopCount: 0,
      });

      const rgba = new Uint8ClampedArray(10 * 10 * 4).fill(255);
      expect(() => encoder.addFrame({ rgba, width: 10, height: 10 }, 0)).not.toThrow();

      encoder.dispose();
    });
  });
});

describe('palette scheduling (#99)', () => {
  it('quantizes every frame on the quality preset (interval 1)', async () => {
    const { shouldQuantize } = await import(
      '../../../src/features/export/encoders/gifenc-encoder.js'
    );
    for (const i of [0, 1, 2, 7, 449]) {
      expect(shouldQuantize(i, 1, true)).toBe(true);
    }
  });

  it('quantizes on frames 0, N, 2N... on the balanced preset (interval 10)', async () => {
    const { shouldQuantize } = await import(
      '../../../src/features/export/encoders/gifenc-encoder.js'
    );
    expect(shouldQuantize(0, 10, false)).toBe(true); // no palette yet
    expect(shouldQuantize(1, 10, true)).toBe(false);
    expect(shouldQuantize(9, 10, true)).toBe(false);
    expect(shouldQuantize(10, 10, true)).toBe(true);
    expect(shouldQuantize(15, 10, true)).toBe(false);
    expect(shouldQuantize(20, 10, true)).toBe(true);
  });

  it('quantizes only once on the fast preset (interval 0)', async () => {
    const { shouldQuantize } = await import(
      '../../../src/features/export/encoders/gifenc-encoder.js'
    );
    expect(shouldQuantize(0, 0, false)).toBe(true);
    for (const i of [1, 10, 100, 449]) {
      expect(shouldQuantize(i, 0, true)).toBe(false);
    }
  });

  it('always quantizes when no palette exists regardless of interval', async () => {
    const { shouldQuantize } = await import(
      '../../../src/features/export/encoders/gifenc-encoder.js'
    );
    expect(shouldQuantize(5, 0, false)).toBe(true);
    expect(shouldQuantize(5, 10, false)).toBe(true);
  });

  it('presets carry the intended intervals', async () => {
    const { ENCODER_PRESETS } = await import('../../../src/features/export/core.js');
    const byId = Object.fromEntries(ENCODER_PRESETS.map((p) => [p.id, p.paletteInterval]));
    expect(byId).toEqual({ quality: 1, balanced: 10, fast: 0 });
  });
});
