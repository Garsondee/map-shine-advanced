const { defineConfig } = require('@playwright/test');

/**
 * ⚠️ WEBGPU IS THE WHOLE POINT — READ BEFORE CHANGING `channel` OR `headless`.
 *
 * Map Shine Advanced renders through WebGPU, so a browser without a real GPU adapter shows a
 * blank canvas and measures nothing. Probed directly on the reference machine (RTX 3070
 * Laptop, 2026-08-10), over `http://localhost`:
 *
 *   installed Chrome, headed   → adapter nvidia/ampere, device created, render pass executed ✅
 *   bundled Chromium, headed   → fails to launch on this machine ("spawn UNKNOWN")
 *   bundled headless shell     → `requestAdapter()` returns null — no GPU at all
 *   headless + --enable-unsafe-webgpu → adapter appears, then `requestDevice()` throws
 *                                 "DynamicLib.Open: dxil.dll" — the shell ships no DXC libs
 *
 * Hence: `channel: 'chrome'` and headed by default. This is also the browser the module is
 * actually shipped against, which satisfies the project's own rule that a bench must build
 * its inputs the way production does.
 *
 * `PERF_HEADLESS=true` is deliberately NOT wired to Playwright's `headless` any more — it
 * would silently produce a GPU-less run whose numbers look like a catastrophic regression.
 */
const maximize = process.env.PERF_MAXIMIZE === 'true';
const kiosk = process.env.PERF_KIOSK === 'true';

const args = [];
if (maximize) args.push('--start-maximized');
if (kiosk) args.push('--kiosk');
// Keep the first run of a fresh profile from stealing focus or nagging.
args.push('--no-first-run', '--no-default-browser-check');

module.exports = defineConfig({
  testDir: 'tests/playwright',
  timeout: 5 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'tests/playwright-artifacts/html-report', open: 'never' }]],
  outputDir: 'tests/playwright-artifacts/test-results',
  use: {
    channel: 'chrome',
    headless: false,
    viewport: maximize ? null : {
      width: Number(process.env.PERF_VIEWPORT_W || 1920),
      height: Number(process.env.PERF_VIEWPORT_H || 1080)
    },
    launchOptions: { args },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  workers: 1
});
