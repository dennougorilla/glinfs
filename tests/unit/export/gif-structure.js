/**
 * Minimal GIF structure reader for unit tests: walks the block stream and
 * reports each image's Graphic Control Extension and color table size.
 * Pixel data (LZW) is skipped, not decoded — E2E specs decode real pixels
 * with ImageDecoder.
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
