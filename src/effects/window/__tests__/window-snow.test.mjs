/**
 * Node verification for window-snow.js - snow falling past the window, played through its light.
 *
 * The properties that matter, each pinned below:
 *   - no snow is EXACTLY identity (offset 0, gain 1, white tint, no desaturation);
 *   - the number of falling flakes is LINEAR in the snow (the author: "from very small values all the way up to the
 *     highest values as a ramp of intensity"), counted on the picture, not just on the frame numbers;
 *   - every stage starts where the plan says, and each only grows with the snow;
 *   - the flakes fall toward the wall and never jump when the speed changes (the fall is CPU-integrated);
 *   - the sill drift builds over minutes, sits at the wall edge, and melts after the snow;
 *   - the TSL graph constructs with and without snow, and the setters reach the uniforms.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  SNOW_TUNE,
  WINDOW_SNOW_DEFAULTS,
  snowKindWeight,
  stepSnowPack,
  resolveSnowFrame,
  evalFlakeLayer,
  evalWindowSnowPixel,
  createWindowSnow,
} from '../window-snow.js';
import { createWindowRain } from '../window-rain.js';
import { WINDOW_PARAMS } from '../window.js';

const look = { ...WINDOW_SNOW_DEFAULTS };
/** A south wall: the flakes' shadows fall +y, toward it. Pane height mid-way. */
const flowSouth = { px: 0, py: 1, qx: 0, qy: 1, mix: 0, kappa: 1, h: 0.6, gate: 1 };

const frameFor = (snow01, extra = {}) => ({
  ...resolveSnowFrame({ snow01, pack01: 0, look, ...extra }),
});

/** Fraction of a patch of glass a flake shadow (or glint) touches. Falling flakes only: stick off, no drift. */
function flakeCoverage(snow01, { clock = 37.3, fallShift = 911, lk = look } = {}) {
  const frame = { ...resolveSnowFrame({ snow01, pack01: 0, look: { ...lk, stick: 0 } }) };
  let n = 0;
  let total = 0;
  for (let j = 0; j < 160; j++) {
    for (let i = 0; i < 160; i++) {
      const r = evalWindowSnowPixel({
        x: 3000 + i * 17.3,
        y: 2000 + j * 16.1,
        frame,
        look: lk,
        clock,
        fallShift,
        flow: flowSouth,
      });
      total++;
      if (Math.abs(r.gain / frame.lift - 1) > 0.02) n++;
    }
  }
  return n / total;
}

export async function run(t) {
  // ── 1. What counts as snow ───────────────────────────────────────────────
  t.ok('snow: snow is all snow', snowKindWeight('snow', 0) === 1);
  t.ok('snow: rain and hail are none', snowKindWeight('rain', 1) === 0 && snowKindWeight('hail', 1) === 0);
  t.ok('snow: sleet is its cold share', snowKindWeight('sleet', 0.3) === 0.3);
  t.ok('snow: a NaN mix weight is no snow, not NaN', snowKindWeight('sleet', NaN) === 0);

  // ── 2. No snow is identity, bit for bit ──────────────────────────────────
  {
    const dry = frameFor(0);
    t.ok('snow: no snow has no presence', dry.presence === 0 && dry.fall === 0 && dry.stick === 0);
    let exact = true;
    for (let i = 0; i < 400; i++) {
      const r = evalWindowSnowPixel({
        x: i * 13.7,
        y: i * 5.3,
        frame: dry,
        look,
        clock: i * 0.37,
        fallShift: i * 3.1,
        flow: flowSouth,
      });
      if (r.offsetX !== 0 || r.offsetY !== 0 || r.gain !== 1 || r.desat !== 0 || r.tint.some((c) => c !== 1))
        exact = false;
    }
    t.ok('snow: no snow means offset 0, gain 1, white tint, no desaturation', exact);
  }

  // ── 3. The ramp: linear flake count, stages in order ─────────────────────
  {
    const ratios = [0.02, 0.1, 0.25, 0.5, 0.75, 1].map((s) => frameFor(s).fall / frameFor(1).fall / s);
    t.ok(
      'snow: the flake cover is proportional to the snow (' + ratios.map((v) => v.toFixed(3)).join(', ') + ')',
      ratios.every((v) => Math.abs(v - 1) < 1e-9)
    );
    // ...and on the picture: shadows counted at each level, divided by the snow, are flat
    const levels = [0.05, 0.1, 0.25, 0.5, 0.75];
    const cov = levels.map((s) => flakeCoverage(s));
    const per = cov.map((c, i) => c / levels[i]);
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    t.ok(
      'snow: shadows on the glass follow the snow in a line (coverage/snow ' +
        per.map((v) => v.toFixed(3)).join(', ') +
        ')',
      // overlapping flakes cover less than their sum, so heavier snow may sit a little under the line
      cov[0] > 0 && per.every((v) => Math.abs(v / mean - 1) < 0.3) && cov.every((c, i) => i === 0 || c > cov[i - 1])
    );
    t.ok('snow: the lightest snow already shows a flake', flakeCoverage(0.02) > 0);
    t.ok('snow: even full snow leaves most of the light clear of falling flakes', flakeCoverage(1) < 0.5);

    let monotone = true;
    let prev = frameFor(0);
    for (let s = 0.02; s <= 1.0001; s += 0.02) {
      const f = frameFor(s, { gust01: 0.5 });
      if (
        f.fall < prev.fall - 1e-12 ||
        f.stick < prev.stick - 1e-12 ||
        f.flurry < prev.flurry - 1e-12 ||
        f.whiteout < prev.whiteout - 1e-12 ||
        f.desat < prev.desat - 1e-12 ||
        f.lift < prev.lift - 1e-12
      )
        monotone = false;
      prev = f;
    }
    t.ok('snow: every stage only grows with the snow', monotone);
    t.ok('snow: from 0.01 there are flakes', frameFor(0.01).fall > 0 && frameFor(0.01).presence === 1);
    t.ok('snow: flurries wait for heavy snow', frameFor(0.5).flurry === 0 && frameFor(0.7).flurry > 0);
    t.ok('snow: whiteout waits for the heaviest snow', frameFor(0.75).whiteout === 0 && frameFor(1).whiteout === 1);
    t.ok('snow: the whiteout lifts the light, never dims it', frameFor(1).lift > 1 && frameFor(1).lift < 1.3);
    t.ok(
      'snow: full snow leans cool (blue up, red down)',
      frameFor(1).tint[2] > 1 && frameFor(1).tint[0] < 1 && frameFor(0).tint.every((c) => c === 1)
    );
    t.ok(
      'snow: the dial scales the flakes',
      resolveSnowFrame({ snow01: 0.5, pack01: 0, look: { ...look, flakeCount: 2 } }).fall === 2 * frameFor(0.5).fall
    );
    const off = resolveSnowFrame({ snow01: 1, pack01: 1, look: { ...look, flakeCount: 0, stick: 0, sillDrift: 0 } });
    t.ok(
      'snow: zeroing the dials removes every flake and the drift',
      off.fall === 0 && off.stick === 0 && off.drift === 0
    );
    t.ok(
      'snow: zero snow and no drift is no presence',
      resolveSnowFrame({ snow01: 0, pack01: 0, look }).presence === 0
    );
  }

  // ── 4. The fall: toward the wall, smoothly ───────────────────────────────
  {
    // A single far flake, tracked: its shadow centre moves +y (toward the south wall) as the fall advances.
    const T = SNOW_TUNE;
    const cellPx = look.flakeSizePx * T.farCellMul;
    const base = { dx: 0, dy: 1, cellPx, seed: T.farSeed, radius: T.farRadius, dark: T.farDark, soft: T.farSoft };
    // The shadow profile down the pane (averaged across it), and the lag that best matches one fall to the next.
    const profile = (fallShift) => {
      const out = [];
      for (let y = 0; y < 600; y += 0.25) {
        let s = 0;
        for (let x = 0; x < 400; x += 1.5) {
          s +=
            1 -
            evalFlakeLayer({ ...base, x, y, speed: T.farSpeed, fallShift, cover: 1, flutter: 0, glint: 0, clock: 0 });
        }
        out.push(s);
      }
      return out;
    };
    const shift = cellPx * 0.2;
    const p0 = profile(0);
    const p1 = profile(shift);
    let bestLag = 0;
    let bestErr = Infinity;
    for (let lag = 0; lag <= 60; lag++) {
      let err = 0;
      for (let i = 100; i < 2200; i++) err += (p1[i + lag] - p0[i]) ** 2;
      if (err < bestErr) {
        bestErr = err;
        bestLag = lag * 0.25;
      }
    }
    t.ok(
      'snow: flake shadows fall toward the wall (' +
        bestLag.toFixed(2) +
        ' px for ' +
        (shift * T.farSpeed).toFixed(2) +
        ')',
      Math.abs(bestLag - shift * T.farSpeed) < 0.3
    );
    // A small step of the fall moves the picture a little: no teleport.
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const x = 100 + (i % 20) * 3.3;
      const y = 100 + Math.floor(i / 20) * 3.1;
      const common = { x, y, frame: frameFor(0.6), look, clock: 10, flow: flowSouth };
      const g0 = evalWindowSnowPixel({ ...common, fallShift: 500 }).gain;
      const g1 = evalWindowSnowPixel({ ...common, fallShift: 500.05 }).gain;
      worst = Math.max(worst, Math.abs(g1 - g0));
    }
    // the sharpest feature is a glint's rim, about 1 px wide: a 0.04 px step moves it ~0.05; a teleport would be ~1
    t.ok('snow: a tiny step of the fall changes the picture a tiny bit (' + worst.toFixed(4) + ')', worst < 0.1);
  }

  // ── 5. The sill drift ────────────────────────────────────────────────────
  {
    let pack = 0;
    for (let s = 0; s < 60; s++) pack = stepSnowPack(pack, 1, 1, look.meltSec);
    const after1min = pack;
    for (let s = 0; s < 600; s++) pack = stepSnowPack(pack, 1, 1, look.meltSec);
    t.ok(
      'snow: the drift takes minutes to build (' + after1min.toFixed(3) + ' after 1 min)',
      after1min > 0.15 && after1min < 0.4
    );
    t.ok('snow: a long heavy fall fills it', pack === 1);
    let light = 0;
    for (let s = 0; s < 3600; s++) light = stepSnowPack(light, 0.1, 1, look.meltSec);
    t.ok('snow: light snow never builds a big drift (' + light.toFixed(3) + ')', light <= 0.16 + 1e-9);
    let melt = 1;
    for (let s = 0; s < look.meltSec; s++) melt = stepSnowPack(melt, 0, 1, look.meltSec);
    t.ok(
      'snow: the drift melts after the snow (' + melt.toFixed(3) + ' after one melt time)',
      Math.abs(melt - Math.exp(-1)) < 0.01
    );
    t.ok('snow: a NaN step is harmless', Number.isFinite(stepSnowPack(0.5, NaN, NaN, NaN)));

    // At the wall (h small) the drift dims the light; far up the pane it does nothing.
    const frame = { ...resolveSnowFrame({ snow01: 0, pack01: 1, look }), fall: 0, stick: 0 };
    const at = (h) =>
      evalWindowSnowPixel({ x: 500, y: 500, frame, look, clock: 0, fallShift: 0, flow: { ...flowSouth, h } }).gain;
    t.ok('snow: the drift lies at the wall (gain ' + at(0.02).toFixed(3) + ')', at(0.02) < 0.7);
    t.ok('snow: well up the pane there is no drift', at(0.95) === 1);
    t.ok(
      'snow: no wall knowledge, no drift',
      evalWindowSnowPixel({ x: 500, y: 500, frame, look, clock: 0, fallShift: 0, flow: { ...flowSouth, kappa: 0 } })
        .gain === 1
    );
    t.ok('snow: the drift stays on while it lingers (presence)', frame.presence === 1 || frame.drift > 0);
  }

  // ── 6. Bounded output ────────────────────────────────────────────────────
  {
    let ok = true;
    const storm = resolveSnowFrame({ snow01: 1, pack01: 1, look, windSpeed01: 1, gust01: 1 });
    for (let i = 0; i < 2000; i++) {
      const r = evalWindowSnowPixel({
        x: i * 7.77,
        y: i * 3.13,
        frame: storm,
        look,
        clock: i * 0.91,
        fallShift: i * 17,
        flurryClock: i * 3,
        windShiftX: i,
        windShiftY: -i,
        windFlowX: 1,
        windFlowY: 0,
        flow: { ...flowSouth, h: (i % 100) / 100 },
      });
      if (
        ![r.offsetX, r.offsetY, r.gain, r.desat, ...r.tint].every(Number.isFinite) ||
        Math.hypot(r.offsetX, r.offsetY) > SNOW_TUNE.maxOffsetPx + 1e-9 ||
        r.gain < 0 ||
        r.gain > SNOW_TUNE.maxGain ||
        r.desat < 0 ||
        r.desat > 1
      )
        ok = false;
    }
    t.ok('snow: a full storm stays finite and bounded', ok);
  }

  // ── 7. The effect card ───────────────────────────────────────────────────
  {
    const P = WINDOW_PARAMS;
    const map = {
      snowResponse: 'response',
      snowFlakeCount: 'flakeCount',
      snowFlakeSizePx: 'flakeSizePx',
      snowFallSpeed: 'fallSpeed',
      snowFlutter: 'flutter',
      snowGlint: 'glint',
      snowStick: 'stick',
      snowSillDrift: 'sillDrift',
      snowMeltSec: 'meltSec',
      snowFlurry: 'flurry',
      snowWhiteout: 'whiteout',
    };
    t.ok(
      'snow: every dial is on the card with the module default',
      Object.entries(map).every(([k, d]) => P[k]?.category === 'Snow' && P[k].default === WINDOW_SNOW_DEFAULTS[d])
    );
    t.ok('snow: the response spans the whole precipitation range by default', WINDOW_SNOW_DEFAULTS.response === 1);
  }

  // ── 8. The TSL graph ─────────────────────────────────────────────────────
  {
    const tex = () =>
      new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    const snow = createWindowSnow({ THREE });
    const rain = createWindowRain({ THREE, flowDirsTexture: tex(), flowAuxTexture: tex(), snow });
    const n = rain.build();
    t.ok(
      'snow-tsl: the rain build carries the snow offset, gain, desat and tint apart from the rain',
      !!n.snow && !!n.snow.offsetPx && !!n.snow.gain && !!n.snow.desat && !!n.snow.tint && !!n.gain
    );
    t.ok('snow-tsl: build can be called again', !!rain.build().snow);
    t.ok('snow-tsl: the rain handle exposes its snow', rain.snow === snow);
    const bare = createWindowRain({ THREE, flowDirsTexture: tex(), flowAuxTexture: tex() }).build();
    t.ok('snow-tsl: no snow handle, no snow nodes', bare.snow === null);

    const frame = resolveSnowFrame({ snow01: 0.9, pack01: 0.5, look, windSpeed01: 0.4, gust01: 0.6 });
    snow.setLook({ flakeSizePx: 5 });
    snow.setFrame(frame, { clock: 12.5, fallShift: 300, flurryClock: 40, windShift: [3, 4], windFlow: [1, 0] });
    const s = snow.snapshot();
    t.ok(
      'snow-tsl: setFrame pushes the weather',
      s.presence === 1 &&
        Math.abs(s.amounts[0] - frame.fall) < 1e-6 &&
        Math.abs(s.amounts[2] - frame.drift) < 1e-6 &&
        Math.abs(s.clocks[1] - 300) < 1e-6 &&
        Math.abs(s.tint[2] - frame.tint[2]) < 1e-6 &&
        s.size === 5 &&
        s.windFlow[0] === 1
    );
    snow.setFrame(resolveSnowFrame({ snow01: 0, pack01: 0, look }), { clock: NaN, fallShift: NaN });
    const s2 = snow.snapshot();
    t.ok(
      'snow-tsl: dry snow pushes a white tint and no presence; NaN clocks become 0',
      s2.presence === 0 && s2.tint.every((c) => c === 1) && s2.clocks[0] === 0 && s2.clocks[1] === 0
    );
  }
}
