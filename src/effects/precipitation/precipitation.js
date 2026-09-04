/**
 * PRECIPITATION's declaration — the manifest and PRECIPITATION_PARAMS.
 *
 * ⚠️ THE LAST EFFECT WITHOUT ONE (2026-08-30). Precipitation shipped P1 LIVE
 * and P2-P7 `BUILT` without ever passing through `effect-cascade.js`/
 * `registry.js` — confirmed by the original tier-gradient audit
 * (docs/planning/Effect-Tier-Gradient-Audit-2026-08-29.md §3.4) as a real,
 * structural gap: no GM/player enable override, no `a11y.photosensitive`
 * gate, and its own "budget multiplier" (`precipTierScaleForProfile`,
 * `precip-species.js`) read the raw performance-profile SETTING directly
 * rather than going through the real resolver every other effect uses.
 *
 * ⭐ `PRECIPITATION_PARAMS` WAS DELIBERATELY EMPTY UNTIL NOW (2026-09-04, live
 * author request: *"we need controls for the appearance of weather. It is an
 * effect after all. Make a new effect panel for all precipitation effects."*).
 * The empty schema's own header used to argue that precipitation's "look" —
 * which species falls, how hard (`precip01`) — is WEATHER-MANAGER state, not a
 * per-scene author dial. That argument still holds for the AXES (species,
 * intensity — those stay on `MapShine.setPrecip`/`setPrecipKind`), but it
 * never applied to the EFFECT's own LOOK dials: how opaque a splash is, how
 * turbulent the fall reads, how strong the distant veil sits, how much the
 * ground remembers snow/dust/wet — every one of these already existed as a
 * live uniform (`precip-subsystem.js#setTuning`, built for the shader lab to
 * sweep) with no author-facing control anywhere in the product. This schema
 * is that control surface, finally given to the same params/manifest/Studio
 * machinery every other effect uses.
 *
 * ⭐ FIVE BODIES, MIRRORING FIRE'S OWN Flame/Ember/Smoke SPLIT (§Category).
 * Precipitation is not one particle system — it is five independent
 * sub-engines coordinated by `precip-subsystem.js` (the ground splash, the
 * falling body, the distant impression veil, the ground's mantle
 * accumulation, and roof/eave drips), each with its own size/rate/strength
 * knobs. Lumping all 23 into 'Look' would be the exact unusable-card problem
 * Fire's own category comment (`ui/widgets/param-groups.js`) already names —
 * so this schema uses five matching categories (`Splash`, `Fall`, `Veil`,
 * `Ground`, `Drips`), added to `CATEGORY_ORDER` alongside Fire's trio.
 *
 * ⚠️ EVERY DEFAULT BELOW IS THE ENGINE'S OWN EXISTING HARDCODED DEFAULT,
 * copied rather than re-chosen, with exactly one exception: `splashAlphaScale`
 * moved from the engine's original `1` to `0.35` — the same live-feedback
 * fix landed in `precip-splash-runtime.js` in this same pass (*"lower their
 * opacity by a lot"* — the densest splash archetype peaked at ~91% opaque at
 * the old default, reading as a solid disc rather than translucent water).
 * Matching every other default to its engine's own hardcoded value means a
 * fresh session needs no "push defaults on boot" step at all: the engine is
 * already sitting at what the schema claims, and only an actual author touch
 * (`MapShine.setPrecipitation`) ever has to push a different number.
 *
 * @module effects/precipitation/precipitation
 */

/**
 * @typedef {import('../../core/params-schema.js').ParamDecl} ParamDecl
 */

export const PRECIPITATION_PARAMS = Object.freeze({
  // ── SPLASH — the ground impact (precip-splash-runtime.js) ────────────────
  splashAlphaScale: Object.freeze({
    type: 'float',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 0.35,
    category: 'Splash',
    label: 'Splash opacity',
    help: 'How visible ground splashes are overall. Lowered from the engine`s original 1.0 — at full opacity the round splash rings read as solid discs rather than translucent water.',
  }),
  splashSizeScale: Object.freeze({
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Splash',
    label: 'Splash size',
    help: 'Scales every splash archetype`s footprint together.',
  }),
  splashRateScale: Object.freeze({
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Splash',
    label: 'Splash density',
    help: 'How many splashes land per unit of ground, as a multiple of the falling species` own rate.',
  }),
  splashPeakBoost: Object.freeze({
    type: 'float',
    min: 0,
    max: 5,
    step: 0.05,
    default: 2.75,
    category: 'Splash',
    label: 'Splash brightness peak',
    help: 'How bright a splash gets at the midpoint of its life, before `Splash opacity` scales the whole result down.',
  }),
  splashSmearGain: Object.freeze({
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Splash',
    label: 'Splash wind smear',
    help: 'How strongly wind throws a splash`s crown downwind and asymmetric, rather than leaving it round. From directly above, a windier impact should look struck-from-one-side, not motion-blurred.',
  }),

  // ── FALL — the falling body itself (precip-runtime.js) ───────────────────
  sizeScale: Object.freeze({
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 1.1,
    category: 'Fall',
    label: 'Drop / flake size',
    help: 'Scales every falling body`s width/diameter together.',
  }),
  streakScale: Object.freeze({
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1.1,
    category: 'Fall',
    label: 'Streak length',
    help: 'How long a fast-falling drop`s motion streak draws, on top of its own width.',
  }),
  chaosScale: Object.freeze({
    type: 'float',
    min: 0,
    max: 8,
    step: 0.1,
    default: 3.5,
    category: 'Motion',
    label: 'Turbulence',
    help: 'Lateral wander as rain/snow falls — the difference between a rigid curtain and real weather.',
  }),
  fallSlant01: Object.freeze({
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Motion',
    label: 'Wind-driven slant',
    help: '0 = physically pure vertical fall (nearly invisible from directly above); 1 = fully slanted toward the wind, the classic downpour look.',
  }),
  windAirSpeedPxS: Object.freeze({
    type: 'float',
    min: 0,
    max: 6000,
    step: 50,
    default: 2600,
    category: 'Response',
    label: 'Wind push strength',
    help: 'How hard a full gale pushes falling rain/snow, ground splashes and roof drips sideways, in world px/s. Shared by all three.',
  }),
  parallaxStreak01: Object.freeze({
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Depth',
    label: 'Motion-streak blend',
    help: '0 = every streak parallel (reads as drifting one direction); 1 = the full falling-toward-camera splay. The physically fuller look measures as too extreme for most scenes, hence the lower shipped default is NOT this — see `cameraHeight`.',
  }),
  cameraHeight: Object.freeze({
    type: 'float',
    min: 500,
    max: 5000,
    step: 50,
    default: 2000,
    category: 'Depth',
    label: 'Falling perspective strength',
    help: 'How strongly falling rain/snow (and roof drips) appear to radiate outward from the view centre as they fall — a fake-camera-height trick, not a real 3-D camera. Smaller = stronger perspective.',
  }),
  illumLit01: Object.freeze({
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.85,
    category: 'Light',
    label: 'Light pickup',
    help: 'How much a falling drop brightens as it crosses a torch or lamp`s light. 0 = unlit sprites only.',
  }),

  // ── VEIL — the distant impression curtain (curtain-render.js) ────────────
  curtainStrength: Object.freeze({
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Veil',
    label: 'Veil strength',
    help: 'Overall visibility of the distant atmospheric rain/snow haze that greys the air in a downpour.',
  }),
  curtainBandDepth: Object.freeze({
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.8,
    category: 'Veil',
    label: 'Squall banding',
    help: 'How strongly rain/snow arrives in gusty bands rather than an even rate. Shared by the veil, the falling bodies and the splashes, so they always agree about where a squall is.',
  }),
  curtainBandScale: Object.freeze({
    type: 'float',
    min: 0.05,
    max: 5,
    step: 0.05,
    default: 1,
    category: 'Veil',
    label: 'Squall band size',
    help: 'World-space size of one squall band — larger reads as slower, wider weather fronts.',
  }),

  // ── GROUND — the mantle, i.e. accumulation (mantle-runtime.js) ───────────
  mantleSnowStrength: Object.freeze({
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Ground',
    label: 'Snow cover strength',
    help: 'How visible accumulated snow is once it settles on the ground.',
  }),
  mantleDustStrength: Object.freeze({
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Ground',
    label: 'Dust cover strength',
    help: 'How visible accumulated ash/dust is once it settles on the ground.',
  }),
  mantleWetStrength: Object.freeze({
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Ground',
    label: 'Wet ground strength',
    help: 'How dark and glossy rain-wetted ground reads while it dries.',
  }),

  // ── DRIPS — roof/eave runoff (precip-drip-runtime.js) ─────────────────────
  dripSizeScale: Object.freeze({
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Drips',
    label: 'Drip size',
    help: 'Scales every roof-edge drip`s width together.',
  }),
  dripStreakScale: Object.freeze({
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Drips',
    label: 'Drip streak length',
    help: 'How long a falling drip`s motion streak draws, on top of its own width.',
  }),
  dripParallax01: Object.freeze({
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.3,
    category: 'Depth',
    label: 'Drip perspective',
    help: 'Same fake-perspective trick as `Falling perspective strength`, applied to drips falling off a roof edge above the viewed floor.',
  }),
  dripEdgeJitterPx: Object.freeze({
    type: 'float',
    min: 0,
    max: 100,
    step: 1,
    default: 26,
    category: 'Drips',
    label: 'Drip spawn jitter',
    help: 'How far along a roof edge each drip`s spawn point wanders, in world pixels — the difference between drips falling from one exact point and a believable scatter along the eave.',
  }),
});

export const PRECIPITATION = Object.freeze({
  id: 'precipitation',
  title: 'Precipitation',
  // Covers the whole viewport when active, the same "dominates the screen,
  // not a localised decoration" shape water's own 0.8 already reflects —
  // unlike a single fire or fluid tube, weather has no natural "small" case.
  visualWeight: 0.7,
  a11y: Object.freeze({
    photosensitive: false,
    // A future flash/lightning-adjacent species (the audit's own §3.4 named
    // this risk) would need this flipped true — recorded here so the gate
    // exists to flip, not invented from scratch the day it's actually needed.
  }),
  // On at every profile, matching what this effect ALREADY does today
  // (`getPrecipRenderState()` hardcoded `enabled: true` unconditionally,
  // vt-pan-viewer.js) — this manifest FORMALISES that behaviour, it does
  // not change it. Low still gets real, visible weather (tier 0 below),
  // just fewer live particles — the same "still visible, minimal cost"
  // shape this whole audit exists to find for every effect.
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why:
      'Builds its species curtains, arrival/splash engines, mantle buffers and drip engines lazily on first ' +
      'use per floor (precip-subsystem.js) — no dedicated probe; covered by settle.js`s own frame-steadiness ' +
      'and pipeline-growth criteria, the same posture fluid`s own readiness declares for the identical reason.',
  }),
  params: PRECIPITATION_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.1 }),
      adds:
        'the floor every profile gets: rain/snow/etc. genuinely falls, at 40% of the shipped live-particle ' +
        'count (precipTierPlan(0).tierScale, precip-species.js) — real weather at the cheapest setting this ' +
        'effect has.',
    }),
    Object.freeze({
      n: 1,
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.18 }),
      adds: 'live-particle count rises to 70% of shipped',
    }),
    Object.freeze({
      n: 2,
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.25 }),
      adds: 'live-particle count reaches its own ceiling — 100% of shipped, unchanged above this rung',
    }),
  ]),
  // ⭐ EMPTY NOW (2026-09-04) — the one deferred rung this manifest ever had
  // ("per-scene author-facing look params... genuinely new design") is what
  // PRECIPITATION_PARAMS above now is. Left as an explicit empty array
  // rather than omitted, so "nothing is deferred" is a fact a reader can see
  // rather than an absence they have to interpret.
  deferredRungs: Object.freeze([]),
});
