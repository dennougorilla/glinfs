import { describe, expect, it } from 'vitest';
import * as captureIndex from '../../../src/features/capture/index.js';

/**
 * Regression test for the Biome dead-code sweep (#50).
 *
 * `clearCaptureBuffer` and `getCapturedFramesCount` had zero call sites
 * anywhere in src/ or tests/ (confirmed via `grep -rn` before removal) and
 * were removed. This guards against either export silently reappearing
 * without any caller, which would just reintroduce dead code.
 */
describe('capture/index.js dead export removal (#50)', () => {
  it('no longer exports clearCaptureBuffer', () => {
    expect(captureIndex.clearCaptureBuffer).toBeUndefined();
  });

  it('no longer exports getCapturedFramesCount', () => {
    expect(captureIndex.getCapturedFramesCount).toBeUndefined();
  });
});
