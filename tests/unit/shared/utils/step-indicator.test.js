import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateStepIndicator } from '../../../../src/shared/utils/step-indicator.js';

/** The header's step indicator: Capture → Edit (Export is an editor action) */
const MARKUP = `
  <nav class="step-indicator">
    <a href="#/capture" class="step" data-step="capture"></a>
    <span class="step-connector"></span>
    <a href="#/editor" class="step" data-step="editor"></a>
  </nav>`;

/** @param {string} step */
const classesOf = (step) =>
  [.../** @type {Element} */ (document.querySelector(`[data-step="${step}"]`)).classList].filter(
    (name) => name !== 'step',
  );

describe('updateStepIndicator', () => {
  beforeEach(() => {
    document.body.innerHTML = MARKUP;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('on Capture without frames: Capture active, Edit disabled', () => {
    updateStepIndicator('capture');
    expect(classesOf('capture')).toEqual(['step--active']);
    expect(classesOf('editor')).toEqual(['step--disabled']);
    expect(document.querySelector('.step-connector')?.classList).not.toContain(
      'step-connector--completed',
    );
  });

  it('on Capture with frames: Edit is reachable', () => {
    updateStepIndicator('capture', { hasFrames: true });
    expect(classesOf('editor')).toEqual([]);
  });

  it('while editing: Capture completed (and live while recording), Edit active', () => {
    updateStepIndicator('editor', { isCapturing: true });
    expect(classesOf('capture')).toEqual(['step--live', 'step--completed']);
    expect(classesOf('editor')).toEqual(['step--active']);
    expect(document.querySelector('.step-connector')?.classList).toContain(
      'step-connector--completed',
    );
  });

  it('has no Export step in the app shell', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const html = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8');
    expect(html).not.toContain('data-step="export"');
    expect(html).toContain('data-step="editor"');
  });
});
