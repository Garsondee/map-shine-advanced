#!/usr/bin/env node
/**
 * tools/guide/shoot.mjs — render the guide's map pictures in a real Foundry (mmp-0mv).
 *
 *   node tools/guide/shoot.mjs --name <cdp client> [--only id,id] [--raw <dir>] [--manifest <shots.json>]
 *
 * Reads guide/shots.json. For each shot: opens the scene and floor, sets the time and
 * weather, frames the spot (centre + span as fractions of the scene), waits for Map
 * Shine to settle, and saves a clean screenshot (no Foundry UI) plus the exact map
 * rectangle that is in view. tools/guide/crop.py then cuts the matching plain-art and
 * mask crops, draws the annotations and writes the WebP files into guide/images/.
 *
 * Run it on a PRIVATE rig (tools/test-world), never the live server: it changes the
 * viewed scene, the clock and the weather of the client it drives.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const manifest = JSON.parse(
  fs.readFileSync(path.resolve(opt('manifest', path.join(REPO, 'guide', 'shots.json'))), 'utf8')
);
const only = opt('only') ? new Set(opt('only').split(',')) : null;
const rawDir = path.resolve(opt('raw', path.join(REPO, 'tools', 'guide', 'raw')));
fs.mkdirSync(rawDir, { recursive: true });

function portFor() {
  if (opt('port')) return Number(opt('port'));
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'foundry-cdp', 'clients.json'), 'utf8'));
  const c = reg[opt('name', 'gm')];
  if (!c) throw new Error(`no cdp client "${opt('name', 'gm')}" in tools/foundry-cdp/clients.json`);
  return c.port;
}

/** In-page: open the scene/floor, set the sky, frame the spot, wait for MSA to settle. */
async function frameInPage(shot) {
  const waitSettled = async (ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (MapShine?.getSceneSettle?.()?.settled) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  const scene = game.scenes.find((s) => s.name === shot.scene);
  if (!scene) throw new Error(`no scene "${shot.scene}"`);
  if (canvas.scene?.id !== scene.id) {
    await scene.view();
    await new Promise((r) => setTimeout(r, 1500));
    await waitSettled(180000);
  }
  if (shot.level) {
    const lv = canvas.scene.levels.contents.find((l) => l.name === shot.level || l.id === shot.level);
    if (!lv) throw new Error(`no level "${shot.level}" on ${shot.scene}`);
    if (canvas.level?.id !== lv.id) {
      await canvas.scene.view({ level: lv.id });
      await new Promise((r) => setTimeout(r, 1500));
      await waitSettled(120000);
    }
  }
  if (typeof shot.hour === 'number') MapShine.setSunHour?.(shot.hour);
  if (shot.archetype) MapShine.setWeatherArchetype?.(shot.archetype, 'guide-shoot', { immediate: true });
  if (shot.weather) MapShine.setWeatherTargets?.(shot.weather, { immediate: true });
  if (shot.effects) {
    for (const [setter, patch] of Object.entries(shot.effects)) MapShine[setter]?.(patch);
  }
  // `force`: switch an effect on for this picture only (never written to a setting) — for
  // opt-in effects such as Prism and Iridescence, which are off until a GM turns them on.
  for (const [id, on] of Object.entries(shot.force ?? {})) MapShine.forceEffect?.(id, on);
  // `waterPreset`: render the water with one of its built-in presets (named in the caption).
  if (shot.waterPreset) {
    const fx = await import(new URL('modules/map-shine-advanced/src/effects/index.js', `${location.origin}/`).href);
    const preset = fx.waterPreset?.(shot.waterPreset);
    if (preset) MapShine.setWater?.(preset);
  }
  const r = canvas.dimensions.sceneRect;
  const cx = r.x + shot.center[0] * r.width;
  const cy = r.y + shot.center[1] * r.height;
  const scale = window.innerWidth / (shot.span * r.width);
  await canvas.pan({ x: cx, y: cy, scale, duration: 0 });
  await new Promise((res) => setTimeout(res, 800));
  await waitSettled(60000);
  await new Promise((res) => setTimeout(res, shot.settleMs ?? 4000));
  const s = canvas.stage.scale.x;
  const px = canvas.stage.pivot.x;
  const py = canvas.stage.pivot.y;
  const w = window.innerWidth / s;
  const h = window.innerHeight / s;
  const lv = canvas.level;
  return {
    view: { x: px - w / 2, y: py - h / 2, w, h },
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    art: lv?.background?.src ?? canvas.scene.background?.src ?? null,
    level: lv?.name ?? null,
  };
}

const port = portFor();
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().includes('/game'));
if (!page) throw new Error('no Foundry /game page on that client');
const [vw, vh] = manifest.viewport ?? [1600, 900];
await page.setViewportSize({ width: vw, height: vh });
await sleep(1500);

const CLEAN =
  '#interface, #pause, #notifications, #tooltip, #msa-remote, #msa-guide, [id^=msa-studio], #msa-player, .app, .application, .window-app, #loading, #fps { visibility: hidden !important; }';

for (const shot of manifest.shots) {
  if (only && !only.has(shot.id)) continue;
  process.stderr.write(`[guide-shoot] ${shot.id} …\n`);
  const info = await page.evaluate(frameInPage, shot);
  const style = await page.addStyleTag({ content: CLEAN });
  // Door icons and other canvas controls are drawn on Foundry's canvas, not in the DOM.
  await page.evaluate(() => {
    if (canvas.controls) canvas.controls.visible = false;
  });
  await sleep(400);
  const png = path.join(rawDir, `${shot.id}-msa.png`);
  await page.screenshot({ path: png });
  await page.evaluate((force) => {
    if (canvas.controls) canvas.controls.visible = true;
    for (const id of Object.keys(force ?? {})) MapShine.forceEffect?.(id, null);
  }, shot.force ?? null);
  await style.evaluate((el) => el.remove());
  const uv = {
    u0: (info.view.x - info.rect.x) / info.rect.w,
    v0: (info.view.y - info.rect.y) / info.rect.h,
    u1: (info.view.x + info.view.w - info.rect.x) / info.rect.w,
    v1: (info.view.y + info.view.h - info.rect.y) / info.rect.h,
  };
  fs.writeFileSync(path.join(rawDir, `${shot.id}.json`), JSON.stringify({ ...info, uv }, null, 2));
  process.stderr.write(`[guide-shoot] ${shot.id} ok  art=${info.art}  uv=${JSON.stringify(uv)}\n`);
}
await page.setViewportSize(null).catch(() => {});
await browser.close().catch(() => {});
