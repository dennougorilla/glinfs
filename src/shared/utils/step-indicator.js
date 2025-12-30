/**
 * Step Indicator Utility
 * Unified logic for updating the step indicator across all screens.
 * @module shared/utils/step-indicator
 */

/**
 * @typedef {'capture' | 'editor' | 'export'} StepName
 */

/**
 * @typedef {Object} StepContext
 * @property {boolean} [hasFrames] - Whether captured frames exist (for capture screen)
 */

/**
 * Update step indicator in the header
 *
 * Step state logic:
 * - Capture: active when on capture, completed when on editor/export
 * - Editor: active when on editor, completed when on export, disabled if no frames (on capture)
 * - Export: active when on export, disabled otherwise
 *
 * @param {StepName} currentStep - The current active step
 * @param {StepContext} [context={}] - Optional context for conditional states
 */
export function updateStepIndicator(currentStep, context = {}) {
  const { hasFrames = false } = context;

  const steps = document.querySelectorAll('.step-indicator .step');
  const connectors = document.querySelectorAll('.step-indicator .step-connector');

  steps.forEach((step) => {
    const stepName = step.getAttribute('data-step');
    step.classList.remove('step--active', 'step--completed', 'step--disabled');

    if (stepName === currentStep) {
      step.classList.add('step--active');
    } else if (stepName === 'capture') {
      // Capture is completed if we're on editor or export
      if (currentStep === 'editor' || currentStep === 'export') {
        step.classList.add('step--completed');
      }
    } else if (stepName === 'editor') {
      // Editor is completed if we're on export, disabled if no frames (on capture)
      if (currentStep === 'export') {
        step.classList.add('step--completed');
      } else if (currentStep === 'capture' && !hasFrames) {
        step.classList.add('step--disabled');
      }
    } else if (stepName === 'export') {
      // Export is always disabled unless we're on export
      if (currentStep !== 'export') {
        step.classList.add('step--disabled');
      }
    }
  });

  // Update connectors based on progress
  connectors.forEach((connector, index) => {
    connector.classList.remove('step-connector--completed');

    // First connector (capture -> editor): completed when on editor or export
    if (index === 0 && (currentStep === 'editor' || currentStep === 'export')) {
      connector.classList.add('step-connector--completed');
    }
    // Second connector (editor -> export): completed when on export
    if (index === 1 && currentStep === 'export') {
      connector.classList.add('step-connector--completed');
    }
  });
}
