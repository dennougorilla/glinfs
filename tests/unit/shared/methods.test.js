import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMethod,
  getMethodOverride,
  getStoredMethods,
  listMethods,
  METHODS,
  parseMethodOverrides,
  registerMethod,
  setMethod,
  setMethodOverridesFromSearch,
  unregisterMethod,
  validateMethodEntry,
} from '../../../src/shared/methods.js';
import {
  loadSettings,
  onSettingsChange,
  resetSettings,
} from '../../../src/shared/user-settings.js';

const STORAGE_KEY = 'glinfs_user_settings';

/** @returns {import('../../../src/shared/methods.js').MethodEntry} */
const entry = (overrides = {}) => ({
  id: 'test.detector',
  area: 'scenes',
  name: 'Scene detection',
  options: [
    { id: 'fixed', name: 'Fixed threshold' },
    { id: 'adaptive', name: 'Adaptive' },
  ],
  default: 'fixed',
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  setMethodOverridesFromSearch('');
  registerMethod(entry());
});

afterEach(() => {
  unregisterMethod('test.detector');
  unregisterMethod('test.second');
  unregisterMethod('test.capture');
});

describe('the registry', () => {
  it('ships only well-formed entries with distinct ids', () => {
    for (const e of METHODS) expect(() => validateMethodEntry(e)).not.toThrow();
  });

  it.each([
    ['no id', { id: '' }],
    ['an unknown area', { area: 'kitchen' }],
    ['no name', { name: '' }],
    ['one option', { options: [{ id: 'fixed', name: 'Fixed threshold' }] }],
    [
      'duplicate option ids',
      {
        options: [
          { id: 'a', name: 'A' },
          { id: 'a', name: 'B' },
        ],
        default: 'a',
      },
    ],
    [
      'an option without a name',
      {
        options: [
          { id: 'fixed', name: 'Fixed' },
          { id: 'b', name: '' },
        ],
      },
    ],
    ['a default that is not an option', { default: 'magic' }],
  ])('rejects an entry with %s', (_label, overrides) => {
    expect(() => validateMethodEntry(entry({ id: 'test.second', ...overrides }))).toThrow();
  });

  it('rejects an id that is already registered', () => {
    expect(() => registerMethod(entry())).toThrow(/already registered/);
  });

  it('lists entries by area, the default option first', () => {
    registerMethod(
      entry({
        id: 'test.second',
        area: 'export',
        options: [
          { id: 'on', name: 'On' },
          { id: 'off', name: 'Off' },
        ],
        default: 'off',
      }),
    );
    registerMethod(entry({ id: 'test.capture', area: 'capture' }));
    const listed = listMethods().filter((e) => e.id.startsWith('test.'));
    expect(listed.map((e) => e.id)).toEqual(['test.capture', 'test.detector', 'test.second']);
    expect(listed[2].options.map((o) => o.id)).toEqual(['off', 'on']);
  });

  it('throws for an id that is not registered', () => {
    expect(() => getMethod('nope')).toThrow(/Unknown method/);
  });
});

describe('stored choices', () => {
  it('is the default when nothing is stored', () => {
    expect(getMethod('test.detector')).toBe('fixed');
  });

  it('reads a stored choice', () => {
    setMethod('test.detector', 'adaptive');
    expect(getMethod('test.detector')).toBe('adaptive');
    expect(loadSettings().methods).toEqual({ 'test.detector': 'adaptive' });
  });

  it('notifies settings listeners, so a change takes effect without a reload', () => {
    const listener = vi.fn();
    const off = onSettingsChange(listener);
    setMethod('test.detector', 'adaptive');
    off();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores a choice that is not an option', () => {
    setMethod('test.detector', 'magic');
    expect(loadSettings().methods).toEqual({});
  });

  it('falls back to the default for an unknown stored value', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ methods: { 'test.detector': 'removed-option' } }),
    );
    expect(getMethod('test.detector')).toBe('fixed');
    expect(getStoredMethods()).toMatchObject({ 'test.detector': 'fixed' });
  });

  it.each([
    ['a number', { 'test.detector': 3 }],
    ['an array', ['adaptive']],
    ['a string', 'adaptive'],
    ['null', null],
  ])('loads %s stored as methods as no choice', (_label, methods) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ methods }));
    expect(loadSettings().methods).toEqual({});
    expect(getMethod('test.detector')).toBe('fixed');
  });

  it('keeps stored values of entries not registered (another build may know them)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ methods: { 'other.switch': 'b' } }));
    setMethod('test.detector', 'adaptive');
    expect(loadSettings().methods).toEqual({ 'other.switch': 'b', 'test.detector': 'adaptive' });
  });

  it('Reset All restores the defaults', () => {
    setMethod('test.detector', 'adaptive');
    resetSettings();
    expect(getMethod('test.detector')).toBe('fixed');
  });
});

describe('URL override ?method.<id>=<option>', () => {
  it('parses only method.* parameters', () => {
    expect(
      parseMethodOverrides('?testMode=true&method.a=x&method.=y&methodb=z&method.c.d=w'),
    ).toEqual({ a: 'x', 'c.d': 'w' });
  });

  it('wins over the stored choice without writing the settings', () => {
    setMethod('test.detector', 'fixed');
    setMethodOverridesFromSearch('?method.test.detector=adaptive');
    expect(getMethod('test.detector')).toBe('adaptive');
    expect(getMethodOverride('test.detector')).toBe('adaptive');
    expect(loadSettings().methods).toEqual({ 'test.detector': 'fixed' });
  });

  it('keeps winning after the stored choice changes', () => {
    setMethodOverridesFromSearch('?method.test.detector=adaptive');
    setMethod('test.detector', 'fixed');
    expect(getMethod('test.detector')).toBe('adaptive');
  });

  it('is ignored when it does not name an option', () => {
    setMethod('test.detector', 'adaptive');
    setMethodOverridesFromSearch('?method.test.detector=magic');
    expect(getMethodOverride('test.detector')).toBeNull();
    expect(getMethod('test.detector')).toBe('adaptive');
  });
});
