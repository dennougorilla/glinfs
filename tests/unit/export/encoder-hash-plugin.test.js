import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeEncoderJsSha256Hex,
  ENCODER_JS_PATH,
  encoderHashRestartPlugin,
} from '../../../scripts/compute-encoder-hash.js';

function createFakeServer() {
  return {
    restart: vi.fn(async () => {}),
    config: { logger: { info: vi.fn() } },
  };
}

function setUpPlugin() {
  const plugin = encoderHashRestartPlugin();
  const server = createFakeServer();
  plugin.configureServer(/** @type {any} */ (server));
  return { plugin, server };
}

describe('computeEncoderJsSha256Hex', () => {
  /** @type {string | undefined} */
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('hashes public/encoder/encoder.js by default', () => {
    expect(ENCODER_JS_PATH.endsWith('/public/encoder/encoder.js')).toBe(true);
    const expected = createHash('sha256').update(readFileSync(ENCODER_JS_PATH)).digest('hex');
    expect(computeEncoderJsSha256Hex()).toBe(expected);
  });

  it('re-reads the file on every call so a changed glue yields a new digest', () => {
    dir = mkdtempSync(join(tmpdir(), 'glinfs-encoder-hash-'));
    const file = join(dir, 'encoder.js');
    writeFileSync(file, 'var Module = {};');
    const before = computeEncoderJsSha256Hex(file);
    writeFileSync(file, 'var Module = {}; // rebuilt');
    expect(computeEncoderJsSha256Hex(file)).not.toBe(before);
  });
});

describe('encoderHashRestartPlugin', () => {
  it('only applies to the dev server, so build output is unchanged', () => {
    expect(encoderHashRestartPlugin().apply).toBe('serve');
  });

  it('restarts the dev server when encoder.js changes (stale define hash fix)', async () => {
    const { plugin, server } = setUpPlugin();
    await plugin.watchChange(ENCODER_JS_PATH, { event: 'update' });
    expect(server.restart).toHaveBeenCalledTimes(1);
  });

  it.each(['create', 'delete'])('restarts on %s events (atomic replace)', async (event) => {
    const { plugin, server } = setUpPlugin();
    await plugin.watchChange(ENCODER_JS_PATH, { event });
    expect(server.restart).toHaveBeenCalledTimes(1);
  });

  it('matches Windows-style ids', async () => {
    const { plugin, server } = setUpPlugin();
    await plugin.watchChange(ENCODER_JS_PATH.replaceAll('/', '\\'), { event: 'update' });
    expect(server.restart).toHaveBeenCalledTimes(1);
  });

  it('ignores changes to other files, including encoder.wasm', async () => {
    const { plugin, server } = setUpPlugin();
    await plugin.watchChange(ENCODER_JS_PATH.replace(/encoder\.js$/, 'encoder.wasm'), {
      event: 'update',
    });
    await plugin.watchChange('/somewhere/else/public/encoder/encoder.js', { event: 'update' });
    expect(server.restart).not.toHaveBeenCalled();
  });

  it('is a no-op before configureServer has run', async () => {
    const plugin = encoderHashRestartPlugin();
    await expect(plugin.watchChange(ENCODER_JS_PATH, { event: 'update' })).resolves.toBeUndefined();
  });
});
