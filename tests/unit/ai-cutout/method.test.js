/**
 * The cutout switches (Settings → Methods, task 8 item 5): each is a valid
 * registry entry in the cutout area whose default is the behaviour the app
 * had before it was a switch.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CUTOUT_METHOD_ENTRIES,
  getClickAnswerRule,
  getColourReach,
  getRetrackScope,
  getTrackAfterLost,
} from '../../../src/features/ai-cutout/method.js';
import { listMethods, setMethodOverridesFromSearch } from '../../../src/shared/methods.js';

afterEach(() => setMethodOverridesFromSearch(''));

describe('cutout methods', () => {
  it('registers each entry once, in the cutout area, defaulting to the old behaviour', () => {
    const listed = listMethods().filter((e) => e.area === 'cutout');
    for (const entry of CUTOUT_METHOD_ENTRIES) {
      expect(listed.filter((e) => e.id === entry.id)).toHaveLength(1);
    }
    expect(getTrackAfterLost()).toBe('resume');
    expect(getRetrackScope()).toBe('span');
    expect(getClickAnswerRule()).toBe('size');
    expect(getColourReach()).toBe('touching');
  });

  it('a URL override selects an option for the page session', () => {
    setMethodOverridesFromSearch('?method.cutout.track-lost=stop&method.cutout.retrack=all');
    expect(getTrackAfterLost()).toBe('stop');
    expect(getRetrackScope()).toBe('all');
    setMethodOverridesFromSearch('?method.cutout.click-answer=scored');
    expect(getClickAnswerRule()).toBe('scored');
    setMethodOverridesFromSearch('?method.cutout.colour-reach=pieces');
    expect(getColourReach()).toBe('pieces');
    // An unknown option keeps the default
    setMethodOverridesFromSearch('?method.cutout.track-lost=sometimes');
    expect(getTrackAfterLost()).toBe('resume');
  });
});
