/**
 * Minimal GIF readers for unit tests. readGifStructure walks the block
 * stream and reports each image's Graphic Control Extension and color table
 * size, skipping the pixel data; decodeGifFrames also decodes each image's
 * LZW data to color indices (E2E specs decode real pixels with
 * ImageDecoder).
 */

/**
 * @typedef {Object} GifFrameInfo
 * @property {number} delayCs - GCE delay (centiseconds)
 * @property {number} disposal - GCE disposal method (0-7)
 * @property {boolean} transparent - GCE transparency flag
 * @property {number} transparentIndex - GCE transparent color index
 * @property {number} colorTableSize - Entries in the color table the image uses
 * @property {boolean} localColorTable - Whether the image has its own table
 */

/**
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number, frames: GifFrameInfo[] }}
 */
export function readGifStructure(bytes) {
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header !== 'GIF89a' && header !== 'GIF87a') {
    throw new Error(`Not a GIF: ${header}`);
  }
  const u16 = (/** @type {number} */ o) => bytes[o] | (bytes[o + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  const lsdFields = bytes[10];
  const globalTableSize = lsdFields & 0x80 ? 1 << ((lsdFields & 7) + 1) : 0;
  let pos = 13 + globalTableSize * 3;

  /** Skip a sequence of data sub-blocks */
  const skipSubBlocks = () => {
    while (bytes[pos] !== 0) pos += bytes[pos] + 1;
    pos++;
  };

  /** @type {GifFrameInfo[]} */
  const frames = [];
  /** @type {Omit<GifFrameInfo, 'colorTableSize' | 'localColorTable'> | null} */
  let gce = null;

  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[pos++];
      if (label === 0xf9) {
        const packed = bytes[pos + 1];
        gce = {
          disposal: (packed >> 2) & 7,
          transparent: (packed & 1) === 1,
          delayCs: u16(pos + 2),
          transparentIndex: bytes[pos + 4],
        };
      }
      skipSubBlocks();
    } else if (block === 0x2c) {
      const fields = bytes[pos + 8];
      const local = (fields & 0x80) !== 0;
      const localSize = local ? 1 << ((fields & 7) + 1) : 0;
      pos += 9 + localSize * 3;
      pos++; // LZW minimum code size
      skipSubBlocks();
      frames.push({
        delayCs: gce?.delayCs ?? 0,
        disposal: gce?.disposal ?? 0,
        transparent: gce?.transparent ?? false,
        transparentIndex: gce?.transparentIndex ?? 0,
        colorTableSize: local ? localSize : globalTableSize,
        localColorTable: local,
      });
      gce = null;
    } else {
      throw new Error(`Unexpected GIF block 0x${block.toString(16)} at ${pos - 1}`);
    }
  }

  return { width, height, frames };
}

/**
 * @typedef {Object} DecodedGifFrame
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 * @property {number | null} transparentIndex - null when the GCE sets no transparency
 * @property {Uint8Array} indices - Decoded color indices, row-major (no interlacing)
 */

/**
 * Decode one image's LZW data (GIF variant: LSB-first codes, variable code
 * size up to 12 bits, clear and end codes, no early change)
 * @param {number} minCodeSize
 * @param {Uint8Array} data - Concatenated sub-block payloads
 * @param {number} pixelCount
 * @returns {Uint8Array}
 */
function lzwDecode(minCodeSize, data, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = new Uint8Array(pixelCount);
  let outPos = 0;
  /** @type {number[][]} */
  let dict = [];
  let codeSize = minCodeSize + 1;
  /** @type {number[] | null} */
  let prev = null;
  const reset = () => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push([], []);
    codeSize = minCodeSize + 1;
    prev = null;
  };
  reset();

  let bitPos = 0;
  const totalBits = data.length * 8;
  while (bitPos + codeSize <= totalBits) {
    let code = 0;
    for (let b = 0; b < codeSize; b++, bitPos++) {
      code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << b;
    }
    if (code === clearCode) {
      reset();
      continue;
    }
    if (code === endCode) break;
    /** @type {number[]} */
    let entry;
    if (code < dict.length) {
      entry = dict[code];
    } else if (code === dict.length && prev) {
      entry = [...prev, prev[0]];
    } else {
      throw new Error(`Bad LZW code ${code}`);
    }
    for (const v of entry) {
      if (outPos < pixelCount) out[outPos++] = v;
    }
    if (prev && dict.length < 4096) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  if (outPos !== pixelCount) {
    throw new Error(`LZW data decoded to ${outPos} of ${pixelCount} pixels`);
  }
  return out;
}

/**
 * Decode every image's color indices (and its GCE transparency), so tests
 * can check which pixels an encoder wrote as the transparent index
 * @param {Uint8Array} bytes
 * @returns {DecodedGifFrame[]}
 */
export function decodeGifFrames(bytes) {
  const u16 = (/** @type {number} */ o) => bytes[o] | (bytes[o + 1] << 8);
  const lsdFields = bytes[10];
  const globalTableSize = lsdFields & 0x80 ? 1 << ((lsdFields & 7) + 1) : 0;
  let pos = 13 + globalTableSize * 3;

  /** @returns {Uint8Array} Concatenated payloads of a sub-block sequence */
  const readSubBlocks = () => {
    /** @type {number[]} */
    const payload = [];
    while (bytes[pos] !== 0) {
      const size = bytes[pos];
      for (let i = 1; i <= size; i++) payload.push(bytes[pos + i]);
      pos += size + 1;
    }
    pos++;
    return Uint8Array.from(payload);
  };

  /** @type {DecodedGifFrame[]} */
  const frames = [];
  /** @type {number | null} */
  let transparentIndex = null;
  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[pos++];
      if (label === 0xf9) {
        const packed = bytes[pos + 1];
        transparentIndex = packed & 1 ? bytes[pos + 4] : null;
      }
      readSubBlocks();
    } else if (block === 0x2c) {
      const left = u16(pos);
      const top = u16(pos + 2);
      const width = u16(pos + 4);
      const height = u16(pos + 6);
      const fields = bytes[pos + 8];
      if (fields & 0x40) throw new Error('Interlaced images are not supported');
      const localSize = fields & 0x80 ? 1 << ((fields & 7) + 1) : 0;
      pos += 9 + localSize * 3;
      const minCodeSize = bytes[pos++];
      const indices = lzwDecode(minCodeSize, readSubBlocks(), width * height);
      frames.push({ left, top, width, height, transparentIndex, indices });
      transparentIndex = null;
    } else {
      throw new Error(`Unexpected GIF block 0x${block.toString(16)} at ${pos - 1}`);
    }
  }
  return frames;
}
