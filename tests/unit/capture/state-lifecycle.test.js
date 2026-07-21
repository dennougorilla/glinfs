import { describe, expect, it } from 'vitest';
import {
  initCaptureState,
  startCapture,
  stopCapture,
} from '../../../src/features/capture/state.js';

describe('initCaptureState', () => {
  it('should initialize with capture stopped and no stream', () => {
    // Act
    const state = initCaptureState();

    // Assert
    expect(state.isCapturing).toBe(false);
    expect(state.isSharing).toBe(false);
    expect(state.isPaused).toBe(false);
    expect(state.stream).toBe(null);
    expect(state.error).toBe(null);
  });
});

describe('startCapture', () => {
  it('should set isCapturing and isSharing and store the stream', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const initialState = initCaptureState();

    // Act
    const capturingState = startCapture(initialState, mockStream);

    // Assert
    expect(capturingState.isCapturing).toBe(true);
    expect(capturingState.isSharing).toBe(true);
    expect(capturingState.stream).toBe(mockStream);
  });

  it('should clear a previous error', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const stateWithError = { ...initCaptureState(), error: 'previous failure' };

    // Act
    const capturingState = startCapture(stateWithError, mockStream);

    // Assert
    expect(capturingState.error).toBe(null);
  });

  it('should not mutate the previous state', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const initialState = initCaptureState();

    // Act
    const capturingState = startCapture(initialState, mockStream);

    // Assert
    expect(capturingState).not.toBe(initialState);
    expect(initialState.isCapturing).toBe(false);
    expect(initialState.stream).toBe(null);
  });
});

describe('stopCapture', () => {
  it('should clear capture flags and release the stream reference', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const capturingState = startCapture(initCaptureState(), mockStream);

    // Act
    const stoppedState = stopCapture(capturingState);

    // Assert
    expect(stoppedState.isCapturing).toBe(false);
    expect(stoppedState.isSharing).toBe(false);
    expect(stoppedState.isPaused).toBe(false);
    expect(stoppedState.stream).toBe(null);
  });

  it('should not mutate the previous state', () => {
    // Arrange
    const mockStream = { id: 'test-stream' };
    const capturingState = startCapture(initCaptureState(), mockStream);

    // Act
    const stoppedState = stopCapture(capturingState);

    // Assert
    expect(stoppedState).not.toBe(capturingState);
    expect(capturingState.isCapturing).toBe(true);
    expect(capturingState.stream).toBe(mockStream);
  });
});
