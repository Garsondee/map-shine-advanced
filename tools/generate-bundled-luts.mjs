#!/usr/bin/env node
/**
 * Generates MSA's three bundled cinematic .cube LUTs, from a plain
 * documented formula rather than a sourced/licensed film scan — see
 * grade.js#BUNDLED_LUT_NAMES and the (now-removed) 'bundled-lut-loading'
 * deferredRung this closes out (mythica-machina-press#38). The shader/parser
 * path (grade-ops.js, lut-cube.js) was already built and tested; this script
 * is the missing "actual asset" half.
 *
 * Each look is a small, named chain of operations applied per-texel over a
 * LUT_3D_SIZE grid, written out in the standard red-fastest .cube row order
 * `parseCubeLut` expects. Deliberately simple/analytic (no external image, no
 * per-frame authoring) so the look is fully reproducible from this file alone
 * — re-run this script any time the formula below is tuned.
 *
 * These LUTs apply to the ARTISTIC grade's whole-frame TAIL, i.e. AFTER tone
 * mapping (grade-present.js) — so treat r/g/b here as already display-referred
 * 0..1, the same assumption a real post-tonemap film LUT makes.
 *
 * Usage: `node tools/generate-bundled-luts.mjs` (no args) — writes/overwrites
 * all three files under assets/luts/.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'assets', 'luts');

/** LUT_3D_SIZE — the cube edge. 17 is plenty smooth for these gentle,
 * analytic (no high-frequency detail) curves, at a fraction of the file size
 * of a scan-derived 33^3 LUT (17^3 = 4,913 rows vs 35,937). */
const SIZE = 17;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** A gentle filmic S-curve, blended with identity by `amount` (0 = none, 1 =
 * full smoothstep) so contrast can be dialed per look without a new curve. */
function sCurve(x, amount) {
  const s = x * x * (3 - 2 * x); // smoothstep(0,1,x)
  return x + (s - x) * amount;
}

/** Desaturate toward this pixel's own luma by `amount` (0 = untouched, 1 =
 * fully grey) — simple, well-understood, no gamut remapping. */
function desaturate(r, g, b, amount) {
  const l = luma(r, g, b);
  return [r + (l - r) * amount, g + (l - g) * amount, b + (l - b) * amount];
}

/**
 * The three bundled looks. Each is `(r,g,b) -> [r,g,b]`, pure, 0..1 in and
 * (clamped) 0..1 out. Matches grade.js#BUNDLED_LUT_NAMES exactly (minus
 * 'none', which needs no file — the identity LUT already ships as an
 * in-memory placeholder, see lut-cube.js#identityCubeLut).
 */
const LOOKS = {
  /** Warm Film — classic warm-stock push: mild S-curve, warm channel shift,
   * a small lift so blacks read as film-black rather than crushed digital
   * black. */
  warmFilm(r, g, b) {
    let [rr, gg, bb] = [r, g, b].map((c) => sCurve(c, 0.35));
    rr *= 1.06;
    bb *= 0.93;
    rr = rr * 0.97 + 0.02;
    gg = gg * 0.97 + 0.015;
    bb = bb * 0.97 + 0.01;
    return [clamp01(rr), clamp01(gg), clamp01(bb)];
  },

  /** Cool Film — moodier/higher-contrast: stronger S-curve, cool (blue-teal)
   * channel shift, a touch of desaturation, and a small crush instead of a
   * lift (the opposite polarity from Warm Film, deliberately). */
  coolFilm(r, g, b) {
    let [rr, gg, bb] = [r, g, b].map((c) => sCurve(c, 0.5));
    rr *= 0.94;
    gg *= 0.99;
    bb *= 1.07;
    [rr, gg, bb] = desaturate(rr, gg, bb, 0.1);
    rr = Math.max(0, rr - 0.012) * 1.012;
    gg = Math.max(0, gg - 0.012) * 1.012;
    bb = Math.max(0, bb - 0.012) * 1.012;
    return [clamp01(rr), clamp01(gg), clamp01(bb)];
  },

  /** Bleach Bypass — the classic silver-retention look: heavy desaturation,
   * a hard S-curve for punch, and a faint cool cast (bypass stock famously
   * skews cold/steely rather than neutral grey). */
  bleachBypass(r, g, b) {
    let [rr, gg, bb] = desaturate(r, g, b, 0.55);
    [rr, gg, bb] = [rr, gg, bb].map((c) => sCurve(c, 0.65));
    rr *= 0.98;
    bb *= 1.03;
    return [clamp01(rr), clamp01(gg), clamp01(bb)];
  },
};

function buildCubeText(title, size, transform) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, ''];
  // Red-fastest row order, exactly what parseCubeLut/Data3DTexture expect —
  // see lut-cube.js's own header for why this order is load-bearing.
  for (let bIdx = 0; bIdx < size; bIdx++) {
    const b = bIdx / (size - 1);
    for (let gIdx = 0; gIdx < size; gIdx++) {
      const g = gIdx / (size - 1);
      for (let rIdx = 0; rIdx < size; rIdx++) {
        const r = rIdx / (size - 1);
        const [or_, og, ob] = transform(r, g, b);
        lines.push(`${or_.toFixed(6)} ${og.toFixed(6)} ${ob.toFixed(6)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const titles = {
    warmFilm: 'MSA Warm Film',
    coolFilm: 'MSA Cool Film',
    bleachBypass: 'MSA Bleach Bypass',
  };
  for (const [name, fn] of Object.entries(LOOKS)) {
    const text = buildCubeText(titles[name], SIZE, fn);
    const outPath = path.join(OUT_DIR, `${name}.cube`);
    writeFileSync(outPath, text, 'utf8');
    console.log(`wrote ${outPath} (${(text.length / 1024).toFixed(1)} KB, ${SIZE}^3 rows)`);
  }
}

main();
