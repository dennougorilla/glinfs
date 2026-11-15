import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { announce, mountLiveRegion } from '../../../src/shared/live-region.js';

/**
 * The live region is for screen readers only. It used to have no
 * visually-hidden style, so every announcement was printed as plain text
 * under the app and made the page taller than the viewport.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

describe('mountLiveRegion', () => {
  it('creates one polite, atomic status region that is visually hidden', () => {
    const region = mountLiveRegion();

    expect(region.id).toBe('live-region');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.classList.contains('sr-only')).toBe(true);
    expect(region.parentElement).toBe(document.body);
  });

  it('returns the existing region instead of adding a second one', () => {
    const first = mountLiveRegion();
    expect(mountLiveRegion()).toBe(first);
    expect(document.querySelectorAll('#live-region')).toHaveLength(1);
  });

  it('is where announce() writes', () => {
    const region = mountLiveRegion();
    announce('Clip added to queue (1/3)');
    expect(region.textContent).toBe('Clip added to queue (1/3)');
  });
});

describe('the shared .sr-only rule it relies on', () => {
  it('takes the element out of the layout and clips it to nothing', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
    const rule = css.match(/(?:^|\n)\.sr-only\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/width:\s*1px/);
    expect(rule).toMatch(/height:\s*1px/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
  });
});
