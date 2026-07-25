/**
 * SUN OCCLUSION — the march's maths, asserted rather than admired
 * (docs/planning/Sun-Shadows.md).
 *
 * What this file is FOR: the shader in `sun-occlusion-render.js` is a
 * transcription of `marchVisibility`, and a shader cannot be Node-tested. So
 * everything the two share — the direction the ray walks, how far it reaches,
 * how the penumbra widens, when a rebake fires — is pinned HERE, and the shader
 * is then a copy of a proven function rather than an original composition.
 *
 * The direction tests are the load-bearing ones. Sky-reach shadows falling on
 * the WRONG SIDE of every building is a bug that looks plausible on screen
 * (there ARE shadows, they move with the sun, they are just mirrored), and this
 * project has shipped exactly that class twice for the UI-shadow and twice for
 * vegetation (feedback_y_flip_recurring_risk). All four quadrants, explicitly.
 */

import {
  marchDirectionToSun,
  marchVisibility,
  marchStepPx,
  marchPenumbraPx,
  maxThrowPx,
  sunNeedsRebake,
  angleDeltaDeg,
  edgeRamp01,
  resolveSunMarch,
  sharpenReceiverGate01,
  DEFAULT_MARCH_STEPS,
  GATE_SHARPEN_LOW,
  GATE_SHARPEN_HIGH,
} from '../sun-occlusion.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** @param {{ok:(name:string, cond:boolean)=>void}} t */
export function run(t) {
  // ── THE DIRECTION THE RAY WALKS ──────────────────────────────────────
  // Convention (light-visibility.js#shadowOffsetDirection): azimuth is compass
  // degrees clockwise from UP, in a +y-DOWN space. The light is IN that
  // direction; the march walks TOWARD it, so it is the negation of the throw.
  {
    const n = marchDirectionToSun(0); // light due "north" (screen up)
    t.ok('sun at azimuth 0 → the march walks UP (−y)', near(n.x, 0) && near(n.y, -1));

    const e = marchDirectionToSun(90); // light to the right
    t.ok('sun at azimuth 90 → the march walks RIGHT (+x)', near(e.x, 1) && near(e.y, 0));

    const s = marchDirectionToSun(180); // Foundry/world noon = south
    t.ok('sun at azimuth 180 → the march walks DOWN (+y)', near(s.x, 0) && near(s.y, 1));

    const w = marchDirectionToSun(270);
    t.ok('sun at azimuth 270 → the march walks LEFT (−x)', near(w.x, -1) && near(w.y, 0));

    t.ok(
      'every quadrant returns a UNIT vector (a non-unit one silently rescales every step)',
      [0, 37, 90, 143, 180, 250, 270, 355].every((a) => {
        const d = marchDirectionToSun(a);
        return near(Math.hypot(d.x, d.y), 1, 1e-9);
      })
    );
  }

  // ── REACH ────────────────────────────────────────────────────────────
  {
    t.ok(
      'a 100px caster at 45° throws 100px',
      near(maxThrowPx({ maxCasterHeightPx: 100, elevationDeg: 45 }), 100, 1e-9)
    );
    t.ok(
      'the same caster reaches FURTHER as the sun lowers',
      maxThrowPx({ maxCasterHeightPx: 100, elevationDeg: 20 }) >
        maxThrowPx({ maxCasterHeightPx: 100, elevationDeg: 60 })
    );
    t.ok('a sun overhead throws nothing', near(maxThrowPx({ maxCasterHeightPx: 100, elevationDeg: 90 }), 0, 1e-6));
    t.ok('no casters → no reach, whatever the sun does', maxThrowPx({ maxCasterHeightPx: 0, elevationDeg: 5 }) === 0);
    // The grazing case is the one that produces Infinity if handled naively,
    // and an Infinity here becomes a NaN world position in the shader.
    const grazing = maxThrowPx({ maxCasterHeightPx: 100, elevationDeg: 0 });
    t.ok(
      'a sun ON the horizon saturates at the cap — never Infinity, never NaN',
      Number.isFinite(grazing) && grazing > 0
    );
  }

  // ── STEP SIZING: quality, never reach ────────────────────────────────
  {
    const args = { maxCasterHeightPx: 200, elevationDeg: 30 };
    const coarse = marchStepPx({ ...args, steps: 16 });
    const fine = marchStepPx({ ...args, steps: 64 });
    t.ok('more steps means SMALLER steps', fine < coarse);
    t.ok(
      'steps x stepPx spans exactly the same distance either way — raising quality must not lengthen the shadow',
      near(coarse * 16, fine * 64, 1e-9)
    );
  }

  // ── CONTACT HARDENING ────────────────────────────────────────────────
  {
    const atWall = marchPenumbraPx({ distancePx: 0 });
    const farOut = marchPenumbraPx({ distancePx: 500 });
    t.ok('the feather is tight where the shadow meets its caster', atWall < farOut);
    t.ok('the feather is never zero — no shadow is a perfect cutout', atWall > 0);
    t.ok(
      'the atmosphere softens EVERY distance, it does not replace the curve',
      marchPenumbraPx({ distancePx: 500, softnessMul: 3 }) > farOut &&
        marchPenumbraPx({ distancePx: 0, softnessMul: 3 }) > atWall
    );
  }

  // ── THE MARCH ITSELF ─────────────────────────────────────────────────
  {
    // A single 200px-tall blocker sitting 100px to the RIGHT of the origin.
    const blockerAt = (bx, by, hPx) => (x, y) => (Math.hypot(x - bx, y - by) < 40 ? hPx : 0);
    const base = {
      sampleHeightPx: blockerAt(100, 0, 200),
      elevationDeg: 45,
      maxCasterHeightPx: 200,
      steps: 64,
    };

    // Sun at azimuth 90 = to the RIGHT, so the march walks right and FINDS the
    // blocker; the shadow therefore falls to the LEFT of it, i.e. on us.
    const shadowed = marchVisibility({ x: 0, y: 0, azimuthDeg: 90, ...base });
    t.ok('a point on the far side of a blocker FROM the sun is shadowed', shadowed < 1);

    // Same geometry, sun on the opposite side: the march walks away from the
    // blocker and finds nothing. This is the mirrored-shadow bug, caught.
    const lit = marchVisibility({ x: 0, y: 0, azimuthDeg: 270, ...base });
    t.ok('the SAME point with the sun on the other side is fully lit', near(lit, 1, 1e-9));

    t.ok(
      'a taller blocker shadows a point the shorter one cannot reach',
      marchVisibility({
        x: 0,
        y: 0,
        azimuthDeg: 90,
        ...base,
        sampleHeightPx: blockerAt(300, 0, 800),
        maxCasterHeightPx: 800,
      }) <
        marchVisibility({
          x: 0,
          y: 0,
          azimuthDeg: 90,
          ...base,
          sampleHeightPx: blockerAt(300, 0, 60),
          maxCasterHeightPx: 60,
        })
    );

    t.ok(
      'an empty field casts nothing, whatever the sun is doing',
      near(marchVisibility({ x: 0, y: 0, azimuthDeg: 90, ...base, sampleHeightPx: () => 0 }), 1, 1e-9)
    );

    t.ok(
      'a sun overhead casts nothing (the noon no-op)',
      near(marchVisibility({ x: 0, y: 0, azimuthDeg: 90, ...base, elevationDeg: 90 }), 1, 1e-9)
    );

    // THE RECEIVER GATE — the author's "only outdoors" requirement.
    t.ok(
      'receiverGate 0 means this pixel takes no cast shadow at all (the indoors case)',
      near(marchVisibility({ x: 0, y: 0, azimuthDeg: 90, ...base, receiverGate: 0 }), 1, 1e-9)
    );
    t.ok(
      'a partial gate produces a partial shadow, monotonically',
      marchVisibility({ x: 0, y: 0, azimuthDeg: 90, ...base, receiverGate: 0.5 }) > shadowed &&
        marchVisibility({ x: 0, y: 0, azimuthDeg: 90, ...base, receiverGate: 0.5 }) < 1
    );

    t.ok(
      'strength bounds how dark it can get — never below 1 − strength',
      marchVisibility({ x: 0, y: 0, azimuthDeg: 90, ...base, strength: 0.4 }) >= 0.6 - 1e-9
    );

    t.ok(
      'every reading stays in [0,1] across a full sweep of the sky',
      [0, 45, 90, 135, 180, 225, 270, 315].every((az) =>
        [1, 5, 15, 30, 60, 89].every((el) => {
          const v = marchVisibility({ x: 0, y: 0, azimuthDeg: az, ...base, elevationDeg: el });
          return Number.isFinite(v) && v >= 0 && v <= 1;
        })
      )
    );
  }

  // ── CPU AND GPU MUST AGREE ABOUT THE SKY ─────────────────────────────
  {
    const r = resolveSunMarch({ azimuthDeg: 135, elevationDeg: 30, maxCasterHeightPx: 400 });
    const d = marchDirectionToSun(135);
    t.ok(
      'resolveSunMarch hands the shader the SAME direction the CPU march walks',
      near(r.dirX, d.x) && near(r.dirY, d.y)
    );
    t.ok(
      'and the SAME step length',
      near(r.stepPx, marchStepPx({ maxCasterHeightPx: 400, elevationDeg: 30, steps: DEFAULT_MARCH_STEPS }))
    );
    t.ok('tanElev matches the elevation it was given', near(r.tanElev, Math.tan((30 * Math.PI) / 180), 1e-9));
    t.ok(
      'no length controls given → unchanged (backward compatible)',
      near(
        r.stepPx,
        resolveSunMarch({ azimuthDeg: 135, elevationDeg: 30, maxCasterHeightPx: 400, lengthScale: 1, maxLengthMul: 0 })
          .stepPx
      )
    );
  }

  // ── THE LENGTH CONTROLS (2026-07-24, author's #1 ask) ────────────────
  {
    const base = { azimuthDeg: 180, elevationDeg: 20, maxCasterHeightPx: 400 };
    const full = resolveSunMarch({ ...base, lengthScale: 1 });
    const half = resolveSunMarch({ ...base, lengthScale: 0.5 });
    // length ∝ span ∝ 1/tan; half the length ⇒ double the effective tangent.
    t.ok('lengthScale 0.5 halves the span', near(half.spanPx, full.spanPx * 0.5, 1));
    t.ok('lengthScale 0.5 doubles the effective tangent', near(half.tanElev, full.tanElev * 2, 1e-6));
    t.ok('lengthScale never touches direction', near(half.dirX, full.dirX) && near(half.dirY, full.dirY));

    // The dawn/dusk cap only bites at LOW sun (where 1/tan runs away).
    const lowSun = { azimuthDeg: 180, elevationDeg: 3, maxCasterHeightPx: 400 };
    const uncapped = resolveSunMarch({ ...lowSun });
    const capped = resolveSunMarch({ ...lowSun, maxLengthMul: 4 });
    t.ok('the dawn/dusk cap shortens a low-sun shadow', capped.spanPx < uncapped.spanPx);
    t.ok('and caps it at maxLengthMul × the caster height (400 × 4)', near(capped.spanPx, 400 * 4, 1));
    // At HIGH sun the natural shadow is already shorter than the cap → untouched.
    const highSun = { azimuthDeg: 180, elevationDeg: 70, maxCasterHeightPx: 400 };
    t.ok(
      'the dawn/dusk cap does NOT touch a midday shadow',
      near(resolveSunMarch({ ...highSun, maxLengthMul: 4 }).spanPx, resolveSunMarch({ ...highSun }).spanPx, 1e-6)
    );
    t.ok(
      'the two controls compose — scale THEN cap, both applied',
      resolveSunMarch({ ...lowSun, lengthScale: 0.5, maxLengthMul: 4 }).spanPx <= 400 * 4 + 1
    );
  }

  // ── THE REBAKE QUANTISER ─────────────────────────────────────────────
  // Without this a running day clock re-marches every frame and hands back the
  // exact cost model this design exists to avoid.
  {
    t.ok('nothing baked yet always bakes', sunNeedsRebake(null, { azimuthDeg: 0, elevationDeg: 0 }) === true);
    t.ok(
      'a sun that has barely moved does NOT rebake',
      sunNeedsRebake({ azimuthDeg: 100, elevationDeg: 40 }, { azimuthDeg: 100.2, elevationDeg: 40.1 }, 0.5) === false
    );
    t.ok(
      'a sun that has moved past the step DOES rebake',
      sunNeedsRebake({ azimuthDeg: 100, elevationDeg: 40 }, { azimuthDeg: 100.6, elevationDeg: 40 }, 0.5) === true
    );
    t.ok(
      'elevation alone can trigger it (a sun rising straight up still moves the shadows)',
      sunNeedsRebake({ azimuthDeg: 100, elevationDeg: 40 }, { azimuthDeg: 100, elevationDeg: 41 }, 0.5) === true
    );
    // Crossing north: 359° → 1° is 2° of movement, not 358°. Without the wrap
    // this fires a rebake storm every time the sun passes due north.
    t.ok(
      'crossing 0/360 is a SMALL move, not a full circle',
      sunNeedsRebake({ azimuthDeg: 359.9, elevationDeg: 40 }, { azimuthDeg: 0.1, elevationDeg: 40 }, 0.5) === false
    );
    t.ok('angleDeltaDeg wraps to (−180, 180]', near(angleDeltaDeg(1, 359), 2) && near(angleDeltaDeg(359, 1), -2));
  }

  // ── THE MAP-EDGE RAMP ────────────────────────────────────────────────
  {
    const rect = { x: 0, y: 0, width: 1000, height: 1000 };
    t.ok('dead centre is fully un-ramped', near(edgeRamp01({ x: 500, y: 500, rect, bandPx: 200 }), 1));
    t.ok('right on the boundary is fully ramped out', edgeRamp01({ x: 0, y: 500, rect, bandPx: 200 }) === 0);
    t.ok(
      'the ramp is monotonic across the band (a non-monotonic one shows as a band of its own)',
      [10, 50, 100, 150, 199].every((d, i, arr) =>
        i === 0
          ? true
          : edgeRamp01({ x: d, y: 500, rect, bandPx: 200 }) > edgeRamp01({ x: arr[i - 1], y: 500, rect, bandPx: 200 })
      )
    );
    t.ok(
      'a zero band disables it entirely (opt-out stays available)',
      edgeRamp01({ x: 0, y: 500, rect, bandPx: 0 }) === 1
    );
    t.ok(
      'every corner ramps, not just two of them',
      [
        [0, 0],
        [1000, 0],
        [0, 1000],
        [1000, 1000],
      ].every(([x, y]) => edgeRamp01({ x, y, rect, bandPx: 200 }) === 0)
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE RECEIVER-GATE SHARPENING CURVE (2026-07-24, author: "brighter area
  // next to the actual building... shadow should be strongest next to the
  // building"). The wall's own coarse-grid blur was weakening the shadow
  // exactly where it should be strongest; sharpening collapses that band.
  // ═══════════════════════════════════════════════════════════════════════
  {
    t.ok('deep indoors (well under the low edge) stays fully suppressed', sharpenReceiverGate01(0.02) === 0);
    t.ok('well past the high edge is fully receptive', sharpenReceiverGate01(0.6) === 1);
    t.ok(
      'a modest 40% outdoor reading is treated as FULLY receptive — the old raw-value behaviour would have ' +
        'weakened the shadow to 40% strength exactly where contact-hardening says it should be strongest',
      sharpenReceiverGate01(0.4) === 1
    );
    t.ok(
      'the curve is monotonic across the full 0..1 range (no dip that would show as a second, wrong edge)',
      [0, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1].every((v, i, arr) =>
        i === 0 ? true : sharpenReceiverGate01(v) >= sharpenReceiverGate01(arr[i - 1])
      )
    );
    t.ok(
      'the declared thresholds are the ones actually used (not silently retuned)',
      sharpenReceiverGate01(GATE_SHARPEN_LOW) === 0 && sharpenReceiverGate01(GATE_SHARPEN_HIGH) === 1
    );
    t.ok(
      'never negative, never above 1, for out-of-range input',
      sharpenReceiverGate01(-5) === 0 && sharpenReceiverGate01(5) === 1
    );
  }
}
