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
 * overridden. Covers probe-pending, the migration of the old materialized
 * default, storage shared with OLDER builds (an open pre-deploy tab), and the
 * limit re-announcement when the codec probe resolves.
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

  it('stores auto (not the effective default) when other settings are saved', () => {
    registerClipCodec(createCodec({ available: false }));
    updateSetting('export', 'quality', 0.5);
    expect(storedBlob().capture).toMatchObject({ clipQueueLimit: 10, clipQueueLimitMode: 'auto' });
    expect(getClipQueueLimit()).toBe(3);
  });
});

describe('migration of stored settings (v0.5.x blobs, no clipQueueLimitMode)', () => {
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

  it('persists the migrated form (auto mode) on the next save', () => {
    storeRaw({ capture: { clipQueueLimit: 10 } });
    updateSetting('export', 'quality', 0.5);
    expect(storedBlob().capture).toMatchObject({ clipQueueLimit: 10, clipQueueLimitMode: 'auto' });
  });

  it('runs once: an explicit 10 chosen after the migration is kept', () => {
    storeRaw({ capture: { clipQueueLimit: 10 } });
    registerClipCodec(createCodec({ available: false }));
    expect(getClipQueueLimit()).toBe(3);

    updateSetting('capture', 'clipQueueLimit', 10);
    expect(storedBlob().capture).toMatchObject({
      clipQueueLimit: 10,
      clipQueueLimitMode: 'explicit',
    });
    updateSetting('export', 'quality', 0.5);
    expect(getClipQueueLimit()).toBe(10);
  });

  it('never leaks the storage mode into the loaded settings object', () => {
    updateSetting('capture', 'clipQueueLimit', 5);
    expect(loadSettings().capture).not.toHaveProperty('clipQueueLimitMode');
    expect(loadSettings()).not.toHaveProperty('schemaVersion');
  });

  it('reads a stored null (no older build writes one) as auto', () => {
    storeRaw({ capture: { clipQueueLimit: null } });
    registerClipCodec(createCodec({ available: false }));
    expect(isClipQueueLimitUserSet()).toBe(false);
    expect(getClipQueueLimit()).toBe(3);
  });
});

/*
 * Mixed-version storage: an older build (a tab opened before the deploy, or
 * a rollback) shares the same localStorage key. These replicate v0.5.3's
 * settings code (442f18e: src/shared/user-settings.js loadSettings /
 * updateSetting / resetCategory and src/shared/app-store.js
 * getClipQueueLimit) so the stored form is checked against the real old
 * reader's arithmetic, not just this build's own reader.
 */
const LEGACY_CAPTURE_DEFAULTS = { fps: 30, clipQueueLimit: 10 };

function legacyLoad() {
  const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  return {
    capture: { ...LEGACY_CAPTURE_DEFAULTS, ...parsed.capture },
    export: { ...parsed.export },
    thumbnailQuality: parsed.thumbnailQuality || 'auto',
  };
}

/** v0.5.3 getClipQueueLimit */
function legacyGetClipQueueLimit() {
  const raw = Number(legacyLoad().capture.clipQueueLimit);
  if (!Number.isFinite(raw)) return 10;
  return Math.min(30, Math.max(1, Math.round(raw)));
}

/** v0.5.3 updateSetting for a capture key (persists the whole merged object) */
function legacyUpdateCapture(key, value) {
  const settings = legacyLoad();
  settings.capture[key] = value;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** v0.5.3 resetCategory('capture') */
function legacyResetCapture() {
  const settings = legacyLoad();
  settings.capture = { ...LEGACY_CAPTURE_DEFAULTS };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

describe('storage shared with an older build (review of #92 PR)', () => {
  it('an old reader keeps its 10 after this build saves an unrelated setting', () => {
    storeRaw({ capture: { clipQueueLimit: 10 } });
    expect(legacyGetClipQueueLimit()).toBe(10);

    registerClipCodec(createCodec({ available: false }));
    updateSetting('export', 'quality', 0.5);

    // Was 10 -> 1 when auto was stored as null
    expect(legacyGetClipQueueLimit()).toBe(10);
    // ...while this build still resolves auto
    expect(isClipQueueLimitUserSet()).toBe(false);
    expect(getClipQueueLimit()).toBe(3);
  });

  it('an old reader keeps 10 after this build resets to auto', () => {
    updateSetting('capture', 'clipQueueLimit', 4);
    resetCategory('capture');
    expect(legacyGetClipQueueLimit()).toBe(10);
    expect(isClipQueueLimitUserSet()).toBe(false);
  });

  it('explicit values read the same in both builds, including an explicit 10', () => {
    registerClipCodec(createCodec({ available: false }));
    updateSetting('capture', 'clipQueueLimit', 5);
    expect(legacyGetClipQueueLimit()).toBe(5);
    expect(getClipQueueLimit()).toBe(5);

    updateSetting('capture', 'clipQueueLimit', 10);
    expect(legacyGetClipQueueLimit()).toBe(10);
    expect(isClipQueueLimitUserSet()).toBe(true);
    expect(getClipQueueLimit()).toBe(10);
  });

  it('auto survives an old tab saving an unrelated capture setting', () => {
    registerClipCodec(createCodec({ available: false }));
    updateSetting('export', 'quality', 0.5);

    legacyUpdateCapture('fps', 60);

    expect(isClipQueueLimitUserSet()).toBe(false);
    expect(getClipQueueLimit()).toBe(3);
    expect(loadSettings().capture.fps).toBe(60);
  });

  it('an explicit 10 survives an old tab saving an unrelated capture setting', () => {
    registerClipCodec(createCodec({ available: false }));
    updateSetting('capture', 'clipQueueLimit', 10);

    legacyUpdateCapture('fps', 60);

    expect(isClipQueueLimitUserSet()).toBe(true);
    expect(getClipQueueLimit()).toBe(10);
  });

  it('a limit changed in an old tab under a stale auto mode is explicit', () => {
    registerClipCodec(createCodec({ available: false }));
    updateSetting('export', 'quality', 0.5);

    legacyUpdateCapture('clipQueueLimit', 5);

    expect(isClipQueueLimitUserSet()).toBe(true);
    expect(getClipQueueLimit()).toBe(5);
  });

  it('an old tab resetting capture returns this build to auto', () => {
    registerClipCodec(createCodec({ available: false }));
    updateSetting('capture', 'clipQueueLimit', 10);

    legacyResetCapture();

    expect(isClipQueueLimitUserSet()).toBe(false);
    expect(getClipQueueLimit()).toBe(3);
  });

  it('never stores a non-numeric clipQueueLimit', () => {
    updateSetting('export', 'quality', 0.5);
    resetCategory('capture');
    updateSetting('capture', 'clipQueueLimit', null);
    expect(typeof storedBlob().capture.clipQueueLimit).toBe('number');
  });
});
