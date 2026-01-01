import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../../../src/shared/store.js';

describe('createStore', () => {
  describe('getState', () => {
    it('should return initial state', () => {
      // Arrange
      const initialState = { count: 0, name: 'test' };

      // Act
      const store = createStore(initialState);

      // Assert
      expect(store.getState()).toEqual(initialState);
    });

    it('should return same reference for unchanged state', () => {
      // Arrange
      const initialState = { value: 42 };
      const store = createStore(initialState);

      // Act
      const state1 = store.getState();
      const state2 = store.getState();

      // Assert
      expect(state1).toBe(state2);
    });
  });

  describe('setState', () => {
    it('should update state with partial object', () => {
      // Arrange
      const store = createStore({ count: 0, name: 'test' });

      // Act
      store.setState({ count: 1 });

      // Assert
      expect(store.getState()).toEqual({ count: 1, name: 'test' });
    });

    it('should update state with function', () => {
      // Arrange
      const store = createStore({ count: 0 });

      // Act
      store.setState((state) => ({ ...state, count: state.count + 1 }));

      // Assert
      expect(store.getState().count).toBe(1);
    });

    it('should provide current state to updater function', () => {
      // Arrange
      const store = createStore({ items: ['a', 'b'] });
      const updater = vi.fn((state) => ({ items: [...state.items, 'c'] }));

      // Act
      store.setState(updater);

      // Assert
      expect(updater).toHaveBeenCalledWith({ items: ['a', 'b'] });
      expect(store.getState().items).toEqual(['a', 'b', 'c']);
    });

    it('should skip update when state reference unchanged', () => {
      // Arrange
      const store = createStore({ value: 42 });
      const listener = vi.fn();
      store.subscribe(listener);

      // Act - return same state reference
      store.setState((state) => state);

      // Assert - listener not called
      expect(listener).not.toHaveBeenCalled();
    });

    it('should create new state object with spread', () => {
      // Arrange
      const initialState = { a: 1, b: 2 };
      const store = createStore(initialState);

      // Act
      store.setState({ a: 10 });

      // Assert - new object created
      expect(store.getState()).not.toBe(initialState);
      expect(store.getState()).toEqual({ a: 10, b: 2 });
    });
  });

  describe('subscribe', () => {
    it('should call listener on state change', () => {
      // Arrange
      const store = createStore({ count: 0 });
      const listener = vi.fn();
      store.subscribe(listener);

      // Act
      store.setState({ count: 1 });

      // Assert
      expect(listener).toHaveBeenCalledOnce();
    });

    it('should provide current and previous state to listener', () => {
      // Arrange
      const store = createStore({ count: 0 });
      const listener = vi.fn();
      store.subscribe(listener);

      // Act
      store.setState({ count: 5 });

      // Assert
      expect(listener).toHaveBeenCalledWith(
        { count: 5 },  // current state
        { count: 0 }   // previous state
      );
    });

    it('should call multiple listeners', () => {
      // Arrange
      const store = createStore({ value: 'initial' });
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      store.subscribe(listener1);
      store.subscribe(listener2);

      // Act
      store.setState({ value: 'updated' });

      // Assert
      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it('should return unsubscribe function', () => {
      // Arrange
      const store = createStore({ count: 0 });
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);

      // Act
      store.setState({ count: 1 });
      unsubscribe();
      store.setState({ count: 2 });

      // Assert - listener called only once (before unsubscribe)
      expect(listener).toHaveBeenCalledOnce();
    });

    it('should not affect other listeners when one unsubscribes', () => {
      // Arrange
      const store = createStore({ count: 0 });
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = store.subscribe(listener1);
      store.subscribe(listener2);

      // Act
      store.setState({ count: 1 });
      unsub1();
      store.setState({ count: 2 });

      // Assert
      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledTimes(2);
    });
  });

  describe('immutability', () => {
    it('should not mutate original state', () => {
      // Arrange
      const initialState = { nested: { value: 1 } };
      const store = createStore(initialState);

      // Act
      store.setState({ nested: { value: 2 } });

      // Assert - original unchanged
      expect(initialState.nested.value).toBe(1);
    });

    it('should preserve unmodified properties', () => {
      // Arrange
      const store = createStore({
        unchanged: 'preserved',
        changed: 'original',
      });

      // Act
      store.setState({ changed: 'updated' });

      // Assert
      expect(store.getState().unchanged).toBe('preserved');
      expect(store.getState().changed).toBe('updated');
    });
  });

  describe('edge cases', () => {
    it('should handle null initial state', () => {
      // Arrange & Act
      const store = createStore(null);

      // Assert
      expect(store.getState()).toBeNull();
    });

    it('should handle empty object initial state', () => {
      // Arrange
      const store = createStore({});

      // Act
      store.setState({ newProp: 'value' });

      // Assert
      expect(store.getState()).toEqual({ newProp: 'value' });
    });

    it('should handle array state', () => {
      // Arrange
      const store = createStore([1, 2, 3]);

      // Act - use function updater for arrays
      store.setState((state) => [...state, 4]);

      // Assert
      expect(store.getState()).toEqual([1, 2, 3, 4]);
    });

    it('should work with boolean state values', () => {
      // Arrange
      const store = createStore({ enabled: false });

      // Act
      store.setState({ enabled: true });

      // Assert
      expect(store.getState().enabled).toBe(true);
    });
  });
});
