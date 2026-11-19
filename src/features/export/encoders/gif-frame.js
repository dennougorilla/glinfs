/**
 * One GIF frame after the first, encoded in steps.
 *
 * The bytes are the ones gifenc's writeFrame writes for a frame that is not
 * the first (graphic control extension, image descriptor, local color table,
 * LZW data); the LZW coder is gifenc's (MIT, Matt DesLauriers, after
 * GIFCOMPR.C), restructured so that it can stop between pixels and resume.
 * That lets two encodings of one frame be run side by side and the larger
 * one be dropped as soon as it cannot be the smaller (see encodeSmaller).
 *
 * @module features/export/encoders/gif-frame
 */

const BITS = 12;
const HSIZE = 5003;
const MASKS = [
  0x0000, 0x0001, 0x0003, 0x0007, 0x000f, 0x001f, 0x003f, 0x007f, 0x00ff, 0x01ff, 0x03ff, 0x07ff,
  0x0fff, 0x1fff, 0x3fff, 0x7fff, 0xffff,
];
/** gifenc writes every frame with colorDepth 8, whatever the palette size */
const COLOR_DEPTH = 8;
/** Pixels coded per step before the encodings' sizes are compared again */
export const STEP_PIXELS = 1 << 12;

/**
 * @typedef {Object} FrameOptions
 * @property {number[][]} palette - Local color table
 * @property {number} delay - Milliseconds (written in 1/100 s, rounded)
 * @property {number} [dispose=-1]
 * @property {boolean} [transparent=false]
 * @property {number} [transparentIndex=0]
 */

/**
 * A byte buffer that grows like gifenc's stream
 * @param {number} capacity
 */
function createBuffer(capacity) {
  let bytes = new Uint8Array(capacity);
  let length = 0;
  /** @param {number} needed */
  const expand = (needed) => {
    if (bytes.length >= needed) return;
    const grown = new Uint8Array(Math.max(needed, bytes.length * 2));
    grown.set(bytes.subarray(0, length));
    bytes = grown;
  };
  return {
    get length() {
      return length;
    },
    reset() {
      length = 0;
    },
    /** @param {number} b */
    byte(b) {
      expand(length + 1);
      bytes[length++] = b;
    },
    /** @param {Uint8Array} data @param {number} count */
    bytes(data, count) {
      expand(length + count);
      bytes.set(data.subarray(0, count), length);
      length += count;
    },
    view() {
      return bytes.subarray(0, length);
    },
  };
}

/** @param {number} length */
function colorTableSize(length) {
  return Math.max(Math.ceil(Math.log2(length)), 1);
}

/**
 * Write the graphic control extension, image descriptor and local color
 * table exactly as gifenc does for a frame that is not the first
 * @param {ReturnType<typeof createBuffer>} out
 * @param {number} width
 * @param {number} height
 * @param {FrameOptions} opts
 */
function writeFrameHeader(out, width, height, opts) {
  const { palette, delay, dispose = -1 } = opts;
  let { transparent = false, transparentIndex = 0 } = opts;
  if (transparentIndex < 0) {
    transparentIndex = 0;
    transparent = false;
  }
  let disp = transparent ? 2 : 0;
  if (dispose >= 0) disp = dispose & 7;
  const delayTime = Math.round(delay / 10);
  out.byte(0x21);
  out.byte(0xf9);
  out.byte(4);
  out.byte((disp << 2) | (transparent ? 1 : 0));
  out.byte(delayTime & 0xff);
  out.byte((delayTime >> 8) & 0xff);
  out.byte(transparentIndex || 0);
  out.byte(0);

  const size = colorTableSize(palette.length);
  out.byte(0x2c);
  out.byte(0);
  out.byte(0);
  out.byte(0);
  out.byte(0);
  out.byte(width & 0xff);
  out.byte((width >> 8) & 0xff);
  out.byte(height & 0xff);
  out.byte((height >> 8) & 0xff);
  out.byte(0x80 | (size - 1));
  for (let i = 0; i < 1 << size; i++) {
    const color = i < palette.length ? palette[i] : null;
    out.byte(color ? color[0] : 0);
    out.byte(color ? color[1] : 0);
    out.byte(color ? color[2] : 0);
  }
}

/**
 * A frame encoding that runs a slice of pixels at a time.
 *
 * `bound()` is a lower bound on the final size: the bytes written so far
 * plus the packet bytes held in the accumulator. Output only grows, so once
 * the bound passes a size, the final size does too.
 */
export function createFrameEncoding() {
  const out = createBuffer(1 << 16);
  const accum = new Uint8Array(256);
  const htab = new Int32Array(HSIZE);
  const codetab = new Int32Array(HSIZE);
  let hshift = 0;
  for (let fcode = HSIZE; fcode < 65536; fcode *= 2) ++hshift;
  hshift = 8 - hshift;

  /** @type {Uint8Array} */
  let pixels = new Uint8Array(0);
  let idx = 0;
  let ent = 0;
  let curAccum = 0;
  let curBits = 0;
  let clearFlg = false;
  let nBits = 0;
  let maxcode = 0;
  let freeEnt = 0;
  let aCount = 0;
  let done = false;
  const initBits = Math.max(2, COLOR_DEPTH) + 1;
  const clearCode = 1 << (initBits - 1);
  const eofCode = clearCode + 1;

  /** @param {number} code */
  const output = (code) => {
    curAccum &= MASKS[curBits];
    if (curBits > 0) curAccum |= code << curBits;
    else curAccum = code;
    curBits += nBits;
    while (curBits >= 8) {
      accum[aCount++] = curAccum & 0xff;
      if (aCount >= 254) {
        out.byte(aCount);
        out.bytes(accum, aCount);
        aCount = 0;
      }
      curAccum >>= 8;
      curBits -= 8;
    }
    if (freeEnt > maxcode || clearFlg) {
      if (clearFlg) {
        nBits = initBits;
        maxcode = (1 << nBits) - 1;
        clearFlg = false;
      } else {
        ++nBits;
        maxcode = nBits === BITS ? 1 << nBits : (1 << nBits) - 1;
      }
    }
    if (code === eofCode) {
      while (curBits > 0) {
        accum[aCount++] = curAccum & 0xff;
        if (aCount >= 254) {
          out.byte(aCount);
          out.bytes(accum, aCount);
          aCount = 0;
        }
        curAccum >>= 8;
        curBits -= 8;
      }
      if (aCount > 0) {
        out.byte(aCount);
        out.bytes(accum, aCount);
        aCount = 0;
      }
    }
  };

  return {
    /**
     * Start encoding a frame (drops any previous one)
     * @param {Uint8Array} index - Palette indices, width * height
     * @param {number} width
     * @param {number} height
     * @param {FrameOptions} opts
     */
    start(index, width, height, opts) {
      out.reset();
      writeFrameHeader(out, width, height, opts);
      pixels = index;
      accum.fill(0);
      codetab.fill(0);
      htab.fill(-1);
      curAccum = 0;
      curBits = 0;
      clearFlg = false;
      nBits = initBits;
      maxcode = (1 << nBits) - 1;
      freeEnt = clearCode + 2;
      aCount = 0;
      ent = pixels[0];
      idx = 1;
      done = false;
      out.byte(initBits - 1);
      output(clearCode);
    },

    /**
     * Code up to `count` more pixels; at the end, write the final codes
     * @param {number} count
     * @returns {boolean} Whether the frame is complete
     */
    step(count) {
      if (done) return true;
      // Locals in the hot loop (closure variables are slower to reach)
      const px = pixels;
      const hash = htab;
      const codes = codetab;
      const shift = hshift;
      const end = Math.min(px.length, idx + count);
      let i = idx;
      let prefix = ent;
      for (; i < end; i++) {
        const c = px[i];
        const fcode = (c << BITS) + prefix;
        let h = (c << shift) ^ prefix;
        if (hash[h] === fcode) {
          prefix = codes[h];
          continue;
        }
        const disp = h === 0 ? 1 : HSIZE - h;
        let found = false;
        while (hash[h] >= 0) {
          h -= disp;
          if (h < 0) h += HSIZE;
          if (hash[h] === fcode) {
            found = true;
            break;
          }
        }
        if (found) {
          prefix = codes[h];
          continue;
        }
        output(prefix);
        prefix = c;
        if (freeEnt < 1 << BITS) {
          codes[h] = freeEnt++;
          hash[h] = fcode;
        } else {
          hash.fill(-1);
          freeEnt = clearCode + 2;
          clearFlg = true;
          output(clearCode);
        }
      }
      idx = i;
      ent = prefix;
      if (idx < px.length) return false;
      output(ent);
      output(eofCode);
      out.byte(0);
      done = true;
      return true;
    },

    /** A lower bound on the final size in bytes (the size once complete) */
    bound() {
      return out.length + aCount;
    },

    /** The frame's bytes; valid until the next start */
    view() {
      return out.view();
    },
  };
}

/**
 * Encode a frame completely
 * @param {ReturnType<typeof createFrameEncoding>} encoding
 * @param {Uint8Array} index
 * @param {number} width
 * @param {number} height
 * @param {FrameOptions} opts
 * @returns {Uint8Array} A view valid until the encoding's next start
 */
export function encodeFrame(encoding, index, width, height, opts) {
  encoding.start(index, width, height, opts);
  encoding.step(Number.POSITIVE_INFINITY);
  return encoding.view();
}

/**
 * Encode two versions of a frame and return the bytes of the smaller, with
 * the first winning a tie: exactly what encoding both completely and
 * comparing gives, with less work.
 *
 * The encodings take turns, the one with fewer bytes so far going next.
 * When one is complete, the other only continues while its lower bound
 * could still beat it (below for the second, at most equal for the first):
 * its output only grows, so past that it cannot win and is dropped.
 *
 * @param {ReturnType<typeof createFrameEncoding>} first - Started
 * @param {ReturnType<typeof createFrameEncoding>} second - Started
 * @returns {{ bytes: Uint8Array, second: boolean }} The winner's bytes (a
 *   view valid until its encoding's next start) and whether it is `second`
 */
export function encodeSmaller(first, second) {
  let firstDone = false;
  let secondDone = false;
  while (!firstDone && !secondDone) {
    if (first.bound() <= second.bound()) firstDone = first.step(STEP_PIXELS);
    else secondDone = second.step(STEP_PIXELS);
  }
  if (firstDone) {
    const size = first.bound();
    while (!secondDone && second.bound() < size) secondDone = second.step(STEP_PIXELS);
    const wins = secondDone && second.bound() < size;
    return wins ? { bytes: second.view(), second: true } : { bytes: first.view(), second: false };
  }
  const size = second.bound();
  while (!firstDone && first.bound() <= size) firstDone = first.step(STEP_PIXELS);
  const wins = firstDone && first.bound() <= size;
  return wins ? { bytes: first.view(), second: false } : { bytes: second.view(), second: true };
}
