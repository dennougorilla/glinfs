/**
 * Loading UI Components
 * @module features/loading/ui
 */

import { createElement } from '../../shared/utils/dom.js';
import { updateStepIndicator } from '../../shared/utils/step-indicator.js';

/**
 * Create spinner SVG icon
 * @returns {SVGElement}
 */
function createSpinnerIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  // Background circle (faded)
  const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bgCircle.setAttribute('cx', '12');
  bgCircle.setAttribute('cy', '12');
  bgCircle.setAttribute('r', '10');
  bgCircle.setAttribute('stroke-opacity', '0.25');
  svg.appendChild(bgCircle);

  // Animated arc
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arc.setAttribute('d', 'M12 2a10 10 0 0 1 10 10');
  arc.setAttribute('stroke-opacity', '1');
  svg.appendChild(arc);

  return svg;
}

/**
 * Render loading screen
 * @param {HTMLElement} container
 * @returns {() => void} Cleanup function
 */
export function renderLoadingScreen(container) {
  // Update step indicator to show Edit step as current
  updateStepIndicator('editor', { hasFrames: true });

  const screen = createElement('div', { className: 'loading-screen screen' });

  const content = createElement('div', { className: 'loading-content' });

  // Spinner
  const spinnerWrapper = createElement('div', { className: 'loading-spinner' });
  spinnerWrapper.appendChild(createSpinnerIcon());
  content.appendChild(spinnerWrapper);

  // Title
  content.appendChild(
    createElement('h2', { className: 'loading-title' }, ['Detecting Scenes...'])
  );

  // Subtitle
  content.appendChild(
    createElement('p', { className: 'loading-subtitle' }, [
      'Analyzing your clip for scene changes',
    ])
  );

  // Progress container
  const progressContainer = createElement('div', { className: 'loading-progress-container' });

  // Progress bar
  const progressBar = createElement('div', { className: 'loading-progress-bar' });
  const progressFill = createElement('div', {
    className: 'loading-progress-fill',
    'data-progress': 'fill',
  });
  progressBar.appendChild(progressFill);
  progressContainer.appendChild(progressBar);

  // Progress text
  progressContainer.appendChild(
    createElement('div', {
      className: 'loading-progress-text',
      'data-progress': 'text',
    }, ['0%'])
  );

  content.appendChild(progressContainer);
  screen.appendChild(content);

  container.innerHTML = '';
  container.appendChild(screen);

  return () => {};
}

/**
 * Update progress display
 * @param {HTMLElement} container
 * @param {number} percent - Progress percentage (0-100)
 */
export function updateProgress(container, percent) {
  const fill = container.querySelector('[data-progress="fill"]');
  const text = container.querySelector('[data-progress="text"]');

  const roundedPercent = Math.round(percent);

  if (fill instanceof HTMLElement) {
    fill.style.width = `${roundedPercent}%`;
  }

  if (text) {
    text.textContent = `${roundedPercent}%`;
  }
}
