/**
 * THE GOO'S LIGHT ON THE MAP (`fluid-light-field.js`, mmp-0t3.2) — the claims that answer "perfect circles of
 * light": the glow has no rim, follows the pipe instead of sitting in discs, and does not blow out on a flask.
 * Pure: the field is summed here exactly as the shader sums it (kernel × emitter light, ADDED).
 */
import {
  fluidLightKernel,
  fluidLightEmitters,
  fluidLightWeights,
  writeFluidLightEmitters,
  fluidLightCircle,
  FLUID_LIGHT_KERNEL_LINE_INTEGRAL,
  FLUID_LIGHT_REACH_PX,
} from '../fluid-light-field.js';
import { createFluidLightTwin, stepFluidLightTwin, fluidPalette } from '../fluid-alchemy.js';
import { extractTubeNet } from '../fluid-net.js';

function grid(w, h, fill) {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fill(x, y)) data[y * w + x] = 200;
  return { spec: { x: 0, y: 0, width: w * 10, height: h * 10, w, h, texelW: 10, texelH: 10 }, data };
}
const quad = (w, h) => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];
/** The field at a point: what the shader adds there (luma of Σ light × kernel), every footprint unclipped. */
function fieldAt(emitters, out, reach, px, py) {
  let s = 0;
  for (let i = 0; i < emitters.length; i++) {
    const k = fluidLightKernel(Math.hypot(px - emitters[i].x, py - emitters[i].y) / reach);
    s += k * (0.2126 * out[i * 4] + 0.7152 * out[i * 4 + 1] + 0.0722 * out[i * 4 + 2]);
  }
  return s;
}
/** A twin whose every tube is full of calm goo. */
function fullTwin(net) {
  const twin = createFluidLightTwin(net);
  for (const t of twin.tubes) {
    t.phi.fill(1);
    t.energy.fill(0);
    t.reagent.fill(0);
  }
  return twin;
}

export function run(t) {
  const { ok } = t;
  const R = FLUID_LIGHT_REACH_PX;
  const white = { colors: [[1, 1, 1]], count: 1 };

  // ── THE KERNEL: no rim ────────────────────────────────────────────────
  {
    ok('kernel is 1 at the emitter', fluidLightKernel(0) === 1);
    ok('kernel is 0 at and past its reach', fluidLightKernel(1) === 0 && fluidLightKernel(1.4) === 0);
    const slope = (fluidLightKernel(1) - fluidLightKernel(0.999)) / 0.001;
    ok(`kernel arrives at 0 with ~zero slope (${slope.toFixed(5)})`, Math.abs(slope) < 0.01);
    let mono = true;
    for (let x = 0; x < 1; x += 0.01) if (fluidLightKernel(x + 0.01) > fluidLightKernel(x) + 1e-12) mono = false;
    ok('kernel falls monotonically', mono);
    ok(
      `line integral is finite and positive (${FLUID_LIGHT_KERNEL_LINE_INTEGRAL.toFixed(4)})`,
      FLUID_LIGHT_KERNEL_LINE_INTEGRAL > 0.1 && FLUID_LIGHT_KERNEL_LINE_INTEGRAL < 2
    );
  }

  // ── A STRAIGHT PIPE: the glow is a band along it, not discs ─────────────
  const pipeNet = extractTubeNet({
    grid: grid(300, 60, (x, y) => x >= 5 && x < 295 && y >= 29 && y < 32),
    samplesPerTube: 64,
  });
  const pipe = fluidLightEmitters(pipeNet, quad(3000, 600));
  {
    ok(`a pipe gets emitters (${pipe.length})`, pipe.length >= 15);
    ok(
      'every emitter sits on the pipe',
      pipe.every((e) => e.x > 0 && e.x < 3000 && Math.abs(e.y - 305) < 20 && e.row === 0)
    );
    const capped = fluidLightEmitters(pipeNet, quad(3000, 600), { maxEmitters: 6 });
    ok(`the cap is respected by growing the cells (${capped.length})`, capped.length > 0 && capped.length <= 6);
    const area = pipe.reduce((s, e) => s + e.areaPx, 0);
    ok(`emitters account for all the goo (${area} px²)`, Math.abs(area - 290 * 3 * 100) < 1);
  }
  const pipeW = fluidLightWeights(pipe, R);
  const pipeOut = new Float32Array(pipe.length * 4);
  writeFluidLightEmitters({
    emitters: pipe,
    weights: pipeW,
    twin: fullTwin(pipeNet),
    palette: white,
    gain: 1,
    smooth: new Float32Array(pipe.length).fill(NaN),
    dtSec: 1 / 60,
    out: pipeOut,
  });
  {
    // A 30 px pipe is the reference: full calm goo (level 0.45) sums to ~0.45 on its centre line.
    const centre = fieldAt(pipe, pipeOut, R, 1500, 305);
    ok(
      `a full reference pipe sums to ~its level on its centre line (${centre.toFixed(3)})`,
      Math.abs(centre - 0.45) < 0.06
    );
    // Along the pipe: no lumps where the emitters sit (they are 140 px apart, the kernel reaches 560).
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = 800; x <= 2200; x += 5) {
      const v = fieldAt(pipe, pipeOut, R, x, 305 + 60);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    ok(`no lumps along the pipe, 60 px off it (ripple ${(((hi - lo) / hi) * 100).toFixed(2)}%)`, (hi - lo) / hi < 0.03);
    // Across the pipe: the field eases out to nothing with no step anywhere (the MAX'd discs had a rim).
    let worstStep = 0;
    let prev = fieldAt(pipe, pipeOut, R, 1500, 305);
    const peak = prev;
    for (let d = 5; d <= R + 60; d += 5) {
      const v = fieldAt(pipe, pipeOut, R, 1500, 305 + d);
      worstStep = Math.max(worstStep, Math.abs(prev - v));
      prev = v;
    }
    ok(
      `no rim across the pipe (worst 5 px step ${((worstStep / peak) * 100).toFixed(2)}% of peak)`,
      worstStep / peak < 0.06
    );
    ok(`nothing past the reach (${prev})`, prev === 0);
    // The glow is a BAND: as bright 1000 px along the pipe as at its middle, far dimmer the same distance across.
    const along = fieldAt(pipe, pipeOut, R, 1500 + 600, 305);
    const across = fieldAt(pipe, pipeOut, R, 1500, 305 + 300);
    ok(
      `the glow follows the pipe, not a disc (along ${along.toFixed(3)} vs across ${across.toFixed(3)})`,
      along > 5 * across
    );
  }

  // ── A FLASK: brighter than a pipe, not eight times brighter ─────────────
  {
    const net = extractTubeNet({
      grid: grid(120, 120, (x, y) => (x - 60) ** 2 + (y - 60) ** 2 < 22 ** 2),
      samplesPerTube: 64,
    });
    const em = fluidLightEmitters(net, quad(1200, 1200));
    const w = fluidLightWeights(em, R);
    const out = new Float32Array(em.length * 4);
    writeFluidLightEmitters({
      emitters: em,
      weights: w,
      twin: fullTwin(net),
      palette: white,
      gain: 1,
      smooth: new Float32Array(em.length).fill(NaN),
      dtSec: 1 / 60,
      out,
    });
    const flask = fieldAt(em, out, R, 600, 600);
    const pipeCentre = fieldAt(pipe, pipeOut, R, 1500, 305);
    const ratio = flask / pipeCentre;
    ok(`a 440 px flask glows brighter than a pipe, but eased (×${ratio.toFixed(2)})`, ratio > 1.2 && ratio < 4);
  }

  // ── THE PER-TICK WRITE: follows the goo ────────────────────────────────
  {
    const twin = createFluidLightTwin(pipeNet);
    const pal = fluidPalette([0.1, 0.9, 0.7], [0.6, 0.3, 1], 0.5);
    const out = new Float32Array(pipe.length * 4);
    const smooth = new Float32Array(pipe.length).fill(NaN);
    const args = { emitters: pipe, weights: pipeW, twin, palette: pal, gain: 0.33, smooth, dtSec: 1 / 30, out };
    const empty = writeFluidLightEmitters(args);
    ok('an empty pipe adds nothing', empty.lit === 0 && out.every((v, i) => i % 4 === 3 || v === 0));
    const pump = new Float32Array([5000, 1, pipeNet.tubes[0].lengthPx, 1]);
    const tube = new Float32Array([0, 1, 0.5, 1, 0, pipeNet.tubes[0].lengthPx, 0, 1]);
    let r = null;
    for (let i = 0; i < 600; i++) {
      stepFluidLightTwin(twin, pump, tube, 1 / 30);
      r = writeFluidLightEmitters(args);
    }
    ok(`a full pipe lights every emitter (${r.lit}/${pipe.length})`, r.lit === pipe.length);
    ok(
      'every value is finite and non-negative',
      out.every((v) => Number.isFinite(v) && v >= 0)
    );
    ok(
      'the light is the goo’s colour (green-cyan reagent → G is the largest channel)',
      out[1] > out[0] && out[1] >= out[2]
    );
    const z = new Float32Array(pipe.length * 4);
    writeFluidLightEmitters({ ...args, gain: 0, out: z });
    ok(
      'light 0 → nothing added',
      z.every((v, i) => i % 4 === 3 || v === 0)
    );
  }

  // ── THE FALLBACK FOOTPRINT ─────────────────────────────────────────────
  {
    const c = fluidLightCircle(10, 20, 100, 32);
    ok(
      'a circle footprint has 32 points at the reach',
      c.length === 64 && Math.abs(Math.hypot(c[0] - 10, c[1] - 20) - 100) < 1e-9
    );
  }
}
