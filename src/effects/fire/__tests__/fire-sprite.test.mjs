/**
 * fire-sprite.test.mjs — THE COLOUR SPEC, PINNED AGAINST V2.
 *
 * The TSL half of `fire-sprite.js` (the four archetypes) is browser-only and is
 * judged in `tools/shader-lab/bench-fire.js#sprite-archetypes`. What CAN be
 * tested here is the half that carries the look in data: the gradients, the
 * emission and alpha curves, and the temperature blend.
 *
 * ⚠️ THESE ARE TRANSCRIPTION TESTS, AND THAT IS THE POINT. Every number in this
 * module was copied out of `legacy/compositor-v2/effects/fire-behaviors.js`,
 * where it had years of the author's approval behind it. A transcription error
 * in a colour stop would not throw, would not fail a render, and would produce a
 * fire that is subtly wrong in a way nobody could trace back to a typo. So the
 * shipped values are asserted directly, and the curve SHAPES that carry the
 * look — the ignition pop, the monotone cooling — are asserted as properties
 * rather than as spot values, so a deliberate retune has to break something
 * meaningful rather than merely move a number.
 */
import {
  FLAME_GRADIENT_COLD,
  FLAME_GRADIENT_STANDARD,
  FLAME_GRADIENT_HOT,
  FLAME_EMISSION_STOPS,
  FLAME_ALPHA_STOPS,
  EMBER_COLOR_STOPS,
  EMBER_EMISSION_STOPS,
  SMOKE_COLOR_STOPS,
  FLAME_ARCHETYPES,
  FIRE_HDR_LINEAR_GAIN,
  FLAME_CORE_EMISSION,
  EMBER_EMISSION,
  FLAME_PEAK_OPACITY,
  EMBER_PEAK_OPACITY,
  flameGradientStops,
} from '../fire-sprite.js';

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
/** Every stop list must be ascending in `t` or the piecewise builders mis-ramp. */
const ascending = (stops) => stops.every((s, i) => i === 0 || s.t > stops[i - 1].t);

export function run(t) {
  // ── STOP LISTS ARE WELL-FORMED ─────────────────────────────────────────────

  {
    const lists = {
      FLAME_GRADIENT_COLD,
      FLAME_GRADIENT_STANDARD,
      FLAME_GRADIENT_HOT,
      FLAME_EMISSION_STOPS,
      FLAME_ALPHA_STOPS,
      EMBER_COLOR_STOPS,
      EMBER_EMISSION_STOPS,
      SMOKE_COLOR_STOPS,
    };
    for (const [name, stops] of Object.entries(lists)) {
      t.ok(`${name} ascends in t`, ascending(stops));
      t.ok(`${name} spans a full life 0..1`, near(stops[0].t, 0) && near(stops.at(-1).t, 1));
      const finite = stops.every((s) => (s.rgb ? s.rgb.every(Number.isFinite) : Number.isFinite(s.v)));
      t.ok(`${name} is all finite`, finite);
    }
    // The three flame gradients are blended stop-for-stop, so they must line up.
    t.ok(
      'the three flame gradients share a stop layout',
      FLAME_GRADIENT_COLD.length === FLAME_GRADIENT_STANDARD.length &&
        FLAME_GRADIENT_STANDARD.length === FLAME_GRADIENT_HOT.length &&
        FLAME_GRADIENT_COLD.every((s, i) => near(s.t, FLAME_GRADIENT_HOT[i].t))
    );
  }

  // ── THE IGNITION POP — the shape that reads as CATCHING FIRE ───────────────

  {
    // Asserted as a PROPERTY, not a spot value: emission must start at zero,
    // peak early, and decay to zero. A retune may move the numbers; it may not
    // turn the pop into a plateau without failing here.
    t.ok('flame emission starts dark', near(FLAME_EMISSION_STOPS[0].v, 0));
    t.ok('flame emission ends dark', near(FLAME_EMISSION_STOPS.at(-1).v, 0));
    const peak = FLAME_EMISSION_STOPS.reduce((a, b) => (b.v > a.v ? b : a));
    t.ok(`the flame's emission peak is in the first 20% of life (t=${peak.t})`, peak.t <= 0.2);
    t.ok(`...and it is a real spike (${peak.v})`, peak.v >= 3.5);
    // Monotone decay after the peak — no second flare-up.
    const after = FLAME_EMISSION_STOPS.filter((s) => s.t >= peak.t);
    t.ok(
      'emission decays monotonically after the pop',
      after.every((s, i) => i === 0 || s.v <= after[i - 1].v)
    );
    // The same shape for embers, harder.
    const emberPeak = EMBER_EMISSION_STOPS.reduce((a, b) => (b.v > a.v ? b : a));
    t.ok(`the ember pop is even hotter than the flame's (${emberPeak.v} vs ${peak.v})`, emberPeak.v > peak.v);
  }

  {
    // ⚠️ THE RATIO IS THE READ. An ember is a tiny additive dot; it only reads
    // as a point SOURCE rather than a speck because it is disproportionately
    // brighter and more opaque than the flame mass around it. V2 shipped ~8.6×
    // emission and ~5.3× opacity, and those ratios are the reason.
    t.ok(
      `embers are far hotter than flames (${(EMBER_EMISSION / FLAME_CORE_EMISSION).toFixed(1)}×)`,
      EMBER_EMISSION / FLAME_CORE_EMISSION > 6
    );
    // ⚠️ THRESHOLD LOWERED 4× → 2×, 2026-08-09, DELIBERATELY. V2's ratio was
    // ~5.3× (0.19 flame vs 1.0 ember) because it ran ~51 overlapping flame
    // sprites that built their mass up between them. This build runs about a
    // dozen per fire, so flame opacity went to 0.45 — each sprite has to carry
    // more of the silhouette or the archetype shape never reads at all. The
    // ember still has to be the more opaque of the two (that is what makes a
    // tiny dot read as a point SOURCE), which is what this now pins.
    t.ok(
      `embers are still more opaque than flames (${(EMBER_PEAK_OPACITY / FLAME_PEAK_OPACITY).toFixed(1)}×)`,
      EMBER_PEAK_OPACITY / FLAME_PEAK_OPACITY > 2
    );
  }

  {
    // ⚠️ BLOOM IS A NUMBER, NOT A HOPE. `BLOOM_PARAMS.threshold` defaults to 4.0
    // on an HDR scene. The previous (volumetric) fire peaked at 1.25 and could
    // never have bloomed at any setting — the author asked why it did not glow
    // and the answer was arithmetic. Pin that the newborn core clears it.
    const peakEmission = Math.max(...FLAME_EMISSION_STOPS.map((s) => s.v));
    const corePeak = peakEmission * FLAME_CORE_EMISSION * FIRE_HDR_LINEAR_GAIN;
    t.ok(`a newborn flame core clears bloom's 4.0 threshold (${corePeak.toFixed(1)})`, corePeak > 4);
    // ⚠️ HEADROOM CEILING ADDED AND THE FLOOR LOWERED, 2026-08-09. The original
    // assertion was `> 10`, which V2's gain met at ~15 — and that is precisely
    // what produced the author's *"Flame brightness effects just a white blur"*:
    // a dozen sprites overlapping at 15 radiance each sum past 35 under additive
    // blending, and EVERY hue saturates to white long before that. A single
    // sprite must now clear the threshold on its own while leaving room for a
    // pile of them to stay coloured, so this pins a BAND rather than a floor.
    t.ok(`...without room to saturate a stack of them (${corePeak.toFixed(1)})`, corePeak > 4 && corePeak < 12);
  }

  // ── SMOKE'S ORANGE BIRTH — the flame→smoke handover ────────────────────────

  {
    // ⚠️ THIS IS THE WHOLE "LICKS UP THEN TURNS TO SMOKE" READ. Flame and smoke
    // are separate systems that never exchange particles; the only thing tying
    // them together is that smoke is BORN the colour the flame died. Lose this
    // and the effect reads as "sprites plus haze" — V2's own words.
    const birth = SMOKE_COLOR_STOPS[0].rgb;
    t.ok(`smoke is born warm, not grey (${birth.join(', ')})`, birth[0] > birth[2] * 2.5);
    t.ok('...and it is genuinely orange, not merely warm', birth[0] > 0.6 && birth[1] > 0.25 && birth[2] < 0.25);
    // It must cool FAST — within roughly the first tenth of life.
    const cooled = SMOKE_COLOR_STOPS[1];
    t.ok(`smoke cools to neutral quickly (by t=${cooled.t})`, cooled.t < 0.15);
    const spread = Math.max(...cooled.rgb) - Math.min(...cooled.rgb);
    t.ok(`...and what it cools TO is near-neutral (spread ${spread.toFixed(2)})`, spread < 0.15);
    // And it fades to black so smoke can disappear rather than pile up.
    t.ok(
      'smoke fades to black',
      SMOKE_COLOR_STOPS.at(-1).rgb.every((c) => near(c, 0))
    );
  }

  // ── THE TEMPERATURE BLEND ──────────────────────────────────────────────────

  {
    // The exact endpoints, so the blend cannot silently invert.
    const cold = flameGradientStops(0);
    const hot = flameGradientStops(1);
    t.ok(
      'temperature 0 IS the cold gradient',
      cold.every((s, i) => s.rgb.every((c, ch) => near(c, FLAME_GRADIENT_COLD[i].rgb[ch], 1e-9)))
    );
    t.ok(
      'temperature 1 IS the hot gradient',
      hot.every((s, i) => s.rgb.every((c, ch) => near(c, FLAME_GRADIENT_HOT[i].rgb[ch], 1e-9)))
    );
    t.ok(
      'temperature 0.5 IS the standard gradient',
      flameGradientStops(0.5).every((s, i) => s.rgb.every((c, ch) => near(c, FLAME_GRADIENT_STANDARD[i].rgb[ch], 1e-9)))
    );
    // Hotter really means whiter at the core — the property the control promises.
    const blueAt = (temp) => flameGradientStops(temp)[0].rgb[2];
    t.ok('raising temperature makes the newborn core bluer/whiter', blueAt(1) > blueAt(0.5) && blueAt(0.5) > blueAt(0));
    // V2's shipped default sits most of the way toward HOT.
    const shipped = flameGradientStops(0.85);
    t.ok('the shipped 0.85 default is nearer HOT than STANDARD', shipped[0].rgb[2] > FLAME_GRADIENT_STANDARD[0].rgb[2]);
  }

  {
    // Degenerate input must degrade to a usable gradient, never to NaN — these
    // values reach a vertex buffer.
    for (const bad of [NaN, undefined, null, -5, 99, Infinity]) {
      const stops = flameGradientStops(bad);
      const finite = stops.every((s) => s.rgb.every(Number.isFinite) && Number.isFinite(s.t));
      t.ok(`temperature ${String(bad)} still yields a finite gradient`, finite);
    }
  }

  // ── THE ARCHETYPE LIST ─────────────────────────────────────────────────────

  {
    // The dispatch order is V2's own, and `fire-particles` will index into it.
    t.ok('there are exactly four archetypes', FLAME_ARCHETYPES.length === 4);
    t.ok(
      "they are V2's four, in V2's dispatch order",
      FLAME_ARCHETYPES.join(',') === 'plasmaCore,convectionCrescent,vortexSwirl,thermalRing'
    );
    t.ok('the list is frozen', Object.isFrozen(FLAME_ARCHETYPES));
  }
}
