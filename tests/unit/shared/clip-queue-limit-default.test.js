import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getClipQueueLimit,
  getDefaultClipQueueLimit,
  isClipQueueLimitUserSet,
  registerClipCodec,
  resetAppStore,
} from '../../../src/shared/app-store.js';
import { on as onBus } from '../../../src/shared/bus.js';
import {
  CLIP_QUEUE_LIMIT_DEFAULT_COMPRESSED,
  CLIP_QUEUE_LIMIT_DEFAULT_RAW,
  loadSettings,
  resetCategory,
  updateSetting,
} from '../../../src/shared/user-settings.js';

/**
 * Tests for #92 item 2: the clip queue limit's EFFECTIVE default depends on
 * whether queued clips are compressed (10) or fall back to raw frames (3,
 * ~3.5 GiB each at 1080p), while an explicit user choice is never
 * overridden. Covers probe-pending, the settings schema 1 -> 2 migration of
 * the old materialized default, and the limit re-announcement when the
 * codec probe resolves.
 */

const STORAGE_KEY = 'glinfs_user_settings';

/** Minimal codec whose availability (and probe) the test controls */
function createCodec({ available = true, probe } = {}) {
  return {
    isCompressionAvailable: () => available,
    encode: vi.fn(() => new Promise(() => {})),
    decode: vi.fn(() => new Promise(() => {})),
    ...(probe ? { probeSupport: probe } : {}),
  };
}

/** Store a raw settings blob as an older app version would have */
function storeRaw(blob) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
}

function storedBlob() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
}

beforeEach(() => {
  resetAppStore();
  localStorage.clear();
});

afterEach(() => {
  registerClipCodec(null);
  vi.clearAllMocks();
});

describe('effective default (setting unset)', () => {
  it('is the compressed default when compression is available', () => {
    registerClipCodec(createCodec({ available: true }));
    expect(isClipQueueLimitUserSet()).toBe(false);
    expect(getDefaultClipQueueLimit()).toBe(CLIP_QUEUE_LIMIT_DEFAULT_COMPRESSED);
    expect(getClipQueueLimit()).toBe(10);
  });

  it('is the raw default when compression is unavailable', () => {
    registerClipCodec(createCodec({ available: false }));
    expect(getClipQueueLimit()).toBe(CLIP_QUEUE_LIMIT_DEFAULT_RAW);
    expect(getClipQueueLimit()).toBe(3);
  });

  it('is the raw default with no codec registered', () => {
    expect(getClipQueueLimit()).toBe(3);
  });

  it('stays raw while the probe is pending, then flips and re-announces the limit', async () => {
    let available = false;
    /** @type {(v: boolean) => void} */
    let resolveProbe = () => {};
    const probePromise = new Promise((resolve) => {
      resolveProbe = resolve;
    });
    const codec = {
      ...createCodec({ probe: () => probePromise }),
      isCompressionAvailable: () => available,
    };

    const events = [];
    const unsubscribe = onBus('queue:changed', (payload) => events.push(payload));
    registerClipCodec(codec);

    // Probe pending: conservative raw default, nothing announced yet
    expect(getClipQueueLimit()).toBe(3);
    expect(events).toEqual([]);

    available = true;
    resolveProbe(true);
    await probePromise;
    await Promise.resolve();

    expect(getClipQueueLimit()).toBe(10);
    expect(events).toEqual([expect.objectContaining({ type: 'codec-ready', limit: 10 })]);
    unsubscribe();
  });

  it('does not announce for a codec that was replaced before its probe resolved', async () => {
    let resolveProbe = () => {};
    const probePromise = new Promise((resolve) => {
      resolveProbe = resolve;
    });
    const events = [];
    const unsubscribe = onBus('queue:changed', (payload) => events.push(payload));

    registerClipCodec(createCodec({ probe: () => probePromise }));
    registerClipCodec(null);
    resolveProbe(true);
    await probePromise;
    await Promise.resolve();

    expect(events).toEqual([]);
    unsubscribe();
  });
});

describe('explicit user choice is never overridden', () => {
  it('keeps an explicit 10 on a raw-fallback platform', () => {
    registerClipCodec(createCodec({ available: false }));
    updateSetting('capture', 'clipQueueLimit', 10);
    expect(isClipQueueLimitUserSet()).toBe(true);
    expect(getClipQueueLimit()).toBe(10);
  });

  it('keeps an explicit 3 when compression is available', () => {
    registerClipCodec(createCodec({ available: true }));
    updateSetting('capture', 'clipQueueLimit', 3);
    expect(getClipQueueLimit()).toBe(3);
  });

  it('keeps the choice across unrelated setting changes', () => {
    registerClipCodec(createCodec({ available: false }));
    updateSetting('capture', 'clipQueueLimit', 10);
    updateSetting('export', 'quality', 0.5);
    updateSetting('capture', 'fps', 60);
    expect(getClipQueueLimit()).toBe(10);
  });

  it('returns to auto on a category reset', () => {
    registerClipCodec(createCodec({ available: false }));
    updateSetting('capture', 'clipQueueLimit', 12);
    resetCategory('capture');
    expect(isClipQueueLimitUserSet()).toBe(false);
    expect(getClipQueueLimit()).toBe(3);
  });

  it('does not store the effective default when other settings are saved', () => {
    registerClipCodec(createCodec({ available: true }));
    updateSetting('export', 'quality', 0.5);
    expect(storedBlob().capture.clipQueueLimit).toBeNull();
  });
});

describe('migration of stored settings (schema 1 -> 2)', () => {
  it('treats a legacy stored 10 (the old materialized default) as auto', () => {
    // v0.5.x persisted the whole merged object on ANY settings change
    storeRaw({ capture: { fps: 60, clipQueueLimit: 10 }, export: {}, thumbnailQuality: 'auto' });
    registerClipCodec(createCodec({ available: false }));

    expect(loadSettings().capture.clipQueueLimit).toBeNull();
    expect(getClipQueueLimit()).toBe(3);
    // Unrelated stored values survive the migration
    expect(loadSettings().capture.fps).toBe(60);
  });

  it('resolves a migrated legacy 10 back to 10 where compression is available', () => {
    storeRaw({ capture: { clipQueueLimit: 10 } });
    registerClipCodec(createCodec({ available: true }));
    expect(getClipQueueLimit()).toBe(10);
  });

  it('keeps any other legacy value as an explicit user choice', () => {
    storeRaw({ capture: { clipQueueLimit: 7 } });
    registerClipCodec(createCodec({ available: false }));
    expect(isClipQueueLimitUserSet()).toBe(true);
    expect(getClipQueueLimit()).toBe(7);
  });

  it('persists the migrated form with the schema version on the next save', () => {
    storeRaw({ capture: { clipQueueLimit: 10 } });
    updateSetting('export', 'quality', 0.5);
    expect(storedBlob()).toMatchObject({ schemaVersion: 2, capture: { clipQueueLimit: null } });
  });

  it('runs once: an explicit 10 chosen after the migration is kept', () => {
    storeRaw({ capture: { clipQueueLimit: 10 } });
    registerClipCodec(createCodec({ available: false }));
    expect(getClipQueueLimit()).toBe(3);

    updateSetting('capture', 'clipQueueLimit', 10);
    expect(storedBlob()).toMatchObject({ schemaVersion: 2, capture: { clipQueueLimit: 10 } });
    expect(getClipQueueLimit()).toBe(10);
  });

  it('never leaks schemaVersion into the loaded settings object', () => {
    updateSetting('export', 'quality', 0.5);
    expect(loadSettings()).not.toHaveProperty('schemaVersion');
  });
});
