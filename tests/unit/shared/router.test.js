import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initRouter, navigate, getCurrentRoute, onRouteChange } from '../../../src/shared/router.js';

describe('Router', () => {
  let originalHash;

  beforeEach(() => {
    originalHash = window.location.hash;
    window.location.hash = '';
  });

  afterEach(() => {
    window.location.hash = originalHash;
  });

  describe('initRouter', () => {
    it('calls default route handler on init', () => {
      const captureHandler = vi.fn();
      const editorHandler = vi.fn();

      initRouter({
        '/capture': captureHandler,
        '/editor': editorHandler,
        '/export': vi.fn(),
      });

      // Wait for hashchange to process
      expect(captureHandler).toHaveBeenCalled();
    });
  });

  describe('getCurrentRoute', () => {
    it('returns current route', () => {
      initRouter({
        '/capture': vi.fn(),
        '/editor': vi.fn(),
        '/export': vi.fn(),
      });

      expect(getCurrentRoute()).toBe('/capture');
    });
  });

  describe('navigate', () => {
    it('changes hash to target route', () => {
      initRouter({
        '/capture': vi.fn(),
        '/editor': vi.fn(),
        '/export': vi.fn(),
      });

      navigate('/editor');

      expect(window.location.hash).toBe('#/editor');
    });
  });

  describe('onRouteChange', () => {
    it('returns unsubscribe function', () => {
      initRouter({
        '/capture': vi.fn(),
        '/editor': vi.fn(),
        '/export': vi.fn(),
      });

      const callback = vi.fn();
      const unsubscribe = onRouteChange(callback);

      expect(typeof unsubscribe).toBe('function');
    });
  });

  describe('cleanup on route change', () => {
    it('calls cleanup function when navigating away', async () => {
      const captureCleanup = vi.fn();
      const captureHandler = vi.fn(() => captureCleanup);
      const editorHandler = vi.fn();

      initRouter({
        '/capture': captureHandler,
        '/editor': editorHandler,
        '/export': vi.fn(),
      });

      // Navigate to editor
      navigate('/editor');

      // Wait for hashchange event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Cleanup should have been called
      expect(captureCleanup).toHaveBeenCalledOnce();
    });

    it('handles cleanup errors gracefully', async () => {
      const errorCleanup = vi.fn(() => {
        throw new Error('Cleanup error');
      });
      const captureHandler = vi.fn(() => errorCleanup);
      const editorHandler = vi.fn();

      initRouter({
        '/capture': captureHandler,
        '/editor': editorHandler,
        '/export': vi.fn(),
      });

      // Navigate - should not throw even if cleanup throws
      navigate('/editor');

      await new Promise((resolve) => setTimeout(resolve, 0));

      // Cleanup was called (even though it threw)
      expect(errorCleanup).toHaveBeenCalled();
      // Next handler should still be called
      expect(editorHandler).toHaveBeenCalled();
    });

    it('handles handlers that return undefined', async () => {
      const captureHandler = vi.fn(); // returns undefined
      const editorHandler = vi.fn();

      initRouter({
        '/capture': captureHandler,
        '/editor': editorHandler,
        '/export': vi.fn(),
      });

      // Should not throw
      navigate('/editor');

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(editorHandler).toHaveBeenCalled();
    });
  });
});
