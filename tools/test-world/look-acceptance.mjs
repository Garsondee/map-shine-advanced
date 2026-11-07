#!/usr/bin/env node
/**
 * tools/test-world/look-acceptance.mjs — the default-look acceptance suite (mmp-ilo.3, mmp-63o.3).
 *
 * "One reliable default look on every map" needs a number, not a screenshot argument. For each test
 * map x time of day x weather, this sets the sky through the SYNCED paths (MapShine.setTimeOfDay,
 * MapShine.fadeWeatherToArchetype), waits for the scene to settle, reads the light meter
 * (MapShine.meter.read: median/p5/p95 EV, crushed/blown/over-white shares) and saves a clean
 * screenshot, then checks each case against the targets below and writes report.json + a summary.
 *
 *   node tools/test-world/look-acceptance.mjs --client gm [--maps all|"Big Bank,Docklands"]
 *        [--times noon,dusk,night] [--weather clear,overcast,steady-rain,thunderstorm,snow,fog]
 *        [--out <dir>]
 *
 * TARGETS are a first draft (2026-11-07), deliberately loose, to be tightened once the one-camera
 * rework (mmp-ilo.1) lands. A case FAILS when the picture is blown out, crushed to black, or its
 * median light sits outside a sane band for its time of day.
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
const log = (...a) => console.error('[look]', ...a);

export const TIMES = Object.freeze({ noon: 12.5, dusk: 18.6, night: 23.5 });

/** First-draft targets per time of day. EV is the meter's: 0 = full daylight on open ground. */
export const TARGETS = Object.freeze({
  noon: { evMedianMin: -4, evMedianMax: 0.5 },
  dusk: { evMedianMin: -7, evMedianMax: -0.5 },
  night: { evMedianMin: -11, evMedianMax: -3 },
  any: { overWhiteMax: 0.03, crushedMax: 0.35 },
});

export const DEFAULT_MAPS = Object.freeze([
  'Mythica Machina - Big Bank (MSA)',
  'Mythica Machina - Docklands Warehouse',
  'Mythica Machina - Clockwork Dungeon',
  "Mythica Machina - Mad Scientist's Compound",
]);

/**
 * Judge one case. Pure, exported for tests.
 * @param {{evMedian:number|null, overWhiteShare:number, crushedShare:number}} m
 * @param {'noon'|'dusk'|'night'} time
 * @returns {{pass: boolean, reasons: string[]}}
 */
export function judgeCase(m, time) {
  const reasons = [];
  const t = TARGETS[time];
  if (m?.evMedian === null || m?.evMedian === undefined) reasons.push('no meter reading');
  else {
    if (m.evMedian < t.evMedianMin) reasons.push(`too dark: median ${m.evMedian} EV < ${t.evMedianMin}`);
    if (m.evMedian > t.evMedianMax) reasons.push(`too bright: median ${m.evMedian} EV > ${t.evMedianMax}`);
  }
  if (m?.overWhiteShare > TARGETS.any.overWhiteMax)
    reasons.push(`blown: ${(m.overWhiteShare * 100).toFixed(1)}% over white`);
  if (m?.crushedShare > TARGETS.any.crushedMax)
    reasons.push(`crushed: ${(m.crushedShare * 100).toFixed(1)}% below -7 EV`);
  return { pass: reasons.length === 0, reasons };
}

async function waitSettled(page, timeoutSec = 300) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    const ok = await page
      .evaluate(async () => {
        const r = await globalThis.MapShine?.debug?.runReport?.('scene-settled');
        const v = typeof r === 'string' ? JSON.parse(r) : r;
        return v?.settled === true;
      })
      .catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

async function main() {
  const client = String(opt('client', 'gm'));
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'foundry-cdp', 'clients.json'), 'utf8'));
  if (!reg[client]) throw new Error(`client "${client}" not booted`);
  const mapsOpt = String(opt('maps', 'all'));
  const maps = mapsOpt === 'all' ? DEFAULT_MAPS : mapsOpt.split(',').map((s) => s.trim());
  const times = String(opt('times', 'noon,dusk,night')).split(',');
  const weathers = String(opt('weather', 'clear,overcast,steady-rain,thunderstorm')).split(',');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = opt('out', path.join(REPO, 'tests', 'playwright-artifacts', 'look-acceptance', stamp));
  fs.mkdirSync(out, { recursive: true });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${reg[client].port}`);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes('/game'));
  const rows = [];
  try {
    for (const mapName of maps) {
      const ok = await page.evaluate(async (n) => {
        const s = game.scenes.getName(n);
        if (!s) return false;
        await s.view();
        return true;
      }, mapName);
      if (!ok) {
        log(`missing scene: ${mapName}`);
        continue;
      }
      await waitSettled(page);
      await page.evaluate(() => {
        if (game.paused) game.togglePause(false);
        canvas.animatePan({
          x: canvas.dimensions.width / 2,
          y: canvas.dimensions.height / 2,
          scale: 0.35,
          duration: 0,
        });
      });
      for (const time of times) {
        for (const weather of weathers) {
          await page.evaluate(
            async ({ hour, weather }) => {
              MapShine.setTimeOfDay(hour, 0);
              MapShine.fadeWeatherToArchetype(weather, 0);
            },
            { hour: TIMES[time], weather }
          );
          await sleep(9000); // weather eases (tau ~20 s at full fade; immediate fades land fast) + DR adapt
          await waitSettled(page, 120);
          const m = await page.evaluate(() => MapShine.meter.read());
          const file = `${mapName.replace(/[^a-z0-9]+/gi, '_')}-${time}-${weather}.png`;
          const style = await page.addStyleTag({
            content:
              '#interface, #pause, #notifications, #tooltip, #msa-remote, .app, .application, .window-app { visibility: hidden !important; }',
          });
          await page.screenshot({ path: path.join(out, file) });
          await style.evaluate((el) => el.remove());
          const verdict = judgeCase(m, time);
          rows.push({ map: mapName, time, weather, ...verdict, meter: m, shot: file });
          log(`${mapName} | ${time} | ${weather}: ${verdict.pass ? 'PASS' : 'FAIL ' + verdict.reasons.join('; ')}`);
        }
      }
    }
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ targets: TARGETS, rows }, null, 2));
    await browser.close().catch(() => {});
  }
  const pass = rows.filter((r) => r.pass).length;
  process.stdout.write(JSON.stringify({ out, cases: rows.length, pass, fail: rows.length - pass }, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    log(e?.message ?? e);
    process.exit(1);
  });
}
