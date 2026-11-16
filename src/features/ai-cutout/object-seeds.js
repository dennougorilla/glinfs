/**
 * Seeds: a tracked object's last answer on a frame, kept to prompt the next run
 * @module features/ai-cutout/object-seeds
 *
 * A correction (one more click or box on a tracked object) is a new set of
 * prompts, so every mask of the object is redone (its masks carry the tag of
 * the prompts that made them, and export takes only masks of the current
 * tag). Redone from scratch, a frame that the user corrects is decoded from
 * its own points only and forgets what the earlier answer held: a click that
 * adds the bush beside a lawn answers with the bush, or with the whole frame.
 * A seed keeps that earlier answer (its mask and the decoder's low-res
 * logits) so the corrected frame can be prompted with it: the answer's box,
 * points inside and outside it, the new points, and its logits as
 * `mask_input` (see click-tracker.js).
 *
 * A seed is the object's LAST answer on the frame: a run that clears a frame
 * (to redo it, or because it could not reach it) clears its seed too, so a
 * frame the last run lost has none rather than an older one.
 *
 * A seed is never a result. It is not in the mask store, never stored or
 * exported under the current tag, and only prompts a run whose prompts
 * extend the ones that made it: the same scope (Whole / Part) and every
 * earlier click and box still there plus at least one more. A changed scope,
 * an undone or deleted click, or the same prompts again (a retry) get no seed
 * and are redone from scratch, as before seeds existed.
 *
 * Bounded memory: the logits are kept as int8 (a quarter logit per step,
 * clamped to ±31.75, about where SAM's logits saturate) and the store drops
 * the least recently used seeds past its cap.
 *
 * No ORT, no DOM: unit-tested.
 */

import { createByteLru } from './byte-lru.js';

/** Memory cap of all seeds */
export const OBJECT_SEED_CAP_BYTES = 48 * 1024 * 1024;

/** int8 steps per logit */
const LOGIT_STEPS = 4;

/**
 * @typedef {Object} SeedPrompts - What made a seed (an object's prompts)
 * @property {{ frame: number, x: number, y: number, mode: string }[]} clicks
 * @property {{ frame: number, x0: number, y0: number, x1: number, y1: number }[]} [boxes]
 * @property {string | undefined} scope
 */

/**
 * @typedef {Object} Seed
 * @property {{ data: Uint8Array, width: number, height: number }} mask
 * @property {Float32Array | null} lowRes - The answer's low-res logits
 */

/**
 * Low-res logits as int8 (quarter steps, clamped)
 * @param {Float32Array} logits
 * @returns {Int8Array}
 */
export function quantizeLogits(logits) {
  const out = new Int8Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const v = Math.round(logits[i] * LOGIT_STEPS);
    out[i] = v > 127 ? 127 : v < -127 ? -127 : v;
  }
  return out;
}

/**
 * @param {Int8Array} q
 * @returns {Float32Array}
 */
export function dequantizeLogits(q) {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] / LOGIT_STEPS;
  return out;
}

/**
 * @param {{ frame: number, x: number, y: number, mode: string }} c
 * @returns {string}
 */
const clickKey = (c) => `${c.frame}:${c.x}:${c.y}:${c.mode}`;

/**
 * @param {{ frame: number, x0: number, y0: number, x1: number, y1: number }} b
 * @returns {string}
 */
const boxKey = (b) => `${b.frame}:${b.x0}:${b.y0}:${b.x1}:${b.y1}`;

/**
 * Whether every key of `older` is in `newer` (as a multiset)
 * @param {string[]} older
 * @param {string[]} newer
 * @returns {boolean}
 */
function includesAll(older, newer) {
  /** @type {Map<string, number>} */
  const count = new Map();
  for (const k of newer) count.set(k, (count.get(k) ?? 0) + 1);
  for (const k of older) {
    const n = count.get(k) ?? 0;
    if (n === 0) return false;
    count.set(k, n - 1);
  }
  return true;
}

/**
 * Whether prompts `newer` extend `older`: the same scope, every click and
 * box of `older` still there, and at least one more
 * @param {SeedPrompts} older
 * @param {SeedPrompts} newer
 * @returns {boolean}
 */
export function extendsPrompts(older, newer) {
  if (older.scope !== newer.scope) return false;
  const oc = older.clicks.map(clickKey);
  const nc = newer.clicks.map(clickKey);
  const ob = (older.boxes ?? []).map(boxKey);
  const nb = (newer.boxes ?? []).map(boxKey);
  if (oc.length + ob.length >= nc.length + nb.length) return false;
  return includesAll(oc, nc) && includesAll(ob, nb);
}

/**
 * @typedef {Object} ObjectSeeds
 * @property {(objectId: string, frameKey: string, mask: Seed['mask'], lowRes: Float32Array | null, prompts: SeedPrompts) => void} set
 * @property {(objectId: string, frameKey: string, prompts: SeedPrompts) => Seed | null} get -
 *   The seed of a frame when `prompts` extend the ones that made it, else null
 * @property {(objectId: string, frameKey: string) => void} delete - The frame has no
 *   answer of the object's latest prompts (redone or not reached): its older seed goes
 * @property {(objectId: string) => void} dropObject
 * @property {() => void} clear
 * @property {number} bytes
 */

/**
 * @param {{ capBytes?: number }} [options]
 * @returns {ObjectSeeds}
 */
export function createObjectSeeds({ capBytes = OBJECT_SEED_CAP_BYTES } = {}) {
  /** @type {Map<string, Set<string>>} objectId -> its keys */
  const keysOf = new Map();
  /** @type {import('./byte-lru.js').ByteLru<{ mask: Seed['mask'], lowRes: Int8Array | null, prompts: SeedPrompts }>} */
  const lru = createByteLru(capBytes, {
    onEvict: (key) => {
      const id = key.slice(0, key.indexOf('\u0000'));
      keysOf.get(id)?.delete(key);
    },
  });
  const keyOf = (/** @type {string} */ objectId, /** @type {string} */ frameKey) =>
    `${objectId}\u0000${frameKey}`;
  return {
    set(objectId, frameKey, mask, lowRes, prompts) {
      const key = keyOf(objectId, frameKey);
      const value = {
        mask,
        lowRes: lowRes ? quantizeLogits(lowRes) : null,
        // A copy: the edits' arrays may be replaced, never compared by identity
        prompts: {
          clicks: [...prompts.clicks],
          boxes: [...(prompts.boxes ?? [])],
          scope: prompts.scope,
        },
      };
      const bytes = mask.data.byteLength + (value.lowRes?.byteLength ?? 0) + 256;
      if (lru.set(key, value, bytes)) {
        let keys = keysOf.get(objectId);
        if (!keys) {
          keys = new Set();
          keysOf.set(objectId, keys);
        }
        keys.add(key);
      }
    },
    get(objectId, frameKey, prompts) {
      const entry = lru.get(keyOf(objectId, frameKey));
      if (!entry || !extendsPrompts(entry.prompts, prompts)) return null;
      return { mask: entry.mask, lowRes: entry.lowRes ? dequantizeLogits(entry.lowRes) : null };
    },
    delete(objectId, frameKey) {
      const key = keyOf(objectId, frameKey);
      lru.delete(key);
      keysOf.get(objectId)?.delete(key);
    },
    dropObject(objectId) {
      for (const key of keysOf.get(objectId) ?? []) lru.delete(key);
      keysOf.delete(objectId);
    },
    clear() {
      lru.clear();
      keysOf.clear();
    },
    get bytes() {
      return lru.bytes;
    },
  };
}
