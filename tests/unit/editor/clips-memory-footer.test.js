import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSharedMaskStore } from '../../../src/features/ai-cutout/mask-store.js';
import { updateClipsMemoryFooter } from '../../../src/features/editor/ui.js';
import {
  getHeldMemoryMB,
  RING_BUFFER_HOLDER,
  registerMemoryHolder,
  resetAppStore,
  setClipPayload,
} from '../../../src/shared/app-store.js';
import { SETTINGS_METADATA } from '../../../src/shared/user-settings.js';
import { formatMemory } from '../../../src/shared/utils/memory-monitor.js';

/**
 * The Clips footer shows the number the budget checks compare (memory
 * accounting PR A): the held total, ring buffer included, in the unit the
 * Settings slider shows.
 */

/** @type {Array<() => void>} */
let unregister = [];

beforeEach(() => {
  resetAppStore();
  localStorage.clear();
  getSharedMaskStore().clear();
  document.body.innerHTML = '<div id="c"><p data-clips-footer></p></div>';
});

afterEach(() => {
  for (const off of unregister) off();
  unregister = [];
  document.body.innerHTML = '';
});

describe('Clips memory footer', () => {
  it('shows the held total, ring buffer included, against the budget', () => {
    setClipPayload({
      frames: [
        { id: 'a', frame: { close() {}, closed: false }, timestamp: 0, width: 1000, height: 500 },
      ],
      fps: 30,
      capturedAt: 0,
    });
    unregister.push(registerMemoryHolder(RING_BUFFER_HOLDER, () => 2400));
    const container = /** @type {HTMLElement} */ (document.getElementById('c'));

    updateClipsMemoryFooter(container);

    const text = container.querySelector('[data-clips-footer]')?.textContent ?? '';
    expect(getHeldMemoryMB()).toBeCloseTo(2402, 6);
    expect(text.startsWith(`~${formatMemory(2402)} / 4.0 GB`)).toBe(true);
  });

  it('writes the budget the way the Settings slider does', () => {
    const { format } = SETTINGS_METADATA.capture.settings.memoryBudgetMB;
    for (const value of [500, 1000, 1500, 4000, 16000]) {
      expect(format(value)).toBe(formatMemory(value));
    }
  });
});
