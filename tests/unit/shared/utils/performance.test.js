import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce, throttle } from '../../../../src/shared/utils/performance.js';

describe('throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls fn immediately on the leading edge', () => {
    // Arrange
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    // Act
    throttled('a');

    // Assert
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('schedules a trailing call and invokes it with the latest args, not the stale args from when it was scheduled', () => {
    // Arrange
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    // Act
    throttled('a'); // leading call fires immediately
    throttled('b'); // inside the window, schedules a trailing call
    throttled('c'); // still inside the window, updates latestArgs but does not reschedule
    expect(fn).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(100);

    // Assert
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('c');
  });

  it('does not invoke a trailing call if no extra calls occurred inside the window', () => {
    // Arrange
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    // Act
    throttled('a');
    vi.advanceTimersByTime(100);

    // Assert - only the leading call happened, no trailing call was scheduled
    expect(fn).toHaveBeenCalledOnce();
  });

  it('fires immediately again (new leading call) once the interval has fully elapsed', () => {
    // Arrange
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    // Act
    throttled('a');
    vi.advanceTimersByTime(150);
    throttled('b');

    // Assert
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'a');
    expect(fn).toHaveBeenNthCalledWith(2, 'b');
  });

  it('cancel() suppresses the pending trailing call', () => {
    // Arrange
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    // Act
    throttled('a'); // leading call
    throttled('b'); // schedules trailing call
    throttled.cancel();
    vi.advanceTimersByTime(200);

    // Assert - trailing call never fires
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('cancel() is safe to call when nothing is pending', () => {
    // Arrange
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    // Act & Assert
    expect(() => throttled.cancel()).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('allows a new trailing call to be scheduled after cancel()', () => {
    // Arrange
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    // Act
    throttled('a'); // leading
    throttled('b'); // scheduled trailing
    throttled.cancel(); // suppressed
    vi.advanceTimersByTime(150); // interval elapses with nothing pending
    throttled('c'); // new leading call

    // Assert
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'a');
    expect(fn).toHaveBeenNthCalledWith(2, 'c');
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays invoking fn until after ms have elapsed', () => {
    // Arrange
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    // Act
    debounced('a');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    // Assert
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('resets the delay on repeated calls and uses the latest args', () => {
    // Arrange
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    // Act
    debounced('a');
    vi.advanceTimersByTime(50);
    debounced('b'); // resets the 100ms window
    vi.advanceTimersByTime(50);

    // Assert - only 50ms have passed since the last call, so fn hasn't fired yet
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('invokes fn again on a subsequent call after the delay has elapsed', () => {
    // Arrange
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    // Act
    debounced('a');
    vi.advanceTimersByTime(100);
    debounced('b');
    vi.advanceTimersByTime(100);

    // Assert
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'a');
    expect(fn).toHaveBeenNthCalledWith(2, 'b');
  });

  it('does not expose a cancel method (unlike throttle)', () => {
    // Arrange & Act
    const debounced = debounce(vi.fn(), 100);

    // Assert
    expect(debounced.cancel).toBeUndefined();
  });
});
