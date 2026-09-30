/**
 * Settings → "AI models"
 * @module features/settings/downloaded-models
 *
 * One row per registered AI cutout model: what it is for (large) and the
 * network behind it (small), a one-line description, its size and license
 * (plus a one-line caveat when the registry has one: General's DIS5K note),
 * and its state — Not downloaded, Downloading NN%, Downloaded, Loaded (its
 * session is in memory this visit) or Update available (the cached file is
 * an older pin). Each row downloads the model ahead of use (with progress
 * and Cancel) or deletes it (after a confirmation); "Download all" fetches
 * every model not downloaded yet, one after another.
 *
 * Downloads run through the shared model downloads (the same verified
 * download and caching code the worker uses; they continue when the user
 * leaves Settings). After a download the app asks for persistent storage;
 * a status line says whether the browser granted it, next to the storage
 * the site uses.
 *
 * A model that an analysis is using (queued or running) cannot be deleted;
 * the row says why and updates when the analysis ends. Deleting also frees
 * the model's session when no analysis uses it.
 *
 * The "Prepare downloaded models when the editor opens" toggle (user
 * setting aiCutout.preloadModels) sits at the end of the section.
 *
 * Every other file in the model cache (a model this version no longer
 * ships, like the fp32 isnetis.onnx of the first AI cutout release) is
 * listed below as an "Old model file" with its own Delete button: nothing
 * the app stored stays out of reach.
 */

import { loadSettings, updateSetting } from '../../shared/user-settings.js';
import { createElement } from '../../shared/utils/dom.js';
import {
  deleteCachedFile,
  deleteDownloadedModel,
  listDownloadedModels,
} from '../ai-cutout/model-cache.js';
import { getModelDownloads } from '../ai-cutout/model-downloads.js';
import { formatModelSize, getModelIds } from '../ai-cutout/model-registry.js';
import { estimateStorageUsage, isStoragePersistent } from '../ai-cutout/model-storage.js';
import { SegmentationErrorCode } from '../ai-cutout/protocol.js';
import { getSegmentationManager, resolveModelSpec } from '../ai-cutout/segmentation-manager.js';

/** @typedef {import('../ai-cutout/model-cache.js').DownloadedModelInfo} DownloadedModelInfo */
/** @typedef {import('../ai-cutout/model-cache.js').OldModelFile} OldModelFile */
/** @typedef {import('../ai-cutout/model-cache.js').DownloadedModelsListing} DownloadedModelsListing */
/** @typedef {import('../ai-cutout/model-downloads.js').ModelDownloadState} ModelDownloadState */
/** @typedef {import('../ai-cutout/model-downloads.js').ModelDownloadResult} ModelDownloadResult */

/**
 * The part of the segmentation manager this section uses
 * @typedef {Object} ManagerLike
 * @property {(id: string) => boolean} isModelBusy
 * @property {(listener: () => void) => () => void} onBusyChange
 * @property {(listener: () => void) => () => void} [onModelStateChange]
 * @property {(id: string) => unknown} [getReadyInfo]
 * @property {(id: string) => boolean} unloadModel
 */

/**
 * The part of the model downloads this section uses
 * @typedef {Object} DownloadsLike
 * @property {(id: string) => Promise<ModelDownloadResult>} start
 * @property {(id: string) => void} cancel
 * @property {(id: string) => ModelDownloadState | null} get
 * @property {(listener: () => void) => () => void} subscribe
 */

/**
 * @typedef {Object} DownloadedModelsDeps
 * @property {() => Promise<DownloadedModelsListing>} [list]
 * @property {(modelId: string) => Promise<boolean>} [remove]
 * @property {(url: string) => Promise<boolean>} [removeFile] - Deletes an old file
 * @property {ManagerLike} [manager]
 * @property {DownloadsLike} [downloads]
 * @property {() => Promise<boolean | null>} [isPersistent]
 * @property {() => Promise<number | null>} [estimateUsage]
 * @property {(message: string) => boolean} [confirm]
 * @property {{ get: () => boolean, set: (value: boolean) => void }} [preloadSetting]
 */

/**
 * A model's license caveat: one sentence and a link to where it comes from
 * @param {import('../ai-cutout/model-registry.js').ModelLicenseNote} note
 * @returns {HTMLElement}
 */
function renderLicenseNote(note) {
  return createElement('span', { className: 'settings-models-license-note' }, [
    `${note.text} `,
    createElement(
      'a',
      {
        href: note.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        className: 'settings-models-link',
      },
      [note.linkLabel],
    ),
  ]);
}

/** Row label of a file no registered model loads */
export const OLD_FILE_LABEL = 'Old model file';

/**
 * @typedef {'not-downloaded' | 'downloading' | 'downloaded' | 'loaded' | 'update-available' | 'unknown'} ModelStatusKind
 */

/**
 * State of a model row, most specific first: a running download, a session
 * in memory, an older cached pin, the cached file.
 * @param {Pick<DownloadedModelInfo, 'cached' | 'updateAvailable'>} model
 * @param {{ busy?: boolean, loaded?: boolean, download?: ModelDownloadState | null }} [runtime]
 * @returns {{ kind: ModelStatusKind, text: string }}
 */
export function deriveModelStatus(model, { busy = false, loaded = false, download = null } = {}) {
  const inUse = busy ? ' In use by a running analysis; it can be deleted when it ends.' : '';
  if (download) {
    if (download.phase === 'verifying') {
      return { kind: 'downloading', text: 'Checking the download…' };
    }
    const pct =
      download.totalBytes > 0 ? Math.floor((download.loadedBytes / download.totalBytes) * 100) : 0;
    return { kind: 'downloading', text: `Downloading ${pct}%` };
  }
  if (loaded) return { kind: 'loaded', text: `Loaded (ready to analyze).${inUse}` };
  if (busy) return { kind: 'downloaded', text: inUse.trim() };
  if (model.cached === null) {
    return { kind: 'unknown', text: 'This browser does not allow checking its cache.' };
  }
  if (model.updateAvailable) {
    return { kind: 'update-available', text: 'Update available. The downloaded file is older.' };
  }
  return model.cached
    ? { kind: 'downloaded', text: 'Downloaded' }
    : { kind: 'not-downloaded', text: 'Not downloaded' };
}

/**
 * The storage status line
 * @param {{ persistent: boolean | null, usage: number | null, fallbackBytes: number }} storage
 *   usage: what the site stores (navigator.storage.estimate); fallbackBytes:
 *   the cached models' sizes, used when the browser cannot tell
 * @returns {string}
 */
export function describeStorage({ persistent, usage, fallbackBytes }) {
  const used = `Storage used: ${formatModelSize(usage ?? fallbackBytes)}`;
  if (persistent === true) return `${used} · Stored persistently`;
  if (persistent === false) return `${used} · Browser may clear these when space is low`;
  return used;
}

/**
 * Message for a finished download
 * @param {string} label
 * @param {ModelDownloadResult} result
 * @returns {string}
 */
export function describeDownloadResult(label, result) {
  if (result.outcome === 'cancelled') return `The ${label} model download was cancelled.`;
  if (result.outcome === 'done') {
    return result.cached
      ? `The ${label} model was downloaded.`
      : `The ${label} model was downloaded but this browser could not keep it.`;
  }
  const code = /** @type {any} */ (result.error)?.code;
  if (code === SegmentationErrorCode.HASH_MISMATCH) {
    return `The ${label} model download was damaged, so it was not kept. Try again.`;
  }
  if (code === SegmentationErrorCode.MODEL_NOT_FOUND) {
    return `The ${label} model could not be downloaded (not found).`;
  }
  return `The ${label} model could not be downloaded. Check your connection and try again.`;
}

/**
 * Render the section. The list fills in once Cache Storage answers.
 * @param {Array<() => void>} cleanups - Receives the section's cleanups
 * @param {DownloadedModelsDeps} [deps]
 * @returns {HTMLElement}
 */
export function renderAiModelsSection(cleanups, deps = {}) {
  // The key a model is cached under carries the hash its load verifies
  // (the DEV/E2E stub override included)
  const cacheDeps = { getFiles: (/** @type {string} */ id) => resolveModelSpec(id).files };
  const list = deps.list ?? (() => listDownloadedModels(cacheDeps));
  const remove = deps.remove ?? ((id) => deleteDownloadedModel(id, cacheDeps));
  const removeFile = deps.removeFile ?? ((url) => deleteCachedFile(url));
  const manager = deps.manager ?? getSegmentationManager();
  const downloads = deps.downloads ?? getModelDownloads();
  const isPersistent = deps.isPersistent ?? (() => isStoragePersistent());
  const estimateUsage = deps.estimateUsage ?? (() => estimateStorageUsage());
  const confirmAction = deps.confirm ?? ((message) => globalThis.confirm(message));
  const preloadSetting = deps.preloadSetting ?? {
    get: () => loadSettings().aiCutout.preloadModels !== false,
    set: (/** @type {boolean} */ value) => updateSetting('aiCutout', 'preloadModels', value),
  };

  let disposed = false;
  /** @type {DownloadedModelsListing | null} */
  let listing = null;
  /** Rows being deleted, by row key @type {Set<string>} */
  const deleting = new Set();
  let downloadingAll = false;
  /** Models seen downloading at the last downloads change @type {Set<string>} */
  const activeDownloads = () => new Set(getModelIds().filter((id) => downloads.get(id)));
  let downloadsSeen = activeDownloads();

  const titleId = 'settings-models-title';
  const section = createElement('section', {
    className: 'settings-section settings-models',
    'aria-labelledby': titleId,
  });
  const downloadAllBtn = /** @type {HTMLButtonElement} */ (
    createElement(
      'button',
      {
        type: 'button',
        className: 'btn btn-secondary btn-sm settings-models-download-all',
        id: 'settings-models-download-all',
      },
      ['Download all'],
    )
  );
  const header = createElement('div', { className: 'settings-section-header' }, [
    createElement('h2', { className: 'settings-section-title', id: titleId }, ['AI models']),
    downloadAllBtn,
  ]);
  const intro = createElement('p', { className: 'settings-models-intro' }, [
    'AI cutout models run in this browser. Download them here ahead of time, or the first analysis with a model downloads it. They stay until you delete them.',
  ]);
  const storageLine = createElement('p', {
    className: 'settings-models-storage',
    id: 'settings-models-storage',
  });
  const listEl = createElement('ul', {
    className: 'settings-list settings-models-list',
    'aria-busy': 'true',
  });
  const status = createElement('p', {
    className: 'settings-models-status',
    role: 'status',
  });

  // --- Prepare downloaded models (user setting) ---
  const preloadNoteId = 'settings-models-preload-note';
  const preloadToggle = /** @type {HTMLButtonElement} */ (
    createElement('button', {
      type: 'button',
      id: 'settings-models-preload',
      'aria-labelledby': 'settings-models-preload-label',
      'aria-describedby': preloadNoteId,
    })
  );
  const paintPreload = () => {
    const on = preloadSetting.get();
    preloadToggle.className = `btn btn-toggle ${on ? 'btn-toggle--active' : ''}`;
    preloadToggle.setAttribute('aria-pressed', String(on));
    preloadToggle.textContent = on ? 'On' : 'Off';
  };
  paintPreload();
  const onPreloadClick = () => {
    preloadSetting.set(!preloadSetting.get());
    paintPreload();
  };
  preloadToggle.addEventListener('click', onPreloadClick);
  const preloadRow = createElement('div', { className: 'settings-item settings-models-preload' }, [
    createElement('div', { className: 'settings-item-text' }, [
      createElement(
        'span',
        { className: 'settings-item-label', id: 'settings-models-preload-label' },
        ['Prepare downloaded models when the editor opens'],
      ),
      createElement('p', { className: 'settings-item-note', id: preloadNoteId }, [
        'Loads the chosen model in the background so Analyze starts right away. Never downloads.',
      ]),
    ]),
    createElement('div', { className: 'settings-control' }, [preloadToggle]),
  ]);

  section.append(header, intro, storageLine, listEl, status, preloadRow);

  /**
   * One row: name, notes, status line and actions
   * @param {{ key: string, index: number, title: (string | Node)[], notes: (string | Node)[][], status: string, statusKind?: string, progress?: number | null, actions: HTMLButtonElement[], attrs: Record<string, string> }} row
   * @returns {HTMLElement}
   */
  const renderRow = ({
    key,
    index,
    title,
    notes,
    status: rowStatus,
    statusKind,
    progress,
    actions,
    attrs,
  }) => {
    const nameId = `settings-model-row-${index}-name`;
    const statusId = `settings-model-row-${index}-status`;
    for (const button of actions) button.setAttribute('aria-describedby', statusId);
    const text = createElement('div', { className: 'settings-item-text' }, [
      createElement(
        'h3',
        { className: 'settings-item-label settings-models-title', id: nameId },
        title,
      ),
      ...notes.map((note) => createElement('p', { className: 'settings-item-note' }, note)),
      createElement(
        'p',
        {
          className: `settings-item-note settings-models-state${statusKind ? ` settings-models-state--${statusKind}` : ''}`,
          id: statusId,
        },
        [rowStatus],
      ),
    ]);
    if (progress !== undefined && progress !== null) {
      text.append(
        createElement('progress', {
          className: 'settings-models-progress',
          max: '1',
          value: String(progress),
          'aria-labelledby': `${nameId} ${statusId}`,
        }),
      );
    }
    const item = createElement(
      'li',
      { className: 'settings-item settings-models-item', ...attrs },
      [text, createElement('div', { className: 'settings-models-actions' }, actions)],
    );
    item.dataset.rowKey = key;
    return item;
  };

  /**
   * @param {string} label
   * @param {Record<string, string>} attrs
   * @param {() => void} onClick
   * @param {{ disabled?: boolean, primary?: boolean }} [options]
   * @returns {HTMLButtonElement}
   */
  const button = (label, attrs, onClick, { disabled = false, primary = false } = {}) => {
    const el = /** @type {HTMLButtonElement} */ (
      createElement(
        'button',
        {
          type: 'button',
          className: `btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm settings-models-action`,
          ...attrs,
        },
        [label],
      )
    );
    el.disabled = disabled;
    el.addEventListener('click', onClick);
    return el;
  };

  /**
   * @param {DownloadedModelInfo} model
   * @param {number} index
   * @returns {HTMLElement}
   */
  const renderModelRow = (model, index) => {
    const key = `model:${model.id}`;
    const busy = manager.isModelBusy(model.id);
    const loaded = Boolean(manager.getReadyInfo?.(model.id));
    const download = downloads.get(model.id);
    const state = deriveModelStatus(model, { busy, loaded, download });
    const licenseLink = createElement(
      'a',
      {
        href: model.license.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        className: 'settings-models-link',
      },
      [model.license.name],
    );
    /** @type {HTMLButtonElement[]} */
    const actions = [];
    if (download) {
      actions.push(
        button(
          'Cancel',
          {
            'aria-label': `Cancel the ${model.label} model download`,
            'data-model-cancel': model.id,
          },
          () => downloads.cancel(model.id),
        ),
      );
    } else if (model.cached !== true || model.updateAvailable) {
      actions.push(
        button(
          model.updateAvailable ? 'Update' : 'Download',
          {
            'aria-label': `Download the ${model.label} model (${formatModelSize(model.bytes)})`,
            'data-model-download': model.id,
          },
          () => void handleDownload(model),
          { primary: true },
        ),
      );
    }
    const hasFile = model.cached === true || model.staleUrls.length > 0;
    if (hasFile && !download) {
      actions.push(
        button(
          deleting.has(key) ? 'Deleting…' : 'Delete',
          { 'aria-label': `Delete the ${model.label} model`, 'data-model-delete': model.id },
          () => void handleDelete(model),
          { disabled: busy || deleting.has(key) },
        ),
      );
    }
    return renderRow({
      key,
      index,
      title: [
        model.label,
        createElement('span', { className: 'settings-models-name' }, [model.modelName]),
      ],
      notes: [
        [model.description],
        [`${formatModelSize(model.bytes)} · License: `, licenseLink],
        ...(model.licenseNote ? [[renderLicenseNote(model.licenseNote)]] : []),
      ],
      status: state.text,
      statusKind: state.kind,
      progress:
        download && download.phase === 'downloading' && download.totalBytes > 0
          ? download.loadedBytes / download.totalBytes
          : null,
      actions,
      attrs: { 'data-model-id': model.id, 'data-model-status': state.kind },
    });
  };

  /**
   * @param {OldModelFile} file
   * @param {number} index
   * @returns {HTMLElement}
   */
  const renderOldFileRow = (file, index) => {
    const key = `file:${file.url}`;
    return renderRow({
      key,
      index,
      title: [OLD_FILE_LABEL],
      notes: [
        [
          createElement('span', { className: 'settings-models-file' }, [file.fileName]),
          file.bytes === null ? '' : ` · ${formatModelSize(file.bytes)}`,
        ],
      ],
      status: 'No longer used by this version. Deleting it frees the space.',
      actions: [
        button(
          deleting.has(key) ? 'Deleting…' : 'Delete',
          { 'aria-label': `Delete the old model file ${file.fileName}` },
          () => void handleDeleteFile(file),
          { disabled: deleting.has(key) },
        ),
      ],
      attrs: { 'data-old-file': file.fileName },
    });
  };

  const render = () => {
    if (disposed || !listing) return;
    const pending = listing.models.filter(
      (model) => (model.cached !== true || model.updateAvailable) && !downloads.get(model.id),
    );
    downloadAllBtn.disabled = downloadingAll || pending.length === 0;
    // The row that holds focus keeps it across the rebuild (the same
    // button, else its first button, else its heading); a row that is gone
    // hands it to the row now in its place
    const focused = document.activeElement;
    const focusedRow =
      focused instanceof HTMLElement && listEl.contains(focused)
        ? /** @type {HTMLElement | null} */ (focused.closest('[data-row-key]'))
        : null;
    const focusedKey = focusedRow?.dataset.rowKey;
    const focusedLabel = focused instanceof HTMLElement ? focused.getAttribute('aria-label') : null;
    const focusedIndex = focusedRow ? [...listEl.children].indexOf(focusedRow) : -1;
    const rows = [
      ...listing.models.map(renderModelRow),
      ...listing.oldFiles.map((file, i) => renderOldFileRow(file, listing.models.length + i)),
    ];
    listEl.replaceChildren(...rows);
    listEl.removeAttribute('aria-busy');
    if (focusedKey === undefined) return;
    const target =
      rows.find((row) => row.dataset.rowKey === focusedKey) ??
      rows[Math.min(focusedIndex, rows.length - 1)];
    if (!target) return;
    const buttons = /** @type {HTMLButtonElement[]} */ ([...target.querySelectorAll('button')]);
    const same = buttons.find((b) => b.getAttribute('aria-label') === focusedLabel && !b.disabled);
    const next = same ?? buttons.find((b) => !b.disabled);
    if (next) {
      next.focus();
    } else {
      const heading = target.querySelector('h3');
      if (heading instanceof HTMLElement) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }
  };

  const refreshStorage = async () => {
    const [persistent, usage] = await Promise.all([isPersistent(), estimateUsage()]);
    if (disposed) return;
    storageLine.textContent = describeStorage({
      persistent,
      usage,
      fallbackBytes: listing?.cachedBytes ?? 0,
    });
  };

  const refresh = async () => {
    try {
      const next = await list();
      if (disposed) return;
      listing = next;
    } catch {
      if (disposed) return;
      listing = { models: [], oldFiles: [], cachedBytes: 0 };
      status.textContent = 'The AI models could not be listed.';
    }
    render();
    await refreshStorage();
  };

  /**
   * Download one model and say how it went
   * @param {DownloadedModelInfo} model
   * @returns {Promise<ModelDownloadResult>}
   */
  const handleDownload = async (model) => {
    status.textContent = '';
    const result = await downloads.start(model.id);
    if (disposed) return result;
    status.textContent = describeDownloadResult(model.label, result);
    await refresh();
    return result;
  };

  const handleDownloadAll = async () => {
    if (!listing || downloadingAll) return;
    downloadingAll = true;
    render();
    try {
      // One after another: each download holds the whole file in memory
      // until it is verified
      for (const model of listing.models) {
        if (disposed) return;
        if (model.cached === true && !model.updateAvailable) continue;
        const result = await handleDownload(model);
        if (result.outcome !== 'done') break;
      }
    } finally {
      downloadingAll = false;
      render();
    }
  };
  downloadAllBtn.addEventListener('click', () => void handleDownloadAll());

  /**
   * Run a delete for one row, then say how it went and list again
   * @param {string} key
   * @param {() => Promise<string>} run - Resolves with the status message
   * @param {string} failure - Message when `run` throws
   */
  const deleteRow = async (key, run, failure) => {
    deleting.add(key);
    render();
    let message;
    try {
      message = await run();
    } catch {
      message = failure;
    }
    deleting.delete(key);
    if (disposed) return;
    status.textContent = message;
    await refresh();
  };

  /** @param {DownloadedModelInfo} model */
  const handleDelete = async (model) => {
    const key = `model:${model.id}`;
    // Re-checked at click time: an analysis may have started meanwhile
    if (manager.isModelBusy(model.id) || deleting.has(key)) {
      render();
      return;
    }
    if (
      !confirmAction(
        `Delete the ${model.label} model (${formatModelSize(model.bytes)})? It downloads again the next time you use it.`,
      )
    ) {
      return;
    }
    await deleteRow(
      key,
      async () => {
        const deleted = await remove(model.id);
        manager.unloadModel(model.id);
        return deleted
          ? `The ${model.label} model was deleted.`
          : `The ${model.label} model was not in this browser’s cache.`;
      },
      `The ${model.label} model could not be deleted.`,
    );
  };

  /** @param {OldModelFile} file */
  const handleDeleteFile = async (file) => {
    const key = `file:${file.url}`;
    if (deleting.has(key)) return;
    await deleteRow(
      key,
      async () =>
        (await removeFile(file.url))
          ? `The old model file ${file.fileName} was deleted.`
          : `The old model file ${file.fileName} was already gone.`,
      `The old model file ${file.fileName} could not be deleted.`,
    );
  };

  const unsubscribers = [
    manager.onBusyChange(() => render()),
    manager.onModelStateChange?.(() => render()) ?? (() => undefined),
    downloads.subscribe(() => {
      // A download that ended (also one started before this screen
      // mounted) changed the cache: list again
      const active = activeDownloads();
      const ended = [...downloadsSeen].some((id) => !active.has(id));
      downloadsSeen = active;
      if (ended) void refresh();
      else render();
    }),
  ];
  cleanups.push(() => {
    disposed = true;
    preloadToggle.removeEventListener('click', onPreloadClick);
    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  void refresh();
  return section;
}
