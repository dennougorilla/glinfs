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
});
