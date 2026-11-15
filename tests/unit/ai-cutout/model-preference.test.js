import { describe, expect, it } from 'vitest';
import {
  isDownloadedAvailability,
  pickPreferredModel,
} from '../../../src/features/ai-cutout/model-preference.js';
import {
  DEFAULT_MODEL_ID,
  FIRST_RUN_MODEL_ID,
  getModelIds,
} from '../../../src/features/ai-cutout/model-registry.js';

const GENERAL = ['general', 'ben2'];

describe('model-preference (#187)', () => {
  it('keeps edits without a model on the anime model and starts new choices with BEN2', () => {
    expect(DEFAULT_MODEL_ID).toBe('anime');
    expect(FIRST_RUN_MODEL_ID).toBe('ben2');
    expect(getModelIds()).toContain(FIRST_RUN_MODEL_ID);
  });

  it('counts ready and cached models as downloaded', () => {
    expect(isDownloadedAvailability('ready')).toBe(true);
    expect(isDownloadedAvailability('cached')).toBe(true);
    expect(isDownloadedAvailability('missing')).toBe(false);
    expect(isDownloadedAvailability('unknown')).toBe(false);
    expect(isDownloadedAvailability(undefined)).toBe(false);
  });

  it('prefers the remembered model over a downloaded one', () => {
    expect(
      pickPreferredModel(GENERAL, {
        subject: 'general',
        remembered: { bySubject: { general: 'general' } },
        availability: { ben2: 'cached', general: 'missing' },
      }),
    ).toBe('general');
  });

  it('prefers the subject-specific memory over the last choice overall', () => {
    expect(
      pickPreferredModel(GENERAL, {
        subject: 'general',
        remembered: { last: 'ben2', bySubject: { general: 'general' } },
      }),
    ).toBe('general');
    expect(pickPreferredModel(GENERAL, { subject: 'general', remembered: { last: 'ben2' } })).toBe(
      'ben2',
    );
  });

  it('ignores remembered models the card cannot use', () => {
    expect(
      pickPreferredModel(['portrait', 'video-person'], {
        subject: 'portrait',
        remembered: { last: 'ben2', bySubject: { portrait: 'removed-model' } },
        availability: { 'video-person': 'ready' },
      }),
    ).toBe('video-person');
  });

  it('prefers a downloaded model over the first-run default', () => {
    expect(
      pickPreferredModel(GENERAL, { availability: { general: 'cached', ben2: 'missing' } }),
    ).toBe('general');
  });

  it('falls back to the first-run default, then the card default', () => {
    expect(pickPreferredModel(GENERAL, { availability: { general: 'missing' } })).toBe('ben2');
    expect(pickPreferredModel(GENERAL)).toBe('ben2');
    expect(pickPreferredModel(['portrait', 'video-person'], { fallback: 'portrait' })).toBe(
      'portrait',
    );
    expect(pickPreferredModel(['anime'], { fallback: 'missing-id' })).toBe('anime');
    expect(pickPreferredModel([])).toBeNull();
  });
});
