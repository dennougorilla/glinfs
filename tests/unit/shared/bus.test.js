import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emit, on, once, offAll, bus } from '../../../src/shared/bus.js';

describe('Event Bus', () => {
  beforeEach(() => {
    // Clear all listeners between tests by removing known events
    offAll('test:event');
    offAll('test:other');
    offAll('test:once');
    offAll('test:error');
  });

  describe('emit', () => {
    it('should call registered handlers with payload', () => {
      // Arrange
      const handler = vi.fn();
      on('test:event', handler);
      const payload = { data: 'test' };

      // Act
      emit('test:event', payload);

      // Assert
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('should call multiple handlers for same event', () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      on('test:event', handler1);
      on('test:event', handler2);

      // Act
      emit('test:event', { value: 42 });

      // Assert
      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('should not throw when emitting to non-existent event', () => {
      // Act & Assert
      expect(() => emit('nonexistent:event', {})).not.toThrow();
    });

    it('should handle handler errors gracefully', () => {
      // Arrange
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler error');
      });
      const normalHandler = vi.fn();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      on('test:error', errorHandler);
      on('test:error', normalHandler);

      // Act
      emit('test:error', {});

      // Assert - both handlers called, error logged
      expect(errorHandler).toHaveBeenCalled();
      expect(normalHandler).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error in event handler'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('should work without payload', () => {
      // Arrange
      const handler = vi.fn();
      on('test:event', handler);

      // Act
      emit('test:event');

      // Assert
      expect(handler).toHaveBeenCalledWith(undefined);
    });
  });

  describe('on', () => {
    it('should return unsubscribe function', () => {
      // Arrange
      const handler = vi.fn();
      const unsubscribe = on('test:event', handler);

      // Act - emit, unsubscribe, emit again
      emit('test:event', {});
      unsubscribe();
      emit('test:event', {});

      // Assert - handler called only once
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should handle multiple subscriptions to same event', () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      // Act
      const unsub1 = on('test:event', handler1);
      const _unsub2 = on('test:event', handler2);

      emit('test:event', {});
      unsub1();
      emit('test:event', {});

      // Assert
      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledTimes(2);
    });

    it('should create listener set for new events', () => {
      // Arrange
      const handler = vi.fn();

      // Act
      on('test:new', handler);
      emit('test:new', { created: true });

      // Assert
      expect(handler).toHaveBeenCalledWith({ created: true });

      // Cleanup
      offAll('test:new');
    });
  });

  describe('once', () => {
    it('should call handler only once', () => {
      // Arrange
      const handler = vi.fn();
      once('test:once', handler);

      // Act
      emit('test:once', { first: true });
      emit('test:once', { second: true });

      // Assert
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ first: true });
    });

    it('should remove handler after first call', () => {
      // Arrange
      const handler = vi.fn();
      once('test:once', handler);

      // Act
      emit('test:once', {});

      // Additional emits should not reach handler
      emit('test:once', {});
      emit('test:once', {});

      // Assert
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('offAll', () => {
    it('should remove all listeners for event', () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      on('test:event', handler1);
      on('test:event', handler2);

      // Act
      offAll('test:event');
      emit('test:event', {});

      // Assert
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should not affect other events', () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      on('test:event', handler1);
      on('test:other', handler2);

      // Act
      offAll('test:event');
      emit('test:event', {});
      emit('test:other', {});

      // Assert
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should handle non-existent events gracefully', () => {
      // Act & Assert
      expect(() => offAll('nonexistent:event')).not.toThrow();
    });
  });

  describe('bus object', () => {
    it('should expose emit, on, once, and off functions', () => {
      expect(typeof bus.emit).toBe('function');
      expect(typeof bus.on).toBe('function');
      expect(typeof bus.once).toBe('function');
      expect(typeof bus.off).toBe('function');
    });

    it('should work with bus.off (alias for offAll)', () => {
      // Arrange
      const handler = vi.fn();
      bus.on('test:event', handler);

      // Act
      bus.off('test:event');
      bus.emit('test:event', {});

      // Assert
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
