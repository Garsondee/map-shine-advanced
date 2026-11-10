#!/usr/bin/env node
/**
 * tools/lab/water-look.mjs — look at Lab · Water (or a real map) under named conditions.
 *
 *   node tools/lab/water-look.mjs --name lab --views A,B1,B2boats [--tag base] [--wind 0.2 --winddir 90]
 *        [--hour 12] [--params '{"depthScalePx":16}'] [--debug 9] [--settle 4000] [--size 2400x1350]
 *        [--scene <id>] [--at x,y,scale]   (a real map: --scene id + --at scene-px centre and zoom)
 *        [--probes]                        (probe the views' named points with MapShine.probe)
 *
 * For each view: pan, settle, wait for MSA's ready flag, hide Foundry's UI, take a screenshot at
 * the given viewport size (out/water/<tag>-<view>.png), then optionally probe. Water params go
 * through MapShine.setWaterLive (transient, never written to the scene); every key set here is
 * cleared again at the end. Wind / hour are set with MapShine.setWind / setSunHour.
 *
 * Runs under the rig lock (rig-lock.mjs) like lab.mjs look.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WATER_IDS, WATER_VIEWS, waterProbes } from './water-spec.mjs';
import { withRigLock } from './rig-lock.mjs';
/** --flat: only the effects that bend or draw over the picture (the full Measure set blanks the dry art here). */
const MEASURE_OFF = Object.freeze(['lens', 'grid']);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

function cdpPort(name) {
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'foundry-cdp', 'clients.json'), 'utf8'));
  if (!reg[name]) throw new Error(`no cdp client named ${name}`);
  return reg[name].port;
}

const HIDE_UI =
  '#interface, #pause, #notifications, #tooltip, #msa-remote, [id^=msa-studio], .app, .application, .window-app, #loading, [data-msa-probe-overlay] { visibility: hidden !important; }';

async function main() {
  const name = opt('name', 'lab');
  const tag = opt('tag', 'look');
  const settle = Number(opt('settle', 4000));
  const [vw, vh] = opt('size', '2400x1350').split('x').map(Number);
  const params = JSON.parse(opt('params', '{}'));
  const wind = opt('wind');
  const windDir = Number(opt('winddir', 90));
  const hour = opt('hour');
  const debug = opt('debug');
  const measure = flag('flat') || flag('measure');
  const sceneId = opt('scene', WATER_IDS.scene);
  const at = opt('at');
  const views = at
    ? [{ key: opt('view', 'at'), ...(([x, y, s]) => ({ cx: +x, cy: +y, scale: +s }))(at.split(',')) }]
    : opt('views', 'overview')
        .split(',')
        .map((k) => {
          if (!WATER_VIEWS[k]) throw new Error(`no view ${k}; known: ${Object.keys(WATER_VIEWS).join(',')}`);
          return { key: k, ...WATER_VIEWS[k] };
        });
  const outDir = path.join(HERE, 'out', 'water');
  fs.mkdirSync(outDir, { recursive: true });

  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort(name)}`);
  const results = [];
  try {
    const page = browser
      .contexts()
      .flatMap((x) => x.pages())
      .find((p) => p.url().includes('/game'));
    if (!page) throw new Error('no /game page');
    const vp0 = page.viewportSize();
    if (!vp0 || vp0.width !== vw || vp0.height !== vh) {
      await page.setViewportSize({ width: vw, height: vh });
      await page.waitForTimeout(1500);
    }
    const setup = await page.evaluate(
      async ({ sceneId, params, wind, windDir, hour, debug, off }) => {
        if (canvas.scene?.id !== sceneId) {
          await game.scenes.get(sceneId).view();
          await new Promise((r) => setTimeout(r, 6000));
        }
        for (const id of off) MapShine.forceEffect(id, false);
        const gm = canvas.interface?.grid?.mesh;
        if (gm && off.length) gm.visible = false;
        const out = {};
        if (Object.keys(params).length) out.live = MapShine.setWaterLive(params);
        if (wind != null) out.wind = await MapShine.setWind({ speed01: Number(wind), directionDeg: windDir });
        if (hour != null) out.hour = MapShine.setSunHour(Number(hour));
        if (debug != null) out.debug = MapShine.setWaterDebug(Number(debug));
        return { scene: canvas.scene?.name, ...JSON.parse(JSON.stringify(out ?? {})) };
      },
      { sceneId, params, wind, windDir, hour, debug, off: measure ? MEASURE_OFF : [] }
    );
    if (measure) {
      // mmp-78u.7 workaround (as lab-look.mjs): nudge the viewport so present rebinds to the live lit target.
      const vp = page.viewportSize();
      await page.setViewportSize({ width: vp.width - 2, height: vp.height });
      await page.waitForTimeout(600);
      await page.setViewportSize(vp);
      await page.waitForTimeout(6000);
    }
    console.error(`[water-look] ${setup.scene}: ${JSON.stringify(setup).slice(0, 300)}`);

    for (const v of views) {
      await page.evaluate(async ({ cx, cy, scale }) => {
        const d = canvas.dimensions;
        await canvas.animatePan({ x: d.sceneX + cx, y: d.sceneY + cy, scale, duration: 0 });
      }, v);
      await page.waitForTimeout(settle);
      await page.evaluate(async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 120000 && !globalThis.MapShine?.getSceneReady?.()?.ready) {
          await new Promise((r) => setTimeout(r, 500));
        }
      });
      const style = await page.addStyleTag({ content: HIDE_UI });
      await page.waitForTimeout(250);
      const file = path.join(outDir, `${tag}-${v.key}.png`);
      await page.screenshot({ path: file });
      await style.evaluate((el) => el.remove());
      const row = { view: v.key, shot: file };
      if (flag('probes') && sceneId === WATER_IDS.scene) {
        const plot = v.key.replace(/[a-z]+$/, '');
        const pts = waterProbes().filter((p) => p.plot === plot);
        if (pts.length) {
          row.probes = await page.evaluate(async (pts) => {
            const d = canvas.dimensions;
            const r = await MapShine.probe(
              pts.map((p) => ({ name: p.name, x: p.x + d.sceneX, y: p.y + d.sceneY })),
              { markers: false }
            );
            return r.results.map((x, i) => ({
              name: pts[i].name,
              on: x.onScreen,
              presented: x.presented ?? null,
              albedo: x.albedo ?? null,
              water: x.masks?.masks?.water ?? null,
            }));
          }, pts);
        }
      }
      results.push(row);
      console.error(`[water-look] ${v.key} -> ${file}`);
    }
    // Leave the client as we found it: clear every live water key we set, and the debug view.
    await page.evaluate(
      ({ keys, debug, off }) => {
        off.forEach((id) => MapShine.forceEffect(id, null));
        if (keys.length) MapShine.setWaterLive(Object.fromEntries(keys.map((k) => [k, null])));
        if (debug != null) MapShine.setWaterDebug(0);
      },
      { keys: Object.keys(params), debug, off: measure ? MEASURE_OFF : [] }
    );
  } finally {
    await browser.close().catch(() => {});
  }
  const json = path.join(outDir, `${tag}.json`);
  fs.writeFileSync(json, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ tag, json, shots: results.map((r) => r.shot) }));
}

withRigLock(process.env.LAB_OWNER ?? 'water-look', main)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
