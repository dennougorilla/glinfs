import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
