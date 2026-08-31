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
  precipTierScaleForProfile,
} from '../precip-species.js';
import { resolveActivePopulations } from '../precip-subsystem.js';

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
    // P1 shipped two rows; P5 added `hail` (§4.4's phase machine, the species
    // the ARENA was extended for). The count is asserted because the closed
    // list and the table must never drift apart, not because three is a target.
    t.ok('the closed list ships eight species', PRECIP_SPECIES_IDS.length === 8);
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
      /**
       * ⭐ THE RULE DEPENDS ON WHETHER THE BODY MAKES ITS OWN LIGHT.
       *
       * ⚠️ THIS ASSERTED "night is dimmer than day" FOR EVERY ROW until P6, and
       * `spore` and `mote` failed it — correctly. A body that CATCHES light is
       * dimmer when there is less of it; a body that EMITS light is more
       * visible against a dark ground, which is why a firefly is a night
       * creature. The old assertion had quietly encoded "every species is
       * water", which was true of all three rows that existed and is not a law.
       *
       * `body.emissive01` is the discriminator, so the check now says what it
       * means rather than what happened to hold
       * (`feedback_one_input_two_extractions_two_thresholds`).
       */
      if (s.body.emissive01 > 0) {
        t.ok(
          `${id}: EMISSIVE — reads brighter at night, not dimmer`,
          s.light.nightAlphaMul > s.light.dayAlphaMul && s.light.nightRgbMul > s.light.dayRgbMul
        );
      } else {
        t.ok(
          `${id}: LIT — night is dimmer than day (both channels)`,
          s.light.nightAlphaMul < s.light.dayAlphaMul && s.light.nightRgbMul < s.light.dayRgbMul
        );
      }
      t.ok(`${id}: the flash BOOSTS rather than dims`, s.light.flashAlphaMul > 1 && s.light.flashRgbMul > 1);
      t.ok(
        `${id}: every response curve names a known kind`,
        Object.values(s.respond).every((c) => ['linear', 'pow', 'threshold'].includes(c.kind))
      );
    }
    // ⚠️ THE SCHEDULE IS AN ASSERTION, IN BOTH DIRECTIONS. `arrive` landed
    // with P2's splashes and must now EXIST on every row; `stay` is P3's and
    // must still be genuinely ABSENT, not present-and-empty (see the module
    // header). Only asserting the absent half would let a future slice add an
    // empty `arrive` back and call it progress.
    t.ok(
      'every row carries an `arrive` block — P2 shipped it with the splashes',
      PRECIP_SPECIES_IDS.every((id) => PRECIP_SPECIES[id].arrive?.kind)
    );
    t.ok(
      'every `arrive.kind` is in the closed list',
      PRECIP_SPECIES_IDS.every((id) => ['splash', 'bounce', 'settle', 'none'].includes(PRECIP_SPECIES[id].arrive.kind))
    );
    // ⚠️ THE FIELDS P2 DOES NOT CONSUME MUST STILL BE ABSENT. `bounces` is
    // P5's, `restSec` is P3's, `waterRing` is §4.2's — all three are in §2.1's
    // schema and none has a reader today. This is the same rot guard as the
    // `stay` line below, aimed one level deeper.
    t.ok(
      'no row carries `bounces`/`restSec`/`waterRing` yet — P3/P5/§4.2 add them with their readers',
      PRECIP_SPECIES_IDS.every((id) => {
        const a = PRECIP_SPECIES[id].arrive;
        return a.bounces === undefined && a.restSec === undefined && a.waterRing === undefined;
      })
    );
    // ⭐ `stay` LANDED WITH P3's MANTLE, same discipline as `arrive` — the
    // block appears in the commit that builds its reader. Its own contents are
    // proven in `mantle-model.test.mjs`, beside the integrator that consumes
    // them; here we only assert the SCHEDULE.
    t.ok(
      'every row carries a `stay` block — P3 shipped it with the mantle',
      PRECIP_SPECIES_IDS.every((id) => PRECIP_SPECIES[id].stay?.surface)
    );
    t.ok(
      'every `stay.channel` is a known channel or an explicit null',
      PRECIP_SPECIES_IDS.every((id) => [null, 'snow', 'dust'].includes(PRECIP_SPECIES[id].stay.channel))
    );
  }

  // ---- ⭐ THE DUAL-POPULATION CAPABILITY ---------------------------------------
  {
    const of = (kind, w) => resolveActivePopulations(kind, w);
    const idsOf = (r) => r.populations.map((p) => p.speciesId).sort();
    const weightOf = (r, id) => r.populations.find((p) => p.speciesId === id)?.weight ?? 0;

    // ⭐ SLEET IS GENUINELY BOTH — the whole reason this capability exists.
    const mid = of('sleet', 0.5);
    t.ok('sleet at the band’s middle runs BOTH populations', idsOf(mid).join(',') === 'rain,snow');
    t.ok(
      '…and splits them evenly',
      Math.abs(weightOf(mid, 'rain') - 0.5) < 1e-9 && Math.abs(weightOf(mid, 'snow') - 0.5) < 1e-9
    );

    /**
     * ⚠️ THE BUG THIS REPLACED: a resolver returning ONE species made a
     * 0.49-weight sleet pure rain and a 0.51 pure snow — a hard flip in the
     * exact middle of the band the band exists to smooth. Continuity across
     * that point is now something the suite can actually assert.
     */
    const warmSide = of('sleet', 0.49);
    const coldSide = of('sleet', 0.51);
    t.ok(
      '⭐ crossing the band’s middle is CONTINUOUS, not a flip',
      Math.abs(weightOf(warmSide, 'snow') - weightOf(coldSide, 'snow')) < 0.05
    );
    t.ok(
      'both sides of the middle still run both populations',
      idsOf(warmSide).length === 2 && idsOf(coldSide).length === 2
    );

    // …and the ENDS collapse to one, because at the edges sleet IS just rain or
    // just snow — and a population at weight 0.004 still builds an engine,
    // seeds an arena and dispatches a kernel nobody can see the result of.
    t.ok('the warm end is rain alone', idsOf(of('sleet', 0)).join(',') === 'rain');
    t.ok('the cold end is snow alone', idsOf(of('sleet', 1)).join(',') === 'snow');
    t.ok(
      'weights always sum to 1 — the blend divides the weather, it does not add to it',
      [0, 0.2, 0.5, 0.8, 1].every(
        (w) => Math.abs(of('sleet', w).populations.reduce((n, p) => n + p.weight, 0) - 1) < 1e-9
      )
    );

    // ⭐ ASH BRINGS ITS EMBERS (§2.2's `ashSystem` + `ashEmberSystem` pair).
    const ash = of('ash', 0);
    t.ok('ash runs two populations', idsOf(ash).join(',') === 'ash,ember');
    t.ok('the parent is at full strength', weightOf(ash, 'ash') === 1);
    // ⚠️ SPARSE. A one-to-one pairing would read as orange snow.
    t.ok('the companion is sparse', weightOf(ash, 'ember') > 0 && weightOf(ash, 'ember') < 0.2);
    t.ok(
      'the companion comes from the ROW, not from a branch here',
      PRECIP_SPECIES.ash.companion.speciesId === 'ember'
    );

    /**
     * ⭐ AND `ember` IS STRUCTURALLY UNSELECTABLE — §2.2's boundary between
     * fire's embers (rising FROM fires) and weather's (falling from the sky)
     * made mechanical rather than left as a comment. The closed list cannot
     * name it, so no GM, no derivation and no stored scene flag can summon one.
     */
    t.ok('ember is not a selectable species', !PRECIP_SPECIES_IDS.includes('ember'));
    t.ok('ember is not in the main table', !Object.hasOwn(PRECIP_SPECIES, 'ember'));
    t.ok(
      '…but it resolves, so the engine builder can construct what ash summoned',
      resolveSpecies('ember').ok === true
    );
    t.ok(
      'the `embers` KIND stays unbuilt rather than summoning a bare population',
      of('embers', 0).populations.length === 0
    );

    // A species with no companion runs alone.
    t.ok('plain species run alone', of('rain', 0).populations.length === 1 && of('hail', 0).populations.length === 1);
    // Failures still yield NOTHING, never a fallback that would rain.
    t.ok(
      'an unknown kind yields no populations, with a reason',
      of('nonesuch', 0).populations.length === 0 && /unknown/.test(of('nonesuch', 0).reason)
    );
    t.ok('a non-finite weight is treated as the warm end', of('sleet', NaN).populations[0].speciesId === 'rain');
  }

  // ---- THE ARRIVAL: V2's four splash tiles, transcribed ----------------------
  {
    const a = PRECIP_SPECIES.rain.arrive;
    t.ok('rain splashes', a.kind === 'splash');
    // ⚠️ SNOW SETTLES, AND THE SPLASH ENGINE READS `kind`, NOT THE BLOCK'S
    // EXISTENCE. A discriminator that only says "has an arrive block" would
    // make snow throw water — the exact `feedback_gate_and_self_exclusion_
    // answer_different_questions` shape.
    t.ok('snow settles, it does not splash', PRECIP_SPECIES.snow.arrive.kind === 'settle');
    t.ok('snow carries no splash archetypes at all', PRECIP_SPECIES.snow.arrive.archetypes === undefined);

    t.ok('rain ships V2’s four tiles', a.archetypes.length === 4);
    t.ok('rain’s splash capacity is V2’s 2000 × 4', a.capacity === 8000);
    t.ok('rain splashes smear with wind (§4.1)', a.smearWithWind === true);
    for (const arch of a.archetypes) {
      t.ok(`${arch.id}: life is a real interval`, arch.lifeSecMax > arch.lifeSecMin && arch.lifeSecMin > 0);
      t.ok(`${arch.id}: size is a real interval`, arch.sizePxMax >= arch.sizePxMin && arch.sizePxMin > 0);
      // ⚠️ A PEAK ABOVE 1 WOULD BE A SECOND OPACITY AUTHORITY. The ground
      // boost (V2's 2.75×) is a runtime DIAL applied on top; folding it into
      // the row would make these numbers stop being V2's harvested peaks and
      // nobody could tell which reading a future edit was changing.
      t.ok(`${arch.id}: peak alpha stays a fraction`, arch.peakAlpha > 0 && arch.peakAlpha <= 1);
      t.ok(`${arch.id}: the ring sits inside the quad`, arch.ringR > 0 && arch.ringR < 1);
      t.ok(
        `${arch.id}: shape knobs are normalised`,
        arch.roughen01 >= 0 && arch.roughen01 <= 1 && arch.disc01 >= 0 && arch.disc01 <= 1
      );
      t.ok(`${arch.id}: spikes is a positive frequency`, arch.spikes > 0);
    }
    // ⚠️ THE FOUR MUST ACTUALLY DIFFER. Four rows carrying one look is the
    // failure this table exists to avoid, and it is invisible to every
    // per-row check above (`feedback_sibling_ranks_need_mutual_comparison`).
    const shapeKeys = new Set(a.archetypes.map((x) => `${x.ringR}|${x.ringW}|${x.roughen01}|${x.disc01}`));
    t.ok('the four archetypes are four DIFFERENT shapes', shapeKeys.size === 4);
    t.ok('exactly one archetype is the filled inner puddle', a.archetypes.filter((x) => x.disc01 >= 0.9).length === 1);

    // ⭐ THE WINDOW MATH `precip-splash-runtime.js#archetypeIndex` runs, pinned
    // in Node because the shader copy is browser-only. At the shipped centre
    // and spread every archetype must be reachable — a window that silently
    // excluded a tile would be a 25% population loss nobody could see.
    const reached = new Set();
    for (let k = 0; k < 400; k++) {
      const h = (k + 0.5) / 400;
      const tPick = Math.min(0.9999, Math.max(0, a.splashArchetype01 + (h - 0.5) * a.archetypeSpread));
      reached.add(Math.floor(tPick * 4));
    }
    t.ok('all four tiles are reachable at the shipped centre/spread', reached.size === 4);
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
    t.ok('isBuiltSpecies agrees', isBuiltSpecies('rain') === true && isBuiltSpecies('nonesuch') === false);

    /**
     * ⭐ THE SCHEDULE IS NOW EMPTY, AND THAT IS THE ASSERTION.
     *
     * These lines used to resolve `hail`, then `sand`, and were retargeted each
     * time that species got built — P5 and then P6. There is nothing left to
     * point at: every id §2.2 names is a real row.
     *
     * ⚠️ SO THE TEST CHANGES SHAPE RATHER THAN CHASING A SUBJECT. What matters
     * now is that the closed list COVERS the design and that the map is empty
     * BY BEING EMPTY rather than by having been deleted — the
     * designed-but-unbuilt branch stays live for the next species anyone
     * designs, and its emptiness is a measurement, not an absence
     * (`feedback_absent_zone_row_is_a_measurement`).
     */
    t.ok(
      'the planned schedule is empty — every designed species is built',
      Object.keys(PRECIP_SPECIES_PLANNED).length === 0
    );
    t.ok(
      '⭐ the closed list covers every species §2.2 names',
      ['rain', 'snow', 'sleet', 'hail', 'ash', 'sand', 'spore', 'petal', 'mote'].every(
        (id) => isBuiltSpecies(id) || id === 'sleet'
      )
    );

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
      [resolveSpecies('nonesuch'), resolveSpecies('drizzle'), resolveSpecies('ran'), resolveSpecies(undefined)].every(
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

  // ---- 🔒 precipTierScaleForProfile — wired 2026-08-29 -----------------------
  // `resolveSpeciesFrame`'s own `tierScale` parameter (tested above) has always
  // multiplied into `liveCount`; this is the producer that used to be hardcoded
  // to `1` at its one caller (`vt-pan-viewer.js#getPrecipRenderState`) — see
  // docs/planning/Effect-Tier-Gradient-Audit-2026-08-29.md §3.4.
  {
    t.ok('standard (the DEFAULT profile) is untouched — exactly 1', precipTierScaleForProfile('standard') === 1);
    t.ok(
      'quality and extreme are ALSO exactly 1 — this is a downward-only budget lever, never an upscale',
      precipTierScaleForProfile('quality') === 1 && precipTierScaleForProfile('extreme') === 1
    );
    t.ok('performance is reduced, but less than low', precipTierScaleForProfile('performance') === 0.7);
    t.ok('low is the most reduced', precipTierScaleForProfile('low') === 0.4);
    t.ok(
      'the ladder never goes DOWN as the profile goes up',
      ['low', 'performance', 'standard', 'quality', 'extreme'].every(
        (p, i, arr) => i === 0 || precipTierScaleForProfile(p) >= precipTierScaleForProfile(arr[i - 1])
      )
    );
    t.ok(
      'an unknown profile falls back to the default rank (standard) — total, never a throw',
      precipTierScaleForProfile('ludicrous') === 1
    );
    t.ok(
      'feeding this straight into resolveSpeciesFrame genuinely reduces liveCount at low, and not at standard',
      resolveSpeciesFrame(PRECIP_SPECIES.rain, { precip01: 1 }, precipTierScaleForProfile('low')).liveCount <
        PRECIP_SPECIES.rain.capacity &&
        resolveSpeciesFrame(PRECIP_SPECIES.rain, { precip01: 1 }, precipTierScaleForProfile('standard')).liveCount ===
          PRECIP_SPECIES.rain.capacity
    );
  }
}
