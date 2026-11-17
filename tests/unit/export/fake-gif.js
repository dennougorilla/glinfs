/**
 * A structurally valid GIF of `frames` equal images totalling about
 * `totalBytes` (the pixel data is filler, not decodable LZW), for mocked
 * sample encodes: the size estimate reads each image's byte length.
 * @param {number} totalBytes
 * @param {number} frames
 * @returns {Blob}
 */
export function fakeGifBlob(totalBytes, frames) {
  const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0];
  const perFrame = Math.max(21, Math.floor((totalBytes - header.length - 1) / Math.max(1, frames)));
  // GCE (8) + image descriptor (10) + LZW code size (1) + sub-blocks + terminator (1)
  const payload = Math.max(0, perFrame - 20 - Math.ceil(perFrame / 256));
  const blocks = Math.ceil(payload / 255);
  const head = [0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 8];
  // Written into a typed array: building megabytes as a JS array was slow
  // enough to time out waits under load
  const image = new Uint8Array(head.length + blocks + payload + 1);
  image.set(head, 0);
  let at = head.length;
  for (let left = payload; left > 0; left -= 255) {
    const n = Math.min(255, left);
    image[at] = n;
    at += 1 + n; // the n filler bytes stay 0
  }
  image[at] = 0;
  const count = Math.max(1, frames);
  const bytes = new Uint8Array(header.length + image.length * count + 1);
  bytes.set(header, 0);
  for (let f = 0; f < count; f++) bytes.set(image, header.length + f * image.length);
  bytes[bytes.length - 1] = 0x3b;
  return new Blob([bytes], { type: 'image/gif' });
}
