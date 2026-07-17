import { describe, expect, it } from 'vitest';
import { createElement } from '../../../../src/shared/utils/dom.js';

describe('createElement', () => {
  describe('nullish and false attribute values (issue #35)', () => {
    it('skips attributes with undefined values', () => {
      const el = createElement('select', { disabled: undefined });

      expect(el.hasAttribute('disabled')).toBe(false);
      expect(/** @type {HTMLSelectElement} */ (el).disabled).toBe(false);
    });

    it('skips attributes with null values', () => {
      const el = createElement('input', { disabled: null });

      expect(el.hasAttribute('disabled')).toBe(false);
      expect(/** @type {HTMLInputElement} */ (el).disabled).toBe(false);
    });

    it('skips attributes with boolean false values', () => {
      const el = createElement('button', { disabled: false });

      expect(el.hasAttribute('disabled')).toBe(false);
      expect(/** @type {HTMLButtonElement} */ (el).disabled).toBe(false);
    });

    it('supports the conditional disabled pattern used by capture UI', () => {
      const render = (isSharing) =>
        createElement('select', { disabled: isSharing ? 'true' : undefined });

      expect(/** @type {HTMLSelectElement} */ (render(false)).disabled).toBe(false);
      expect(/** @type {HTMLSelectElement} */ (render(true)).disabled).toBe(true);
    });

    it('does not produce aria-disabled="undefined" artifacts', () => {
      const el = createElement('button', { 'aria-disabled': undefined });

      expect(el.hasAttribute('aria-disabled')).toBe(false);
    });

    it('still sets the string "false" as an attribute value', () => {
      // Callers pass explicit string 'false' for ARIA states; those must be kept.
      const el = createElement('li', { 'aria-selected': 'false' });

      expect(el.getAttribute('aria-selected')).toBe('false');
    });

    it('sets boolean true as the string "true"', () => {
      const el = createElement('button', { disabled: true });

      expect(el.getAttribute('disabled')).toBe('true');
      expect(/** @type {HTMLButtonElement} */ (el).disabled).toBe(true);
    });
  });

  describe('existing behavior', () => {
    it('sets className via the className key', () => {
      const el = createElement('div', { className: 'foo bar' });

      expect(el.className).toBe('foo bar');
      expect(el.classList.contains('foo')).toBe(true);
      expect(el.classList.contains('bar')).toBe(true);
    });

    it('sets data-* attributes', () => {
      const el = createElement('li', { 'data-value': '42' });

      expect(el.getAttribute('data-value')).toBe('42');
      expect(el.dataset.value).toBe('42');
    });

    it('sets plain string attributes', () => {
      const el = createElement('a', { href: 'https://example.com', rel: 'noopener' });

      expect(el.getAttribute('href')).toBe('https://example.com');
      expect(el.getAttribute('rel')).toBe('noopener');
    });

    it('sets empty string attribute values', () => {
      const el = createElement('input', { value: '' });

      expect(el.hasAttribute('value')).toBe(true);
      expect(el.getAttribute('value')).toBe('');
    });

    it('appends string children as text nodes and element children directly', () => {
      const child = createElement('span', { className: 'inner' });
      const el = createElement('div', {}, ['hello', child]);

      expect(el.childNodes).toHaveLength(2);
      expect(el.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
      expect(el.childNodes[0].textContent).toBe('hello');
      expect(el.childNodes[1]).toBe(child);
    });

    it('works with no attributes or children', () => {
      const el = createElement('p');

      expect(el.tagName).toBe('P');
      expect(el.attributes).toHaveLength(0);
      expect(el.childNodes).toHaveLength(0);
    });
  });
});
