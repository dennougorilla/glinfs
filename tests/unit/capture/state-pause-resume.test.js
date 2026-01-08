import { describe, it, expect } from 'vitest';
import {
  initCaptureState,
  pauseCapture,
  resumeCapture,
  startCapture,
  stopCapture,
} from '../../../src/features/capture/state.js';

describe('pauseCapture', () => {
  it('should set isPaused to true and isCapturing to false', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const initialState = initCaptureState();
    const capturingState = startCapture(initialState, mockStream);

    // Act
    const pausedState = pauseCapture(capturingState);

    // Assert
    expect(pausedState.isPaused).toBe(true);
    expect(pausedState.isCapturing).toBe(false);
  });

  it('should preserve stream and isSharing when paused', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const initialState = initCaptureState();
    const capturingState = startCapture(initialState, mockStream);

    // Act
    const pausedState = pauseCapture(capturingState);

    // Assert
    expect(pausedState.stream).toBe(mockStream);
    expect(pausedState.isSharing).toBe(true);
  });

  it('should preserve buffer when paused', () => {
    // Arrange
    const initialState = initCaptureState();
    const stateWithBuffer = {
      ...initialState,
      buffer: { ...initialState.buffer, size: 10 },
    };

    // Act
    const pausedState = pauseCapture(stateWithBuffer);

    // Assert
    expect(pausedState.buffer.size).toBe(10);
  });
});

describe('resumeCapture', () => {
  it('should set isCapturing to true and isPaused to false', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const initialState = initCaptureState();
    const capturingState = startCapture(initialState, mockStream);
    const pausedState = pauseCapture(capturingState);

    // Act
    const resumedState = resumeCapture(pausedState);

    // Assert
    expect(resumedState.isCapturing).toBe(true);
    expect(resumedState.isPaused).toBe(false);
  });

  it('should preserve stream when resuming', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const initialState = initCaptureState();
    const capturingState = startCapture(initialState, mockStream);
    const pausedState = pauseCapture(capturingState);

    // Act
    const resumedState = resumeCapture(pausedState);

    // Assert
    expect(resumedState.stream).toBe(mockStream);
  });

  it('should preserve buffer when resuming', () => {
    // Arrange
    const initialState = initCaptureState();
    const stateWithBuffer = {
      ...initialState,
      buffer: { ...initialState.buffer, size: 10 },
      isPaused: true,
    };

    // Act
    const resumedState = resumeCapture(stateWithBuffer);

    // Assert
    expect(resumedState.buffer.size).toBe(10);
  });
});

describe('pause/resume workflow', () => {
  it('should complete full pause/resume cycle', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const initialState = initCaptureState();

    // Act & Assert - full cycle
    const started = startCapture(initialState, mockStream);
    expect(started.isCapturing).toBe(true);
    expect(started.isPaused).toBe(false);
    expect(started.stream).toBe(mockStream);

    const paused = pauseCapture(started);
    expect(paused.isCapturing).toBe(false);
    expect(paused.isPaused).toBe(true);
    expect(paused.stream).toBe(mockStream);

    const resumed = resumeCapture(paused);
    expect(resumed.isCapturing).toBe(true);
    expect(resumed.isPaused).toBe(false);
    expect(resumed.stream).toBe(mockStream);
  });

  it('stopCapture should clear isPaused', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const initialState = initCaptureState();
    const capturingState = startCapture(initialState, mockStream);
    const pausedState = pauseCapture(capturingState);

    // Act
    const stoppedState = stopCapture(pausedState);

    // Assert
    expect(stoppedState.isPaused).toBe(false);
    expect(stoppedState.isCapturing).toBe(false);
    expect(stoppedState.stream).toBe(null);
  });
});

describe('initCaptureState', () => {
  it('should initialize with isPaused false', () => {
    // Act
    const state = initCaptureState();

    // Assert
    expect(state.isPaused).toBe(false);
  });
});
