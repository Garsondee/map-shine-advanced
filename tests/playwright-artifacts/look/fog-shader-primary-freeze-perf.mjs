/** Bug #18 fix — CLEAN, isolated perf reads (follow-up to
 * fog-shader-primary-freeze-verify.mjs, whose own fps number was confounded
 * by measuring immediately after two camera pans + a token-control
 * operation, mid residency-streaming churn — not a fair reading).
 *
 * Two settled measurements, both AFTER waitForSceneSettled (not a fixed
 * sleep):
 *   1. No token controlled — the closest apples-to-apples comparison to the
 *      known baseline (memory reference_live_foundry_harness: 67fps,
 *      Mansion, 1920x1080, 2026-08-10). Isolates whether keeping
 *      canvas.primary's cache alive (this fix) costs anything even when
 *      Foundry's fog filter isn't running at all.
 *   2. A token controlled (canvas.visibility.visible=true, fog filter
 *      genuinely compositing) — a NEW number, not previously measured under
 *      the old code either. This is the real cost of fog-of-war being on,
 *      not attributable to this fix specifically, but honestly reported
 *      either way (feedback_instruments_must_not_lie).
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

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const LABEL = 'fog-shader-primary-freeze-perf';

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

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);
await waitForCanvasReady(page);
await waitForMapShineReady(page);
await unpauseIfPaused(page);

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
    if (st && (st.complete || !st.showing)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s`);
    await page.waitForTimeout(1000);
  }
}
console.log(`[${LABEL}] waiting for real map art…`);
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'initial view' });
// Extra dwell beyond settle=0-outstanding-work, matching msa-look.spec.js's
// own default SETTLE_SECONDS so this is comparable to the 67fps baseline.
await page.waitForTimeout(8000);

async function measureFps() {
  return page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames += 1;
      if (frames >= 90) resolve(Math.round((frames * 1000) / (performance.now() - t0)));
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

const mechanism = await page.evaluate(() => ({
  primaryRenderable: window.canvas?.primary?.renderable ?? null,
  primarySpriteRenderable: window.canvas?.primary?.sprite?.renderable ?? null,
  effectsRenderable: window.canvas?.effects?.renderable ?? null,
  visibilityVisible: window.canvas?.visibility?.visible ?? null,
}));

const fpsNoToken = await measureFps();
console.log(`[${LABEL}] fps, settled, NO token controlled (fog inactive): ${fpsNoToken}`);
console.log(`[${LABEL}] mechanism at this point:`, JSON.stringify(mechanism));

// Now control a token (if one exists) and settle again before the second read.
let fpsWithToken = null;
let tokenInfo = { found: false };
let visibilityWithToken = null;
try {
  tokenInfo = await page.evaluate(async () => {
    const placeables = window.canvas?.tokens?.placeables ?? [];
    if (!placeables.length) return { found: false };
    const token = placeables[0];
    const originalSight = foundry.utils.deepClone(token.document.sight);
    if (!(token.document.sight?.range > 0)) {
      await token.document.update({ sight: { enabled: true, range: 60 } });
    }
    await token.control({ releaseOthers: true });
    return { found: true, tokenId: token.id, name: token.name, originalSight };
  });

  if (tokenInfo.found) {
    await page.waitForTimeout(1000);
    await waitForSceneSettled(page, { label: 'with token controlled', timeoutMs: 60000 }).catch((e) => {
      console.log(`[${LABEL}] settle after token-control didn't confirm quiet (non-fatal): ${e.message}`);
    });
    await page.waitForTimeout(2000);

    visibilityWithToken = await page.evaluate(() => ({
      visible: window.canvas?.visibility?.visible ?? null,
      activeVisionSources: Array.from(window.canvas?.effects?.visionSources ?? []).filter((s) => s?.active).length,
    }));
    console.log(`[${LABEL}] visibility state with token controlled:`, JSON.stringify(visibilityWithToken));

    fpsWithToken = await measureFps();
    console.log(`[${LABEL}] fps, settled, WITH token controlled (fog active): ${fpsWithToken}`);

    await page.evaluate(async (info) => {
      const token = window.canvas?.tokens?.placeables?.find((t) => t.id === info.tokenId);
      if (!token) return;
      token.release();
      await token.document.update({ sight: info.originalSight });
    }, tokenInfo);
  } else {
    console.log(`[${LABEL}] no tokens found on this scene — skipping the with-token fps read`);
  }
} catch (e) {
  console.log(`[${LABEL}] token-control step failed (non-fatal):`, String(e?.message ?? e));
}

const summary = {
  label: LABEL,
  capturedAt: new Date().toISOString(),
  knownBaseline: { fps: 67, scenario: 'Mansion both floors, Renderer=MSA, 1920x1080, DPR1, no token controlled, 2026-08-10, memory reference_live_foundry_harness' },
  mechanism,
  fpsNoTokenControlled: fpsNoToken,
  fpsWithTokenControlled: fpsWithToken,
  tokenInfo: { found: tokenInfo.found, name: tokenInfo.name ?? null },
  visibilityWithToken,
  consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-result.json`), JSON.stringify(summary, null, 2));
console.log(`[${LABEL}] wrote ${LABEL}-result.json`);

await context.close();
await launcher.stop();
