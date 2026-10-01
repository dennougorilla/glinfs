import { afterEach, describe, expect, it } from 'vitest';
import { initRangeFill, rangeFillPercent } from '../../../src/shared/range-fill.js';

/** Let the MutationObserver deliver */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function range({ min = '0', max = '100', value = '50' } = {}) {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.value = value;
  return input;
}

const fill = (input) => input.style.getPropertyValue('--range-fill');

describe('rangeFillPercent', () => {
  it('maps the value into the range', () => {
    expect(rangeFillPercent(range({ min: '10', max: '20', value: '15' }))).toBe(50);
    expect(rangeFillPercent(range({ value: '0' }))).toBe(0);
    expect(rangeFillPercent(range({ value: '100' }))).toBe(100);
  });

  it('is 0 for an empty range', () => {
    expect(rangeFillPercent(range({ min: '5', max: '5', value: '5' }))).toBe(0);
  });
});

describe('initRangeFill', () => {
  let stop = () => {};
  afterEach(() => {
    stop();
    document.body.innerHTML = '';
  });

  it('fills ranges present at startup and added later', async () => {
    const early = range({ value: '25' });
    document.body.appendChild(early);
    stop = initRangeFill();
    expect(fill(early)).toBe('25%');

    const late = range({ value: '75' });
    document.body.appendChild(late);
    await settle();
    expect(fill(late)).toBe('75%');
  });

  it('follows user input', () => {
    const input = range();
    document.body.appendChild(input);
    stop = initRangeFill();
    input.value = '10';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fill(input)).toBe('10%');
  });

  it('follows a script assigning value directly, which fires no event', () => {
    const input = range();
    document.body.appendChild(input);
    stop = initRangeFill();
    input.value = '90';
    expect(fill(input)).toBe('90%');
    expect(input.value).toBe('90');
  });

  it('follows a new min or max', async () => {
    const input = range({ value: '50' });
    document.body.appendChild(input);
    stop = initRangeFill();
    input.max = '200';
    await settle();
    expect(fill(input)).toBe('25%');
  });

  it('picks up a value set right after insertion', async () => {
    stop = initRangeFill();
    const input = range({ value: '10' });
    document.body.appendChild(input);
    input.value = '60';
    await settle();
    expect(fill(input)).toBe('60%');
  });
});
