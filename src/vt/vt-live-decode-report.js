/**
 * @fileoverview vt/vt-live-decode-report.js — a debug-panel report that
 * exercises the REAL browser decode path (fetch + createImageBitmap crop) for
 * the first time, against whatever torture fixture image is actually synced.
 *
 * Deliberately separate from vt-selftest-report.js: that one is pure logic,
 * safe to click repeatedly. This one does real network + decode work, so it's
 * its own explicit button — the debug panel's "safe automatic vs. deliberate
 * heavier" split.
 *
 * @module vt/vt-live-decode-report
 */

import { PageTable } from './page-table.js';
import { getSourceBitmap, decodePage, pageWorldRect } from './decode-pool.js';

/**
 * @param {string} url - module-relative path to a torture fixture image,
 *   e.g. "modules/map-shine-advanced/assets/torture/torture_floor0.png".
 */
export async function runVtLiveDecodeTest(url) {
  const t0 = performance.now();
  let sourceBitmap;
  try {
    sourceBitmap = await getSourceBitmap(url);
  } catch (err) {
    return {
      url,
      ok: false,
      error: `getSourceBitmap failed: ${err?.message || err}. Is ${url} actually synced to this Foundry install?`,
    };
  }
  const decodeMs = Math.round(performance.now() - t0);

  const table = new PageTable({ id: 'live:decodeTest', worldSizePx: sourceBitmap.width });
  const samplePages = [
    { label: 'corner (0,0) — world-edge clamping exercised', mip: 0, px: 0, py: 0 },
    { label: 'middle page', mip: 0, px: Math.floor(table.pagesPerAxis(0) / 2), py: Math.floor(table.pagesPerAxis(0) / 2) },
    { label: 'far corner — the other world-edge clamp', mip: 0, px: table.pagesPerAxis(0) - 1, py: table.pagesPerAxis(0) - 1 },
  ];

  const pageResults = [];
  for (const sample of samplePages) {
    const worldRect = pageWorldRect(table, sample.mip, sample.px, sample.py);
    const tPage0 = performance.now();
    try {
      const pageBitmap = await decodePage(sourceBitmap, worldRect);
      pageResults.push({
        ...sample,
        worldRect,
        decodedSizePx: { width: pageBitmap.width, height: pageBitmap.height },
        correctSize: pageBitmap.width === 256 && pageBitmap.height === 256,
        ms: Math.round(performance.now() - tPage0),
      });
      pageBitmap.close?.(); // this is a self-test — don't hold GPU/CPU memory after reading the result
    } catch (err) {
      pageResults.push({ ...sample, worldRect, error: String(err?.message || err) });
    }
  }

  const allPagesOk = pageResults.every((p) => p.correctSize);
  return {
    url,
    ok: true,
    sourceImageDimensions: { width: sourceBitmap.width, height: sourceBitmap.height },
    sourceDecodeMs: decodeMs,
    pagesPerAxisAtMip0: table.pagesPerAxis(0),
    allSamplePagesCorrectSize: allPagesOk,
    pageResults,
    note: allPagesOk
      ? 'All sample pages decoded to exactly 256x256 as expected — the crop-decode path works end to end against the real synced fixture.'
      : 'At least one sample page did NOT decode to 256x256 — see pageResults for which one and its worldRect.',
  };
}
