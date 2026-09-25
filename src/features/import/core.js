/**
 * Import Core - pure logic for opening GIF / image files as clips
 * @module features/import/core
 *
 * No DOM, no WebCodecs: everything here is unit-testable in isolation.
 *
 * Timing model: an imported clip is a constant-fps clip like a screen
 * capture. The fps is chosen from the GCD of the source frame delays, and a
 * source frame whose delay spans several 1/fps periods becomes that many
 * "slots" (repeated frames). Uniform GIFs therefore import 1:1, and holds
 * become repeated slots that the exporter merges back into one GIF frame.
 */

/** Largest file accepted (bytes) */
export const MAX_IMPORT_FILE_BYTES = 200 * 1024 * 1024;

/** Largest clip (in constant-fps slots) an import may produce */
export const MAX_IMPORT_TOTAL_SLOTS = 3600;

/** Fps used for a single still image (matches the capture default) */
export const STILL_IMAGE_FPS = 30;

/** Upper bound for a chosen import fps (GIF delays are centiseconds) */
export const MAX_IMPORT_FPS = 50;

/**
 * Delay browsers substitute for a 0/1 cs GIF delay (ms). Chromium, Firefox
 * and Safari all play such frames at 100 ms.
 */
const MIN_DELAY_REPLACEMENT_MS = 100;

/**
 * MIME types the importer accepts (still decoded by ImageDecoder, which may
 * still refuse a type at runtime: see decode.js).
 * @type {readonly string[]}
 */
export const ACCEPTED_IMPORT_TYPES = Object.freeze([
  'image/gif',
  'image/png',
  'image/apng',
  'image/webp',
  'image/jpeg',
]);

/** File extension -> MIME type, for files whose type the OS left empty */
const EXTENSION_TYPES = Object.freeze({
  gif: 'image/gif',
  png: 'image/png',
  apng: 'image/apng',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
});

/** `accept` attribute for the file input: MIME types plus extensions */
export const IMPORT_ACCEPT_ATTRIBUTE = [
  ...ACCEPTED_IMPORT_TYPES,
  ...Object.keys(EXTENSION_TYPES).map((ext) => `.${ext}`),
].join(',');

/**
 * @typedef {'unsupported-type'|'file-too-large'|'empty-file'|'too-many-frames'|'decode-failed'|'aborted'|'queue-full'|'memory-budget'|'busy'} ImportErrorCode
 */

/**
 * An import refusal or failure with a user-facing message.
 */
export class ImportError extends Error {
  /**
   * @param {ImportErrorCode} code
   * @param {string} message - Plain-English, shown to the user as-is
   * @param {Record<string, unknown>} [detail] - Extra data for the reporter
   *   (e.g. the memory-budget projection)
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'ImportError';
    /** @type {ImportErrorCode} */
    this.code = code;
    /** @type {Record<string, unknown>|undefined} */
    this.detail = detail;
  }
}

/**
 * Resolve the MIME type to decode a file as. Uses the browser-reported type
 * when it is one we accept, else falls back to the file extension (dropped
 * files sometimes arrive with an empty type).
 * @param {{ name?: string, type?: string }} file
 * @returns {string|null} Accepted MIME type, or null when unsupported
 */
export function resolveImportMimeType(file) {
  const type = (file?.type ?? '').toLowerCase();
  if (ACCEPTED_IMPORT_TYPES.includes(type)) return type;
  if (type) return null;
  const match = /\.([a-z0-9]+)$/i.exec(file?.name ?? '');
  const ext = match ? match[1].toLowerCase() : '';
  return Object.hasOwn(EXTENSION_TYPES, ext) ? EXTENSION_TYPES[ext] : null;
}

/**
 * Check a file before reading it.
 * @param {{ name?: string, type?: string, size?: number }} file
 * @returns {ImportError|null} The refusal, or null when the file may be decoded
 */
export function validateImportFile(file) {
  if (!resolveImportMimeType(file)) {
    return new ImportError(
      'unsupported-type',
      `Can't open "${file?.name ?? 'file'}" — choose a GIF, PNG, APNG, WebP or JPEG image`,
    );
  }
  const size = file?.size ?? 0;
  if (size <= 0) {
    return new ImportError('empty-file', `"${file?.name ?? 'file'}" is empty`);
  }
  if (size > MAX_IMPORT_FILE_BYTES) {
    return new ImportError(
      'file-too-large',
      `"${file.name}" is ${Math.round(size / (1024 * 1024))} MB — files up to ${
        MAX_IMPORT_FILE_BYTES / (1024 * 1024)
      } MB can be opened`,
    );
  }
  return null;
}

/**
 * Normalize one frame duration: missing/0/1 cs delays play at 100 ms in
 * browsers, everything else is rounded to the GIF's 10 ms resolution.
 * @param {number|null|undefined} ms
 * @returns {number} Duration in ms, a positive multiple of 10
 */
export function normalizeFrameDurationMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 10) {
    return MIN_DELAY_REPLACEMENT_MS;
  }
  return Math.max(10, Math.round(ms / 10) * 10);
}

/**
 * Greatest common divisor of two non-negative integers
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function gcd(a, b) {
  let x = a;
  let y = b;
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * Choose the clip fps for a set of source frame durations, so that an
 * unedited import exports with its original timing.
 *
 * gcdCs is the GCD of the normalized durations in centiseconds. The export
 * writes `round(runLength * 100 / fps)` cs per GIF frame, so the timing is
 * exact only when the slot period `100 / fps` is a whole number of
 * centiseconds that divides every duration. The largest such period is
 * `gcd(gcdCs, 100)` cs, giving `fps = 100 / gcd(gcdCs, 100)` (e.g. 400 ms
 * frames -> 5 fps, 150 ms -> 20 fps, 700 ms -> 10 fps). Plain
 * `round(100 / gcdCs)` would turn uniform 400 ms frames into 3 fps with
 * 1/1/2 slots (330/330/670 ms).
 *
 * When that period would need more than 50 fps (gcdCs shares no factor with
 * 100, e.g. 30 or 70 ms frames), fall back to `clamp(round(100 / gcdCs), 1, 50)`:
 * its period rounds to gcdCs, so uniform timing still exports exactly.
 * A single still image gets 30 fps.
 *
 * @param {Array<number|null|undefined>} durationsMs
 * @returns {number} Integer fps in 1..50
 */
export function chooseImportFps(durationsMs) {
  if (!durationsMs || durationsMs.length <= 1) return STILL_IMAGE_FPS;
  let gcdCs = 0;
  for (const ms of durationsMs) {
    gcdCs = gcd(gcdCs, normalizeFrameDurationMs(ms) / 10);
  }
  const exactFps = 100 / gcd(gcdCs, 100);
  if (exactFps <= MAX_IMPORT_FPS) return exactFps;
  return Math.min(MAX_IMPORT_FPS, Math.max(1, Math.round(100 / gcdCs)));
}

/**
 * Slots (constant-fps frames) per source frame, by cumulative rounding so
 * rounding error never accumulates across the clip:
 * `end_i = round(cumMs_i * fps / 1000)`, `slots_i = max(1, end_i - emitted)`
 * where `emitted` is the number of slots already handed out.
 *
 * Every source frame keeps at least one slot, so a frame shorter than one
 * period is never dropped. Measuring against `emitted` (rather than
 * `end_{i-1}`) lets a later, longer frame absorb the extra slot such a
 * short frame took, so the clip keeps its real total length whenever that
 * is possible. Without any forced slot the two are identical.
 *
 * @param {Array<number|null|undefined>} durationsMs - Per source frame
 * @param {number} fps
 * @returns {number[]} Slot count per source frame (each >= 1)
 */
export function computeFrameSlots(durationsMs, fps) {
  /** @type {number[]} */
  const slots = [];
  let cumulativeMs = 0;
  let emitted = 0;
  for (const ms of durationsMs) {
    cumulativeMs += normalizeFrameDurationMs(ms);
    const end = Math.round((cumulativeMs * fps) / 1000);
    const count = Math.max(1, end - emitted);
    slots.push(count);
    emitted += count;
  }
  return slots;
}

/**
 * Refuse imports that would exceed the clip length limit.
 * @param {number} totalSlots
 * @param {number} fps
 * @returns {ImportError|null}
 */
export function checkTotalSlots(totalSlots, fps) {
  if (totalSlots > MAX_IMPORT_TOTAL_SLOTS) {
    return new ImportError(
      'too-many-frames',
      `This animation is too long to edit (${totalSlots} frames at ${fps} fps) — ` +
        `the limit is ${MAX_IMPORT_TOTAL_SLOTS} frames`,
    );
  }
  return null;
}

/**
 * Refuse a source with more frames than any clip may have. Checked before
 * decoding so a huge animation is never materialized.
 * @param {number} sourceFrameCount
 * @returns {ImportError|null}
 */
export function checkSourceFrameCount(sourceFrameCount) {
  if (sourceFrameCount > MAX_IMPORT_TOTAL_SLOTS) {
    return new ImportError(
      'too-many-frames',
      `This animation has ${sourceFrameCount} frames — the limit is ${MAX_IMPORT_TOTAL_SLOTS}`,
    );
  }
  return null;
}

/**
 * Memory an import holds, at the same conservative raw-RGBA rate as
 * captured clips. Only UNIQUE source frames count: repeated slots are
 * clones sharing their source frame's pixels (see Frame.sharedKey).
 * @param {number} sourceFrameCount
 * @param {number} width
 * @param {number} height
 * @returns {number} MB
 */
export function projectImportMemoryMB(sourceFrameCount, width, height) {
  return (sourceFrameCount * width * height * 4) / (1024 * 1024);
}

/**
 * Whether an RGBA (or BGRA) buffer contains any pixel that is not fully
 * opaque. Stops at the first one.
 * @param {Uint8Array|Uint8ClampedArray} pixels - 4 bytes per pixel, alpha last
 * @returns {boolean}
 */
export function hasTransparentPixel(pixels) {
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 255) return true;
  }
  return false;
}

/**
 * Whether a VideoFrame pixel format can carry alpha at all.
 * @param {string|null|undefined} format - VideoFrame.format
 * @returns {boolean|null} true = has alpha channel, false = never has alpha,
 *   null = unknown (check by conversion)
 */
export function formatAlphaSupport(format) {
  switch (format) {
    case 'RGBA':
    case 'BGRA':
      return true;
    case 'RGBX':
    case 'BGRX':
    case 'I420':
    case 'I422':
    case 'I444':
    case 'NV12':
      return false;
    default:
      return null;
  }
}

/**
 * Busy label shown on the Capture screen while a file decodes.
 * @param {string} fileName
 * @param {number} [decoded] - Source frames decoded so far
 * @param {number} [total] - Source frames in the file
 * @returns {string}
 */
export function formatImportBusyLabel(fileName, decoded, total) {
  const base = `Opening ${fileName}…`;
  if (!total || total <= 1 || decoded === undefined) return base;
  return `${base} ${Math.min(100, Math.round((decoded / total) * 100))}%`;
}
