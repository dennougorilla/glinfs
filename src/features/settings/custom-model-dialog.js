/**
 * Settings → AI models → "Add model"
 * @module features/settings/custom-model-dialog
 *
 * A modal <dialog> (focus stays inside, Escape closes) that turns an ONNX
 * file into a custom model:
 *
 * 1. Source: a local file (picked or dropped) or an https URL (Hugging
 *    Face: see model-hosts.js). A .json file is a shared model definition:
 *    its URL is downloaded, or its file asked for, and the bytes must match
 *    the definition's size and SHA-256. Nothing is added before Save.
 * 2. The probe worker reads the file (asking first above 1 GB), hashes it
 *    and reads the graph; proposeSettings fills the form, or the dialog
 *    says why the file is out of scope.
 * 3. The user confirms label, input size, resize, normalization, output
 *    kind, the mask output (when there are several) and the cards that
 *    list the model, and runs the test frame (WebGPU when the browser has
 *    it). A failed test shows why; Save needs a passing test (or, when the
 *    model ran but the test image came out empty or full, "Save anyway").
 * 4. Save stores the bytes in the model cache and the definition in
 *    IndexedDB. Closing at any point frees the file (the worker ends).
 *
 * The file never leaves the device.
 */

import { createElement } from '../../shared/utils/dom.js';
import { getCustomModelDefinition, saveCustomModel } from '../ai-cutout/custom-model-store.js';
import {
  CUSTOM_MODEL_FORMAT,
  CUSTOM_MODEL_SUBJECTS,
  CUSTOM_MODEL_VERSION,
  CUSTOM_SUBJECT_LABELS,
  createTestFrame,
  customModelFileName,
  formatShape,
  INPUT_SIZE_LIMITS,
  LARGE_MODEL_BYTES,
  labelFromFileName,
  NORMALIZATIONS,
  normalizeCustomModelDefinition,
  parseDefinitionJson,
  proposeSettings,
} from '../ai-cutout/custom-models.js';
import { getModelFileUrl } from '../ai-cutout/model-config.js';
import { checkModelUrl, urlFileName } from '../ai-cutout/model-hosts.js';
import { modelCacheKey } from '../ai-cutout/model-loader.js';
import { createModelProbe } from '../ai-cutout/model-probe.js';
import { formatModelSize } from '../ai-cutout/model-registry.js';
import { requestPersistentStorage } from '../ai-cutout/model-storage.js';

/** @typedef {import('../ai-cutout/custom-models.js').CustomModelDefinition} CustomModelDefinition */
/** @typedef {import('../ai-cutout/model-probe.js').OpenedModel} OpenedModel */
/** @typedef {import('../ai-cutout/model-probe.js').TestResult} TestResult */

/**
 * @typedef {Object} AddModelDialogDeps
 * @property {(definition: CustomModelDefinition, updated: boolean) => void} [onSaved]
 * @property {() => ReturnType<typeof createModelProbe>} [createProbe]
 */

/** Resize choices */
const RESIZE_LABELS = {
  stretch: 'Stretch to a square',
  letterbox: 'Letterbox (keep the aspect ratio)',
};

/** Output kind choices */
const OUTPUT_LABELS = { probability: 'Probability (0..1)', logits: 'Logits (sigmoid)' };

/**
 * @param {string} tag
 * @param {Record<string, string>} attrs
 * @param {(string | Node)[]} [children]
 * @returns {HTMLElement}
 */
const el = (tag, attrs = {}, children = []) => createElement(tag, attrs, children);

/**
 * A settings row: label (and its control's id) on the left, control right
 * @param {string} label
 * @param {string} controlId
 * @param {HTMLElement} control
 * @returns {HTMLElement}
 */
function row(label, controlId, control) {
  return el('div', { className: 'settings-item settings-dialog-row' }, [
    el('label', { className: 'settings-item-label', for: controlId }, [label]),
    el('div', { className: 'settings-control' }, [control]),
  ]);
}

/**
 * A <select> of `options` (value → text)
 * @param {string} id
 * @param {Record<string, string>} options
 * @param {string} value
 * @returns {HTMLSelectElement}
 */
function select(id, options, value) {
  const node = /** @type {HTMLSelectElement} */ (
    el(
      'select',
      { id, className: 'settings-select' },
      Object.entries(options).map(([key, text]) => el('option', { value: key }, [text])),
    )
  );
  node.value = value;
  return node;
}

/**
 * @param {string} label
 * @param {Record<string, string>} attrs
 * @param {boolean} [primary]
 * @returns {HTMLButtonElement}
 */
function button(label, attrs = {}, primary = false) {
  return /** @type {HTMLButtonElement} */ (
    el(
      'button',
      {
        type: 'button',
        className: `btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm`,
        ...attrs,
      },
      [label],
    )
  );
}

/**
 * Draw the test image with the test mask as its alpha over a checkerboard
 * @param {HTMLCanvasElement} canvas
 * @param {{ size: number, data: ArrayBuffer }} preview
 */
function drawPreview(canvas, preview) {
  const { size } = preview;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = createTestFrame(size);
  const mask = new Uint8Array(preview.data);
  const out = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    const check = ((x >> 3) + (y >> 3)) % 2 === 0 ? 70 : 40;
    const a = mask[i] / 255;
    for (let c = 0; c < 3; c++) {
      out.data[i * 4 + c] = Math.round(image[i * 4 + c] * a + check * (1 - a));
    }
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

/**
 * Open the Add model dialog.
 * @param {AddModelDialogDeps} [deps]
 * @returns {{ dialog: HTMLDialogElement, close: () => void }}
 */
export function openAddModelDialog(deps = {}) {
  const { onSaved = () => undefined, createProbe = () => createModelProbe() } = deps;
  let probe = createProbe();
  let closed = false;

  /**
   * What the dialog holds
   * @type {{
   *   source: { kind: 'file', file: File } | { kind: 'url', url: string } | null,
   *   imported: CustomModelDefinition | null,
   *   opened: OpenedModel | null,
   *   form: { label: string, inputName: string, outputName: string, inputSize: number, resize: 'letterbox' | 'stretch', normalization: 'unit' | 'imagenet' | 'symmetric', output: 'probability' | 'logits', subjects: Set<string> } | null,
   *   proposal: ReturnType<typeof proposeSettings> | null,
   *   test: TestResult | null,
   *   testing: boolean,
   *   saving: boolean,
   *   message: string,
   * }}
   */
  const state = {
    source: null,
    imported: null,
    opened: null,
    form: null,
    proposal: null,
    test: null,
    testing: false,
    saving: false,
    message: '',
  };

  const titleId = 'add-model-title';
  const title = el('h2', { className: 'settings-dialog-title', id: titleId, tabindex: '-1' }, [
    'Add model',
  ]);
  const closeButton = button('×', {
    'aria-label': 'Close',
    title: 'Close (Esc)',
    className: 'settings-dialog-close',
  });
  const body = el('div', { className: 'settings-dialog-body' });
  const footer = el('div', { className: 'settings-dialog-footer' });
  const status = el('p', {
    className: 'settings-dialog-status',
    role: 'status',
    id: 'add-model-status',
  });
  const dialog = /** @type {HTMLDialogElement} */ (
    el(
      'dialog',
      {
        className: 'settings-dialog',
        'aria-labelledby': titleId,
        'data-testid': 'add-model-dialog',
      },
      [
        el('header', { className: 'settings-dialog-header' }, [title, closeButton]),
        body,
        status,
        footer,
      ],
    )
  );

  const close = () => {
    if (closed) return;
    closed = true;
    probe.cancel();
    probe.dispose();
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', close);
  dialog.addEventListener('cancel', (event) => {
    // Escape: never while saving (the bytes are half stored)
    if (state.saving) event.preventDefault();
  });

  /** @param {string} text */
  const say = (text) => {
    status.textContent = text;
  };

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------

  const fileInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'file',
      id: 'add-model-file',
      accept: '.onnx,.json,application/json',
      className: 'settings-dialog-file-input',
    })
  );
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void handleFile(file);
  });

  const showSource = () => {
    state.source = null;
    state.opened = null;
    state.form = null;
    state.test = null;
    state.imported = null;
    fileInput.accept = '.onnx,.json,application/json';
    const pick = button('Choose a file', { id: 'add-model-choose' }, true);
    pick.addEventListener('click', () => fileInput.click());
    const url = /** @type {HTMLInputElement} */ (
      el('input', {
        type: 'url',
        id: 'add-model-url',
        className: 'settings-dialog-url',
        placeholder: 'https://huggingface.co/…/resolve/…/model.onnx',
        spellcheck: 'false',
        autocomplete: 'off',
      })
    );
    const go = button('Download', { id: 'add-model-url-go' });
    const submit = () => {
      const checked = checkModelUrl(url.value, location.href);
      if (!checked.ok) {
        say(checked.reason);
        url.focus();
        return;
      }
      url.value = checked.url;
      void openSource({ kind: 'url', url: checked.url });
    };
    go.addEventListener('click', submit);
    url.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    const drop = el('div', { className: 'settings-dialog-drop', id: 'add-model-drop' }, [
      el('span', { className: 'settings-item-label' }, ['ONNX file or model definition (.json)']),
      el('div', { className: 'settings-control' }, [pick]),
    ]);
    body.replaceChildren(
      drop,
      el('div', { className: 'settings-item settings-dialog-row' }, [
        el('label', { className: 'settings-item-label', for: 'add-model-url' }, ['URL']),
        el('div', { className: 'settings-control settings-dialog-url-control' }, [url, go]),
      ]),
    );
    footer.replaceChildren(cancelButton());
    pick.focus();
  };

  const cancelButton = () => {
    const cancel = button('Cancel', { id: 'add-model-cancel' });
    cancel.addEventListener('click', close);
    return cancel;
  };

  /** @param {string} text @param {number | null} [fraction] */
  const showProgress = (text, fraction = null) => {
    const bar = /** @type {HTMLProgressElement} */ (
      el('progress', { className: 'settings-models-progress', max: '1', id: 'add-model-progress' })
    );
    if (fraction !== null) bar.value = fraction;
    const line = el('p', { className: 'settings-item-note', id: 'add-model-progress-text' }, [
      text,
    ]);
    body.replaceChildren(el('div', { className: 'settings-dialog-progress' }, [line, bar]));
    const stop = button('Cancel', { id: 'add-model-stop' });
    stop.addEventListener('click', () => {
      invalidateOpen();
      say('Stopped.');
      showSource();
    });
    footer.replaceChildren(stop);
  };

  /** @param {number} loaded @param {number | null} total */
  const updateProgress = (loaded, total) => {
    const text = body.querySelector('#add-model-progress-text');
    const bar = /** @type {HTMLProgressElement | null} */ (
      body.querySelector('#add-model-progress')
    );
    if (!text || !bar) return;
    const verb = state.source?.kind === 'url' ? 'Downloading' : 'Reading';
    if (total !== null && loaded >= total) {
      text.textContent = 'Loading the model…';
      bar.removeAttribute('value');
      return;
    }
    text.textContent =
      total === null
        ? `${verb} ${formatModelSize(loaded, 1)}`
        : `${verb} ${formatModelSize(loaded, 1)} of ${formatModelSize(total, 1)}`;
    if (total) bar.value = loaded / total;
  };

  /**
   * Ask before reading a file above 1 GB
   * @param {number | null} bytes
   * @param {() => void} onYes
   */
  const showSizeQuestion = (bytes, onYes) => {
    const size = bytes === null ? 'of unknown size' : `${formatModelSize(bytes)}`;
    body.replaceChildren(
      el(
        'div',
        {
          className: 'settings-dialog-question',
          role: 'group',
          'aria-labelledby': 'add-model-size-q',
        },
        [
          el('p', { className: 'settings-item-label', id: 'add-model-size-q' }, [
            `This file is ${size}${bytes !== null && bytes > LARGE_MODEL_BYTES ? ', over 1 GB' : ''}. Read it into memory?`,
          ]),
        ],
      ),
    );
    const yes = button('Read it', { id: 'add-model-size-yes' }, true);
    yes.addEventListener('click', onYes);
    footer.replaceChildren(cancelButton(), yes);
    yes.focus();
  };

  /** @param {string} message */
  const showError = (message) => {
    body.replaceChildren(
      el('div', { className: 'settings-dialog-problem', role: 'alert', id: 'add-model-error' }, [
        message,
      ]),
    );
    const again = button('Choose another file or URL', { id: 'add-model-again' }, true);
    again.addEventListener('click', () => {
      invalidateOpen();
      say('');
      showSource();
    });
    footer.replaceChildren(cancelButton(), again);
    again.focus();
  };

  // ------------------------------------------------------------------
  // Opening a file or URL
  // ------------------------------------------------------------------

  /** @param {File} file */
  const handleFile = async (file) => {
    if (/\.json$/i.test(file.name) || file.type === 'application/json') {
      const result = parseDefinitionJson(await file.text());
      if (!result.ok) {
        say(result.error);
        return;
      }
      // The import replaces a file that is still loading: its late result
      // must not fill the form under the imported definition's name
      invalidateOpen();
      showImport(result.definition);
      return;
    }
    if (state.imported && state.imported.source === 'file') {
      void openSource(
        { kind: 'file', file },
        { bytes: state.imported.bytes, sha256: state.imported.sha256 },
      );
      return;
    }
    void openSource({ kind: 'file', file });
  };

  /**
   * An imported definition: what it is, and how its file is fetched
   * @param {CustomModelDefinition} definition
   */
  const showImport = (definition) => {
    state.imported = definition;
    const existing = getCustomModelDefinition(definition.id);
    const where =
      definition.source === 'url'
        ? `Downloads ${formatModelSize(definition.bytes)} from ${new URL(/** @type {string} */ (definition.url)).hostname}`
        : `Needs the file ${definition.fileName} (${formatModelSize(definition.bytes)})`;
    body.replaceChildren(
      el('div', { className: 'settings-list', id: 'add-model-import' }, [
        el('div', { className: 'settings-item' }, [
          el('div', { className: 'settings-item-text' }, [
            el('span', { className: 'settings-item-label' }, [definition.label]),
            el('p', { className: 'settings-item-note' }, [where]),
            ...(existing
              ? [
                  el('p', { className: 'settings-item-note' }, [
                    `Already added as "${existing.label}".`,
                  ]),
                ]
              : []),
          ]),
        ]),
      ]),
    );
    const next =
      definition.source === 'url'
        ? button('Download and test', { id: 'add-model-import-go' }, true)
        : button(`Choose ${definition.fileName}`, { id: 'add-model-import-go' }, true);
    next.addEventListener('click', () => {
      if (definition.source === 'url') {
        void openSource(
          { kind: 'url', url: /** @type {string} */ (definition.url) },
          { bytes: definition.bytes, sha256: definition.sha256 },
        );
      } else {
        fileInput.accept = '.onnx';
        fileInput.click();
      }
    });
    footer.replaceChildren(cancelButton(), next);
    next.focus();
  };

  /**
   * Read / download, hash and inspect
   * @param {{ kind: 'file', file: File } | { kind: 'url', url: string }} source
   * @param {{ bytes: number, sha256: string }} [expect]
   * @param {boolean} [allowLarge]
   */
  /** Bumped by every open: only the latest one may fill the dialog */
  let openSeq = 0;

  /**
   * Abandon whatever is loading: its result can no longer fill the dialog,
   * and its worker (file, hash, session) is freed. Every new open, an
   * import, Stop and "Choose another" start from here.
   */
  function invalidateOpen() {
    openSeq++;
    probe.cancel();
    probe.dispose();
    probe = createProbe();
  }

  const openSource = async (source, expect, allowLarge = false) => {
    // A new file or URL replaces whatever is still loading. A fresh worker
    // for every open: two opens never share its file, hash and session
    // (a second file dropped while the first was loading could otherwise
    // pair one file's bytes with the other's graph), and the old session's
    // memory is freed now
    invalidateOpen();
    const seq = openSeq;
    const current = probe;
    const stale = () => closed || seq !== openSeq;
    state.source = source;
    state.opened = null;
    state.form = null;
    state.test = null;
    say('');
    const size = source.kind === 'file' ? source.file.size : null;
    showProgress(source.kind === 'file' ? 'Reading the file…' : 'Downloading…', size ? 0 : null);
    try {
      const result = await current.open(source, {
        allowLarge,
        expect,
        onProgress: ({ loadedBytes, totalBytes }) => {
          if (!stale()) updateProgress(loadedBytes, totalBytes);
        },
      });
      if (stale()) return;
      if ('needsConfirm' in result) {
        showSizeQuestion(result.needsConfirm, () => {
          if (stale()) return;
          if (result.downloaded) {
            showProgress('Loading the model…');
            void current.confirmDownloaded().then(
              (opened) => !stale() && showSettings(opened),
              (error) =>
                !stale() &&
                /** @type {any} */ (error)?.name !== 'AbortError' &&
                showError(describeOpenError(error)),
            );
          } else {
            void openSource(source, expect, true);
          }
        });
        return;
      }
      showSettings(result);
    } catch (error) {
      if (stale() || /** @type {any} */ (error)?.name === 'AbortError') return;
      showError(describeOpenError(error));
    }
  };

  // ------------------------------------------------------------------
  // Settings, test and save
  // ------------------------------------------------------------------

  /** @param {OpenedModel} opened */
  const showSettings = (opened) => {
    state.opened = opened;
    state.test = null;
    const proposal = proposeSettings(opened.graph);
    state.proposal = proposal;
    const imported = state.imported;
    const fileName =
      imported?.fileName ??
      (state.source?.kind === 'file'
        ? state.source.file.name
        : urlFileName(state.source?.url ?? '')) ??
      'model.onnx';
    /** @type {string[]} */
    const problems = [...proposal.problems];
    if (imported && !opened.graph.inputs.some((input) => input.name === imported.inputName)) {
      problems.push(
        `The file has no input named "${imported.inputName}", which the definition uses.`,
      );
    }
    if (imported && !proposal.maskOutputs.includes(imported.outputName)) {
      problems.push(
        `The output "${imported.outputName}" the definition uses is not a mask output of this file.`,
      );
    }
    state.form = imported
      ? {
          label: imported.label,
          inputName: imported.inputName,
          outputName: imported.outputName,
          inputSize: imported.inputSize,
          resize: imported.resize,
          normalization: imported.normalization,
          output: imported.output,
          subjects: new Set(imported.subjects),
        }
      : {
          ...proposal.settings,
          label: labelFromFileName(fileName),
          subjects: new Set(['general']),
        };
    const form = state.form;

    const summary = el('div', { className: 'settings-dialog-summary', id: 'add-model-summary' }, [
      el('p', { className: 'settings-item-label' }, [fileName]),
      el('p', { className: 'settings-item-note' }, [
        `${formatModelSize(opened.bytes, 1)} · SHA-256 `,
        el('code', { className: 'settings-dialog-hash' }, [opened.sha256.slice(0, 16)]),
        '…',
      ]),
      el('ul', { className: 'settings-dialog-graph', 'aria-label': 'Graph' }, [
        ...opened.graph.inputs.map((value) =>
          el('li', {}, [`Input ${value.name}: ${value.type ?? '?'} ${formatShape(value.shape)}`]),
        ),
        ...opened.graph.outputs.map((value) =>
          el('li', {}, [`Output ${value.name}: ${value.type ?? '?'} ${formatShape(value.shape)}`]),
        ),
      ]),
    ]);

    if (problems.length > 0) {
      body.replaceChildren(
        summary,
        el('div', { className: 'settings-dialog-problem', role: 'alert', id: 'add-model-scope' }, [
          el('p', { className: 'settings-dialog-problem-title' }, [
            'Outside what this app can run',
          ]),
          el(
            'ul',
            {},
            problems.map((problem) => el('li', {}, [problem])),
          ),
        ]),
      );
      const again = button('Choose another file or URL', { id: 'add-model-again' }, true);
      again.addEventListener('click', () => {
        invalidateOpen();
        showSource();
      });
      footer.replaceChildren(cancelButton(), again);
      again.focus();
      return;
    }

    const label = /** @type {HTMLInputElement} */ (
      el('input', {
        type: 'text',
        id: 'add-model-label',
        className: 'settings-dialog-text',
        maxlength: '60',
      })
    );
    label.value = form.label;
    const size = /** @type {HTMLInputElement} */ (
      el('input', {
        type: 'number',
        id: 'add-model-size',
        className: 'settings-number',
        min: String(INPUT_SIZE_LIMITS.min),
        max: String(INPUT_SIZE_LIMITS.max),
        step: '1',
      })
    );
    size.value = String(form.inputSize);
    size.disabled = proposal.fixedInputSize !== null;
    const resize = select('add-model-resize', RESIZE_LABELS, form.resize);
    const normalization = select(
      'add-model-normalization',
      Object.fromEntries(Object.entries(NORMALIZATIONS).map(([key, n]) => [key, n.label])),
      form.normalization,
    );
    const output = select('add-model-output', OUTPUT_LABELS, form.output);
    const maskOutput = select(
      'add-model-mask-output',
      Object.fromEntries(proposal.maskOutputs.map((name) => [name, name])),
      form.outputName,
    );
    const cards = el(
      'div',
      {
        className: 'settings-dialog-cards',
        role: 'group',
        'aria-labelledby': 'add-model-cards-label',
      },
      CUSTOM_MODEL_SUBJECTS.map((subject) => {
        const box = /** @type {HTMLInputElement} */ (
          el('input', { type: 'checkbox', id: `add-model-card-${subject}`, value: subject })
        );
        box.checked = form.subjects.has(subject);
        box.addEventListener('change', () => {
          if (box.checked) form.subjects.add(subject);
          else form.subjects.delete(subject);
          paintFooter();
        });
        return el(
          'label',
          { className: 'settings-dialog-card', for: `add-model-card-${subject}` },
          [box, CUSTOM_SUBJECT_LABELS[subject]],
        );
      }),
    );

    const testLine = el('p', {
      className: 'settings-item-note',
      id: 'add-model-test-result',
      role: 'status',
    });
    const preview = /** @type {HTMLCanvasElement} */ (
      el('canvas', {
        className: 'settings-dialog-preview',
        id: 'add-model-preview',
        width: '96',
        height: '96',
        hidden: '',
      })
    );
    const testButton = button('Test', { id: 'add-model-test' }, true);

    /** Settings changed: the last test no longer applies */
    const invalidate = () => {
      state.test = null;
      testLine.textContent = '';
      testLine.removeAttribute('data-kind');
      preview.hidden = true;
      paintFooter();
    };
    label.addEventListener('input', () => {
      form.label = label.value;
      paintFooter();
    });
    size.addEventListener('change', () => {
      const value = Math.round(Number(size.value));
      form.inputSize = Math.min(
        INPUT_SIZE_LIMITS.max,
        Math.max(INPUT_SIZE_LIMITS.min, value || 1024),
      );
      size.value = String(form.inputSize);
      invalidate();
    });
    resize.addEventListener('change', () => {
      form.resize = /** @type {any} */ (resize.value);
      // The test image is square: letterbox and stretch feed it the same
      paintFooter();
    });
    normalization.addEventListener('change', () => {
      form.normalization = /** @type {any} */ (normalization.value);
      invalidate();
    });
    output.addEventListener('change', () => {
      form.output = /** @type {any} */ (output.value);
      invalidate();
    });
    maskOutput.addEventListener('change', () => {
      form.outputName = maskOutput.value;
      invalidate();
    });

    const runTest = async () => {
      if (state.testing) return;
      state.testing = true;
      testLine.textContent = 'Testing on one generated frame…';
      testLine.removeAttribute('data-kind');
      paintFooter();
      try {
        const result = await probe.test({
          inputName: form.inputName,
          outputName: form.outputName,
          inputSize: form.inputSize,
          normalization: form.normalization,
          output: form.output,
        });
        if (closed) return;
        state.test = result;
        const where =
          result.backend === 'webgpu'
            ? ' (WebGPU)'
            : opened.hasAdapter
              ? ''
              : ' (without WebGPU: this browser has none)';
        testLine.textContent = `${result.ok ? 'Passed' : 'Failed'}${where}: ${result.message}`;
        testLine.setAttribute('data-kind', result.ok ? 'ok' : 'error');
        if (result.preview) {
          drawPreview(preview, result.preview);
          preview.hidden = false;
        } else {
          preview.hidden = true;
        }
      } catch (error) {
        if (closed) return;
        state.test = null;
        testLine.textContent = `Failed: ${/** @type {any} */ (error)?.message ?? error}`;
        testLine.setAttribute('data-kind', 'error');
      } finally {
        state.testing = false;
        paintFooter();
      }
    };
    testButton.addEventListener('click', () => void runTest());

    const webgpuNote = opened.webgpuError
      ? [
          el('p', { className: 'settings-dialog-problem', role: 'alert', id: 'add-model-webgpu' }, [
            opened.webgpuError,
          ]),
        ]
      : [];

    body.replaceChildren(
      summary,
      ...webgpuNote,
      el('div', { className: 'settings-list settings-dialog-form' }, [
        row('Name', 'add-model-label', label),
        row('Input size', 'add-model-size', size),
        row('Resize', 'add-model-resize', resize),
        row('Normalization', 'add-model-normalization', normalization),
        row('Output', 'add-model-output', output),
        ...(proposal.maskOutputs.length > 1
          ? [row('Mask output', 'add-model-mask-output', maskOutput)]
          : []),
        el('div', { className: 'settings-item settings-dialog-row' }, [
          el('span', { className: 'settings-item-label', id: 'add-model-cards-label' }, ['Cards']),
          el('div', { className: 'settings-control' }, [cards]),
        ]),
        el('div', { className: 'settings-item settings-dialog-row settings-dialog-test' }, [
          el('div', { className: 'settings-item-text' }, [testLine]),
          el('div', { className: 'settings-control' }, [preview, testButton]),
        ]),
      ]),
    );

    const save = button('Save', { id: 'add-model-save' }, true);
    save.addEventListener('click', () => void handleSave());
    footer.replaceChildren(cancelButton(), save);

    function paintFooter() {
      const test = state.test;
      const canSave =
        !state.testing &&
        !state.saving &&
        form.subjects.size > 0 &&
        form.label.trim().length > 0 &&
        Boolean(test && (test.ok || test.canSaveAnyway));
      save.disabled = !canSave;
      save.textContent = state.saving
        ? 'Saving…'
        : test && !test.ok && test.canSaveAnyway
          ? 'Save anyway'
          : 'Save';
      testButton.disabled = state.testing || state.saving;
    }
    paintFooter();
    label.focus();
    label.select();
    // An imported definition was confirmed by its user already: test it now
    if (imported) void runTest();
  };

  const handleSave = async () => {
    const { opened, form, source } = state;
    if (!opened || !form || !source || state.saving) return;
    const fileName =
      state.imported?.fileName ??
      (source.kind === 'file' ? source.file.name : urlFileName(source.url) || 'model.onnx');
    const normalized = normalizeCustomModelDefinition({
      format: CUSTOM_MODEL_FORMAT,
      version: CUSTOM_MODEL_VERSION,
      label: form.label,
      source: source.kind,
      ...(source.kind === 'url' ? { url: source.url } : {}),
      fileName,
      bytes: opened.bytes,
      sha256: opened.sha256,
      inputName: form.inputName,
      outputName: form.outputName,
      inputSize: form.inputSize,
      resize: form.resize,
      normalization: form.normalization,
      output: form.output,
      subjects: [...form.subjects],
    });
    if (!normalized.ok) {
      say(normalized.error);
      return;
    }
    const { definition } = normalized;
    state.saving = true;
    const saveButton = /** @type {HTMLButtonElement | null} */ (
      footer.querySelector('#add-model-save')
    );
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';
    }
    say('');
    try {
      const url =
        definition.source === 'url'
          ? /** @type {string} */ (definition.url)
          : getModelFileUrl(customModelFileName(definition.sha256));
      await probe.save(
        modelCacheKey(/** @type {any} */ ({ url, sha256: definition.sha256 }), location.href),
      );
      const updated = getCustomModelDefinition(definition.id) !== null;
      await saveCustomModel(definition);
      void requestPersistentStorage();
      state.saving = false;
      onSaved(definition, updated);
      close();
    } catch (error) {
      state.saving = false;
      say(`The model could not be saved: ${/** @type {any} */ (error)?.message ?? error}`);
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save';
      }
    }
  };

  // Drop a file anywhere on the dialog
  dialog.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files') || state.saving) return;
    event.preventDefault();
    dialog.setAttribute('data-dragging', 'true');
  });
  dialog.addEventListener('dragleave', (event) => {
    if (event.target === dialog) dialog.removeAttribute('data-dragging');
  });
  dialog.addEventListener('drop', (event) => {
    dialog.removeAttribute('data-dragging');
    const file = event.dataTransfer?.files?.[0];
    if (!file || state.saving) return;
    event.preventDefault();
    // An .onnx opens anew and an imported .json replaces what is loading
    // (both through invalidateOpen)
    void handleFile(file);
  });

  // Outside the views, which replace each other
  dialog.append(fileInput);
  document.body.append(dialog);
  dialog.showModal();
  showSource();
  return { dialog, close };
}

/**
 * Why a file or URL could not be opened (UI copy)
 * @param {unknown} error
 * @returns {string}
 */
export function describeOpenError(error) {
  const message = /** @type {any} */ (error)?.message ?? String(error);
  return message.endsWith('.') ? message : `${message}.`;
}
