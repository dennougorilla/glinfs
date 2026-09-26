/**
 * Step Indicator Utility
 * Unified logic for updating the step indicator across all screens.
 *
 * The flow has two steps, Capture → Edit. Exporting is an action of the
 * editor (its Export button opens the Export GIF dialog over it), so there
 * is no Export step to navigate to.
 * @module shared/utils/step-indicator
 */

/**
 * @typedef {'capture' | 'editor'} StepName
 */

/**
 * @typedef {Object} StepContext
 * @property {boolean} [hasFrames] - Whether captured frames exist (for capture screen)
 * @property {boolean} [isCapturing] - Whether a screen capture session is running in the
 *   background (i.e. active but on a route other than /capture). Surfaced as a pulsing
 *   dot on the Capture step so background recording isn't invisible while editing.
 */

/**
 * Update step indicator in the header
 *
 * Step state logic:
 * - Capture: active when on capture, completed when on editor
 * - Editor: active when on editor, disabled if no frames (on capture)
 *
 * @param {StepName} currentStep - The current active step
 * @param {StepContext} [context={}] - Optional context for conditional states
 */
export function updateStepIndicator(currentStep, context = {}) {
  const { hasFrames = false, isCapturing = false } = context;

  const steps = document.querySelectorAll('.step-indicator .step');
  const connectors = document.querySelectorAll('.step-indicator .step-connector');

  steps.forEach((step) => {
    const stepName = step.getAttribute('data-step');
    step.classList.remove('step--active', 'step--completed', 'step--disabled', 'step--live');

    // Background recording indicator: only meaningful for the Capture step,
    // and only while we're actually away from it (on /capture the recording
    // UI itself already shows this).
    if (stepName === 'capture' && isCapturing && currentStep !== 'capture') {
      step.classList.add('step--live');
    }

    if (stepName === currentStep) {
      step.classList.add('step--active');
    } else if (stepName === 'capture') {
      // Capture is completed once we're editing
      if (currentStep === 'editor') {
        step.classList.add('step--completed');
      }
    } else if (stepName === 'editor') {
      // Editor is disabled on capture until frames exist
      if (currentStep === 'capture' && !hasFrames) {
        step.classList.add('step--disabled');
      }
    }
  });

  // The capture -> editor connector is completed while editing
  connectors.forEach((connector, index) => {
    connector.classList.toggle(
      'step-connector--completed',
      index === 0 && currentStep === 'editor',
    );
  });
}
