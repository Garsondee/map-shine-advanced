/** COLD-CACHE FLOOR SWITCH — the author's live report, reproduced and timed.
 *
 * THE REPORT (2026-08-11): "I go up one floor. The upper floor background image
 * and foreground image take several minutes to actually appear… That's a serious
 * issue because people might think things are just completely broken. This
 * happens the first time that a texture cache gets wiped due to a new version."
 *
 * The cache wipe is the whole point, so this script CAUSES one: it deletes the
 * BC cache database (`msa-bc-cache`, see bc-compress.worker.js) on the join page
 * — BEFORE MapShine boots and opens its own connection, which would otherwise
 * make `deleteDatabase` fire `onblocked` and silently leave a warm cache behind,
 * measuring nothing.
 *
 * WHAT IS MEASURED, and why it is per-item rather than a settle flag: the
 * symptom is "this specific image is not on screen yet." So the script snapshots
 * which whole-images are already `ready` before the switch, then reports every
 * item that becomes ready AFTER it, with the elapsed seconds attached and its
 * source filename — self-describing, no guessing at item ids, and it names the
 * background/foreground directly. `vt/settle.js`'s own `settled` flag is
 * deliberately NOT the gate here: its tracker is not reset on a floor switch
 * (a known defect, fixed in its own task), so it can report a stale "settled"
 * the instant a floor changes and would flatter this measurement.
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import {
  bestEffortLogin,
  waitForGameReady,
  waitForCanvasReady,
  waitForMapShineReady,
  unpauseIfPaused,
} from '../../playwright/map-shine-utils.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));

const cdp = await context.newCDPSession(page);
await cdp.send('Network.clearBrowserCache');

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });

// THE CACHE WIPE — here, on the join page, before MapShine exists.
const wipe = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const req = indexedDB.deleteDatabase('msa-bc-cache');
      req.onsuccess = () => done('deleted');
      req.onerror = () => done('error');
      req.onblocked = () => done('BLOCKED — a connection was already open; the cache is NOT cold');
      setTimeout(() => done('timeout'), 15000);
    })
);
console.log('[cold] BC cache wipe:', wipe);
if (wipe !== 'deleted') {
  console.error('[cold] ABORT — the cache was not actually wiped, so nothing below would measure a cold load.');
  await context.close();
  process.exit(1);
}

await bestEffortLogin(page);
await waitForGameReady(page);
await waitForCanvasReady(page);
await waitForMapShineReady(page);
await unpauseIfPaused(page);

/** The whole-image census: id -> {status, visible, src, compressed}. */
async function readWholeImages() {
  return page.evaluate(async () => {
    try {
      const raw = await window.MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
      const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const wi = r?.wholeImage ?? null;
      // ⚠️ `items`, NOT `perItem` — the field is named `perItem` INSIDE
      // `summarizeWholeImage` and returned as `items`. The first version of
      // this script read `perItem`, got `undefined`, and reported "0 loading"
      // for six straight minutes: indistinguishable, in the log, from a
      // healthy idle scene. Hence `censusOk` below — this reader now says
      // outright when it cannot see anything, instead of implying all-clear
      // ([[feedback_instruments_must_not_lie]]).
      const per = Array.isArray(wi?.items) ? wi.items : null;
      return {
        censusOk: per !== null,
        items: (per ?? []).map((p) => ({
          id: p.id,
          src: p.src,
          status: p.status,
          visible: p.visible,
          compressed: p.compressed,
        })),
        worker: wi?.compressed?.worker ?? null,
      };
    } catch (e) {
      return { censusOk: false, items: [], worker: null, error: String(e?.message ?? e) };
    }
  });
}

function fileOf(src) {
  return String(src || '')
    .split('/')
    .pop();
}

/** Wait until no whole-image is still `loading`, with a hard ceiling. */
async function waitForNoneLoading(label, timeoutMs) {
  const start = Date.now();
  let last = 0;
  for (;;) {
    const snap = await readWholeImages();
    // FAIL LOUD, never wait quietly: "I cannot read the census" and "the census
    // says nothing is loading" are opposite facts that must never print alike.
    if (!snap.censusOk)
      throw new Error(`whole-image census unreadable (${snap.error ?? 'no wholeImage.items'}) — cannot measure`);
    const loading = snap.items.filter((i) => i.status === 'loading');
    if (snap.items.length && loading.length === 0) return { elapsedS: (Date.now() - start) / 1000, snap };
    const now = Date.now();
    if (now - last > 10000) {
      last = now;
      const w = snap.worker;
      console.log(
        `[cold] ${label} ${Math.round((now - start) / 1000)}s — ${loading.length} loading` +
          (w
            ? ` · worker pending=${w.pending} (interactive ${w.queuedInteractive}, background ${w.queuedBackground})`
            : '')
      );
    }
    if (now - start > timeoutMs) return { elapsedS: (now - start) / 1000, snap, timedOut: true };
    await page.waitForTimeout(1000);
  }
}

console.log('[cold] waiting for the GROUND floor to finish its cold load…');
const ground = await waitForNoneLoading('ground', 900000);
console.log(`[cold] ground floor done after ${ground.elapsedS.toFixed(1)}s`);

const before = new Set(ground.snap.items.filter((i) => i.status === 'ready').map((i) => i.id));
const workerBefore = ground.snap.worker;

// THE SWITCH — everything past here is what the author was staring at.
const t0 = Date.now();
const clicked = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('*')).filter(
    (el) => el.children.length === 0 && el.textContent?.trim() === 'First Floor'
  );
  if (!els.length) return { ok: false, reason: 'no "First Floor" control found' };
  els[0].click();
  return { ok: true };
});
console.log('[cold] floor switch:', JSON.stringify(clicked));
if (!clicked.ok) {
  await context.close();
  process.exit(1);
}

/** Poll until every whole-image is out of `loading`, recording WHEN each new
 * item first reported ready — that timestamp IS "when the image appeared". */
const firstReadyS = new Map();
const laneSamples = [];
let lastLog = 0;
let result = null;
for (;;) {
  const snap = await readWholeImages();
  if (!snap.censusOk)
    throw new Error(`whole-image census unreadable (${snap.error ?? 'no wholeImage.items'}) — cannot measure`);
  const nowS = (Date.now() - t0) / 1000;
  for (const it of snap.items) {
    if (it.status === 'ready' && !before.has(it.id) && !firstReadyS.has(it.id)) {
      firstReadyS.set(it.id, { atS: +nowS.toFixed(1), src: fileOf(it.src), compressed: it.compressed });
      console.log(`[cold]   ✓ ${nowS.toFixed(1)}s — ${fileOf(it.src)} (${it.compressed ?? 'raw'})`);
    }
  }
  if (snap.worker) {
    laneSamples.push({
      atS: +nowS.toFixed(1),
      pending: snap.worker.pending,
      interactive: snap.worker.queuedInteractive,
      background: snap.worker.queuedBackground,
    });
  }
  const loading = snap.items.filter((i) => i.status === 'loading');
  if (snap.items.length && loading.length === 0) {
    result = { elapsedS: +nowS.toFixed(1), snap };
    break;
  }
  if (Date.now() - lastLog > 10000) {
    lastLog = Date.now();
    const w = snap.worker;
    console.log(
      `[cold] first floor ${nowS.toFixed(0)}s — ${loading.length} loading` +
        (w
          ? ` · worker pending=${w.pending} (interactive ${w.queuedInteractive}, background ${w.queuedBackground})`
          : '')
    );
  }
  if (nowS > 900) {
    result = { elapsedS: +nowS.toFixed(1), snap, timedOut: true };
    break;
  }
  await page.waitForTimeout(1000);
}

await page
  .locator('canvas#msa-vt-pan-viewer-canvas')
  .screenshot({ path: path.join(OUT_DIR, 'cold-cache-first-floor.png') })
  .catch(() => {});

const appeared = [...firstReadyS.values()].sort((a, b) => a.atS - b.atS);
const summary = {
  cacheWipe: wipe,
  groundFloorColdLoadS: +ground.elapsedS.toFixed(1),
  floorSwitchToAllLoadedS: result.elapsedS,
  timedOut: !!result.timedOut,
  itemsThatAppearedAfterTheSwitch: appeared,
  slowestAppearanceS: appeared.length ? appeared[appeared.length - 1].atS : null,
  workerBefore,
  workerAfter: result.snap.worker,
  // NON-VACUITY: if the lanes never carried a backlog, this run did not
  // reproduce the conditions the fix targets and proves nothing about it.
  maxQueueDepthSeen: result.snap.worker?.maxQueueDepth ?? null,
  peakBackgroundQueued: laneSamples.reduce((m, s) => Math.max(m, s.background ?? 0), 0),
  laneSamples: laneSamples.slice(0, 200),
};
console.log('[cold] VERDICT:', JSON.stringify({ ...summary, laneSamples: `${laneSamples.length} samples` }, null, 2));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'cold-cache-floor-switch-result.json'),
  JSON.stringify({ summary, consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40) }, null, 2)
);
console.log('[cold] wrote cold-cache-floor-switch-result.json');

await context.close();
