/**
 * Which AI cutout model a choice starts with (#187)
 * @module features/ai-cutout/model-preference
 *
 * A subject card ("Anything", "Person", ...) can use one or more models.
 * When the user picks the card, the model it uses is, in this order:
 *
 * 1. remembered: the model the user last chose for this card (or the last
 *    model they chose at all, when the card can use it);
 * 2. downloaded: the first of the card's models that is already in the
 *    browser (Cache Storage) or loaded;
 * 3. first-run default: FIRST_RUN_MODEL_ID when the card can use it, else
 *    the card's own default.
 *
 * Nothing here downloads anything: a model that is not downloaded is only
 * ever downloaded after the user confirms the editor's download question.
 * Plain functions with no browser access, so unit tests call them directly.
 */

import { FIRST_RUN_MODEL_ID } from './model-registry.js';

/**
 * @typedef {Object} RememberedModels
 * @property {string | null} [last] - The last model the user chose
 * @property {Readonly<Record<string, string>>} [bySubject] - The last model
 *   the user chose per subject card
 */

/**
 * @typedef {Object} ModelPreferenceOptions
 * @property {string} [subject] - The subject card (its key in `bySubject`)
 * @property {RememberedModels | null} [remembered]
 * @property {Readonly<Record<string, string>> | null} [availability] - Per
 *   model id: 'ready' | 'cached' | 'missing' | 'unknown' (as the editor's
 *   AI status reports it); absent ids count as not downloaded
 * @property {string | null} [fallback] - The card's own default model
 */

/**
 * Whether an availability means the model needs no download
 * @param {string | undefined} availability
 * @returns {boolean}
 */
export function isDownloadedAvailability(availability) {
  return availability === 'ready' || availability === 'cached';
}

/**
 * The model a subject card starts with: remembered > downloaded >
 * first-run default (see the module comment)
 * @param {readonly string[]} candidates - The card's models, its default first
 * @param {ModelPreferenceOptions} [options]
 * @returns {string | null} null when the card has no model
 */
export function pickPreferredModel(
  candidates,
  { subject, remembered, availability, fallback } = {},
) {
  if (candidates.length === 0) return null;
  const forSubject = subject ? remembered?.bySubject?.[subject] : undefined;
  const rememberedId = [forSubject, remembered?.last].find(
    (id) => typeof id === 'string' && candidates.includes(id),
  );
  if (rememberedId) return rememberedId;
  const downloaded = candidates.find((id) => isDownloadedAvailability(availability?.[id]));
  if (downloaded) return downloaded;
  if (candidates.includes(FIRST_RUN_MODEL_ID)) return FIRST_RUN_MODEL_ID;
  return fallback && candidates.includes(fallback) ? fallback : candidates[0];
}
