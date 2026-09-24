/**
 * Editor left sidebar panel: CLIPS/SCENES tabs (#100 Layout A) with the
 * remembered tab (#98), plus the scenes list renderer
 * @module features/editor/panels/left-sidebar
 */

import { createElement, on } from '../../../shared/utils/dom.js';
import { getThumbnailCache } from '../../../shared/utils/thumbnail-cache.js';
import { createThumbnailCanvas } from '../api.js';

/** sessionStorage key for the remembered CLIPS/SCENES sidebar tab (#98) */
const SIDEBAR_TAB_STORAGE_KEY = 'glinfs.editor.sidebarTab';

/** Module-level fallback when sessionStorage is unavailable (private mode, etc). */
let sidebarTabFallback = 'clips';

/**
 * Read the last-selected CLIPS/SCENES sidebar tab, preferring sessionStorage
 * so the choice survives editor remounts within the same tab session
 * (#98). Falls back to module state when storage throws or is unset.
 * @returns {'clips' | 'scenes'}
 */
function getStoredSidebarTab() {
  try {
    const stored = sessionStorage.getItem(SIDEBAR_TAB_STORAGE_KEY);
    if (stored === 'clips' || stored === 'scenes') return stored;
  } catch {
    // sessionStorage unavailable - fall through to module state
  }
  return sidebarTabFallback;
}

/**
 * Persist the CLIPS/SCENES sidebar tab choice (#98).
 * @param {'clips' | 'scenes'} name
 */
function setStoredSidebarTab(name) {
  sidebarTabFallback = name;
  try {
    sessionStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, name);
  } catch {
    // sessionStorage unavailable - module state above still tracks it
  }
}

/**
 * Render the left sidebar (tab bar + CLIPS/SCENES panes). The panes are
 * empty hooks: the scenes list and clip entries are populated after mount.
 * @returns {{ element: HTMLElement, scenesContainer: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderEditorLeftSidebar() {
  /** @type {(() => void)[]} */
  const cleanups = [];

  // Left Sidebar (#100, Layout A): docked live source monitor on top,
  // CLIPS/SCENES as tabs below — the two lists stop fighting over vertical
  // space, and the live monitor has a fixed home instead of floating.
  const leftSidebar = createElement('div', { className: 'editor-sidebar-left' });
  const leftPanelContent = createElement('div', { className: 'panel-content' });

  // Tab bar
  const clipsTab = createElement(
    'button',
    {
      className: 'sidebar-tab sidebar-tab--active',
      type: 'button',
      'data-tab': 'clips',
      role: 'tab',
      'aria-selected': 'true',
      'data-testid': 'tab-clips',
    },
    ['Clips', createElement('span', { className: 'sidebar-tab-count', 'data-count': 'clips' })],
  );
  const scenesTab = createElement(
    'button',
    {
      className: 'sidebar-tab',
      type: 'button',
      'data-tab': 'scenes',
      role: 'tab',
      'aria-selected': 'false',
      'data-testid': 'tab-scenes',
    },
    ['Scenes', createElement('span', { className: 'sidebar-tab-count', 'data-count': 'scenes' })],
  );
  const tabBar = createElement('div', { className: 'sidebar-tabs', role: 'tablist' }, [
    clipsTab,
    scenesTab,
  ]);
  leftPanelContent.appendChild(tabBar);

  // CLIPS pane — keeps the existing container hooks so refreshClipsPanel /
  // the queue-full banner keep working unchanged
  const clipsPane = createElement('div', { className: 'sidebar-pane', 'data-pane': 'clips' }, [
    createElement('div', {
      className: 'clips-queue-banner',
      role: 'status',
      hidden: true,
    }),
    createElement('div', {
      className: 'clips-sidebar-content',
      'data-clips-container': 'true',
    }),
    createElement('div', {
      className: 'clips-sidebar-memory',
      'data-clips-footer': 'true',
    }),
  ]);
  leftPanelContent.appendChild(clipsPane);

  // SCENES pane — same hook as before for updateScenesSidebar
  const scenesContainer = createElement('div', {
    className: 'scenes-sidebar-content',
    'data-scenes-container': 'true',
  });
  const scenesPane = createElement(
    'div',
    { className: 'sidebar-pane', 'data-pane': 'scenes', hidden: true },
    [scenesContainer],
  );
  leftPanelContent.appendChild(scenesPane);

  const selectTab = (name) => {
    for (const tab of [clipsTab, scenesTab]) {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('sidebar-tab--active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    clipsPane.hidden = name !== 'clips';
    scenesPane.hidden = name !== 'scenes';
    setStoredSidebarTab(name);
  };
  cleanups.push(on(clipsTab, 'click', () => selectTab('clips')));
  cleanups.push(on(scenesTab, 'click', () => selectTab('scenes')));

  // Restore the remembered tab (#98) - re-renders and editor remounts would
  // otherwise always reset to CLIPS regardless of what the user last picked.
  selectTab(getStoredSidebarTab());

  leftSidebar.appendChild(leftPanelContent);

  return { element: leftSidebar, scenesContainer, cleanups };
}

/**
 * Render scenes sidebar with thumbnails (left sidebar)
 * @param {HTMLElement} container - The scenes container element
 * @param {import('../types.js').EditorState} state - Current editor state
 * @param {import('../ui.js').EditorUIHandlers} handlers - UI handlers
 * @returns {(() => void)[]} Cleanup functions for event listeners
 */
export function renderScenesSidebar(container, state, handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  // Clear container
  container.innerHTML = '';

  // Show different content based on scene detection status
  if (state.sceneDetectionStatus === 'idle') {
    // One quiet line (#98) - the old icon + two-line empty state ate more
    // sidebar height than the actual scenes list usually does
    container.appendChild(
      createElement('div', { className: 'scenes-sidebar-hint' }, [
        'No scenes \u2014 enable Scene Detection in Capture',
      ]),
    );
    return cleanups;
  }

  if (state.sceneDetectionStatus === 'detecting') {
    const progressContainer = createElement('div', { className: 'scene-detection-progress' });
    const progressBar = createElement('div', { className: 'progress-bar' });
    const progressFill = createElement('div', {
      className: 'progress-fill',
      style: `width: ${state.sceneDetectionProgress}%`,
    });
    progressBar.appendChild(progressFill);
    progressContainer.appendChild(
      createElement('div', { className: 'progress-label' }, [
        `Detecting... ${state.sceneDetectionProgress}%`,
      ]),
    );
    progressContainer.appendChild(progressBar);
    container.appendChild(progressContainer);
    return cleanups;
  }

  if (state.sceneDetectionStatus === 'error') {
    container.appendChild(
      createElement('div', { className: 'scene-detection-error' }, [
        createElement('span', { className: 'error-icon' }, ['\u26A0']),
        state.sceneDetectionError || 'Detection failed',
      ]),
    );
    return cleanups;
  }

  // Completed, zero scenes found - one quiet line (#98), matching the
  // detection-off hint above instead of the old icon + two-line block
  if (state.scenes.length === 0) {
    container.appendChild(
      createElement('div', { className: 'scenes-sidebar-hint' }, ['No scene changes detected']),
    );
    return cleanups;
  }

  // Create scenes list with thumbnails
  const scenesList = createElement('div', { className: 'scenes-thumbnail-list' });

  /** @type {HTMLElement[]} */
  const sceneCards = [];

  /**
   * Update selection state for all scene cards
   * @param {number} selectedSceneIndex
   */
  function updateCardSelection(selectedSceneIndex) {
    sceneCards.forEach((card, idx) => {
      card.classList.toggle('is-selected', idx === selectedSceneIndex);
    });
  }

  const sceneThumbnailSize = 160;
  const thumbnailCache = getThumbnailCache();

  state.scenes.forEach((scene, index) => {
    const isSelected =
      state.selectedRange.start === scene.startFrame && state.selectedRange.end === scene.endFrame;

    const sceneCard = createElement('button', {
      className: `scene-thumbnail-card ${isSelected ? 'is-selected' : ''}`,
      type: 'button',
      'data-scene-id': scene.id,
      // Range bounds are duplicated on the DOM node so a pure range-change
      // tick can toggle selection (updateScenesSelection) without needing
      // to re-walk `state.scenes` or rebuild anything (issue #99, fix 2).
      'data-scene-start': String(scene.startFrame),
      'data-scene-end': String(scene.endFrame),
      title: `Scene ${index + 1}: Frames ${scene.startFrame}-${scene.endFrame}`,
    });

    // Create thumbnail from first frame of scene - routed through the
    // shared ThumbnailCache so repeated renders of the same scene list
    // (e.g. after this panel is rebuilt for an unrelated reason) reuse the
    // already-drawn canvas instead of paying drawImage/getImageData again.
    const thumbnailContainer = createElement('div', { className: 'scene-thumbnail' });
    const sceneFrame = state.clip?.frames[scene.startFrame];
    if (sceneFrame) {
      try {
        let canvas = thumbnailCache.get(sceneFrame.id, sceneThumbnailSize);
        if (!canvas) {
          canvas = createThumbnailCanvas(sceneFrame, sceneThumbnailSize);
          thumbnailCache.addCanvas(sceneFrame.id, sceneThumbnailSize, canvas);
        }
        // Clone the pixel content (cloneNode alone doesn't copy canvas bitmap data),
        // so the cached canvas can be reused by other consumers untouched.
        const canvasClone = document.createElement('canvas');
        canvasClone.width = canvas.width;
        canvasClone.height = canvas.height;
        const cloneCtx = canvasClone.getContext('2d');
        if (cloneCtx) {
          cloneCtx.drawImage(canvas, 0, 0);
        }
        canvasClone.className = 'scene-thumbnail-canvas';
        thumbnailContainer.appendChild(canvasClone);
      } catch (e) {
        console.warn('[Editor] Failed to create scene thumbnail:', e);
        thumbnailContainer.appendChild(
          createElement('div', { className: 'scene-thumbnail-placeholder' }, ['\uD83C\uDFA5']),
        );
      }
    }
    sceneCard.appendChild(thumbnailContainer);

    // Scene info
    const sceneInfo = createElement('div', { className: 'scene-thumbnail-info' }, [
      createElement('div', { className: 'scene-thumbnail-header' }, [
        createElement('span', { className: 'scene-thumbnail-number' }, [`Scene ${index + 1}`]),
        createElement('span', { className: 'scene-thumbnail-duration' }, [
          `${scene.endFrame - scene.startFrame + 1}f`,
        ]),
      ]),
      createElement('div', { className: 'scene-thumbnail-range' }, [
        `${scene.startFrame} \u2192 ${scene.endFrame}`,
      ]),
    ]);
    sceneCard.appendChild(sceneInfo);

    sceneCards.push(sceneCard);

    cleanups.push(
      on(sceneCard, 'click', () => {
        handlers.onFrameChange(scene.startFrame);
        handlers.onRangeChange({ start: scene.startFrame, end: scene.endFrame });
        updateCardSelection(index);
      }),
    );

    scenesList.appendChild(sceneCard);
  });

  container.appendChild(scenesList);

  // Scene count footer
  container.appendChild(
    createElement('div', { className: 'scenes-sidebar-footer' }, [
      `${state.scenes.length} scene${state.scenes.length !== 1 ? 's' : ''} detected`,
    ]),
  );

  return cleanups;
}
