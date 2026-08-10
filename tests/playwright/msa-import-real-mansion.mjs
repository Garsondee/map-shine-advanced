/**
 * ONE-OFF IMPORT RUNNER — builds the real "Mythica Machina Mansion" scene in the bench
 * Foundry from the texture-remapped export (see mansion-redux-remapped.json, produced by a
 * generic path-remap pass over mansion_example_map/mythica-machina-mansion-redux/info.json).
 *
 * Not a Playwright *test* (no `test()` wrapper) — this is a scripted one-time action, run
 * directly with `node`, reusing the SAME persistent Chrome profile and connection helpers as
 * msa-look.spec.js so it inherits an already-logged-in Bench session where possible.
 *
 * Deliberately does the import via the browser's own `fetch()` + dynamic `import()` of
 * tools/scene-import.mjs, rather than passing the ~500KB export as a page.evaluate() argument
 * — both files are already reachable through Foundry's own static file server once serving
 * the map-shine-advanced module (proven earlier this session for the level background art).
 */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from './foundry-launcher.js';
import { bestEffortLogin, waitForGameReady } from './map-shine-utils.js';

const PROFILE_DIR = process.env.MSA_LOOK_PROFILE
  || path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');

if (!process.env.FOUNDRY_USER_NAME && !process.env.FOUNDRY_USER_ID) {
  process.env.FOUNDRY_USER_NAME = 'Bench';
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1600, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check']
  });
  const page = context.pages()[0] || (await context.newPage());
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 500)));

  const launcher = new FoundryLauncher({ headless: true });
  await launcher.start();

  try {
    await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
    await bestEffortLogin(page);
    await waitForGameReady(page);

    const before = await page.evaluate(() => (window.game?.scenes?.contents ?? []).map((s) => ({ id: s.id, name: s.name, active: s.active })));
    console.log('[import] scenes before:', JSON.stringify(before));

    // Retire any prior "Mythica Machina Mansion" scenes in this bench world — earlier
    // proof-of-mechanism runs and a failed import attempt (defaultLevel0000 collision, now
    // fixed in tools/scene-import.mjs) both left stale scenes under this exact name.
    const retired = await page.evaluate(async () => {
      const stale = window.game.scenes.contents.filter((s) => s.name === 'Mythica Machina Mansion');
      const ids = stale.map((s) => s.id);
      for (const s of stale) await s.delete();
      return ids;
    });
    if (retired.length) console.log('[import] retired stale scene(s):', JSON.stringify(retired));

    const result = await page.evaluate(async () => {
      const origin = window.location.origin;
      const expRes = await fetch(`${origin}/modules/map-shine-advanced/tests/playwright-artifacts/look/mansion-redux-remapped.json`);
      if (!expRes.ok) return { ok: false, reason: `fetch export failed: ${expRes.status} ${expRes.statusText}` };
      const exportJson = await expRes.json();
      const mod = await import(`${origin}/modules/map-shine-advanced/tools/scene-import.mjs`);
      return mod.importSceneExport({ exportJson, sceneName: 'Mythica Machina Mansion' });
    });

    console.log('[import] result:', JSON.stringify(result));
    if (!result?.ok) throw new Error(`import failed: ${result?.reason}`);

    await page.evaluate(async (sceneId) => {
      const scene = window.game.scenes.get(sceneId);
      if (!scene) throw new Error('imported scene not found by id after creation');
      await scene.activate();
    }, result.sceneId);

    const after = await page.evaluate(() => ({
      active: window.game?.scenes?.active ? { id: game.scenes.active.id, name: game.scenes.active.name } : null,
      count: (window.game?.scenes?.contents ?? []).length
    }));
    console.log('[import] active scene now:', JSON.stringify(after));
    console.log('[import] DONE');
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('[import] FAILED:', err?.stack || err);
  process.exitCode = 1;
});
