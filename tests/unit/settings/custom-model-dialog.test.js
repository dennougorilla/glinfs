import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setCustomModelEntries } from '../../../src/features/ai-cutout/model-registry.js';
import { openAddModelDialog } from '../../../src/features/settings/custom-model-dialog.js';

vi.mock('../../../src/features/ai-cutout/custom-model-store.js', () => ({
  getCustomModelDefinition: () => null,
  saveCustomModel: vi.fn(async () => undefined),
}));

/** @param {string} name @param {number} sha */
function opened(name, sha) {
  return {
    bytes: 1000 + sha,
    sha256: String(sha).repeat(64).slice(0, 64),
    backend: 'webgpu',
    hasAdapter: true,
    webgpuError: null,
    graph: {
      inputs: [{ name: `${name}_in`, isTensor: true, type: 'float32', shape: [1, 3, 64, 64] }],
      outputs: [{ name: `${name}_out`, isTensor: true, type: 'float32', shape: [1, 1, 64, 64] }],
    },
  };
}

/**
 * A fake probe whose open() resolves only when the test says so
 */
function fakeProbes() {
  /** @type {any[]} */
  const probes = [];
  const createProbe = () => {
    /** @type {{ resolve: (value: unknown) => void } | null} */
    let pending = null;
    const probe = {
      open: vi.fn(
        () =>
          new Promise((resolve) => {
            pending = { resolve };
          }),
      ),
      finish: (/** @type {unknown} */ value) => pending?.resolve(value),
      test: vi.fn(async () => ({ ok: true, problem: null, message: 'ok', backend: 'webgpu' })),
      save: vi.fn(async () => ({ cached: true })),
      cancel: vi.fn(),
      dispose: vi.fn(),
      confirmDownloaded: vi.fn(),
    };
    probes.push(probe);
    return probe;
  };
  return { probes, createProbe };
}

/** @param {HTMLInputElement} input @param {File} file */
function pick(input, file) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

beforeAll(() => {
  // jsdom: a modal dialog needs only its open state here
  // jsdom: Blob.text() is missing
  const blob = /** @type {any} */ (Blob.prototype);
  blob.text ??= function text() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
  const proto = /** @type {any} */ (HTMLDialogElement.prototype);
  proto.showModal ??= function showModal() {
    this.setAttribute('open', '');
  };
  proto.close ??= function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  document.body.innerHTML = '';
  setCustomModelEntries([]);
});

describe('Add model dialog (review #196, finding 2)', () => {
  it('a second file opened while the first still loads replaces it: the late first result is ignored', async () => {
    const { probes, createProbe } = fakeProbes();
    const { dialog, close } = openAddModelDialog({ createProbe });
    const input = /** @type {HTMLInputElement} */ (dialog.querySelector('#add-model-file'));

    pick(input, new File([new Uint8Array(10)], 'a.onnx'));
    await Promise.resolve();
    const probeA = probes.at(-1);
    expect(probeA.open).toHaveBeenCalledTimes(1);

    pick(input, new File([new Uint8Array(5)], 'b.onnx'));
    await Promise.resolve();
    const probeB = probes.at(-1);
    // The first open's worker is gone (its file, hash and session with it)
    expect(probeB).not.toBe(probeA);
    expect(probeA.dispose).toHaveBeenCalled();
    expect(probeB.open).toHaveBeenCalledTimes(1);
    expect(probeB.open.mock.calls[0][0].file.name).toBe('b.onnx');

    probeB.finish(opened('b', 2));
    await vi.waitFor(() => expect(dialog.querySelector('#add-model-summary')).not.toBeNull());
    // The first open finishing late changes nothing
    probeA.finish(opened('a', 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const summary = /** @type {HTMLElement} */ (dialog.querySelector('#add-model-summary'));
    expect(summary.textContent).toContain('b.onnx');
    expect(summary.textContent).toContain('Input b_in');
    expect(summary.textContent).not.toContain('a_in');

    // Test and Save go to the probe that holds b.onnx
    /** @type {HTMLButtonElement} */ (dialog.querySelector('#add-model-test')).click();
    await vi.waitFor(() =>
      expect(dialog.querySelector('#add-model-test-result')?.getAttribute('data-kind')).toBe('ok'),
    );
    expect(probeB.test).toHaveBeenCalledWith(
      expect.objectContaining({ inputName: 'b_in', outputName: 'b_out', inputSize: 64 }),
    );
    expect(probeA.test).not.toHaveBeenCalled();
    /** @type {HTMLButtonElement} */ (dialog.querySelector('#add-model-save')).click();
    await vi.waitFor(() => expect(probeB.save).toHaveBeenCalledTimes(1));
    expect(probeB.save.mock.calls[0][0]).toContain(`sha256=${'2'.repeat(64)}`);
    expect(probeA.save).not.toHaveBeenCalled();
    close();
  });
  it('an imported definition replaces a file still loading: the late file result is ignored (round 2)', async () => {
    const { probes, createProbe } = fakeProbes();
    const { dialog, close } = openAddModelDialog({ createProbe });
    const input = /** @type {HTMLInputElement} */ (dialog.querySelector('#add-model-file'));

    pick(input, new File([new Uint8Array(10)], 'a.onnx'));
    await Promise.resolve();
    const probeA = probes.at(-1);
    expect(probeA.open).toHaveBeenCalledTimes(1);

    const definition = {
      format: 'glinfs-custom-model',
      version: 1,
      label: 'Shared model',
      source: 'url',
      url: 'https://huggingface.co/o/r/resolve/abc/x.onnx',
      fileName: 'x.onnx',
      bytes: 1234,
      sha256: 'f'.repeat(64),
      inputName: 'a_in',
      outputName: 'a_out',
      inputSize: 64,
      resize: 'stretch',
      normalization: 'imagenet',
      output: 'logits',
      subjects: ['general'],
    };
    pick(
      input,
      new File([JSON.stringify(definition)], 'x.glinfs-model.json', { type: 'application/json' }),
    );
    await vi.waitFor(() => expect(dialog.querySelector('#add-model-import')).not.toBeNull());
    expect(probeA.dispose).toHaveBeenCalled();

    // a.onnx finishes late, with a graph that would even match the definition
    probeA.finish(opened('a', 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialog.querySelector('#add-model-import')?.textContent).toContain('Shared model');
    expect(dialog.querySelector('#add-model-summary')).toBeNull();
    expect(dialog.querySelector('#add-model-save')).toBeNull();
    expect(probeA.test).not.toHaveBeenCalled();
    expect(probeA.save).not.toHaveBeenCalled();
    close();
  });
});
