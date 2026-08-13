/** MASK-AUTHORITY REPORT, SINGLE FRESH LOAD — narrow, single-purpose check
 * (2026-08-13).
 *
 * Question: after the First-Floor `_Fire` mask file was swapped
 * (byte-for-byte) with a copy of the Ground floor's mask, does the
 * `mask-authority` report's `floors[1].derived.rasterized.fire` field show
 * real authored content reaching the rasterized grid, or does it fall back to
 * a "default" (never-sourced) value? And how does that compare to
 * `floors[0]` (Ground), the floor already proven to yield 5 fires from this
 * exact file's content?
 *
 * This does ONE fresh scene load (`deriveFloorProducts` in mask-derive.js
 * computes products for EVERY floor in a single pass, independent of which
 * floor is currently being viewed — confirmed by reading the source — so no
 * floor switch is needed to populate floor 1's row). It calls
 * `MapShine.debug.runReport('mask-authority')` exactly once, immediately
 * after the loading-screen-state report says `complete`, and prints both
 * floors' fire-related fields.
 *
 * Deliberately minimal: no floor switching, no screenshots, no network
 * sniffing — those questions were already answered by
 * `fire-first-floor-swap-verify.mjs` in this same directory. This script's
 * only job is the mask-authority report's own fire fields, from a genuinely
 * fresh page load.
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
  waitForSceneSettled,
} from '../../playwright/map-shine-utils.js';

const LABEL = 'mask-authority-fresh';
const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const resultPath = path.join(OUT_DIR, `${LABEL}-result.json`);

fs.mkdirSync(OUT_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());

const consoleLines = [];
page.on('console', (m) => consoleLines.push({ type: m.type(), text: m.text().slice(0, 500), at: Date.now() }));
page.on('pageerror', (e) => consoleLines.push({ type: 'pageerror', text: String(e).slice(0, 500), at: Date.now() }));

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();

const state = { label: LABEL, startedAt: new Date().toISOString() };
function save() {
  fs.writeFileSync(resultPath, JSON.stringify(state, null, 2));
}

async function waitForMapArtLoaded(timeoutMs) {
  const start = Date.now();
  for (;;) {
    const st = await page.evaluate(async () => {
      try {
        const raw = await window.MapShine?.debug?.runReport?.('loading-screen-state');
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          showing: r?.showing !== false,
          complete: r?.current?.complete === true,
          error: r?.current?.error ?? null,
          phase: (r?.currentPhases || []).filter((p) => p.endMs === null).map((p) => p.phase)[0] ?? null,
        };
      } catch (e) {
        return { showing: true, error: null };
      }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return st;
    if (Date.now() - start > timeoutMs)
      throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s (phase=${st?.phase})`);
    await page.waitForTimeout(1000);
  }
}

async function getReport(id) {
  return page.evaluate(async (reportId) => {
    try {
      const r = await window.MapShine?.debug?.runReport?.(reportId);
      return typeof r === 'string' ? JSON.parse(r) : r;
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }, id);
}

try {
  console.log(`[${LABEL}] goto ${launcher.getBaseUrl()}`);
  await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
  await bestEffortLogin(page);
  await waitForGameReady(page);
  await waitForCanvasReady(page);
  await waitForMapShineReady(page);
  await unpauseIfPaused(page);

  console.log(`[${LABEL}] waiting for map art to finish loading...`);
  await waitForMapArtLoaded(600000);
  console.log(`[${LABEL}] map art loaded (loading-screen-state complete)`);

  // Belt-and-suspenders: the settle tracker + a short dwell, same posture as
  // every other script in this directory, before treating the report as
  // trustworthy.
  await waitForSceneSettled(page, { label: 'fresh load', timeoutMs: 300000 });
  await page.waitForTimeout(5000);

  state.sceneState = await page.evaluate(() => ({
    sceneName: window.canvas?.scene?.name ?? null,
    viewedLevelId: window.canvas?.level?.id ?? null,
    viewedLevelName: window.canvas?.level?.name ?? null,
  }));
  console.log(`[${LABEL}] scene state:`, JSON.stringify(state.sceneState));

  console.log(`[${LABEL}] calling MapShine.debug.runReport('mask-authority')...`);
  const report = await getReport('mask-authority');
  state.maskAuthorityReport = report;
  save();

  if (report?.error) {
    throw new Error(`runReport('mask-authority') failed: ${report.error}`);
  }
  if (!Array.isArray(report?.floors)) {
    throw new Error(`report.floors is not an array — got: ${JSON.stringify(report).slice(0, 500)}`);
  }

  const byIndex = (i) => report.floors.find((f) => f.index === i) ?? report.floors[i] ?? null;
  const floor0 = byIndex(0);
  const floor1 = byIndex(1);

  const summarize = (f) => ({
    index: f?.index ?? null,
    name: f?.name ?? null,
    authoredFire: f?.authored?.fire ?? '<missing>',
    derivedRasterizedFire:
      f?.derived && typeof f.derived === 'object' ? (f.derived.rasterized?.fire ?? '<no rasterized.fire field>') : f?.derived,
    completenessAuthoredSourcesFire:
      f?.derived && typeof f.derived === 'object' ? (f.derived.completeness?.authoredSources?.fire ?? null) : null,
    requiredMasksMissing: f?.requiredMasksMissing ?? null,
  });

  state.comparison = { floor0: summarize(floor0), floor1: summarize(floor1) };
  save();

  console.log(`[${LABEL}] ===== RESULT =====`);
  console.log(`[${LABEL}] floor 0 (${floor0?.name}): authored.fire = ${JSON.stringify(state.comparison.floor0.authoredFire)}`);
  console.log(`[${LABEL}] floor 0 (${floor0?.name}): derived.rasterized.fire = ${JSON.stringify(state.comparison.floor0.derivedRasterizedFire)}`);
  console.log(`[${LABEL}] floor 1 (${floor1?.name}): authored.fire = ${JSON.stringify(state.comparison.floor1.authoredFire)}`);
  console.log(`[${LABEL}] floor 1 (${floor1?.name}): derived.rasterized.fire = ${JSON.stringify(state.comparison.floor1.derivedRasterizedFire)}`);
  console.log(`[${LABEL}] full floor0 row:`, JSON.stringify(floor0, null, 2));
  console.log(`[${LABEL}] full floor1 row:`, JSON.stringify(floor1, null, 2));

  state.ok = true;
} catch (e) {
  console.error(`[${LABEL}] run stopped early:`, e);
  state.error = String(e?.stack || e?.message || e);
} finally {
  state.consoleErrorCount = consoleLines.filter((l) => l.type === 'error' || l.type === 'pageerror').length;
  state.consoleErrors = consoleLines.filter((l) => l.type === 'error' || l.type === 'pageerror').slice(0, 40);
  save();
  await context.close().catch(() => {});
  await launcher.stop();
  console.log(`[${LABEL}] wrote ${resultPath}`);
}
