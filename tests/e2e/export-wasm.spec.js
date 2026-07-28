/**
 * Real gifsicle-WASM export through the full worker pipeline.
 * @module tests/e2e/export-wasm.spec
 *
 * This is the only coverage of the WASM encoder path end-to-end (worker
 * creation → fetch of public/encoder assets → Emscripten init via
 * new Function → quantize/encode → NETSCAPE loop patch → Blob). It exists
 * primarily to catch integration breakage that unit tests cannot see —
 * e.g. a Content-Security-Policy change blocking the worker, eval, or
 * WASM compilation (the CSP meta tag governs this page; see #71/#50).
 */

import { expect, test } from '@playwright/test';
import { gotoExportWithClip } from './helpers/app.js';

test('gifsicle-wasm encoder completes a real export without CSP violations', async ({ page }) => {
  /** @type {string[]} */
  const violations = [];
  await page.addInitScript(() => {
    // Surface CSP violations to the test through a window array
    window.__CSP_VIOLATIONS__ = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__CSP_VIOLATIONS__.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });

  await gotoExportWithClip(page, { frameCount: 6, fps: 30 });

  // Select the WASM encoder card
  const wasmCard = page.locator('.encoder-card', { hasText: 'libimagequant' });
  await expect(wasmCard).toBeVisible();
  await wasmCard.click();

  // Run the export; WASM fetch + compile + encode of 6 small frames
  await page.locator('.btn-export-main').click();
  await expect(page.locator('.export-complete-v2')).toBeVisible({ timeout: 30000 });

  violations.push(...(await page.evaluate(() => window.__CSP_VIOLATIONS__ ?? [])));
  expect(violations).toEqual([]);
});
