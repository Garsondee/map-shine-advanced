/**
 * THE SPECIES TABLE — the response model, proven before a pixel is drawn
 * (docs/planning/Precipitation.md §2).
 *
 * What is proven here:
 *   - the closed list and the table never drift apart;
 *   - every row is internally well-formed (ranges ordered, curves valid);
 *   - `resolveSpecies` fails OPEN to *no precipitation*, and tells a typo
 *     apart from a designed-but-unbuilt species apart from a not-a-species;
 *   - ⭐ rain's count curve is genuinely QUADRATIC and snow's genuinely LINEAR
 *     — the one difference §2.3 says makes drizzle read as drizzle;
 *   - `resolveSpeciesFrame` is a true no-op at `precip01 = 0` (LAW 5);
 *   - day/night is a LERP (dusk ramps) and the flash is proportional.
 */
import {
  PRECIP_SPECIES,
  PRECIP_SPECIES_IDS,
  PRECIP_SPECIES_PLANNED,
  resolveSpecies,
  isBuiltSpecies,
  evalCurve,
  resolveSpeciesFrame,
  windTowardVector,
} from '../precip-species.js';

export function run(t) {
  // ---- ⭐ THE COMPASS: which way precipitation is driven -----------------------
  // Pinned because the shader version is browser-only TSL, so a rotation error
  // in it can ONLY be caught by a human on a live map — which is how this was
  // found TWICE, wrong in two different ways (a missing rotation, then a
  // negation that fixed 180 degrees of a 90-degree error). Y-DOWN world: +X is
  // EAST, +Y is SOUTH (the camera is flipped, top = minY).
  {
    const dir = (d) => {
      const v = windTowardVector(d);
      return Math.abs(v.x) > Math.abs(v.y) ? (v.x > 0 ? 'EAST' : 'WEST') : v.y > 0 ? 'SOUTH' : 'NORTH';
    };
    t.ok('directionDeg 0 drives precipitation SOUTH', dir(0) === 'SOUTH');
    t.ok('directionDeg 90 drives it WEST', dir(90) === 'WEST');
    t.ok('directionDeg 180 drives it NORTH', dir(180) === 'NORTH');
    t.ok('directionDeg 270 drives it EAST', dir(270) === 'EAST');
    // The property that actually failed live: turning the wind must turn the
    // rain the SAME way, not 90 degrees off it.
    const a = windTowardVector(0),
      b = windTowardVector(90);
    const crossZ = a.x * b.y - a.y * b.x;
    t.ok('⭐ +90 deg of wind rotates the drive by exactly +90 deg', Math.abs(crossZ - 1) < 1e-9);
    t.ok(
      'the vector is unit length at every angle',
      [0, 37, 90, 211, 359].every((d) => {
        const v = windTowardVector(d);
        return Math.abs(Math.hypot(v.x, v.y) - 1) < 1e-9;
      })
    );
    t.ok(
      'a non-finite angle yields a finite vector rather than NaN',
      Number.isFinite(windTowardVector(NaN).x) && Number.isFinite(windTowardVector(NaN).y)
    );
  }

  // ---- the closed list vs the table ------------------------------------------
  {
    t.ok('P1 ships exactly two species', PRECIP_SPECIES_IDS.length === 2);
    t.ok(
      'the closed list and the table name exactly the same rows',
      PRECIP_SPECIES_IDS.length === Object.keys(PRECIP_SPECIES).length &&
        PRECIP_SPECIES_IDS.every((id) => Object.hasOwn(PRECIP_SPECIES, id))
    );
    t.ok(
      'every row is self-identifying (row.id === its key)',
      PRECIP_SPECIES_IDS.every((id) => PRECIP_SPECIES[id].id === id)
    );
    t.ok(
      'the planned map never overlaps the built table — a species is one or the other',
      Object.keys(PRECIP_SPECIES_PLANNED).every((id) => !Object.hasOwn(PRECIP_SPECIES, id))
    );
    t.ok(
      'drizzle and sleet are in NEITHER map — they are operating points, not rows',
      !Object.hasOwn(PRECIP_SPECIES, 'drizzle') &&
        !Object.hasOwn(PRECIP_SPECIES_PLANNED, 'drizzle') &&
        !Object.hasOwn(PRECIP_SPECIES, 'sleet') &&
        !Object.hasOwn(PRECIP_SPECIES_PLANNED, 'sleet')
    );
  }

  // ---- row well-formedness ----------------------------------------------------
  {
    for (const id of PRECIP_SPECIES_IDS) {
      const s = PRECIP_SPECIES[id];
      t.ok(
        `${id}: speed range is ordered and positive`,
        s.fall.speedPxS[0] > 0 && s.fall.speedPxS[1] > s.fall.speedPxS[0]
      );
      t.ok(`${id}: size range is ordered and positive`, s.body.sizePx[0] > 0 && s.body.sizePx[1] > s.body.sizePx[0]);
      t.ok(
        `${id}: gravity multiplier range is ordered`,
        s.fall.gravityMul[0] > 0 && s.fall.gravityMul[1] > s.fall.gravityMul[0]
      );
      t.ok(`${id}: windCarry01 is a real 0..1`, s.fall.windCarry01 >= 0 && s.fall.windCarry01 <= 1);
      t.ok(`${id}: spawnHeightPx is a real parallax budget`, s.fall.spawnHeightPx > 0);
      t.ok(`${id}: capacity is a positive integer`, Number.isInteger(s.capacity) && s.capacity > 0);
      t.ok(`${id}: declares a zoom-sleep threshold`, s.zoomSleepPxPerBody > 0);
      t.ok(
        `${id}: declares the full V2 light scalar set`,
        ['dayAlphaMul', 'dayRgbMul', 'nightAlphaMul', 'nightRgbMul', 'flashAlphaMul', 'flashRgbMul'].every((k) =>
          Number.isFinite(s.light[k])
        )
      );
      t.ok(
        `${id}: night is dimmer than day (both channels)`,
        s.light.nightAlphaMul < s.light.dayAlphaMul && s.light.nightRgbMul < s.light.dayRgbMul
      );
      t.ok(`${id}: the flash BOOSTS rather than dims`, s.light.flashAlphaMul > 1 && s.light.flashRgbMul > 1);
      t.ok(
        `${id}: every response curve names a known kind`,
        Object.values(s.respond).every((c) => ['linear', 'pow', 'threshold'].includes(c.kind))
      );
    }
    // ⚠️ P1 ships fall/body/respond/light ONLY. `arrive` (P2) and `stay` (P3)
    // must be genuinely ABSENT, not present-and-empty — see the module header.
    t.ok(
      'no row carries an `arrive` block yet — P2 adds it with the splashes',
      PRECIP_SPECIES_IDS.every((id) => PRECIP_SPECIES[id].arrive === undefined)
    );
    t.ok(
      'no row carries a `stay` block yet — P3 adds it with the mantle',
      PRECIP_SPECIES_IDS.every((id) => PRECIP_SPECIES[id].stay === undefined)
    );
  }

  // ---- rain vs snow: the differences that ARE the design ----------------------
  {
    const rain = PRECIP_SPECIES.rain;
    const snow = PRECIP_SPECIES.snow;
    t.ok('snow falls an order of magnitude slower than rain', snow.fall.speedPxS[1] < rain.fall.speedPxS[0] / 5);
    t.ok('snow is carried by wind far more than rain', snow.fall.windCarry01 > rain.fall.windCarry01);
    t.ok(
      '⭐ snow flutters (the paper-fall) and rain does not',
      snow.fall.flutter !== null && rain.fall.flutter === null
    );
    t.ok('⭐ snow spins and rain does not', snow.fall.spin !== null && rain.fall.spin === null);
    t.ok('rain streaks far more per unit speed than a flake does', rain.body.streakPerPxS > snow.body.streakPerPxS * 3);
    // ⚠️ A REGRESSION PIN, not a style check. The first cut of this field read
    // the harvest ledger's `0.0065×0.25` as a product and drew 1.2–8.2 SCREEN
    // px specks instead of rain; the shader lab measured it and the sweep
    // landed on V2's `speedFactor` alone. A future "tidy-up" that reintroduces
    // the multiplication silently returns the starfield, and no Node assertion
    // about ratios or ranges would notice — so the VALUE itself is pinned.
    t.ok(
      '⭐ rain streak factor is V2s speedFactor alone (0.0065), not the 0.25 product',
      Math.abs(rain.body.streakPerPxS - 0.0065) < 1e-9
    );
    t.ok(
      'a fast drop therefore draws a streak tens of world px long, not single digits',
      rain.fall.speedPxS[1] * rain.body.streakPerPxS > 25
    );
    t.ok('a flake is soft-edged, a streak is hard', snow.body.softness01 > rain.body.softness01);
    t.ok('snow is bigger than a rain streak is wide', snow.body.sizePx[0] > rain.body.sizePx[0]);
    t.ok('snow therefore sleeps LATER than rain when zooming out', snow.zoomSleepPxPerBody > rain.zoomSleepPxPerBody);
    t.ok(
      'only snow responds to storm activity (its flutter)',
      snow.respondStorm?.flutter && rain.respondStorm === undefined
    );
  }

  // ---- evalCurve --------------------------------------------------------------
  {
    t.ok(
      'linear hits both endpoints exactly',
      evalCurve({ kind: 'linear', from: 0, to: 1 }, 0) === 0 && evalCurve({ kind: 'linear', from: 0, to: 1 }, 1) === 1
    );
    t.ok('linear is halfway at 0.5', Math.abs(evalCurve({ kind: 'linear', from: 0, to: 10 }, 0.5) - 5) < 1e-9);
    t.ok(
      'pow exp=2 is a QUARTER at halfway, not a half',
      Math.abs(evalCurve({ kind: 'pow', exp: 2, from: 0, to: 1 }, 0.5) - 0.25) < 1e-9
    );
    t.ok(
      'pow still hits both endpoints',
      evalCurve({ kind: 'pow', exp: 2, from: 0, to: 1 }, 0) === 0 &&
        evalCurve({ kind: 'pow', exp: 2, from: 0, to: 1 }, 1) === 1
    );
    t.ok('threshold is flat below its knee', evalCurve({ kind: 'threshold', at: 0.5, from: 0, to: 1 }, 0.3) === 0);
    t.ok(
      'threshold is exactly at the floor ON its knee',
      evalCurve({ kind: 'threshold', at: 0.5, from: 0, to: 1 }, 0.5) === 0
    );
    t.ok(
      'threshold is halfway up at the midpoint of its ramp',
      Math.abs(evalCurve({ kind: 'threshold', at: 0.5, from: 0, to: 1 }, 0.75) - 0.5) < 1e-9
    );
    t.ok(
      'threshold reaches its ceiling at 1',
      Math.abs(evalCurve({ kind: 'threshold', at: 0.5, from: 0, to: 1 }, 1) - 1) < 1e-9
    );
    t.ok(
      'a degenerate threshold at=1 is a step, not a divide-by-zero',
      Number.isFinite(evalCurve({ kind: 'threshold', at: 1, from: 0, to: 1 }, 1))
    );
    t.ok(
      'input is clamped, never extrapolated',
      evalCurve({ kind: 'linear', from: 0, to: 1 }, 5) === 1 && evalCurve({ kind: 'linear', from: 0, to: 1 }, -5) === 0
    );
    t.ok('a non-finite input yields the floor', evalCurve({ kind: 'linear', from: 0.2, to: 1 }, NaN) === 0.2);
    // ⚠️ FAIL-OPEN POLARITY: a malformed curve must make LESS weather.
    t.ok(
      'an unknown curve kind yields the FLOOR, never the ceiling',
      evalCurve({ kind: 'nonsense', from: 0.1, to: 0.9 }, 1) === 0.1
    );
    t.ok('a null curve yields zero rather than throwing', evalCurve(null, 0.5) === 0);
  }

  // ---- ⭐ the curve shapes §2.3 actually specifies -----------------------------
  {
    const rain = PRECIP_SPECIES.rain;
    const snow = PRECIP_SPECIES.snow;
    // "drizzle is SPARSE before it is short" — at half intensity, rain must
    // have far fewer than half its bodies. This is the single most important
    // curve in the table and a linear one would silently pass every other check.
    const rainHalf = evalCurve(rain.respond.count, 0.5);
    t.ok('⭐ rain at half precip has a QUARTER of its bodies (quadratic)', Math.abs(rainHalf - 0.25) < 1e-9);
    const snowHalf = evalCurve(snow.respond.count, 0.5);
    t.ok(
      '⭐ snow at half precip has HALF its bodies (linear, deliberately unlike rain)',
      Math.abs(snowHalf - 0.5) < 1e-9
    );
    t.ok('the two count curves genuinely differ at the same input', rainHalf !== snowHalf);
    // "heavy rain falls harder, not just thicker"
    t.ok('rain gets longer as it intensifies', evalCurve(rain.respond.length, 1) > evalCurve(rain.respond.length, 0));
    t.ok('rain gets faster as it intensifies', evalCurve(rain.respond.speed, 1) > evalCurve(rain.respond.speed, 0));
    // "a downpour greys the air; drizzle does not"
    t.ok('drizzle raises NO veil', evalCurve(rain.respond.veil, 0.2) === 0);
    t.ok('a downpour raises a full veil', Math.abs(evalCurve(rain.respond.veil, 1) - 1) < 1e-9);
    // "blizzard snow travels, it doesn't waltz"
    t.ok(
      '⭐ snow flutter COLLAPSES as the storm rises',
      evalCurve(snow.respondStorm.flutter, 1) < evalCurve(snow.respondStorm.flutter, 0) * 0.25
    );
    t.ok('calm snow flutters at full strength', Math.abs(evalCurve(snow.respondStorm.flutter, 0) - 1) < 1e-9);
  }

  // ---- resolveSpecies: three distinguishable failures --------------------------
  {
    const hit = resolveSpecies('rain');
    t.ok('a built species resolves ok', hit.ok === true && hit.species === PRECIP_SPECIES.rain && hit.reason === null);
    t.ok('isBuiltSpecies agrees', isBuiltSpecies('rain') === true && isBuiltSpecies('hail') === false);

    const planned = resolveSpecies('hail');
    t.ok(
      'a DESIGNED-but-unbuilt species fails with a schedule, not "unknown"',
      planned.ok === false && planned.species === null && /not built/.test(planned.reason)
    );
    t.ok('the planned reason names its owning slice', /P5/.test(resolveSpecies('hail').reason));

    const notASpecies = resolveSpecies('drizzle');
    t.ok(
      'drizzle is refused as NOT A SPECIES, with the reason why',
      notASpecies.ok === false && /not a species/.test(notASpecies.reason) && /low precip01/.test(notASpecies.reason)
    );
    t.ok(
      'sleet is refused as a BLEND, with the reason why',
      /not a species/.test(resolveSpecies('sleet').reason) && /blend/.test(resolveSpecies('sleet').reason)
    );

    const typo = resolveSpecies('ran');
    t.ok(
      'a genuine typo says "unknown", distinct from both cases above',
      typo.ok === false && /unknown/.test(typo.reason)
    );
    t.ok('undefined fails open cleanly rather than throwing', resolveSpecies(undefined).ok === false);
    // ⚠️ THE POLARITY THAT MATTERS: never a default downpour.
    t.ok(
      '⭐ EVERY failure yields null, never a fallback species that would rain',
      [resolveSpecies('hail'), resolveSpecies('drizzle'), resolveSpecies('ran'), resolveSpecies(undefined)].every(
        (r) => r.species === null
      )
    );
  }

  // ---- resolveSpeciesFrame ----------------------------------------------------
  {
    const rain = PRECIP_SPECIES.rain;

    // LAW 5: a clear day costs nothing.
    const clear = resolveSpeciesFrame(rain, { precip01: 0 });
    t.ok('⭐ LAW 5: precip01=0 yields ZERO live bodies', clear.liveCount === 0);
    t.ok('LAW 5: precip01=0 raises no veil either', clear.veil01 === 0);

    const full = resolveSpeciesFrame(rain, { precip01: 1 });
    t.ok('precip01=1 yields the full capacity', full.liveCount === rain.capacity);
    const half = resolveSpeciesFrame(rain, { precip01: 0.5 });
    t.ok(
      'precip01=0.5 yields a QUARTER of capacity (the quadratic, end to end)',
      half.liveCount === Math.round(rain.capacity * 0.25)
    );

    // The tier scale is the cascade's budget lever, multiplying the count.
    const tiered = resolveSpeciesFrame(rain, { precip01: 1 }, 0.5);
    t.ok(
      'tierScale halves the live count without touching capacity',
      tiered.liveCount === Math.round(rain.capacity * 0.5)
    );
    t.ok('capacity itself is NEVER changed by a frame resolve', rain.capacity === 15000);
    t.ok(
      'a tierScale above 1 cannot exceed capacity',
      resolveSpeciesFrame(rain, { precip01: 1 }, 99).liveCount === rain.capacity
    );

    // Day/night is a LERP, so dusk ramps.
    const day = resolveSpeciesFrame(rain, { precip01: 1, dayFactor01: 1 });
    const night = resolveSpeciesFrame(rain, { precip01: 1, dayFactor01: 0 });
    const dusk = resolveSpeciesFrame(rain, { precip01: 1, dayFactor01: 0.5 });
    t.ok(
      'full day uses V2 day scalars exactly',
      Math.abs(day.alphaMul - 1.62) < 1e-9 && Math.abs(day.rgbMul - 0.5) < 1e-9
    );
    t.ok(
      'full night uses V2 night scalars exactly',
      Math.abs(night.alphaMul - 0.34) < 1e-9 && Math.abs(night.rgbMul - 0.24) < 1e-9
    );
    t.ok(
      '⭐ dusk LERPS between them rather than snapping',
      dusk.alphaMul > night.alphaMul && dusk.alphaMul < day.alphaMul
    );
    t.ok('dusk is exactly halfway (a true lerp, not an ease)', Math.abs(dusk.alphaMul - (1.62 + 0.34) / 2) < 1e-9);
    t.ok(
      'dayFactor01 defaults to full day when absent',
      Math.abs(resolveSpeciesFrame(rain, { precip01: 1 }).alphaMul - day.alphaMul) < 1e-9
    );

    // The flash is proportional, not a switch.
    const flashed = resolveSpeciesFrame(rain, { precip01: 1, dayFactor01: 1, flash01: 1 });
    t.ok('⭐ a full flash multiplies alpha by V2s x6', Math.abs(flashed.alphaMul - 1.62 * 6) < 1e-6);
    t.ok('a full flash multiplies rgb by V2s x4', Math.abs(flashed.rgbMul - 0.5 * 4) < 1e-6);
    const halfFlash = resolveSpeciesFrame(rain, { precip01: 1, dayFactor01: 1, flash01: 0.5 });
    t.ok(
      'half a flash is genuinely half a flash, not on/off',
      halfFlash.alphaMul > day.alphaMul && halfFlash.alphaMul < flashed.alphaMul
    );
    t.ok(
      'no flash leaves the scalars untouched',
      Math.abs(resolveSpeciesFrame(rain, { precip01: 1, dayFactor01: 1, flash01: 0 }).alphaMul - day.alphaMul) < 1e-9
    );

    // Snow's storm-keyed flutter, end to end.
    const snow = PRECIP_SPECIES.snow;
    t.ok(
      'calm snow flutters fully',
      Math.abs(resolveSpeciesFrame(snow, { precip01: 1, stormActivity01: 0 }).flutterMul - 1) < 1e-9
    );
    t.ok(
      'blizzard snow barely flutters',
      resolveSpeciesFrame(snow, { precip01: 1, stormActivity01: 1 }).flutterMul < 0.2
    );
    t.ok(
      'rain reports flutterMul 1 (no storm response) so the kernel can multiply unconditionally',
      resolveSpeciesFrame(rain, { precip01: 1, stormActivity01: 1 }).flutterMul === 1
    );

    // Garbage in, clear sky out — never a NaN reaching a uniform.
    const garbage = resolveSpeciesFrame(rain, {
      precip01: NaN,
      stormActivity01: 'x',
      dayFactor01: undefined,
      flash01: null,
    });
    t.ok(
      'non-finite axes yield a clear sky, not NaN',
      garbage.liveCount === 0 && Number.isFinite(garbage.alphaMul) && Number.isFinite(garbage.rgbMul)
    );
  }
}
