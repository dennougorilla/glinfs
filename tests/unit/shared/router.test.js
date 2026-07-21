import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCurrentRoute,
  getPreviousRoute,
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

  describe('route handler failure recovery', () => {
    it('falls back to /capture when a route handler throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const captureHandler = vi.fn();

      initRouter({
        '/capture': captureHandler,
        '/editor': () => {
          throw new Error('handler boom');
        },
      });
      captureHandler.mockClear();

      navigate('/editor');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Previously the exception escaped the hashchange listener and left
      // the app on a blank, half-initialized screen
      expect(captureHandler).toHaveBeenCalled();
      expect(getCurrentRoute()).toBe('/capture');
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('renders a static message instead of looping when /capture itself fails', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const main = document.createElement('div');
      main.id = 'main-content';
      document.body.appendChild(main);

      initRouter({
        '/capture': () => {
          throw new Error('capture boom');
        },
      });

      expect(main.textContent).toContain('reload the page');

      main.remove();
      errorSpy.mockRestore();
    });
  });

  describe('container class reset', () => {
    it('clears route-specific classes from #main-content before mounting', async () => {
      const main = document.createElement('div');
      main.id = 'main-content';
      document.body.appendChild(main);

      initRouter({
        '/capture': vi.fn(),
        '/settings': () => {
          // Mimic the Settings screen, which sets a container class and
          // never resets it in its cleanup
          main.className = 'settings-container';
        },
        '/editor': vi.fn(),
      });

      navigate('/settings');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(main.className).toBe('settings-container');

      navigate('/editor');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(main.className).toBe('');

      main.remove();
    });
  });

  describe('getPreviousRoute', () => {
    it('reports the route that was active before the current one', async () => {
      initRouter({
        '/capture': vi.fn(),
        '/editor': vi.fn(),
        '/settings': vi.fn(),
      });

      navigate('/editor');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getPreviousRoute()).toBe('/capture');

      navigate('/settings');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getPreviousRoute()).toBe('/editor');
    });
  });

  describe('repeated initialization', () => {
    it('does not stack hashchange listeners across initRouter calls', () => {
      // Count actual registrations: a handler-call-count assertion would be
      // masked by the same-hash dedup in handleHashChange.
      const addSpy = vi.spyOn(window, 'addEventListener');

      initRouter({ '/capture': vi.fn(), '/editor': vi.fn() });
      initRouter({ '/capture': vi.fn(), '/editor': vi.fn() });
      initRouter({ '/capture': vi.fn(), '/editor': vi.fn() });

      const hashchangeRegistrations = addSpy.mock.calls.filter(
        ([type]) => type === 'hashchange',
      ).length;
      // The module-level listener may have been registered by an earlier
      // test's init; within this spy's window at most one registration
      // may occur, never one per init call.
      expect(hashchangeRegistrations).toBeLessThanOrEqual(1);

      addSpy.mockRestore();
    });

    it('runs the previous route cleanup when re-initialized', () => {
      const cleanup = vi.fn();
      initRouter({ '/capture': () => cleanup, '/editor': vi.fn() });
      expect(cleanup).not.toHaveBeenCalled();

      initRouter({ '/capture': vi.fn(), '/editor': vi.fn() });

      // Re-init must tear down the mounted route's session (timers,
      // subscriptions) instead of silently dropping its cleanup.
      expect(cleanup).toHaveBeenCalledTimes(1);
    });
  });
});
