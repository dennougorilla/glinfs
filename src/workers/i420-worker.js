/**
 * I420 converter worker (D3's cheap half)
 *
 * Turns capture ImageBitmaps (RGBA, on the GPU) into CPU I420 bytes for the
 * clip's VideoFrames: 1.5 B/px instead of 4. Three engines give the same
 * bytes as the CPU reference (shared/i420.js), tried in this order:
 * - WebGPU: a compute pass writes the frame's I420 bytes (Y, then U, then V)
 *   into a buffer, mapped a few frames behind (1080p: ~1.4 ms a frame);
 * - WebGL2: one draw into a single-channel target laid out like the I420
 *   buffer, read through pixel-pack buffers (1080p: ~5.6 ms a frame, the
 *   read back is the cost);
 * - the CPU reference, where neither runs.
 *
 * Messages:
 * - in  CONVERT { jobId, frames: [{ id, timestamp, bitmap }], engines? } (bitmaps
 *       transferred; `engines` limits and orders the engines, for tests)
 * - out FRAME { jobId, index, id, timestamp, width, height, data } (data transferred),
 *       once per frame, in order
 * - out DONE { jobId, engine: 'webgpu' | 'webgl2' | 'js' }
 * - in  WARM: get the GPU device and the shader ready before the first clip
 * - out FAILED { jobId, error, rest: [{ index, bitmap }] }: the frames not
 *       converted go back (bitmaps transferred) for the old route
 *
 * Every bitmap is closed as soon as its pixels are on the GPU (WebGL) or
 * read (CPU), so the RGBA copy of a frame is released while the rest of the
 * clip converts.
 *
 * @module workers/i420-worker
 */

import { i420Layout, rgbaToI420 } from '../shared/i420.js';

/** Frames converted ahead of the oldest read */
const PIPELINE_DEPTH = 8;

/** @typedef {'webgpu' | 'webgl2' | 'js'} Engine */

/** @type {Engine[]} */
const ENGINES = ['webgpu', 'webgl2', 'js'];

// One invocation packs 4 output bytes into a u32 (little endian, so the
// buffer's bytes come out in order). Same maths as rgbaToI420.
const COMPUTE_SHADER = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> bytes: array<u32>;
struct Size { w: u32, h: u32, cw: u32, ch: u32 };
@group(0) @binding(2) var<uniform> size: Size;
const K = vec3f(0.2126, 0.7152, 0.0722);
// Math.round: halves go up (WGSL round() takes them to even)
fn roundHalfUp(v: f32) -> f32 { return floor(v + 0.5); }
fn px(x: u32, y: u32) -> vec3f {
  return textureLoad(src, vec2u(min(x, size.w - 1u), min(y, size.h - 1u)), 0).rgb;
}
fn byteAt(idx: u32) -> u32 {
  let luma = size.w * size.h;
  let plane = size.cw * size.ch;
  if (idx < luma) { return u32(roundHalfUp(dot(px(idx % size.w, idx / size.w), K) * 255.0)); }
  var c = idx - luma;
  let isV = c >= plane;
  if (isV) { c = c - plane; }
  if (c >= plane) { return 0u; }
  let x = (c % size.cw) * 2u;
  let y = (c / size.cw) * 2u;
  let m = (px(x, y) + px(x + 1u, y) + px(x, y + 1u) + px(x + 1u, y + 1u)) * 0.25;
  let l = dot(m, K);
  var v = (m.b - l) / 1.8556;
  if (isV) { v = (m.r - l) / 1.5748; }
  return u32(clamp(roundHalfUp(v * 255.0 + 128.0), 0.0, 255.0));
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&bytes)) { return; }
  let i = g.x * 4u;
  bytes[g.x] = byteAt(i) | (byteAt(i + 1u) << 8u) | (byteAt(i + 2u) << 16u) | (byteAt(i + 3u) << 24u);
}`;

const VERTEX_SHADER = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

// Output byte idx (row-major over a W-wide target) -> its I420 sample.
// Must match rgbaToI420 byte for byte: same weights, 2x2 mean, edge repeat.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D t;
uniform int W;
uniform int H;
uniform int CW;
uniform int CH;
out vec4 o;
const vec3 K = vec3(0.2126, 0.7152, 0.0722);
vec3 px(int x, int y) { return texelFetch(t, ivec2(min(x, W - 1), min(y, H - 1)), 0).rgb; }
void main() {
  int idx = int(gl_FragCoord.y) * W + int(gl_FragCoord.x);
  if (idx < W * H) { o = vec4(dot(px(idx % W, idx / W), K), 0.0, 0.0, 1.0); return; }
  int c = idx - W * H;
  bool isV = c >= CW * CH;
  if (isV) c -= CW * CH;
  if (c >= CW * CH) { o = vec4(0.0); return; }
  int x = (c % CW) * 2;
  int y = (c / CW) * 2;
  vec3 m = (px(x, y) + px(x + 1, y) + px(x, y + 1) + px(x + 1, y + 1)) * 0.25;
  float l = dot(m, K);
  float v = isV ? (m.r - l) / 1.5748 : (m.b - l) / 1.8556;
  o = vec4(clamp(v + 128.0 / 255.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

/**
 * @typedef {Object} Converter
 * @property {Engine} engine
 * @property {(items: Array<{ bitmap: ImageBitmap }>, onFrame: (index: number, data: ArrayBuffer) => void) => Promise<void>} convertAll
 *   - Closes each bitmap once its pixels are taken
 * @property {() => void} release - Free the size-dependent GPU memory
 */

/** @type {Promise<GPUDevice | null> | null} */
let gpuDevice = null;

/**
 * The worker's WebGPU device, asked for once; null without WebGPU or after
 * the device was lost
 * @returns {Promise<GPUDevice | null>}
 */
function getGpuDevice() {
  if (!gpuDevice) {
    gpuDevice = (async () => {
      try {
        const adapter = await navigator.gpu?.requestAdapter();
        const device = (await adapter?.requestDevice()) ?? null;
        device?.lost.then(() => {
          gpuDevice = Promise.resolve(null);
        });
        return device;
      } catch (err) {
        console.warn('[i420-worker] WebGPU unavailable:', err);
        return null;
      }
    })();
  }
  return gpuDevice;
}

/** @type {WeakMap<GPUDevice, GPUComputePipeline>} */
const pipelines = new WeakMap();

/**
 * The compute pipeline of a device, made once
 * @param {GPUDevice} device
 * @returns {GPUComputePipeline}
 */
function getPipeline(device) {
  let pipeline = pipelines.get(device);
  if (!pipeline) {
    pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: COMPUTE_SHADER }), entryPoint: 'main' },
    });
    pipelines.set(device, pipeline);
  }
  return pipeline;
}

/**
 * WARM: get the device and the pipeline (or the WebGL2 program) ready
 * @returns {Promise<void>}
 */
async function warm() {
  const device = await getGpuDevice();
  if (device) {
    getPipeline(device);
  } else {
    getGl();
  }
}

/**
 * A WebGPU converter for one frame size
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Converter | null>}
 */
async function createWebGpuConverter(width, height) {
  const device = await getGpuDevice();
  if (!device) return null;
  const pipeline = getPipeline(device);
  const { chromaWidth, chromaHeight, size } = i420Layout(width, height);
  const words = Math.ceil(size / 4);
  const texture = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const storage = device.createBuffer({
    size: words * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const uniforms = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    uniforms,
    0,
    new Uint32Array([width, height, chromaWidth, chromaHeight]),
  );
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: { buffer: storage } },
      { binding: 2, resource: { buffer: uniforms } },
    ],
  });
  const readBuffers = Array.from({ length: PIPELINE_DEPTH }, () =>
    device.createBuffer({
      size: words * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    }),
  );

  return {
    engine: 'webgpu',
    async convertAll(items, onFrame) {
      /** @type {{ buffer: GPUBuffer, index: number }[]} */
      const inflight = [];
      const readOldest = async () => {
        const { buffer, index } = /** @type {(typeof inflight)[number]} */ (inflight.shift());
        await buffer.mapAsync(GPUMapMode.READ);
        const data = new Uint8Array(size);
        data.set(new Uint8Array(buffer.getMappedRange(), 0, size));
        buffer.unmap();
        onFrame(index, data.buffer);
      };
      for (let index = 0; index < items.length; index++) {
        if (inflight.length === PIPELINE_DEPTH) await readOldest();
        const { bitmap } = items[index];
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [width, height]);
        // The copy took the pixels: release the RGBA bitmap
        bitmap.close();
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(words / 256));
        pass.end();
        const buffer = readBuffers[index % PIPELINE_DEPTH];
        encoder.copyBufferToBuffer(storage, 0, buffer, 0, words * 4);
        device.queue.submit([encoder.finish()]);
        inflight.push({ buffer, index });
      }
      while (inflight.length) await readOldest();
    },
    release() {
      for (const buffer of readBuffers) buffer.destroy();
      storage.destroy();
      uniforms.destroy();
      texture.destroy();
    },
  };
}

/** @type {{ canvas: OffscreenCanvas, gl: WebGL2RenderingContext, program: WebGLProgram } | null | undefined} */
let glState;

/**
 * The worker's WebGL2 context and program, made once; null without WebGL2
 * @returns {{ canvas: OffscreenCanvas, gl: WebGL2RenderingContext, program: WebGLProgram } | null}
 */
function getGl() {
  if (glState !== undefined) return glState;
  glState = null;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = /** @type {WebGL2RenderingContext | null} */ (
      canvas.getContext('webgl2', {
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      })
    );
    if (!gl) return null;
    const program = gl.createProgram();
    for (const [type, source] of /** @type {const} */ ([
      [gl.VERTEX_SHADER, VERTEX_SHADER],
      [gl.FRAGMENT_SHADER, FRAGMENT_SHADER],
    ])) {
      const shader = /** @type {WebGLShader} */ (gl.createShader(type));
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile failed');
      }
      gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, 'p');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('program link failed');
    gl.useProgram(program);
    const triangle = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    glState = { canvas, gl, program };
  } catch (err) {
    console.warn('[i420-worker] WebGL2 unavailable, converting on the CPU:', err);
    glState = null;
  }
  return glState;
}

/**
 * A WebGL2 converter for one frame size
 * @param {number} width
 * @param {number} height
 * @returns {Converter | null}
 */
function createGlConverter(width, height) {
  const state = getGl();
  if (!state) return null;
  const { canvas, gl, program } = state;
  const { chromaWidth, chromaHeight, size } = i420Layout(width, height);
  const rows = Math.ceil(size / width);
  const bytes = width * rows;
  canvas.width = width;
  canvas.height = rows;

  for (const [name, value] of /** @type {const} */ ([
    ['W', width],
    ['H', height],
    ['CW', chromaWidth],
    ['CH', chromaHeight],
  ])) {
    gl.uniform1i(gl.getUniformLocation(program, name), value);
  }

  const source = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, rows);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  gl.viewport(0, 0, width, rows);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.bindTexture(gl.TEXTURE_2D, source);

  const packBuffers = Array.from({ length: PIPELINE_DEPTH }, () => {
    const buffer = /** @type {WebGLBuffer} */ (gl.createBuffer());
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
    return buffer;
  });
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

  return {
    engine: 'webgl2',
    async convertAll(items, onFrame) {
      /** @type {{ buffer: WebGLBuffer, sync: WebGLSync, index: number }[]} */
      const inflight = [];
      const readOldest = async () => {
        const { buffer, sync, index } = /** @type {(typeof inflight)[number]} */ (inflight.shift());
        while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        gl.deleteSync(sync);
        const data = new Uint8Array(size);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        onFrame(index, data.buffer);
      };
      for (let index = 0; index < items.length; index++) {
        if (inflight.length === PIPELINE_DEPTH) await readOldest();
        if (gl.isContextLost()) throw new Error('WebGL context lost');
        const { bitmap } = items[index];
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        // The texture holds the pixels now: release the RGBA bitmap
        bitmap.close();
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const buffer = packBuffers[index % PIPELINE_DEPTH];
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        gl.readPixels(0, 0, width, rows, gl.RED, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        inflight.push({
          buffer,
          sync: /** @type {WebGLSync} */ (gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)),
          index,
        });
        gl.flush();
      }
      while (inflight.length) await readOldest();
    },
    release() {
      for (const buffer of packBuffers) gl.deleteBuffer(buffer);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(target);
      gl.deleteTexture(source);
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}

/** @type {OffscreenCanvasRenderingContext2D | null} */
let readContext = null;

/**
 * CPU route: read the bitmap's pixels and convert them in JS
 * @param {ImageBitmap} bitmap
 * @returns {ArrayBuffer}
 */
function convertOnCpu(bitmap) {
  const { width, height } = bitmap;
  if (!readContext) {
    readContext = /** @type {OffscreenCanvasRenderingContext2D} */ (
      new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
    );
  }
  const canvas = readContext.canvas;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  readContext.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = readContext.getImageData(0, 0, width, height);
  return rgbaToI420(data, width, height).buffer;
}

/** @type {Converter} */
const cpuConverter = {
  engine: 'js',
  async convertAll(items, onFrame) {
    for (let index = 0; index < items.length; index++) {
      onFrame(index, convertOnCpu(items[index].bitmap));
    }
  },
  release() {},
};

/**
 * The first engine that runs here, for one frame size
 * @param {Engine[]} engines
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Converter | null>}
 */
async function createConverter(engines, width, height) {
  for (const engine of engines) {
    try {
      const converter =
        engine === 'webgpu'
          ? await createWebGpuConverter(width, height)
          : engine === 'webgl2'
            ? createGlConverter(width, height)
            : cpuConverter;
      if (converter) return converter;
    } catch (err) {
      console.warn(`[i420-worker] ${engine} could not start:`, err);
    }
  }
  return null;
}

/**
 * @param {{ jobId: number, engines?: Engine[], frames: Array<{ id: string, timestamp: number, bitmap: ImageBitmap, width?: number, height?: number }> }} payload
 */
async function convert({ jobId, frames, engines = ENGINES }) {
  let next = 0;
  /** @param {number} index @param {ArrayBuffer} data */
  const send = (index, data) => {
    const frame = frames[index];
    self.postMessage(
      {
        type: 'FRAME',
        jobId,
        index,
        id: frame.id,
        timestamp: frame.timestamp,
        width: frame.width,
        height: frame.height,
        data,
      },
      [data],
    );
    next = index + 1;
  };
  // Remember the sizes: a closed bitmap reports 0 x 0
  for (const frame of frames) {
    Object.assign(frame, { width: frame.bitmap.width, height: frame.bitmap.height });
  }

  try {
    const first = frames[0];
    const converter = first ? await createConverter(engines, first.width, first.height) : null;
    if (!converter) throw new Error('no engine can run');
    try {
      // One size per call: the clip is the newest source's frames only
      await converter.convertAll(frames, (index, data) => send(index, data));
    } finally {
      converter.release();
    }
    const engine = converter.engine;
    self.postMessage({ type: 'DONE', jobId, engine });
  } catch (err) {
    // The frames not sent yet: those still holding their bitmap go back for
    // the old route; a bitmap already on the GPU was closed and is lost
    const rest = frames
      .map((frame, index) => ({ index, bitmap: frame.bitmap }))
      .filter(({ index, bitmap }) => index >= next && bitmap.width > 0);
    self.postMessage(
      { type: 'FAILED', jobId, error: String(err), rest },
      rest.map(({ bitmap }) => bitmap),
    );
  }
}

/** Jobs run one after another: they share the GL context */
let jobs = Promise.resolve();

self.onmessage = (event) => {
  const { type, ...payload } = event.data ?? {};
  if (type === 'CONVERT') {
    jobs = jobs.then(() => convert(/** @type {any} */ (payload)));
  } else if (type === 'WARM') {
    jobs = jobs.then(warm);
  }
};
