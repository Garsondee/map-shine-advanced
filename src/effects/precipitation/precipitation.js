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
 * knobs. Lumping all of these into 'Look' would be the exact unusable-card
 * problem Fire's own category comment (`ui/widgets/param-groups.js`) already
 * names — so this schema uses five matching categories (`Splash`, `Fall`,
 * `Veil`, `Ground`, `Drips`), added to `CATEGORY_ORDER` alongside Fire's trio.
 * (23 at the schema's 2026-09-04 birth; mythica-machina-press#316 added five
 * more — the authored-drip mode plus its two engine dials, and a Fall-speed
 * sibling for both engines — without touching this shape.)
 *
 * ⚠️ EVERY DEFAULT BELOW IS THE ENGINE'S OWN EXISTING HARDCODED DEFAULT,
 * copied rather than re-chosen, with exactly one exception: `splashAlphaScale`
 * moved from the engine's own `0.75` down to `0.29` — the author's own repeated
 * live-feedback ("lower their opacity by a lot" — the densest splash archetype
 * peaked at ~91% opaque at the old default, reading as a solid disc rather than
 * translucent water), tuned across more than one pass to the value shipped here.
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
    default: 0.29,
    category: 'Splash',
    label: 'Splash opacity',
    help: 'How visible ground splashes are overall. Lowered from the engine`s original 1.0 — at full opacity the round splash rings read as solid discs rather than translucent water.',
  }),
  splashSizeScale: Object.freeze({
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 3,
    category: 'Splash',
    label: 'Splash size',
    help: 'Scales every splash archetype`s footprint together. Splashes on the floor itself are drawn at half this size; ones on raised things grow back toward it (see Splash height effect).',
  }),
  splashElevationExag: Object.freeze({
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 4,
    category: 'Splash',
    label: 'Splash height effect',
    help: 'How much the height of what the rain hits changes the splash size. Ground = half size; a roof, canopy or tree about 3 squares up = full size. 0 = everything the same (ground) size; 2+ exaggerates the depth, so tall things get splashes bigger than normal.',
  }),
  splashRateScale: Object.freeze({
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 3,
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
    default: 1.75,
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
    default: 0.55,
    category: 'Fall',
    label: 'Drop / flake size',
    help: 'Scales every falling body`s width/diameter together.',
  }),
  streakScale: Object.freeze({
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 3,
    category: 'Fall',
    label: 'Streak length',
    help: 'How long a fast-falling drop`s motion streak draws, on top of its own width.',
  }),
  // mythica-machina-press#316's OPTIONAL Fall-parity dial — an author-facing
  // sibling to the Drips category's own `dripFallSpeedScale`, added because it
  // was cheap once the drip engine's own version proved the pattern. Stacks
  // onto `uSpeedMul` (the weather-response scalar `resolveSpeciesFrame`
  // already drives every frame) rather than replacing it — see
  // `precip-runtime.js`'s own `uFallSpeedScale` doc for why the two must stay
  // separate uniforms.
  fallSpeedScale: Object.freeze({
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 0.6,
    category: 'Fall',
    label: 'Fall speed',
    help: 'Scales how fast rain/snow falls, independent of size or streak length.',
  }),
  // ⭐ THE TORRENT (torrent-render.js, 2026-10-27) — screen-space wind-driven
  // rain sheets that only rise in the rain fader's last quarter (rain's own
  // `respond.torrent`, precip-species.js). 1 = the engine's own default.
  torrentStrength: Object.freeze({
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.65,
    category: 'Fall',
    label: 'Torrent strength',
    help: 'How strongly the top of the rain fader adds wind-driven sheets of near rain sweeping across the screen. Only appears in the heaviest rain; the wind drives it harder and sets its direction.',
  }),
  chaosScale: Object.freeze({
    type: 'float',
    min: 0,
    max: 8,
    step: 0.1,
    default: 1.1,
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
    default: 6000,
    category: 'Response',
    label: 'Wind push strength',
    help: 'How hard the wind pushes falling rain/snow, ground splashes and roof drips sideways. 2250 = the wind’s real speed on this map (they move with the gusts on the wind overlay); higher exaggerates, lower damps. Shared by all three.',
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
    default: 2250,
    category: 'Depth',
    label: 'Falling perspective strength',
    help: 'How strongly falling rain/snow (and roof drips) appear to radiate outward from the view centre as they fall — a fake-camera-height trick, not a real 3-D camera. Smaller = stronger perspective.',
  }),
  illumLit01: Object.freeze({
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.41,
    category: 'Light',
    label: 'Light pickup',
    help: 'How much a falling drop brightens as it crosses a torch or lamp`s light. 0 = unlit sprites only.',
  }),
  // mmp-row — the gradient-line glint (precip-glint.js). Rain only; fades to
  // nothing in daylight, so these only matter at night near a light.
  rainLightEnabled: Object.freeze({
    type: 'bool',
    default: true,
    category: 'Light',
    label: 'Rain glints in light',
    help: 'Rain streaks catch the light of a torch or lamp as thin glinting lines — brightest at the end facing the light, tinted by its colour. Night only; daytime rain is unchanged.',
  }),
  rainLightStrength: Object.freeze({
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 2,
    category: 'Light',
    label: 'Rain light response',
    help: 'How brightly lit rain streaks glint. 0 = no glint at all.',
  }),
  rainGlint: Object.freeze({
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Light',
    label: 'Rain glint',
    help: 'How much lit streaks differ from each other and twinkle. 0 = every lit streak glows the same, steadily.',
  }),

  // ── VEIL — the distant impression curtain (curtain-render.js) ────────────
  curtainStrength: Object.freeze({
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.5,
    category: 'Veil',
    label: 'Veil strength',
    help: 'Overall visibility of the distant atmospheric rain/snow haze that greys the air in a downpour.',
  }),
  curtainBandDepth: Object.freeze({
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Veil',
    label: 'Squall banding',
    help: 'How strongly rain/snow arrives in gusty bands rather than an even rate. Shared by the veil, the falling bodies and the splashes, so they always agree about where a squall is.',
  }),
  curtainBandScale: Object.freeze({
    type: 'float',
    min: 0.05,
    max: 5,
    step: 0.05,
    default: 3.9,
    category: 'Veil',
    label: 'Squall band size',
    help: 'World-space size of one squall band — larger reads as slower, wider weather fronts.',
  }),
  // ⭐ mythica-machina-press#34/#314 — the STORM FOG (storm-fog-render.js), a
  // second and much stronger atmospheric layer that only rises at the top of
  // a species' own intensity (rain past ~0.7 precip01, snow past ~0.6 — see
  // precip-species.js's own `respond.fog` curves). Filed under the SAME
  // category as the veil above: both are "how visible is the air itself"
  // dials, just two different intensities of that one phenomenon.
  stormFogStrength: Object.freeze({
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.3,
    category: 'Veil',
    label: 'Storm-fog strength',
    help: 'How strongly a genuine downpour or blizzard reduces visibility outdoors — rain greys the air, snow whites it out. Only rises once the weather is already severe; ordinary rain/snow never triggers it.',
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
    default: 0.55,
    category: 'Ground',
    label: 'Wet ground strength',
    help: 'How dark and glossy rain-wetted ground reads while it dries.',
  }),

  // ── GROUND DISTURBANCE — tokens trampling the mantle (the V2 "Ash
  // Disturbance" effect, generalised — Precipitation.md §5.2's own named gap:
  // a token's footsteps dent `trample01`, which the darken/brighten meshes
  // already thin snow and dust by. Ash is the showcase (soot kicked bare
  // where something just walked) but the mechanism is the channel, not the
  // species — footprints in fresh snow are the identical code path. Same
  // `category: 'Ground'` as the three strengths above, not a new category:
  // `ui/widgets/param-groups.js#CATEGORY_ORDER` is a closed list (see this
  // file's own test), and these are four more dials on the same mantle.
  trampleEnabled: Object.freeze({
    type: 'bool',
    default: true,
    category: 'Ground',
    label: 'Tokens disturb the ground',
    help: 'A moving token stamps the mantle it is standing on — footprints in snow, bare patches kicked clear of ash — healing back once it stops.',
  }),
  trampleStrength: Object.freeze({
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.8,
    category: 'Ground',
    label: 'Disturbance depth',
    help: 'How deep one footstep digs into the mantle. Higher reads as a heavier, more deliberate print.',
  }),
  trampleRadiusScale: Object.freeze({
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.05,
    default: 0.9,
    category: 'Ground',
    label: 'Disturbance radius',
    help: "Multiplies each token's own footprint size — a cat and a dragon leave different-sized prints without separate tuning.",
  }),
  trampleRecoverHours: Object.freeze({
    type: 'float',
    min: 0.1,
    max: 24,
    step: 0.1,
    default: 3,
    category: 'Ground',
    label: 'Recovery time (hours)',
    help: 'Game hours for an undisturbed footprint to heal back to clean ground.',
  }),

  // ── DRIPS — roof/eave runoff (precip-drip-runtime.js) ─────────────────────
  // ⭐ Defaults re-set with the 2026-10-27 rebuild (author: "Change their
  // default settings AND their particle effect"). The old 100px spawn jitter
  // is what scattered drips across the lawn; drops now spread ALONG the eave
  // on their own, so the jitter only roughens the lip.
  dripSizeScale: Object.freeze({
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 1.75,
    category: 'Drips',
    label: 'Drip size',
    help: 'Scales every roof-edge drip`s width together.',
  }),
  dripStreakScale: Object.freeze({
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 0.2,
    category: 'Drips',
    label: 'Drip streak length',
    help: 'How long the tail behind a moving drop draws. Heavy runoff draws longer tails on its own; this scales both.',
  }),
  dripParallax01: Object.freeze({
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Depth',
    label: 'Drip perspective',
    help: 'Same fake-perspective trick as `Falling perspective strength`, applied to drips falling off a roof edge above the viewed floor.',
  }),
  dripEdgeJitterPx: Object.freeze({
    type: 'float',
    min: 0,
    max: 100,
    step: 1,
    default: 6,
    category: 'Drips',
    label: 'Drip spawn jitter',
    help: 'Extra scatter around each drip`s birth point on the eave, in world pixels. Drips already spread along the whole eave; this roughens the lip.',
  }),
  dripTurbulence: Object.freeze({
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 0.15,
    category: 'Drips',
    label: 'Drip turbulence',
    help: 'How strongly swirling air pushes falling drips around. Neighbouring drips swirl together, like a gust through a curtain of water; stronger in high and gusty wind.',
  }),
  dripThrow: Object.freeze({
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 0.15,
    category: 'Drips',
    label: 'Drip throw',
    help: 'How far water is flung off the edge of a roof. Heavy runoff is thrown further than an occasional drip; this scales both. Painted Drip-mask spots are not thrown.',
  }),
  // ── mythica-machina-press#316 — the AUTHORED `_Drip` mask's own controls,
  // plus two engine-facing dials (`dripCurlPx`/`dripTailDurationSec`) shared
  // by both the auto-detected roofline and the authored layer, since both are
  // the same underlying engine (`precip-drip-runtime.js`). ─────────────────
  dripAuthoredMode: Object.freeze({
    type: 'enum',
    values: ['weather', 'always'],
    default: 'weather',
    category: 'Drips',
    label: 'Authored drip mode',
    help: "Whether the painted Drip mask's spawn points behave like roof-edge runoff (only while it's raining, tapering off after) or drip constantly regardless of weather — for cave condensation, a leaking pipe, anything that shouldn't care if it's sunny out. Only affects Drip-authored points; the auto-detected roofline always follows the weather.",
  }),
  dripFallSpeedScale: Object.freeze({
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Drips',
    label: 'Drip fall speed',
    help: 'Scales how fast drips fall (gravity and top speed together; a released drip starts slow and accelerates). Both weather and always-mode drips.',
  }),
  dripCurlPx: Object.freeze({
    type: 'float',
    min: 0,
    max: 40,
    step: 1,
    default: 2,
    category: 'Drips',
    label: 'Drip wobble',
    help: 'Each drip`s own small sideways wander, on top of the shared turbulence, so two drips in the same gust still drift apart.',
  }),
  dripTailDurationSec: Object.freeze({
    type: 'float',
    min: 0,
    max: 900,
    step: 10,
    default: 560,
    category: 'Drips',
    label: 'Weather-drip tail',
    help: 'How long, in seconds, weather-mode drips keep tapering off after rain stops. Does not apply to always-mode drips, which never taper.',
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
