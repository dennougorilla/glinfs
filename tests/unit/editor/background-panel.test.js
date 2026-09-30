/**
 * The Background tab ("What do you want to keep?"): subject cards, the
 * inline download question, the Fit mapping, the always-visible
 * adjustments, the fix-up tools, and a status slot that never moves the
 * controls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_REGISTRY } from '../../../src/features/ai-cutout/model-registry.js';
import {
  aiFromFit,
  canResetBackground,
  describeAiStatus,
  describeFit,
  FIT_STEPS,
  fitFromAi,
  getDownloadPrompt,
  getModelReadiness,
  getModelTooltip,
  getSubject,
  getSubjectModel,
  getWebgpuWarning,
  renderBackgroundPanel,
  SUBJECT_CARDS,
  updateBackgroundPanel,
} from '../../../src/features/editor/panels/background-panel.js';
import { createAiCutoutStatus, createBrushState } from '../../../src/features/editor/state.js';
import {
  createDefaultEdits,
  EDIT_LIMITS,
  normalizeEdits,
} from '../../../src/shared/edits/model.js';

/**
 * @param {Record<string, unknown>} [background]
 * @param {Record<string, unknown>} [over]
 */
function makeState(background = {}, over = {}) {
  return /** @type {any} */ ({
    clip: { frames: [], hasAlpha: false },
    currentFrame: 0,
    selectedRange: { start: 0, end: 0 },
    edits: normalizeEdits({ background }, 1),
    selectedTextId: null,
    pickingKeyColor: false,
    aiPickTool: null,
    aiCutout: createAiCutoutStatus(),
    brush: createBrushState(),
    downloadPrompt: null,
    ...over,
  });
}

/** @type {Record<string, import('vitest').Mock>} */
let handlers;
/** @type {HTMLElement} */
let root;

/**
 * @param {string} selector
 * @returns {any}
 */
const $ = (selector) => root.querySelector(selector);

/** @param {Element} el @param {string} type */
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

beforeEach(() => {
  handlers = {
    onChooseSubject: vi.fn(),
    onConfirmModelDownload: vi.fn(),
    onCancelModelDownload: vi.fn(),
    onSetBackground: vi.fn(),
    onSetPickingKeyColor: vi.fn(),
    onSetAiParams: vi.fn(),
    onSetAiPickTool: vi.fn(),
    onSetBrush: vi.fn(),
    onResetBackground: vi.fn(),
    onAiAnalyze: vi.fn(),
    onAiCancel: vi.fn(),
    onAiAllowWasm: vi.fn(),
    onRemoveAiPick: vi.fn(),
    onFrameChange: vi.fn(),
  };
  document.body.innerHTML = '';
  root = document.createElement('div');
  root.appendChild(renderBackgroundPanel(/** @type {any} */ (handlers)).element);
  document.body.appendChild(root);
});

describe('subjects', () => {
  it('maps the settings to a subject and each AI card to a registered model', () => {
    expect(getSubject(createDefaultEdits().background)).toBe('none');
    expect(getSubject(normalizeEdits({ background: { enabled: true } }, 1).background)).toBe(
      'color',
    );
    for (const [model, subject] of [
      ['anime', 'anime'],
      ['portrait', 'portrait'],
      ['general', 'general'],
    ]) {
      const { background } = normalizeEdits(
        { background: { enabled: true, method: 'ai', ai: { model } } },
        1,
      );
      expect(getSubject(background)).toBe(subject);
      expect(getSubjectModel(/** @type {any} */ (subject))).toBe(model);
    }
    expect(getSubjectModel('color')).toBeNull();
    expect(getSubjectModel('none')).toBeNull();
    const cardModels = SUBJECT_CARDS.map((card) => card.model).filter(Boolean);
    expect(cardModels.sort()).toEqual(MODEL_REGISTRY.map((entry) => entry.id).sort());
  });

  it('is one labelled radio group: Off and the four cards', () => {
    const group = $('#background-subject');
    expect(group.getAttribute('aria-labelledby')).toBe('background-subject-title');
    expect($('#background-subject-title').textContent).toBe('What do you want to keep?');
    const radios = [...group.querySelectorAll('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual(['none', 'anime', 'portrait', 'general', 'color']);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    for (const radio of radios) {
      expect(root.querySelector(`label[for="${radio.id}"]`)?.contains(radio)).toBe(true);
    }
  });

  it('checks the current subject and calls the handler on a choice', () => {
    updateBackgroundPanel(
      root,
      makeState({ enabled: true, method: 'ai', ai: { model: 'portrait' } }),
      10,
    );
    expect($('#subject-portrait').checked).toBe(true);
    expect($('#subject-none').checked).toBe(false);
    $('#subject-color').checked = true;
    fire($('#subject-color'), 'change');
    expect(handlers.onChooseSubject).toHaveBeenLastCalledWith('color');
    $('#subject-none').checked = true;
    fire($('#subject-none'), 'change');
    expect(handlers.onChooseSubject).toHaveBeenLastCalledWith('none');
  });

  it('shows each AI model as Ready or with its download size (tooltip: network, size, license)', () => {
    expect(getModelReadiness('anime', 'ready')).toMatchObject({ ready: true, text: 'Ready' });
    expect(getModelReadiness('anime', 'cached')).toMatchObject({ ready: true, text: 'Ready' });
    expect(getModelReadiness('anime', 'missing')).toEqual({
      ready: false,
      text: '↓ 88 MB',
      label: 'Download 88 MB',
    });
    expect(getModelReadiness('general', undefined).text).toBe('↓ 90 MB');
    expect(getModelTooltip('anime')).toContain('ISNet (isnet-anime) · 88 MB · Apache-2.0');

    updateBackgroundPanel(
      root,
      makeState(
        {},
        {
          aiCutout: { ...createAiCutoutStatus(), models: { anime: 'ready', portrait: 'missing' } },
        },
      ),
      10,
    );
    expect($('#subject-status-anime').textContent).toContain('Ready');
    expect($('#subject-status-anime').dataset.ready).toBe('true');
    expect($('#subject-status-portrait').textContent).toContain('13 MB');
    expect($('#subject-status-portrait .sr-only').textContent).toContain('Download 13 MB');
    expect($('#subject-anime').getAttribute('aria-describedby')).toBe('subject-status-anime');
    expect($('label[for="subject-anime"]').title).toContain('Apache-2.0');
  });
});

describe('download question', () => {
  it('asks inline before a download, with the asked card shown as chosen', () => {
    expect(getDownloadPrompt('general').title).toBe('Download 90 MB?');
    expect(getDownloadPrompt('general').detail).toContain('Anything model (ISNet)');

    updateBackgroundPanel(root, makeState({}, { downloadPrompt: 'general' }), 10);
    expect($('#background-download').hidden).toBe(false);
    expect($('#background-download-title').textContent).toBe('Download 90 MB?');
    expect($('#subject-general').checked).toBe(true);
    expect($('#background-settings').hidden).toBe(true);

    fire($('#background-download-confirm'), 'click');
    expect(handlers.onConfirmModelDownload).toHaveBeenCalled();
    fire($('#background-download-cancel'), 'click');
    expect(handlers.onCancelModelDownload).toHaveBeenCalled();

    updateBackgroundPanel(root, makeState(), 10);
    expect($('#background-download').hidden).toBe(true);
    expect($('#subject-none').checked).toBe(true);
  });
});

describe('Fit', () => {
  it('maps Tighter…Looser to threshold and edge together, 0 = the defaults', () => {
    expect(aiFromFit(0)).toEqual({ threshold: 0.5, edge: 0 });
    expect(aiFromFit(FIT_STEPS)).toEqual({ threshold: 0.1, edge: 5 });
    expect(aiFromFit(-FIT_STEPS)).toEqual({ threshold: 0.9, edge: -5 });
    expect(aiFromFit(1)).toEqual({ threshold: 0.46, edge: 1 });
    expect(aiFromFit(-3)).toEqual({ threshold: 0.62, edge: -2 });
    // Out of range and garbage are clamped
    expect(aiFromFit(99)).toEqual(aiFromFit(FIT_STEPS));
    expect(aiFromFit(Number.NaN)).toEqual(aiFromFit(0));
    for (let fit = -FIT_STEPS; fit <= FIT_STEPS; fit++) {
      const ai = aiFromFit(fit);
      expect(fitFromAi(ai)).toBe(fit);
      expect(ai.threshold).toBeGreaterThanOrEqual(EDIT_LIMITS.aiThreshold.min);
      expect(ai.threshold).toBeLessThanOrEqual(EDIT_LIMITS.aiThreshold.max);
      expect(Math.abs(ai.edge)).toBeLessThanOrEqual(EDIT_LIMITS.aiEdge.max);
    }
  });

  it('reads stored parameters from before the slider by their threshold', () => {
    expect(fitFromAi({ threshold: 0.3, edge: 0 })).toBe(5);
    expect(fitFromAi({ threshold: 0.95, edge: 3 })).toBe(-10);
    expect(fitFromAi({ threshold: 0.05, edge: -8 })).toBe(10);
    expect(describeFit(0)).toBe('Default');
    expect(describeFit(-4)).toBe('Tighter 4');
    expect(describeFit(2)).toBe('Looser 2');
  });

  it('is live while dragged and commits on release', () => {
    updateBackgroundPanel(root, makeState({ enabled: true, method: 'ai' }), 10);
    const fit = $('#ai-fit');
    expect(fit.value).toBe('0');
    expect(fit.getAttribute('aria-valuetext')).toContain('Default');
    fit.value = '4';
    fire(fit, 'input');
    expect(handlers.onSetAiParams).toHaveBeenLastCalledWith(aiFromFit(4), { live: true });
    fire(fit, 'change');
    expect(handlers.onSetAiParams).toHaveBeenLastCalledWith(aiFromFit(4));

    $('#ai-smoothing').checked = false;
    fire($('#ai-smoothing'), 'change');
    expect(handlers.onSetAiParams).toHaveBeenLastCalledWith({ smoothing: false });
  });
});

describe('AI status slot', () => {
  const status = createAiCutoutStatus();

  it('says what is going on in one line', () => {
    expect(
      describeAiStatus({
        running: true,
        pending: 5,
        analyzed: 1,
        total: 6,
        status: { ...status, phase: 'analyzing', framesDone: 1, framesTotal: 6 },
      }),
    ).toEqual({ kind: 'running', text: 'Analyzing 1 of 6 frames' });
    expect(describeAiStatus({ running: false, pending: 3, analyzed: 2, total: 5, status })).toEqual(
      { kind: 'pending', text: '3 frames not analyzed' },
    );
    expect(describeAiStatus({ running: false, pending: 0, analyzed: 5, total: 5, status })).toEqual(
      { kind: 'done', text: '5 of 5 frames analyzed' },
    );
    expect(describeAiStatus({ running: false, pending: 0, analyzed: 0, total: 0, status })).toEqual(
      { kind: 'empty', text: '' },
    );
  });

  it('keeps its place and size: states swap content, never insert or remove blocks', () => {
    const frames = [{ id: 'a', width: 4, height: 4 }];
    const base = { clip: { frames, hasAlpha: false } };
    updateBackgroundPanel(root, makeState({ enabled: true, method: 'ai' }, base), 10);
    const slot = $('#ai-status');
    const next = slot.nextElementSibling;
    expect(slot.dataset.kind).toBe('pending');
    expect($('#ai-analyze').hidden).toBe(false);
    expect($('#ai-cancel').hidden).toBe(true);

    updateBackgroundPanel(
      root,
      makeState(
        { enabled: true, method: 'ai' },
        {
          ...base,
          aiCutout: {
            ...status,
            phase: 'analyzing',
            framesDone: 0,
            framesTotal: 1,
            building: true,
          },
        },
      ),
      10,
    );
    expect(slot.dataset.kind).toBe('running');
    expect($('#ai-status-text').textContent).toBe('Analyzing 0 of 1 frames');
    expect($('#ai-cancel').hidden).toBe(false);
    expect($('#ai-analyze').hidden).toBe(true);
    expect($('#ai-progress-bar').hidden).toBe(false);
    // Same element, same neighbour: nothing was added above the sliders
    expect($('#ai-status')).toBe(slot);
    expect(slot.nextElementSibling).toBe(next);
    expect($('#ai-section').textContent).not.toContain('Updating');

    fire($('#ai-cancel'), 'click');
    expect(handlers.onAiCancel).toHaveBeenCalled();
  });

  it('labels Analyze with the download when the model is not ready', () => {
    const frames = [{ id: 'a', width: 4, height: 4 }];
    updateBackgroundPanel(
      root,
      makeState({ enabled: true, method: 'ai' }, { clip: { frames, hasAlpha: false } }),
      10,
    );
    expect($('#ai-analyze').textContent).toBe('Analyze (↓ 88 MB)');
    expect($('#ai-analyze').getAttribute('aria-label')).toBe('Analyze 1 frame (downloads 88 MB)');
    fire($('#ai-analyze'), 'click');
    expect(handlers.onAiAnalyze).toHaveBeenCalled();
  });

  it('warns without WebGPU (with the CPU choice) and shows errors with Try again', () => {
    expect(getWebgpuWarning({ needsWasmChoice: true, webgpuModelFailed: true }, 'General')).toMatch(
      /^The General model could not run on WebGPU/,
    );
    expect(
      getWebgpuWarning({ needsWasmChoice: true, webgpuModelFailed: false }, 'General'),
    ).toMatch(/^This needs WebGPU/);
    updateBackgroundPanel(
      root,
      makeState(
        { enabled: true, method: 'ai' },
        {
          aiCutout: {
            ...status,
            webgpu: false,
            phase: 'error',
            error: { code: 'x', message: 'Boom.' },
          },
        },
      ),
      10,
    );
    expect($('#ai-webgpu-warning').hidden).toBe(false);
    expect($('#ai-error').hidden).toBe(false);
    expect($('#ai-error-text').textContent).toBe('Boom.');
    fire($('#ai-run-wasm'), 'click');
    expect(handlers.onAiAllowWasm).toHaveBeenCalled();
    fire($('#ai-retry'), 'click');
    expect(handlers.onAiAnalyze).toHaveBeenCalled();
  });
});

describe('color key', () => {
  it('shows the key color, similar colors and Edges only / Everywhere; the eyedropper is a tool', () => {
    updateBackgroundPanel(
      root,
      makeState(
        { enabled: true, color: '#abcdef', tolerance: 33.4, mode: 'global' },
        { pickingKeyColor: true, clip: { frames: [], hasAlpha: true } },
      ),
      10,
    );
    expect($('#subject-color').checked).toBe(true);
    expect($('#color-section').hidden).toBe(false);
    expect($('#ai-section').hidden).toBe(true);
    expect($('#background-color').value).toBe('#abcdef');
    expect($('#background-color-hex').textContent).toBe('#ABCDEF');
    expect($('#background-pick').checked).toBe(true);
    expect($('label[for="background-pick"]').classList.contains('is-active')).toBe(true);
    expect($('#background-tolerance').value).toBe('33');
    expect($('#background-mode-global').checked).toBe(true);
    expect($('#background-alpha-note').hidden).toBe(false);
    // Keep/Remove belong to the AI
    expect($('label[for="ai-pick-keep"]').hidden).toBe(true);
  });

  it('controls call the background handlers', () => {
    $('#background-color').value = '#ff00ff';
    fire($('#background-color'), 'input');
    expect(handlers.onSetBackground).toHaveBeenLastCalledWith({ color: '#ff00ff' });
    $('#background-pick').checked = true;
    fire($('#background-pick'), 'change');
    expect(handlers.onSetPickingKeyColor).toHaveBeenCalledWith(true);
    $('#background-tolerance').value = '70';
    fire($('#background-tolerance'), 'input');
    expect(handlers.onSetBackground).toHaveBeenLastCalledWith({ tolerance: 70 });
    $('#background-mode-global').checked = true;
    fire($('#background-mode-global'), 'change');
    expect(handlers.onSetBackground).toHaveBeenLastCalledWith({ mode: 'global' });
  });
});

describe('fix-up tools', () => {
  it('Keep / Remove / Brush / Reset, with the active tool marked', () => {
    const state = makeState(
      { enabled: true, method: 'ai', ai: { picks: [{ frame: 0, x: 0.5, y: 0.5, mode: 'keep' }] } },
      { aiPickTool: 'remove' },
    );
    updateBackgroundPanel(root, state, 10);
    expect($('#ai-pick-remove').checked).toBe(true);
    expect($('label[for="ai-pick-remove"]').classList.contains('is-active')).toBe(true);
    expect($('label[for="ai-pick-keep"]').classList.contains('is-active')).toBe(false);
    expect($('#ai-pick-list').hidden).toBe(false);
    expect($('#ai-pick-list').textContent).toContain('Keep at');
    expect($('#background-reset').disabled).toBe(false);

    $('#ai-pick-keep').checked = true;
    fire($('#ai-pick-keep'), 'change');
    expect(handlers.onSetAiPickTool).toHaveBeenLastCalledWith('keep', expect.any(Object));
    $('#touchup-brush').checked = true;
    fire($('#touchup-brush'), 'change');
    expect(handlers.onSetBrush).toHaveBeenLastCalledWith({ on: true });
    fire($('#background-reset'), 'click');
    expect(handlers.onResetBackground).toHaveBeenCalled();
    fire($('.editor-cutout-pick-delete'), 'click');
    expect(handlers.onRemoveAiPick).toHaveBeenCalledWith(0);
  });

  it('Reset is available only when something differs from the defaults', () => {
    expect(canResetBackground(makeState({ enabled: true, method: 'ai' }))).toBe(false);
    expect(canResetBackground(makeState({ enabled: true, method: 'ai', ai: { edge: 2 } }))).toBe(
      true,
    );
    expect(canResetBackground(makeState({ enabled: true, colorChosen: false }))).toBe(false);
    expect(canResetBackground(makeState({ enabled: true, colorChosen: true }))).toBe(true);
    expect(
      canResetBackground(makeState({ enabled: true, colorChosen: false, tolerance: 50 })),
    ).toBe(true);
    const withStroke = makeState({ enabled: true, colorChosen: false });
    withStroke.edits = { ...withStroke.edits, touchUps: [{ id: 's' }] };
    expect(canResetBackground(withStroke)).toBe(true);
  });

  it('every control has an accessible name', () => {
    updateBackgroundPanel(root, makeState({ enabled: true, method: 'ai' }), 10);
    for (const control of root.querySelectorAll('input, button')) {
      const id = control.id;
      const named =
        control.getAttribute('aria-label') ||
        (id && root.querySelector(`label[for="${id}"]`)) ||
        control.closest('label') ||
        control.textContent?.trim();
      expect(named, id || control.outerHTML).toBeTruthy();
    }
  });
});
