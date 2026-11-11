/**
 * water-waves.test.mjs — THE ONE WAVE SYSTEM (2026-11-10, mmp-78u.30.9): the spectrum's physics in plain numbers,
 * and that every water tier builds with the system attached (surface, caustics, shafts read from it).
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  buildWaveSet,
  waveAmplitudes,
  waveFetchMetres,
  waveWindMetresPerSecond,
  createWaterWaveSystem,
  WAVE_COUNT,
  WAVE_TILE_PX,
  WAVE_CHOP_REFERENCE,
  WAVE_RESOLVED_SLOPE,
  waveRippleGain,
  waveRippleWeight,
  waveViewLayout,
  waveBandRanges,
  WAVE_SPLAT_CELLS,
  WAVE_CAUSTIC_RES,
  WAVE_RIPPLE_BINS,
  WAVE_RIPPLE_ROT,
  waveRippleBinWeights,
  wavePatternVelocity,
  waveBoilSign,
  WAVE_WIND_IN_FLOW_RATIO,
} from '../water-waves.js';
import { WATER_TIER3_CHOP } from '../water-field.js';
import { buildWaterSurfaceMaterial } from '../water-render.js';
import { buildWorldSpaceOutdoorsGate } from '../../lighting/environmental-light.js';
import { metresPerSecondForSpeed01 } from '../../../world/wind-scale.js';

const PPM = 100 / 1.524;

export function run(t) {
  const { ok } = t;

  // ── the fixed set ──
  const set = buildWaveSet({ seed: 7, pxPerM: PPM });
  ok(`the set has ${WAVE_COUNT} components`, set.length === WAVE_COUNT);
  ok('no two components share a lattice point', new Set(set.map((c) => `${c.n},${c.m}`)).size === set.length);
  ok(
    'every component tiles exactly on the tile (k·tile = 2π·integer), so the baked texture has no seam',
    set.every(
      (c) =>
        Math.abs((c.kx * WAVE_TILE_PX) / (2 * Math.PI) - c.n) < 1e-6 &&
        Math.abs((c.ky * WAVE_TILE_PX) / (2 * Math.PI) - c.m) < 1e-6
    )
  );
  const set2 = buildWaveSet({ seed: 7, pxPerM: PPM });
  ok(
    'the set is deterministic for a seed (a scene reloads into the same sea)',
    set2.every((c, i) => c.n === set[i].n && c.ph === set[i].ph)
  );

  // ── the sea for a wind ──
  const sea = (wind01, fetchM = 400, towardRad = 0) =>
    waveAmplitudes(set, {
      windMs: waveWindMetresPerSecond(wind01, metresPerSecondForSpeed01),
      towardRad,
      fetchM,
      pxPerM: PPM,
    });
  const calm = sea(0.01);
  const breeze = sea(0.1);
  const gale = sea(0.3);
  ok(
    `waves lengthen with the wind (${calm.peakWavelengthM.toFixed(2)} → ${breeze.peakWavelengthM.toFixed(2)} → ${gale.peakWavelengthM.toFixed(2)} m)`,
    calm.peakWavelengthM < breeze.peakWavelengthM && breeze.peakWavelengthM < gale.peakWavelengthM
  );
  ok(
    `and grow taller (Hs ${calm.hsM.toFixed(3)} → ${breeze.hsM.toFixed(3)} → ${gale.hsM.toFixed(3)} m)`,
    calm.hsM < breeze.hsM && breeze.hsM < gale.hsM
  );
  ok(
    `a 7 m/s breeze over a harbour has metre-scale waves (${breeze.peakWavelengthM.toFixed(2)} m, period ${breeze.peakPeriodSec.toFixed(2)} s)`,
    breeze.peakWavelengthM > 0.6 &&
      breeze.peakWavelengthM < 2.5 &&
      breeze.peakPeriodSec > 0.5 &&
      breeze.peakPeriodSec < 1.5
  );
  ok(
    `at the reference wind (7 m/s) the drawn sea is the resolved share of Cox & Munk (${breeze.drawnShare.toFixed(4)} vs ${WAVE_RESOLVED_SLOPE})`,
    Math.abs(breeze.drawnShare - WAVE_RESOLVED_SLOPE) < 1e-6
  );
  // ⚠️ the calm and the gale (2026-11-10, Ingram: "very strange at 0 wind", "low resolution ... at full 100")
  const still = sea(0);
  ok(
    `a calm is glass: no drawn waves (Hs ${still.hsM.toFixed(4)} m), a mirror's glint (${still.glintRoughness.toFixed(3)})`,
    still.hsM < 1e-6 && still.glintRoughness < 0.03
  );
  let prevHs = -1;
  let prevVar = -1;
  let smooth = true;
  for (let ms = 0; ms <= 30; ms += 0.25) {
    const s = waveAmplitudes(set, { windMs: ms, towardRad: 0, fetchM: 2000, pxPerM: PPM });
    const v = s.drawnShare * (0.0005 + 0.00512 * ms);
    if (s.hsM < prevHs - 1e-9 || v < prevVar - 1e-9) smooth = false;
    prevHs = s.hsM;
    prevVar = v;
  }
  ok('from calm to gale the sea only grows: no low-wind blow-up, no jump (0..30 m/s in 0.25 steps)', smooth);
  const galeSea = waveAmplitudes(set, { windMs: 30, towardRad: 0, fetchM: 2000, pxPerM: PPM });
  const shortA2 = galeSea.ampsSea.reduce((a, amp, i) => a + ((2 * Math.PI) / set[i].k < 1 ? amp * amp : 0), 0);
  const allA2 = galeSea.ampsSea.reduce((a, amp) => a + amp * amp, 0);
  ok(
    `a gale's drawn sea keeps sub-metre waves, not a few long blobs (${((100 * shortA2) / allA2).toExponential(2)}% of its height variance)`,
    shortA2 > 0 && galeSea.ampsSea.filter((a) => a > 1e-3 * Math.max(...galeSea.ampsSea)).length > 20
  );
  const br = waveBandRanges(set);
  ok(
    `each band bakes only its own components (sea 0..${br.seaEnd}, ripples ${br.rippleStart}..${set.length}) and together they cover all`,
    br.seaEnd < set.length &&
      br.rippleStart > 0 &&
      br.rippleStart <= br.seaEnd &&
      set.every(
        (c, i) => (i < br.seaEnd || waveRippleWeight(c.k) === 1) && (i >= br.rippleStart || waveRippleWeight(c.k) === 0)
      )
  );
  ok('ripples: none in still air (capillary onset)', waveRippleGain(0) === 0 && waveRippleGain(0.4) === 0);
  ok(
    'ripples: the reference wind is 1, and they grow as √U',
    Math.abs(waveRippleGain(7) - 1) < 1e-9 && waveRippleGain(28) > 1.9
  );
  // world-locked layout: a pan by any amount keeps the photon grid and the slice texels on one world lattice
  const a = waveViewLayout({ minX: 1000, minY: 500, maxX: 2920, maxY: 1580 });
  const b = waveViewLayout({ minX: 1037.3, minY: 523.9, maxX: 2957.3, maxY: 1603.9 });
  const onLattice = (x, step) => Math.abs(x / step - Math.round(x / step)) < 1e-6;
  const cell = a.grid[2] / WAVE_SPLAT_CELLS;
  ok(
    'a pan keeps the photons and the caustic texels on the same world lattice (no crawl)',
    a.grid[2] === b.grid[2] &&
      onLattice(a.grid[0], cell) &&
      onLattice(b.grid[0], cell) &&
      onLattice(b.view[0], b.view[2] / WAVE_CAUSTIC_RES) &&
      b.view[0] <= 1037.3 &&
      b.grid[0] <= 1037.3 - 0.2 * 1920
  );
  const pond = sea(0.1, 6);
  ok(
    `a pond's short fetch keeps its waves short (${pond.peakWavelengthM.toFixed(2)} m vs ${breeze.peakWavelengthM.toFixed(2)} m)`,
    pond.peakWavelengthM < breeze.peakWavelengthM
  );
  // energy goes downwind: components heading into the wind carry far less than those with it
  const e2 = (s, i) => s.ampsSea[i] ** 2;
  const along = (s, towardRad) =>
    set.reduce((acc, c, i) => acc + (Math.cos(c.theta - towardRad) > 0.7 ? e2(s, i) : 0), 0);
  const against = (s, towardRad) =>
    set.reduce((acc, c, i) => acc + (Math.cos(c.theta - towardRad) < -0.7 ? e2(s, i) : 0), 0);
  const east = sea(0.1, 400, 0);
  ok('the wind sea runs with the wind, not against it', along(east, 0) > against(east, 0) * 20);
  const north = sea(0.1, 400, -Math.PI / 2);
  ok('turning the wind turns the wind sea', along(north, -Math.PI / 2) > against(north, -Math.PI / 2) * 20);
  // the ripples are CANONICAL (toward +x of their bake; the shader turns them to each pixel's own wind)
  const r2 = (s) => set.map((c, i) => s.ampsRipple[i] ** 2);
  const ripE = r2(east);
  const ripN = r2(north);
  // (only through the drawing gain, pinned on the lattice's slightly un-round wind sea: ~1%)
  ok(
    'the ripple bake does not depend on the scene wind’s bearing (within 3%)',
    ripE.every((x, i) => Math.abs(x - ripN[i]) <= 1e-12 + 0.06 * x)
  );
  const ripAlong = set.reduce((a, c, i) => a + (Math.cos(c.theta) > 0.85 ? ripE[i] : 0), 0);
  const ripTotal = ripE.reduce((a, x) => a + x, 0);
  ok(
    `the ripple bake runs toward +x with a narrow spread (${((100 * ripAlong) / ripTotal).toFixed(0)}% within ±32°)`,
    ripAlong > 0.6 * ripTotal
  );
  const pure = set.filter((c) => waveRippleWeight(c.k) >= 1);
  ok(
    `every pure ripple component lies within ±60° of +x (${pure.length} of them carry the band)`,
    pure.length >= 15 && pure.every((c) => Math.abs(c.theta) <= Math.PI / 3 + 0.12)
  );
  // the per-pixel bearing blend (mirror of the shader's `ripplesAt`): Σw² = 1, continuous as the wind turns through a
  // hand-over of the bearing triple, and narrowing as the wind strengthens
  const cont = (s) => {
    let worst = 0;
    let prev = waveRippleBinWeights(-Math.PI, s);
    for (let a = -Math.PI + 0.001; a <= Math.PI; a += 0.001) {
      const cur = waveRippleBinWeights(a, s);
      for (let b = 0; b < WAVE_RIPPLE_BINS; b++) worst = Math.max(worst, Math.abs(cur[b] - prev[b]));
      prev = cur;
    }
    return worst;
  };
  const unit = [0.3, 3, 10].every((s) =>
    [0, 0.4, 1.3, -2.9].every((a) => Math.abs(waveRippleBinWeights(a, s).reduce((x, w) => x + w * w, 0) - 1) < 1e-9)
  );
  ok('the bearing blend keeps Σw² = 1 (the ripples’ variance holds)', unit);
  ok(
    `turning the wind never jumps the bearing weights (worst step ${cont(0.3).toFixed(4)}, ${cont(10).toFixed(4)} per mrad)`,
    cont(0.3) < 0.01 && cont(10) < 0.01
  );
  const peak = (s) => Math.max(...waveRippleBinWeights(WAVE_RIPPLE_ROT + 0.1, s));
  ok(
    `a strong wind narrows the ripples onto its bearing (main weight ${peak(0.3).toFixed(2)} calm → ${peak(10).toFixed(2)} windy)`,
    peak(10) > 0.9 && peak(0.3) < 0.7
  );
  const rw = set.map((c) => waveRippleWeight(c.k));
  ok(
    'ripple weights are 0..1',
    rw.every((r) => r >= 0 && r <= 1)
  );
  ok('short waves are ripples, long ones the wind sea', rw.some((r) => r > 0.9) && rw.some((r) => r < 0.1));

  // ── fetch ──
  const sceneRect = { minX: 0, minY: 0, maxX: 3000, maxY: 3000 };
  ok(
    'water running off the scene edge is open sea',
    waveFetchMetres({ bounds: { minX: 0, minY: 0, maxX: 3000, maxY: 900 }, sceneRect, pxPerM: PPM }) === 2000
  );
  const pf = waveFetchMetres({ bounds: { minX: 500, minY: 500, maxX: 900, maxY: 800 }, sceneRect, pxPerM: PPM });
  ok(`an inland pond's fetch is its own size (${pf.toFixed(1)} m)`, pf > 5 && pf < 8);

  ok(
    'Surface chop reference = WATER_TIER3_CHOP (0.31 means the measured sea)',
    WAVE_CHOP_REFERENCE === WATER_TIER3_CHOP
  );

  // ── the GPU system constructs, steps, and every water tier builds against it ──
  let sys = null;
  let err = null;
  try {
    sys = createWaterWaveSystem({ THREE, metresPerSecondForSpeed01 });
    sys.update({
      dtSec: 0.016,
      wind01: 0.1,
      windDeg: 90,
      fetchM: 400,
      pxPerM: PPM,
      sunDir: [0.4, 0.2, 0.89],
      viewRect: { minX: 0, minY: 0, maxX: 1280, maxY: 720 },
      flowPx: [0, 50],
    });
  } catch (e) {
    err = e;
  }
  ok(`the wave system constructs and steps (${err ? err.message : 'clean'})`, err === null && !!sys);
  if (!sys) return;
  const info = sys.info();
  ok(`it reports its sea (${JSON.stringify(info)})`, info && info.peakWavelengthM > 0 && info.hsM > 0);
  const stub = () => {
    const tx = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    tx.needsUpdate = true;
    return tx;
  };
  const RECT = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const { uniform, vec4, float } = THREE.TSL;
  for (const tier of [2, 3, 4, 5]) {
    let e2 = null;
    try {
      buildWaterSurfaceMaterial({
        THREE,
        tier,
        maskTexture: stub(),
        maskRect: RECT,
        bodyTexture: stub(),
        bodyRect: RECT,
        capturedTexture: stub(),
        capturedRect: RECT,
        capturedTexSize: { width: 512, height: 512 },
        timeMsNode: uniform(float(0)),
        uViewRect: uniform(vec4(0, 0, 1000, 1000)),
        uOutdoorsRect: uniform(vec4(0, 0, 1000, 1000)),
        outdoorsTexNode: THREE.TSL.texture(stub()),
        buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
        waves: sys,
      });
    } catch (e) {
      e2 = e;
    }
    ok(`tier ${tier} water builds with the wave system attached (${e2 ? e2.message : 'clean'})`, e2 === null);
  }

  // ── the flow carries the pattern, the wind mixes in (2026-11-10) ─────────
  {
    const base = { windDir: [1, 0], windRatio: 1, peakSpeedPx: 95, flowSpeedPx: 70 };
    const pond = wavePatternVelocity({ ...base, currentPx: [0, 0] });
    ok(
      'a closed pond (no current) moves with the wind alone, downwind',
      pond.vx > 0 && pond.vy === 0 && pond.flowing === 0
    );
    const river = wavePatternVelocity({ ...base, currentPx: [-31, 0] });
    ok(`a river reach running INTO the wind still moves with the river (vx ${river.vx.toFixed(1)} px/s)`, river.vx < 0);
    ok(
      `in a river the wind's travel is a small share of the current's (${river.windPx.toFixed(1)} vs 31 px/s)`,
      river.windPx < 0.4 * 31
    );
    const rapids = wavePatternVelocity({ ...base, currentPx: [0, 110], peakSpeedPx: 227 });
    ok('in a rapid the wind still leans on it (both mix)', rapids.vx > 0 && rapids.vy === 110);
    ok(
      'in running water the wind travels at WAVE_WIND_IN_FLOW_RATIO of the current',
      Math.abs(rapids.windPx - 110 * WAVE_WIND_IN_FLOW_RATIO) < 1e-9
    );
    const slow = wavePatternVelocity({ ...base, currentPx: [0, 12] });
    ok(
      `even a slow reach (12 px/s) is carried more by its current than the wind (${slow.windPx.toFixed(1)} px/s)`,
      slow.windPx < 0.4 * 12
    );
    const strong = wavePatternVelocity({ ...base, currentPx: [0, 0], peakSpeedPx: 220 });
    ok('a stronger wind (longer, faster waves) carries still water faster', strong.vx > pond.vx);
    ok('a calm carries nothing', wavePatternVelocity({ ...base, currentPx: [0, 0], peakSpeedPx: 0 }).vx === 0);
    ok(
      'shelter (local wind 0) carries nothing by wind',
      wavePatternVelocity({ ...base, currentPx: [0, 0], windRatio: 0 }).vx === 0
    );
    let net = 0;
    for (let i = 0; i < 64; i++) net += waveBoilSign(i);
    ok('the components boil in place: as many run forward as backward', net === 0);
  }
  sys.dispose();
}
