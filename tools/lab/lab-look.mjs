/**
 * tools/lab/lab-look.mjs — `lab.mjs look`: one command for one look at one plot (mmp-78u).
 *
 * Replaces the 5-call routine (pan, wait, shot, probe, sample) that kept sampling the wrong
 * screen pixel (FRICTION.md #4, #9). It:
 *   1. views the plot's level and pans to the plot (scene coords → canvas via live dimensions),
 *   2. optionally switches to MEASURE view (unsaved forceEffect overrides: no Dynamic Range,
 *      bloom, grade, stylize, lens, grid or fog), waits, then
 *   3. takes a clean screenshot FIRST (probe markers would pollute it), then
 *   4. probes the plot's named world points (spec plotProbes) for albedo / illum / lit, and reads
 *      the screenshot at the SCREEN pixel the probe itself reports, so the two always agree.
 * Overrides are restored at the end unless --keep.
 *
 * ⚠️ WORKAROUND (mmp-78u.7): switching Lens off leaves present reading Lens's last frame. After
 * changing effects we nudge the viewport size, which makes the viewer rebind present to the live
 * lit target. Remove the nudge when mmp-78u.7 is fixed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EFFECTS_FLOORS, IDS, cellRect, effectsPlots, plotProbes } from './lab-spec.mjs';
import { WALLS_IDS, WALL_TYPES, LIGHT_KINDS, wallsCell, wallsProbes } from './walls-spec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));

export const MEASURE_OFF = Object.freeze(['dynamicRange', 'bloom', 'grade', 'stylize', 'lens', 'grid', 'fogOfWar']);

function cdpPort(name) {
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'foundry-cdp', 'clients.json'), 'utf8'));
  if (!reg[name]) throw new Error(`no cdp client named ${name}`);
  return reg[name].port;
}

const toSrgb = (lin) => {
  const c = Math.max(0, Math.min(1, lin));
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
};

export async function look({
  name,
  plot: code,
  level,
  scale = 0.45,
  view = 'shipped',
  waitMs = 6000,
  out,
  keep = false,
}) {
  const { chromium } = require('playwright');
  // Two address forms: an Effects plot code ("C3"), or a Walls cell "W:<wallType>/<lightKind>"
  // (e.g. "W:pattern/lampNear") — any wall type x light kind of Lab · Walls & Windows.
  let target;
  if (String(code).startsWith('W:')) {
    const [wt, lk] = String(code).slice(2).split('/');
    const col = WALL_TYPES.findIndex((t) => t.key === wt);
    const row = LIGHT_KINDS.findIndex((k) => k.key === lk);
    if (col < 0 || row < 0) throw new Error(`no walls cell ${code}`);
    const c = wallsCell(col, row);
    target = {
      sceneId: WALLS_IDS.scene,
      levelId: WALLS_IDS.level,
      letter: 'W',
      cx: c.x + c.s / 2,
      cy: c.y + c.s / 2,
      probes: wallsProbes(col, row),
      tag: `${wt}-${lk}`,
    };
  } else {
    const plot = effectsPlots().find((p) => p.code === code);
    if (!plot) throw new Error(`no plot ${code}`);
    const floor = EFFECTS_FLOORS.find((f) => f.key === (level ?? plot.floor));
    const c = cellRect(plot.col, plot.row);
    target = {
      sceneId: IDS.effectsScene,
      levelId: floor.id,
      letter: floor.letter,
      cx: c.x + c.w / 2,
      cy: c.y + c.h / 2,
      probes: plotProbes(plot),
      tag: code,
    };
  }
  const probes = target.probes;

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort(name)}`);
  try {
    const page = browser
      .contexts()
      .flatMap((x) => x.pages())
      .find((p) => p.url().includes('/game'));
    if (!page) throw new Error('no /game page');

    const state = await page.evaluate(
      async ({ sceneId, levelId, cx, cy, scale, off }) => {
        const scene = game.scenes.get(sceneId);
        if (canvas.scene?.id !== sceneId || canvas.level?.id !== levelId) {
          await scene.view({ level: levelId });
          await new Promise((r) => setTimeout(r, 5000));
        }
        for (const id of off) MapShine.forceEffect(id, false);
        // MSA's grid off hands the lines back to Foundry's own mesh: hide that too in Measure view.
        const gm = canvas.interface?.grid?.mesh;
        if (gm && off.length) gm.visible = false;
        const d = canvas.dimensions;
        await canvas.animatePan({ x: d.sceneX + cx, y: d.sceneY + cy, scale, duration: 0 });
        return { level: canvas.level?.name, view: [globalThis.innerWidth, globalThis.innerHeight] };
      },
      {
        sceneId: target.sceneId,
        levelId: target.levelId,
        cx: target.cx,
        cy: target.cy,
        scale,
        off: view === 'measure' ? MEASURE_OFF : [],
      }
    );
    // mmp-78u.7 workaround: nudge the viewport so present rebinds to the live lit target.
    const vp = page.viewportSize() ?? { width: state.view[0], height: state.view[1] };
    await page.setViewportSize({ width: vp.width - 2, height: vp.height });
    await page.waitForTimeout(500);
    await page.setViewportSize(vp);
    await page.waitForTimeout(waitMs);
    // Wait for MSA's own ready signal (new masks trigger a warm-up screen; FRICTION #20), max 2 min.
    await page.evaluate(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 120000 && !globalThis.MapShine?.getSceneReady?.()?.ready) {
        await new Promise((r) => setTimeout(r, 500));
      }
    });

    const style = await page.addStyleTag({
      content:
        '#interface, #pause, #notifications, #tooltip, #msa-remote, [id^=msa-studio], .app, .application, .window-app, [data-msa-probe-overlay] { visibility: hidden !important; }',
    });
    const file = out ?? path.join(HERE, 'out', 'shots', `look-${target.letter}-${target.tag}-${view}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    await style.evaluate((el) => el.remove());

    // Probe v2 (mmp-78u.12): settled reads, the PRESENTED pixel straight from MSA, and a drift verdict.
    const probed = await page.evaluate(
      async ({ pts }) => {
        const d = canvas.dimensions;
        const r = await MapShine.probe(pts.map((p) => ({ name: p.name, x: p.x + d.sceneX, y: p.y + d.sceneY })));
        return {
          settled: r.settled,
          verdict: r.verdict,
          rows: r.results.map((x) => ({
            on: x.onScreen,
            albedo: x.albedo,
            illum: x.illum,
            lit: x.lit,
            presented: x.presented,
            drift: x.drift ? `${x.drift.maxAbs} ${x.drift.verdict}` : '-',
            dark: x.foundry?.darkness ?? null,
            regions: (x.foundry?.regions ?? []).map((g) => g.behaviors.join('+')).join('; '),
            lights: x.foundry?.lights?.length ?? 0,
            outdoors: x.masks?.masks?.outdoors ?? null,
          })),
        };
      },
      { pts: probes.map(({ name, x, y }) => ({ name, x, y })) }
    );
    const table = probes.map((p, i) => {
      const r = probed.rows[i] ?? {};
      return {
        point: p.name,
        art: p.expectArt.join('/'),
        albedo: r.albedo ? r.albedo.map(toSrgb).join('/') : '-',
        illum: r.illum ? r.illum.map((v) => v.toFixed(3)).join('/') : '-',
        screen: r.presented && r.on ? r.presented.join('/') : 'off-screen',
        drift: r.drift,
        outdoors: r.outdoors,
        dark: r.dark == null ? '-' : Number(r.dark).toFixed(2),
        regions: r.regions || '-',
        lights: r.lights,
      };
    });

    if (!keep && view === 'measure') {
      await page.evaluate((off) => {
        off.forEach((id) => MapShine.forceEffect(id, null));
      }, MEASURE_OFF);
    }
    return {
      plot: code,
      level: state.level,
      view,
      shot: file,
      settled: probed.settled,
      verdict: probed.verdict,
      table,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
