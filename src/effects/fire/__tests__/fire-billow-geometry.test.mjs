/**
 * fire-billow-geometry.test.mjs — THE BILLOW MODEL, MEASURED.
 *
 * The model is a pure function of (fire, environment, clock) -> lobes, so the whole of it can be pinned here without a GPU:
 * the same function is the thing drawn, so there is no twin to drift. What is NOT provable here — how the contour LOOKS —
 * is judged in the lab against the author's painted campfires (`tools/shader-lab/fire-billow-lab.js`, `measure()`).
 *
 * Every property below is one the author asked for (or the painted art demands), stated as a number:
 *   - the same inputs always give the same flame, and the clock moves it;
 *   - the buffer is never overrun, and no number is ever NaN (one NaN lobe poisons a whole draw);
 *   - a hearth is low and contained, a bonfire tall and wild: ONE regime scalar blends them;
 *   - wind LEANS the flame downwind (both ways, symmetrically), rain/gale make it smaller, a dying fire is its coals;
 *   - a put-out fire is dark; a doused fire steams; spit embers lie where they land;
 *   - height shows as parallax and as the 3/4 lift up the page, and the side view is the same billows.
 */
import {
  emitFireLobes,
  emitMassSmoke,
  MASS_SMOKE_MAX,
  basePoint,
  maxLobesPerFire,
  LOBE_STRIDE,
  LOBE,
  KIND_FLAME,
  KIND_SMOKE,
  KIND_COAL,
  hashU32,
  hash01,
  billowPower,
  billowLeanGain,
  billowPulse,
  billowDraft,
  BILLOW_TUNE,
  BILLOW_FLAME_RAMP,
  BILLOW_SMOKE_RAMP,
} from '../fire-billow-geometry.js';

const FIRE = Object.freeze({
  x: 2000,
  y: 2000,
  radius: 50,
  seed: 7,
  intensity: 1,
  outdoor01: 1,
  turb01: 1,
  puffHz: 1.6,
  flickerAmp: 0.3,
});
const ENV = Object.freeze({ tSec: 12, camX: 2000, camY: 2000, parallax: 1, tilt: 0.3, projection: 'top', quality: 1 });

function emit(fire = {}, env = {}, tune) {
  const cap = maxLobesPerFire(fire.radius ?? FIRE.radius) * 2;
  const flame = new Float32Array(cap * LOBE_STRIDE);
  const smoke = new Float32Array(cap * LOBE_STRIDE);
  const r = emitFireLobes(flame, 0, { ...FIRE, ...fire }, { ...ENV, ...env }, tune, smoke, 0);
  return { flame, smoke, r, cap };
}

const lobesOf = (buf, n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = i * LOBE_STRIDE;
    out.push({
      x: buf[o + LOBE.X],
      y: buf[o + LOBE.Y],
      r: buf[o + LOBE.R],
      w: buf[o + LOBE.STRENGTH],
      heat: buf[o + LOBE.HEAT],
      along: buf[o + LOBE.STRETCH],
      dx: buf[o + LOBE.DIRX],
      dy: buf[o + LOBE.DIRY],
      kind: buf[o + LOBE.KIND],
      tone: buf[o + LOBE.TONE],
      across: buf[o + 10],
      z: buf[o + 11],
    });
  }
  return out;
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const burning = (list) => list.filter((l) => l.kind === KIND_FLAME);

/** Hue in degrees of a #rrggbb colour. */
function hueDeg(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  let h;
  if (mx === r) h = ((g - b) / (mx - mn)) * 60;
  else if (mx === g) h = (2 + (b - r) / (mx - mn)) * 60;
  else h = (4 + (r - g) / (mx - mn)) * 60;
  return h < 0 ? h + 360 : h;
}

export function run(t) {
  // ── THE HASH: bit-exact integer, uniform enough to drive a flame ─────────────────────────────────────────────
  {
    const vals = [];
    for (let i = 0; i < 20000; i++) vals.push(hash01(i, i * 3, 7));
    t.ok(
      'hash01 stays in [0, 1)',
      vals.every((v) => v >= 0 && v < 1)
    );
    t.ok('hash01 is roughly uniform (mean 0.5, ~10% in each tenth)', Math.abs(mean(vals) - 0.5) < 0.01);
    const tenths = new Array(10).fill(0);
    for (const v of vals) tenths[Math.floor(v * 10)]++;
    t.ok(
      'every tenth of [0,1) is populated about equally',
      tenths.every((c) => c > 1700 && c < 2300)
    );
    t.ok('hash01 is deterministic', hash01(5, 6, 7) === hash01(5, 6, 7));
    t.ok(
      'hash01 depends on every key',
      hash01(5, 6, 7) !== hash01(6, 6, 7) && hash01(5, 6, 7) !== hash01(5, 7, 7) && hash01(5, 6, 7) !== hash01(5, 6, 8)
    );
    t.ok(
      'hashU32 is an unsigned 32-bit integer, negative inputs included',
      hashU32(-1) >= 0 && hashU32(-1) <= 0xffffffff && Number.isInteger(hashU32(123456))
    );
  }

  // ── THE PALETTE: measured from the painted campfires — one hue band, cream to deep orange ────────────────────
  {
    const burn = BILLOW_FLAME_RAMP.filter((s) => s.t >= 0.2);
    t.ok(
      'the flame ramp runs hottest first, t descending to 0',
      BILLOW_FLAME_RAMP.every((s, i, a) => i === 0 || s.t < a[i - 1].t) && BILLOW_FLAME_RAMP.at(-1).t === 0
    );
    t.ok(
      'every burning stop sits in the painted flame’s ONE hue band (the art is 20-54 degrees)',
      burn.every((s) => hueDeg(s.hex) > 20 && hueDeg(s.hex) < 54)
    );
    t.ok('the cream core is the painted #fede70', BILLOW_FLAME_RAMP[0].hex === '#fede70');
    t.ok(
      'the smoke is warm: every grey leans red (r >= b)',
      Object.values(BILLOW_SMOKE_RAMP).every(
        (h) => Number.parseInt(h.slice(1, 3), 16) >= Number.parseInt(h.slice(5, 7), 16)
      )
    );
  }

  // ── THE SMALL FUNCTIONS ──────────────────────────────────────────────────────────────────────────────────────
  t.ok(
    'billowLeanGain is 0 at calm, 1 at a gale, and rises monotonically between',
    billowLeanGain(0) === 0 &&
      Math.abs(billowLeanGain(1) - 1) < 1e-12 &&
      billowLeanGain(0.3) < billowLeanGain(0.6) &&
      billowLeanGain(0.6) < billowLeanGain(0.9)
  );
  t.ok('billowLeanGain clamps its input', billowLeanGain(-3) === 0 && Math.abs(billowLeanGain(9) - 1) < 1e-12);
  t.ok(
    'billowPower: a healthy calm fire is 1, a dead one 0, and stress removes up to 72%',
    billowPower(1, 0) === 1 && billowPower(0, 0) === 0 && Math.abs(billowPower(1, 1) - 0.28) < 1e-12
  );
  {
    let sum = 0;
    let lo = 9;
    let hi = -9;
    for (let i = 0; i < 4000; i++) {
      const p = billowPulse(i * 0.013, 1.6, 0.2, 3);
      sum += p;
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    t.ok(
      'the breathing pulse averages ~1 and never collapses to nothing',
      Math.abs(sum / 4000 - 1) < 0.03 && lo > 0.5 && hi < 1.5
    );
  }
  {
    let on = 0;
    const angles = new Set();
    const N = 6000;
    for (let i = 0; i < N; i++) {
      const d = billowDraft(i * 0.1, 11, 0.22);
      if (d.motion01 > 0.02) on++;
      angles.add(Math.round(d.angle * 100));
      if (d.motion01 > 0.22 + 1e-9 || d.motion01 < 0) throw new Error('draft out of range');
    }
    t.ok(
      `a sealed room's draft is an OCCASIONAL puff (on ${((on / N) * 100).toFixed(1)}% of the time), never constant and never absent`,
      on / N > 0.03 && on / N < 0.6
    );
    t.ok('each draft blows from a fresh direction', angles.size > 20);
  }

  // ── EMIT: determinism, finiteness, bounds ────────────────────────────────────────────────────────────────────
  {
    const a = emit();
    const b = emit();
    t.ok(
      'a flame emits a body, tongues, flecks, coals and smoke (dozens of lobes)',
      a.r.flame > 40 && a.r.coal > 4 && a.r.smoke > 3
    );
    t.ok(
      'emit is deterministic: the same fire at the same time is byte-identical',
      a.r.count === b.r.count && a.flame.subarray(0, a.r.count * LOBE_STRIDE).every((v, i) => v === b.flame[i])
    );
    const c = emit({}, { tSec: 12.3 });
    t.ok(
      'the clock moves the flame',
      c.flame.subarray(0, 60).some((v, i) => v !== a.flame[i])
    );
    const list = lobesOf(a.flame, a.r.count);
    t.ok(
      'every lobe number is finite',
      list.every((l) => Object.values(l).every(Number.isFinite))
    );
    t.ok(
      'radius and strength are never negative; the lobe kinds are valid',
      list.every((l) => l.r >= 0 && l.w >= 0 && (l.kind === KIND_FLAME || l.kind === KIND_COAL))
    );
    t.ok(
      'heat stays in 0..1',
      list.every((l) => l.heat >= 0 && l.heat <= 1.0001)
    );
    t.ok(
      'stretch is a real scale (>= 1 along, > 0 across)',
      list.every((l) => l.along >= 1 && l.across > 0)
    );
    const smoke = lobesOf(a.smoke, a.r.smoke);
    t.ok(
      'smoke goes to its own buffer, all KIND_SMOKE, with a tone in 0..1',
      smoke.length === a.r.smoke && smoke.every((l) => l.kind === KIND_SMOKE && l.tone >= 0 && l.tone <= 1)
    );
    // with no separate smoke buffer the smoke rides in the main one (the old single-buffer contract)
    const single = new Float32Array(maxLobesPerFire(50) * LOBE_STRIDE * 2);
    const rs = emitFireLobes(single, 0, FIRE, ENV);
    t.ok('with no smoke buffer the smoke is written into the main one', rs.count === a.r.count + a.r.smoke);
  }

  // ── NEVER OVERRUN THE BUDGET, NEVER A NaN — across sizes, weather, life and a long clock ──────────────────────
  {
    let worst = 0;
    let bad = 0;
    const cases = [
      { radius: 12 },
      { radius: 50 },
      { radius: 140 },
      { radius: 300 },
      { radius: 50, windMotion01: 1, windX: 1, windY: 0 },
      { radius: 50, stress01: 1, rain01: 1 },
      { radius: 50, vitality01: 0.2, coal01: 0.9 },
      { radius: 50, outdoor01: 0 },
      { radius: 50, intensity: 2, spitMul: 6, smokeMul: 4 },
    ];
    for (const fc of cases) {
      const cap = maxLobesPerFire(fc.radius);
      for (let i = 0; i < 60; i++) {
        const flame = new Float32Array(cap * 3 * LOBE_STRIDE);
        const smoke = new Float32Array(cap * 3 * LOBE_STRIDE);
        const r = emitFireLobes(flame, 0, { ...FIRE, ...fc }, { ...ENV, tSec: i * 7.77 + 100 }, undefined, smoke, 0);
        worst = Math.max(worst, r.count / cap, r.smoke / cap);
        for (const v of flame.subarray(0, r.count * LOBE_STRIDE)) if (!Number.isFinite(v)) bad++;
        for (const v of smoke.subarray(0, r.smoke * LOBE_STRIDE)) if (!Number.isFinite(v)) bad++;
      }
    }
    t.ok(`maxLobesPerFire is a true upper bound (worst case used ${(worst * 100).toFixed(0)}% of it)`, worst <= 1);
    t.ok('no NaN or Infinity in any lobe, in any condition', bad === 0);
  }

  // ── VITALITY: a fire's flame shrinks smoothly to its coals; a dead fire is dark ──────────────────────────────
  {
    const n = (v, extra = {}) => emit({ vitality01: v, ...extra }).r;
    const full = n(1);
    const half = n(0.45);
    const low = n(0.1);
    const out = n(0, { coal01: 0 });
    t.ok(
      `flame lobes fall as vitality falls (${full.flame} > ${half.flame} > ${low.flame})`,
      full.flame > half.flame && half.flame > low.flame
    );
    t.ok(
      'a fire with no vitality and cold coals emits NOTHING — no flame, no coals, no smoke',
      out.flame === 0 && out.coal === 0 && out.smoke === 0
    );
    const embers = n(0, { coal01: 0.8 });
    t.ok(
      'a put-out fire with hot coals is its coal bed alone: coals, and no flame body',
      embers.coal > 4 && embers.flame < 6
    );
    t.ok(
      'coal lobes carry the heat of the bed',
      (() => {
        const e = emit({ vitality01: 0, coal01: 0.6 });
        const coals = lobesOf(e.flame, e.r.count).filter((l) => l.kind === KIND_COAL);
        return coals.length > 0 && coals.every((l) => l.heat > 0.6 * 0.74 && l.heat <= 0.6 + 1e-9);
      })()
    );
    t.ok(
      'a burning fire shows its coal bed too, but the coals are not the flame',
      (() => {
        const e = emit();
        return lobesOf(e.flame, e.r.count).filter((l) => l.kind === KIND_COAL).length > 0;
      })()
    );
  }

  // ── TWO FIRES IN ONE EFFECT: the hearth is low and contained, the bonfire tall and wild ───────────────────────
  {
    const stat = (outdoor01) => {
      let zMax = 0;
      let smokeN = 0;
      let flecks = 0;
      let flameN = 0;
      const T = 40;
      for (let i = 0; i < T; i++) {
        const e = emit({ outdoor01 }, { tSec: 30 + i * 0.37 });
        const fl = lobesOf(e.flame, e.r.count).filter((l) => l.kind === KIND_FLAME);
        zMax += Math.max(...fl.map((l) => l.z));
        smokeN += e.r.smoke;
        flameN += e.r.flame;
        flecks += fl.filter((l) => l.r < 5 && l.along > 1.3).length;
      }
      return { zMax: zMax / T, smoke: smokeN / T, flame: flameN / T, flecks: flecks / T };
    };
    const hearth = stat(0);
    const bonfire = stat(1);
    t.ok(
      `a bonfire stands taller than a hearth (${bonfire.zMax.toFixed(0)} vs ${hearth.zMax.toFixed(0)} px)`,
      bonfire.zMax > hearth.zMax * 1.5
    );
    t.ok(
      `a bonfire smokes far more than a hearth (${bonfire.smoke.toFixed(1)} vs ${hearth.smoke.toFixed(1)} lobes)`,
      bonfire.smoke > hearth.smoke * 2
    );
    t.ok(
      `a bonfire throws more flecks than a hearth (${bonfire.flecks.toFixed(1)} vs ${hearth.flecks.toFixed(1)})`,
      bonfire.flecks > hearth.flecks * 1.4
    );
    const mid = stat(0.5);
    t.ok(
      'the regime is a blend, not a switch: half-open sits between the two',
      mid.zMax > hearth.zMax && mid.zMax < bonfire.zMax && mid.smoke > hearth.smoke && mid.smoke < bonfire.smoke
    );
  }

  // ── WIND LEANS THE FLAME; IT DOES NOT FLING IT ───────────────────────────────────────────────────────────────
  {
    const cx = (e) => {
      const fl = burning(lobesOf(e.flame, e.r.count)).filter((l) => l.w > 0.5 && l.r > 2);
      return mean(fl.map((l) => l.x)) - FIRE.x;
    };
    const avgShift = (extra) => {
      let s = 0;
      const T = 24;
      for (let i = 0; i < T; i++) s += cx(emit(extra, { tSec: 20 + i * 0.53, parallax: 0, tilt: 0 }));
      return s / T;
    };
    const calm = avgShift({ windMotion01: 0, windX: 1, windY: 0, outdoor01: 1 });
    const east = avgShift({ windMotion01: 1, windX: 1, windY: 0, outdoor01: 1 });
    const west = avgShift({ windMotion01: 1, windX: -1, windY: 0, outdoor01: 1 });
    t.ok(
      `a gale from the west leans the flame EAST (${east.toFixed(1)} px vs calm ${calm.toFixed(1)})`,
      east > calm + 0.3 * FIRE.radius
    );
    t.ok(
      `and from the east leans it WEST, symmetrically (${west.toFixed(1)})`,
      west < calm - 0.3 * FIRE.radius && Math.abs(east + west - 2 * calm) < 0.35 * FIRE.radius
    );
    t.ok(
      'the lean is bounded — kinematic by age, so a gale cannot fling the flame away (< 6 R)',
      Math.abs(east) < 6 * FIRE.radius
    );
    const quarter = avgShift({ windMotion01: 0.25, windX: 1, windY: 0, outdoor01: 1 });
    t.ok('the lean grows with the wind, quiet at the bottom of the dial', quarter > calm && quarter < east * 0.7);
    // a stream: older lobes lean further than younger (the flame bends as one body)
    const e = emit({ windMotion01: 1, windX: 1, windY: 0 }, { parallax: 0, tilt: 0 });
    const fl = burning(lobesOf(e.flame, e.r.count)).filter((l) => l.along > 1.01);
    t.ok(
      'wind stretches lobes ALONG the wind (streaks), pointing downwind',
      fl.length > 5 && fl.filter((l) => Math.abs(l.dx) > 0.7).length > fl.length * 0.5
    );
  }

  // ── WEATHER MAKES THE FLAME SMALLER, COOLER, THINNER — AS A WHOLE ─────────────────────────────────────────────
  {
    const meanRadius = (extra) => {
      let s = 0;
      let n = 0;
      for (let i = 0; i < 20; i++) {
        const e = emit(extra, { tSec: 25 + i * 0.41 });
        for (const l of burning(lobesOf(e.flame, e.r.count)).filter((l) => l.w > 0.5)) {
          s += l.r;
          n++;
        }
      }
      return s / n;
    };
    const dry = meanRadius({ stress01: 0 });
    const wet = meanRadius({ stress01: 1, rain01: 1 });
    t.ok(
      `stress shrinks the flame as a whole (${wet.toFixed(2)} vs ${dry.toFixed(2)} px mean radius)`,
      wet < dry * 0.75
    );
    const heatOf = (extra) =>
      mean(
        burning(lobesOf(emit(extra).flame, emit(extra).r.count))
          .filter((l) => l.w > 0.5)
          .map((l) => l.heat)
      );
    t.ok(
      'a stressed flame is cooler (it walks down the colour ramp)',
      heatOf({ stress01: 1 }) < heatOf({ stress01: 0 }) * 0.95
    );
  }

  // ── A DOUSED FIRE STEAMS ─────────────────────────────────────────────────────────────────────────────────────
  {
    const steamOf = (extra) => {
      const e = emit({ vitality01: 0.4, coal01: 0.9, ...extra });
      const s = lobesOf(e.smoke, e.r.smoke);
      return { n: s.length, wet: mean(s.map((l) => l.heat)) };
    };
    const dryFire = steamOf({ rain01: 0 });
    const rained = steamOf({ rain01: 1 });
    t.ok(
      'rain on a hot fire makes WET smoke (steam): its smoke lobes carry the wetness',
      rained.wet > 0.2 && dryFire.wet < 0.01
    );
    t.ok('and more of it than the same fire dry', rained.n >= dryFire.n);
    const dead = emit({ vitality01: 0, coal01: 0, rain01: 0 });
    t.ok('a cold dead fire does not smoke at all', dead.r.smoke === 0);
  }

  // ── THE CAMERA: height is parallax and the 3/4 lift; the side view is the same billows ─────────────────────────
  {
    const top0 = emit({}, { parallax: 0, tilt: 0 });
    const top5 = emit({}, { parallax: 0, tilt: 0.5 });
    const a = lobesOf(top0.flame, top0.r.count);
    const b = lobesOf(top5.flame, top5.r.count);
    t.ok('the same fire at the same time gives the same lobes whatever the camera', a.length === b.length);
    t.ok(
      'tilt lifts each lobe UP THE PAGE by tilt x its height (screen y falls as z rises)',
      a.every(
        (l, i) => Math.abs(l.y - 0.5 * a[i].z - b[i].y) < 1e-3 * (1 + Math.abs(l.y)) && Math.abs(l.x - b[i].x) < 1e-3
      )
    );
    const para = emit({}, { parallax: 1, tilt: 0, camX: 2000 + 700, camY: 2000 });
    const flat = emit({}, { parallax: 0, tilt: 0, camX: 2000 + 700, camY: 2000 });
    const pl = lobesOf(para.flame, para.r.count);
    const fl = lobesOf(flat.flame, flat.r.count);
    t.ok(
      'parallax pushes a tall billow AWAY from the view centre and magnifies it',
      pl.some((l, i) => fl[i].z > 40 && l.x < fl[i].x - 1 && l.r > fl[i].r * 1.01)
    );
    t.ok(
      'and leaves ground-level billows exactly where they are',
      pl.every((l, i) => fl[i].z > 0.01 || Math.abs(l.x - fl[i].x) < 1e-6)
    );
    const side = emit({}, { projection: 'side', groundY: 2000, sideScale: 1 });
    const sl = lobesOf(side.flame, side.r.count);
    // (the lobes are stored as float32: at a y of 2000 the spacing is 1.2e-4, so "exactly" means to that)
    t.ok(
      'the side view puts height on the vertical axis (y = ground - z), x unchanged',
      sl.length === fl.length &&
        sl.every((l, i) => Math.abs(l.y - (2000 - l.z)) < 2e-3 && Math.abs(l.x - fl[i].x) < 1e-3)
    );
    t.ok(
      'the side view flame stands well clear of the ground (a tall plume, not a mound)',
      Math.max(...sl.filter((l) => l.kind === KIND_FLAME).map((l) => l.z)) > 1.2 * FIRE.radius
    );
  }

  // ── SPIT EMBERS lie where they land and the dial turns them off ───────────────────────────────────────────────
  {
    const tiny = (extra, tSec) => {
      const e = emit({ spitMul: 4, ...extra }, { tSec });
      return burning(lobesOf(e.flame, e.r.count)).filter((l) => l.r < 4.5 && l.r > 0.3 && l.w > 1.3 && l.w < 1.4);
    };
    let withSpit = 0;
    let without = 0;
    for (let i = 0; i < 80; i++) {
      withSpit += tiny({}, 50 + i * 1.3).length;
      without += tiny({ spitMul: 0 }, 50 + i * 1.3).length;
    }
    t.ok(
      `the spitting-embers dial adds embers (${withSpit} vs ${without} ember-sized lobes over 80 instants)`,
      withSpit > without * 3 + 20
    );
    // an ember in the air is higher than one on the ground, and a landed one has z = 0
    const e = emit({ spitMul: 6 }, { tSec: 61.1 });
    const grounded = burning(lobesOf(e.flame, e.r.count)).filter((l) => l.w > 1.3 && l.w < 1.4 && l.z === 0);
    t.ok('landed embers rest ON THE GROUND (height 0) and lie where they fell', grounded.length > 0);
  }

  // ── A STRAY PAINTED POINT CANNOT ROOT A FLAME PIECE OUTSIDE THE FIRE ──────────────────────────────────────────
  // (2026-10-20, the real viewer: two dim points 330 px north of a bonfire, really the edge of a roof's paint, rooted
  // tongues and billows that stood alone in the air above the flame — a detached teardrop. The engine now hands a flame
  // only its own blob's points; this is the second wall.)
  {
    const R = FIRE.radius;
    const ring = 60;
    const cloud = new Float32Array((ring + 1) * 4);
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      cloud.set([FIRE.x + Math.cos(a) * R * 0.6, FIRE.y + Math.sin(a) * R * 0.6, 1, 3], i * 4);
    }
    cloud.set([FIRE.x, FIRE.y - 400, 0.03, 3], ring * 4); // the stray: eight radii north
    const spawn = { spawn: cloud, spawnCount: ring + 1, spawnStride: 4 };

    const out = [0, 0, 1];
    const stray = basePoint({ x: FIRE.x, y: FIRE.y, ...spawn }, R, 60 / 61 + 0.001, 0.2, 0.3, 0.55, out);
    const strayD = Math.hypot(stray[0] - FIRE.x, stray[1] - FIRE.y);
    t.ok(
      `a base rooted on the stray is held to 1.15 radii of the centre (${strayD.toFixed(1)} of ${(1.15 * R).toFixed(1)})`,
      strayD <= 1.15 * R + 1e-6 && stray[1] < FIRE.y - 0.5 * R
    );
    const own = basePoint({ x: FIRE.x, y: FIRE.y, ...spawn }, R, 0.3, 0.2, 0.3, 0.55, out);
    t.ok(
      'and a base on one of the fire’s own points is not moved by it',
      Math.hypot(own[0] - FIRE.x, own[1] - FIRE.y) < 0.6 * R
    );

    let far = 0;
    let n = 0;
    for (let i = 0; i < 240; i++) {
      // no flecks and no spit: those are THROWN, by design, and wander off on their own
      const e = emit(
        { ...spawn, spitMul: 0 },
        { tSec: 3 + i * 0.37, parallax: 0, tilt: 0 },
        { fleckBase: 0, fleckPerR: 0 }
      );
      for (const l of burning(lobesOf(e.flame, e.r.count))) {
        n++;
        far = Math.max(far, Math.hypot(l.x - FIRE.x, l.y - FIRE.y));
      }
    }
    t.ok(
      `with a stray in the cloud, no flame lobe of 240 instants stands farther than 2.2 radii out (${far.toFixed(0)} of ${(2.2 * R).toFixed(0)}, ${n} lobes)`,
      far <= 2.2 * R
    );
  }

  // ── THE DIALS: size, height and the author's tune overrides ───────────────────────────────────────────────────
  {
    const width = (tune) => {
      const e = emit({}, { parallax: 0, tilt: 0 }, tune);
      const body = burning(lobesOf(e.flame, e.r.count)).filter((l) => l.w > 0.9);
      return Math.max(...body.map((l) => Math.hypot(l.x - FIRE.x, l.y - FIRE.y) + l.r));
    };
    t.ok(
      'the plume-radius tune widens the flame',
      width({ bodyRadius: BILLOW_TUNE.bodyRadius * 1.6 }) > width({}) * 1.25
    );
    t.ok(
      'quality scales the budget (a lower tier draws fewer lobes)',
      emit({}, { quality: 0.4 }).r.count < emit({}, { quality: 1 }).r.count * 0.7
    );
    t.ok('an unknown tune key is harmless', emit({}, {}, { nonsense: 1 }).r.count === emit().r.count);
  }

  // ── THE SMOKE'S SHAPE: born small, grows as it climbs, rises up the page, black with soot (2026-10-20, round 2) ──────
  {
    const lobesAt = (extra = {}, env = {}, tune) => {
      const out = [];
      for (let i = 0; i < 60; i++) {
        const e = emit({ vitality01: 1, coal01: 1, ...extra }, { tSec: 5 + i * 0.61, ...env }, tune);
        out.push(...lobesOf(e.smoke, e.r.smoke));
      }
      return out;
    };
    const young = lobesAt().filter((l) => l.tone < 0.3);
    const old = lobesAt().filter((l) => l.tone > 0.7);
    t.ok(
      `a smoke billow is born small and grows as it climbs (${mean(young.map((l) => l.r)).toFixed(1)} px young, ${mean(old.map((l) => l.r)).toFixed(1)} px old)`,
      young.length > 20 && old.length > 20 && mean(old.map((l) => l.r)) > 1.5 * mean(young.map((l) => l.r))
    );
    const sootOf = (extra) => mean(lobesAt(extra).map((l) => l.heat));
    t.ok(
      'a sooty fuel’s smoke carries NEGATIVE colour (soot), a clean one none',
      sootOf({ sootiness01: 0.8 }) < -0.5 && Math.abs(sootOf({ sootiness01: 0 })) < 0.01
    );
    t.ok(
      'and rain washes it: wet smoke is steam (positive), soot or no soot',
      sootOf({ sootiness01: 0.8, rain01: 1 }) > sootOf({ sootiness01: 0.8 }) + 0.3 && sootOf({ rain01: 1 }) > 0.05
    );
    const meanY = (tune, env) => mean(lobesAt({}, env, tune).map((l) => l.y));
    const flatEnv = { parallax: 0, tilt: 0.3 };
    t.ok(
      'from above, smoke climbs UP THE PAGE faster than its height says (the lift cheat): more lift, smaller screen y',
      meanY({ smokeLift: 3.4 }, flatEnv) < meanY({ smokeLift: 1 }, flatEnv) - 4
    );
    const sideEnv = { projection: 'side', groundY: 2000, sideScale: 1 };
    t.ok(
      'but the side view keeps the true height (no cheat there)',
      Math.abs(meanY({ smokeLift: 3.4 }, sideEnv) - meanY({ smokeLift: 1 }, sideEnv)) < 1e-3
    );
  }

  // ── THE COLUMN OF A BURNING MASS (emitMassSmoke) ───────────────────────────────────────────────────────────────────
  {
    const MASS = Object.freeze({
      x: 3000,
      y: 3000,
      radius: 300,
      baseZ: 90,
      seed: 5,
      lit01: 1,
      vitality01: 1,
      coal01: 1,
      stress01: 0,
      rain01: 0,
      outdoor01: 1,
      windX: 0,
      windY: 0,
      windMotion01: 0,
      smokeMul: 1,
      sootiness01: 0.7,
    });
    const column = (m = {}, env = {}, tune, tSec = 20) => {
      const buf = new Float32Array(80 * LOBE_STRIDE).fill(-777);
      const start = 3;
      const r = emitMassSmoke(buf, start, { ...MASS, ...m }, { ...ENV, parallax: 0, tSec, ...env }, tune);
      return { buf, start, count: r.count, lobes: lobesOf(buf.subarray(start * LOBE_STRIDE), r.count) };
    };
    const a = column();
    t.ok(
      `a burning mass makes a COLUMN: dozens of smoke billows (${a.count})`,
      a.count >= 14 &&
        a.count <= MASS_SMOKE_MAX &&
        a.lobes.every((l) => l.kind === KIND_SMOKE && l.tone >= 0 && l.tone <= 1)
    );
    t.ok(
      'they are written at `start` and nowhere else (the buffer around them is untouched), every number finite',
      a.buf.subarray(0, a.start * LOBE_STRIDE).every((v) => v === -777) &&
        a.buf.subarray((a.start + a.count) * LOBE_STRIDE).every((v) => v === -777) &&
        a.lobes.every((l) => Object.values(l).every(Number.isFinite))
    );
    const again = column();
    t.ok(
      'the same mass at the same time is the same column (and the clock moves it)',
      a.buf.every((v, i) => v === again.buf[i]) && column({}, {}, undefined, 21.3).buf.some((v, i) => v !== a.buf[i])
    );
    const zs = a.lobes.map((l) => l.z);
    t.ok(
      `it climbs well above the roof: from the flame tops (${MASS.baseZ}) to over a radius higher (${Math.max(...zs).toFixed(0)})`,
      Math.min(...zs) >= MASS.baseZ - 1e-6 && Math.max(...zs) > MASS.baseZ + MASS.radius
    );
    const lowHalf = a.lobes.filter((l) => l.z < MASS.baseZ + MASS.radius * 0.8);
    const highHalf = a.lobes.filter((l) => l.z > MASS.baseZ + MASS.radius * 1.2);
    t.ok(
      `and it widens as it climbs (${mean(lowHalf.map((l) => l.r)).toFixed(0)} px low, ${mean(highHalf.map((l) => l.r)).toFixed(0)} px high)`,
      lowHalf.length > 3 && highHalf.length > 3 && mean(highHalf.map((l) => l.r)) > 1.5 * mean(lowHalf.map((l) => l.r))
    );
    t.ok(
      'from above it reaches up the page (the highest billows are far above the roof on screen)',
      a.lobes.filter((l) => l.z > MASS.baseZ + MASS.radius * 1.2).every((l) => l.y < MASS.y - 0.3 * l.z)
    );
    t.ok(
      'its billows are bigger than a campfire’s (a roof’s column, not a puff)',
      Math.max(...a.lobes.map((l) => l.r)) > 2 * Math.max(...lobesOf(emit().smoke, emit().r.smoke).map((l) => l.r))
    );
    const bigger = column({ radius: 600 });
    t.ok(
      'a bigger mass makes a bigger column (more, wider, higher)',
      bigger.count >= a.count &&
        Math.max(...bigger.lobes.map((l) => l.r)) > 1.5 * Math.max(...a.lobes.map((l) => l.r)) &&
        Math.max(...bigger.lobes.map((l) => l.z)) > Math.max(...zs) * 1.3
    );
    t.ok(
      'a part-lit mass (a spreading front) makes less: fewer billows from a smaller radius',
      column({ lit01: 0.25, radius: 300 * Math.sqrt(0.25) }).count < a.count &&
        column({ lit01: 0.25, radius: 150 }).count > 0
    );
    const dead = column({ vitality01: 0, coal01: 0 });
    t.ok('a mass that is out and cold makes none', dead.count === 0);
    const smoulder = column({ vitality01: 0, coal01: 1 });
    t.ok('but a smouldering one still does, a little', smoulder.count > 0 && smoulder.count < a.count);
    t.ok(
      'indoors the column hardly climbs and is thinner (a roofed room’s smoke has nowhere to go)',
      Math.max(...column({ outdoor01: 0 }).lobes.map((l) => l.z)) < Math.max(...zs) * 0.7 &&
        column({ outdoor01: 0 }).count < a.count
    );
    t.ok(
      'the smoke multiplier scales the number of billows',
      column({ smokeMul: 0.4 }).count < a.count && column({ smokeMul: 0 }).count === 0
    );
    const xTop = (m) =>
      mean(
        column(m)
          .lobes.filter((l) => l.z > MASS.baseZ + MASS.radius * 1.2)
          .map((l) => l.x)
      );
    const still = xTop({});
    t.ok(
      'wind LEANS the column downwind, both ways, by about the same',
      xTop({ windX: 1, windMotion01: 1 }) > still + 25 &&
        xTop({ windX: -1, windMotion01: 1 }) < still - 25 &&
        Math.abs(xTop({ windX: 1, windMotion01: 1 }) - still + (xTop({ windX: -1, windMotion01: 1 }) - still)) < 40
    );
    const heatOf = (m) => mean(column(m).lobes.map((l) => l.heat));
    t.ok(
      'a building’s smoke is black (soot: negative colour), more so the sootier the fuel, none for a clean one',
      heatOf({ sootiness01: 0.8 }) < heatOf({ sootiness01: 0.4 }) &&
        heatOf({ sootiness01: 0.4 }) < -0.1 &&
        Math.abs(heatOf({ sootiness01: 0 })) < 0.01
    );
    t.ok(
      'the base of the column is lighter than its top (lit by the fire, then greying and darkening)',
      mean(
        column()
          .lobes.filter((l) => l.tone < 0.3)
          .map((l) => l.heat)
      ) >
        mean(
          column()
            .lobes.filter((l) => l.tone > 0.7)
            .map((l) => l.heat)
        )
    );
    t.ok(
      'and rain turns it to steam (positive colour)',
      heatOf({ rain01: 1, sootiness01: 0 }) > 0.05 &&
        heatOf({ rain01: 1, sootiness01: 0.7 }) > heatOf({ sootiness01: 0.7 })
    );
    t.ok(
      'the author’s tune overrides reach it (a taller `massRise` climbs higher)',
      Math.max(...column({}, {}, { massRise: BILLOW_TUNE.massRise * 2 }).lobes.map((l) => l.z)) > Math.max(...zs) * 1.4
    );
    const side = column({}, { projection: 'side', groundY: 3000, sideScale: 1 });
    t.ok(
      'the side view draws it too, with height on the vertical axis (no up-the-page lift)',
      side.count === a.count && side.lobes.every((l) => Math.abs(l.y - (3000 - l.z)) < 5e-3)
    );
    t.ok(
      'a nonsense mass is harmless: no NaN, no overrun',
      (() => {
        const b = column({ radius: NaN, seed: undefined, lit01: undefined, outdoor01: NaN, windX: NaN, windY: NaN });
        return (
          b.count >= 0 && b.count <= MASS_SMOKE_MAX && b.lobes.every((l) => Object.values(l).every(Number.isFinite))
        );
      })()
    );
  }
}
