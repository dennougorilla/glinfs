import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countHotkeys,
  isComposingEvent,
  isEditableTarget,
  registerHotkey,
} from '../../../src/shared/hotkeys.js';

/**
 * #102: the single document-level hotkey dispatcher — scope precedence,
 * the shared editable-target guard, modifier matching, defaultPrevented,
 * modal-scope exclusivity, and unsubscribe hygiene.
 */

/** @type {(() => void)[]} */
let unsubscribers = [];

/** @param {import('../../../src/shared/hotkeys.js').HotkeyOptions} options */
function register(options) {
  const unsubscribe = registerHotkey(options);
  unsubscribers.push(unsubscribe);
  return unsubscribe;
}

/**
 * @param {KeyboardEventInit} init
 * @param {EventTarget} [target]
 */
function press(init, target = document) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  unsubscribers = [];
  document.body.innerHTML = '';
});

afterEach(() => {
  unsubscribers.forEach((fn) => {
    fn();
  });
  document.body.innerHTML = '';
  expect(countHotkeys()).toBe(0);
});

describe('scope precedence', () => {
  it('orders modal > overlay > route > global, first match wins', () => {
    const calls = [];
    for (const scope of /** @type {const} */ (['global', 'route', 'overlay', 'modal'])) {
      register({ key: 'Escape', scope, handler: () => calls.push(scope) });
    }

    press({ key: 'Escape' });

    expect(calls).toEqual(['modal']);
  });

  it('falls through to a lower scope once the higher one unsubscribes', () => {
    const calls = [];
    register({ key: 'Escape', scope: 'route', handler: () => calls.push('route') });
    const closeOverlay = register({
      key: 'Escape',
      scope: 'overlay',
      handler: () => calls.push('overlay'),
    });

    press({ key: 'Escape' });
    closeOverlay();
    press({ key: 'Escape' });

    expect(calls).toEqual(['overlay', 'route']);
  });

  it('lets a handler decline with false so a lower scope can act', () => {
    const route = vi.fn(() => false);
    const global = vi.fn();
    register({ key: 'x', scope: 'route', handler: route });
    register({ key: 'x', scope: 'global', handler: global });

    press({ key: 'x' });

    expect(route).toHaveBeenCalledOnce();
    expect(global).toHaveBeenCalledOnce();
  });

  it('tries the most recent registration first within a scope', () => {
    const calls = [];
    register({ key: 'x', scope: 'route', handler: () => calls.push('first') });
    register({ key: 'x', scope: 'route', handler: () => calls.push('second') });

    press({ key: 'x' });

    expect(calls).toEqual(['second']);
  });

  it('only routes matching keys; other keys reach lower scopes', () => {
    const overlay = vi.fn();
    const route = vi.fn();
    register({ key: 'Escape', scope: 'overlay', handler: overlay });
    register({ key: 'f', scope: 'route', handler: route });

    press({ key: 'f' });

    expect(overlay).not.toHaveBeenCalled();
    expect(route).toHaveBeenCalledOnce();
  });

  it('rejects unknown scopes and entries without a key or code', () => {
    expect(() =>
      registerHotkey(/** @type {any} */ ({ key: 'x', scope: 'nope', handler: () => {} })),
    ).toThrow(/scope/);
    expect(() => registerHotkey({ scope: 'route', handler: () => {} })).toThrow(/key or a code/);
  });
});

describe('modal exclusivity (the frame grid registers modal-scope keys)', () => {
  it('skips overlay and route scopes while a modal hotkey is registered', () => {
    const overlay = vi.fn();
    const route = vi.fn();
    register({ key: 'Escape', scope: 'overlay', handler: overlay });
    register({ key: 'Delete', scope: 'route', handler: route });

    // The modal owns neither key, yet the page below must not see them
    const closeModal = register({ key: 'Enter', scope: 'modal', handler: () => {} });
    press({ key: 'Escape' });
    press({ key: 'Delete' });
    expect(overlay).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();

    closeModal();
    press({ key: 'Escape' });
    press({ key: 'Delete' });
    expect(overlay).toHaveBeenCalledOnce();
    expect(route).toHaveBeenCalledOnce();
  });

  it('keeps the global scope live', () => {
    const global = vi.fn();
    register({ key: 'c', modifiers: { shift: true }, scope: 'global', handler: global });
    register({ key: 'Escape', scope: 'modal', handler: () => {} });

    press({ key: 'C', shiftKey: true });

    expect(global).toHaveBeenCalledOnce();
  });

  it('does not let a modal handler that closes the modal leak the key below', () => {
    const route = vi.fn();
    register({ key: 'Escape', scope: 'route', handler: route });
    const closeModal = register({
      key: 'Escape',
      scope: 'modal',
      handler: () => {
        closeModal();
        return false;
      },
    });

    press({ key: 'Escape' });

    expect(route).not.toHaveBeenCalled();
  });

  it('no longer yields to an unregistered aria-modal element', () => {
    const route = vi.fn();
    register({ key: ' ', scope: 'route', handler: route });
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    press({ key: ' ' });

    expect(route).toHaveBeenCalledOnce();
  });
});

describe('editable-target guard', () => {
  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    ['select', () => document.createElement('select')],
    [
      'contenteditable',
      () => {
        const el = document.createElement('div');
        el.setAttribute('contenteditable', 'true');
        el.tabIndex = 0;
        return el;
      },
    ],
  ])('suppresses hotkeys while %s has focus', (_name, create) => {
    const handler = vi.fn();
    register({ key: 'g', scope: 'route', handler });
    const el = create();
    document.body.appendChild(el);
    el.focus();
    expect(document.activeElement).toBe(el);

    // Both shapes: test-style dispatch on document, and a real event whose
    // target is the focused element
    press({ key: 'g' });
    press({ key: 'g' }, el);

    expect(handler).not.toHaveBeenCalled();
  });

  it('covers descendants of a contenteditable host', () => {
    const host = document.createElement('div');
    host.setAttribute('contenteditable', '');
    const child = document.createElement('span');
    host.appendChild(child);
    document.body.appendChild(host);

    expect(isEditableTarget(child)).toBe(true);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('honours isContentEditable (browsers) as well as the attribute', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'isContentEditable', { value: true });
    expect(isEditableTarget(el)).toBe(true);
  });

  it('fires hotkeys that opt in with allowInEditable', () => {
    const handler = vi.fn();
    register({ key: 'Escape', scope: 'overlay', allowInEditable: true, handler });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    press({ key: 'Escape' }, input);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('lets an opted-in lower scope act while a guarded higher one is skipped', () => {
    const overlay = vi.fn();
    const global = vi.fn();
    register({ key: 'Escape', scope: 'overlay', handler: overlay });
    register({ key: 'Escape', scope: 'global', allowInEditable: true, handler: global });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    press({ key: 'Escape' }, input);

    expect(overlay).not.toHaveBeenCalled();
    expect(global).toHaveBeenCalledOnce();
  });
});

describe('defaultPrevented', () => {
  it('ignores an event an earlier listener already consumed', () => {
    const handler = vi.fn();
    register({ key: 'Escape', scope: 'route', handler });
    const consume = (/** @type {Event} */ e) => e.preventDefault();
    document.addEventListener('keydown', consume, true);
    try {
      press({ key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', consume, true);
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores an event consumed by an element-level handler (bubble order)', () => {
    const handler = vi.fn();
    register({ key: 'ArrowLeft', scope: 'route', handler });
    const el = document.createElement('div');
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => e.preventDefault());
    document.body.appendChild(el);

    press({ key: 'ArrowLeft' }, el);

    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves preventDefault to the handler', () => {
    register({ key: 'x', scope: 'route', handler: () => {} });
    register({ key: 'y', scope: 'route', handler: (e) => e.preventDefault() });

    expect(press({ key: 'x' }).defaultPrevented).toBe(false);
    expect(press({ key: 'y' }).defaultPrevented).toBe(true);
  });
});

describe('IME composition guard', () => {
  const composing = [
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ];

  it.each(composing)('never fires a hotkey for a %s keystroke', (_label, init) => {
    const route = vi.fn();
    const overlay = vi.fn();
    register({ key: 'Escape', scope: 'route', handler: route });
    register({ key: 'Escape', scope: 'overlay', allowInEditable: true, handler: overlay });

    const e = press({ key: 'Escape', ...init });

    expect(route).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it.each(composing)('also skips allowInEditable hotkeys inside a field (%s)', (_label, init) => {
    const handler = vi.fn();
    register({ key: 'Escape', scope: 'overlay', allowInEditable: true, handler });
    const input = document.createElement('input');
    document.body.appendChild(input);

    press({ key: 'Escape', ...init }, input);

    expect(handler).not.toHaveBeenCalled();
  });

  it('fires normally once composition ends', () => {
    const handler = vi.fn();
    register({ key: 'Escape', scope: 'route', handler });

    press({ key: 'Escape', isComposing: false, keyCode: 27 });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('isComposingEvent reads both markers', () => {
    const make = (/** @type {KeyboardEventInit} */ init) => new KeyboardEvent('keydown', init);
    expect(isComposingEvent(make({ key: 'a', isComposing: true }))).toBe(true);
    expect(isComposingEvent(make({ key: 'Process', keyCode: 229 }))).toBe(true);
    expect(isComposingEvent(make({ key: 'Escape', keyCode: 27 }))).toBe(false);
  });
});

describe('modifier matching', () => {
  it('requires Ctrl/Meta/Alt to match exactly so browser shortcuts pass through', () => {
    const handler = vi.fn();
    register({ key: 'f', modifiers: { shift: 'any' }, scope: 'route', handler });

    press({ key: 'f', metaKey: true }); // Cmd+F: browser find
    press({ key: 'f', ctrlKey: true }); // Ctrl+F: browser find
    press({ key: 'f', altKey: true });
    expect(handler).not.toHaveBeenCalled();

    press({ key: 'f' });
    press({ key: 'F', shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('treats Shift as exact unless the hotkey says any', () => {
    const plain = vi.fn();
    const shifted = vi.fn();
    register({ key: 'a', scope: 'route', handler: plain });
    register({ key: 'b', modifiers: { shift: true }, scope: 'route', handler: shifted });

    press({ key: 'A', shiftKey: true });
    press({ key: 'b' });
    expect(plain).not.toHaveBeenCalled();
    expect(shifted).not.toHaveBeenCalled();

    press({ key: 'a' });
    press({ key: 'B', shiftKey: true });
    expect(plain).toHaveBeenCalledOnce();
    expect(shifted).toHaveBeenCalledOnce();
  });

  it('matches a required modifier (Ctrl+E) and not its neighbours', () => {
    const handler = vi.fn();
    register({ key: 'e', modifiers: { ctrl: true }, scope: 'route', handler });

    press({ key: 'e' });
    press({ key: 'e', metaKey: true });
    press({ key: 'E', ctrlKey: true, shiftKey: true });
    expect(handler).not.toHaveBeenCalled();

    press({ key: 'e', ctrlKey: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('matches by code for layout-independent keys (Shift+1 is "!" on US)', () => {
    const handler = vi.fn();
    register({ code: 'Digit1', modifiers: { shift: 'any' }, scope: 'route', handler });

    press({ key: '!', code: 'Digit1', shiftKey: true });
    press({ key: '1', code: 'Digit1' });
    press({ key: '1', code: 'Numpad1' });

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('unsubscribe', () => {
  it('stops delivery and is idempotent', () => {
    const handler = vi.fn();
    const unsubscribe = registerHotkey({ key: 'x', scope: 'route', handler });
    expect(countHotkeys('route')).toBe(1);

    unsubscribe();
    unsubscribe();
    press({ key: 'x' });

    expect(handler).not.toHaveBeenCalled();
    expect(countHotkeys()).toBe(0);
  });

  it('removes the document listener when the registry empties', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    try {
      const a = registerHotkey({ key: 'x', scope: 'route', handler: () => {} });
      const b = registerHotkey({ key: 'y', scope: 'global', handler: () => {} });
      expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);

      a();
      expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
      b();
      expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it('tolerates a handler unsubscribing itself mid-dispatch', () => {
    const calls = [];
    /** @type {() => void} */
    let close = () => {};
    close = register({
      key: 'Escape',
      scope: 'overlay',
      handler: () => {
        calls.push('overlay');
        close();
      },
    });
    register({ key: 'Escape', scope: 'route', handler: () => calls.push('route') });

    press({ key: 'Escape' });
    press({ key: 'Escape' });

    expect(calls).toEqual(['overlay', 'route']);
  });
});
