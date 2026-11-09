#!/usr/bin/env node
/**
 * tools/lab/wind-fire.mjs — what each fire on Lab · Wind feels, over time (mmp-vm1.1.6).
 *
 *   node tools/lab/wind-fire.mjs --name labe --label after-living [--living 1|0] [--speed 0.15] [--seconds 40]
 *        [--hz 5] [--settle 8] [--out <dir>]
 *
 * Runs `wind-fire-page.js` in the lab client (it samples `MapShine.getFireStatus().billow.weather`: per flame cluster
 * the wind push the billow model got and, on builds that have it, the local air speed and heading) and saves
 * `<out>/<label>.json`. `wind-fire.py` compares labels. Run it under the rig lock.
 *
 * @module tools/lab/wind-fire
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const label = opt('label', 'run');
const outDir = path.resolve(opt('out', path.join(HERE, 'out', 'wind', 'fire')));
fs.mkdirSync(outDir, { recursive: true });
const living = opt('living', null);
const args = {
  seconds: Number(opt('seconds', 40)),
  hz: Number(opt('hz', 5)),
  speed01: Number(opt('speed', 0.15)),
  directionDeg: Number(opt('direction', 90)),
  settleSec: Number(opt('settle', 8)),
  unpause: true,
  ...(living === null ? {} : { livingWind: living === '1' }),
};
const page = path.join(outDir, '.wind-fire-page.run.js');
fs.writeFileSync(
  page,
  `${fs.readFileSync(path.join(HERE, 'wind-fire-page.js'), 'utf8')}\nreturn await windFirePage(args);\n`
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
  ],
  { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
);
if (r.status !== 0) {
  console.error(r.stderr);
  process.exit(1);
}
const data = JSON.parse(r.stdout);
data.label = label;
data.args = args;
fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(data));
console.log(
  JSON.stringify({
    label,
    samples: data.samples,
    clusters: Object.keys(data.series ?? {}).length,
    living: data.living?.enabled ?? null,
  })
);
