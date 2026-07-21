import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Set the URL search string that test-mode.js reads via
 * `new URLSearchParams(window.location.search)`.
 */
function setSearch(search) {
  window.location.search = search;
}

/**
 * The module keeps a module-level `initialized` guard, so each test needs a
 * fresh module instance (vi.resetModules + dynamic import) to observe
 * detection/parsing from a clean slate.
 */
async function loadTestModeModule() {
  vi.resetModules();
  return import('../../../src/shared/test-mode.js');
}

describe('test-mode', () => {
  beforeEach(() => {
    // jsdom's real Location object rejects arbitrary `search` assignment, so
    // swap in a plain, freely-mutable object (same pattern used elsewhere in
    // this suite, e.g. tests/unit/shared/utils/mock-frame.test.js).
    Object.defineProperty(window, 'location', {
      value: { search: '', hash: '' },
      writable: true,
    });
    delete window.__PLAYWRIGHT_TEST__;
    Object.defineProperty(navigator, 'webdriver', { value: undefined, configurable: true });
    // detectTestMode() falls back to "on in dev mode" via import.meta.env.DEV,
    // which vitest sets to true by default. Stub it off so URL/flag-based
    // detection can be exercised deterministically.
    vi.stubEnv('DEV', false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('detection', () => {
    it('is disabled by default when no signals are present', async () => {
      // Arrange / Act
      const { isTestMode, initTestMode } = await loadTestModeModule();
      initTestMode();

      // Assert
      expect(isTestMode()).toBe(false);
    });

    it('detects testMode=true in the URL', async () => {
      // Arrange
      setSearch('?testMode=true');

      // Act
      const { isTestMode, initTestMode } = await loadTestModeModule();
      initTestMode();

      // Assert
      expect(isTestMode()).toBe(true);
    });

    it('ignores testMode when the value is not exactly "true"', async () => {
      // Arrange
      setSearch('?testMode=1');

      // Act
      const { isTestMode, initTestMode } = await loadTestModeModule();
      initTestMode();

      // Assert
      expect(isTestMode()).toBe(false);
    });

    it('detects the window.__PLAYWRIGHT_TEST__ flag', async () => {
      // Arrange
      window.__PLAYWRIGHT_TEST__ = true;

      // Act
      const { isTestMode, initTestMode } = await loadTestModeModule();
      initTestMode();

      // Assert
      expect(isTestMode()).toBe(true);
    });

    it('detects navigator.webdriver', async () => {
      // Arrange
      Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true });

      // Act
      const { isTestMode, initTestMode } = await loadTestModeModule();
      initTestMode();

      // Assert
      expect(isTestMode()).toBe(true);
    });

    it('falls back to DEV-mode detection when no other signal applies', async () => {
      // Arrange
      vi.stubEnv('DEV', true);

      // Act
      const { isTestMode, initTestMode } = await loadTestModeModule();
      initTestMode();

      // Assert
      expect(isTestMode()).toBe(true);
    });

    it('lazily initializes on the first isTestMode() call without an explicit initTestMode()', async () => {
      // Arrange
      setSearch('?testMode=true');

      // Act
      const { isTestMode } = await loadTestModeModule();

      // Assert
      expect(isTestMode()).toBe(true);
    });

    it('only initializes once — a later URL change has no effect until the module is reloaded', async () => {
      // Arrange
      const { isTestMode, initTestMode } = await loadTestModeModule();
      initTestMode();
      expect(isTestMode()).toBe(false);

      // Act - the `initialized` guard means this second call is a no-op
      setSearch('?testMode=true');
      initTestMode();

      // Assert
      expect(isTestMode()).toBe(false);
    });
  });

  describe('mock frame config parsing bounds', () => {
    it.each([
      ['1', 1],
      ['300', 300],
      ['60', 60],
    ])('accepts mockFrames=%s', async (raw, expected) => {
      setSearch(`?testMode=true&mockFrames=${raw}`);
      const { getTestConfig, initTestMode } = await loadTestModeModule();
      initTestMode();
      expect(getTestConfig().defaultFrameCount).toBe(expected);
    });

    it.each(['0', '-5', '301', 'abc'])(
      'falls back to the default frame count (30) for out-of-range mockFrames=%s',
      async (raw) => {
        setSearch(`?testMode=true&mockFrames=${raw}`);
        const { getTestConfig, initTestMode } = await loadTestModeModule();
        initTestMode();
        expect(getTestConfig().defaultFrameCount).toBe(30);
      },
    );

    it.each(['15', '30', '60'])('accepts mockFps=%s', async (raw) => {
      setSearch(`?testMode=true&mockFps=${raw}`);
      const { getTestConfig, initTestMode } = await loadTestModeModule();
      initTestMode();
      expect(getTestConfig().defaultFps).toBe(Number(raw));
    });

    it.each(['24', '120', 'abc'])(
      'falls back to the default fps (30) for unsupported mockFps=%s',
      async (raw) => {
        setSearch(`?testMode=true&mockFps=${raw}`);
        const { getTestConfig, initTestMode } = await loadTestModeModule();
        initTestMode();
        expect(getTestConfig().defaultFps).toBe(30);
      },
    );

    it('accepts mockWidth within the [100, 3840] bound', async () => {
      setSearch('?testMode=true&mockWidth=1920');
      const { getTestConfig, initTestMode } = await loadTestModeModule();
      initTestMode();
      expect(getTestConfig().defaultWidth).toBe(1920);
    });

    it.each(['99', '3841', 'abc'])(
      'falls back to the default width (640) for out-of-range mockWidth=%s',
      async (raw) => {
        setSearch(`?testMode=true&mockWidth=${raw}`);
        const { getTestConfig, initTestMode } = await loadTestModeModule();
        initTestMode();
        expect(getTestConfig().defaultWidth).toBe(640);
      },
    );

    it('accepts mockHeight within the [100, 2160] bound', async () => {
      setSearch('?testMode=true&mockHeight=1080');
      const { getTestConfig, initTestMode } = await loadTestModeModule();
      initTestMode();
      expect(getTestConfig().defaultHeight).toBe(1080);
    });

    it.each(['99', '2161', 'abc'])(
      'falls back to the default height (480) for out-of-range mockHeight=%s',
      async (raw) => {
        setSearch(`?testMode=true&mockHeight=${raw}`);
        const { getTestConfig, initTestMode } = await loadTestModeModule();
        initTestMode();
        expect(getTestConfig().defaultHeight).toBe(480);
      },
    );
  });

  describe('getTestConfig / updateTestConfig round-trip', () => {
    it('getTestConfig returns a fresh copy — mutating the result does not affect internal state', async () => {
      // Arrange
      const { getTestConfig, initTestMode } = await loadTestModeModule();
      initTestMode();

      // Act
      const cfg1 = getTestConfig();
      cfg1.defaultFrameCount = 999;
      const cfg2 = getTestConfig();

      // Assert
      expect(cfg2.defaultFrameCount).toBe(30);
    });

    it('updateTestConfig merges a partial update into the current config', async () => {
      // Arrange
      const { getTestConfig, initTestMode, updateTestConfig } = await loadTestModeModule();
      initTestMode();

      // Act
      updateTestConfig({ defaultFrameCount: 99, defaultPattern: 'gradient' });
      const cfg = getTestConfig();

      // Assert
      expect(cfg.defaultFrameCount).toBe(99);
      expect(cfg.defaultPattern).toBe('gradient');
      // Untouched fields survive the merge
      expect(cfg.defaultFps).toBe(30);
      expect(cfg.defaultWidth).toBe(640);
    });

    it('updateTestConfig can flip `enabled` at runtime', async () => {
      // Arrange
      const { getTestConfig, initTestMode, updateTestConfig } = await loadTestModeModule();
      initTestMode();
      expect(getTestConfig().enabled).toBe(false);

      // Act
      updateTestConfig({ enabled: true });

      // Assert
      expect(getTestConfig().enabled).toBe(true);
    });

    it('reflects config parsed from the URL before any explicit update', async () => {
      // Arrange
      setSearch('?testMode=true&mockFrames=45');
      const { getTestConfig, initTestMode, updateTestConfig } = await loadTestModeModule();
      initTestMode();
      expect(getTestConfig().defaultFrameCount).toBe(45);

      // Act - update a different field
      updateTestConfig({ defaultPattern: 'checkerboard' });

      // Assert - URL-derived value is preserved across the update
      expect(getTestConfig().defaultFrameCount).toBe(45);
      expect(getTestConfig().defaultPattern).toBe('checkerboard');
    });
  });
});
