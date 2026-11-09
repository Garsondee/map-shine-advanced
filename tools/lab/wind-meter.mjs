#!/usr/bin/env node
/**
 * tools/lab/wind-meter.mjs — measure the wind field on the MSA Lab rig (mmp-vm1.1, the Wind lab).
 *
 *   node tools/lab/wind-meter.mjs --name labe [--speeds 0.05,0.15,0.3,0.5] [--seconds 60] [--hz 10]
 *        [--snap 5] [--direction 90] [--settle 4] [--points all|WN1,WN2] [--tag run1] [--out <dir>]
 *        [--living 1|0]   (LIVING WIND on / off for the run; absent leaves the client as it is)
 *
 * For each dial speed: unpause, set the wind (direction + speed), let the baked openness/shadow settle, then
 * read the BAKED field back for `--seconds` (`tools/lab/wind-meter-page.js`). One JSON per speed lands in
 * `tools/lab/out/wind/<tag>/speed-<s>.json`; `tools/lab/wind-plot.py <dir>` turns them into PNG plots and a
 * claims table. Run it under the rig lock (`LAB_RIG=e node tools/lab/rig-lock.mjs exec --owner wind-lab -- ...`):
 * it drives the one GM client.
 *
 * @module tools/lab/wind-meter
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windProbes } from './wind-spec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const name = opt('name', 'labe');
const speeds = opt('speeds', '0.05,0.15,0.3,0.5').split(',').map(Number);
const seconds = Number(opt('seconds', 60));
const hz = Number(opt('hz', 10));
const snap = Number(opt('snap', 5));
const direction = Number(opt('direction', 90));
const settle = Number(opt('settle', 4));
const plotsWanted = opt('points', 'all');
const living = opt('living', null); // '1' on, '0' off, absent = leave as is
const tag = opt('tag', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const outDir = path.resolve(opt('out', path.join(HERE, 'out', 'wind', tag)));
fs.mkdirSync(outDir, { recursive: true });

const points = windProbes().filter((p) => plotsWanted === 'all' || plotsWanted.split(',').includes(p.plot));
// The page script defines `windMeterPage(args)`; the call is appended here (a committed page script has no
// top-level return, which lint rejects).
const pageScript = path.join(outDir, '.wind-meter-page.run.js');
fs.writeFileSync(
  pageScript,
  `${fs.readFileSync(path.join(HERE, 'wind-meter-page.js'), 'utf8')}
return await windMeterPage(args);
`
);

for (const s of speeds) {
  const args = {
    points: points.map(({ name: n, x, y, plot }) => ({ name: n, x, y, plot })),
    seconds,
    hz,
    snapEverySec: snap,
    setWind: { directionDeg: direction, speed01: s },
    settleSec: settle,
    unpause: true,
    ...(living === null ? {} : { livingWind: living === '1' }),
  };
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
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
    { cwd: REPO, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    console.error(`speed ${s}: cdp eval failed (${r.status})\n${r.stderr}`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch (err) {
    console.error(`speed ${s}: could not parse the page's answer: ${err.message}\n${r.stdout.slice(0, 500)}`);
    process.exit(1);
  }
  if (!data.ok) {
    console.error(`speed ${s}: ${JSON.stringify(data).slice(0, 800)}`);
    process.exit(1);
  }
  const file = path.join(outDir, `speed-${s.toFixed(3)}.json`);
  fs.writeFileSync(file, JSON.stringify({ speed01: s, directionDeg: direction, ...data }));
  console.log(
    JSON.stringify({
      speed01: s,
      samples: data.t.length,
      snaps: data.snaps.length,
      reads: data.reads,
      repeats: data.repeats,
      wallSec: data.wallSec,
      renderScale: data.renderScale,
      livingWind: data.livingWind?.enabled ?? null,
      grid: `${data.grid.cols}x${data.grid.rows}@${Math.round(data.grid.cellSize)}`,
      ppm: data.ambient.pixelsPerMetre,
      file: path.relative(REPO, file),
      tookSec: Math.round((Date.now() - t0) / 1000),
    })
  );
}
