#!/usr/bin/env node
/**
 * tools/lab/weather-frames.mjs <client> <out-dir> [n=12] — n clean screenshots in a row (f0.png ...), the frame
 * stack flicker.py measures (MSA Lab, weather family). Each shot is a separate cdp call (~1 s apart).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [name, out, nArg] = process.argv.slice(2);
if (!name || !out) {
  console.error('usage: weather-frames.mjs <client> <out-dir> [n=12]');
  process.exit(2);
}
const n = Number(nArg ?? 12);
const cdp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'foundry-cdp', 'cdp.mjs');
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (/^f\d+\.png$/.test(f)) fs.unlinkSync(path.join(out, f));
for (let i = 0; i < n; i++) {
  const r = spawnSync('node', [cdp, 'shot', '--name', name, '--clean', '--out', path.join(out, `f${i}.png`)], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`shot ${i} failed: ${r.stderr}`);
}
console.log(fs.readdirSync(out).filter((f) => /^f\d+\.png$/.test(f)).length);
