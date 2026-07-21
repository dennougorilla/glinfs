import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSettings } from '../../../src/features/settings/index.js';

describe('initSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<main id="main-content"></main>';
  });

  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('renders without throwing when called with no arguments (router contract)', () => {
    // Regression for #36: the router calls route handlers with no arguments,
    // but initSettings required a container and crashed with a TypeError.
    expect(() => initSettings()).not.toThrow();

    const container = document.getElementById('main-content');
    expect(container.classList.contains('settings-container')).toBe(true);
    expect(container.children.length).toBeGreaterThan(0);
  });

  it('returns a cleanup function', () => {
    const cleanup = initSettings();
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });

  it('does not attach expando properties to the container', () => {
    initSettings();
    const container = document.getElementById('main-content');
    expect(container._onBack).toBeUndefined();
  });

  it('throws a descriptive error when #main-content is missing', () => {
    document.body.innerHTML = '';
    expect(() => initSettings()).toThrow('Required element not found: #main-content');
  });
});

describe('initSettings back navigation', () => {
  let originalHash;

  beforeEach(() => {
    originalHash = window.location.hash;
    window.location.hash = '';
    localStorage.clear();
    document.body.innerHTML = '<main id="main-content"></main>';
  });

  afterEach(() => {
    window.location.hash = originalHash;
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('returns to the route the user came from, not a hardcoded destination', async () => {
    // Regression: onBack always navigated to '/capture', so opening
    // Settings from the Editor (or Export) stranded the user on Capture
    // instead of returning them to where the gear icon was clicked.
    const { initRouter, navigate } = await import('../../../src/shared/router.js');

    initRouter({
      '/capture': vi.fn(),
      '/editor': vi.fn(),
      '/settings': initSettings,
    });

    navigate('/editor');
    await new Promise((resolve) => setTimeout(resolve, 0));

    navigate('/settings');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const backBtn = document.querySelector('.settings-header button');
    backBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toBe('#/editor');
  });

  it('falls back to /capture when settings is entered directly', async () => {
    const { initRouter } = await import('../../../src/shared/router.js');

    initRouter({
      '/capture': vi.fn(),
      '/settings': initSettings,
    });

    window.location.hash = '#/settings';
    await new Promise((resolve) => setTimeout(resolve, 0));

    const backBtn = document.querySelector('.settings-header button');
    backBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toBe('#/capture');
  });
});
