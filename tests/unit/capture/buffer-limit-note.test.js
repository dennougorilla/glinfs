import { describe, expect, it } from 'vitest';
import { updateBufferStatus } from '../../../src/features/capture/ui.js';

/**
 * #231 review P3: the buffer is re-clamped while sharing (B5), so the
 * "Buffer limited" note must follow the live limit, not only a full render.
 */

function statsContainer() {
  const container = document.createElement('div');
  container.innerHTML = `<div class="capture-stats">${['Frames', 'Duration', 'FPS']
    .map(
      (label) =>
        `<div class="stat-item"><span class="stat-label">${label}</span><span class="stat-value">0</span></div>`,
    )
    .join('')}</div>`;
  return container;
}

const stats = { frameCount: 10, duration: 1, fps: 30 };
const note = (container) => container.querySelector('.capture-stats-limit-note');

describe('updateBufferStatus keeps the buffer-limit note current', () => {
  it('adds, updates and removes the note as the limit changes', () => {
    const container = statsContainer();

    updateBufferStatus(container, stats, {
      clamped: true,
      effectiveDuration: 10.2,
      maxFrames: 303,
    });
    expect(note(container)?.textContent).toBe('Buffer limited to ~10s by the memory budget');
    expect(note(container)?.parentElement?.className).toBe('capture-stats');

    updateBufferStatus(container, stats, { clamped: true, effectiveDuration: 6.4, maxFrames: 190 });
    expect(container.querySelectorAll('.capture-stats-limit-note')).toHaveLength(1);
    expect(note(container)?.textContent).toBe('Buffer limited to ~6s by the memory budget');

    updateBufferStatus(container, stats, { clamped: false, effectiveDuration: 15, maxFrames: 450 });
    expect(note(container)).toBeNull();
    expect(container.querySelectorAll('.stat-value')[0].textContent).toBe('10');
  });
});
