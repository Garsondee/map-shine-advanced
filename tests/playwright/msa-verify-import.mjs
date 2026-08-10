/** Quick post-import sanity check: do the imported cross-references actually resolve? */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from './foundry-launcher.js';
import { bestEffortLogin, waitForGameReady } from './map-shine-utils.js';

const PROFILE_DIR = process.env.MSA_LOOK_PROFILE
  || path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
if (!process.env.FOUNDRY_USER_NAME && !process.env.FOUNDRY_USER_ID) process.env.FOUNDRY_USER_NAME = 'Bench';

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome', headless: false, viewport: { width: 1600, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check']
  });
  const page = context.pages()[0] || (await context.newPage());
  const launcher = new FoundryLauncher({ headless: true });
  await launcher.start();
  try {
    await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
    await bestEffortLogin(page);
    await waitForGameReady(page);

    const report = await page.evaluate(() => {
      const scene = window.game.scenes.active;
      const levels = Array.from(scene.levels.values());
      const ground = levels.find((l) => l.name === 'Ground Floor');
      const first = levels.find((l) => l.name === 'First Floor');
      const asArray = (v) => Array.from(v ?? []);
      const roofTile = scene.tiles.find((t) => t.flags?.['map-shine-advanced']?.overheadIsRoof === true);
      const groundOverheadTile = scene.tiles.find((t) => t.texture?.src?.includes('Ground_Overhead'));
      const sampleWallOnGround = scene.walls.find((w) => asArray(w.levels).includes(ground?.id));
      return {
        sceneName: scene.name,
        sceneId: scene.id,
        groundId: ground?.id,
        groundBg: ground?.background?.src,
        firstId: first?.id,
        firstBg: first?.background?.src,
        firstVisibilityLevels: asArray(first?.visibility?.levels),
        firstVisibilityResolvesToGround: asArray(first?.visibility?.levels).includes(ground?.id),
        roofTileLevels: asArray(roofTile?.levels),
        roofTileSrc: roofTile?.texture?.src,
        roofTileTargetsFirstFloor: asArray(roofTile?.levels).includes(first?.id),
        groundOverheadTileLevels: asArray(groundOverheadTile?.levels),
        sampleWallResolvesToGround: !!sampleWallOnGround,
        wallCount: scene.walls.size,
        lightCount: scene.lights.size,
        regionCount: scene.regions.size,
        tileCount: scene.tiles.size,
        authoredAnchorCount: Object.keys(scene.getFlag('map-shine-advanced', 'authoredAnchors')?.overrides ?? {}).length,
        hasFireMask: !!scene.getFlag('map-shine-advanced', 'paintedMasks')?.['fire::0'],
        hasCameraPath: !!scene.getFlag('map-shine-advanced', 'cameraPath')?.keyframes?.length
      };
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
