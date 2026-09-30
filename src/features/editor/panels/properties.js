/**
 * Editor properties panel (right column): live monitor slot, then three
 * tabs — Frame (aspect ratio, playback, crop range, overlay), Text and
 * Background — and the Touch up mode, which replaces the tabs while the
 * mask brush is on (see touch-up-panel.js).
 *
 * The tabs follow the ARIA tabs pattern: a roving tabindex, arrow keys /
 * Home / End move between them and select (automatic activation). Their
 * keydowns are consumed so the editor's arrow-key and Space shortcuts do
 * not fire on a focused tab. The chosen tab lives in state.sidebarTab; the
 * DOM is switched at once (updateSidebarTabs) and again from state, which
 * is idempotent.
 * @module features/editor/panels/properties
 */

import { createElement, on } from '../../../shared/utils/dom.js';
import { getAnalysisFraction } from '../ai-cutout.js';
import { SIDEBAR_TABS } from '../state.js';
import { isAnalysisRunning, renderBackgroundPanel } from './background-panel.js';
import { renderTextPanel } from './edits-panel.js';
import { renderTouchUpSection } from './touch-up-panel.js';

/** @type {Record<import('../types.js').SidebarTab, string>} */
const TAB_LABELS = { frame: 'Frame', text: 'Text', background: 'Background' };

/**
 * Tab icons (24px viewBox, stroked like the app's other icons): crop
 * marks, a "T", and a person cut out of a dashed frame
 * @type {Record<import('../types.js').SidebarTab, string>}
 */
const TAB_ICONS = {
  frame: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  background:
    '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/><circle cx="12" cy="10" r="3"/><path d="M7 21v-1a5 5 0 0 1 10 0v1"/>',
};

/**
 * @param {import('../types.js').SidebarTab} tab
 * @returns {SVGSVGElement}
 */
function createTabIcon(tab) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: '18',
    height: '18',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(name, value);
  }
  svg.innerHTML = TAB_ICONS[tab];
  return svg;
}

/** @type {string[]} */
const ASPECT_RATIOS = ['free', '1:1', '16:9', '4:3', '9:16'];

/**
 * Playback speeds the editor offers. The editor speed is also the GIF's
 * speed (the export uses it for the frame delays).
 * @type {readonly number[]}
 */
export const PLAYBACK_SPEEDS = Object.freeze([0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]);

/**
 * Render the right-hand properties panel
 * @param {import('../types.js').EditorState} state - Render-time state (initial values only)
 * @param {import('../ui.js').EditorUIHandlers} handlers
 * @returns {{ element: HTMLElement, cleanups: (() => void)[] }}
 */
export function renderEditorPropertiesPanel(state, handlers) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  // Sidebar
  const sidebar = createElement('div', { className: 'editor-sidebar' });

  // Live source monitor slot (#100 layout v3 / plan 1): docked at the TOP of
  // the right panel — the underused properties column cedes its prime space
  // to a permanently visible monitor. Populated by live-monitor.js while a
  // capture session is live, empty and invisible otherwise.
  sidebar.appendChild(
    createElement('div', { className: 'live-monitor-slot', 'data-live-monitor': 'true' }),
  );

  // Frame tab content (scrolls inside its panel)
  const panelContent = createElement('div', { className: 'panel-content editor-side-frame' });

  // Speed control: the preview plays at this speed and the GIF is exported
  // at it. A clip may carry a speed outside the list (an older default such
  // as 1.25x from Settings): it is offered as well so the select shows it.
  const speedGroup = createElement('div', { className: 'property-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Playback']),
    createElement('div', { className: 'property-row' }, [
      createElement('label', { className: 'property-label', for: 'editor-speed' }, ['Speed']),
    ]),
    createElement('p', { className: 'editor-speed-hint', id: 'editor-speed-hint' }, [
      'The GIF plays at this speed too',
    ]),
  ]);
  const speeds = PLAYBACK_SPEEDS.includes(state.playbackSpeed)
    ? PLAYBACK_SPEEDS
    : [...PLAYBACK_SPEEDS, state.playbackSpeed].sort((a, b) => a - b);
  const speedSelect = /** @type {HTMLSelectElement} */ (
    createElement(
      'select',
      { id: 'editor-speed', 'aria-describedby': 'editor-speed-hint' },
      speeds.map((speed) =>
        createElement('option', { value: String(speed) }, [`${Number(speed.toFixed(2))}×`]),
      ),
    )
  );
  speedSelect.value = String(state.playbackSpeed);
  cleanups.push(on(speedSelect, 'change', () => handlers.onSpeedChange(Number(speedSelect.value))));
  speedGroup.querySelector('.property-row').appendChild(speedSelect);

  // Crop/Aspect ratio controls
  const cropGroup = createElement('div', { className: 'property-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Aspect Ratio']),
  ]);
  const ratioButtons = createElement('div', { className: 'aspect-ratio-buttons' });
  ASPECT_RATIOS.forEach((ratio) => {
    const btn = createElement(
      'button',
      {
        className: `aspect-btn ${(state.selectedAspectRatio || 'free') === ratio ? 'active' : ''}`,
        type: 'button',
        'data-ratio': ratio,
      },
      [ratio === 'free' ? 'Free' : ratio],
    );
    cleanups.push(on(btn, 'click', () => handlers.onAspectRatioChange(ratio)));
    ratioButtons.appendChild(btn);
  });
  cropGroup.appendChild(ratioButtons);
  panelContent.appendChild(cropGroup);

  // Grid toggle
  const gridGroup = createElement('div', { className: 'property-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Overlay']),
    createElement('div', { className: 'property-row' }, [
      createElement('span', { className: 'property-label' }, ['Show Grid']),
    ]),
  ]);
  const gridBtn = createElement(
    'button',
    {
      className: `btn btn-secondary btn-grid-toggle ${state.showGrid ? 'active' : ''}`,
      type: 'button',
      'aria-pressed': String(state.showGrid),
    },
    [state.showGrid ? 'On' : 'Off'],
  );
  cleanups.push(on(gridBtn, 'click', () => handlers.onToggleGrid()));
  gridGroup.querySelector('.property-row').appendChild(gridBtn);

  // Crop info panel (always visible)
  const cropValues = state.cropArea
    ? {
        x: String(Math.round(state.cropArea.x)),
        y: String(Math.round(state.cropArea.y)),
        w: String(Math.round(state.cropArea.width)),
        h: String(Math.round(state.cropArea.height)),
      }
    : { x: '-', y: '-', w: '-', h: '-' };

  const cropInfoGroup = createElement('div', { className: 'property-group crop-info-group' }, [
    createElement('div', { className: 'property-group-title' }, ['Crop Range']),
    createElement('div', { className: 'crop-info-grid' }, [
      createElement('div', { className: 'crop-info-item' }, [
        createElement('span', { className: 'crop-info-label' }, ['X']),
        createElement('span', { className: 'crop-info-value' }, [cropValues.x]),
      ]),
      createElement('div', { className: 'crop-info-item' }, [
        createElement('span', { className: 'crop-info-label' }, ['Y']),
        createElement('span', { className: 'crop-info-value' }, [cropValues.y]),
      ]),
      createElement('div', { className: 'crop-info-item' }, [
        createElement('span', { className: 'crop-info-label' }, ['W']),
        createElement('span', { className: 'crop-info-value' }, [cropValues.w]),
      ]),
      createElement('div', { className: 'crop-info-item' }, [
        createElement('span', { className: 'crop-info-label' }, ['H']),
        createElement('span', { className: 'crop-info-value' }, [cropValues.h]),
      ]),
    ]),
  ]);
  if (state.cropArea) {
    cropInfoGroup.appendChild(createClearCropButton());
  }

  // Frame tab: Aspect (above, adjusted constantly), Playback and the crop
  // values; the grid overlay stays a small collapsible (#100 v3). Native
  // <details> keeps this zero-JS.
  const makeAccordion = (label, node, open = false, id = undefined) => {
    const details = createElement('details', { className: 'prop-accordion', id }, [
      createElement('summary', { className: 'prop-accordion-summary' }, [label]),
      node,
    ]);
    if (open) details.setAttribute('open', '');
    return details;
  };
  panelContent.appendChild(speedGroup);
  panelContent.appendChild(cropInfoGroup);
  panelContent.appendChild(makeAccordion('Overlay', gridGroup));

  // Clip edits: one tab each. Values are applied by updateEditsPanel()
  // after mount and on changes.
  const textPanel = renderTextPanel(handlers);
  cleanups.push(...textPanel.cleanups);

  const backgroundPanel = renderBackgroundPanel(handlers);
  cleanups.push(...backgroundPanel.cleanups);

  /** @type {Record<import('../types.js').SidebarTab, HTMLElement>} */
  const contents = {
    frame: panelContent,
    text: createElement('div', { className: 'panel-content' }, [textPanel.element]),
    background: createElement('div', { className: 'panel-content' }, [backgroundPanel.element]),
  };

  const tablist = createElement('div', {
    className: 'editor-side-tabs',
    role: 'tablist',
    'aria-label': 'Properties',
  });
  for (const tab of SIDEBAR_TABS) {
    const selected = tab === state.sidebarTab;
    const button = createElement(
      'button',
      {
        type: 'button',
        className: 'editor-side-tab',
        role: 'tab',
        id: `editor-side-tab-${tab}`,
        'data-tab': tab,
        'aria-controls': `editor-side-panel-${tab}`,
        'aria-selected': String(selected),
        tabindex: selected ? '0' : '-1',
      },
      [
        createElement('span', { className: 'editor-side-tab-icon' }, [
          createTabIcon(tab),
          ...(tab === 'background'
            ? [
                createElement('span', {
                  className: 'editor-side-tab-badge',
                  id: 'editor-side-tab-badge',
                  'aria-hidden': 'true',
                  hidden: 'true',
                }),
              ]
            : []),
        ]),
        createElement('span', { className: 'editor-side-tab-label' }, [TAB_LABELS[tab]]),
      ],
    );
    tablist.appendChild(button);
  }

  const panels = createElement('div', { className: 'editor-side-panels' });
  for (const tab of SIDEBAR_TABS) {
    const panel = createElement(
      'div',
      {
        className: 'editor-side-panel',
        role: 'tabpanel',
        id: `editor-side-panel-${tab}`,
        'aria-labelledby': `editor-side-tab-${tab}`,
        'data-tab': tab,
        hidden: tab === state.sidebarTab ? undefined : 'true',
      },
      [contents[tab]],
    );
    panels.appendChild(panel);
  }

  /** @param {import('../types.js').SidebarTab} tab */
  const selectTab = (tab) => {
    applySidebarTab(sidebar, tab);
    handlers.onSelectSidebarTab?.(tab);
  };
  cleanups.push(
    on(tablist, 'click', (e) => {
      const target = e.target instanceof Element ? e.target.closest('[role="tab"]') : null;
      if (target instanceof HTMLElement && target.dataset.tab) {
        selectTab(/** @type {import('../types.js').SidebarTab} */ (target.dataset.tab));
      }
    }),
    on(tablist, 'keydown', (e) => {
      const event = /** @type {KeyboardEvent} */ (e);
      const current = event.target instanceof HTMLElement ? event.target.dataset.tab : undefined;
      const index = SIDEBAR_TABS.indexOf(/** @type {any} */ (current));
      if (index === -1 || event.altKey || event.ctrlKey || event.metaKey) return;
      /** @type {number | null} */
      let next = null;
      if (event.key === 'ArrowRight') next = (index + 1) % SIDEBAR_TABS.length;
      else if (event.key === 'ArrowLeft') {
        next = (index - 1 + SIDEBAR_TABS.length) % SIDEBAR_TABS.length;
      } else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = SIDEBAR_TABS.length - 1;
      else if (event.key === ' ' || event.key === 'Enter') next = index;
      if (next === null) return;
      // Consumed: the editor's hotkeys (frame step, play) must not fire too
      event.preventDefault();
      const tab = SIDEBAR_TABS[next];
      selectTab(tab);
      /** @type {HTMLElement | null} */ (tablist.querySelector(`[data-tab="${tab}"]`))?.focus();
    }),
  );

  // Touch up mode: replaces the tabs while the brush is on
  const touchUp = renderTouchUpSection(handlers);
  cleanups.push(...touchUp.cleanups);

  sidebar.appendChild(tablist);
  sidebar.appendChild(panels);
  sidebar.appendChild(touchUp.element);

  // Clear Crop clicks are handled via delegation so the listener survives
  // updateCropInfoPanel() re-creating the button on crop updates (issue #37)
  cleanups.push(
    on(panelContent, 'click', (e) => {
      const target = /** @type {Element | null} */ (e.target);
      if (target instanceof Element && target.closest('.btn-clear-crop')) {
        handlers.onCropChange(null);
      }
    }),
  );

  return { element: sidebar, cleanups };
}

/**
 * Show a tab: its button selected and focusable (roving tabindex), its
 * panel visible, the others hidden
 * @param {ParentNode} root - The sidebar or an ancestor
 * @param {import('../types.js').SidebarTab} tab
 */
export function applySidebarTab(root, tab) {
  for (const button of root.querySelectorAll('.editor-side-tab')) {
    const selected = /** @type {HTMLElement} */ (button).dataset.tab === tab;
    if (button.getAttribute('aria-selected') !== String(selected)) {
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('tabindex', selected ? '0' : '-1');
    }
  }
  for (const panel of root.querySelectorAll('.editor-side-panel')) {
    const el = /** @type {HTMLElement} */ (panel);
    const hidden = el.dataset.tab !== tab;
    if (el.hidden !== hidden) el.hidden = hidden;
  }
}

/**
 * Text of the Background tab's badge: the analysis progress while one
 * runs (so it shows from the other tabs), a dot while removal is on,
 * else nothing
 * @param {import('../types.js').EditorState} state
 * @returns {{ text: string, running: boolean, on: boolean }}
 */
export function getBackgroundTabBadge(state) {
  const on = state.edits?.background?.enabled === true;
  const status = state.aiCutout;
  if (on && state.edits.background.method === 'ai' && status && isAnalysisRunning(status.phase)) {
    const measured = status.phase === 'downloading' || status.phase === 'analyzing';
    const text = measured ? `${Math.round(getAnalysisFraction(status) * 100)}%` : '\u2026';
    return { text, running: true, on };
  }
  return { text: '', running: false, on };
}

/**
 * Apply the state to the sidebar: the chosen tab, the Background tab's
 * badge, and the Touch up mode (tabs hidden, the mode panel shown)
 * @param {ParentNode} container
 * @param {import('../types.js').EditorState} state
 */
export function updateSidebarTabs(container, state) {
  const sidebar = container.querySelector('.editor-side-tabs')?.parentElement;
  if (!sidebar) return;
  applySidebarTab(sidebar, state.sidebarTab);

  const badge = /** @type {HTMLElement | null} */ (sidebar.querySelector('#editor-side-tab-badge'));
  if (badge) {
    const { text, running, on } = getBackgroundTabBadge(state);
    if (badge.textContent !== text) badge.textContent = text;
    badge.hidden = !on;
    badge.classList.toggle('editor-side-tab-badge--running', running);
    const tab = badge.closest('.editor-side-tab');
    const label = running ? `Background (analyzing ${text})` : on ? 'Background (on)' : null;
    if (label) tab?.setAttribute('aria-label', label);
    else tab?.removeAttribute('aria-label');
  }

  // Touch up mode: the brush being on (only while removal is on)
  const touchUp = state.brush?.on === true && state.edits?.background?.enabled === true;
  const tablist = /** @type {HTMLElement | null} */ (sidebar.querySelector('.editor-side-tabs'));
  const panels = /** @type {HTMLElement | null} */ (sidebar.querySelector('.editor-side-panels'));
  if (!tablist || !panels || tablist.hidden === touchUp) return;
  const focused = document.activeElement;
  tablist.hidden = touchUp;
  panels.hidden = touchUp;
  // Also set by updateTouchUpSection; shown here first so focus can move in
  const section = /** @type {HTMLElement | null} */ (sidebar.querySelector('#touchup-section'));
  if (section) section.hidden = !touchUp;
  sidebar.classList.toggle('editor-side--touch-up', touchUp);
  // Focus follows the swap when it was in the part that just hid: into the
  // mode (Done) on entering — also from <body>, where a click on the
  // entry's label leaves it — and back to the entry on leaving. Leaving with
  // focus elsewhere (e.g. Escape over the preview) keeps it there.
  const hiddenPart = touchUp ? panels : section;
  const lost =
    (focused instanceof HTMLElement && Boolean(hiddenPart?.contains(focused))) ||
    (touchUp && (focused === null || focused === document.body));
  if (!lost) return;
  const target = touchUp
    ? sidebar.querySelector('#touchup-done')
    : sidebar.querySelector('#touchup-brush');
  if (target instanceof HTMLElement) target.focus();
}

/**
 * Create the Clear Crop button element
 * Click handling is delegated to the properties panel (renderEditorPropertiesPanel),
 * so no listener is attached here (issue #37).
 * @returns {HTMLElement}
 */
export function createClearCropButton() {
  return createElement(
    'button',
    {
      className: 'btn btn-secondary btn-clear-crop',
      type: 'button',
      style: 'width: 100%; margin-top: var(--space-4);',
    },
    ['Clear Crop'],
  );
}
