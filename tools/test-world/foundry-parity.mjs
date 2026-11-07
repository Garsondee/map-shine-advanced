#!/usr/bin/env node
/**
 * tools/test-world/foundry-parity.mjs — Foundry lighting parity harness (mmp-ynr.1).
 *
 * Real Foundry, never the shader lab (Ingram, 2026-11-07). On 'MSA Test - Light Matrix' (one cell per
 * Foundry light setting / animation type, tools/test-world/fixture.mjs) it captures the SAME camera twice:
 *   1. NATIVE: the client setting `msaEnabled` off, page reloaded, Foundry draws it.
 *   2. MSA: enabled again, every MSA effect's GM switch Off (make-test-world neutral --effects off), clear sky.
 * Animated lights are frozen by pausing the game for both shots (Foundry animates on its own ticker, so
 * animated cells are compared on their average look, not frame by frame: noted per cell).
 * Then each cell (pitch 800 px) is compared: mean luminance and mean RGB in a circle around the light.
 *
 *   node tools/test-world/foundry-parity.mjs --client gm [--out <dir>]
 *
 * Writes native.png, msa.png, side-by-side.jpg (via python if present) and report.json with per-cell numbers.
 * Restores the effect switches and the scene flag at the end.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[parity-foundry]', ...a);
const SCENE = 'MSA Test - Light Matrix';

async function settled(page, sec = 240) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < sec) {
    const ok = await page
      .evaluate(async () => {
        if (!globalThis.game?.ready || !globalThis.canvas?.ready) return false;
        // MSA's real switch is the per-client `msaEnabled` setting (the scene's `enabled` flag is a V2 leftover).
        const enabled = game.settings.get('map-shine-advanced', 'msaEnabled') !== false;
        if (!enabled) return true; // native: Foundry's canvas is ready
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

async function frame(page) {
  await page.evaluate(async () => {
    const d = canvas.dimensions;
    await canvas.animatePan({
      x: d.sceneX + d.sceneWidth / 2,
      y: d.sceneY + d.sceneHeight / 2,
      scale: 0.2,
      duration: 0,
    });
  });
  await sleep(4000);
}

async function shot(page, file) {
  const style = await page.addStyleTag({
    content:
      '#interface, #pause, #notifications, #tooltip, #msa-remote, .app, .application, .window-app { visibility: hidden !important; }',
  });
  await page.screenshot({ path: file });
  await style.evaluate((el) => el.remove());
}

/** Screen positions of each light (after framing), with its fixture id and animation type. */
async function lightCells(page) {
  return page.evaluate(() =>
    canvas.scene.lights.contents
      .map((l) => {
        const p = canvas.stage.worldTransform.apply({ x: l.x, y: l.y });
        const r = 300 * canvas.stage.scale.x; // inside the dim radius at pitch 800
        return {
          id: l.flags?.['map-shine-advanced']?.testFixtureId ?? l.id,
          anim: l.config.animation?.type ?? null,
          x: p.x,
          y: p.y,
          r,
        };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x)
  );
}

function cellStats(png, c) {
  let n = 0;
  const sum = [0, 0, 0];
  const r2 = c.r * c.r;
  for (let y = Math.max(0, Math.floor(c.y - c.r)); y < Math.min(png.height, c.y + c.r); y++) {
    for (let x = Math.max(0, Math.floor(c.x - c.r)); x < Math.min(png.width, c.x + c.r); x++) {
      if ((x - c.x) ** 2 + (y - c.y) ** 2 > r2) continue;
      const i = (y * png.width + x) * 4;
      sum[0] += png.data[i];
      sum[1] += png.data[i + 1];
      sum[2] += png.data[i + 2];
      n++;
    }
  }
  const rgb = sum.map((s) => (n ? s / n : 0));
  return { rgb: rgb.map((v) => Math.round(v)), lum: Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) };
}

async function main() {
  const client = String(opt('client', 'gm'));
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'foundry-cdp', 'clients.json'), 'utf8'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = opt('out', path.join(REPO, 'tests', 'playwright-artifacts', 'foundry-parity', stamp));
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${reg[client].port}`);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes('/game'));
  const setEnabled = (on) =>
    page.evaluate(
      async ({ name, on }) => {
        // Per-client MSA switch (takes effect on reload); the scene's `enabled` flag is ignored by MSA.
        await game.settings.set('map-shine-advanced', 'msaEnabled', on);
        await game.scenes.getName(name).view();
        if (!game.paused) await game.togglePause(true, true);
      },
      { name: SCENE, on }
    );
  const before = await page.evaluate(() => {
    const keys = [...game.settings.settings.keys()].filter(
      (k) => k.startsWith('map-shine-advanced.') && k.endsWith('.gmEnable')
    );
    return Object.fromEntries(
      keys.map((k) => [k, game.settings.get('map-shine-advanced', k.slice('map-shine-advanced.'.length))])
    );
  });
  try {
    // NATIVE
    await setEnabled(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settled(page);
    await page.evaluate((name) => game.scenes.getName(name).view(), SCENE);
    await settled(page);
    await frame(page);
    const cells = await lightCells(page);
    await shot(page, path.join(out, 'native.png'));
    // MSA, effects off
    await setEnabled(true);
    await page.evaluate(async (before) => {
      for (const k of Object.keys(before))
        await game.settings.set('map-shine-advanced', k.slice('map-shine-advanced.'.length), 'off');
    }, before);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settled(page);
    await page.evaluate((name) => game.scenes.getName(name).view(), SCENE);
    await settled(page);
    await page.evaluate(() => {
      MapShine.fadeWeatherToArchetype?.('clear', 0);
    });
    await frame(page);
    await shot(page, path.join(out, 'msa.png'));
    const nat = PNG.sync.read(fs.readFileSync(path.join(out, 'native.png')));
    const msa = PNG.sync.read(fs.readFileSync(path.join(out, 'msa.png')));
    const rows = cells.map((c) => {
      const a = cellStats(nat, c);
      const b = cellStats(msa, c);
      return { id: c.id, anim: c.anim, native: a, msa: b, lumDiff: b.lum - a.lum };
    });
    const report = {
      scene: SCENE,
      note: 'Mean over a circle of r=300 world px around each light; 0-255 sRGB screen values. Animated lights compared on a paused frame.',
      rows,
    };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    for (const r of rows)
      log(
        `${r.id.padEnd(22)} native ${String(r.native.lum).padStart(3)}  msa ${String(r.msa.lum).padStart(3)}  diff ${r.lumDiff}`
      );
    process.stdout.write(JSON.stringify({ out, cells: rows.length }, null, 2) + '\n');
  } finally {
    // Restore switches and the scene flag.
    await page.evaluate(async (before) => {
      for (const [k, v] of Object.entries(before))
        await game.settings.set('map-shine-advanced', k.slice('map-shine-advanced.'.length), v);
    }, before);
    await setEnabled(true).catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  log(e?.message ?? e);
  process.exit(1);
});
