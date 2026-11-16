/**
 * The Background tab ("What do you want to keep?"): subject cards, the
 * inline download question, the Fit mapping, the always-visible
 * adjustments, the fix-up tools, and a status slot that never moves the
 * controls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_REGISTRY } from '../../../src/features/ai-cutout/model-registry.js';
import { OBJECT_COLORS } from '../../../src/features/editor/object-colors.js';
import {
  aiFromFit,
  canResetBackground,
  describeAiStatus,
  describeClickStatus,
  describeFit,
  FIT_STEPS,
  fitFromAi,
  getCleanupChips,
  getColourGuard,
  getDownloadPrompt,
  getLostFramesInSelection,
  getLostFramesText,
  getLostObject,
  getModelOptionLabel,
  getModelReadiness,
  getModelSubject,
  getModelTooltip,
  getObjectLabel,
  getObjectLostText,
  getSubject,
  getSubjectModel,
  getSubjectModels,
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
    onChooseModel: vi.fn(),
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
    onGoToLostFrame: vi.fn(),
    onGoToObject: vi.fn(),
    onHighlightAiObject: vi.fn(),
    onGoToObjectLost: vi.fn(),
    onRemoveAiObject: vi.fn(),
    onSetAiObjectScope: vi.fn(),
    onSetAiObjectTolerance: vi.fn(),
    onGoToColourGuard: vi.fn(),
    onApplyCleanup: vi.fn(),
    onClearCleanup: vi.fn(),
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
      ['video-person', 'portrait'],
      ['general', 'general'],
      ['ben2', 'general'],
    ]) {
      const { background } = normalizeEdits(
        { background: { enabled: true, method: 'ai', ai: { model } } },
        1,
      );
      expect(getSubject(background)).toBe(subject);
      // The subject keeps the model chosen for it
      expect(getSubjectModel(/** @type {any} */ (subject), background.ai)).toBe(model);
    }
    // Without a choice for it (or another subject's model): the default
    expect(getSubjectModel('portrait')).toBe('portrait');
    // (nothing remembered or downloaded: the first-run default, BEN2, where the card has it)
    expect(getSubjectModel('general', { model: 'video-person' })).toBe('ben2');
    expect(getSubjectModel('anime', { model: 'ben2' })).toBe('anime');
    expect(getSubjectModel('color')).toBeNull();
    expect(getSubjectModel('none')).toBeNull();
    // (a development build, as in these tests, also offers the BiRefNet models)
    expect(getSubjectModels('general')).toEqual([
      'general',
      'ben2',
      'birefnet-general',
      'birefnet-lite',
    ]);
    expect(getSubjectModels('anime')).toEqual([
      'anime',
      'birefnet-general',
      'birefnet-lite',
      'birefnet-toonout',
    ]);
    expect(getSubjectModels('portrait')).toEqual(['portrait', 'video-person']);
    expect(getSubjectModels('color')).toEqual([]);
    // Every registered model is on a card, each card's default first; only
    // BiRefNet general and lite are on two cards (Anime and Anything)
    const cardModels = SUBJECT_CARDS.flatMap((card) => card.models);
    expect([...new Set(cardModels)].sort()).toEqual(MODEL_REGISTRY.map((entry) => entry.id).sort());
    expect(cardModels.filter((id, i) => cardModels.indexOf(id) !== i).sort()).toEqual([
      'birefnet-general',
      'birefnet-lite',
    ]);
    for (const card of SUBJECT_CARDS) {
      expect(card.models[0] ?? null).toBe(card.model);
    }
  });

  it('keeps the card a shared model was chosen with', () => {
    const background = (/** @type {Record<string, unknown>} */ ai) =>
      normalizeEdits({ background: { enabled: true, method: 'ai', ai } }, 1).background;
    // Chosen on Anything, it stays on Anything; edits without a card use the first card
    expect(getSubject(background({ model: 'birefnet-general', subject: 'general' }))).toBe(
      'general',
    );
    expect(getSubject(background({ model: 'birefnet-lite', subject: 'anime' }))).toBe('anime');
    expect(getSubject(background({ model: 'birefnet-general' }))).toBe('anime');
    // A card that does not list the model is ignored
    expect(getSubject(background({ model: 'birefnet-toonout', subject: 'general' }))).toBe('anime');
    expect(getSubject(background({ model: 'ben2', subject: 'anime' }))).toBe('general');
    expect(getModelSubject('birefnet-lite', 'general')).toBe('general');
    expect(getModelSubject('birefnet-lite')).toBe('anime');
    expect(getModelSubject('nope')).toBeNull();
    // The clip's shared model is the model of both cards
    const ai = background({ model: 'birefnet-general', subject: 'general' }).ai;
    expect(getSubjectModel('anime', ai)).toBe('birefnet-general');
    expect(getSubjectModel('general', ai)).toBe('birefnet-general');
  });

  it('starts a subject with the remembered, else a downloaded, else the first-run model (#187)', () => {
    const anime = { model: 'anime' };
    // The clip's own model wins when the card can use it
    expect(getSubjectModel('general', { model: 'general' }, { remembered: { last: 'ben2' } })).toBe(
      'general',
    );
    // Remembered: per subject, then the last choice overall
    expect(
      getSubjectModel('general', anime, {
        remembered: { last: 'ben2', bySubject: { general: 'general' } },
        availability: { ben2: 'cached' },
      }),
    ).toBe('general');
    expect(getSubjectModel('general', anime, { remembered: { last: 'ben2' } })).toBe('ben2');
    expect(getSubjectModel('portrait', anime, { remembered: { last: 'ben2' } })).toBe('portrait');
    // Downloaded before not downloaded
    expect(
      getSubjectModel('general', anime, { availability: { general: 'ready', ben2: 'missing' } }),
    ).toBe('general');
    expect(
      getSubjectModel('portrait', anime, {
        availability: { portrait: 'missing', 'video-person': 'cached' },
      }),
    ).toBe('video-person');
    // Nothing downloaded: BEN2 on its card, else the card's default
    expect(getSubjectModel('general', anime, { availability: { general: 'missing' } })).toBe(
      'ben2',
    );
    expect(getSubjectModel('portrait', anime, { availability: {} })).toBe('portrait');
  });

  it('is one labelled radio group: Off and the five cards', () => {
    const group = $('#background-subject');
    expect(group.getAttribute('aria-labelledby')).toBe('background-subject-title');
    expect($('#background-subject-title').textContent).toBe('What do you want to keep?');
    const radios = [...group.querySelectorAll('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual([
      'none',
      'anime',
      'portrait',
      'general',
      'click',
      'color',
    ]);
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

describe('model choice', () => {
  it('offers the models of a subject that can use several, with size and readiness', () => {
    expect(getModelOptionLabel('ben2')).toBe('Hair & detail · BEN2 · 223 MB');
    updateBackgroundPanel(
      root,
      makeState(
        { enabled: true, method: 'ai', ai: { model: 'ben2' } },
        { aiCutout: { ...createAiCutoutStatus(), models: { general: 'ready' } } },
      ),
      10,
    );
    expect($('#subject-general').checked).toBe(true);
    expect($('#ai-model-row').hidden).toBe(false);
    const select = $('#ai-model');
    expect([...select.options].map((o) => o.value)).toEqual([
      'general',
      'ben2',
      'birefnet-general',
      'birefnet-lite',
    ]);
    expect(select.value).toBe('ben2');
    expect(select.options[0].textContent).toBe('General · ISNet · 90 MB');
    expect(select.options[1].textContent).toBe('Hair & detail · BEN2 · 223 MB (download)');
    expect(select.options[2].textContent).toBe('Busy backgrounds · BiRefNet · 519 MB (download)');
    expect(select.options[3].textContent).toBe(
      'Busy backgrounds, faster · BiRefNet lite · 122 MB (download)',
    );
    expect($('#ai-model-hint').textContent).toContain('MIT');
    expect($('label[for="ai-model"]').textContent).toBe('Model');
    // The card says what its current model needs
    expect($('#subject-status-general').textContent).toContain('223 MB');

    select.value = 'general';
    fire(select, 'change');
    expect(handlers.onChooseModel).toHaveBeenLastCalledWith('general');
  });

  it('is hidden for a subject with one model', () => {
    updateBackgroundPanel(
      root,
      makeState({ enabled: true, method: 'ai', ai: { model: 'click' } }),
      10,
    );
    expect($('#ai-model-row').hidden).toBe(true);
    // Anime offers BiRefNet in a development build, ToonOut on Anime only
    updateBackgroundPanel(
      root,
      makeState({ enabled: true, method: 'ai', ai: { model: 'birefnet-toonout' } }),
      10,
    );
    expect($('#subject-anime').checked).toBe(true);
    expect([...$('#ai-model').options].map((o) => o.value)).toEqual([
      'anime',
      'birefnet-general',
      'birefnet-lite',
      'birefnet-toonout',
    ]);
    expect($('#ai-model').value).toBe('birefnet-toonout');
    updateBackgroundPanel(
      root,
      makeState({ enabled: true, method: 'ai', ai: { model: 'video-person' } }),
      10,
    );
    expect($('#ai-model-row').hidden).toBe(false);
    expect([...$('#ai-model').options].map((o) => o.value)).toEqual(['portrait', 'video-person']);
    expect($('#ai-model').value).toBe('video-person');
  });

  it('asks before a download of an alternative model on its subject’s card', () => {
    updateBackgroundPanel(root, makeState({}, { downloadPrompt: 'ben2' }), 10);
    expect($('#subject-general').checked).toBe(true);
    expect($('#background-download-title').textContent).toBe('Download 223 MB?');
    expect($('#background-download-detail').textContent).toContain('Anything model (BEN2)');
    expect($('#subject-status-general').textContent).toContain('223 MB');
  });

  it('asks on the card a shared model was chosen for', () => {
    updateBackgroundPanel(
      root,
      makeState({}, { downloadPrompt: 'birefnet-lite', downloadPromptSubject: 'general' }),
      10,
    );
    expect($('#subject-general').checked).toBe(true);
    expect($('#subject-anime').checked).toBe(false);
    expect($('#background-download-title').textContent).toBe('Download 122 MB?');
    expect($('#background-download-detail').textContent).toContain(
      'Anything model (BiRefNet lite)',
    );
    updateBackgroundPanel(
      root,
      makeState({}, { downloadPrompt: 'birefnet-lite', downloadPromptSubject: 'anime' }),
      10,
    );
    expect($('#subject-anime').checked).toBe(true);
    expect($('#background-download-detail').textContent).toContain('Anime model (BiRefNet lite)');
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

  it('offers no CPU choice for a WebGPU-only model (BiRefNet): it says to choose another', () => {
    expect(
      getWebgpuWarning(
        { needsWasmChoice: true, webgpuModelFailed: false },
        'Busy backgrounds',
        true,
      ),
    ).toBe(
      'The Busy backgrounds model needs WebGPU, which this browser does not provide, and it is too large to run on the CPU. Choose another model.',
    );
    expect(
      getWebgpuWarning(
        { needsWasmChoice: true, webgpuModelFailed: true },
        'Busy backgrounds',
        true,
      ),
    ).toMatch(/could not run on WebGPU in this browser, and it is too large to run on the CPU/);
    for (const wasmAllowed of [false, true]) {
      updateBackgroundPanel(
        root,
        makeState(
          { enabled: true, method: 'ai', ai: { model: 'birefnet-general', subject: 'general' } },
          { aiCutout: { ...status, webgpu: false, wasmAllowed } },
        ),
        10,
      );
      expect(root.querySelector('#ai-webgpu-warning')?.hasAttribute('hidden')).toBe(false);
      expect(root.querySelector('#ai-webgpu-warning-text')?.textContent).toMatch(
        /needs WebGPU.*Choose another model/,
      );
      expect(root.querySelector('#ai-run-wasm')?.hasAttribute('hidden')).toBe(true);
      // Nothing to analyze with, and the refusal is said once
      expect(root.querySelector('#ai-analyze')?.hasAttribute('hidden')).toBe(true);
    }
    updateBackgroundPanel(
      root,
      makeState(
        { enabled: true, method: 'ai', ai: { model: 'birefnet-general', subject: 'general' } },
        {
          aiCutout: {
            ...status,
            webgpu: false,
            needsWasmChoice: false,
            phase: 'error',
            error: { code: 'webgpu-required', message: 'Busy backgrounds needs WebGPU' },
          },
        },
      ),
      10,
    );
    expect(root.querySelector('#ai-error')?.hasAttribute('hidden')).toBe(true);
    // Other models keep the CPU choice
    updateBackgroundPanel(
      root,
      makeState(
        { enabled: true, method: 'ai', ai: { model: 'general', subject: 'general' } },
        { aiCutout: { ...status, webgpu: false } },
      ),
      10,
    );
    expect(root.querySelector('#ai-run-wasm')?.hasAttribute('hidden')).toBe(false);
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

describe('click to select ("Something else")', () => {
  const clickState = (/** @type {Record<string, unknown>} */ ai = {}, over = {}) =>
    makeState({ enabled: true, method: 'ai', ai: { model: 'click', ...ai } }, over);

  it('has its own card with a download question naming the model', () => {
    const card = SUBJECT_CARDS.find((c) => c.value === 'click');
    expect(card).toMatchObject({
      label: 'Something else',
      hint: 'Click it to select',
      model: 'click',
    });
    expect(getSubject(clickState().edits.background)).toBe('click');
    expect(getSubjectModel('click')).toBe('click');
    expect(getDownloadPrompt('click')).toEqual({
      title: 'Download 45 MB?',
      detail:
        'The Click to select model (MobileSAM) runs in this browser. It downloads once and stays on this device; your frames never leave it.',
    });
  });

  it('describes the status: a click first, then tracking, lost frames and done', () => {
    const status = createAiCutoutStatus();
    const base = { running: false, pending: 5, tracked: 0, selection: 5, clicks: 0, status };
    expect(describeClickStatus(base)).toEqual({
      kind: 'hint',
      text: 'Click the thing you want to keep',
    });
    expect(
      describeClickStatus({
        ...base,
        running: true,
        status: { ...status, phase: 'analyzing', framesDone: 2, framesTotal: 5 },
      }),
    ).toEqual({ kind: 'running', text: 'Tracking 2 of 5 frames' });
    expect(describeClickStatus({ ...base, clicks: 1, pending: 2, tracked: 3 })).toEqual({
      kind: 'pending',
      text: '2 frames not tracked',
    });
    expect(
      describeClickStatus({
        ...base,
        clicks: 1,
        pending: 2,
        tracked: 3,
        status: { ...status, lostFrames: [3] },
      }),
    ).toEqual({ kind: 'pending', text: '3 of 5 frames tracked' });
    expect(describeClickStatus({ ...base, clicks: 1, pending: 0, tracked: 5 })).toEqual({
      kind: 'done',
      text: 'Tracked through 5 frames',
    });
  });

  it('says where tracking lost the object', () => {
    expect(getLostFramesText([], 10)).toBe('');
    expect(getLostFramesText([20], 10)).toMatch(
      /^Lost track at .+\. Click it there to keep going\.$/,
    );
    expect(getLostFramesText([20, 31], 10)).toMatch(/^Lost track at 2 places, first at /);
  });

  it('shows Whole / Part once something is clicked, and the lost note with Go there', () => {
    updateBackgroundPanel(root, clickState(), 10);
    expect($('#ai-click-scope').hidden).toBe(true);
    expect($('#ai-status-text').textContent).toBe('Click the thing you want to keep');
    expect($('#ai-analyze').hidden).toBe(true);
    expect($('#background-tools-hint').textContent).toBe(
      'Click the thing you want to keep in the preview.',
    );

    const picked = clickState(
      { picks: [{ frame: 0, x: 0.5, y: 0.5, mode: 'keep' }], clickScope: 'part' },
      { aiCutout: { ...createAiCutoutStatus(), lostFrames: [0] } },
    );
    updateBackgroundPanel(root, picked, 10);
    expect($('#ai-click-scope').hidden).toBe(false);
    expect($('#ai-click-scope-part').checked).toBe(true);
    expect($('#ai-click-scope-whole').checked).toBe(false);
    expect($('#ai-click-lost').hidden).toBe(false);
    expect($('#ai-click-lost-text').textContent).toMatch(/^Lost track at /);
    fire($('#ai-click-lost-go'), 'click');
    expect(handlers.onGoToLostFrame).toHaveBeenCalled();
    $('#ai-click-scope-whole').checked = true;
    fire($('#ai-click-scope-whole'), 'change');
    expect(handlers.onSetAiParams).toHaveBeenLastCalledWith({ clickScope: 'whole' });
    // Part differs from the default: Reset has something to do
    expect(canResetBackground(picked)).toBe(true);
    expect(canResetBackground(clickState({ clickScope: 'part' }))).toBe(true);
  });

  it('Part left over from click to select does not count for Reset with another model', () => {
    const general = makeState({
      enabled: true,
      method: 'ai',
      ai: { model: 'general', clickScope: 'part' },
    });
    expect(canResetBackground(general)).toBe(false);
  });

  it('lost frames outside the selection (it changed since tracking) are not shown', () => {
    const status = { ...createAiCutoutStatus(), lostFrames: [2, 8] };
    expect(getLostFramesInSelection(status, { start: 0, end: 5 })).toEqual([2]);
    expect(getLostFramesInSelection(status, { start: 3, end: 5 })).toEqual([]);
    expect(getLostFramesInSelection(null, { start: 0, end: 5 })).toEqual([]);

    const narrowed = clickState(
      { picks: [{ frame: 4, x: 0.5, y: 0.5, mode: 'keep' }] },
      { aiCutout: status, selectedRange: { start: 3, end: 5 } },
    );
    updateBackgroundPanel(root, narrowed, 10);
    expect($('#ai-click-lost').hidden).toBe(true);
    expect($('#ai-status-text').textContent).not.toMatch(/of 3 frames tracked/);
  });
});

describe('tracked objects', () => {
  /** @param {string} id @param {'remove' | 'add'} mode @param {number} frame */
  const object = (id, mode, frame) => ({
    id,
    mode,
    scope: 'whole',
    clicks: [{ frame, x: 0.5, y: 0.5, mode: 'keep' }],
  });
  /** @param {any[]} objects @param {Record<string, unknown>} [over] */
  const stateWith = (objects, over = {}) =>
    makeState(
      { enabled: true, method: 'ai', ai: { model: 'general', objects } },
      {
        clip: { frames: Array.from({ length: 40 }, () => ({})), hasAlpha: false },
        selectedRange: { start: 0, end: 39 },
        ...over,
      },
    );

  it('labels, finds the lost one (active first) and words its note', () => {
    const a = /** @type {any} */ (object('a', 'remove', 10));
    const b = /** @type {any} */ (object('b', 'add', 0));
    expect(getObjectLabel(a, 10)).toBe('Remove at 01:00');
    expect(getObjectLabel(b, 10)).toBe('Keep at 00:00');
    // A box-only object is labelled at its box; a box added later does not
    // move the label
    expect(getObjectLabel({ ...a, boxes: [{ frame: 20, x0: 0, y0: 0, x1: 1, y1: 1 }] }, 10)).toBe(
      'Remove at 01:00',
    );
    expect(
      getObjectLabel({ ...b, clicks: [], boxes: [{ frame: 20, x0: 0, y0: 0, x1: 1, y1: 1 }] }, 10),
    ).toBe('Keep at 02:00');
    const lost = { a: [5], b: [7, 30] };
    expect(getLostObject([a, b], lost, { start: 0, end: 39 })).toEqual({ object: a, frames: [5] });
    expect(getLostObject([a, b], lost, { start: 0, end: 39 }, 'b')?.object).toBe(b);
    // Outside the selection does not count
    expect(getLostObject([a, b], lost, { start: 6, end: 20 })).toEqual({ object: b, frames: [7] });
    expect(getLostObject([a], {}, { start: 0, end: 39 })).toBeNull();
    expect(getObjectLostText(a, [5], 10)).toBe(
      'What you removed was lost at 00:05. Click it there to keep going.',
    );
    expect(getObjectLostText(b, [7, 30], 10)).toBe(
      'What you kept was lost at 2 places, first at 00:07. Click it there to keep going.',
    );
  });

  it('lists picks and tracked fix-ups as one list, with swatches and the selected one marked', () => {
    const state = stateWith([object('a', 'remove', 10), object('b', 'add', 0)], {
      aiActiveObjectId: 'a',
      aiPickTool: 'remove',
    });
    state.edits.background.ai.picks = [{ frame: 4, x: 0.2, y: 0.2, mode: 'remove' }];
    updateBackgroundPanel(root, state, 10);
    // Only Keep / Remove make fix-ups
    expect(root.querySelector('#ai-object-remove')).toBeNull();
    expect(root.querySelector('#ai-object-list')).toBeNull();
    const items = [...root.querySelectorAll('#ai-pick-list > li')];
    const [ta, tb] = state.edits.background.ai.objects;
    expect(items.map((li) => li.textContent)).toEqual([
      'Remove at 00:04×',
      `${getObjectLabel(ta, 10)}×`,
      `${getObjectLabel(tb, 10)}×`,
    ]);
    expect(getObjectLabel(tb, 10)).toMatch(/^Keep at /);
    expect(items[0].querySelector('.editor-cutout-pick-swatch')).toBeNull();
    const swatches = items
      .slice(1)
      .map((li) =>
        /** @type {HTMLElement} */ (
          li.querySelector('.editor-cutout-pick-swatch')
        ).style.getPropertyValue('--swatch'),
      );
    expect(swatches).toEqual([OBJECT_COLORS[0], OBJECT_COLORS[1]]);
    const chips = [...root.querySelectorAll('#ai-pick-list [data-object-id]')];
    expect(chips.map((c) => /** @type {HTMLElement} */ (c).dataset.objectId)).toEqual(['a', 'b']);
    expect(chips[0].classList.contains('is-active')).toBe(true);
    expect(chips[1].classList.contains('is-active')).toBe(false);
    // Hover and focus highlight a tracked fix-up
    chips[1]
      .querySelector('.editor-cutout-pick-go')
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(handlers.onHighlightAiObject).toHaveBeenLastCalledWith('b');
    $('#ai-pick-list').dispatchEvent(new MouseEvent('mouseleave'));
    expect(handlers.onHighlightAiObject).toHaveBeenLastCalledWith(null);
    /** @type {HTMLElement} */ (chips[1].querySelector('.editor-cutout-pick-go')).click();
    expect(handlers.onGoToObject).toHaveBeenCalledWith('b');
    /** @type {HTMLElement} */ (chips[0].querySelector('.editor-cutout-pick-delete')).click();
    expect(handlers.onRemoveAiObject).toHaveBeenCalledWith('a');
    expect($('#ai-object-scope').hidden).toBe(false);
    // Whole / Part only beside a selected fix-up
    updateBackgroundPanel(
      root,
      stateWith([object('a', 'remove', 10), object('b', 'add', 0)], { aiActiveObjectId: null }),
      10,
    );
    expect($('#ai-object-scope').hidden).toBe(true);
  });

  it('shows where an object was lost, with a button that goes there', () => {
    const status = { ...createAiCutoutStatus(), objectLost: { a: [12] } };
    updateBackgroundPanel(root, stateWith([object('a', 'remove', 3)], { aiCutout: status }), 10);
    expect($('#ai-object-lost').hidden).toBe(false);
    expect($('#ai-object-lost').textContent).toContain('lost at 01:02');
    $('#ai-object-lost-go').click();
    expect(handlers.onGoToObjectLost).toHaveBeenCalledWith('a');
    updateBackgroundPanel(root, stateWith([object('a', 'remove', 3)]), 10);
    expect($('#ai-object-lost').hidden).toBe(true);
  });

  it('turns Colour off for a Remove fix-up with no point to sample (a box alone; review r3)', () => {
    const boxOnly = {
      ...object('a', 'remove', 3),
      clicks: [],
      boxes: [{ frame: 3, x0: 0, y0: 0, x1: 0.5, y1: 0.5 }],
    };
    updateBackgroundPanel(
      root,
      stateWith([boxOnly], { aiActiveObjectId: 'a', aiPickTool: 'remove' }),
      10,
    );
    expect($('#ai-object-scope-colour').disabled).toBe(true);
    updateBackgroundPanel(
      root,
      stateWith([object('a', 'remove', 3)], { aiActiveObjectId: 'a', aiPickTool: 'remove' }),
      10,
    );
    expect($('#ai-object-scope-colour').disabled).toBe(false);
  });

  it('offers Colour beside Whole / Part for a selected Remove fix-up, with its tolerance', () => {
    const colour = { ...object('a', 'remove', 3), scope: 'colour', tolerance: 44 };
    updateBackgroundPanel(
      root,
      stateWith([colour, object('b', 'add', 0)], { aiActiveObjectId: 'a', aiPickTool: 'remove' }),
      10,
    );
    const segment = (/** @type {string} */ v) =>
      /** @type {HTMLElement} */ ($(`#ai-object-scope-${v}`).closest('.editor-cutout-segment'));
    expect(segment('colour').hidden).toBe(false);
    expect($('#ai-object-scope-colour').checked).toBe(true);
    expect($('#ai-object-scope-whole').checked).toBe(false);
    expect($('#ai-object-tolerance-row').hidden).toBe(false);
    expect($('#ai-object-tolerance').value).toBe('44');
    $('#ai-object-tolerance').value = '20';
    fire($('#ai-object-tolerance'), 'input');
    expect(handlers.onSetAiObjectTolerance).toHaveBeenLastCalledWith(20, { live: true });
    fire($('#ai-object-tolerance'), 'change');
    expect(handlers.onSetAiObjectTolerance).toHaveBeenLastCalledWith(20);
    $('#ai-object-scope-part').click();
    expect(handlers.onSetAiObjectScope).toHaveBeenLastCalledWith('part');
    // An Add fix-up: no Colour, no tolerance
    updateBackgroundPanel(
      root,
      stateWith([colour, object('b', 'add', 0)], { aiActiveObjectId: 'b', aiPickTool: 'keep' }),
      10,
    );
    expect(segment('colour').hidden).toBe(true);
    expect($('#ai-object-tolerance-row').hidden).toBe(true);
  });

  it('says where a Colour fix-up removes more (its worst frame), with a button that goes there', () => {
    const colour = { ...object('a', 'remove', 3), scope: 'colour', tolerance: 64 };
    // Levels: 1 or more is the notice
    const shares = new Array(40).fill(0.2);
    shares[25] = 3.8;
    shares[30] = 1.2;
    shares[12] = 1;
    const status = {
      ...createAiCutoutStatus(),
      colourLevels: { a: shares },
    };
    updateBackgroundPanel(root, stateWith([colour], { aiCutout: status }), 10);
    expect($('#ai-object-lost').hidden).toBe(false);
    expect($('#ai-object-lost').textContent).toContain('Colour removes more at 02:05.');
    expect($('#ai-object-lost').textContent).not.toMatch(/%|subject/);
    $('#ai-object-lost-go').click();
    expect(handlers.onGoToColourGuard).toHaveBeenCalledWith('a', 25);
    // Outside the selection does not count; a level of 1 or less is quiet
    expect(getColourGuard([colour], { a: shares }, { start: 26, end: 39 })).toMatchObject({
      frame: 30,
    });
    expect(getColourGuard([colour], { a: shares }, { start: 0, end: 20 })).toBeNull();
    expect(
      getColourGuard([{ ...colour, scope: 'part' }], { a: shares }, { start: 0, end: 39 }),
    ).toBeNull();
    // Nothing to warn about: the notice goes (a tracked object's lost note would show)
    updateBackgroundPanel(
      root,
      stateWith([colour], { aiCutout: { ...status, colourLevels: { a: new Array(40).fill(0) } } }),
      10,
    );
    expect($('#ai-object-lost').textContent).not.toContain('Colour removes');
  });

  it('shows a lost tracked fix-up and a Colour warning together; Go there takes turns (C)', () => {
    // A bystander that left the shot stays lost to the end of the selection:
    // the Colour warning must not hide behind it
    const colour = { ...object('a', 'remove', 3), scope: 'colour', tolerance: 64 };
    const tracked = object('b', 'remove', 5);
    const shares = new Array(40).fill(0);
    shares[25] = 3.8;
    const lostToEnd = Array.from({ length: 28 }, (_, i) => 12 + i);
    const status = {
      ...createAiCutoutStatus(),
      colourLevels: { a: shares },
      objectLost: { a: [4], b: lostToEnd },
    };
    updateBackgroundPanel(root, stateWith([colour, tracked], { aiCutout: status }), 10);
    const text = $('#ai-object-lost').textContent;
    expect(text).toContain('What you removed was lost at 28 places, first at 01:02.');
    expect(text).toContain('Colour removes more at 02:05.');
    $('#ai-object-lost-go').click();
    expect(handlers.onGoToObjectLost).toHaveBeenLastCalledWith('b');
    $('#ai-object-lost-go').click();
    expect(handlers.onGoToColourGuard).toHaveBeenLastCalledWith('a', 25);
    $('#ai-object-lost-go').click();
    expect(handlers.onGoToObjectLost).toHaveBeenCalledTimes(2);
    // The same notice again does not restart the turns; a new one does
    updateBackgroundPanel(root, stateWith([colour, tracked], { aiCutout: status }), 10);
    $('#ai-object-lost-go').click();
    expect(handlers.onGoToColourGuard).toHaveBeenCalledTimes(2);
    // Found again: only the Colour warning (the Colour fix-up's own lost frames never count)
    updateBackgroundPanel(
      root,
      stateWith([colour, tracked], { aiCutout: { ...status, objectLost: { a: [4] } } }),
      10,
    );
    expect($('#ai-object-lost').textContent).not.toContain('was lost');
    $('#ai-object-lost-go').click();
    expect(handlers.onGoToColourGuard).toHaveBeenLastCalledWith('a', 25);
    expect(handlers.onGoToObjectLost).toHaveBeenCalledTimes(2);
  });

  it('says when the tracked fix-ups are full; Keep / Remove stay on for picks', () => {
    const many = Array.from({ length: EDIT_LIMITS.aiObjects.max }, (_, i) =>
      object(`o${i}`, 'remove', i),
    );
    updateBackgroundPanel(root, stateWith(many.slice(0, 1)), 10);
    expect($('#background-tools-hint').textContent).not.toContain('limit');
    updateBackgroundPanel(root, stateWith(many), 10);
    expect($('#background-tools-hint').textContent).toContain('limit of 4 tracked fix-ups');
    expect($('#ai-pick-remove').disabled).toBe(false);
  });
});

describe('Clean up chips', () => {
  const specks = { kind: 'specks', count: 3, minIslandArea: 0.001 };
  const holes = { kind: 'holes', count: 1, maxHoleArea: 0.002 };
  const blob = { kind: 'blob', frames: 2, where: 'top-right', pick: { frame: 4, x: 0.8, y: 0.2 } };
  const shrink = { kind: 'shrink', frames: 3, frame: 7 };
  /** @param {Record<string, unknown>} ai @param {any[]} suggestions */
  const stateWith = (ai, suggestions) =>
    makeState(
      { enabled: true, method: 'ai', ai: { model: 'general', ...ai } },
      { aiCutout: { ...createAiCutoutStatus(), cleanupSuggestions: suggestions } },
    );

  it('words each suggestion and puts the clean-ups that are on first', () => {
    const ai = /** @type {any} */ ({
      model: 'general',
      cleanup: { minIslandArea: 0.001, maxHoleArea: 0 },
    });
    const chips = getCleanupChips(ai, /** @type {any} */ ([specks, holes, blob, shrink]));
    expect(chips.map((c) => [c.label, c.applied])).toEqual([
      ['Specks removed · every frame', true],
      ['Fill 1 small hole · every frame', false],
      ['Remove blob near top-right · on 2 frames', false],
      ['Check 3 frames where the character shrinks', false],
    ]);
  });

  it('shows no blob chip with click to select, and at most four chips', () => {
    const click = /** @type {any} */ ({
      model: 'click',
      cleanup: { minIslandArea: 0, maxHoleArea: 0 },
    });
    expect(getCleanupChips(click, /** @type {any} */ ([blob, shrink])).map((c) => c.kind)).toEqual([
      'shrink',
    ]);
    const on = /** @type {any} */ ({
      model: 'general',
      cleanup: { minIslandArea: 0.001, maxHoleArea: 0.001 },
    });
    expect(getCleanupChips(on, /** @type {any} */ ([blob, blob, shrink]))).toHaveLength(4);
  });

  it('hides the row without chips; a tap applies a suggestion or turns a clean-up off', () => {
    updateBackgroundPanel(root, stateWith({}, []), 10);
    expect($('#ai-cleanup').hidden).toBe(true);
    updateBackgroundPanel(
      root,
      stateWith({ cleanup: { minIslandArea: 0, maxHoleArea: 0.002 } }, [specks, holes]),
      10,
    );
    expect($('#ai-cleanup').hidden).toBe(false);
    const buttons = [...root.querySelectorAll('#ai-cleanup-list button')];
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Small holes filled · every frame',
      'Remove 3 specks · every frame',
    ]);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
    /** @type {HTMLElement} */ (buttons[0]).click();
    expect(handlers.onClearCleanup).toHaveBeenCalledWith('holes');
    /** @type {HTMLElement} */ (buttons[1]).click();
    expect(handlers.onApplyCleanup).toHaveBeenCalledWith(specks);
  });
});
