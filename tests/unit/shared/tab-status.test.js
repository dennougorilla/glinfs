import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emit } from '../../../src/shared/bus.js';
import { initTabStatus } from '../../../src/shared/tab-status.js';

const BASE_TITLE = 'Glinfs - Screen Capture to GIF';

describe('initTabStatus', () => {
  /** @type {() => void} */
  let stop;

  const icons = () =>
    [...document.querySelectorAll('link[rel~="icon"]')].map((l) => l.getAttribute('href'));

  /** @type {Set<(route: string) => void>} */
  let routeListeners;
  /** @param {string} route */
  const goTo = (route) => {
    for (const fn of routeListeners) fn(route);
  };
  const logoState = () => document.querySelector('.app-logo')?.getAttribute('data-state') ?? null;

  beforeEach(() => {
    routeListeners = new Set();
    document.body.innerHTML = '<a class="app-logo" href="#/capture"></a>';
    document.head.innerHTML = `
      <link rel="icon" href="/glinfs/favicon.ico" sizes="48x48">
      <link rel="icon" href="/glinfs/favicon.svg" type="image/svg+xml">`;
    document.title = BASE_TITLE;
    stop = initTabStatus(document, {
      getRoute: () => '/capture',
      subscribeRoute: (fn) => {
        routeListeners.add(fn);
        return () => routeListeners.delete(fn);
      },
    });
  });

  afterEach(() => {
    stop();
  });

  it('shows the edit icon in the editor and marks the header logo', () => {
    goTo('/editor');

    expect(icons()).toEqual(['/glinfs/favicon-edit.svg', '/glinfs/favicon-edit.svg']);
    expect(document.title).toBe(BASE_TITLE);
    expect(logoState()).toBe('edit');

    goTo('/capture');
    expect(icons()).toEqual(['/glinfs/favicon.ico', '/glinfs/favicon.svg']);
    expect(logoState()).toBeNull();
  });

  it('lets a live capture outrank editing, and an export outrank both', () => {
    goTo('/editor');
    emit('capture:started', {});
    expect(logoState()).toBe('recording');

    emit('export:started', {});
    expect(logoState()).toBe('busy');

    emit('export:closed', {});
    emit('capture:stopped', {});
    expect(logoState()).toBe('edit');
    expect(icons()[1]).toBe('/glinfs/favicon-edit.svg');
  });

  it('shows the recording icon and title while a capture is live', () => {
    emit('capture:started', {});

    expect(icons()).toEqual(['/glinfs/favicon-recording.svg', '/glinfs/favicon-recording.svg']);
    expect(document.title).toBe('● Recording - Glinfs');
  });

  it('restores the original icons and title when the capture stops', () => {
    emit('capture:started', {});
    emit('capture:stopped', {});

    expect(icons()).toEqual(['/glinfs/favicon.ico', '/glinfs/favicon.svg']);
    expect(document.title).toBe(BASE_TITLE);
  });

  it('shows export progress, then falls back to recording if the capture is still live', () => {
    emit('capture:restored', { fromNavigation: true });
    emit('export:started', {});
    expect(document.title).toBe('Exporting 0% - Glinfs');
    expect(icons()[1]).toBe('/glinfs/favicon-busy.svg');

    emit('export:progress', { percent: 41.6, frame: 10 });
    expect(document.title).toBe('Exporting 42% - Glinfs');

    emit('export:complete', {});
    expect(document.title).toBe('● Recording - Glinfs');
    expect(icons()[1]).toBe('/glinfs/favicon-recording.svg');
  });

  it('ignores progress that arrives after the export ended', () => {
    emit('export:started', {});
    emit('export:cancelled', {});
    emit('export:progress', { percent: 80, frame: 20 });

    expect(document.title).toBe(BASE_TITLE);
    expect(icons()).toEqual(['/glinfs/favicon.ico', '/glinfs/favicon.svg']);
  });

  it('stops following events and restores the original state when disposed', () => {
    emit('capture:started', {});
    stop();
    emit('capture:started', {});
    goTo('/editor');

    expect(document.title).toBe(BASE_TITLE);
    expect(logoState()).toBeNull();
    expect(icons()).toEqual(['/glinfs/favicon.ico', '/glinfs/favicon.svg']);
    stop = () => {};
  });
});
