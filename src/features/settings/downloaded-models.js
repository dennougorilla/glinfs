/**
 * Settings → "Downloaded models"
 * @module features/settings/downloaded-models
 *
 * Lists every AI cutout model with its size, license and whether this
 * browser keeps it in Cache Storage, with a Delete button per model. A
 * model that an analysis is using (queued or running) cannot be deleted;
 * the row says why and updates when the analysis ends. Deleting also stops
 * an idle worker that still holds the model, so its memory is freed too.
 *
 * Every other file in the model cache (a copy under an earlier pin, or a
 * model this version no longer ships, like the fp32 isnetis.onnx of the
 * first AI cutout release) is listed below as an "Old model file" with its
 * own Delete button: nothing the app stored stays out of reach.
 */

import { createElement } from '../../shared/utils/dom.js';
import {
  deleteCachedFile,
  deleteDownloadedModel,
  listDownloadedModels,
} from '../ai-cutout/model-cache.js';
import { formatModelSize } from '../ai-cutout/model-registry.js';
import { getSegmentationManager, resolveModelSpec } from '../ai-cutout/segmentation-manager.js';

/** @typedef {import('../ai-cutout/model-cache.js').DownloadedModelInfo} DownloadedModelInfo */
/** @typedef {import('../ai-cutout/model-cache.js').OldModelFile} OldModelFile */
/** @typedef {import('../ai-cutout/model-cache.js').DownloadedModelsListing} DownloadedModelsListing */

/**
 * @typedef {Object} DownloadedModelsDeps
 * @property {() => Promise<DownloadedModelsListing>} [list]
 * @property {(modelId: string) => Promise<boolean>} [remove]
 * @property {(url: string) => Promise<boolean>} [removeFile] - Deletes an old file
 * @property {{ isModelBusy: (id: string) => boolean, onBusyChange: (listener: () => void) => () => void, unloadModel: (id: string) => boolean }} [manager]
 */

/** Row label of a file no registered model loads */
export const OLD_FILE_LABEL = 'Old model file';

/**
 * Status line of a model row
 * @param {DownloadedModelInfo} model
 * @param {boolean} busy
 * @returns {string}
 */
export function describeModelStatus(model, busy) {
  if (busy) return 'In use by a running analysis. It can be deleted when the analysis ends.';
  if (model.cached === null) return 'This browser does not allow checking its cache.';
  return model.cached ? 'Downloaded, kept in this browser’s cache' : 'Not downloaded';
}

/**
 * Render the section. The list fills in once Cache Storage answers.
 * @param {Array<() => void>} cleanups - Receives the section's cleanups
 * @param {DownloadedModelsDeps} [deps]
 * @returns {HTMLElement}
 */
export function renderDownloadedModelsSection(cleanups, deps = {}) {
  // The key a model is cached under carries the hash its load verifies
  // (the DEV/E2E stub override included)
  const cacheDeps = { getSha256: (/** @type {string} */ id) => resolveModelSpec(id).sha256 };
  const list = deps.list ?? (() => listDownloadedModels(cacheDeps));
  const remove = deps.remove ?? ((id) => deleteDownloadedModel(id, cacheDeps));
  const removeFile = deps.removeFile ?? ((url) => deleteCachedFile(url));
  const manager = deps.manager ?? getSegmentationManager();

  let disposed = false;
  /** @type {DownloadedModelsListing | null} */
  let listing = null;
  /** Rows being deleted, by row key @type {Set<string>} */
  const deleting = new Set();

  const titleId = 'settings-models-title';
  const section = createElement('section', {
    className: 'settings-section settings-models',
    'aria-labelledby': titleId,
  });
  const header = createElement('div', { className: 'settings-section-header' }, [
    createElement('h2', { className: 'settings-section-title', id: titleId }, [
      'Downloaded models',
    ]),
  ]);
  const intro = createElement('p', { className: 'settings-models-intro' }, [
    'AI cutout models download the first time you analyze with them and stay in this browser’s cache. Deleting one frees the space; it downloads again the next time you use it. Old model files are left over from earlier versions of glinfs and are no longer used.',
  ]);
  const listEl = createElement('ul', {
    className: 'settings-list settings-models-list',
    'aria-busy': 'true',
  });
  const status = createElement('p', {
    className: 'settings-models-status',
    role: 'status',
  });
  section.append(header, intro, listEl, status);

  /**
   * One row: name, notes, status line and a Delete button
   * @param {{ key: string, index: number, label: string, notes: (string | Node)[], status: string, deleteLabel: string, canDelete: boolean, onDelete: () => void, attrs: Record<string, string>, buttonAttrs: Record<string, string> }} row
   * @returns {HTMLElement}
   */
  const renderRow = ({
    key,
    index,
    label,
    notes,
    status: rowStatus,
    deleteLabel,
    canDelete,
    onDelete,
    attrs,
    buttonAttrs,
  }) => {
    const nameId = `settings-model-row-${index}-name`;
    const statusId = `settings-model-row-${index}-status`;
    const deleteBtn = /** @type {HTMLButtonElement} */ (
      createElement(
        'button',
        {
          type: 'button',
          className: 'btn btn-secondary btn-sm settings-models-delete',
          'aria-label': deleteLabel,
          'aria-describedby': statusId,
          ...buttonAttrs,
        },
        [deleting.has(key) ? 'Deleting…' : 'Delete'],
      )
    );
    deleteBtn.disabled = !canDelete || deleting.has(key);
    deleteBtn.addEventListener('click', onDelete);
    const item = createElement(
      'li',
      { className: 'settings-item settings-models-item', ...attrs },
      [
        createElement('div', { className: 'settings-item-text' }, [
          createElement('h3', { className: 'settings-item-label', id: nameId }, [label]),
          createElement('p', { className: 'settings-item-note' }, notes),
          createElement(
            'p',
            { className: 'settings-item-note settings-models-state', id: statusId },
            [rowStatus],
          ),
        ]),
        deleteBtn,
      ],
    );
    item.dataset.rowKey = key;
    return item;
  };

  /**
   * @param {DownloadedModelInfo} model
   * @param {number} index
   * @returns {HTMLElement}
   */
  const renderModelRow = (model, index) => {
    const busy = manager.isModelBusy(model.id);
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
    return renderRow({
      key: `model:${model.id}`,
      index,
      label: model.label,
      notes: [`${model.description} · ${formatModelSize(model.bytes)} · License: `, licenseLink],
      status: describeModelStatus(model, busy),
      deleteLabel: `Delete the ${model.label} model`,
      canDelete: !busy && model.cached === true,
      onDelete: () => void handleDelete(model),
      attrs: { 'data-model-id': model.id },
      buttonAttrs: { 'data-model-delete': model.id },
    });
  };

  /**
   * @param {OldModelFile} file
   * @param {number} index
   * @returns {HTMLElement}
   */
  const renderOldFileRow = (file, index) =>
    renderRow({
      key: `file:${file.url}`,
      index,
      label: OLD_FILE_LABEL,
      notes: [
        createElement('span', { className: 'settings-models-file' }, [file.fileName]),
        file.bytes === null ? '' : ` · ${formatModelSize(file.bytes)}`,
      ],
      status: 'No longer used by this version. Deleting it frees the space.',
      deleteLabel: `Delete the old model file ${file.fileName}`,
      canDelete: true,
      onDelete: () => void handleDeleteFile(file),
      attrs: { 'data-old-file': file.fileName },
      buttonAttrs: {},
    });

  const render = () => {
    if (disposed || !listing) return;
    // The row that holds focus keeps it across the rebuild (its button, or
    // its heading once the button got disabled); a row that is gone hands
    // it to the row now in its place
    const focused = document.activeElement;
    const focusedRow =
      focused instanceof HTMLElement && listEl.contains(focused)
        ? /** @type {HTMLElement | null} */ (focused.closest('[data-row-key]'))
        : null;
    const focusedKey = focusedRow?.dataset.rowKey;
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
    const button = target.querySelector('button');
    if (button instanceof HTMLButtonElement && !button.disabled) {
      button.focus();
    } else {
      const heading = target.querySelector('h3');
      if (heading instanceof HTMLElement) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }
  };

  const refresh = async () => {
    try {
      const next = await list();
      if (disposed) return;
      listing = next;
    } catch {
      if (disposed) return;
      listing = { models: [], oldFiles: [] };
      status.textContent = 'The downloaded models could not be listed.';
    }
    render();
  };

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

  const unsubscribe = manager.onBusyChange(() => render());
  cleanups.push(() => {
    disposed = true;
    unsubscribe();
  });

  void refresh();
  return section;
}
