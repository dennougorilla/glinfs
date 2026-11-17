/**
 * Colours of tracked fix-ups: the chip's swatch and the region drawn on the
 * frame in Show mask share one colour per object (by its place in the list)
 * @module features/editor/object-colors
 */

/** Distinct from the mask tint (red) and from each other (one per fix-up, EDIT_LIMITS.aiObjects.max) */
export const OBJECT_COLORS = /** @type {const} */ ([
  '#3b82f6',
  '#f59e0b',
  '#10b981',
  '#a855f7',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f97316',
]);

/**
 * @param {{ id: string }[]} objects
 * @param {string} id
 * @returns {string}
 */
export function getObjectColor(objects, id) {
  const index = Math.max(
    0,
    objects.findIndex((o) => o.id === id),
  );
  return OBJECT_COLORS[index % OBJECT_COLORS.length];
}
