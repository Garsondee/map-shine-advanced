#!/usr/bin/env node
/**
 * tools/test-world/foundry-parity-darkness.mjs — scene darkness parity sweep (mmp-ynr.3).
 *
 * Real Foundry, never the shader lab (Ingram, 2026-11-07). Same rig and scene as foundry-parity.mjs
 * ('MSA Test - Light Matrix'), but instead of one shot it sweeps the SCENE'S OWN darkness (a real
 * `scene.update`, what a GM's slider does) and compares native Foundry against MSA at each step:
 *
 *   node tools/test-world/foundry-parity-darkness.mjs --client gm [--out <dir>]
 *        [--darkness 0,0.25,0.5,0.75,1] [--msa-hour 12]
 *        [--global-light <max>[:<luminosity>[:bright]]]   e.g. 0.5 = Global Illumination on for darkness 0..0.5
 *        [--region <mode>:<modifier>]                      an Adjust Darkness Level region over the left half;
 *                                                          mode 0 override, 1 brighten, 2 darken
 *        [--keep-sky]   keep the scene's own MSA sky realism / grade (default: set to the parity defaults, 0)
 *
 * MSA's clock is left at --msa-hour (default 12, noon) so the scene's darkness, not MSA's night, is what is
 * being tested. Per step it measures every light cell (r=300 world px, like foundry-parity.mjs) and every
 * unlit GAP between two neighbouring lights (r=40, 400 px from both: pure ambient), in both renderers.
 * Writes native-dNNN.png, msa-dNNN.png and report.json. Restores the scene's environment, the effect
 * switches and the region at the end.
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
const log = (...a) => console.error('[parity-darkness]', ...a);
const SCENE = 'MSA Test - Light Matrix';
const PITCH = 800;
const REGION_NAME = 'MSA parity darkness region (temporary)';

async function settled(page, sec = 240) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < sec) {
    const ok = await page
      .evaluate(async () => {
        if (!globalThis.game?.ready || !globalThis.canvas?.ready) return false;
        if (game.settings.get('map-shine-advanced', 'msaEnabled') === false) return true;
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
    const fit = Math.min(globalThis.innerWidth / d.sceneWidth, globalThis.innerHeight / d.sceneHeight) * 0.95;
    await canvas.animatePan({
      x: d.sceneX + d.sceneWidth / 2,
      y: d.sceneY + d.sceneHeight / 2,
      scale: Math.min(0.2, fit),
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

/** Light cells (r=300) and the unlit gaps half a pitch to the right of each light (r=40), in screen px. */
async function samplePoints(page) {
  return page.evaluate((pitch) => {
    const W = canvas.dimensions.sceneWidth;
    const s = canvas.stage.scale.x;
    const toScreen = (x, y) => canvas.stage.worldTransform.apply({ x, y });
    const cells = [];
    const gaps = [];
    for (const l of canvas.scene.lights.contents) {
      const id = l.flags?.['map-shine-advanced']?.testFixtureId ?? l.id;
      const p = toScreen(l.x, l.y);
      cells.push({ id, worldX: l.x, x: p.x, y: p.y, r: 300 * s });
      if (l.x + pitch < W) {
        const g = toScreen(l.x + pitch / 2, l.y);
        gaps.push({ id: `gap-right-of-${id}`, worldX: l.x + pitch / 2, x: g.x, y: g.y, r: 40 * s });
      }
    }
    const order = (a, b) => a.y - b.y || a.x - b.x;
    return { cells: cells.sort(order), gaps: gaps.sort(order), sceneWidth: W };
  }, PITCH);
}

function stats(png, c) {
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
  const rgb = sum.map((v) => (n ? v / n : 0));
  return { rgb: rgb.map((v) => Math.round(v)), lum: Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

function parseGlobalLight(v) {
  if (!v) return null;
  const [max, lum, bright] = String(v).split(':');
  return {
    enabled: true,
    darkness: { min: 0, max: Number(max) },
    luminosity: Number(lum ?? 0),
    bright: bright === 'bright',
  };
}

async function main() {
  const client = String(opt('client', 'gm'));
  const darknessList = String(opt('darkness', '0,0.25,0.5,0.75,1')).split(',').map(Number);
  const msaHour = Number(opt('msa-hour', 12));
  const globalLight = parseGlobalLight(opt('global-light', null));
  const regionArg = opt('region', null);
  const keepSky = argv.includes('--keep-sky');
  const region = regionArg
    ? { mode: Number(regionArg.split(':')[0]), modifier: Number(regionArg.split(':')[1]) }
    : null;
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'foundry-cdp', 'clients.json'), 'utf8'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = opt('out', path.join(REPO, 'tests', 'playwright-artifacts', 'foundry-parity-darkness', stamp));
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${reg[client].port}`);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes('/game'));

  const view = () =>
    page.evaluate(async (name) => {
      await game.scenes.getName(name).view();
      if (!game.paused) await game.togglePause(true, true);
    }, SCENE);
  const reloadWith = async (msaOn) => {
    await page.evaluate((on) => game.settings.set('map-shine-advanced', 'msaEnabled', on), msaOn);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settled(page);
    await view();
    await settled(page);
  };
  const setDarkness = (d) =>
    page.evaluate(async ({ name, d }) => game.scenes.getName(name).update({ environment: { darknessLevel: d } }), {
      name: SCENE,
      d,
    });

  const saved = await page.evaluate((name) => {
    const s = game.scenes.getName(name);
    const keys = [...game.settings.settings.keys()].filter(
      (k) => k.startsWith('map-shine-advanced.') && k.endsWith('.gmEnable')
    );
    return {
      environment: foundry.utils.deepClone(s._source.environment),
      sky: foundry.utils.deepClone(s._source.flags?.['map-shine-advanced']?.sky ?? null),
      switches: Object.fromEntries(
        keys.map((k) => [k, game.settings.get('map-shine-advanced', k.slice('map-shine-advanced.'.length))])
      ),
    };
  }, SCENE);

  try {
    // Scene setup shared by both renderers: Global Illumination and the region.
    await page.evaluate(
      async ({ name, globalLight, region, regionName }) => {
        const s = game.scenes.getName(name);
        await s.update({ environment: { globalLight: globalLight ?? { enabled: false } } });
        for (const r of s.regions.filter((x) => x.name === regionName)) await r.delete();
        if (region) {
          const d = s.dimensions;
          await s.createEmbeddedDocuments('Region', [
            {
              name: regionName,
              shapes: [{ type: 'rectangle', x: 0, y: 0, width: d.sceneWidth / 2, height: d.sceneHeight }],
              behaviors: [{ type: 'adjustDarknessLevel', system: { mode: region.mode, modifier: region.modifier } }],
            },
          ]);
        }
      },
      { name: SCENE, globalLight, region, regionName: REGION_NAME }
    );

    const shots = {};
    // NATIVE: MSA off for this client, Foundry draws.
    await reloadWith(false);
    await frame(page);
    const pts = await samplePoints(page);
    for (const d of darknessList) {
      await setDarkness(d);
      await sleep(2500);
      const f = path.join(out, `native-d${String(Math.round(d * 100)).padStart(3, '0')}.png`);
      await shot(page, f);
      shots[d] = { native: f };
    }
    // MSA: every effect's GM switch off, clear sky, clock at --msa-hour.
    await page.evaluate(async (sw) => {
      for (const k of Object.keys(sw))
        await game.settings.set('map-shine-advanced', k.slice('map-shine-advanced.'.length), 'off');
    }, saved.switches);
    // MSA's own sky light and environment grade back to their parity defaults (0): a scene that was once
    // given a Look keeps realism/grade in its flags, which lift and tint noon (the matrix had realism 0.79).
    if (saved.sky && !keepSky)
      await page.evaluate(
        (name) =>
          game.scenes
            .getName(name)
            .setFlag('map-shine-advanced', 'sky', { realism01: 0, gradeEnvStrength: 0, moonlight01: 0 }),
        SCENE
      );
    await reloadWith(true);
    await page.evaluate(async (hour) => {
      MapShine.fadeWeatherToArchetype?.('clear', 0);
      await MapShine.setTimeOfDay?.(hour, 0);
    }, msaHour);
    await frame(page);
    for (const d of darknessList) {
      await setDarkness(d);
      await sleep(3500);
      const f = path.join(out, `msa-d${String(Math.round(d * 100)).padStart(3, '0')}.png`);
      await shot(page, f);
      shots[d].msa = f;
      shots[d].msaEnv = await page
        .evaluate(async () => {
          const r = await MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
          const v = (typeof r === 'string' ? JSON.parse(r) : r)?.envSnapshot;
          return {
            msaDarkness01: v?.env?.darkness01 ?? null,
            authoredDarkness01: v?.authoredDarkness01 ?? null,
            foundryDarkness01: v?.foundryDarkness01 ?? null,
            publishedDarkness01: v?.publishedDarkness01 ?? null,
          };
        })
        .catch(() => null);
    }

    const steps = darknessList.map((d) => {
      const nat = PNG.sync.read(fs.readFileSync(shots[d].native));
      const msa = PNG.sync.read(fs.readFileSync(shots[d].msa));
      const row = (c) => {
        const a = stats(nat, c);
        const b = stats(msa, c);
        return { id: c.id, worldX: c.worldX, native: a, msa: b, lumDiff: b.lum - a.lum };
      };
      const cells = pts.cells.map(row);
      const gaps = pts.gaps.map(row);
      const half = pts.sceneWidth / 2;
      const side = (rows, left) => rows.filter((r) => r.worldX < half === left);
      const sum = (rows) => ({
        nativeMedianLum: median(rows.map((r) => r.native.lum)),
        msaMedianLum: median(rows.map((r) => r.msa.lum)),
        medianAbsDiff: median(rows.map((r) => Math.abs(r.lumDiff))),
      });
      return {
        darkness: d,
        msaEnv: shots[d].msaEnv,
        summary: {
          cells: sum(cells),
          gaps: sum(gaps),
          ...(region ? { gapsInRegion: sum(side(gaps, true)), gapsOutsideRegion: sum(side(gaps, false)) } : {}),
        },
        cells,
        gaps,
      };
    });
    const report = {
      scene: SCENE,
      msaHour,
      globalLight,
      region,
      note: 'cells: mean over r=300 world px around each light; gaps: r=40 at the midpoint between two lights (unlit). 0-255 sRGB screen values.',
      steps,
    };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    for (const s of steps) {
      const c = s.summary.cells;
      const g = s.summary.gaps;
      log(
        `darkness ${s.darkness.toFixed(2)}  cells native ${c.nativeMedianLum} msa ${c.msaMedianLum} (|d| ${c.medianAbsDiff})` +
          `  gaps native ${g.nativeMedianLum} msa ${g.msaMedianLum} (|d| ${g.medianAbsDiff})` +
          (s.summary.gapsInRegion
            ? `  region gaps native ${s.summary.gapsInRegion.nativeMedianLum} msa ${s.summary.gapsInRegion.msaMedianLum}`
            : '') +
          `  msa env ${JSON.stringify(s.msaEnv)}`
      );
    }
    process.stdout.write(JSON.stringify({ out, steps: steps.length }, null, 2) + '\n');
  } finally {
    await page
      .evaluate(
        async ({ name, saved, regionName }) => {
          for (const [k, v] of Object.entries(saved.switches))
            await game.settings.set('map-shine-advanced', k.slice('map-shine-advanced.'.length), v);
          const s = game.scenes.getName(name);
          for (const r of s.regions.filter((x) => x.name === regionName)) await r.delete();
          await s.update({ environment: saved.environment });
          if (saved.sky) await s.setFlag('map-shine-advanced', 'sky', saved.sky);
          await game.settings.set('map-shine-advanced', 'msaEnabled', true);
        },
        { name: SCENE, saved, regionName: REGION_NAME }
      )
      .catch((e) => log('restore failed', e?.message ?? e));
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  log(e?.message ?? e);
  process.exit(1);
});
