/**
 * Welcome scene compositor
 * @module features/capture/welcome/stage
 *
 * Draws one moment of the scene on a 600x240 grid (the caller scales the
 * context): the window being recorded (the pixel video at exactly 2x),
 * "Create Clip" pressed after the fact, the cyan selection over the buffer
 * strip, the crop closing in on the subject, and the GIF card coming into
 * register, looping the moment, then clearing its background.
 */

import { LH, LW, makeCanvas } from './pixel.js';
import { BEATS, CYCLE, easeInOut, easeOut, frameTime, lerp, STRIP, seg } from './timeline.js';

/**
 * @typedef {Object} Palette
 * @property {string} paper
 * @property {string} onPaper
 * @property {string} cyan
 * @property {string} magenta
 * @property {string} rec
 * @property {string} panel
 * @property {string} window
 * @property {string} line
 * @property {string} lineStrong
 * @property {string} text2
 * @property {string} muted
 * @property {string} track
 * @property {string} mono - Font family for labels
 * @property {string} sans - Font family for the button
 */

/** The recorded window's video area: the pixel video at exactly 2x */
const SHOT = { x: 1, y: 19, w: LW * 2, h: LH * 2 };
/** Where the GIF card puts its picture */
const GIF_BOX = { x: 350, y: 10, w: 240, h: 128 };
const STRIP_Y = 198;

/**
 * Copy a rectangle of the pixel video into a box (cover), keeping hard edges
 * @param {CanvasRenderingContext2D} ctx
 * @param {CanvasImageSource} src
 * @param {{ x: number, y: number, w: number, h: number }} r - Source rect
 */
function blit(ctx, src, r, dx, dy, dw, dh) {
  let { x: sx, y: sy, w: sw, h: sh } = r;
  const sa = sw / sh;
  const da = dw / dh;
  if (da > sa) {
    const nh = sw / da;
    sy += (sh - nh) / 2;
    sh = nh;
  } else {
    const nw = sh * da;
    sx += (sw - nw) / 2;
    sw = nw;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
}

/**
 * Everything a scene needs between frames: offscreen canvases and the
 * strip's thumbnails per cast member and backdrop
 */
export class StageBuffers {
  constructor() {
    this.video = makeCanvas(LW, LH);
    this.gif = makeCanvas(LW, LH);
    this.cutout = makeCanvas(LW, LH);
    this.tint = makeCanvas(LW, LH);
    /** @type {Map<string, HTMLCanvasElement[]>} */
    this.thumbs = new Map();
  }

  /** Forget thumbnails (their pixel size depends on the canvas scale) */
  reset() {
    this.thumbs.clear();
  }
}

/**
 * Render the pixel video at time t
 * @param {HTMLCanvasElement} target - LWxLH
 * @param {import('./cast.js').CastMember} cast
 * @param {import('./backdrops.js').Backdrop} backdrop
 * @param {{ cyan: string, magenta: string }} plates
 * @param {boolean} [withBackdrop=true]
 */
export function renderVideo(target, t, cast, backdrop, plates, withBackdrop = true) {
  const g = target.getContext('2d');
  if (!g) return target;
  g.clearRect(0, 0, LW, LH);
  g.imageSmoothingEnabled = false;
  if (withBackdrop) backdrop.draw(g, t);
  cast.draw(g, t, { bg: withBackdrop, plates });
  return target;
}

/**
 * The strip's 16 thumbnails: the video at the moment each frame was
 * recorded. Built once per cast member and backdrop.
 */
function thumbnails(buffers, cast, backdrop, plates, scale) {
  const key = `${cast.key}:${backdrop.key}`;
  let list = buffers.thumbs.get(key);
  if (list) return list;
  const scratch = makeCanvas(LW, LH);
  list = Array.from({ length: STRIP.frames }, (_, i) => {
    const c = makeCanvas(STRIP.width * scale, STRIP.height * scale);
    renderVideo(scratch, frameTime(i), cast, backdrop, plates);
    const ctx = c.getContext('2d');
    if (ctx) blit(ctx, scratch, { x: 0, y: 0, w: LW, h: LH }, 0, 0, c.width, c.height);
    return c;
  });
  buffers.thumbs.set(key, list);
  return list;
}

/**
 * Draw the scene at time t
 * @param {CanvasRenderingContext2D} ctx - Scaled so the scene is 600x240 units
 * @param {number} t - Seconds into the loop (0..CYCLE)
 * @param {{
 *   cast: import('./cast.js').CastMember,
 *   backdrop: import('./backdrops.js').Backdrop,
 *   palette: Palette,
 *   buffers: StageBuffers,
 *   scale: number,
 *   bufferSeconds: number,
 * }} scene
 */
export function drawStage(ctx, t, scene) {
  const { cast, backdrop, palette: P, buffers, scale, bufferSeconds } = scene;
  const plates = { cyan: P.cyan, magenta: P.magenta };
  const p = (t / CYCLE) * 100;
  const rr = (x, y, w, h, r, fill, stroke) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };
  const font = (weight, size, family) => {
    ctx.font = `${weight} ${size}px ${family}`;
  };

  ctx.globalAlpha = 1;

  /* ---- the window being recorded ---- */
  rr(0.5, 0.5, 299, 179, 8, P.window, P.lineStrong);
  for (const x of [10, 17, 24]) {
    ctx.beginPath();
    ctx.arc(x, 9, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = P.lineStrong;
    ctx.fill();
  }
  ctx.fillStyle = P.line;
  ctx.fillRect(1, 18, 298, 1);
  if (t % 1 < 0.5) {
    ctx.beginPath();
    ctx.arc(266, 9, 3, 0, Math.PI * 2);
    ctx.fillStyle = P.rec;
    ctx.fill();
  }
  ctx.fillStyle = P.text2;
  font(600, 9, P.mono);
  ctx.textBaseline = 'middle';
  ctx.fillText('REC', 273, 9.5);

  renderVideo(buffers.video, t, cast, backdrop, plates);
  ctx.save();
  ctx.beginPath();
  ctx.rect(SHOT.x, SHOT.y, SHOT.w, SHOT.h);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buffers.video, SHOT.x, SHOT.y, SHOT.w, SHOT.h);

  /* ---- the crop closes in on the subject ---- */
  if (p > BEATS.crop[0]) {
    const e = easeInOut(seg(p, ...BEATS.crop));
    const c = cast.crop;
    const target = { x: SHOT.x + c.x * 2, y: SHOT.y + c.y * 2, w: c.w * 2, h: c.h * 2 };
    const r = {
      x: lerp(SHOT.x, target.x, e),
      y: lerp(SHOT.y, target.y, e),
      w: lerp(SHOT.w, target.w, e),
      h: lerp(SHOT.h, target.h, e),
    };
    ctx.fillStyle = `rgba(6, 8, 12, ${0.6 * Math.min(1, seg(p, BEATS.crop[0], BEATS.crop[0] + 3))})`;
    ctx.beginPath();
    ctx.rect(SHOT.x, SHOT.y, SHOT.w, SHOT.h);
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill('evenodd');
    ctx.strokeStyle = P.cyan;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha *= 0.35;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(r.x + (r.w * i) / 3, r.y);
      ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
      ctx.moveTo(r.x, r.y + (r.h * i) / 3);
      ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
    }
    ctx.stroke();
    ctx.globalAlpha /= 0.35;
    ctx.fillStyle = P.cyan;
    const L = 7;
    const T = 2.5;
    const corner = (x, y, sx, sy) => {
      ctx.fillRect(sx > 0 ? x - T / 2 : x - L + T / 2, y - T / 2, L, T);
      ctx.fillRect(x - T / 2, sy > 0 ? y - T / 2 : y - L + T / 2, T, L);
    };
    corner(r.x, r.y, 1, 1);
    corner(r.x + r.w, r.y, -1, 1);
    corner(r.x, r.y + r.h, 1, -1);
    corner(r.x + r.w, r.y + r.h, -1, -1);
    if (e > 0.6) {
      const a = seg(e, 0.6, 1);
      ctx.globalAlpha *= a;
      rr(r.x + 4, r.y + 4, 24, 11, 3, P.cyan);
      ctx.fillStyle = P.onPaper;
      font(600, 7.5, P.mono);
      ctx.textAlign = 'center';
      ctx.fillText(c.ratio, r.x + 16, r.y + 9.8);
      ctx.textAlign = 'left';
      ctx.globalAlpha /= a;
    }
  }
  ctx.restore();

  ctx.fillStyle = P.line;
  ctx.fillRect(1, 161.5, 298, 1);
  ctx.beginPath();
  ctx.moveTo(10, 167.5);
  ctx.lineTo(16, 171);
  ctx.lineTo(10, 174.5);
  ctx.closePath();
  ctx.fillStyle = P.text2;
  ctx.fill();
  rr(23, 170, 236, 2, 1, P.track);
  rr(23, 170, 236 * lerp(0.22, 0.72, t / CYCLE), 2, 1, P.text2);
  ctx.fillStyle = P.muted;
  font(500, 8, P.mono);
  ctx.fillText(`01:${String(20 + Math.floor(t)).padStart(2, '0')}`, 265, 171.5);

  /* ---- "Create Clip": lifts off its magenta plate, then lands ---- */
  const [c0, c1] = BEATS.createClip;
  if (p > c0 && p < c1) {
    const a = p < c0 + 3 ? seg(p, c0, c0 + 3) : p > c1 - 5 ? 1 - seg(p, c1 - 5, c1) : 1;
    const lift =
      p > c0 + 3 && p < c0 + 7
        ? p < c0 + 5
          ? seg(p, c0 + 3, c0 + 5)
          : 1 - seg(p, c0 + 5, c0 + 7)
        : 0;
    const dy = p < c0 + 3 ? (1 - a) * 6 : p > c1 - 5 ? -(1 - a) * 6 : 0;
    ctx.save();
    ctx.globalAlpha *= a;
    if (lift > 0) rr(408 + 3 * lift, 76 + dy + 3 * lift, 86, 24, 5, P.magenta);
    rr(408 - 2 * lift, 76 + dy - 2 * lift, 86, 24, 5, P.paper);
    ctx.fillStyle = P.onPaper;
    font(600, 11, P.sans);
    ctx.textAlign = 'center';
    ctx.fillText('Create Clip', 451 - 2 * lift, 88.5 + dy - 2 * lift);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  /* ---- the GIF card ---- */
  if (p > BEATS.gif[0]) {
    const e = easeOut(seg(p, ...BEATS.gif));
    const dy = (1 - e) * 10;
    const c = cast.crop;
    const ar = c.w / c.h;
    let gw = GIF_BOX.h * ar;
    let gh = GIF_BOX.h;
    if (gw > GIF_BOX.w) {
      gw = GIF_BOX.w;
      gh = gw / ar;
    }
    const wx = GIF_BOX.x + (GIF_BOX.w - gw) / 2;
    const wy = GIF_BOX.y + (GIF_BOX.h - gh) / 2 + dy;
    ctx.save();
    ctx.globalAlpha *= Math.min(1, seg(p, BEATS.gif[0], BEATS.gif[0] + 3) * 1.2);
    // two plates close in on the card as it comes into register
    if (e < 1) {
      ctx.save();
      ctx.globalAlpha *= 0.75 * (1 - e);
      rr(340 - 8 * (1 - e), dy, 260, 180, 8, P.cyan);
      rr(340 + 8 * (1 - e), dy, 260, 180, 8, P.magenta);
      ctx.restore();
    }
    rr(340.5, dy + 0.5, 259, 179, 8, P.panel, P.lineStrong);
    // the GIF loops the moment at 10fps
    const step = Math.floor(Math.max(0, t - (BEATS.gif[0] / 100) * CYCLE) / 0.1) % 16;
    const gt = lerp(cast.m0, cast.m1, step / 15);
    const sweep = easeInOut(seg(p, ...BEATS.alpha));
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(wx, wy, gw, gh, 4);
    ctx.clip();
    // the moment with its background, where the sweep has not cleared it yet
    if (sweep < 1) {
      renderVideo(buffers.gif, gt, cast, backdrop, plates);
      ctx.save();
      ctx.beginPath();
      ctx.rect(wx + gw * sweep, wy, gw * (1 - sweep), gh);
      ctx.clip();
      blit(ctx, buffers.gif, c, wx, wy, gw, gh);
      ctx.restore();
    }
    // then its background clears: a checkerboard, the subject traced in cyan
    if (sweep > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(wx, wy, gw * sweep, gh);
      ctx.clip();
      ctx.fillStyle = '#25272d';
      ctx.fillRect(wx, wy, gw, gh);
      ctx.fillStyle = '#3a3d46';
      for (let yy = 0; yy < gh; yy += 8) {
        for (let xx = 0; xx < gw; xx += 8)
          if (((xx + yy) / 8) % 2) ctx.fillRect(wx + xx, wy + yy, 8, 8);
      }
      renderVideo(buffers.cutout, gt, cast, backdrop, plates, false);
      const trace =
        p < BEATS.alpha[1] ? 0.9 : 0.9 * (1 - seg(p, BEATS.alpha[1], BEATS.alpha[1] + 3));
      const tc = buffers.tint.getContext('2d');
      if (trace > 0 && tc) {
        tc.globalCompositeOperation = 'source-over';
        tc.clearRect(0, 0, LW, LH);
        tc.drawImage(buffers.cutout, 0, 0);
        tc.globalCompositeOperation = 'source-in';
        tc.fillStyle = P.cyan;
        tc.fillRect(0, 0, LW, LH);
        tc.globalCompositeOperation = 'source-over';
        ctx.globalAlpha *= trace;
        for (const [ox, oy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) {
          blit(ctx, buffers.tint, c, wx + ox * 1.4, wy + oy * 1.4, gw, gh);
        }
        ctx.globalAlpha /= trace;
      }
      blit(ctx, buffers.cutout, c, wx, wy, gw, gh);
      ctx.restore();
    }
    ctx.restore();
    rr(wx + 0.5, wy + 0.5, gw - 1, gh - 1, 4, null, P.lineStrong);
    ctx.fillStyle = P.text2;
    font(500, 10, P.mono);
    ctx.textBaseline = 'middle';
    ctx.fillText(cast.file, 350, 157 + dy);
    ctx.fillStyle = P.muted;
    font(500, 8.5, P.mono);
    ctx.textAlign = 'right';
    ctx.fillText(`${c.ratio} · 10fps${sweep > 0.5 ? ' · alpha' : ''}`, 562, 157.5 + dy);
    ctx.textAlign = 'left';
    rr(568, 150 + dy, 22, 14, 3, P.paper);
    ctx.fillStyle = P.onPaper;
    font(600, 9, P.mono);
    ctx.fillText('GIF', 571.5, 157.5 + dy);
    ctx.restore();
  }

  /* ---- the buffer strip: frames enter at "now" and fall off the past end ---- */
  const off = STRIP.scroll * seg(p, ...BEATS.stripStop);
  const y0 = STRIP_Y;
  ctx.fillStyle = P.muted;
  font(500, 9, P.mono);
  ctx.textBaseline = 'middle';
  ctx.fillText(`−${bufferSeconds}s`, 0, y0 - 9);
  ctx.fillStyle = P.rec;
  ctx.textAlign = 'right';
  ctx.fillText('now', 600, y0 - 9);
  ctx.textAlign = 'left';
  const thumbs = thumbnails(buffers, cast, backdrop, plates, scale);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y0, STRIP.now, 44);
  ctx.clip();
  for (let i = 0; i < STRIP.frames; i++) {
    const x = i * STRIP.pitch - off;
    if (x > STRIP.now || x + STRIP.width < 0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y0 + 4, STRIP.width, STRIP.height, 3);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(thumbs[i], x, y0 + 4, STRIP.width, STRIP.height);
    ctx.restore();
    rr(x + 0.5, y0 + 4.5, STRIP.width - 1, STRIP.height - 1, 3, null, P.lineStrong);
  }
  ctx.restore();
  // the oldest frames fade out: erase toward the left edge, whatever is behind
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const fade = ctx.createLinearGradient(0, 0, 108, 0);
  fade.addColorStop(0, 'rgba(0, 0, 0, 1)');
  fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, y0, 108, 44);
  ctx.restore();
  // the selection over the last frames
  if (p > BEATS.bracket[0]) {
    const e = easeOut(seg(p, ...BEATS.bracket));
    const bw = 300 * e;
    ctx.save();
    ctx.globalAlpha *= e;
    rr(596 - bw, y0 + 1, bw, 41, 4, 'rgba(34, 211, 238, 0.08)');
    ctx.strokeStyle = P.cyan;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(597 - bw, y0 + 1, bw - 2, 40, 4);
    ctx.stroke();
    ctx.fillStyle = P.cyan;
    ctx.fillRect(594 - bw, y0 + 9, 4, 25);
    ctx.fillRect(594, y0 + 9, 4, 25);
    ctx.restore();
  }
  // "now": the live edge
  ctx.save();
  ctx.shadowColor = P.rec;
  ctx.shadowBlur = 6;
  ctx.fillStyle = P.rec;
  ctx.fillRect(597, y0 - 4, 2, 48);
  ctx.restore();

  // the loop fades in and out as one picture: erasing a share of every pixel
  // keeps overlapping layers from showing through each other mid-fade
  const opacity =
    p < BEATS.fadeIn[1]
      ? seg(p, ...BEATS.fadeIn)
      : p > BEATS.fadeOut[0]
        ? 1 - seg(p, ...BEATS.fadeOut)
        : 1;
  if (opacity < 1) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0, 0, 0, ${1 - opacity})`;
    ctx.fillRect(0, 0, 600, 240);
    ctx.restore();
  }
}
