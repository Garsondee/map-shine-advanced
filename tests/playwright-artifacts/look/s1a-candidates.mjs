/** DEFERRED-S1a — IS IT WORTH BUILDING? Measured, not assumed.
 *
 * The Testament defers the per-CELL interior/boundary split (S1.1's
 * `alphaMinGrid` + S1.2's `splitCoverageCellMask`, both built, tested, and
 * consumed by nothing). Building it is invasive — it turns one draw per tile
 * into two, in the most load-bearing path in the renderer — so the question
 * that must be answered FIRST is not "is the design sound" but "how many tiles
 * would it actually convert on the real map".
 *
 * `getEarlyZComposition().refusedBy` now names the test that refused each
 * non-interior tile. Only `alpha` refusals are candidates: a tile excluded for
 * `occlusionResponsive` (a roof that fades under a token) or `vegetation`
 * (live wind `positionNode`) is refused on grounds finer alpha certification
 * cannot touch. `s1aCandidateTiles` is that count, already filtered to tiles
 * whose min-alpha grid is actually present.
 *
 * Both floors are sampled, because the answer can differ per floor and the
 * upper floor is the one with art stacked above other art.
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
        return {
          showing: r?.showing !== false,
          complete: r?.current?.complete === true,
          error: r?.current?.error ?? null,
        };
      } catch (e) {
        return { showing: true, error: null };
      }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return;
    if (Date.now() - start > timeoutMs)
      throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s`);
    await page.waitForTimeout(1000);
  }
}

/**
 * ⚠️ WAITS FOR THE CENSUS ITSELF TO STOP CHANGING — it does NOT trust
 * `waitForSceneSettled` (2026-08-11, after this script's own first run produced
 * a false reading).
 *
 * That first run reported IDENTICAL tile counts for both floors, 6 depth
 * proxies where S1.6's trusted capture of the same floor saw 9, and 3 tiles
 * never tagged at all — i.e. it sampled a partially-resident scene and called
 * it a census. Cause: the settle tracker is not reset on a floor switch (a
 * known defect being fixed in its own task), so `waitForSceneSettled` can
 * return instantly on the PREVIOUS floor's stale "settled".
 *
 * The fix is to stop asking a broken oracle and use this measurement's own
 * evidence: poll until the counts are byte-identical across `stableFor`
 * consecutive samples AND nothing is left untagged. `untagged > 0` means a tile
 * never reached `applyEarlyZTileState`, so its reason is unknown and any
 * candidate count computed alongside it is incomplete — reported as a hole,
 * never silently averaged in ([[feedback_instruments_must_not_lie]]).
 */
async function census(label, { stableFor = 4, pollMs = 2000, timeoutMs = 300000 } = {}) {
  const start = Date.now();
  let lastKey = null;
  let stable = 0;
  let state = null;
  for (;;) {
    state = await page.evaluate(() => window.MapShine?.getEarlyZComposition?.());
    const key = JSON.stringify([state?.tiles, state?.depthProxies, state?.prepassMeshes, state?.refusedBy]);
    stable = key === lastKey ? stable + 1 : 0;
    lastKey = key;
    const settledEnough = stable >= stableFor && (state?.tiles?.untagged ?? 1) === 0;
    if (settledEnough) break;
    if (Date.now() - start > timeoutMs) {
      console.warn(
        `[s1a] ${label}: census never stabilised in ${Math.round(timeoutMs / 1000)}s — reporting it as INCOMPLETE`
      );
      break;
    }
    await page.waitForTimeout(pollMs);
  }
  const floor = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
  const untagged = state?.tiles?.untagged ?? 0;
  const complete = untagged === 0 && stable >= stableFor;
  console.log(`[s1a] ${label} (${floor.name}) complete=${complete}:`, JSON.stringify(state));
  return { label, floor, state, complete, untagged, stableSamples: stable };
}

console.log('[s1a] waiting for the ground floor…');
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'ground floor' });
// The flag ships ON as of S1.7, so this is the shipping configuration — but
// assert it rather than assume, since a census taken with it OFF would report
// every tile as 'legacy' and answer a different question entirely.
const flagOn = await page.evaluate(() => window.MapShine?.getEarlyZComposition?.()?.earlyZComposition);
console.log('[s1a] earlyZComposition at boot:', flagOn);
if (flagOn !== true) throw new Error(`expected the shipped default ON, got ${flagOn} — census would be meaningless`);
const ground = await census('ground floor');

const clicked = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('*')).filter(
    (el) => el.children.length === 0 && el.textContent?.trim() === 'First Floor'
  );
  if (!els.length) return { ok: false, reason: 'no "First Floor" control found' };
  els[0].click();
  return { ok: true };
});
console.log('[s1a] floor switch:', JSON.stringify(clicked));
if (!clicked.ok) throw new Error(clicked.reason);
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'first floor' });
const first = await census('first floor');

const totalCandidates = (ground.state?.s1aCandidateTiles ?? 0) + (first.state?.s1aCandidateTiles ?? 0);
const totalTiles =
  Object.values(ground.state?.tiles ?? {}).reduce((a, b) => a + b, 0) +
  Object.values(first.state?.tiles ?? {}).reduce((a, b) => a + b, 0);
const bothComplete = ground.complete && first.complete;
const summary = {
  ground,
  first,
  totalS1aCandidateTiles: totalCandidates,
  totalTiles,
  bothCensusesComplete: bothComplete,
  // The verdict leads with COMPLETENESS, because a candidate count taken from a
  // half-resident scene is not a small error — it is a different scene.
  verdict: !bothComplete
    ? `INCOMPLETE — a census did not stabilise with every tile tagged (ground untagged=${ground.untagged}, first untagged=${first.untagged}). Any count below is a LOWER BOUND on a partially-resident scene, not a measurement.`
    : totalCandidates > 0
      ? `${totalCandidates} of ${totalTiles} tile(s) are refused for alpha alone and have a min-grid — the per-cell split could convert exactly those, and nothing else. Weigh that count against the cost of turning one draw per tile into two before building it.`
      : 'NOT WORTH BUILDING ON THIS MAP — zero tiles are refused for alpha with a min-grid present; every non-interior tile is excluded on grounds a finer alpha split cannot change',
};
console.log('[s1a] VERDICT:', JSON.stringify(summary, null, 2));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 's1a-candidates-result.json'),
  JSON.stringify({ summary, consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40) }, null, 2)
);
console.log('[s1a] wrote s1a-candidates-result.json');

await context.close();
