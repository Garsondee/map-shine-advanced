#!/usr/bin/env node
/**
 * tools/lab/wind-plume.mjs — how far each fire's smoke and flame lean with the wind, on Lab · Wind (mmp-vm1.1.6).
 *
 *   node tools/lab/wind-plume.mjs --name labe --label before [--living 0|1] [--speeds 0,0.036,0.071,0.15,0.25]
 *        [--fires fireField,fireLee,...] [--seconds 6] [--settle 12] [--dwell 3] [--out <dir>]
 *
 * Runs `wind-plume-page.js` in the lab client (it centres the view on each fire at each dial speed and samples the billow
 * engine's plume meter) and saves `<out>/<label>.json`. `wind-plume.py` turns runs into lean angles. Run it under the rig lock.
 *
 * @module tools/lab/wind-plume
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windFires } from './wind-spec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const label = opt('label', 'run');
const outDir = path.resolve(opt('out', path.join(HERE, 'out', 'wind', 'plume')));
fs.mkdirSync(outDir, { recursive: true });
const living = opt('living', null);
const pick = opt('fires', null);
const fires = windFires()
  .filter((f) => !pick || pick.split(',').includes(f.key))
  .map((f) => ({ key: f.key, x: f.x, y: f.y }));
const args = {
  fires,
  speeds: opt('speeds', '0,0.036,0.071,0.15,0.25').split(',').map(Number),
  directionDeg: Number(opt('direction', 90)),
  seconds: Number(opt('seconds', 6)),
  hz: Number(opt('hz', 10)),
  settleSec: Number(opt('settle', 12)),
  dwellSec: Number(opt('dwell', 3)),
  ...(living === null ? {} : { livingWind: living === '1' }),
};
const page = path.join(outDir, '.wind-plume-page.run.js');
fs.writeFileSync(
  page,
  `${fs.readFileSync(path.join(HERE, 'wind-plume-page.js'), 'utf8')}\nreturn await windPlumePage(args);\n`
);
const r = spawnSync(
  process.execPath,
  [
    path.join(REPO, 'tools', 'foundry-cdp', 'cdp.mjs'),
    'eval',
    '--name',
    opt('name', 'labe'),
    '--file',
    page,
    '--args',
    JSON.stringify(args),
    '--timeout',
    String(30 * 60 * 1000),
  ],
  { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
);
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
const data = JSON.parse(r.stdout);
data.label = label;
data.args = args;
fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(data));
console.log(JSON.stringify({ label, runs: data.runs?.length ?? 0, living: data.living?.enabled ?? null }));
