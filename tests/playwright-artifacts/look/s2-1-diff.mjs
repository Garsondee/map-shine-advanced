/** V4-Testament S2.1 — diff the baseline/after captures s2-1-capture.mjs wrote.
 *
 * Same non-vacuity + heatmap discipline as stage1-earlyz-pixel-diff.mjs:
 * a byte-identical diff proves nothing if the scene captured had no active
 * point lights, and WHERE a diff lands matters more than how big it is.
 *
 * usage: node tests/playwright-artifacts/look/s2-1-diff.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const before = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 's2-1-baseline.json'), 'utf8'));
const after = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 's2-1-after.json'), 'utf8'));

const nonVacuous = before.pointLights?.available && after.pointLights?.available && before.pointLights.activeLights > 0 && after.pointLights.activeLights > 0;

if (before.w !== after.w || before.h !== after.h) {
  console.error(`[s2-1-diff] size mismatch ${before.w}x${before.h} vs ${after.w}x${after.h} — cannot diff`);
  process.exit(1);
}

let differing = 0;
let maxChannelDelta = 0;
let sumDelta = 0;
const w = before.w;
const h = before.h;
const heat = new Uint8Array(w * h);
for (let p = 0, i = 0; p < heat.length; p++, i += 4) {
  let d = 0;
  for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(before.bytes[i + c] - after.bytes[i + c]));
  if (d > 0) {
    differing++;
    sumDelta += d;
    if (d > maxChannelDelta) maxChannelDelta = d;
    heat[p] = Math.min(255, d * 8);
  }
}
const total = heat.length;
const summary = {
  size: `${w}x${h}`,
  totalPixels: total,
  differingPixels: differing,
  differingPercent: +((differing / total) * 100).toFixed(4),
  maxChannelDelta,
  meanDeltaOverDiffering: differing ? +(sumDelta / differing).toFixed(2) : 0,
  before: { activeLights: before.pointLights?.activeLights, poolSize: before.pointLights?.poolSize, floorInfo: before.floorInfo },
  after: { activeLights: after.pointLights?.activeLights, poolSize: after.pointLights?.poolSize, floorInfo: after.floorInfo },
  verdict: !nonVacuous
    ? 'VACUOUS — no active point lights in one or both captures; this diff proves NOTHING'
    : differing === 0
      ? 'PASS — byte-identical, S2.1 refactor is behaviour-preserving'
      : `DIFFERS — ${differing} px (${((differing / total) * 100).toFixed(4)}%); inspect the diffmap before judging`,
};
console.log('[s2-1-diff] VERDICT:', JSON.stringify(summary, null, 2));

// PNG heatmap via a minimal raw-to-PNG path is overkill here (Node has no
// canvas built in) — write a simple PPM instead, viewable by most image
// tools, or just trust the numeric summary for a PASS. Only bother writing
// visual evidence when there IS a diff to actually inspect.
if (differing > 0) {
  // Bare, uncompressed PPM (P6) — trivially readable, no dependency needed.
  const ppmHeader = `P6\n${w} ${h}\n255\n`;
  const rgb = Buffer.alloc(w * h * 3);
  for (let p = 0; p < heat.length; p++) {
    rgb[p * 3] = heat[p];
    rgb[p * 3 + 1] = 0;
    rgb[p * 3 + 2] = 0;
  }
  fs.writeFileSync(path.join(OUT_DIR, 's2-1-diffmap.ppm'), Buffer.concat([Buffer.from(ppmHeader), rgb]));
  console.log('[s2-1-diff] wrote s2-1-diffmap.ppm (red = differs)');
}

fs.writeFileSync(path.join(OUT_DIR, 's2-1-diff-result.json'), JSON.stringify(summary, null, 2));
console.log('[s2-1-diff] wrote s2-1-diff-result.json');
