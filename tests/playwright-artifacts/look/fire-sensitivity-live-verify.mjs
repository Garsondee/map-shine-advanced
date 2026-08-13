/** MASK SENSITIVITY SLIDER — live rebuild-without-reload verify (2026-08-13).
 *
 * Author's explicit ask: "Give me a way to change the sensitivity so that I
 * can boost the chance of fire appearing but please make sure that the
 * system once I stop moving the control rebuilds the fire effect so that I
 * can test it immediately without having to refresh Foundry."
 *
 * `MapShine.setFire({ maskSensitivity })` is exactly what the new FOH slider's
 * onChange calls (`boot.js`'s `buildFirePanel`), so driving it directly here
 * is a faithful test of the real wiring, not a shortcut around it. This
 * switches to First Floor (the floor where the author's own live test found
 * paint that wasn't registering), then drives the SAME override through
 * three values — default (0.25), low (0.05), high (0.55) — watching the
 * "painted region on floor 1 yielded M fire(s)" log
 * (`boot.js#getMaskDrivenFires`) for a genuinely NEW line after each change.
 * A repeated/stale line would mean the cache-key wiring isn't forcing a real
 * re-extraction; a new line with a DIFFERENT count is the live-tunable
 * control actually working, no reload involved.
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

const LABEL = 'fire-sensitivity-live';
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

const state = { label: LABEL, startedAt: new Date().toISOString(), steps: [] };
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
        return { showing: r?.showing !== false, complete: r?.current?.complete === true, error: r?.current?.error ?? null };
      } catch (e) {
        return { showing: true, error: null };
      }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return st;
    if (Date.now() - start > timeoutMs) throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s`);
    await page.waitForTimeout(1000);
  }
}

function extractYieldLine(text) {
  const m = /painted region on floor (\d+) yielded (\d+) fire\(s\)/.exec(text);
  if (!m) return null;
  return { floorIndex: Number(m[1]), count: Number(m[2]) };
}

/** Poll console for a NEW floor-1 yield line with `at` after `sinceMs`. */
async function waitForFreshYieldLine(sinceMs, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const hit = consoleLines.find((l) => l.at > sinceMs && extractYieldLine(l.text)?.floorIndex === 1);
    if (hit) return { text: hit.text, at: hit.at, ...extractYieldLine(hit.text) };
    if (Date.now() - start > timeoutMs) return null;
    await page.waitForTimeout(300);
  }
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
  await waitForSceneSettled(page, { label: 'initial load', timeoutMs: 300000 });
  await page.waitForTimeout(3000);

  // ---- Switch to First Floor — the floor the author's own live test found
  // paint that wasn't registering at default sensitivity. ------------------
  const switchResult = await page.evaluate(async () => {
    const levels = window.canvas?.scene?.levels;
    let firstFloorId = null;
    levels?.forEach?.((lvl) => {
      if (lvl.id !== window.canvas?.scene?.levels?.contents?.[0]?.id && !firstFloorId) firstFloorId = lvl.id;
    });
    try {
      await window.canvas?.scene?.view?.({ level: firstFloorId });
      return { method: 'scene.view', firstFloorId };
    } catch (e) {
      return { method: 'failed', firstFloorId, error: String(e?.message ?? e) };
    }
  });
  console.log(`[${LABEL}] floor switch:`, JSON.stringify(switchResult));
  state.switchResult = switchResult;

  await waitForSceneSettled(page, { label: 'after floor switch', timeoutMs: 300000 });
  await page.waitForTimeout(15000); // floor-switch settle buffer, matches sibling scripts

  state.viewedLevelAfterSwitch = await page.evaluate(() => ({
    id: window.canvas?.level?.id ?? null,
    name: window.canvas?.level?.name ?? null,
  }));
  console.log(`[${LABEL}] now viewing:`, JSON.stringify(state.viewedLevelAfterSwitch));

  // ---- STEP 1: baseline at the schema default (0.25) — whatever the render
  // loop already settled on after the floor switch. -------------------------
  const baselineLine = [...consoleLines].reverse().find((l) => extractYieldLine(l.text)?.floorIndex === 1);
  const baseline = baselineLine ? { text: baselineLine.text, at: baselineLine.at, ...extractYieldLine(baselineLine.text) } : null;
  console.log(`[${LABEL}] STEP 1 baseline (default sensitivity):`, JSON.stringify(baseline));
  state.steps.push({ label: 'baseline-default-0.25', result: baseline });
  save();

  // ---- STEP 2: drop sensitivity to near the floor (0.05) — should catch
  // MORE (or equal) paint than default, with a genuinely fresh log line. ----
  const t2 = Date.now();
  const setResult2 = await page.evaluate(() => window.MapShine.setFire({ maskSensitivity: 0.05 }));
  console.log(`[${LABEL}] STEP 2 setFire({maskSensitivity:0.05}) ->`, JSON.stringify(setResult2));
  const low = await waitForFreshYieldLine(t2, 20000);
  console.log(`[${LABEL}] STEP 2 fresh yield line (low sensitivity):`, JSON.stringify(low));
  state.steps.push({ label: 'low-sensitivity-0.05', setResult: setResult2, result: low });
  save();

  // ---- STEP 3: raise sensitivity near the ceiling (0.55) — should catch
  // FEWER (or equal) paint than default, and again a fresh line. ------------
  const t3 = Date.now();
  const setResult3 = await page.evaluate(() => window.MapShine.setFire({ maskSensitivity: 0.55 }));
  console.log(`[${LABEL}] STEP 3 setFire({maskSensitivity:0.55}) ->`, JSON.stringify(setResult3));
  const high = await waitForFreshYieldLine(t3, 20000);
  console.log(`[${LABEL}] STEP 3 fresh yield line (high sensitivity):`, JSON.stringify(high));
  state.steps.push({ label: 'high-sensitivity-0.55', setResult: setResult3, result: high });
  save();

  // ---- STEP 4: back to default (0.25) explicitly — round-trip, and leaves
  // the session in its normal state. ----------------------------------------
  const t4 = Date.now();
  const setResult4 = await page.evaluate(() => window.MapShine.setFire({ maskSensitivity: 0.25 }));
  const backToDefault = await waitForFreshYieldLine(t4, 20000);
  console.log(`[${LABEL}] STEP 4 back to default:`, JSON.stringify(backToDefault));
  state.steps.push({ label: 'back-to-default-0.25', setResult: setResult4, result: backToDefault });
  save();

  console.log(`[${LABEL}] ===== VERDICT =====`);
  console.log(`[${LABEL}] default=${baseline?.count ?? 'none'} low(0.05)=${low?.count ?? 'NO FRESH LINE'} high(0.55)=${high?.count ?? 'NO FRESH LINE'} backToDefault=${backToDefault?.count ?? 'NO FRESH LINE'}`);

  state.rebuildsWithoutReload = Boolean(low && high); // both produced a NEW line, no page nav happened
  state.monotonic =
    low && high && baseline ? low.count >= baseline.count && baseline.count >= high.count : null;
  state.ok = true;
} catch (e) {
  console.error(`[${LABEL}] run stopped early:`, e);
  state.error = String(e?.stack || e?.message || e);
} finally {
  await page.waitForTimeout(500).catch(() => {});
  save();
  await context.close().catch(() => {});
  await launcher.stop();
  console.log(`[${LABEL}] wrote ${resultPath}`);
}
