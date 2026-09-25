/**
 * Editor preview of clip edits: the renderer must match composeEditorFrame
 * pixel for pixel, cache keyed regions, and never read back on text-only
 * edits.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEditorFrameRenderer,
  createKeyedRegionCache,
  detectOutputEdgeColor,
  getOutputRegion,
  getSelectedTextOverlay,
  hitTestEditorText,
  readSourceRegion,
  sampleSourceColor,
  sampleSourcePixel,
} from '../../../src/features/editor/edits-preview.js';
import { composeEditorFrame } from '../../../src/shared/edits/compose.js';
import { createDefaultEdits, createTextLayer } from '../../../src/shared/edits/model.js';
import { createFakeContext } from '../shared/edits/fake-context.js';

const GREEN = [0, 255, 0, 255];

/**
 * @param {string} id
 * @param {number[]} [fill]
 * @param {string} [sharedKey]
 */
function frame(id, fill = GREEN, sharedKey = undefined) {
  return /** @type {any} */ ({
    id,
    sharedKey,
    width: 20,
    height: 10,
    timestamp: 0,
    frame: { fill, closed: false },
  });
}

/** @param {Partial<import('../../../src/shared/edits/model.js').BackgroundRemoval>} [bg] */
function edits(bg = {}, textLayers = /** @type {any[]} */ ([])) {
  const e = createDefaultEdits();
  return { ...e, textLayers, background: { ...e.background, enabled: true, ...bg } };
}

/**
 * All pixels of a fake context
 * @param {ReturnType<typeof createFakeContext>} ctx
 */
function allPixels(ctx) {
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
}

describe('getOutputRegion', () => {
  it('is the crop, else the whole frame', () => {
    expect(getOutputRegion(frame('a'), null)).toEqual({ x: 0, y: 0, width: 20, height: 10 });
    expect(
      getOutputRegion(frame('a'), { x: 2, y: 3, width: 4, height: 5, aspectRatio: 'free' }),
    ).toEqual({ x: 2, y: 3, width: 4, height: 5 });
    expect(getOutputRegion(null, null)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('createKeyedRegionCache', () => {
  const image = (bytes) => /** @type {any} */ ({ data: new Uint8ClampedArray(bytes) });

  it('stores entries until the byte budget, keeping the latest on top', () => {
    const cache = createKeyedRegionCache(100);
    cache.sync('p');
    cache.set('a', image(60));
    cache.set('b', image(60)); // over budget: not admitted, but kept as latest
    expect(cache.stats()).toEqual({ entries: 1, bytes: 60 });
    expect(cache.get('a')).not.toBeNull();
    expect(cache.get('b')).not.toBeNull();
    cache.set('c', image(10));
    expect(cache.get('b')).toBeNull();
    expect(cache.get('c')).not.toBeNull();
    // Re-setting an admitted key does not double count
    cache.set('a', image(60));
    expect(cache.stats().bytes).toBe(70);
  });

  it('drops everything when the parameters change', () => {
    const cache = createKeyedRegionCache();
    cache.sync('p1');
    cache.set('a', image(4));
    cache.sync('p1');
    expect(cache.get('a')).not.toBeNull();
    cache.sync('p2');
    expect(cache.get('a')).toBeNull();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});

describe('createEditorFrameRenderer', () => {
  it('matches composeEditorFrame with background removal and text', () => {
    const layer = createTextLayer({ text: 'Hi', color: '#ff0000', y: 0.5 }, 5);
    const e = edits({ color: '#00ff00', tolerance: 0 }, [layer]);
    const crop = /** @type {any} */ ({ x: 4, y: 2, width: 12, height: 6, aspectRatio: 'free' });

    for (const c of [null, crop]) {
      const expected = createFakeContext(20, 10);
      composeEditorFrame(expected, frame('a'), c, e, 0);
      const actual = createFakeContext(20, 10);
      const renderer = createEditorFrameRenderer();
      renderer.render(actual, frame('a'), c, e, 0);
      expect(Array.from(allPixels(actual))).toEqual(Array.from(allPixels(expected)));
      // ...and again from the cache
      renderer.render(actual, frame('a'), c, e, 0);
      expect(Array.from(allPixels(actual))).toEqual(Array.from(allPixels(expected)));
    }
  });

  it('keys each frame once per parameter set; text-only edits never read back', () => {
    const renderer = createEditorFrameRenderer();
    const ctx = createFakeContext(20, 10);
    const e = edits();

    renderer.render(ctx, frame('a'), null, e, 0);
    renderer.render(ctx, frame('b'), null, e, 1);
    expect(renderer.stats()).toMatchObject({ readbacks: 2, cachedFrames: 2 });

    // Revisit + text edits: all from the cache
    const withText = { ...e, textLayers: [createTextLayer({ text: 'x' }, 2)] };
    renderer.render(ctx, frame('a'), null, withText, 0);
    renderer.render(ctx, frame('b'), null, { ...withText, textLayers: [] }, 1);
    expect(renderer.stats().readbacks).toBe(2);

    // Clones of one decoded frame share its keyed pixels
    renderer.render(ctx, frame('c', GREEN, 'a-shared'), null, e, 2);
    renderer.render(ctx, frame('d', GREEN, 'a-shared'), null, e, 3);
    expect(renderer.stats().readbacks).toBe(3);

    // New key parameters or crop: re-key
    renderer.render(ctx, frame('a'), null, edits({ tolerance: 40 }), 0);
    expect(renderer.stats()).toMatchObject({ readbacks: 4, cachedFrames: 1 });
    renderer.render(
      ctx,
      frame('a'),
      /** @type {any} */ ({ x: 0, y: 0, width: 10, height: 10, aspectRatio: 'free' }),
      edits({ tolerance: 40 }),
      0,
    );
    expect(renderer.stats().readbacks).toBe(5);
  });

  it('skips keying while a crop drag is in progress and keeps the cache for the release', () => {
    const renderer = createEditorFrameRenderer();
    const ctx = createFakeContext(20, 10);
    const e = edits();
    renderer.render(ctx, frame('a'), null, e, 0);
    renderer.render(ctx, frame('b'), null, e, 1);
    expect(renderer.stats()).toMatchObject({ readbacks: 2, cachedFrames: 2 });

    // Every pointer move of the drag: a new crop, no readback, cache intact
    for (let x = 0; x < 5; x++) {
      const crop = /** @type {any} */ ({ x, y: 1, width: 10, height: 8, aspectRatio: 'free' });
      renderer.render(ctx, frame('a'), crop, e, 0, { skipKey: true });
    }
    expect(renderer.stats()).toMatchObject({ readbacks: 2, cachedFrames: 2 });
    expect(ctx.names().filter((n) => n === 'getImageData')).toHaveLength(2);
    // The unkeyed frame shows while dragging
    expect(ctx.pixelAt(0, 0)).toEqual(GREEN);

    // Released: the final region is keyed once
    const released = /** @type {any} */ ({ x: 4, y: 1, width: 10, height: 8, aspectRatio: 'free' });
    renderer.render(ctx, frame('a'), released, e, 0);
    expect(renderer.stats()).toMatchObject({ readbacks: 3, cachedFrames: 1 });
    expect(ctx.pixelAt(5, 2)[3]).toBe(0);

    // A drag released where it started re-uses the cached frames
    const fresh = createEditorFrameRenderer();
    fresh.render(ctx, frame('a'), null, e, 0);
    fresh.render(ctx, frame('a'), released, e, 0, { skipKey: true });
    fresh.render(ctx, frame('a'), null, e, 0);
    expect(fresh.stats().readbacks).toBe(1);
  });

  it('snaps the output region to 1-bit alpha for a transparent export, once per frame', () => {
    const renderer = createEditorFrameRenderer();
    const ctx = createFakeContext(20, 10);
    const soft = (/** @type {string} */ id, /** @type {number} */ alpha) =>
      frame(id, [200, 100, 50, alpha]);
    const crop = /** @type {any} */ ({ x: 2, y: 1, width: 10, height: 8, aspectRatio: 'free' });
    const noKey = createDefaultEdits();

    // A source with alpha, removal off: soft alpha inside the region snaps
    renderer.render(ctx, soft('a', 100), crop, noKey, 0, { transparent: true });
    expect(ctx.pixelAt(5, 5)[3]).toBe(0);
    // ...outside the output region the source is left alone
    expect(ctx.pixelAt(15, 5)[3]).toBe(100);
    renderer.render(ctx, soft('b', 200), crop, noKey, 1, { transparent: true });
    expect(ctx.pixelAt(5, 5)[3]).toBe(255);
    expect(renderer.stats()).toMatchObject({ readbacks: 2, cachedFrames: 2 });

    // Revisits and text edits come from the cache
    const withText = { ...noKey, textLayers: [createTextLayer({ text: 'x' }, 2)] };
    renderer.render(ctx, soft('a', 100), crop, withText, 0, { transparent: true });
    expect(renderer.stats().readbacks).toBe(2);

    // A crop drag skips the snap without touching the cache
    renderer.render(ctx, soft('a', 100), null, noKey, 0, { transparent: true, skipKey: true });
    expect(ctx.pixelAt(5, 5)[3]).toBe(100);
    expect(renderer.stats()).toMatchObject({ readbacks: 2, cachedFrames: 2 });

    // Opaque export: no snap, no readback, cache freed
    renderer.render(ctx, soft('a', 100), crop, noKey, 0);
    expect(ctx.pixelAt(5, 5)[3]).toBe(100);
    expect(renderer.stats()).toMatchObject({ readbacks: 2, cachedFrames: 0 });

    // With removal on, the key and the snap share one readback per frame
    const keyed = edits({ color: '#000000', tolerance: 0 });
    renderer.render(ctx, soft('a', 100), crop, keyed, 0, { transparent: true });
    renderer.render(ctx, soft('a', 100), crop, keyed, 0, { transparent: true });
    expect(ctx.pixelAt(5, 5)[3]).toBe(0);
    expect(renderer.stats()).toMatchObject({ readbacks: 3, cachedFrames: 1 });
  });

  it('frees the cache when removal is off and draws through composeEditorFrame', () => {
    const renderer = createEditorFrameRenderer();
    const ctx = createFakeContext(20, 10);
    renderer.render(ctx, frame('a'), null, edits(), 0);
    expect(renderer.stats().cachedFrames).toBe(1);

    renderer.render(ctx, frame('a'), null, createDefaultEdits(), 0);
    expect(renderer.stats()).toMatchObject({ readbacks: 1, cachedFrames: 0 });
    expect(ctx.pixelAt(0, 0)).toEqual(GREEN);
    expect(ctx.names().filter((n) => n === 'getImageData')).toHaveLength(1);
  });

  it('draws the placeholder for a closed frame without reading back', () => {
    const renderer = createEditorFrameRenderer();
    const ctx = createFakeContext(20, 10);
    const closed = frame('a');
    closed.frame.closed = true;
    renderer.render(ctx, closed, null, edits(), 0);
    expect(renderer.stats().readbacks).toBe(0);
    renderer.clear();
    expect(renderer.stats().cachedFrames).toBe(0);
  });
});

describe('selected text overlay and hit testing', () => {
  const layer = createTextLayer(
    { id: 't', text: 'Hi', size: 0.4, x: 0.5, y: 0.5, start: 2, end: 3 },
    5,
  );

  /** @param {Partial<import('../../../src/features/editor/types.js').EditorState>} over */
  const state = (over) =>
    /** @type {any} */ ({
      edits: { ...createDefaultEdits(), textLayers: [layer] },
      selectedTextId: 't',
      currentFrame: 2,
      cropArea: null,
      ...over,
    });

  it('returns the selected layer bounds offset by the crop', () => {
    const ctx = createFakeContext(20, 10);
    const full = getSelectedTextOverlay(ctx, state({}), frame('a'));
    expect(full).toMatchObject({ active: true });
    expect(full?.x).toBeGreaterThan(0);

    const cropped = getSelectedTextOverlay(
      ctx,
      state({
        cropArea: { x: 5, y: 1, width: 10, height: 8, aspectRatio: 'free' },
        currentFrame: 0,
      }),
      frame('a'),
    );
    expect(cropped?.active).toBe(false);
    // Centered on the crop's center instead of the frame's
    expect(/** @type {any} */ (cropped).x + /** @type {any} */ (cropped).width / 2).toBeCloseTo(10);
  });

  it('is null without a visible selected layer', () => {
    const ctx = createFakeContext(20, 10);
    expect(getSelectedTextOverlay(ctx, state({ selectedTextId: null }), frame('a'))).toBeNull();
    expect(getSelectedTextOverlay(ctx, state({ selectedTextId: 'x' }), frame('a'))).toBeNull();
    const blank = state({
      edits: { ...createDefaultEdits(), textLayers: [{ ...layer, text: ' ' }] },
    });
    expect(getSelectedTextOverlay(ctx, blank, frame('a'))).toBeNull();
    expect(getSelectedTextOverlay(ctx, state({}), null)).toBeNull();
  });

  it('hits only layers drawn on the current frame, inside the output region', () => {
    const ctx = createFakeContext(20, 10);
    expect(hitTestEditorText(ctx, state({}), frame('a'), { x: 10, y: 5 })).toBe('t');
    expect(hitTestEditorText(ctx, state({ currentFrame: 0 }), frame('a'), { x: 10, y: 5 })).toBe(
      null,
    );
    const cropped = state({ cropArea: { x: 0, y: 0, width: 8, height: 10, aspectRatio: 'free' } });
    expect(hitTestEditorText(ctx, cropped, frame('a'), { x: 12, y: 5 })).toBeNull();
    expect(hitTestEditorText(ctx, cropped, frame('a'), { x: 4, y: 5 })).toBe('t');
  });
});

describe('source pixel reads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubOffscreenCanvas = () =>
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        /** @param {number} w @param {number} h */
        constructor(w, h) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return createFakeContext(this.width, this.height, this);
        }
      },
    );

  it('samples and detects colors from the source frame', () => {
    stubOffscreenCanvas();
    const source = frame('a', [10, 20, 30, 255]);
    expect(sampleSourceColor(source, { x: 3, y: 4 })).toBe('#0a141e');
    expect(detectOutputEdgeColor(source, null)).toBe('#0a141e');
    // Clamped into the frame
    expect(readSourceRegion(source, { x: 30, y: -5, width: 5, height: 5 })).toMatchObject({
      width: 1,
      height: 5,
    });
  });

  it('offers no key color where the source is already transparent', () => {
    stubOffscreenCanvas();
    // A transparent pixel reads back as (0, 0, 0, 0): it must not become a
    // black key color that erases dark outlines touching the transparency
    const clear = frame('a', [0, 0, 0, 0]);
    expect(sampleSourcePixel(clear, { x: 3, y: 4 })).toEqual({
      color: '#000000',
      transparent: true,
    });
    expect(sampleSourceColor(clear, { x: 3, y: 4 })).toBeNull();
    expect(detectOutputEdgeColor(clear, null)).toBeNull();
    expect(sampleSourcePixel(frame('b', [10, 20, 30, 200]), { x: 0, y: 0 })).toEqual({
      color: '#0a141e',
      transparent: false,
    });
  });

  it('returns null for unreadable frames or without a canvas', () => {
    const closed = frame('a');
    closed.frame.closed = true;
    expect(sampleSourceColor(closed, { x: 0, y: 0 })).toBeNull();
    // jsdom: no OffscreenCanvas, and <canvas> has no 2D context
    expect(sampleSourceColor(frame('a'), { x: 0, y: 0 })).toBeNull();
    expect(detectOutputEdgeColor(frame('a'), null)).toBeNull();
  });
});
