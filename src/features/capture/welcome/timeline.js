/**
 * Welcome scene timeline and casting
 * @module features/capture/welcome/timeline
 *
 * One loop of the welcome scene lasts {@link CYCLE} seconds. The scene's own
 * beats (Create Clip, the selection, the crop, the GIF card) are placed in
 * percent of the loop; the cast's beats (the run, the jump, the punchline)
 * are in seconds, so every cast member hits the same marks.
 *
 * Casting is random but deterministic: given a session seed and a loop
 * index, {@link pickForLoop} always returns the same cast member and
 * backdrop, and the cast member never repeats from one loop to the next.
 */

/** Seconds per loop */
export const CYCLE = 9;

/** The cast's beats, in seconds */
export const CROUCH = 2.6;
export const JUMP0 = 2.8;
export const JUMP1 = 3.4;

/** The scene's beats, in percent of the loop: [start, end] */
export const BEATS = {
  fadeIn: [0, 4],
  stripStop: [4, 60],
  createClip: [54, 69],
  bracket: [62, 67],
  crop: [66, 74],
  gif: [72, 80],
  alpha: [80, 87],
  fadeOut: [93, 100],
};

/** When a still is wanted (reduced motion): the finished, cut-out GIF */
export const STILL_TIME = 8.2;

/** The buffer strip under the screen, in scene units (600x240) */
export const STRIP = { frames: 16, pitch: 60, width: 54, height: 34, scroll: 360, now: 597 };

/**
 * When strip frame `k` reached "now": the moment of the video it shows
 * (negative for frames recorded before the loop began)
 * @param {number} k
 * @returns {number} seconds
 */
export function frameTime(k) {
  const [a, b] = BEATS.stripStop;
  const percent = a + ((k * STRIP.pitch - STRIP.now) / STRIP.scroll) * (b - a);
  return (percent / 100) * CYCLE;
}

export const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** Progress of `v` through [a, b], clamped to 0..1 */
export const seg = (v, a, b) => clamp01((v - a) / (b - a));
export const lerp = (a, b, s) => a + (b - a) * s;
export const easeOut = (x) => 1 - (1 - x) ** 3;
export const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
/** `a mod n` that stays positive for negative `a` */
export const mod = (a, n) => ((a % n) + n) % n;

/**
 * Small seeded PRNG (mulberry32)
 * @param {number} seed
 * @returns {() => number} 0 <= x < 1
 */
export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mix two integers into a seed
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function mixSeed(a, b) {
  return Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
}

/**
 * A seeded shuffle of 0..n-1
 * @param {number} n
 * @param {number} seed
 * @returns {number[]}
 */
function permutation(n, seed) {
  const order = Array.from({ length: n }, (_, i) => i);
  const random = rng(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Who stars in loop `loop`, and in front of which backdrop.
 *
 * The cast is dealt in rounds: each round is a shuffle of the whole cast, so
 * everyone appears equally often. Where two rounds meet, the first two of the
 * new round swap if needed so nobody appears twice in a row (with three or
 * more members the swap never touches a round's last slot, so the check
 * against the previous round's last member stays valid). The backdrop is a
 * coin toss per loop.
 *
 * @param {number} seed - Session seed
 * @param {number} loop - Loop index (0, 1, 2, ...)
 * @param {number} castCount
 * @param {number} backdropCount
 * @returns {{ cast: number, backdrop: number }}
 */
export function pickForLoop(seed, loop, castCount, backdropCount) {
  const backdrop = Math.floor(rng(mixSeed(seed, loop * 2 + 1))() * backdropCount);
  if (castCount <= 1) return { cast: 0, backdrop };
  if (castCount === 2) {
    const first = Math.floor(rng(seed)() * 2);
    return { cast: (first + loop) % 2, backdrop };
  }
  const round = Math.floor(loop / castCount);
  const order = permutation(castCount, mixSeed(seed, round));
  if (round > 0) {
    const previous = permutation(castCount, mixSeed(seed, round - 1));
    if (order[0] === previous[castCount - 1]) [order[0], order[1]] = [order[1], order[0]];
  }
  return { cast: order[loop % castCount], backdrop };
}
