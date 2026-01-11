/**
 * Encoder Module Tests
 * @module tests/unit/export/encoders
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerEncoder,
  unregisterEncoder,
  createEncoder,
  getAvailableEncoders,
  getDefaultEncoderId,
  setDefaultEncoder,
  isEncoderAvailable,
  clearRegistry,
  createGifencEncoder,
  getGifencMetadata,
} from '../../../src/features/export/encoders/index.js';

describe('Encoder Registry', () => {
  beforeEach(() => {
    // Clear registry before each test
    clearRegistry();
  });

  afterEach(() => {
    // Restore default state
    clearRegistry();
    registerEncoder('gifenc-js', createGifencEncoder, true);
  });

  describe('registerEncoder', () => {
    it('should register an encoder', () => {
      const mockFactory = () => ({
        metadata: { id: 'test', name: 'Test', isWasm: false, version: '1.0.0' },
        init: () => {},
        addFrame: () => {},
        finish: () => new Uint8Array(),
        dispose: () => {},
      });

      registerEncoder('test', mockFactory);

      expect(isEncoderAvailable('test')).toBe(true);
    });

    it('should set first registered encoder as default', () => {
      const mockFactory = () => ({
        metadata: { id: 'test', name: 'Test', isWasm: false, version: '1.0.0' },
        init: () => {},
        addFrame: () => {},
        finish: () => new Uint8Array(),
        dispose: () => {},
      });

      registerEncoder('test', mockFactory);

      expect(getDefaultEncoderId()).toBe('test');
    });

    it('should set encoder as default when setAsDefault is true', () => {
      const mockFactory1 = () => ({
        metadata: { id: 'test1', name: 'Test 1', isWasm: false, version: '1.0.0' },
        init: () => {},
        addFrame: () => {},
        finish: () => new Uint8Array(),
        dispose: () => {},
      });
      const mockFactory2 = () => ({
        metadata: { id: 'test2', name: 'Test 2', isWasm: true, version: '1.0.0' },
        init: () => {},
        addFrame: () => {},
        finish: () => new Uint8Array(),
        dispose: () => {},
      });

      registerEncoder('test1', mockFactory1);
      registerEncoder('test2', mockFactory2, true);

      expect(getDefaultEncoderId()).toBe('test2');
    });
  });

  describe('unregisterEncoder', () => {
    it('should remove encoder from registry', () => {
      const mockFactory = () => ({
        metadata: { id: 'test', name: 'Test', isWasm: false, version: '1.0.0' },
        init: () => {},
        addFrame: () => {},
        finish: () => new Uint8Array(),
        dispose: () => {},
      });

      registerEncoder('test', mockFactory);
      const removed = unregisterEncoder('test');

      expect(removed).toBe(true);
      expect(isEncoderAvailable('test')).toBe(false);
    });

    it('should return false for non-existent encoder', () => {
      const removed = unregisterEncoder('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('createEncoder', () => {
    it('should create encoder instance', () => {
      registerEncoder('gifenc-js', createGifencEncoder, true);

      const encoder = createEncoder('gifenc-js');

      expect(encoder).toBeDefined();
      expect(encoder.metadata.id).toBe('gifenc-js');
      encoder.dispose();
    });

    it('should use default encoder when id is not provided', () => {
      registerEncoder('gifenc-js', createGifencEncoder, true);

      const encoder = createEncoder();

      expect(encoder.metadata.id).toBe('gifenc-js');
      encoder.dispose();
    });

    it('should throw error when no encoder is registered', () => {
      expect(() => createEncoder()).toThrow('No encoder registered');
    });

    it('should throw error for unknown encoder id', () => {
      registerEncoder('gifenc-js', createGifencEncoder, true);
      expect(() => createEncoder('unknown')).toThrow('Encoder "unknown" not found');
    });
  });

  describe('getAvailableEncoders', () => {
    it('should return list of registered encoders', () => {
      registerEncoder('gifenc-js', createGifencEncoder, true);

      const encoders = getAvailableEncoders();

      expect(encoders).toHaveLength(1);
      expect(encoders[0].id).toBe('gifenc-js');
    });
  });

  describe('setDefaultEncoder', () => {
    it('should set default encoder', () => {
      const mockFactory = () => ({
        metadata: { id: 'test', name: 'Test', isWasm: false, version: '1.0.0' },
        init: () => {},
        addFrame: () => {},
        finish: () => new Uint8Array(),
        dispose: () => {},
      });

      registerEncoder('gifenc-js', createGifencEncoder, true);
      registerEncoder('test', mockFactory);

      setDefaultEncoder('test');

      expect(getDefaultEncoderId()).toBe('test');
    });

    it('should throw error for non-existent encoder', () => {
      expect(() => setDefaultEncoder('unknown')).toThrow('Encoder "unknown" not found');
    });
  });
});

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
