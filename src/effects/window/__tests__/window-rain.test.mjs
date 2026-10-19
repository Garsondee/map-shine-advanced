/**
 * Node verification for window-rain.js — the rain-on-glass drops: the JS twin
 * (every formula the shader evaluates) and that the TSL graph constructs.
 *
 * The properties that matter, each pinned below:
 *   - a dry pane is EXACTLY identity (offset 0, gain 1) - the dry picture must
 *     not change by a single bit when this feature exists;
 *   - more rain is more water, monotonically, through drizzle to storm;
 *   - sliders only ever move TOWARD the sill, and they stick and slip;
 *   - across a facet blend nothing jumps (no rotated lattice to tear);
 *   - the wind makes windward panes wetter than leeward ones;
 *   - the numbers the shader can emit are finite and bounded.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  RAIN_TUNE,
  WINDOW_RAIN_DEFAULTS,
  NO_FLOW,
  hashU32,
  hash2,
  rainKindWeight,
  stepWindowWetness,
  resolveRainFrame,
  directionMix,
  windExposure,
  filmField,
  evalSplatLayer,
  vnoise,
  evalFacetFrame,
  evalWindowRainPixel,
  createWindowRain,
  rainMaskFade,
  RAIN_MASK_FADE_SOFT,
} from '../window-rain.js';

const look = { ...WINDOW_RAIN_DEFAULTS };
const clamp01Test = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstepTest = (a, b, x) => {
  const u = clamp01Test((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};

/** The pre-2026-10-19 dials: a few tests below assert the shape of the model at a moderate look, not the shipped one. */
const moderateLook = {
  ...look,
  response: 1,
  dropScalePx: 1.2,
  splatDensity: 1,
  refraction: 1,
  caustic: 0.8,
  rimDarken: 0.35,
  sliders: 0.7,
  slideSpeed: 1,
  trail: 0.6,
  projectionStretch: 0.35,
  windwardBias: 0.6,
  sheeting: 0.6,
};

/** The frame for a given rain amount, with the wet share the glass would hold in steady rain. */
const frameFor = (rain01, extra = {}) => ({
  ...resolveRainFrame({ rain01, wet01: Math.min(1, rain01 * 1.6), look }),
  windFlowX: 0,
  windFlowY: 1,
  ...extra,
});

const flowSouth = { px: 0, py: 1, qx: 0, qy: 1, mix: 0, kappa: 1, h: 0.5, gate: 1 };

function mean(a) {
  return a.reduce((s, v) => s + v, 0) / a.length;
}

export function run(t) {
  // ── 1. The integer hash ──────────────────────────────────────────────────
  {
    let inRange = true;
    const xs = [];
    const ys = [];
    for (let i = 0; i < 4000; i++) {
      const g = hash2(i - 2000, i * 3 + 7, i % 61, 2);
      if (!(g[0] >= 0 && g[0] < 1 && g[1] >= 0 && g[1] < 1)) inRange = false;
      xs.push(g[0]);
      ys.push(g[1]);
    }
    t.ok('rain: hashes stay in [0, 1)', inRange);
    t.ok('rain: the hash is about uniform (mean ' + mean(xs).toFixed(3) + ')', Math.abs(mean(xs) - 0.5) < 0.03);
    // The two components must not be the same number.
    const mx = mean(xs);
    const my = mean(ys);
    let cov = 0;
    let vx = 0;
    let vy = 0;
    for (let i = 0; i < xs.length; i++) {
      cov += (xs[i] - mx) * (ys[i] - my);
      vx += (xs[i] - mx) ** 2;
      vy += (ys[i] - my) ** 2;
    }
    t.ok(
      'rain: the two components are uncorrelated (r ' + (cov / Math.sqrt(vx * vy)).toFixed(3) + ')',
      Math.abs(cov / Math.sqrt(vx * vy)) < 0.06
    );
    t.ok(
      'rain: the hash is deterministic',
      hash2(3, -9, 5, 7)[0] === hash2(3, -9, 5, 7)[0] && hashU32(1, 2, 3, 4) === hashU32(1, 2, 3, 4)
    );
    // Large cell indices (a big map, hours of cycles) must still give a spread, not a constant.
    const big = new Set();
    for (let i = 0; i < 200; i++) big.add(hashU32(500000 + i, 700000 + i * 2, i, 9));
    t.ok('rain: the hash still spreads at large coordinates', big.size === 200);
    // Neighbouring cells must not hash alike: the avalanche (each input bit moves about half the output bits).
    let bitsChanged = 0;
    let trials = 0;
    for (let i = 0; i < 300; i++) {
      const base = hashU32(i, 5, 7, 9);
      for (const alt of [hashU32(i + 1, 5, 7, 9), hashU32(i, 6, 7, 9), hashU32(i, 5, 8, 9), hashU32(i, 5, 7, 10)]) {
        let diff = base ^ alt;
        let c = 0;
        while (diff) {
          c += diff & 1;
          diff >>>= 1;
        }
        bitsChanged += c;
        trials++;
      }
    }
    t.ok(
      'rain: changing any input flips about half the output bits (' + (bitsChanged / trials).toFixed(1) + ' of 32)',
      Math.abs(bitsChanged / trials - 16) < 1.5
    );
    // GOLDEN VALUES. Integer arithmetic is exact, so the shader must produce these very numbers; the lab's
    // twin-parity scenario depends on that, and a change here is a change to every drop on every map.
    t.ok('rain: golden hashU32(1,2,3,4)', hashU32(1, 2, 3, 4) === 1775402438);
    t.ok(
      'rain: golden hashU32 with negative inputs',
      hashU32(-5, 7, 0, 45) === 3660054204 && hashU32(100, -200, 60, 46) === 3059079483
    );
    const g = hash2(12, 34, 5, 102);
    t.ok('rain: golden hash2', g[0] === 0.6366791129112244 && g[1] === 0.13042867183685303);
    t.ok(
      'rain: the 24-bit unit value is exactly representable in float32',
      Math.fround(g[0]) === g[0] && Math.fround(g[1]) === g[1]
    );
  }

  // ── 2. What counts as rain, and how wet the glass is ─────────────────────
  {
    t.ok('rain: rain is full rain', rainKindWeight('rain', 0) === 1);
    t.ok('rain: sleet is the warm share of the mix', Math.abs(rainKindWeight('sleet', 0.25) - 0.75) < 1e-12);
    t.ok(
      'rain: snow, hail, ash and embers are not rain on glass',
      ['snow', 'hail', 'ash', 'embers', 'auto', undefined].every((k) => rainKindWeight(k, 0) === 0)
    );
    t.ok('rain: a non-finite mix weight does not poison sleet', Number.isFinite(rainKindWeight('sleet', NaN)));

    let w = 0;
    for (let i = 0; i < 40; i++) w = stepWindowWetness(w, 1, 1, 40);
    t.ok('rain: steady rain wets the glass fully (' + w.toFixed(3) + ')', w > 0.99);
    t.ok('rain: wetness never exceeds 1', w <= 1);
    const held = stepWindowWetness(0.2, 0.5, 5, 40);
    t.ok(
      'rain: wetness is held up by rain still falling',
      held >= 0.2 && stepWindowWetness(0.9, 0.5, 100, 1) >= 0.8 - 1e-9
    );
    let dry = 1;
    for (let i = 0; i < 40; i++) dry = stepWindowWetness(dry, 0, 1, 40);
    t.ok(
      'rain: after one linger time the glass keeps 1/e of its water (' + dry.toFixed(3) + ')',
      Math.abs(dry - Math.exp(-1)) < 0.02
    );
    t.ok(
      'rain: a huge frame step is clamped to a 5 s step',
      stepWindowWetness(0, 1, 1e6, 40) === stepWindowWetness(0, 1, 5, 40)
    );
    t.ok('rain: a NaN step is harmless', Number.isFinite(stepWindowWetness(0.5, 0, NaN, NaN)));
  }

  // ── 3. Weather resolved to what the shader reads ─────────────────────────
  {
    const dry = resolveRainFrame({ rain01: 0, wet01: 0, look });
    t.ok(
      'rain: a dry day has no presence, so the shader skips the work',
      dry.presence === 0 && dry.cover === 0 && dry.slider === 0 && dry.sheet === 0
    );
    t.ok('rain: a dry day dims nothing', dry.dim === 1 && dry.impact === 0);

    let monotone = true;
    let prev = frameFor(0);
    for (let r = 0.02; r <= 1.0001; r += 0.02) {
      const f = frameFor(r);
      if (
        f.cover < prev.cover - 1e-12 ||
        f.slider < prev.slider - 1e-12 ||
        f.sheet < prev.sheet - 1e-12 ||
        f.impact < prev.impact - 1e-12 ||
        f.slideSpeedMul < prev.slideSpeedMul - 1e-12 ||
        f.dim > prev.dim + 1e-12
      )
        monotone = false;
      prev = f;
    }
    t.ok('rain: every regime term only grows with the rain', monotone);
    t.ok(
      'rain: drizzle has beads but almost no sliders and no sheet',
      frameFor(0.1).cover > 0 && frameFor(0.1).slider < 0.1 && frameFor(0.1).sheet === 0
    );
    t.ok('rain: ordinary rain has sliders but no sheet', frameFor(0.5).slider > 0.2 && frameFor(0.5).sheet === 0);
    t.ok('rain: a storm has the sheet', frameFor(1).sheet > 0.5);
    t.ok('rain: the sheet waits for heavy rain', frameFor(0.5).sheet === 0);
    t.ok('rain: wet glass is dimmed a little, not a lot', frameFor(1).dim > 0.85 && frameFor(1).dim < 1);
    t.ok('rain: bead lifetime shortens in heavy rain', frameFor(1).live < frameFor(0.1).live);

    const linger = resolveRainFrame({ rain01: 0, wet01: 0.5, look });
    t.ok('rain: the rain has stopped but beads linger (presence stays on)', linger.presence === 1 && linger.cover > 0);
    t.ok(
      'rain: lingering water has no impacts, no sliders worth the name and no sheet',
      linger.impact === 0 && linger.sheet === 0 && linger.slider < frameFor(0.5).slider
    );

    const twice = resolveRainFrame({ rain01: 0.5, wet01: 0.5, look: { ...look, splatDensity: 2 } });
    t.ok(
      'rain: splat density scales how many drops there are',
      twice.cover > frameFor(0.5, {}).cover || twice.cover === 1
    );
    const off = resolveRainFrame({ rain01: 1, wet01: 1, look: { ...look, sliders: 0, sheeting: 0, splatDensity: 0 } });
    t.ok(
      'rain: zeroing the dials zeroes the water',
      off.cover === 0 && off.slider === 0 && off.sheet === 0 && off.presence === 0
    );
    t.ok(
      'rain: wind bias is wind speed times the author dial',
      Math.abs(
        resolveRainFrame({ rain01: 0.5, wet01: 0.5, look, windSpeed01: 0.5 }).windBias - 0.5 * look.windwardBias
      ) < 1e-12
    );
    t.ok(
      'rain: out of range inputs are clamped, not propagated',
      resolveRainFrame({ rain01: 5, wet01: -3, look }).cover <= 1
    );
  }

  // ── 4. A dry pane is exactly identity ────────────────────────────────────
  {
    const dry = resolveRainFrame({ rain01: 0, wet01: 0, look });
    let exact = true;
    for (let i = 0; i < 500; i++) {
      const r = evalWindowRainPixel({
        x: i * 13.7,
        y: i * 5.3,
        frame: dry,
        look,
        clock: i * 0.37,
        slideClock: i * 0.11,
        flow: flowSouth,
      });
      if (r.offsetX !== 0 || r.offsetY !== 0 || r.gain !== 1) exact = false;
    }
    t.ok('rain: dry means offset 0 and gain 1, bit for bit', exact);
  }

  // ── 5. More rain, more water ─────────────────────────────────────────────
  {
    // Beads and sliders only: the storm sheet and the global wet dim are broad on purpose and are tested on their own.
    const coverage = (rain01) => {
      const frame = {
        ...resolveRainFrame({ rain01, wet01: Math.min(1, rain01 * 1.6), look: moderateLook }),
        windFlowX: 0,
        windFlowY: 1,
        sheet: 0,
        dim: 1,
      };
      let n = 0;
      let total = 0;
      for (let j = 0; j < 80; j++) {
        for (let i = 0; i < 80; i++) {
          const r = evalWindowRainPixel({
            x: 2000 + i * 2.5,
            y: 3000 + j * 2.5,
            frame,
            look: moderateLook,
            clock: 41.3,
            slideClock: 20,
            flow: flowSouth,
          });
          total++;
          if (Math.abs(r.gain - 1) > 0.03 || Math.hypot(r.offsetX, r.offsetY) > 0.4) n++;
        }
      }
      return n / total;
    };
    const c = [0, 0.1, 0.3, 0.6, 1].map(coverage);
    t.ok('rain: no rain covers nothing', c[0] === 0);
    t.ok(
      'rain: coverage grows from drizzle to storm (' + c.map((v) => v.toFixed(3)).join(' < ') + ')',
      c[1] > 0 && c[1] < c[2] && c[2] < c[3] && c[3] < c[4]
    );
    t.ok('rain: even a storm leaves most of the glass clear', c[4] < 0.85);
  }

  // ── 6. The output is always safe to hand to the GPU ──────────────────────
  {
    let finite = true;
    let bounded = true;
    for (const rain of [0.05, 0.5, 1]) {
      const frame = frameFor(rain, { gust: 1 });
      for (let i = 0; i < 600; i++) {
        const flow =
          i % 3 === 0 ? { ...flowSouth, px: 1, py: 0, mix: (i % 10) / 10 } : i % 3 === 1 ? NO_FLOW : flowSouth;
        const r = evalWindowRainPixel({
          x: ((i * 97) % 9000) - 500,
          y: (i * 61) % 7000,
          frame,
          look: { ...look, refraction: 2, caustic: 2 },
          clock: i * 3.1,
          slideClock: i * 1.7,
          flow,
        });
        if (![r.offsetX, r.offsetY, r.gain].every(Number.isFinite)) finite = false;
        if (Math.hypot(r.offsetX, r.offsetY) > RAIN_TUNE.maxOffsetPx + 1e-9 || r.gain < 0 || r.gain > RAIN_TUNE.maxGain)
          bounded = false;
      }
    }
    t.ok('rain: every output is finite', finite);
    t.ok(
      'rain: offsets are capped at ' + RAIN_TUNE.maxOffsetPx + ' px and gain stays in [0, ' + RAIN_TUNE.maxGain + ']',
      bounded
    );
    const a = evalWindowRainPixel({
      x: 123.4,
      y: 567.8,
      frame: frameFor(0.7),
      look,
      clock: 9.9,
      slideClock: 4.4,
      flow: flowSouth,
    });
    const b = evalWindowRainPixel({
      x: 123.4,
      y: 567.8,
      frame: frameFor(0.7),
      look,
      clock: 9.9,
      slideClock: 4.4,
      flow: flowSouth,
    });
    t.ok(
      'rain: the same pixel at the same time is the same answer',
      a.gain === b.gain && a.offsetX === b.offsetX && a.offsetY === b.offsetY
    );
  }

  // ── 7. A splat is a lens with a bright focus and a dark rim ──────────────
  {
    // Find a live bead by scanning cells, then check its optics.
    const frame = { ...frameFor(0.6), impact: 0 }; // no crown, just the bead
    const cell = look.dropScalePx * RAIN_TUNE.octScale[1] * RAIN_TUNE.cellMul;
    let best = null;
    for (let cy = 0; cy < 30 && !best; cy++) {
      for (let cx = 0; cx < 30 && !best; cx++) {
        const s = evalSplatLayer({
          x: (cx + 0.5) * cell,
          y: (cy + 0.5) * cell,
          octave: 1,
          clock: 5.5,
          frame,
          look,
          ddx: 0,
          ddy: 0,
          paneH: 0.5,
          exposure: 1,
        });
        if (Math.abs(s.gain - 1) > 0.05) best = { cx, cy };
      }
    }
    t.ok('rain: a live bead exists at moderate rain', best !== null);
    let gmin = 1;
    let gmax = 1;
    let pull = 0;
    const base = {
      clock: 5.5,
      frame,
      look,
      octave: 1,
      ddx: 0,
      ddy: 0,
      paneH: 0.5,
      exposure: 1,
    };
    for (let j = 0; j < 40; j++) {
      for (let i = 0; i < 40; i++) {
        const x = (best.cx + i / 40) * cell;
        const y = (best.cy + j / 40) * cell;
        const s = evalSplatLayer({ x, y, ...base });
        gmin = Math.min(gmin, s.gain);
        gmax = Math.max(gmax, s.gain);
        pull = Math.max(pull, Math.hypot(s.ox, s.oy));
      }
    }
    t.ok('rain: a bead focuses light (bright spot, gain ' + gmax.toFixed(2) + ')', gmax > 1.15);
    t.ok('rain: a bead darkens its own rim (gain ' + gmin.toFixed(2) + ')', gmin < 0.97);
    t.ok('rain: a bead bends the light (offset ' + pull.toFixed(1) + ' px)', pull > 0.5);
    // Turning the dials to zero removes exactly that.
    const flat = { ...look, refraction: 0, caustic: 0, rimDarken: 0 };
    let worst = 0;
    for (let j = 0; j < 20; j++) {
      for (let i = 0; i < 20; i++) {
        const s = evalSplatLayer({
          x: (best.cx + i / 20) * cell,
          y: (best.cy + j / 20) * cell,
          ...base,
          look: flat,
        });
        worst = Math.max(worst, Math.abs(s.gain - 1), Math.hypot(s.ox, s.oy));
      }
    }
    t.ok('rain: refraction, caustic and rim at 0 leave a bead invisible', worst < 1e-9);
  }

  // ── 8. Sliders only ever move toward the sill, and they stick and slip ──
  {
    const cases = [
      ['south', 0, 1],
      ['east', 1, 0],
      ['diagonal', 0.6, 0.8],
    ];
    for (const [name, dX, dY] of cases) {
      const frame = { ...frameFor(0.6), slider: 1, sheet: 0, cover: 0 };
      // the real slide clock advances at the storm pace, so step it the way the subsystem does
      const rate = frame.slideSpeedMul;
      const nX = -dY;
      const nY = dX;
      const colW = look.dropScalePx * RAIN_TUNE.colWidthMul;
      const Lmax = colW * RAIN_TUNE.colPeriodMul * 1.3;
      // The best gain at along-coordinate v across column `col`. A head meanders a few px either side of the
      // column's centre line, so one line would lose a small head; sample across the column instead.
      const gainAt = (col, v, slideClock) => {
        let best = -Infinity;
        for (const du of [-2, -1, 0, 1, 2]) {
          const u0 = (col + 0.5) * colW + du;
          const r = evalFacetFrame({
            x: u0 * nX + v * dX,
            y: u0 * nY + v * dY,
            dx: dX,
            dy: dY,
            clock: 0,
            slideClock,
            frame,
            look,
            paneH: 0.5,
            exposure: 1,
            kappa: 1,
          });
          if (r.gain > best) best = r.gain;
        }
        return best;
      };
      // A head is tracked by its bright focus: the single positive peak (the rim and trail only dim), searched
      // locally around where it was a moment ago. The pattern is periodic and unbounded, so it never wraps.
      const findHead = (col, slideClock, lo, hi) => {
        let bv = lo;
        let bg = -Infinity;
        for (let v = lo; v <= hi; v += 1) {
          const g = gainAt(col, v, slideClock);
          if (g > bg) {
            bg = g;
            bv = v;
          }
        }
        return { v: bv, g: bg };
      };
      let col = -1;
      let start = null;
      for (let c = 0; c < 60 && col < 0; c++) {
        const h = findHead(c, 3 * rate, 0, Lmax);
        if (h.g > 1.25) {
          col = c;
          start = h;
        }
      }
      t.ok('rain: ' + name + ' frame has an active slider column', col >= 0);
      if (col < 0) continue;

      const steps = 160;
      const dt = 0.02;
      let backward = false;
      let lost = 0;
      let moved = 0;
      let stuck = 0;
      let slipped = 0;
      let prev = start.v;
      for (let s = 1; s <= steps; s++) {
        const cur = findHead(col, (3 + s * dt) * rate, prev - 15, prev + 40);
        if (cur.g < 1.2) {
          lost++;
          continue;
        }
        const delta = cur.v - prev;
        if (delta < -1) backward = true;
        if (delta > 0) moved += delta;
        if (Math.abs(delta) < 0.5) stuck++;
        if (delta > 2) slipped++;
        prev = cur.v;
      }
      t.ok('rain: ' + name + ' sliders never run back up the pane', !backward);
      t.ok('rain: ' + name + ' sliders can be followed the whole way (' + lost + ' steps lost)', lost === 0);
      t.ok('rain: ' + name + ' sliders do travel (' + moved.toFixed(0) + ' px in ' + steps * dt + ' s)', moved > 40);
      t.ok('rain: ' + name + ' sliders stick (' + stuck + ' of ' + steps + ' steps barely move)', stuck > steps * 0.1);
      t.ok(
        'rain: ' + name + ' sliders slip (' + slipped + ' of ' + steps + ' steps move fast)',
        slipped > steps * 0.05
      );
    }
  }

  // ── 9. Across a facet blend nothing jumps ───────────────────────────────
  {
    const frame = frameFor(0.8);
    const A = { px: 1, py: 0, qx: 0, qy: 1, kappa: 1, h: 0.5, gate: 1 };
    let worstStep = 0;
    for (const [x, y] of [
      [1234.5, 987.5],
      [2210, 1800],
      [5, 7777],
      [3333.3, 444.4],
    ]) {
      let prev = evalWindowRainPixel({ x, y, frame, look, clock: 17.2, slideClock: 9.1, flow: { ...A, mix: 0 } });
      for (let k = 1; k <= 100; k++) {
        const cur = evalWindowRainPixel({
          x,
          y,
          frame,
          look,
          clock: 17.2,
          slideClock: 9.1,
          flow: { ...A, mix: k / 100 },
        });
        worstStep = Math.max(
          worstStep,
          Math.abs(cur.gain - prev.gain),
          Math.hypot(cur.offsetX - prev.offsetX, cur.offsetY - prev.offsetY) / 10
        );
        prev = cur;
      }
    }
    t.ok(
      'rain: the output moves smoothly as the facet weight sweeps 0 to 1 (worst step ' + worstStep.toFixed(3) + ')',
      worstStep < 0.06
    );

    // And the two ends really are different frames, so the blend is doing something.
    let differ = 0;
    for (let i = 0; i < 300; i++) {
      const x = 900 + i * 7.3;
      const y = 1500 + i * 3.1;
      const a = evalWindowRainPixel({ x, y, frame, look, clock: 17.2, slideClock: 9.1, flow: { ...A, mix: 0 } });
      const b = evalWindowRainPixel({ x, y, frame, look, clock: 17.2, slideClock: 9.1, flow: { ...A, mix: 1 } });
      if (Math.abs(a.gain - b.gain) > 0.02) differ++;
    }
    t.ok('rain: facet A and facet B give different water (' + differ + ' of 300 pixels differ)', differ > 5);
  }

  // ── 10. Wind: windward panes are wetter than leeward ones ───────────────
  {
    // Wind blowing toward +y (south). A south-facing pane (outward = +y) is LEEWARD; a north-facing one is WINDWARD.
    const lee = windExposure(0, 1, 0, 1, 1, 1);
    const windward = windExposure(0, -1, 0, 1, 1, 1);
    const side = windExposure(1, 0, 0, 1, 1, 1);
    t.ok('rain: a windward pane is exposed (' + windward.toFixed(2) + ')', windward > 1.3);
    t.ok('rain: a leeward pane is nearly dry (' + lee.toFixed(2) + ')', lee < 0.2);
    t.ok('rain: a side-on pane is in between', side > lee && side < windward);
    t.ok(
      'rain: no wind means every pane is equally exposed',
      windExposure(0, -1, 0, 1, 0, 1) === 1 && windExposure(0, 1, 0, 1, 0, 1) === 1
    );
    t.ok('rain: a pane with no honest direction ignores the wind', windExposure(0, -1, 0, 1, 1, 0) === 1);
    t.ok('rain: exposure is bounded', windward <= RAIN_TUNE.windWind + 1e-9 && lee >= RAIN_TUNE.windLee - 1e-9);

    const wetCount = (dirY) => {
      const frame = { ...frameFor(0.4), windBias: 1, windFlowX: 0, windFlowY: 1 };
      const flow = { px: 0, py: dirY, qx: 0, qy: dirY, mix: 0, kappa: 1, h: 0.5, gate: 1 };
      let n = 0;
      for (let j = 0; j < 60; j++)
        for (let i = 0; i < 60; i++) {
          const r = evalWindowRainPixel({
            x: 800 + i * 4,
            y: 800 + j * 4,
            frame,
            look,
            clock: 12.5,
            slideClock: 6,
            flow,
          });
          if (Math.abs(r.gain / frame.dim - 1) > 0.03) n++;
        }
      return n;
    };
    const wWindward = wetCount(-1);
    const wLeeward = wetCount(1);
    t.ok(
      'rain: through the whole shader a windward pane shows more water (' + wWindward + ' vs ' + wLeeward + ')',
      wWindward > wLeeward * 1.5
    );
  }

  // ── 11. The storm sheet ─────────────────────────────────────────────────
  {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const f = filmField(i * 0.37, i * 0.21);
      lo = Math.min(lo, f);
      hi = Math.max(hi, f);
    }
    t.ok('rain: the film field stays in [0, 1]', lo >= 0 && hi <= 1);
    const frame = { ...frameFor(1), cover: 0, slider: 0, sheet: 1, gust: 0 };
    let dimMax = 0;
    let dimMin = 1;
    for (let i = 0; i < 400; i++) {
      const r = evalFacetFrame({
        x: i * 23,
        y: i * 17,
        dx: 0,
        dy: 1,
        clock: 3,
        slideClock: 8,
        frame,
        look,
        paneH: 0.5,
        exposure: 1,
        kappa: 0,
      });
      dimMax = Math.max(dimMax, 1 - r.gain);
      dimMin = Math.min(dimMin, 1 - r.gain);
    }
    t.ok(
      'rain: the sheet dims by up to ~' +
        (RAIN_TUNE.sheetDim * 100).toFixed(0) +
        '% (' +
        (dimMax * 100).toFixed(1) +
        '%)',
      dimMax > 0.08 && dimMax <= RAIN_TUNE.sheetDim + 1e-9
    );
    t.ok('rain: the sheet never brightens', dimMin >= -1e-12);
    const gusty = evalFacetFrame({
      x: 1000,
      y: 700,
      dx: 0,
      dy: 1,
      clock: 3,
      slideClock: 8,
      frame: { ...frame, gust: 1 },
      look,
      paneH: 0.5,
      exposure: 1,
      kappa: 0,
    });
    t.ok(
      'rain: gusts keep the sheet finite and bounded',
      Number.isFinite(gusty.gain) && gusty.gain > 0.7 && gusty.gain <= 1
    );
  }

  // ── 12. The TSL graph ───────────────────────────────────────────────────
  {
    const tex = () =>
      new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    const rain = createWindowRain({
      THREE,
      flowDirsTexture: tex(),
      flowAuxTexture: tex(),
      viewSpanNode: THREE.TSL.float(2000),
    });
    const n = rain.build();
    t.ok(
      'rain-tsl: build returns offset, gain and the three views',
      ['offsetPx', 'gain', 'debugFlow', 'debugAux', 'debugDrops'].every((k) => n[k])
    );
    t.ok('rain-tsl: build can be called again (the glass cookie is built twice)', rain.build().gain !== undefined);
    const noView = createWindowRain({ THREE, flowDirsTexture: tex(), flowAuxTexture: tex() });
    t.ok('rain-tsl: the view span is optional', noView.build().gain !== undefined);
    const mat = new THREE.NodeMaterial();
    mat.colorNode = THREE.TSL.vec4(n.gain, n.offsetPx.x, n.offsetPx.y, 1);
    t.ok('rain-tsl: the graph attaches to a material', mat.colorNode !== null);

    // The setters reach the uniforms.
    const frame = resolveRainFrame({ rain01: 0.7, wet01: 0.9, look, windSpeed01: 0.5, gust01: 0.3 });
    rain.setFrame(frame, { clock: 12.5, slideClock: 7.25, windFlow: [1, 0] });
    rain.setLook({
      dropScalePx: 60,
      refraction: 1.5,
      caustic: 0.3,
      rimDarken: 0.2,
      trail: 0.9,
      projectionStretch: 0.1,
    });
    const s = rain.snapshot();
    t.ok(
      'rain-tsl: setFrame pushes the weather',
      s.presence === 1 &&
        s.cover === frame.cover &&
        s.slider === frame.slider &&
        s.sheet === frame.sheet &&
        s.dim === frame.dim &&
        s.clock === 12.5 &&
        s.slideClock === 7.25
    );
    t.ok(
      'rain-tsl: setFrame pushes the wind',
      s.windFlow[0] === 1 && s.windFlow[1] === 0 && s.windBias === frame.windBias
    );
    t.ok(
      'rain-tsl: setLook pushes the dials',
      s.scale === 60 && s.refract === 1.5 && s.caustic === 0.3 && s.rim === 0.2 && s.trail === 0.9 && s.stretch === 0.1
    );
    rain.setLook({ dropScalePx: NaN, refraction: -5, rimDarken: 9 });
    const s2 = rain.snapshot();
    t.ok(
      'rain-tsl: setLook rejects NaN and clamps nonsense',
      s2.scale === WINDOW_RAIN_DEFAULTS.dropScalePx && s2.refract === 0 && s2.rim === 1
    );
    rain.setFrame({ presence: 0, cover: NaN, live: NaN, dim: NaN }, { clock: NaN, slideClock: NaN });
    const s3 = rain.snapshot();
    t.ok(
      'rain-tsl: setFrame rejects NaN and falls back to a dry pane',
      s3.presence === 0 && s3.cover === 0 && s3.dim === 1 && s3.clock === 0 && s3.live > 0
    );

    // The flow rect.
    rain.setFlow({ dirsTexture: tex(), auxTexture: tex(), rect: { x: 100, y: 200, width: 1000, height: 500 } });
    const fr = rain.snapshot().flowRect;
    t.ok(
      'rain-tsl: setFlow stores the rect as origin and 1/size',
      fr[0] === 100 && fr[1] === 200 && Math.abs(fr[2] - 0.001) < 1e-12 && Math.abs(fr[3] - 0.002) < 1e-12
    );
    rain.setFlow({ dirsTexture: tex(), auxTexture: tex(), rect: null });
    t.ok(
      'rain-tsl: no rect means no flow (all zero)',
      rain.snapshot().flowRect.every((v) => v === 0)
    );
  }

  // ── 11. A furious storm: fast gravity, near-uniform drops, noise-broken, carried by the wind ─────────
  {
    const T = RAIN_TUNE;
    let lo = 1;
    let hi = 0;
    let smooth = true;
    let prev = vnoise(0.3, 0.7, 5);
    for (let i = 1; i < 400; i++) {
      const v = vnoise(0.3 + i * 0.01, 0.7 + i * 0.013, 5);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      if (Math.abs(v - prev) > 0.08) smooth = false;
      prev = v;
    }
    t.ok(
      'rain: the break-up noise stays in [0, 1) (' + lo.toFixed(2) + '..' + hi.toFixed(2) + ')',
      lo >= 0 && hi < 1 && hi - lo > 0.3
    );
    t.ok('rain: the break-up noise is smooth between lattice corners', smooth);
    t.ok('rain: the noise is deterministic', vnoise(-3.4, 9.1, 7) === vnoise(-3.4, 9.1, 7));
    t.ok(
      'rain: all four drop lattices are within 1.6x of each other in size (near-uniform)',
      Math.max(...T.octScale) / Math.min(...T.octScale) < 1.6 && Math.exp(T.radiusLog) < 1.7
    );
    const storm = resolveRainFrame({ rain01: 1, wet01: 1, look: moderateLook });
    const old = 1.5;
    t.ok(
      'rain: a storm runs at least 10x the old gravity (' + storm.slideSpeedMul.toFixed(1) + ' vs ' + old + ')',
      storm.slideSpeedMul >= 10 * old
    );
    t.ok(
      'rain: a storm covers the glass and its drops barely stick',
      storm.cover > 0.99 && storm.stick < 0.2 && storm.slider > 0.3
    );

    // the wind carries the running water: shifting the lattice by the drift moves the picture by exactly that
    const sl = { ...frameFor(0.8), cover: 0, sheet: 0, dim: 1, slider: 1 };
    let same = true;
    let moved = false;
    for (let i = 0; i < 200; i++) {
      const x = 500 + i * 3.7;
      const y = 800 + ((i * 17) % 90);
      const a = evalWindowRainPixel({ x, y, frame: sl, look, clock: 4, slideClock: 9, flow: flowSouth });
      const b = evalWindowRainPixel({
        x: x + 60,
        y: y - 25,
        frame: sl,
        look,
        clock: 4,
        slideClock: 9,
        flow: flowSouth,
        windShiftX: 60,
        windShiftY: -25,
      });
      if (Math.abs(a.gain - b.gain) > 1e-9 || Math.abs(a.offsetX - b.offsetX) > 1e-9) same = false;
      if (Math.abs(a.gain - 1) > 0.02) moved = true;
    }
    t.ok('rain: a wind shift translates the running water exactly', same && moved);
    // and the beads smear with the wind as well as gravity
    const calm = { ...frameFor(0.8), windPush: 0, windFlowX: 1, windFlowY: 0 };
    const blown = { ...calm, windPush: 1 };
    let differ = 0;
    for (let i = 0; i < 400; i++) {
      const x = 2000 + i * 2.3;
      const y = 3000 + ((i * 7) % 40);
      const a = evalWindowRainPixel({ x, y, frame: calm, look, clock: 7, slideClock: 3, flow: flowSouth });
      const b = evalWindowRainPixel({ x, y, frame: blown, look, clock: 7, slideClock: 3, flow: flowSouth });
      if (Math.abs(a.gain - b.gain) > 0.02) differ++;
    }
    t.ok('rain: wind smears the beads (' + differ + ' of 400 pixels change)', differ > 5);
  }

  // ── 2026-10-19: far more running drops, fewer stationary ones, strongest at full wind ─────────────────────────
  {
    // The OLD model, for the before/after numbers: 6-wide columns, 12 periods, coverage clamp01(1.4 s) at no boost.
    const OLD = { colWidthMul: 6, colPeriodMul: 12, beadsNoWind: true };
    const T = RAIN_TUNE;
    // running heads per unit glass area for a frame (coverage of columns / (column width x head spacing))
    const heads = (slider, colWidthMul, colPeriodMul) => {
      const colW = look.dropScalePx * colWidthMul;
      return slider / (colW * colW * colPeriodMul * 1.05);
    };
    const nowHeads = (fr) => heads(fr.slider, T.colWidthMul, T.colPeriodMul);
    const oldSlider = (rain) =>
      clamp01Test(look.sliders * 1.4 * smoothstepTest(0.08, 0.7, Math.max(rain, 0.6 * Math.min(1, rain * 1.6))));
    const oldHeads = (rain) => heads(oldSlider(rain), OLD.colWidthMul, OLD.colPeriodMul);
    const at = (rain, wind) =>
      resolveRainFrame({ rain01: rain, wet01: Math.min(1, rain * 1.6), look, windSpeed01: wind });

    const gale = nowHeads(at(1, 1)) / oldHeads(1);
    t.ok(
      'rain: at full wind there are ~4x as many running drops as before (' + gale.toFixed(2) + 'x)',
      gale > 3.8 && gale < 4.2
    );
    const calm = nowHeads(at(1, 0)) / oldHeads(1);
    t.ok('rain: with no wind the boost is the smaller 1.5x (' + calm.toFixed(2) + 'x)', calm > 1.4 && calm < 1.6);
    let mono = true;
    for (let w = 0.1; w <= 1.0001; w += 0.1)
      if (nowHeads(at(0.6, w)) < nowHeads(at(0.6, w - 0.1)) - 1e-12) mono = false;
    t.ok('rain: the running share only rises with wind', mono);
    t.ok('rain: the running coverage stays within the grid at full wind', at(1, 1).slider <= 1);
    const beadsCalm = at(1, 0).cover;
    const beadsGale = at(1, 1).cover;
    t.ok(
      'rain: stationary bead coverage falls with wind (' + beadsCalm.toFixed(2) + ' -> ' + beadsGale.toFixed(2) + ')',
      beadsGale < beadsCalm && beadsGale > 0.3 * beadsCalm
    );
    const share = (fr) => nowHeads(fr) / (nowHeads(fr) + fr.cover);
    t.ok(
      'rain: running drops are a larger share of all drops at full wind than in calm',
      share(at(1, 1)) > share(at(1, 0))
    );
    const off = resolveRainFrame({ rain01: 1, wet01: 1, look: { ...look, sliders: 0 }, windSpeed01: 1 });
    t.ok('rain: sliders = 0 still means no running drops', off.slider === 0);
    // the grid constants the CPU twin and the TSL graph both read: one table, so they cannot drift apart
    t.ok(
      'rain: the run grid constant matches the geometry (4x the old heads)',
      Math.abs((6 * 6 * 12) / (T.colWidthMul * T.colWidthMul * T.colPeriodMul) - T.runGrid) < 0.05
    );
  }

  // ── "Rain only in the brightest N% of the mask" (rainMaskFloorPct) ─────────
  {
    t.ok('rain-mask: the shipped default is 100 (off)', WINDOW_RAIN_DEFAULTS.maskFloorPct === 100);
    // at the default the fade is exactly 1 for every mask value, and evalWindowRainPixel is bit-identical to before
    let allOne = true;
    for (let i = 0; i <= 100; i++) if (rainMaskFade({ maskValue: i / 100, peak: 1, pct: 100 }) !== 1) allOne = false;
    t.ok('rain-mask: at 100 the weight is exactly 1 everywhere', allOne);
    const frame = frameFor(0.8);
    let identical = true;
    for (let i = 0; i < 300; i++) {
      const x = 1500 + i * 3.1;
      const y = 2500 + ((i * 11) % 90);
      const a = evalWindowRainPixel({ x, y, frame, look, clock: 5, slideClock: 2, flow: flowSouth });
      const b = evalWindowRainPixel({
        x,
        y,
        frame,
        look,
        clock: 5,
        slideClock: 2,
        flow: flowSouth,
        maskValue: 0,
        maskPeak: 1,
      });
      if (a.offsetX !== b.offsetX || a.offsetY !== b.offsetY || a.gain !== b.gain) identical = false;
    }
    t.ok('rain-mask: at 100 the picture is bit-identical to before, even over a black mask', identical);

    // at a low value: zero in dark areas, unchanged in the brightest area
    const low = { ...look, maskFloorPct: 30 };
    let darkZero = true;
    let brightSame = true;
    let rainSeen = 0;
    for (let i = 0; i < 300; i++) {
      const x = 1500 + i * 3.1;
      const y = 2500 + ((i * 11) % 90);
      const base = evalWindowRainPixel({ x, y, frame, look, clock: 5, slideClock: 2, flow: flowSouth });
      const dark = evalWindowRainPixel({
        x,
        y,
        frame,
        look: low,
        clock: 5,
        slideClock: 2,
        flow: flowSouth,
        maskValue: 0.2,
        maskPeak: 1,
      });
      const peak = evalWindowRainPixel({
        x,
        y,
        frame,
        look: low,
        clock: 5,
        slideClock: 2,
        flow: flowSouth,
        maskValue: 1,
        maskPeak: 1,
      });
      if (dark.offsetX !== 0 || dark.offsetY !== 0 || dark.gain !== 1) darkZero = false;
      if (peak.offsetX !== base.offsetX || peak.offsetY !== base.offsetY || peak.gain !== base.gain) brightSame = false;
      if (base.gain !== 1) rainSeen++;
    }
    t.ok('rain-mask: with rain actually present in the sample (' + rainSeen + ')', rainSeen > 20);
    t.ok('rain-mask: at 30 the dark mask (20% of peak) has no rain at all', darkZero);
    t.ok('rain-mask: at 30 the brightest mask is exactly the unfaded rain', brightSame);

    // monotonic in mask brightness and smooth (no step), for several dial values
    let mono = true;
    let maxStep = 0;
    for (const pct of [0, 10, 30, 50, 80, 95, 99]) {
      let prev = -1;
      for (let i = 0; i <= 1000; i++) {
        const w = rainMaskFade({ maskValue: i / 1000, peak: 1, pct });
        if (w < prev - 1e-12) mono = false;
        if (prev >= 0) maxStep = Math.max(maxStep, Math.abs(w - prev));
        prev = w;
      }
    }
    t.ok('rain-mask: the weight never decreases as the mask gets brighter', mono);
    // the steepest smoothstep over SOFT is 1.5/SOFT per unit; a step of 1/1000 may move 1.5/(SOFT*1000)
    t.ok(
      'rain-mask: no step (largest jump ' + maxStep.toFixed(4) + ')',
      maxStep <= 1.5 / (RAIN_MASK_FADE_SOFT * 1000) + 1e-9
    );
    // continuous in the dial too: 100 -> 99 changes the weight only a little
    const w99 = rainMaskFade({ maskValue: 0, peak: 1, pct: 99 });
    t.ok('rain-mask: dialling 100 -> 99 is continuous (' + w99.toFixed(3) + ')', w99 > 0.95 && w99 < 1);
    // relative to the mask's own peak: the same picture at half the brightness behaves the same
    const a = rainMaskFade({ maskValue: 0.3, peak: 0.6, pct: 40 });
    const b = rainMaskFade({ maskValue: 0.5, peak: 1, pct: 40 });
    t.ok('rain-mask: relative to the mask peak, not absolute brightness', Math.abs(a - b) < 1e-12);
    t.ok(
      'rain-mask: 0 leaves drops only at the very peak',
      rainMaskFade({ maskValue: 0.5, peak: 1, pct: 0 }) === 0 && rainMaskFade({ maskValue: 1, peak: 1, pct: 0 }) === 1
    );

    // CPU and GPU agree: the shader's uniform is the twin's threshold, and the graph builds with the mask tap
    const rain = createWindowRain({
      THREE,
      flowDirsTexture: new THREE.DataTexture(new Uint8Array(4), 1, 1),
      flowAuxTexture: new THREE.DataTexture(new Uint8Array(4), 1, 1),
    });
    let agree = true;
    for (const pct of [0, 25, 60, 100]) {
      rain.setLook({ ...look, maskFloorPct: pct });
      if (Math.abs(rain.snapshot().maskT - (1 - pct / 100)) > 1e-6) agree = false;
    }
    t.ok('rain-mask: the shader threshold uniform is 1 - pct/100, the twin t', agree);
    rain.setMaskPeak(0.8);
    t.ok('rain-mask: setMaskPeak reaches the shader uniform', Math.abs(rain.snapshot().maskPeak - 0.8) < 1e-6);
    let built = true;
    try {
      const nodes = rain.build({ maskGated: () => THREE.TSL.float(0.5) });
      built = !!nodes.offsetPx && !!nodes.gain;
    } catch (e) {
      built = false;
    }
    t.ok('rain-mask: the TSL graph constructs with the mask tap', built);
  }

  // ── 13. Wind and gravity share the drop direction ───────────────────────
  {
    // up to half wind: gravity alone, exactly as before
    let calmOk = true;
    for (const w of [0, 0.1, 0.25, 0.5]) {
      const m = directionMix(w);
      if (m.gravity !== 1 || m.wind !== 0) calmOk = false;
    }
    t.ok('mix: wind 0, 0.25 and 0.5 are gravity alone (weights exactly 1 and 0)', calmOk);
    const full = directionMix(1);
    t.ok('mix: full wind is wind alone (gravity 0, wind 1)', full.gravity === 0 && full.wind === 1);
    const mid = directionMix(0.75);
    t.ok(
      'mix: wind 0.75 is a true mix (' + mid.gravity.toFixed(3) + ' / ' + mid.wind.toFixed(3) + ')',
      mid.gravity > 0 && mid.gravity < 1 && mid.wind > 0 && mid.wind < 1 && Math.abs(mid.gravity + mid.wind - 1) < 1e-12
    );
    let mono = true;
    let smooth = true;
    let prev = directionMix(0);
    for (let i = 1; i <= 1000; i++) {
      const m = directionMix(i / 1000);
      if (m.wind < prev.wind || m.gravity > prev.gravity) mono = false;
      if (Math.abs(m.wind - prev.wind) > 0.0031) smooth = false; // smoothstep slope is at most 3 per unit wind
      prev = m;
    }
    t.ok('mix: the weights change monotonically', mono);
    t.ok('mix: no jump anywhere (slope bounded, flat at both ends)', smooth && directionMix(0.5001).wind < 1e-6);
    t.ok('mix: out-of-range wind clamps', directionMix(-3).gravity === 1 && directionMix(9).wind === 1);

    // the frame carries it, and the running water's gravity speed follows
    const at = (w) => resolveRainFrame({ rain01: 0.8, wet01: 1, look, windSpeed01: w });
    const base = 10 * (0.55 + (1.5 - 0.55) * 0.8) * look.slideSpeed;
    t.ok(
      'mix: slide speed is untouched up to half wind and gone at full wind',
      at(0).gravityMix === 1 &&
        at(0.5).gravityMix === 1 &&
        Math.abs(at(0.5).slideSpeedMul - base) < 1e-9 &&
        at(1).gravityMix === 0 &&
        at(1).slideSpeedMul === 0
    );

    // the bead smear: identical to the old frame (no gravityMix key) at wind <= 0.5; pure wind at 1
    const evalAt = (frame, i) =>
      evalWindowRainPixel({
        x: 2000 + i * 2.3,
        y: 3000 + ((i * 7) % 40),
        frame,
        look,
        clock: 7,
        slideClock: 3,
        flow: flowSouth,
      });
    const sweep = (fa, fb) => {
      let worst = 0;
      for (let i = 0; i < 300; i++) {
        const a = evalAt(fa, i);
        const b = evalAt(fb, i);
        worst = Math.max(
          worst,
          Math.abs(a.gain - b.gain),
          Math.abs(a.offsetX - b.offsetX),
          Math.abs(a.offsetY - b.offsetY)
        );
      }
      return worst;
    };
    const wf = { windFlowX: 1, windFlowY: 0 };
    let sameLow = true;
    for (const w of [0, 0.25, 0.5]) {
      const now = { ...at(w), ...wf };
      const old = { ...now };
      delete old.gravityMix;
      if (sweep(now, old) !== 0) sameLow = false;
    }
    t.ok('mix: wind <= 0.5 gives the identical picture to before', sameLow);
    const f1 = { ...at(1), ...wf };
    t.ok('mix: at full wind the gravity push is already nothing', sweep(f1, { ...f1, gravityMix: 0 }) === 0);
    t.ok(
      'mix: a mid wind smears differently from gravity-only at the same push',
      sweep({ ...at(0.75), ...wf }, { ...at(0.75), ...wf, gravityMix: 1 }) > 0
    );

    // the shader reads the same number the twin does
    const tex = () =>
      new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    const gpu = createWindowRain({ THREE, flowDirsTexture: tex(), flowAuxTexture: tex() });
    gpu.build();
    let agree = true;
    for (const w of [0, 0.3, 0.5, 0.6, 0.75, 0.9, 1]) {
      gpu.setFrame(at(w), { clock: 1, slideClock: 1, windFlow: [1, 0] });
      if (gpu.snapshot().gravityMix !== directionMix(w).gravity) agree = false;
    }
    t.ok('mix: the shader uniform carries directionMix at every wind', agree);
  }
}
