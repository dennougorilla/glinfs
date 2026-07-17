import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCurrentRoute,
  getRouteParams,
  initRouter,
  navigate,
  onRouteChange,
} from '../../../src/shared/router.js';

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

  describe('query params in hash', () => {
    it('matches the route when the hash carries query params', async () => {
      const editorHandler = vi.fn();
      const captureHandler = vi.fn();

      initRouter({
        '/capture': captureHandler,
        '/editor': editorHandler,
      });
      captureHandler.mockClear();

      navigate('/editor', { frame: '5', mode: 'crop' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Previously '#/editor?frame=5' failed the route lookup and silently
      // fell back to '/capture'.
      expect(editorHandler).toHaveBeenCalledTimes(1);
      expect(captureHandler).not.toHaveBeenCalled();
      expect(getCurrentRoute()).toBe('/editor');
      expect(getRouteParams()).toEqual({ frame: '5', mode: 'crop' });
    });

    it('returns empty params for a plain route', async () => {
      initRouter({ '/capture': vi.fn(), '/editor': vi.fn() });

      navigate('/editor');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getRouteParams()).toEqual({});
    });
  });

  describe('error isolation', () => {
    it('continues navigation when the previous route cleanup throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const editorHandler = vi.fn();

      initRouter({
        '/capture': () => () => {
          throw new Error('cleanup boom');
        },
        '/editor': editorHandler,
      });

      navigate('/editor');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(editorHandler).toHaveBeenCalledTimes(1);
      expect(getCurrentRoute()).toBe('/editor');
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('notifies later route listeners when an earlier one throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      initRouter({ '/capture': vi.fn(), '/editor': vi.fn() });

      const healthy = vi.fn();
      const unsubThrowing = onRouteChange(() => {
        throw new Error('listener boom');
      });
      const unsubHealthy = onRouteChange(healthy);

      navigate('/editor');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(healthy).toHaveBeenCalledWith('/editor');
      expect(errorSpy).toHaveBeenCalled();

      unsubThrowing();
      unsubHealthy();
      errorSpy.mockRestore();
    });
  });

  describe('repeated initialization', () => {
    it('does not stack hashchange listeners across initRouter calls', async () => {
      const editorHandler = vi.fn();

      initRouter({ '/capture': vi.fn(), '/editor': vi.fn() });
      initRouter({ '/capture': vi.fn(), '/editor': editorHandler });

      navigate('/editor');
      await new Promise((resolve) => setTimeout(resolve, 0));

      // With stacked listeners the handler would run once per init call.
      expect(editorHandler).toHaveBeenCalledTimes(1);
    });
  });
});
