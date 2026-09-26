/**
 * Settings → "Downloaded models"
 * @module features/settings/downloaded-models
 *
 * Lists every AI cutout model with its size, license and whether this
 * browser keeps it in Cache Storage, with a Delete button per model. A
 * model that an analysis is using (queued or running) cannot be deleted;
 * the row says why and updates when the analysis ends. Deleting also stops
 * an idle worker that still holds the model, so its memory is freed too.
 */

import { createElement } from '../../shared/utils/dom.js';
import { deleteDownloadedModel, listDownloadedModels } from '../ai-cutout/model-cache.js';
import { formatModelSize } from '../ai-cutout/model-registry.js';
import { getSegmentationManager } from '../ai-cutout/segmentation-manager.js';

/** @typedef {import('../ai-cutout/model-cache.js').DownloadedModelInfo} DownloadedModelInfo */

/**
 * @typedef {Object} DownloadedModelsDeps
 * @property {() => Promise<DownloadedModelInfo[]>} [list]
 * @property {(modelId: string) => Promise<boolean>} [remove]
 * @property {{ isModelBusy: (id: string) => boolean, onBusyChange: (listener: () => void) => () => void, unloadModel: (id: string) => boolean }} [manager]
 */

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
  const list = deps.list ?? (() => listDownloadedModels());
  const remove = deps.remove ?? ((id) => deleteDownloadedModel(id));
  const manager = deps.manager ?? getSegmentationManager();

  let disposed = false;
  /** @type {DownloadedModelInfo[] | null} */
  let models = null;
  /** Rows being deleted @type {Set<string>} */
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
    'AI cutout models download the first time you analyze with them and stay in this browser’s cache. Deleting one frees the space; it downloads again the next time you use it.',
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
   * @param {DownloadedModelInfo} model
   * @returns {HTMLElement}
   */
  const renderRow = (model) => {
    const busy = manager.isModelBusy(model.id);
    const nameId = `settings-model-${model.id}-name`;
    const statusId = `settings-model-${model.id}-status`;
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
    const deleteBtn = /** @type {HTMLButtonElement} */ (
      createElement(
        'button',
        {
          type: 'button',
          className: 'btn btn-secondary btn-sm settings-models-delete',
          'aria-label': `Delete the ${model.label} model`,
          'aria-describedby': statusId,
          'data-model-delete': model.id,
        },
        [deleting.has(model.id) ? 'Deleting…' : 'Delete'],
      )
    );
    deleteBtn.disabled = busy || model.cached !== true || deleting.has(model.id);
    deleteBtn.addEventListener('click', () => void handleDelete(model));
    return createElement(
      'li',
      { className: 'settings-item settings-models-item', 'data-model-id': model.id },
      [
        createElement('div', { className: 'settings-item-text' }, [
          createElement('h3', { className: 'settings-item-label', id: nameId }, [model.label]),
          createElement('p', { className: 'settings-item-note' }, [
            `${model.description} · ${formatModelSize(model.bytes)} · License: `,
            licenseLink,
          ]),
          createElement(
            'p',
            { className: 'settings-item-note settings-models-state', id: statusId },
            [describeModelStatus(model, busy)],
          ),
        ]),
        deleteBtn,
      ],
    );
  };

  const render = () => {
    if (disposed || !models) return;
    // The row that holds focus (its button, or its heading once the button
    // got disabled) keeps it across the rebuild
    const focused = document.activeElement;
    const focusedId =
      focused instanceof HTMLElement && listEl.contains(focused)
        ? /** @type {HTMLElement | null} */ (focused.closest('[data-model-id]'))?.dataset.modelId
        : undefined;
    listEl.replaceChildren(...models.map(renderRow));
    listEl.removeAttribute('aria-busy');
    if (focusedId) {
      // Keep keyboard focus on the row (its button may be disabled now)
      const button = listEl.querySelector(`[data-model-delete="${focusedId}"]`);
      if (button instanceof HTMLButtonElement && !button.disabled) {
        button.focus();
      } else {
        const heading = listEl.querySelector(`#settings-model-${focusedId}-name`);
        if (heading instanceof HTMLElement) {
          heading.tabIndex = -1;
          heading.focus();
        }
      }
    }
  };

  const refresh = async () => {
    try {
      const next = await list();
      if (disposed) return;
      models = next;
    } catch {
      if (disposed) return;
      models = [];
      status.textContent = 'The downloaded models could not be listed.';
    }
    render();
  };

  /** @param {DownloadedModelInfo} model */
  const handleDelete = async (model) => {
    // Re-checked at click time: an analysis may have started meanwhile
    if (manager.isModelBusy(model.id) || deleting.has(model.id)) {
      render();
      return;
    }
    deleting.add(model.id);
    render();
    let message;
    try {
      const deleted = await remove(model.id);
      manager.unloadModel(model.id);
      message = deleted
        ? `The ${model.label} model was deleted.`
        : `The ${model.label} model was not in this browser’s cache.`;
    } catch {
      message = `The ${model.label} model could not be deleted.`;
    }
    deleting.delete(model.id);
    if (disposed) return;
    status.textContent = message;
    await refresh();
  };

  const unsubscribe = manager.onBusyChange(() => render());
  cleanups.push(() => {
    disposed = true;
    unsubscribe();
  });

  void refresh();
  return section;
}
