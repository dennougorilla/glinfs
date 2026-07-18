import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCurrentRoute,
  initRouter,
  navigate,
  onRouteChange,
} from '../../../src/shared/router.js';

describe('Router', () => {
  let originalHash;

  beforeEach(() => {
    originalHash = window.location.hash;
    window.location.hash = '';
    document.body.innerHTML = '<main id="main-content"></main>';
  });

  afterEach(() => {
    window.location.hash = originalHash;
    document.body.innerHTML = '';
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

    it('matches the route path when query parameters are present', async () => {
      const editorHandler = vi.fn();
      initRouter({
        '/capture': vi.fn(),
        '/editor': editorHandler,
        '/export': vi.fn(),
      });

      navigate('/editor', { source: 'settings', mode: 'crop' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(window.location.hash).toBe('#/editor?source=settings&mode=crop');
      expect(editorHandler).toHaveBeenCalled();
      expect(getCurrentRoute()).toBe('/editor');
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
      unsubscribe();
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
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
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
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up route'),
        expect.any(Error),
      );

      consoleError.mockRestore();
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

    it('falls back to capture when a route handler throws', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const captureHandler = vi.fn();
      const editorHandler = vi.fn(() => {
        throw new Error('Editor init failed');
      });

      initRouter({
        '/capture': captureHandler,
        '/editor': editorHandler,
        '/export': vi.fn(),
      });

      navigate('/editor');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(editorHandler).toHaveBeenCalled();
      expect(window.location.hash).toBe('#/capture');
      expect(captureHandler.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to initialize route'),
        expect.any(Error),
      );

      consoleError.mockRestore();
    });

    it('clears route-specific classes before mounting the next screen', async () => {
      const main = document.getElementById('main-content');
      main.className = 'settings-container';

      initRouter({
        '/capture': vi.fn(),
        '/editor': vi.fn(),
        '/export': vi.fn(),
      });

      navigate('/editor');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(main.className).toBe('');
    });

    it('continues notifying route listeners when one listener throws', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      initRouter({
        '/capture': vi.fn(),
        '/editor': vi.fn(),
        '/export': vi.fn(),
      });
      const unsubscribeFailing = onRouteChange(() => {
        throw new Error('Listener failed');
      });
      const healthyListener = vi.fn();
      const unsubscribeHealthy = onRouteChange(healthyListener);

      navigate('/editor');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(healthyListener).toHaveBeenCalledWith('/editor');
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Route listener failed'),
        expect.any(Error),
      );

      unsubscribeFailing();
      unsubscribeHealthy();
      consoleError.mockRestore();
    });
  });
});
