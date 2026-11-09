#!/usr/bin/env node
/**
 * tools/lab/wind-strip.mjs — a short strip of frames of one spot on Lab · Wind, for motion you can't see in one still
 * (mmp-9un.5: smoke swinging and reversing; its grain sliding against the wind).
 *
 *   node tools/lab/wind-strip.mjs --port 9394 --x 1800 --y 900 [--w 1400 --h 880] [--speed 0.15] [--direction 90]
 *        [--living 0|1] [--frames 10] [--every 0.5] [--settle 8] --out <dir> --label <name>
 *
 * Centres the view on scene px (x, y) at a zoom that fits w x h, sets the wind, waits, then saves `frames` screenshots
 * `every` seconds apart (Foundry's UI hidden) as `<out>/<label>-NN.png`, and prints their times. Run it under the rig lock.
 *
 * @module tools/lab/wind-strip
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', '..', 'package.json'));
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const port = Number(opt('port', 9394));
const outDir = path.resolve(opt('out', path.join(HERE, 'out', 'wind', 'strip')));
const label = opt('label', 'strip');
const frames = Number(opt('frames', 10));
const every = Number(opt('every', 0.5));
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().includes('/game'));
if (!page) throw new Error(`no /game page on port ${port}`);
const setup = {
  x: Number(opt('x', 1800)),
  y: Number(opt('y', 900)),
  w: Number(opt('w', 1400)),
  h: Number(opt('h', 880)),
  speed01: opt('speed', null) === null ? null : Number(opt('speed', 0)),
  directionDeg: Number(opt('direction', 90)),
  living: opt('living', null),
  settle: Number(opt('settle', 8)),
};
await page.evaluate(async (a) => {
  if (game.paused) game.togglePause(false, { broadcast: true });
  if (a.living !== null) MapShine.setLivingWind(a.living === '1');
  if (a.speed01 !== null) await MapShine.setWind({ directionDeg: a.directionDeg, speed01: a.speed01 });
  const d = canvas.dimensions;
  const scale = Math.min(globalThis.innerWidth / a.w, globalThis.innerHeight / a.h);
  await canvas.animatePan({ x: d.sceneX + a.x, y: d.sceneY + a.y, scale, duration: 0 });
  await new Promise((r) => setTimeout(r, a.settle * 1000));
}, setup);
const style = await page.addStyleTag({
  content:
    '#interface, #pause, #notifications, #tooltip, #msa-remote, [id^=msa-studio], .app, .application, .window-app { visibility: hidden !important; }',
});
const times = [];
const t0 = Date.now();
for (let k = 0; k < frames; k++) {
  const due = t0 + k * every * 1000;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const file = path.join(outDir, `${label}-${String(k).padStart(2, '0')}.png`);
  times.push(((Date.now() - t0) / 1000).toFixed(2));
  await page.screenshot({ path: file });
}
await style.evaluate((el) => el.remove());
await browser.close().catch(() => {});
console.log(JSON.stringify({ label, frames, times }));
