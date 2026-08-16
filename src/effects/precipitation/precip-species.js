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
import { SNOW_RATE_PER_HOUR, PUDDLE_RATE_PER_HOUR } from './mantle-model.js';

export const PRECIP_SPECIES_IDS = Object.freeze(['rain', 'snow', 'hail', 'ash', 'sand', 'spore', 'petal', 'mote']);

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
  /**
   * ⭐ EMPTY, AS OF P6 (2026-08-16) — every id §2.2 names is now a real row.
   *
   * ⚠️ THE MAP STAYS, and emptying it rather than deleting it is the point. It
   * is what distinguishes *"unknown species"* from *"designed, scheduled, not
   * built yet"*, and the next species anyone designs needs that distinction on
   * its first day (`feedback_absent_zone_row_is_a_measurement`). An empty
   * schedule is a state worth being able to express.
   */
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
      /**
       * A per-drop nudge on top of `speedPxS`, so two drops of the same base
       * speed still separate over their lives.
       *
       * ⚠️ **NARROWED FROM V2's 0.72..1.48 AFTER A LIVE REPORT**, and the
       * reason is compounding rather than taste. Author: *"some raindrops seem
       * to fall a lot slower than other raindrops, unrealistically slow."*
       * `speedPxS` is already a 3.7× range (1400..5200); multiplying a second
       * 2.06× range on top of it produced a **7.6× spread**, with the slowest
       * drops at ~1,000 px/s — below V2's own floor, which the range was
       * supposedly reproducing.
       *
       * That is the `0.0065 × 0.25` transcription trap again (memory:
       * keyhole-precipitation-p1-built BUG 1): two harvested numbers stacked
       * because both were written down, when only one of them was the spread.
       * `speedPxS` is the authority on how fast rain falls; this is variety
       * ON TOP of it, so it is now ±10%.
       */
      gravityMul: Object.freeze([0.9, 1.1]),
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
      /**
       * ⭐ §4.1 — *"lashing against the ground is precisely an impact that
       * cannot stay round"*.
       *
       * ⚠️ "CANNOT STAY ROUND" MEANS ASYMMETRIC, NOT ELONGATED. The first
       * implementation read it as an affine stretch along the wind and the
       * author rejected it on sight: *"weirdly elongated — remember the top
       * down perspective."* From directly above a splash is a STATIONARY
       * impact, so stretching it along a direction of travel is motion blur for
       * something that never moved. Wind instead throws the crown DOWNWIND —
       * off-centre, brighter on that rim, barely wider. See
       * `precip-splash-runtime.js#positionNode`.
       */
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

    /**
     * ⭐ THE STAY (P3) — Precipitation.md §5.
     *
     * ⚠️ RAIN FEEDS **NO MANTLE CHANNEL**, and `channel: null` is a real
     * answer rather than a missing one. §2.2's own Stay column for rain reads
     * *"none (drives the scalar `wetness01` integrator + puddles)"* — rain
     * leaves standing water, not a blanket. Giving it a channel would make a
     * downpour deposit a substance, which is the shape of the bug where every
     * species must feed something.
     */
    stay: Object.freeze({
      channel: null,
      /** No blanket accumulates, so the blanket rate is zero and says so. */
      ratePerHour: 0,
      /** …but water POOLS — the `puddle01` channel, filled at this rate at
       * `precip01 = 1`. Read off the row rather than assumed from the id, so
       * sleet and hail can pool at their own rates later without a branch
       * appearing in the model. */
      puddleRatePerHour: PUDDLE_RATE_PER_HOUR,
      meltBy: Object.freeze({ temperature: false, fire: false }),
      surface: Object.freeze({
        /** Wet stone DARKENS and SHINES; it does not tint. The multiply is
         * toward this, and the roughness drop is §5.3's filed REQUEST to the
         * specular system rather than something this row can apply itself. */
        tint: Object.freeze([0.62, 0.66, 0.72]),
        sparkle01: 0,
        roughnessDelta: -0.45,
      }),
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

  /**
   * ⭐ HAIL (P5, §4.4) — the species the ARENA was extended for.
   *
   * §4.4: *"Sparse discrete arrivals are the one place per-body continuity
   * matters: a hailstone must visibly BOUNCE."* Every other species is a
   * statistical population where no individual is followed; a hailstone is
   * followed, through `fall → bounce(×1–2) → rest → fade`, in its own slot.
   */
  hail: Object.freeze({
    id: 'hail',
    label: 'Hail',
    phase: 'solid',

    fall: Object.freeze({
      /** The fastest thing the table sends — mass beats drag. */
      speedPxS: Object.freeze([4200, 7400]),
      /**
       * ⭐ ALMOST NO TURBULENCE — author: *"hail shouldn't be turbulent in the
       * way that snow is turbulent as it has enough weight to drop much more
       * cleanly downwards, though it can be blown by the wind."* Both halves
       * are here: `chaos01` near zero kills the wander, while `windCarry01`
       * below keeps it blowable. Two different phenomena, two numbers.
       */
      chaos01: 0.08,
      /** ⭐ NEAR-BALLISTIC (§2.2's `~0.1`). A hailstone is the one thing the
       * wind barely touches, which is most of why it reads as heavy: the
       * whole sky leans and the hail comes straight down through it. */
      windCarry01: 0.1,
      flutter: null,
      spin: null,
      /** Lower than rain's: hail arrives, it does not drift in. A shorter
       * M(h) budget makes the approach fast and hard. */
      spawnHeightPx: 620,
      gravityMul: Object.freeze([0.95, 1.08]),
    }),

    body: Object.freeze({
      /** A hard pellet, not a streak and not a soft flake — `mote` takes the
       * radial falloff with the TIGHT exponent (`softness01` low). */
      mode: 'mote',
      sizePx: Object.freeze([3.4, 7.2]),
      /** Barely stretched: a stone is a stone at any speed. Not zero, so a
       * full-speed descent still reads as motion rather than as a hovering
       * dot. */
      streakPerPxS: 0.0006,
      headRgba: Object.freeze([1.0, 1.0, 1.0, 1.0]),
      tailRgba: Object.freeze([0.86, 0.9, 0.96, 0.9]),
      brightnessSkewExp: 0.6,
      emissive01: 0,
      /** HARD-edged. This is the low end of the softness scale the flake
       * branch's exponent already spans. */
      softness01: 0.12,
    }),

    respond: Object.freeze({
      /** Even sparser than drizzle at the bottom — a few stones, then many.
       * Hail does not arrive as a light even scatter. */
      count: Object.freeze({ kind: 'pow', exp: 2.4, from: 0, to: 1 }),
      length: Object.freeze({ kind: 'linear', from: 1, to: 1 }),
      speed: Object.freeze({ kind: 'linear', from: 0.9, to: 1.15 }),
      /** Hail does not grey the air — it is discrete by nature, and a veil of
       * it would be exactly the impression tier lying about what is falling. */
      veil: Object.freeze({ kind: 'threshold', at: 0.95, from: 0, to: 0.25 }),
    }),

    /** ⭐ §4.4's PHASE MACHINE, as data. The runtime reads these; the ordinals
     * themselves live in `precip-runtime.js` beside the kernel that walks
     * them. */
    bounce: Object.freeze({
      /** 1–2 visible pop-ups, per stone, chosen by its own hash. */
      countRange: Object.freeze([1, 2]),
      /** How high the first pop-up reaches, as a fraction of the spawn height.
       * Small: a bounce is a hop, not a second fall. Raised from 0.085 — it was
       * contributing a 2.7% size change, which is below the threshold of
       * anything. The SKITTER does most of the work, but the pop should at
       * least be measurable. */
      firstPeakFrac: 0.22,
      /** …and how much of that the NEXT one keeps. Damped, §4.4's "smaller
       * each time". */
      damping: 0.45,
      /** Seconds per pop-up. Fast — a slow bounce reads as a balloon. */
      popSec: 0.34,
      /**
       * ⭐ HOW FAR A STONE SKITTERS SIDEWAYS ON EACH POP-UP, px/s.
       *
       * ⚠️ THIS IS THE CUE THAT MAKES A BOUNCE VISIBLE AT ALL. A pop-up changes
       * only M(h), and at this peak against a 2,000 px camera that is under 3%
       * of size — invisible. A real stone bounces off at an ANGLE, and lateral
       * motion is the one thing a top-down camera reads perfectly.
       */
      skitterPxS: 340,
      /** ⭐ §4.4: *"a resting pellet fading over ~10 s"*. THE detail that makes
       * hail feel like an event rather than an effect: the ground is briefly
       * covered in stones that are still there when you look back. */
      restSec: 9,
      fadeSec: 1.6,
    }),

    arrive: Object.freeze({
      /** ⚠️ NOT `splash`. A hailstone bounces; it does not throw water. The
       * splash engine reads this discriminator and builds nothing. */
      kind: 'bounce',
      smearWithWind: false,
    }),

    stay: Object.freeze({
      /** §2.2: *"brief white speckle, melts fast above freezing"*. It feeds
       * the SNOW channel because a scatter of ice is what that channel
       * renders — a third channel for "ice" would be two names for one blend
       * op. */
      channel: 'snow',
      /** Far slower than snowfall: hail bounces and scatters, it does not
       * blanket. */
      ratePerHour: 0.12,
      puddleRatePerHour: 0.1,
      meltBy: Object.freeze({ temperature: true, fire: true }),
      surface: Object.freeze({
        tint: Object.freeze([0.95, 0.97, 1.0]),
        sparkle01: 0.8,
        roughnessDelta: 0.15,
      }),
    }),

    light: Object.freeze({
      dayAlphaMul: 1.62,
      dayRgbMul: 0.5,
      nightAlphaMul: 0.34,
      nightRgbMul: 0.24,
      flashAlphaMul: 6,
      flashRgbMul: 4,
    }),

    /** Far fewer bodies than rain — hail is sparse and each stone is followed
     * through four life stages, so a slot is occupied for ~12 s rather than
     * ~0.2 s. Capacity is population × dwell, and the dwell is enormous here. */
    capacity: 4000,
    /** Pellets are the biggest bodies in the table, so hail stays legible
     * furthest out. */
    zoomSleepPxPerBody: 1.6,
  }),

  /**
   * ⭐ THE EXOTIC SHELF (P6) — AND THESE FIVE ROWS ARE LAW 1's PROOF.
   *
   * §2.4 stakes the whole design on a claim: *"if a new species ever needs
   * CODE, the schema failed."* Everything below — ash, sand, spore, petal, mote
   * — is DATA ONLY. Not one line of runtime, kernel, draw or subsystem changed
   * to add them; they fall, lean, gate on sky reach, band with the squall, light
   * by day and night, and feed the mantle because the fields they fill were
   * already read.
   *
   * ⚠️ WHERE THE SCHEMA DID NEED SOMETHING, IT IS NAMED RATHER THAN QUIETLY
   * PATCHED — a proof with an unmentioned exception is not a proof:
   *
   *  · `ash`'s **ember companion population** (§2.2: grey flakes PLUS a sparse
   *    additive glow, which V2 ran as a literal pair of systems) needs the
   *    subsystem to run TWO species at once. It cannot — it picks one — and that
   *    same missing capability is why `sleet` still renders as its dominant
   *    half. ONE gap, TWO features waiting on it. `ember` is deliberately still
   *    not a row: fire owns embers rising FROM fires, weather owns them falling
   *    from the sky, and unifying them is a named disease here.
   *  · `body.emissive01` has **no consumer yet** — the draw multiplies a
   *    per-body brightness and never adds. So `spore` and `mote` are correctly
   *    coloured and correctly moving, and do not yet glow past bloom's
   *    threshold. Carried because the value is real and its consumer is a known
   *    rung (§3.5), not because it does anything today.
   */
  ash: Object.freeze({
    id: 'ash',
    label: 'Ash',
    phase: 'dust',
    fall: Object.freeze({
      /** Slower than snow — ash is lighter than water and rides every eddy. */
      speedPxS: Object.freeze([26, 74]),
      /** Nearly wind-borne: a volcanic fall drifts sideways as much as down. */
      windCarry01: 0.92,
      flutter: Object.freeze({ hzMin: 0.4, hzMax: 1.1, ampPxMin: 55, ampPxMax: 130 }),
      spin: Object.freeze({ radSMin: 1.4, radSMax: 3.2, windScaleCalm: 0.5, windScaleStorm: 3.5 }),
      spawnHeightPx: 950,
      gravityMul: Object.freeze([0.8, 1.3]),
    }),
    body: Object.freeze({
      mode: 'flake',
      sizePx: Object.freeze([1.8, 5.4]),
      streakPerPxS: 0.0022,
      /** ⚠️ DARK. Every species before this one is BRIGHTER than the map; ash is
       * the first that is darker, and that is precisely why `dust` is a separate
       * mantle channel with a MULTIPLY blend rather than snow's lerp. */
      headRgba: Object.freeze([0.34, 0.31, 0.29, 0.9]),
      tailRgba: Object.freeze([0.19, 0.18, 0.18, 0.6]),
      brightnessSkewExp: 0.9,
      emissive01: 0,
      softness01: 0.7,
    }),
    respond: Object.freeze({
      count: Object.freeze({ kind: 'linear', from: 0, to: 1 }),
      length: Object.freeze({ kind: 'linear', from: 1, to: 1 }),
      speed: Object.freeze({ kind: 'linear', from: 0.9, to: 1.15 }),
      /** Ash greys the air far sooner than rain does — that IS the phenomenon. */
      veil: Object.freeze({ kind: 'threshold', at: 0.2, from: 0, to: 1 }),
    }),
    respondStorm: Object.freeze({ flutter: Object.freeze({ kind: 'linear', from: 1, to: 0.3 }) }),
    /**
     * ⭐ THE EMBER COMPANION (§2.2) — *"grey flakes + a sparse companion
     * population of glowing ember motes (additive, wind-twitchy). V2 ran
     * exactly this pair (`ashSystem` + `ashEmberSystem`)."*
     *
     * ⚠️ A WEIGHT, NOT A COUNT. The companion's population is this fraction of
     * whatever the parent's own response curve produced, so an ash-storm that
     * thickens brings more sparks with it for free and a dying one takes them
     * away — one axis, both populations, no second intensity to keep in sync
     * (`feedback_shared_field_two_meanings_two_registries`).
     *
     * Sparse on purpose: embers are the exception in a fall of ash, and a
     * one-to-one pairing would read as orange snow.
     */
    companion: Object.freeze({ speciesId: 'ember', weight: 0.08 }),

    arrive: Object.freeze({ kind: 'settle', smearWithWind: false }),
    stay: Object.freeze({
      /** ⭐ THE `dust` CHANNEL's FIRST REAL CUSTOMER. The mantle has integrated it
       * since P3 and nothing fed it until now — which is why P3's own tests
       * assert that rain and snow both deposit zero dust. */
      channel: 'dust',
      ratePerHour: 0.55,
      puddleRatePerHour: 0,
      meltBy: Object.freeze({ temperature: false, fire: false }),
      surface: Object.freeze({ tint: Object.freeze([0.36, 0.34, 0.32]), sparkle01: 0, roughnessDelta: 0.3 }),
    }),
    light: Object.freeze({
      dayAlphaMul: 1.5,
      dayRgbMul: 0.55,
      nightAlphaMul: 0.4,
      nightRgbMul: 0.22,
      flashAlphaMul: 4,
      flashRgbMul: 3,
    }),
    capacity: 18000,
    zoomSleepPxPerBody: 1.1,
  }),

  sand: Object.freeze({
    id: 'sand',
    label: 'Sand',
    phase: 'dust',
    fall: Object.freeze({
      /** ⚠️ §2.2: *"near-horizontal — wind IS the fall."* The lowest fall speed
       * in the table against the highest `windCarry01`, so at any real wind a
       * grain's motion is almost entirely lateral. Nothing in the runtime
       * special-cases that; it falls out of two numbers. */
      speedPxS: Object.freeze([14, 46]),
      windCarry01: 1,
      flutter: Object.freeze({ hzMin: 1.4, hzMax: 2.6, ampPxMin: 18, ampPxMax: 52 }),
      spin: null,
      spawnHeightPx: 700,
      gravityMul: Object.freeze([0.85, 1.2]),
    }),
    body: Object.freeze({
      mode: 'streak',
      sizePx: Object.freeze([0.5, 1.9]),
      /** Grains DART — the highest stretch per unit speed in the table, which is
       * what makes a sandstorm read as speed rather than as falling. */
      streakPerPxS: 0.02,
      headRgba: Object.freeze([0.86, 0.72, 0.46, 0.85]),
      tailRgba: Object.freeze([0.62, 0.5, 0.31, 0.4]),
      brightnessSkewExp: 0.8,
      emissive01: 0,
      softness01: 0.25,
    }),
    respond: Object.freeze({
      count: Object.freeze({ kind: 'pow', exp: 1.6, from: 0, to: 1 }),
      length: Object.freeze({ kind: 'linear', from: 0.8, to: 1.4 }),
      speed: Object.freeze({ kind: 'linear', from: 0.9, to: 1.3 }),
      /** ⭐ THE EARLIEST VEIL IN THE TABLE. §2.2: sand is *"mostly IMPRESSION"* —
       * the curtain IS the sandstorm and the grains are near-zoom detail, so the
       * veil starts almost immediately. */
      veil: Object.freeze({ kind: 'threshold', at: 0.08, from: 0, to: 1 }),
    }),
    arrive: Object.freeze({ kind: 'none', smearWithWind: false }),
    stay: Object.freeze({
      channel: 'dust',
      ratePerHour: 0.3,
      puddleRatePerHour: 0,
      meltBy: Object.freeze({ temperature: false, fire: false }),
      surface: Object.freeze({ tint: Object.freeze([0.78, 0.66, 0.44]), sparkle01: 0.2, roughnessDelta: 0.2 }),
    }),
    light: Object.freeze({
      dayAlphaMul: 1.7,
      dayRgbMul: 0.6,
      nightAlphaMul: 0.3,
      nightRgbMul: 0.2,
      flashAlphaMul: 3,
      flashRgbMul: 2.5,
    }),
    capacity: 24000,
    zoomSleepPxPerBody: 0.5,
  }),

  spore: Object.freeze({
    id: 'spore',
    label: 'Spores',
    phase: 'magic',
    fall: Object.freeze({
      /** The slowest thing the sky sends — spores hang. */
      speedPxS: Object.freeze([8, 26]),
      windCarry01: 1,
      flutter: Object.freeze({ hzMin: 0.25, hzMax: 0.7, ampPxMin: 70, ampPxMax: 190 }),
      spin: Object.freeze({ radSMin: 0.4, radSMax: 1.2, windScaleCalm: 0.6, windScaleStorm: 2 }),
      spawnHeightPx: 820,
      gravityMul: Object.freeze([0.7, 1.35]),
    }),
    body: Object.freeze({
      mode: 'flake',
      sizePx: Object.freeze([1.6, 4.2]),
      streakPerPxS: 0.0009,
      headRgba: Object.freeze([0.66, 1.0, 0.78, 0.95]),
      tailRgba: Object.freeze([0.3, 0.72, 0.5, 0.55]),
      brightnessSkewExp: 0.55,
      /** ⚠️ AUTHORED ABOVE BLOOM's 4.0 THRESHOLD ON PURPOSE (§3.5: an emissive
       * body that wants to glow must be authored above it, not hoped) — but
       * NOTHING READS THIS YET. See the shelf's header. */
      emissive01: 5.5,
      softness01: 0.95,
    }),
    respond: Object.freeze({
      count: Object.freeze({ kind: 'pow', exp: 1.4, from: 0, to: 1 }),
      length: Object.freeze({ kind: 'linear', from: 1, to: 1 }),
      speed: Object.freeze({ kind: 'linear', from: 0.9, to: 1.1 }),
      /** Spores never veil — they are sparse points of light, and a green fog is
       * a different effect entirely. */
      veil: Object.freeze({ kind: 'threshold', at: 1, from: 0, to: 0 }),
    }),
    arrive: Object.freeze({ kind: 'settle', smearWithWind: false }),
    stay: Object.freeze({
      /** §2.2: *"optional faint dust tint"* — optional means a rate near zero,
       * not an absent channel, so a long fey drift does eventually mark ground. */
      channel: 'dust',
      ratePerHour: 0.05,
      puddleRatePerHour: 0,
      meltBy: Object.freeze({ temperature: false, fire: true }),
      surface: Object.freeze({ tint: Object.freeze([0.72, 0.9, 0.76]), sparkle01: 0.5, roughnessDelta: 0 }),
    }),
    light: Object.freeze({
      /** ⚠️ BRIGHTER AT NIGHT THAN BY DAY — the only row that inverts the pair,
       * and the correct inversion for a light SOURCE rather than a lit object.
       * Every other species is water catching the sun. */
      dayAlphaMul: 0.9,
      dayRgbMul: 0.7,
      nightAlphaMul: 1.4,
      nightRgbMul: 1.1,
      flashAlphaMul: 1.2,
      flashRgbMul: 1.1,
    }),
    capacity: 9000,
    zoomSleepPxPerBody: 1,
  }),

  petal: Object.freeze({
    id: 'petal',
    label: 'Petals',
    phase: 'magic',
    fall: Object.freeze({
      /** Snow's dynamics with a warmer palette (§2.2) — which is exactly what a
       * data table lets you say without a line of code. */
      speedPxS: Object.freeze([34, 96]),
      windCarry01: 0.88,
      flutter: Object.freeze({ hzMin: 0.45, hzMax: 0.95, ampPxMin: 60, ampPxMax: 140 }),
      /** Faster tumbling than snow's — a petal is a flat sail. */
      spin: Object.freeze({ radSMin: 1.8, radSMax: 3.6, windScaleCalm: 0.5, windScaleStorm: 3 }),
      spawnHeightPx: 880,
      gravityMul: Object.freeze([0.8, 1.25]),
    }),
    body: Object.freeze({
      mode: 'flake',
      sizePx: Object.freeze([3, 7.5]),
      streakPerPxS: 0.0018,
      headRgba: Object.freeze([1.0, 0.82, 0.9, 0.95]),
      tailRgba: Object.freeze([0.92, 0.6, 0.74, 0.7]),
      brightnessSkewExp: 0.75,
      emissive01: 0,
      /** Softer than a flake but not a blur — a petal has an edge. */
      softness01: 0.55,
    }),
    respond: Object.freeze({
      count: Object.freeze({ kind: 'linear', from: 0, to: 1 }),
      length: Object.freeze({ kind: 'linear', from: 1, to: 1 }),
      speed: Object.freeze({ kind: 'linear', from: 0.9, to: 1.15 }),
      veil: Object.freeze({ kind: 'threshold', at: 0.8, from: 0, to: 0.4 }),
    }),
    respondStorm: Object.freeze({ flutter: Object.freeze({ kind: 'linear', from: 1, to: 0.4 }) }),
    arrive: Object.freeze({ kind: 'settle', smearWithWind: false }),
    /** §2.2's Stay column for petal reads *"none"* — blossom is swept away, it
     * does not become terrain. `channel: null` is the row saying so. */
    stay: Object.freeze({
      channel: null,
      ratePerHour: 0,
      puddleRatePerHour: 0,
      meltBy: Object.freeze({ temperature: false, fire: false }),
      surface: Object.freeze({ tint: Object.freeze([0.95, 0.8, 0.86]), sparkle01: 0, roughnessDelta: 0 }),
    }),
    light: Object.freeze({
      dayAlphaMul: 1.5,
      dayRgbMul: 0.6,
      nightAlphaMul: 0.4,
      nightRgbMul: 0.3,
      flashAlphaMul: 5,
      flashRgbMul: 3.5,
    }),
    capacity: 12000,
    zoomSleepPxPerBody: 1.4,
  }),

  /**
   * ⭐ THE GENERIC MAGICAL CARRIER (§2.2: *"palette/emissive/curl fully
   * data-driven"*) — the row a slice-4 EVENT skins. `mana-storm` glitter,
   * `gloom` flecks and `radiance` sparks are this row with a different palette,
   * which is exactly why they are not three rows.
   */
  mote: Object.freeze({
    id: 'mote',
    label: 'Motes',
    phase: 'magic',
    fall: Object.freeze({
      speedPxS: Object.freeze([18, 70]),
      windCarry01: 0.75,
      flutter: Object.freeze({ hzMin: 0.6, hzMax: 1.8, ampPxMin: 30, ampPxMax: 110 }),
      spin: Object.freeze({ radSMin: 0.8, radSMax: 2.4, windScaleCalm: 0.5, windScaleStorm: 2.5 }),
      spawnHeightPx: 860,
      gravityMul: Object.freeze([0.75, 1.3]),
    }),
    body: Object.freeze({
      mode: 'flake',
      sizePx: Object.freeze([1.2, 3.6]),
      streakPerPxS: 0.0012,
      /** Neutral-bright by default: a carrier is meant to be RE-TINTED, and a
       * strongly-coloured default would fight every skin laid over it. */
      headRgba: Object.freeze([0.95, 0.95, 1.0, 0.9]),
      tailRgba: Object.freeze([0.7, 0.72, 0.9, 0.5]),
      brightnessSkewExp: 0.5,
      emissive01: 4.5,
      softness01: 0.9,
    }),
    respond: Object.freeze({
      count: Object.freeze({ kind: 'linear', from: 0, to: 1 }),
      length: Object.freeze({ kind: 'linear', from: 1, to: 1 }),
      speed: Object.freeze({ kind: 'linear', from: 0.85, to: 1.2 }),
      veil: Object.freeze({ kind: 'threshold', at: 1, from: 0, to: 0 }),
    }),
    arrive: Object.freeze({ kind: 'none', smearWithWind: false }),
    stay: Object.freeze({
      channel: null,
      ratePerHour: 0,
      puddleRatePerHour: 0,
      meltBy: Object.freeze({ temperature: false, fire: false }),
      surface: Object.freeze({ tint: Object.freeze([0.9, 0.9, 1.0]), sparkle01: 0.3, roughnessDelta: 0 }),
    }),
    light: Object.freeze({
      dayAlphaMul: 0.85,
      dayRgbMul: 0.75,
      nightAlphaMul: 1.5,
      nightRgbMul: 1.2,
      flashAlphaMul: 1.5,
      flashRgbMul: 1.3,
    }),
    capacity: 10000,
    zoomSleepPxPerBody: 0.9,
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

    /**
     * ⭐ THE STAY (P3) — and §2.2 calls this row *"THE persistence feature"*.
     * Snow is the one species whose whole point is that it is still there an
     * hour later.
     */
    stay: Object.freeze({
      channel: 'snow',
      ratePerHour: SNOW_RATE_PER_HOUR,
      /** Snow does not pool while it is snow. What melts becomes water, and
       * that transfer is the integrator's job, not a second deposit rate. */
      puddleRatePerHour: 0,
      /** ⭐ BOTH SINKS, and `fire` is the one that costs nothing to author: the
       * fire mask's derived grid already exists, so snow retreats in a halo
       * around every burning hearth for free. */
      meltBy: Object.freeze({ temperature: true, fire: true }),
      surface: Object.freeze({
        /** Snow BRIGHTENS — an albedo lerp toward this, not a multiply.
         * Slightly blue rather than pure white: unlit snow reads as grey
         * without the cool bias, and a pure-white lerp bleaches the art. */
        tint: Object.freeze([0.93, 0.95, 1.0]),
        /** Crystalline glitter, for the specular system's high tiers. */
        sparkle01: 0.65,
        /** Fresh snow is rough, unlike wet stone — opposite sign to rain's,
         * which is exactly why the two are separate channels with separate
         * blend ops rather than one “cover” value. */
        roughnessDelta: 0.25,
      }),
    }),

    capacity: 20000,
    /** Flakes are bigger than streaks are wide, so snow stays legible further
     * out than rain and sleeps LATER. */
    zoomSleepPxPerBody: 1.2,
  }),
});

/**
 * ⭐ COMPANION SPECIES — rows that exist only because another row summons them.
 *
 * ⚠️ SEPARATE FROM `PRECIP_SPECIES` ON PURPOSE, AND THE SEPARATION IS THE
 * DESIGN. §2.2 is emphatic: *"`ember` is deliberately NOT a top-level species:
 * fire's own effect owns embers rising FROM fires. Weather owns embers falling
 * from the SKY as `ash`'s companion population. Same word, two owners, one
 * boundary — stated here so nobody unifies them into a shared mesh and
 * reintroduces the `feedback_shared_field_two_meanings_two_registries`
 * disease."*
 *
 * Keeping `ember` out of `PRECIP_SPECIES_IDS` makes that boundary
 * STRUCTURAL rather than a comment: the manager's closed kind list cannot name
 * it, `derivePrecipKind` cannot produce it, a GM cannot pick it, and a stored
 * scene flag cannot restore it. The only way an ember falls from the sky is
 * because ash brought it — which is exactly the rule.
 *
 * It also keeps the table's own invariant intact ("the closed list and the
 * table name exactly the same rows"), which a hidden extra entry would have
 * quietly broken.
 */
export const PRECIP_COMPANIONS = Object.freeze({
  ember: Object.freeze({
    id: 'ember',
    label: 'Embers',
    phase: 'magic',
    fall: Object.freeze({
      /** Slower even than ash — an ember is a rising, dying thing that has run
       * out of lift, so it drifts rather than falls. */
      speedPxS: Object.freeze([18, 52]),
      windCarry01: 0.95,
      /** ⭐ WIND-TWITCHY (§2.2). The highest flutter frequency in either table:
       * an ember jitters where a flake sways, which is most of what makes the
       * pair read as fire-borne rather than as two kinds of snow. */
      flutter: Object.freeze({ hzMin: 1.6, hzMax: 3.4, ampPxMin: 22, ampPxMax: 64 }),
      spin: null,
      spawnHeightPx: 900,
      gravityMul: Object.freeze([0.7, 1.4]),
    }),
    body: Object.freeze({
      mode: 'flake',
      sizePx: Object.freeze([1.1, 2.8]),
      streakPerPxS: 0.0016,
      /** Hot core to cooling tail — the one palette in either table that is a
       * TEMPERATURE rather than a material. */
      headRgba: Object.freeze([1.0, 0.72, 0.32, 0.95]),
      tailRgba: Object.freeze([0.85, 0.25, 0.08, 0.5]),
      brightnessSkewExp: 0.45,
      /** Above bloom's 4.0 threshold — an ember that does not bloom is an
       * orange dot (§3.5: authored above it, never hoped). */
      emissive01: 6.5,
      softness01: 0.85,
    }),
    respond: Object.freeze({
      count: Object.freeze({ kind: 'linear', from: 0, to: 1 }),
      length: Object.freeze({ kind: 'linear', from: 1, to: 1 }),
      speed: Object.freeze({ kind: 'linear', from: 0.9, to: 1.2 }),
      /** Embers never veil — they are the sparks IN the ash's veil. */
      veil: Object.freeze({ kind: 'threshold', at: 1, from: 0, to: 0 }),
    }),
    arrive: Object.freeze({ kind: 'none', smearWithWind: false }),
    /** An ember burns out; it leaves nothing. `channel: null` says so. */
    stay: Object.freeze({
      channel: null,
      ratePerHour: 0,
      puddleRatePerHour: 0,
      meltBy: Object.freeze({ temperature: false, fire: false }),
      surface: Object.freeze({ tint: Object.freeze([1, 0.8, 0.6]), sparkle01: 0, roughnessDelta: 0 }),
    }),
    light: Object.freeze({
      /** A light SOURCE — brighter at night, like `spore` and `mote`. */
      dayAlphaMul: 0.8,
      dayRgbMul: 0.8,
      nightAlphaMul: 1.6,
      nightRgbMul: 1.3,
      flashAlphaMul: 1.2,
      flashRgbMul: 1.1,
    }),
    capacity: 6000,
    zoomSleepPxPerBody: 0.8,
  }),
});

/**
 * Resolve a species id, INCLUDING companions.
 *
 * ⚠️ A COMPANION RESOLVES HERE BUT IS STILL UNSELECTABLE, because selection
 * goes through the manager's `PRECIP_KINDS` closed list and the subsystem's
 * `KIND_TO_SPECIES`, neither of which names one. This lookup exists so the
 * ENGINE BUILDER can construct the row a parent summoned; it is not a door
 * into the weather.
 *
 * Fails OPEN to *no precipitation* with a reason — the
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
  if (Object.hasOwn(PRECIP_COMPANIONS, id)) {
    return Object.freeze({ ok: true, species: PRECIP_COMPANIONS[id], reason: null });
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
