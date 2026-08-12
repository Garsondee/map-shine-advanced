/** uAlpha verification capture — does a Tile's Configuration alpha / GM-hidden
 * dim actually reach MSA's rendered pixels?
 *
 * Uses `MapShine.probePixels([{x,y}])` (src/diag/pixel-probe.js) rather than
 * eyeballing screenshots: it reads `buf:scene.color` (the `albedo` buffer)
 * back off the real GPU at the tile's own world position, already decoded to
 * 0..1 rgba, plus `itemsAtPoint` (mesh presence/visibility) for the SAME
 * point — a precise, automatable "did the pixel actually change" signal
 * instead of pixel-hunting a screenshot for a small icon.
 *
 * Progressive JSON write (overwritten after every probe) + the alpha case
 * BEFORE the hidden case: two prior runs of this script crashed the browser
 * partway through a longer update sequence (cause undetermined — see the
 * console log of those runs), so the highest-value comparison must land on
 * disk before anything later has a chance to take the browser down with it.
 *
 * Creates ONE disposable Tile document in the bench world (deleted in
 * `finally`, never touches authored content), textured with Foundry's own
 * bundled default icon — NOT a real scene asset: the mansion has zero
 * authored Tile placeables, so an earlier version of this script that reused
 * `scene.background.src` as a fallback was unknowingly pointing a 700x700
 * placement at a full 12,000px source layer (whole-image mode sizes its
 * load off the IMAGE's own pixel dimensions, not the placed tile's world
 * width/height) and crashed the browser outright.
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

const LABEL = process.argv[2] || 'alpha-verify';
const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const resultPath = path.join(OUT_DIR, `${LABEL}-result.json`);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();

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

const shot = (name) =>
  page.locator('canvas#msa-vt-pan-viewer-canvas').screenshot({ path: path.join(OUT_DIR, `${LABEL}-${name}.png`) }).catch((e) => {
    consoleLines.push(`[screenshot-failed] ${name}: ${String(e)}`);
  });

const state = { label: LABEL, steps: [] };
function save() {
  fs.writeFileSync(resultPath, JSON.stringify({ ...state, consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40) }, null, 2));
}

let tileId = null;

try {
  await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
  await bestEffortLogin(page);
  await waitForGameReady(page);
  await waitForCanvasReady(page);
  await waitForMapShineReady(page);
  await unpauseIfPaused(page);

  console.log(`[${LABEL}] waiting for real map art...`);
  await waitForMapArtLoaded(600000);
  await waitForSceneSettled(page, { label: 'initial' });

  const panelClosed = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === 'Map Shine Advanced'
    );
    if (!titles.length) return { found: false };
    const win = titles[0].closest('.application, .app, [data-appid], .window-app');
    if (!win) return { found: true, closed: false, reason: 'no window container' };
    const btn = win.querySelector('[data-action="close"], .close, .header-button.close, button[title="Close"]');
    if (!btn) return { found: true, closed: false, reason: 'no close button' };
    btn.click();
    return { found: true, closed: true };
  });
  console.log(`[${LABEL}] control panel close attempt:`, JSON.stringify(panelClosed));

  // Orphans from earlier crashed runs of this same script (browser died before
  // their own `finally` cleanup could run) — sweep them before adding a new
  // one. Known ids only: never touch anything this script didn't create.
  const KNOWN_ORPHAN_IDS = ['V10yCbxwpZofnfzd', 'qtKjPhGKM84qeD1X', 'UHa4eKDxldPXZ1Rf', 'eAY9wX5flot89UJv'];
  const sweptOrphans = await page.evaluate(async (ids) => {
    const present = ids.filter((id) => canvas.scene.tiles.get(id));
    if (present.length) await canvas.scene.deleteEmbeddedDocuments('Tile', present);
    return present;
  }, KNOWN_ORPHAN_IDS);
  if (sweptOrphans.length) console.log(`[${LABEL}] swept ${sweptOrphans.length} orphaned tile(s) from earlier crashed runs:`, JSON.stringify(sweptOrphans));

  // MUST decode via createImageBitmap in MSA's whole-image loader — confirmed
  // live (before-fix2 run) that 'icons/svg/mystery-man.svg' throws
  // `InvalidStateError: The source image could not be decoded` there, which
  // silently drops the item out of itemStates entirely (never appears in
  // itemsAtPoint, no mesh, nothing to probe) — NOT the bug under test, just
  // the wrong choice of placeholder. A real small raster asset already
  // bundled with the example map decodes fine and exercises the real path.
  const built = await page.evaluate(async () => {
    const scene = canvas.scene;
    const srcToUse =
      'modules/map-shine-advanced/mansion_example_map/mythica-machina-mansion-redux/assets/crosshead_golden_door_02.webp';
    const rect = canvas.dimensions.sceneRect;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const size = 700;
    const [doc] = await scene.createEmbeddedDocuments('Tile', [
      { texture: { src: srcToUse }, x: cx - size / 2, y: cy - size / 2, width: size, height: size, sort: 999999, alpha: 1, hidden: false },
    ]);
    return { id: doc.id, x: doc.x, y: doc.y, width: doc.width, height: doc.height, cx: doc.x + doc.width / 2, cy: doc.y + doc.height / 2 };
  });
  tileId = built.id;
  console.log(`[${LABEL}] built tile:`, JSON.stringify(built));

  await page.evaluate((p) => canvas.animatePan({ x: p.cx, y: p.cy, scale: 1.2, duration: 300 }), built);
  await page.waitForTimeout(800);
  await waitForSceneSettled(page, { label: 'panned to tile', timeoutMs: 120000 });

  async function probe(label) {
    const r = await page.evaluate(async (p) => {
      const [pt] = await window.MapShine.probePixels([{ x: p.cx, y: p.cy }]);
      return pt;
    }, built);
    const items = r?.itemsAtPoint ?? [];
    const mine = items.find((it) => it.id === `tile:${tileId}`);
    const entry = {
      label,
      at: Date.now(),
      albedoRgba: r?.buffers?.albedo?.rgba ?? null,
      onScreen: r?.onScreen ?? null,
      itemsAtPointIds: items.map((it) => it.id),
      myItem: mine ?? null,
    };
    state.steps.push(entry);
    save();
    console.log(`[${LABEL}] probe(${label}):`, JSON.stringify(entry));
    return entry;
  }

  // Registering as a live item can lag the create-document hook — poll
  // itemsAtPoint directly rather than trusting waitForSceneSettled's
  // counters, which can read "quiet" before a just-created item's own first
  // residency pass has even started (nothing queued yet to count as busy).
  {
    const pollStart = Date.now();
    let seen = false;
    for (let i = 0; i < 30; i++) {
      const r = await page.evaluate(async (p) => {
        const [pt] = await window.MapShine.probePixels([{ x: p.cx, y: p.cy }]);
        return (pt?.itemsAtPoint ?? []).map((it) => it.id);
      }, built);
      console.log(`[${LABEL}] waiting for tile:${tileId} in itemsAtPoint... ${Math.round((Date.now() - pollStart) / 1000)}s saw=${JSON.stringify(r)}`);
      if (r.includes(`tile:${tileId}`)) {
        seen = true;
        break;
      }
      await page.waitForTimeout(1000);
    }
    state.registeredAsLiveItem = seen;
    save();
    if (!seen) console.error(`[${LABEL}] tile:${tileId} NEVER appeared in itemsAtPoint after 30s — proceeding anyway to record whatever the probe shows`);
  }

  async function updateTile(patch, label) {
    await page.evaluate(
      async ({ id, patch }) => {
        await canvas.scene.tiles.get(id).update(patch);
      },
      { id: tileId, patch }
    );
    await page.waitForTimeout(1200);
    await waitForSceneSettled(page, { label, timeoutMs: 120000 });
  }

  // THE CORE COMPARISON — highest priority, captured first.
  await probe('alpha1-baseline');
  await shot('01-alpha1-baseline');

  await updateTile({ alpha: 0 }, 'A alpha=0');
  await probe('alpha0');
  await shot('02-alpha0');

  await updateTile({ alpha: 1 }, 'A alpha=1 restored');
  await probe('alpha1-restored');

  // BONUS — the GM-hidden 50% dim, same mechanism (item.alpha), lower priority.
  await updateTile({ hidden: true }, 'A hidden=true');
  await probe('hidden-true');
  await shot('03-hidden-true');

  await updateTile({ hidden: false }, 'A hidden=false restored');
  await probe('hidden-false-restored');

  console.log(`[${LABEL}] all steps completed`);
} catch (e) {
  console.error(`[${LABEL}] run stopped early:`, e);
  state.error = String(e?.message ?? e);
  save();
} finally {
  if (tileId) {
    try {
      await page.evaluate(async (id) => {
        await canvas.scene.deleteEmbeddedDocuments('Tile', [id]);
      }, tileId);
      console.log(`[${LABEL}] cleaned up temp tile ${tileId}`);
    } catch (e) {
      console.error(`[${LABEL}] FAILED to delete temp tile ${tileId} — manual cleanup needed:`, e);
    }
  }
  await context.close().catch(() => {});
  await launcher.stop();
}
