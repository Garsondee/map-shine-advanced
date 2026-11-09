#!/usr/bin/env node
/**
 * tools/lab/veg-sway.mjs — Lab · Vegetation sway meter (mmp-78u.33).
 *
 *   LAB_RIG=d node tools/lab/veg-sway.mjs --name labd --speeds 0,0.062,0.133,0.221 [--frames 300]
 *        [--dt 33.333] [--dir 90] [--rows A,B,C,D] [--scale 0.2] [--settle 8000] [--gust] [--tag run1]
 *
 * For every wind speed: one capture-clock run (exact dt), each plant's canopy centroid per frame
 * (veg-sway-page.js), then per plant: mean lean (vs the calm run), RMS sway, peak-to-peak, the
 * dominant frequency (Hann-windowed DFT of the detrended along-wind series), and for the B clones
 * the pairwise correlation (lockstep check). Writes out/veg-sway-<tag>.json and prints a table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vegetationPlants, VEG_SIZE } from './vegetation-spec.mjs';
import { withRigLock } from './rig-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const PX_PER_M = 150 / (5 * 0.3048); // 98.4: her maps, 150 px per 5-ft square

/** Hann-windowed DFT magnitude peak of a series sampled every dt seconds, 0.05..maxHz. */
export function dominantHz(series, dt, maxHz = 12) {
  const n = series.length;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  // remove a linear trend so a slow drift does not read as the lowest bin
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - (n - 1) / 2) * (series[i] - mean);
    sxx += (i - (n - 1) / 2) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const x = series.map(
    (v, i) => (v - mean - slope * (i - (n - 1) / 2)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
  );
  let best = { hz: 0, mag: 0 };
  const df = 1 / (n * dt);
  for (let f = Math.max(df, 0.05); f <= Math.min(maxHz, 0.5 / dt); f += df / 4) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += x[i] * Math.cos(2 * Math.PI * f * i * dt);
      im -= x[i] * Math.sin(2 * Math.PI * f * i * dt);
    }
    const mag = Math.hypot(re, im);
    if (mag > best.mag) best = { hz: f, mag };
  }
  return best.hz;
}

export function corr(a, b) {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Turn one page run into per-plant numbers (scene px, m, Hz). */
export function analyse(run, dtSec, dirDeg) {
  const z = run.zoom;
  const rad = (dirDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const res = {};
  for (const key of Object.keys(run.plants)) {
    const pts = run.frames.map((f) => f.m[key]).filter(Boolean);
    if (pts.length < run.frames.length * 0.9) continue;
    const xs = pts.map((p) => p[0] / z);
    const ys = pts.map((p) => p[1] / z);
    const along = xs.map((x, i) => x * ux + ys[i] * uy);
    const across = xs.map((x, i) => -x * uy + ys[i] * ux);
    const stat = (s) => {
      const m = s.reduce((a, b) => a + b, 0) / s.length;
      const rms = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length);
      return { mean: m, rms, p2p: Math.max(...s) - Math.min(...s) };
    };
    const flut = pts.map((p) => p[3]).filter((v) => v != null);
    res[key] = {
      along: stat(along),
      across: stat(across),
      hzAlong: dominantHz(along, dtSec),
      hzAcross: dominantHz(across, dtSec),
      flutter: flut.length ? flut.reduce((a, b) => a + b, 0) / flut.length : null,
      leafPx: Math.round(pts.reduce((a, p) => a + p[2], 0) / pts.length),
      series: { along, across },
      clipped: run.plants[key].clipped,
    };
  }
  return res;
}

async function main() {
  const name = opt('name', 'labd');
  const speeds = opt('speeds', '0,0.062,0.133,0.221').split(',').map(Number);
  const frames = Number(opt('frames', 300));
  const dtMs = Number(opt('dt', 1000 / 30));
  const dirDeg = Number(opt('dir', 90));
  const rows = opt('rows', 'A,B,C,D').split(',');
  const scale = Number(opt('scale', 0.2));
  const tag = opt('tag', `run-${Date.now()}`);
  const plants = vegetationPlants().filter((p) => rows.includes(p.row));
  const ys = plants.map((p) => p.cy);
  const view = { x: VEG_SIZE.w / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, scale };
  if (opt('view')) Object.assign(view, JSON.parse(opt('view')));
  // the page script defines vegSwayPage(args); cdp.mjs eval runs a function BODY, so append the call
  const pageScript = path.join(HERE, 'out', 'veg-sway-page.run.js');
  fs.mkdirSync(path.dirname(pageScript), { recursive: true });
  fs.writeFileSync(
    pageScript,
    `${fs.readFileSync(path.join(HERE, 'veg-sway-page.js'), 'utf8')}
return await vegSwayPage(args);
`
  );
  const runs = [];
  for (const speed01 of speeds) {
    const args = {
      speed01,
      dirDeg,
      frames,
      dtMs,
      settleMs: Number(opt('settle', 8000)),
      view,
      gust: argv.includes('--gust'),
      plants: plants.map((p) => ({ key: p.key, box: p.box })),
    };
    const t0 = Date.now();
    const r = spawnSync(
      'node',
      [
        path.join(REPO, 'tools', 'foundry-cdp', 'cdp.mjs'),
        'eval',
        '--name',
        name,
        '--file',
        pageScript,
        '--args',
        JSON.stringify(args),
      ],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 }
    );
    if (r.status !== 0) throw new Error(`page run failed at speed ${speed01}: ${r.stderr.slice(-800)}`);
    const run = JSON.parse(r.stdout);
    const a = analyse(run, dtMs / 1000, dirDeg);
    runs.push({ speed01, mps: speed01 * 70, zoom: run.zoom, secs: (Date.now() - t0) / 1000, plants: a, raw: run });
    console.error(
      `speed01 ${speed01} (${(speed01 * 70).toFixed(1)} m/s): ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s, zoom ${run.zoom.toFixed(3)}`
    );
  }
  // lean = mean along-wind position minus the calm run's
  const calm = runs.find((r) => r.speed01 === 0);
  const table = [];
  for (const r of runs) {
    for (const [key, p] of Object.entries(r.plants)) {
      const lean = calm?.plants[key] ? p.along.mean - calm.plants[key].along.mean : null;
      table.push({
        mps: r.mps.toFixed(1),
        plant: key,
        leanPx: lean?.toFixed(1),
        rmsAlong: p.along.rms.toFixed(2),
        rmsAcross: p.across.rms.toFixed(2),
        p2pAlong: p.along.p2p.toFixed(1),
        hzAlong: p.hzAlong.toFixed(2),
        hzAcross: p.hzAcross.toFixed(2),
        flutter: p.flutter?.toFixed(2),
      });
    }
    const clones = ['B1', 'B2', 'B3', 'B4', 'B5'].filter((k) => r.plants[k]);
    const cs = [];
    for (let i = 0; i < clones.length; i++)
      for (let j = i + 1; j < clones.length; j++)
        cs.push(corr(r.plants[clones[i]].series.along, r.plants[clones[j]].series.along));
    if (cs.length)
      r.cloneCorr = { mean: cs.reduce((a, b) => a + b, 0) / cs.length, max: Math.max(...cs), min: Math.min(...cs) };
  }
  console.table(table);
  for (const r of runs)
    if (r.cloneCorr)
      console.log(
        `clones @ ${r.mps.toFixed(1)} m/s: corr mean ${r.cloneCorr.mean.toFixed(2)} max ${r.cloneCorr.max.toFixed(2)} min ${r.cloneCorr.min.toFixed(2)}`
      );
  const outDir = path.join(HERE, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `veg-sway-${tag}.json`);
  fs.writeFileSync(file, JSON.stringify({ tag, pxPerM: PX_PER_M, dirDeg, dtMs, frames, runs }, null, 1));
  console.log(`-> ${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await withRigLock(process.env.LAB_OWNER ?? 'veg-lab', main, { waitMin: 30 });
}
