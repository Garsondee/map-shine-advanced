/**
 * THE SPECIES TABLE — what the sky can send, as data (Precipitation.md §2).
 *
 * ============================================================================
 * LAW 1 — ONE ENGINE, SPECIES AS DATA
 * ============================================================================
 *
 * Every falling thing is a ROW here, consumed by ONE runtime
 * (`effects/particles/precip-runtime.js`). Adding graupel, blossom or glowing
 * rain is a row, never a class. The corpse this law is carved on is V2's
 * 11,777-line `WeatherParticles` god-class with 355 private fields
 * (`legacy/particles/WeatherParticles.js`) — and §2.4's extensibility proof is
 * this table's own regression test: if a new species ever needs CODE, the
 * schema failed.
 *
 * ⚠️ P1 SHIPS TWO ROWS: `rain` and `snow`. That is not the whole closed list
 * (§2.2 names nine), and the omissions are deliberate rather than partial:
 *
 *   - `drizzle` is **not a species and never will be** — it is `rain` at low
 *     `precip01`, thinned/shortened/slowed by the response curves below. One
 *     species, one continuum. A `drizzle` row would be the same bug as a
 *     `heavy-rain` row.
 *   - `sleet` is likewise **a blend, not a row** — the temperature band yields
 *     a mix weight and the kernel splits the population per-particle by seed
 *     (P5).
 *   - `hail`/`ash`/`sand`/`spore`/`petal`/`mote` are real future rows, each
 *     waiting on machinery P1 does not build (the bounce phase machine, the
 *     dust mantle channel, the impression curtain).
 *
 * ============================================================================
 * ⚠️ WHAT A P1 ROW DELIBERATELY DOES NOT CARRY
 * ============================================================================
 *
 * §2.1's full schema has `arrive` (splash/bounce/settle) and `stay` (the
 * mantle channel). Neither was here in P1, because `feedback_unconsumed_api_
 * rots_silently` is a named disease in this project and a weather system is its
 * natural host. `world/weather.js`'s own axis table solved the identical
 * problem the same way — slice 1 shipped four cloud axes, not all eleven, and
 * every row carries a machine-readable `consumerStatus`.
 *
 * ⭐ **`arrive` LANDED WITH P2** (2026-08-16), in the same commit as
 * `effects/particles/precip-splash-runtime.js` — the discipline working as
 * designed rather than an exception to it. `stay` is still absent and P3 adds
 * it with the mantle. So are `bounces` (P5), `restSec` (P3) and `waterRing`
 * (§4.2's water-hit splashes): the block that exists carries EXACTLY the
 * fields something reads today. A reviewer can tell what is real by whether
 * the field exists at all, which is a stronger signal than a comment nobody
 * reads — and the regression test asserts that boundary in both directions.
 *
 * ============================================================================
 * THE NUMBERS ARE V2's, AND THAT IS THE POINT
 * ============================================================================
 *
 * Precipitation.md §10's harvest ledger — the author's own tuned taste, from
 * the shipped V2 build, re-authored as data and never imported
 * (`feedback_port_faithfully_then_modernize_opportunistically`). Each row
 * below cites the `WeatherParticles.js` line it came from. Where a number was
 * changed, the change is argued in place rather than silently applied.
 *
 * @module effects/precipitation/precip-species
 */

/**
 * The closed list of species ids that P1 actually ships. Validated on every
 * lookup — an unknown id resolves to NO PRECIPITATION with a loud reason
 * rather than to a default that silently rains
 * (`feedback_category_string_must_be_in_closed_list` +
 * `feedback_gate_polarity_must_fail_open`: a broken table must never
 * storm-lock a scene, and it must never be silent either).
 */
export const PRECIP_SPECIES_IDS = Object.freeze(['rain', 'snow']);

/**
 * Species ids named by `Precipitation.md` §2.2 that are NOT built yet, and the
 * slice that owns each. Exported so a caller handed a legitimate-but-future id
 * gets a reason that says *"P6 builds this"* rather than *"unknown species"* —
 * two genuinely different failures, and telling them apart is the difference
 * between a typo and a schedule (`feedback_absent_zone_row_is_a_measurement`).
 *
 * `drizzle`/`sleet` are absent from this map ON PURPOSE — they are operating
 * points and blends, not future rows. See this module's header.
 */
export const PRECIP_SPECIES_PLANNED = Object.freeze({
  hail: 'P5 — needs the bounce phase machine',
  ash: 'P6 — needs the dust mantle channel + ember companion population',
  sand: 'P6 — mostly the impression curtain (P4), not a specimen row',
  spore: 'P6 — the magical shelf',
  petal: 'P6 — the magical shelf',
  mote: 'P6 — the generic magical carrier',
});

/**
 * How a response curve maps `precip01` (or any 0..1 axis) onto a species
 * parameter. Data, not a closure: a frozen row holding functions cannot be
 * validated, serialized, or diffed, and this table's whole claim is that a
 * species is DATA.
 *
 * - `pow` — `out = lerp(from, to, x^exp)`. `exp > 1` starts slow (drizzle is
 *   SPARSE before it is short); `exp < 1` starts fast.
 * - `linear` — `pow` with `exp: 1`, spelled out because most rows want it and
 *   `{kind:'pow', exp:1}` reads like an accident.
 * - `threshold` — 0 below `at`, then ramps to `to` across `[at, 1]`. The
 *   veil's shape: a downpour greys the air, drizzle does not.
 *
 * @param {{kind: string, from?: number, to?: number, exp?: number, at?: number}} curve
 * @param {number} x01
 * @returns {number}
 */
export function evalCurve(curve, x01) {
  const x = Number.isFinite(x01) ? Math.min(1, Math.max(0, x01)) : 0;
  if (!curve || typeof curve !== 'object') return 0;
  const from = Number.isFinite(curve.from) ? curve.from : 0;
  const to = Number.isFinite(curve.to) ? curve.to : 1;
  switch (curve.kind) {
    case 'linear':
      return from + (to - from) * x;
    case 'pow': {
      const exp = Number.isFinite(curve.exp) && curve.exp > 0 ? curve.exp : 1;
      return from + (to - from) * Math.pow(x, exp);
    }
    case 'threshold': {
      const at = Number.isFinite(curve.at) ? curve.at : 0.5;
      if (x <= at) return from;
      // Guard the degenerate at=1 case: a threshold at the very top of the
      // range has zero width to ramp across, so it is a step, not a divide.
      const span = 1 - at;
      if (!(span > 0)) return to;
      return from + (to - from) * ((x - at) / span);
    }
    default:
      // An unknown curve kind yields the FLOOR, never the ceiling — the same
      // fail-open polarity the species lookup uses. A malformed curve must
      // make less weather, never a silent downpour.
      return from;
  }
}

/**
 * THE TABLE.
 *
 * ⚠️ Speeds/sizes are WORLD PIXELS, matching every other length in this
 * engine (`cloudAltitudePx`, `cloudScalePx`, the wind field's px/s). V2's
 * numbers were already in this unit — it ran the same 100px-per-grid-square
 * convention — so the harvest is a transcription, not a conversion.
 */
export const PRECIP_SPECIES = Object.freeze({
  rain: Object.freeze({
    id: 'rain',
    label: 'Rain',
    phase: 'liquid',

    fall: Object.freeze({
      /** V2 `:4994-5017` — 1400..5200 px/s. The spread IS the look: a uniform
       * fall speed reads as a moving texture rather than as weather. */
      speedPxS: Object.freeze([1400, 5200]),
      /** Rain leans with the wind but is not carried by it — it has mass.
       * (Hail will be ~0.1, spore ~1.0; this is the middle of that scale.) */
      windCarry01: 0.45,
      /** Rain does not flutter — it falls. The dual-frequency lateral chaos
       * V2 gave it (`:1450-1505`) is TURBULENCE, applied in the kernel, not
       * the paper-fall sway that snow and ash have. Two different phenomena;
       * conflating them would make rain wobble like a leaf. */
      flutter: null,
      spin: null,
      /** The M(h) parallax budget — how high a drop is born. Large, because
       * the collapse from ~4.5× magnification down to 1× as it falls IS the
       * "rain is coming down AT the map" read (§3.2). */
      spawnHeightPx: 780,
      /** V2's per-drop gravity multiplier `:1450` — 0.72..1.48. Applied on
       * top of `speedPxS` so two drops of the same base speed still separate
       * over their lives. */
      gravityMul: Object.freeze([0.72, 1.48]),
    }),

    body: Object.freeze({
      /** A velocity-stretched streak: the quad elongates along the direction
       * of travel. V2's `speedFactor = 0.0065 × 0.25` (`:5017`) is carried in
       * `streakPerPxS` below. */
      mode: 'streak',
      /** V2 `:4994` — 0.65..3.6 px WIDE. A streak's LENGTH comes from speed. */
      sizePx: Object.freeze([0.65, 3.6]),
      /**
       * World px of streak length per (px/s) of speed. This one number is what
       * makes fast drops read as lines and slow ones as dots, for free.
       *
       * ⚠️ MEASURED IN THE SHADER LAB, NOT TRANSCRIBED — and the first value
       * was wrong. Precipitation.md §10's harvest ledger records V2's rain
       * billboard as `speedFactor = 0.0065×0.25`, which this table first read
       * as a product (0.001625). `bench-precip` measured what that actually
       * draws: streaks of **1.2–8.2 SCREEN px** at a normal zoom, 0.33–1.84 px
       * wide — a starfield of specks, not rain. The two factors were evidently
       * not both stretch.
       *
       * Sweeping `streakScale` (the runtime's dial, added for exactly this)
       * found the answer at ×4 of the product, i.e. **0.0065 — V2's
       * `speedFactor` alone**. At true 1:1 zoom that renders 7–55 px streaks,
       * which is rain. The number is V2's own after all; the multiplication
       * was mine, and the lab is what caught it rather than a live session.
       */
      streakPerPxS: 0.0065,
      /** V2 `:5002` — the cool ramp, head to tail. Head is near-white, tail
       * fades to a desaturated blue. Linear-space RGB + alpha. */
      headRgba: Object.freeze([0.96, 0.98, 1.0, 1.0]),
      tailRgba: Object.freeze([0.48, 0.6, 0.88, 0.38]),
      /** V2 `:1466` — `pow(rand, 0.72)`. A mid-tone skew with rare bright
       * glints, NOT a uniform distribution. This one exponent is most of why
       * V2's rain read as a real curtain instead of a screen of equal dots. */
      brightnessSkewExp: 0.72,
      emissive01: 0,
      /** Rain is a hard-edged streak; softness is for flakes. */
      softness01: 0.15,
    }),

    /** §2.3 — one axis, many operating points. This is where "a day of
     * drizzle" and "rain lashing the ground" become the same species. */
    respond: Object.freeze({
      /** ⚠️ QUADRATIC, and this is the single most important curve in the
       * table: drizzle must be SPARSE before it is short. A linear count makes
       * low precip read as "weak rain everywhere" instead of "a few drops". */
      count: Object.freeze({ kind: 'pow', exp: 2, from: 0, to: 1 }),
      /** Heavy rain falls HARDER, not merely thicker — length and speed both
       * rise, so the curtain gains energy rather than just density. */
      length: Object.freeze({ kind: 'linear', from: 0.55, to: 1.25 }),
      speed: Object.freeze({ kind: 'linear', from: 0.7, to: 1.15 }),
      /** The impression tier's weight (P4 consumes this). Zero until ~0.5:
       * a downpour greys the air; drizzle does not. */
      veil: Object.freeze({ kind: 'threshold', at: 0.5, from: 0, to: 1 }),
    }),

    /** §3.5 — V2's proven scalar lighting (`:104-113`), harvested exactly.
     * Bodies are UNLIT sprites modulated by these; the luxury rung (sampling
     * `buf:scene.illum` per body) is P7, recorded as a rung so it stays a
     * decision rather than a drift. */
    light: Object.freeze({
      dayAlphaMul: 1.62,
      dayRgbMul: 0.5,
      nightAlphaMul: 0.34,
      nightRgbMul: 0.24,
      /** ⭐ The detail that sold every V2 storm: one frame of the whole sky's
       * rain lighting up. Rides the `sky-flash` event envelope when slice
       * 4's events grow a consumer for it. */
      flashAlphaMul: 6,
      flashRgbMul: 4,
    }),

    /**
     * ⭐ THE ARRIVAL (P2) — Precipitation.md §4.1.
     *
     * ⚠️ THIS BLOCK APPEARED IN THE COMMIT THAT BUILT ITS CONSUMER, which is
     * this module's own stated policy (see the header): a reviewer can tell
     * what is real by whether the field EXISTS. §2.1's schema also lists
     * `bounces` (hail, P5), `restSec` (P3's settle) and `waterRing` (§4.2's
     * water-hit splashes) — all three are still absent for the same reason,
     * and adding them "for completeness" is exactly the
     * `feedback_unconsumed_api_rots_silently` disease this discipline exists
     * to prevent.
     */
    arrive: Object.freeze({
      /** The discriminator `precip-splash-runtime.js` builds against. Snow
       * settles, hail bounces; neither is a weak splash. */
      kind: 'splash',
      /**
       * §2.1: *"which of the four V2 splash looks dominates"* — a position on
       * the archetype axis, not a hard pick. `0.5` with the default spread
       * gives all four in equal quarters, which is V2's own behaviour: its
       * four systems shipped near-identical intensity scales (8.45 / 8.7 /
       * 9.1 / 9.25, `legacy/core/WeatherController.js:356-385`).
       */
      splashArchetype01: 0.5,
      /** Width of the window `splashArchetype01` centres. 1 = the whole table. */
      archetypeSpread: 1,
      /** ⭐ §4.1 — *"lashing against the ground is precisely an impact that
       * cannot stay round"*. The quad elongates along the wind vector. */
      smearWithWind: true,
      /** V2 ran `maxParticles: 2000` on each of four splash systems. A CEILING,
       * not a population — see `splashesPerMegapixel`. */
      capacity: 8000,
      /**
       * ⭐ HOW MANY SPLASHES ARE ALIVE PER MEGAPIXEL OF VIEW, at full precip.
       * THE RATE LIVES HERE, and it is per-AREA rather than a flat count.
       *
       * ⚠️ THE FIRST CUT DERIVED THE POPULATION FROM THE CAPACITY
       * (`liveCount = capacity × countFrac`) AND IT WAS A FOAM BATH — 2,430
       * overlapping splashes across a 2000×1500 view, measured at 71% of the
       * frame lit. The mistake is worth naming because it is not a tuning
       * error: **a cap is a ceiling, not a population**. V2's own numbers say
       * so out loud — `maxParticles: 2000` per tile with
       * `emissionOverTime = 200 × intensity × …`, i.e. the count was always
       * `rate × life`, and the cap only ever bit under LOD collapse.
       *
       * ⚠️ AND IT MUST BE PER-AREA, because a splash is SCENERY. The falling
       * curtain keeps a constant SCREEN density (it is an atmospheric layer
       * between the eye and the map, so `uViewScale` holds its apparent pace).
       * Water on flagstones is the opposite: its density belongs to the
       * GROUND, so zooming out must reveal more splashes over more stone, not
       * spread the same few thinner. A flat count would make a zoom look like
       * a change in the weather.
       *
       * Tuned in `bench-precip` against the four archetypes' own sizes; the
       * capacity above still caps it, so a very wide view degrades by thinning
       * rather than by allocating.
       */
      splashesPerMegapixel: 42,
      /**
       * ⭐ V2's FOUR HAND-TUNED TILES, transcribed — the `id` of each is V2's
       * own comment for that tile, verbatim, because the names are the tuning
       * record: *"thin clean ring"* tells you what 0.09 ring width means in a
       * way the number cannot.
       *
       * ⚠️ THE LIFE AND SIZE COLUMNS ARE V2's; THE SHAPE COLUMNS ARE NEW. V2
       * drew these from a 2×2 sprite atlas, so there is no harvested number
       * for "how thick is the rim" — the atlas WAS that number. The five shape
       * knobs re-author the same four looks as a continuum
       * (`precip-splash-runtime.js` explains the space); they are the one part
       * of this row that is authored rather than harvested, and they are
       * marked as such so nobody cites them as V2's taste later.
       */
      archetypes: Object.freeze([
        Object.freeze({
          id: 'thin-clean-ring',
          lifeSecMin: 0.2,
          lifeSecMax: 0.35,
          sizePxMin: 8,
          sizePxMax: 16,
          peakAlpha: 0.14,
          ringR: 0.78,
          ringW: 0.09,
          roughen01: 0.05,
          disc01: 0,
          spikes: 7,
        }),
        Object.freeze({
          id: 'thick-broken-ring',
          lifeSecMin: 0.09,
          lifeSecMax: 0.22,
          sizePxMin: 2,
          sizePxMax: 3,
          peakAlpha: 0.14,
          ringR: 0.66,
          ringW: 0.26,
          roughen01: 0.7,
          disc01: 0.12,
          spikes: 9,
        }),
        Object.freeze({
          id: 'droplets',
          lifeSecMin: 0.2,
          lifeSecMax: 0.79,
          sizePxMin: 6,
          sizePxMax: 27,
          peakAlpha: 0.33,
          ringR: 0.74,
          ringW: 0.13,
          roughen01: 1,
          disc01: 0,
          spikes: 6,
        }),
        Object.freeze({
          id: 'inner-puddle',
          lifeSecMin: 0.305,
          lifeSecMax: 1.4,
          sizePxMin: 10,
          sizePxMax: 24,
          peakAlpha: 0.08,
          ringR: 0.62,
          ringW: 0.2,
          roughen01: 0.1,
          disc01: 1,
          spikes: 5,
        }),
      ]),
    }),

    /** Capacity at max tier. V2 shipped `maxParticles: 15000` for rain and it
     * looked right; the arena reserves this once and `liveCount` does the
     * tiering (Particles.md §10 — tier changes are then free). */
    capacity: 15000,
    /** Below this many screen px per body, the specimen tier SLEEPS and the
     * curtain (P4) carries the picture alone — a JS `if`, never a uniform set
     * to zero (Effects.md Law 4). Rain streaks stay legible small, so this
     * sits low. */
    zoomSleepPxPerBody: 0.6,
  }),

  snow: Object.freeze({
    id: 'snow',
    label: 'Snow',
    phase: 'solid',

    fall: Object.freeze({
      /** V2's snow class — roughly 40..115 px/s. Two orders of magnitude
       * slower than rain, which is why the same runtime reads as a completely
       * different weather with no new code. */
      speedPxS: Object.freeze([40, 115]),
      /** Flakes are nearly wind-borne — a gust genuinely carries them
       * sideways, where rain merely leans. */
      windCarry01: 0.85,
      /** ⭐ THE PAPER-FALL SWAY. V2 `:1556-1663` — 0.5..1.0 Hz, 40..100 px
       * amplitude. This is the whole character of snow: without it flakes
       * fall like slow rain, which reads as ash. */
      flutter: Object.freeze({ hzMin: 0.5, hzMax: 1.0, ampPxMin: 40, ampPxMax: 100 }),
      /** V2 `:1556-1663` — 1.2..2.4 rad/s in BOTH directions, scaled by wind
       * (calm ×0.4 → storm ×3). */
      spin: Object.freeze({ radSMin: 1.2, radSMax: 2.4, windScaleCalm: 0.4, windScaleStorm: 3 }),
      /** Taller than rain's, and slower fall — the lazy vertical drift of
       * flakes IS a long M-decay (§3.2). */
      spawnHeightPx: 900,
      gravityMul: Object.freeze([0.8, 1.25]),
    }),

    body: Object.freeze({
      mode: 'flake',
      sizePx: Object.freeze([2.2, 6.5]),
      /**
       * ⚠️ NO LONGER ZERO, AND THE ZERO WAS THE BUG THE AUTHOR REPORTED
       * (*"snow isn't yet affected by wind"*).
       *
       * A flake tumbles rather than streaking, so this began at 0 — "the quad
       * stays square no matter how hard the wind blows it sideways." That is
       * true of a flake at REST and wrong for a flake being driven: it also
       * removed the only visual signature wind has on snow. Flakes DID drift
       * correctly the whole time (the kernel's wind term is species-scaled and
       * snow's `windCarry01` is the highest in the table) — but a round dot
       * moving sideways looks identical to a round dot standing still, and
       * because bodies respawn uniformly the population's DENSITY never shifts
       * either. Correct motion, invisible.
       *
       * Small and deliberately far below rain's 0.0065: at snow's own fall
       * speed this is a fraction of a pixel and a flake still reads as round,
       * but as wind drives its apparent speed up the quad smears along the way
       * it is going — which is both what a wind-blown flake actually looks
       * like and the cue that was missing.
       */
      streakPerPxS: 0.0016,
      headRgba: Object.freeze([1.0, 1.0, 1.0, 0.95]),
      tailRgba: Object.freeze([0.86, 0.9, 0.98, 0.75]),
      brightnessSkewExp: 0.85,
      emissive01: 0,
      /** Soft-edged — a flake is a blurred dot, not a hard pellet (that is
       * hail, P5). */
      softness01: 0.8,
    }),

    respond: Object.freeze({
      /** ⚠️ LINEAR, deliberately UNLIKE rain's quadratic (§2.3). Light snow
       * is genuinely a thin, even scatter — the sparse-then-dense shape that
       * makes drizzle read correctly makes light snow read as broken. */
      count: Object.freeze({ kind: 'linear', from: 0, to: 1 }),
      length: Object.freeze({ kind: 'linear', from: 1, to: 1 }),
      speed: Object.freeze({ kind: 'linear', from: 0.85, to: 1.1 }),
      veil: Object.freeze({ kind: 'threshold', at: 0.45, from: 0, to: 1 }),
    }),

    /** ⚠️ SNOW'S FLUTTER FALLS AS THE STORM RISES (§2.3) — blizzard snow
     * TRAVELS, it does not waltz. The one response curve keyed to
     * `stormActivity01` rather than `precip01`, and it is inverted; naming it
     * separately is what stops a future reader assuming every curve in this
     * table reads the same axis (`feedback_one_input_two_extractions_two_thresholds`). */
    respondStorm: Object.freeze({
      flutter: Object.freeze({ kind: 'linear', from: 1, to: 0.15 }),
    }),

    light: Object.freeze({
      dayAlphaMul: 1.62,
      dayRgbMul: 0.5,
      nightAlphaMul: 0.34,
      nightRgbMul: 0.24,
      flashAlphaMul: 6,
      flashRgbMul: 4,
    }),

    /**
     * ⭐ SNOW ARRIVES BY **SETTLING**, AND THAT IS THE WHOLE BLOCK.
     *
     * ⚠️ A SETTLE IS NOT A WEAK SPLASH. The splash engine's discriminator is
     * `arrive.kind`, not *"does this row have an arrive block"* — testing for
     * the block's existence would have made snow throw water. Snow's real
     * arrival (rest a few seconds as a body, then hand off to the mantle,
     * §2.2) is P3's, and the fields that describe it (`restSec`, the mantle
     * channel) land in the commit that builds it. What exists today is the one
     * fact P2 genuinely consumes: snow does not splash.
     */
    arrive: Object.freeze({
      kind: 'settle',
      smearWithWind: false,
    }),

    capacity: 20000,
    /** Flakes are bigger than streaks are wide, so snow stays legible further
     * out than rain and sleeps LATER. */
    zoomSleepPxPerBody: 1.2,
  }),
});

/**
 * Resolve a species id. Fails OPEN to *no precipitation* with a reason — the
 * same shape `resolveArchetype`/`resolveBiome`/`resolveEventKind` use one zone
 * over, so every table in this system refuses a bad id identically.
 *
 * ⚠️ THE FALLBACK IS `null`, NOT `rain`. A weather table that cannot identify
 * what is falling must produce a CLEAR SKY, never a default downpour: the
 * failure has to be visible-by-absence and reported, not disguised as
 * plausible weather (`feedback_gate_polarity_must_fail_open` — fail open means
 * *the effect stops*, and here "off" is the safe direction).
 *
 * @param {string} id
 * @returns {Readonly<{ok: boolean, species: object|null, reason: string|null}>}
 */
export function resolveSpecies(id) {
  if (Object.hasOwn(PRECIP_SPECIES, id)) {
    return Object.freeze({ ok: true, species: PRECIP_SPECIES[id], reason: null });
  }
  if (Object.hasOwn(PRECIP_SPECIES_PLANNED, id)) {
    return Object.freeze({
      ok: false,
      species: null,
      reason: `species '${id}' is designed but not built — ${PRECIP_SPECIES_PLANNED[id]}`,
    });
  }
  if (id === 'drizzle' || id === 'sleet') {
    return Object.freeze({
      ok: false,
      species: null,
      reason: `'${id}' is not a species — it is ${id === 'drizzle' ? 'rain at low precip01' : 'a rain/snow blend across the temperature band'} (Precipitation.md §2.2)`,
    });
  }
  return Object.freeze({ ok: false, species: null, reason: `unknown precipitation species '${id}'` });
}

/** @param {string} id @returns {boolean} */
export function isBuiltSpecies(id) {
  return Object.hasOwn(PRECIP_SPECIES, id);
}

/**
 * Everything the runtime needs for one frame of one species, derived from the
 * weather axes. PURE — no THREE, no GPU, no clock — so the whole response
 * model is a Node test long before a pixel is drawn, and the shader lab can
 * throw values at it without a renderer.
 *
 * ⚠️ RETURNS `liveCount`, NOT A CAPACITY CHANGE. The arena reserves max-tier
 * capacity once and never resizes; tiering is a draw-time count
 * (Particles.md §10). A caller that "optimises" this into a re-reservation
 * reintroduces the allocation churn the arena exists to abolish.
 *
 * @param {object} species - a row from {@link PRECIP_SPECIES}.
 * @param {object} axes
 * @param {number} axes.precip01
 * @param {number} [axes.stormActivity01]
 * @param {number} [axes.dayFactor01] - 1 = full day, 0 = full night. Blends
 *   the day/night scalar pair rather than switching at a threshold, so dusk
 *   is a ramp and not a pop.
 * @param {number} [axes.flash01] - the sky-flash envelope, 0..1.
 * @param {number} [tierScale=1] - the effect cascade's own budget multiplier.
 * @returns {Readonly<object>}
 */
export function resolveSpeciesFrame(species, axes, tierScale = 1) {
  const precip01 = clamp01(axes?.precip01);
  const storm01 = clamp01(axes?.stormActivity01);
  const day01 = Number.isFinite(axes?.dayFactor01) ? clamp01(axes.dayFactor01) : 1;
  const flash01 = clamp01(axes?.flash01);
  const scale = Number.isFinite(tierScale) && tierScale > 0 ? Math.min(1, tierScale) : 1;

  const countFrac = evalCurve(species.respond.count, precip01);
  const liveCount = Math.round(species.capacity * countFrac * scale);

  const L = species.light;
  // Day/night is a LERP, not a branch — see `dayFactor01` above.
  const alphaMul = L.nightAlphaMul + (L.dayAlphaMul - L.nightAlphaMul) * day01;
  const rgbMul = L.nightRgbMul + (L.dayRgbMul - L.nightRgbMul) * day01;

  return Object.freeze({
    /** How many slots the DRAW should show. Zero is a legitimate, common
     * answer (a clear day) and the caller must skip the draw entirely rather
     * than submit a zero-count one — Effects.md Law 4. */
    liveCount,
    /** Multiplier on streak length (rain) — 1.0 means "exactly V2's number". */
    lengthMul: evalCurve(species.respond.length, precip01),
    /** Multiplier on fall speed. */
    speedMul: evalCurve(species.respond.speed, precip01),
    /** The impression tier's weight (P4's consumer; carried now because it is
     * derived from the same curve set and splitting the derivation across two
     * slices is how the two drift apart). */
    veil01: evalCurve(species.respond.veil, precip01),
    /** Snow only — 1 at calm, →0.15 in a blizzard. `1` for species with no
     * storm response, so the kernel multiplies unconditionally. */
    flutterMul: species.respondStorm?.flutter ? evalCurve(species.respondStorm.flutter, storm01) : 1,
    /** V2's scalar lighting, day/night-blended and flash-boosted. The flash
     * is a LERP toward the boosted value, so a half-strength flash is half a
     * flash rather than an on/off. */
    alphaMul: alphaMul + (alphaMul * L.flashAlphaMul - alphaMul) * flash01,
    rgbMul: rgbMul + (rgbMul * L.flashRgbMul - rgbMul) * flash01,
  });
}

/** @param {*} v @returns {number} */
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * ⭐ THE DIRECTION PRECIPITATION IS DRIVEN, from the wind field's
 * `directionDeg` — the CPU twin of `precip-runtime.js#windToward`.
 *
 * ⚠️ IT EXISTS SO THE MAPPING IS TESTABLE. The shader version is browser-only
 * TSL, so a compass error in it can only be caught by a human looking at a
 * live map — which is exactly how this one was found, twice, after being wrong
 * in two different ways (a missing rotation, then a negation that fixed 180°
 * of a 90° error). Node can now pin all four cardinals.
 *
 * Y-DOWN world space: +X is EAST, +Y is SOUTH (the camera is flipped,
 * `top = minY`). Keep this in lockstep with the shader helper — they are one
 * rule with two implementations, which is a debt this pays down only by being
 * asserted against.
 *
 * @param {number} directionDeg
 * @returns {{x: number, y: number}} unit vector precipitation travels along.
 */
export function windTowardVector(directionDeg) {
  const r = ((Number(directionDeg) || 0) * Math.PI) / 180;
  return { x: -Math.sin(r), y: Math.cos(r) };
}
