/**
 * FIRE — THE DECLARATION. Params schema + manifest, pure data, no THREE and no
 * TSL. The runtime lives in `fire-render.js` (the TSL material), the physics in
 * `fire-geometry.js` (pure math, Node-tested), and the lifecycle in
 * `fire-subsystem.js` — the same four-way split `candle-flame.js` and
 * `lightning.js` use.
 *
 * ⚠️ `apply` IS NOT DECLARED HERE. It is injected at registration by `boot.js`,
 * so `effects/` never imports the renderer and the manifest stays pure data.
 *
 * ⚠️ PLACEMENT IS NOT DECLARED HERE EITHER. `scene/anchor-catalog.js` already
 * carries `effectId: 'fire'` on the fire anchor kind, and a second declaration
 * would drift (`effect-manifest.js:54`).
 *
 * @module effects/fire/fire
 */

/**
 * THE PARAMS.
 *
 * ⚠️ NOTE HOW FEW OF THESE ARE DERIVED-FROM-SIZE FILLER. V2's fire shipped
 * **167 controls** (`docs/reference/v2-effect-params/fire-effect.md`),
 * several of which were dead on arrival — `coalBedScrollSpeed` was literally
 * labelled "Scroll (unused)", `smokeSizeGrowth` was "(Legacy)", and
 * `fireSize` existed in `params` with no schema entry at all. Restraint for
 * its own sake was never the goal here: almost everything V2 exposed as a
 * slider is DERIVED from `diameterPx` in `fire-geometry.js#fireScaleChain`,
 * because it genuinely is derived — puff frequency, plume height,
 * turbulence, smoke production, light radius and flicker depth all follow
 * from how big the fire is. A control that lets you set a bonfire's flicker
 * rate to a candle's is not a feature; it is a way to make the fire stop
 * reading as a fire.
 *
 * ⚠️ THE COUNT GREW PAST ~20 ON 2026-09-04, DELIBERATELY, ROUND 7 — author:
 * *"add a lot more controls... I want all the wind motion and lifespan
 * controls for embers and flames... two separate controls for each element
 * for Wind being 0 and wind being 1... pick very very wide ranges for every
 * slider."* Every flame/ember lifetime, chaos and rise dial split into a
 * Wind-0/Wind-1 pair (the same "very wide ranges, I'll find the values"
 * philosophy "THE TUNING SET" below already applies) — genuinely new
 * surface area, not a return to V2-style size-redundant filler.
 *
 * ⚠️ ROUND 8, SAME DAY — author: *"remove ratchets around ROH controls and
 * increase limits for FOH."* Every reference-multiplier ("×") dial in "THE
 * TUNING SET" below (Flame/Ember/Smoke categories) and `perspective`
 * (Depth) had its MAX raised again — roughly 5-10× further for the ROH
 * ones (not promoted to any FOH strip — see `ui/widgets/param-groups.js`'s
 * own FOH/ROH split), a more modest 2-3× for the six params that ARE in
 * fire's FOH list (`boot.js`'s two `fohKeys` arrays — `flameCount`,
 * `flameLifeAtWind0`, `flameOpacity`, `flameColorAge`, `emberCount`,
 * `smokeCount`). Deliberately EXCLUDED, each with its own note at the param
 * itself: `maskSensitivity` (a threshold against a normalised [0,1] value —
 * nothing past 1 can mean anything), `lightRadiusScale` (a real, explained
 * performance cost curve, not an arbitrary ceiling), `flameSpawnBias`/
 * `flameCohesion` (already documented as saturating well inside their
 * existing range), and everything in Presence/Look/Motion/Response
 * (`windResponse` especially — `fireWindMotion01`'s own gain clamp hard-caps
 * it at 2 regardless of what the schema allows, so widening the slider past
 * that would be pure theatre). Mins were left untouched throughout — the
 * ask was for more room to push values UP, not down.
 */
export const FIRE_PARAMS = Object.freeze({
  // ── Presence ──────────────────────────────────────────────────────────────
  intensity: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Presence',
    label: 'Fire intensity',
    help: 'How hard everything burns. Above 1 the flame stands taller and burns hotter; below 1 it banks down toward its coals.',
  },
  fuel: {
    type: 'enum',
    values: ['wood', 'coal', 'oil', 'magical'],
    default: 'wood',
    category: 'Presence',
    label: 'Fuel',
    help: 'What is burning. Wood is the default look; coal burns deeper and lower; oil is tall and very sooty; magical is hue-shifted for the unnatural stuff.',
  },
  maskSensitivity: {
    type: 'float',
    min: 0.02,
    max: 0.6,
    step: 0.01,
    // ⚠️ NOT WIDENED IN THE 2026-09-04 ROH RANGE PASS — this is a threshold against a NORMALISED [0,1] paint value, not a
    // reference multiplier; nothing past 1 can ever mean anything (no paint value exceeds 1). A real definitional bound.
    // ⚠️ 0.05, NOT 0.2 (2026-08-16, author live on Tower Bridge — the real multi-blob `_Fire.webp`, ~20 painted regions).
    // At 0.2 only 3 of the ~20 valid areas produced flames; the rest are faint/small strokes. See fire-mask.js's own
    // MIN_PEAK_TEXELS/PAINT_THRESHOLD headers — real authored fire is routinely this small.
    default: 0.02, // 2026-10-20 new defaults (was 0.04)
    category: 'Presence',
    label: 'Mask sensitivity',
    help: 'How much of the painted fire mask counts as real paint before a fire registers there. LOWER catches fainter or smaller painted strokes — turn this DOWN if fire you painted is not appearing. HIGHER requires bolder, more solid paint before a fire lights at all.',
  },

  // ── Look ──────────────────────────────────────────────────────────────────
  // ⚠️ THE BILLOW REBUILD (2026-10-20): the flame is now drawn as nested, cel-shaded billows in the painted-campfire palette
  // (`fire-billow-geometry.js`). The old `color` tint (#ffe7b8 multiplied blue by 3.4), `brightness`, `perspective`,
  // `animationSpeed` and the whole flame/smoke tuning set were retired with the sprites they tuned — see
  // `fire-billow-params.js` for why their stored values must not be handed to a different machine.
  flameTint: {
    type: 'color',
    space: 'srgb',
    default: '#ffffff',
    category: 'Look',
    label: 'Flame tint',
    help: 'Multiplies the flame’s colours. White leaves the painted-campfire palette exactly as it is; a colour pulls the whole flame toward it. (For a whole new fire colour — green alchemy, blue foxfire — use Hue shift instead.)',
  },
  posterize: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.62,
    category: 'Look',
    label: 'Banding',
    help: 'How hard the colour steps between temperature bands. 0 is a smooth photographic ramp; 1 is flat cel-shaded bands.',
  },
  bandCount: {
    type: 'int',
    min: 3,
    max: 12,
    step: 1,
    default: 5,
    category: 'Look',
    label: 'Band count',
    help: 'How many distinct colour steps the banding uses once Banding is above 0. The painted campfires use about five (cream, yellow, amber, orange, deep orange). Fewer reads as more stylised.',
  },
  colorHueShift: {
    type: 'float',
    min: -180,
    max: 180,
    step: 1,
    default: -3, // 2026-10-17 author's live-tuned defaults (was -6)
    category: 'Look',
    label: 'Hue shift',
    help: 'Rotates the flame, embers and smoke around the colour wheel together — the way to get a green alchemical fire or a blue foxfire without hand-picking every stop. Adds to whatever the chosen Fuel already contributes (magical fuel carries its own built-in 180° shift). ±180° already covers the whole wheel in either direction; there is no further edge to push past.',
  },
  flameShading: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    category: 'Look',
    label: 'Billow shading',
    help: 'The lit and shaded crescents along each billow’s edge, which are what make the flame read as rolling volumes rather than a flat cut-out. 0 is flat; 1 is heavily modelled.',
  },
  flameRagged: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Edge raggedness',
    help: 'How rough the painted edge of the flame is: the brush-stroke wobble along every outline. 0 is a clean vector edge.',
  },
  flameGlow: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Flame glow',
    help: 'The faint orange halo around the flame (it also feeds the bloom). The fire’s real light on the room is the Light category.',
  },
  coalGlow: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Coal glow',
    help: 'How strongly the bed of coals glows through its cracks — round the edge of a burning fire, and as the whole fire once the flame is out.',
  },
  bloomCounter: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Counter scene bloom',
    help: 'The scene’s bloom adds its glow on top of everything bright, and left alone it washes a painted flame out to flat yellow-white. At 1 the flame is painted pre-darkened by exactly what the live bloom will add back, so the painted colours (cream, amber, orange) come out as drawn, and it is unchanged if the bloom is off. At 0 the flame is left to the bloom.',
  },

  // ── Flame ─────────────────────────────────────────────────────────────────
  flameSize: {
    type: 'float',
    min: 0.2,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Flame',
    label: 'Flame size ×',
    help: 'How wide the flame is, as a multiple of what the painted fire’s own width implies. 1 matches the painted campfires’ flame-to-logs proportion.',
  },
  flameHeight: {
    type: 'float',
    min: 0.1,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Flame',
    label: 'Flame height ×',
    help: 'How tall the flame stands (outdoors a fire stands about twice as tall as in a sealed room, by itself). From above this shows as the flame rising up the page and as parallax; from the side it is the whole flame.',
  },
  flameLick: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Flame',
    label: 'Licking tongues ×',
    help: 'How many secondary tongues curl out of the body, and how far. A calm hearth has few; a bonfire in wind has many. 0 is a single compact flame.',
  },
  flameWindLean: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Flame',
    label: 'Wind lean ×',
    help: 'How far wind bends and streams the flame. At 1 a hurricane lays the flame nearly flat and tears it into flecks. Only wind that actually reaches the fire leans it (see Wind response); a fire beside a wall leans less.',
  },
  flameFlecks: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Flame',
    label: 'Flecks ×',
    help: 'The little orange flecks that fly off the flame’s edge. Wind throws more of them, further.',
  },
  flameDetail: {
    type: 'float',
    min: 0.3,
    max: 1.5,
    step: 0.05,
    default: 1,
    category: 'Flame',
    label: 'Billow detail ×',
    help: 'How many billows build the flame. Fewer is cheaper and chunkier; more is finer. (The quality setting scales this as well.)',
  },
  flameSpeed: {
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Flame',
    label: 'Speed',
    help: 'How fast the fire itself moves: the billows rolling, the tongues licking, the smoke climbing. 1 is the natural pace for its size (a big fire breathes slower than a small one).',
  },

  // ── Ember ─────────────────────────────────────────────────────────────────
  emberCount: {
    type: 'float',
    min: 0,
    max: 500,
    step: 1,
    default: 1, // 2026-10-20 new defaults (was 3)
    category: 'Ember',
    label: 'Ember count',
    help: 'Sparks per fire. V2 ran about 95 for a whole floor.',
  },
  emberSizeScale: {
    type: 'float',
    min: 0.02,
    max: 100,
    step: 0.02,
    default: 4.78, // 2026-10-17 author's live-tuned defaults (was 1.8)
    category: 'Ember',
    label: 'Ember size ×',
    help: 'Base is 2.3-8.7 world px — already a third of V2’s own, at the author’s request.',
  },
  // ⚠️ LIFE/CHAOS/RISE ARE ALL WIND0/WIND1 PAIRS, 2026-09-04 — author: *"embers need investigating... chaotic rising
  // embers at wind 0 and wind driven embers at high wind values that move sideways and not upwards."* The shipped
  // defaults split exactly that way, but every range is wide enough to push the balance the other way entirely.
  emberLifeAtWind0: {
    type: 'float',
    min: 0.05,
    max: 200,
    step: 0.05,
    default: 0.75, // 2026-10-17 author's live-tuned defaults (was 8.6)
    category: 'Ember',
    label: 'Ember lifetime × (Wind 0)',
    help: 'How long a spark survives in still air. Longer lives let embers travel further before dying.',
  },
  emberLifeAtWind1: {
    type: 'float',
    min: 0.05,
    max: 200,
    step: 0.05,
    default: 1.55, // 2026-10-20 new defaults (was 9.55)
    category: 'Ember',
    label: 'Ember lifetime × (Wind 1)',
    help: 'The same, for a spark in full wind exposure. Higher than Wind 0 by default — a wind-blown ember gets a little longer to travel sideways before it dies. Set equal to Wind 0 to turn off wind-driven lifespan change entirely.',
  },
  emberChaosAtWind0: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 30.7, // 2026-10-20 new defaults (was 14.15)
    category: 'Ember',
    label: 'Ember chaos × (Wind 0)',
    help: 'Strength of the swirling flow that pushes embers around in still air. 0 leaves them drifting only with wind.',
  },
  emberChaosAtWind1: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 2.3, // 2026-10-20 new defaults (was 68)
    category: 'Ember',
    label: 'Ember chaos × (Wind 1)',
    help: 'The same, for an ember in full wind exposure. Lower than Wind 0 by default, so a real gale reads as WIND-DRIVEN motion rather than random swirl — raise it back up if you want embers to stay chaotic even in a storm.',
  },
  emberRiseAtWind0: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 0.1, // 2026-10-17 author's live-tuned defaults (was 1.5)
    category: 'Ember',
    label: 'Ember rise × (Wind 0)',
    help: 'How fast embers climb in still air. Height drives the perspective effect, so this also controls how much they grow and splay outward as they go.',
  },
  emberRiseAtWind1: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 0.05, // 2026-10-20 new defaults (was 0)
    category: 'Ember',
    label: 'Ember rise × (Wind 1)',
    help: "The same, for an ember in full wind exposure. Held low by default so wind-driven embers read as moving SIDEWAYS rather than climbing — raise it back toward Wind 0's value if you want embers to keep rising even in a gale.",
  },
  emberWindPush: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 1.9, // 2026-10-20 new defaults (was 200)
    category: 'Ember',
    label: 'Ember wind push ×',
    help: "How hard wind physically shoves embers sideways, on top of the engine's own baked-in guarantee that full wind moves an ember many times its own (tiny) size. 1 = exactly that guarantee; higher throws sparks further, lower keeps them closer even in a gale. A spark is launched from the fuel and the wind takes hold as it ages. Only affects embers actually exposed to wind (see the Response category).",
  },
  emberStreak: {
    type: 'float',
    min: 0,
    max: 5,
    step: 0.05,
    default: 1,
    category: 'Ember',
    label: 'Ember streak ×',
    help: 'Stretches each spark along its own direction of travel, like a short camera shutter: a wind-blown ember reads as a streak of light, a drifting one as a dot. 0 = round dots always.',
  },
  emberEmission: {
    type: 'float',
    min: 0,
    max: 250,
    step: 0.1,
    default: 5.5, // 2026-10-17 author's live-tuned defaults (was 50)
    category: 'Ember',
    label: 'Ember brightness ×',
    help: 'Embers are ~8x hotter than flames by design — that ratio is what makes a tiny dot read as a spark rather than a speck.',
  },
  // ⚠️ INDOOR SUPPRESSION (2026-09-07) — author: "the ability to suppress embers and smoke by a lot if that fire is
  // indoors... start by suppressing each by 90%, make them live 15% as long." Gated by `fires[].outdoors01`
  // (boot.js#sampleWindExposureAt, the `_Outdoors` mask) — 0 under a roof, 1 under open sky; per fire since 2026-10-16
  // (`dropIndoorSpawnPoints`), the lifetime scale still aggregated map-wide.
  emberIndoorSuppression: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Ember',
    label: 'Indoor suppression',
    help: 'How much this fire’s ember count is cut once it is fully indoors (under a roof). Default 1: indoor fires make no embers at all; only outdoor fires do. 0 leaves indoor embers untouched. Blends with how indoors the fire actually is, so a hearth just inside an open doorway is cut less than one deep in a sealed room.',
  },
  emberIndoorLifeScale: {
    type: 'float',
    min: 0.05,
    max: 30,
    step: 0.05,
    default: 0.15,
    category: 'Ember',
    label: 'Indoor lifetime ×',
    help: 'Multiplies ember lifetime once this fire is fully indoors, on top of whatever the Wind 0/Wind 1 lifetime dials already give — lower makes sparks die almost the instant they leave the fuel bed instead of drifting across a room they have no draft to cross. 1 leaves indoor embers living exactly as long as outdoor ones.',
  },
  spitRate: {
    type: 'float',
    min: 0,
    max: 6,
    step: 0.05,
    default: 1,
    category: 'Ember',
    label: 'Spitting embers ×',
    help: 'The HEAVY embers: chunks of burning wood the fire spits out in an arc, which land and smoulder on the ground for a long while (rain hisses them out, wind makes them flare). Different from the light sparks that spiral upward. Outdoors more than in; 0 turns them off.',
  },
  spitSize: {
    type: 'float',
    min: 0.2,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Ember',
    label: 'Spitting ember size ×',
    help: 'How big the landed chunks are.',
  },

  // ── Smoke ─────────────────────────────────────────────────────────────────
  smokeDensity: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke amount ×',
    help: 'How much smoke the fire makes, on top of what its size and fuel already imply (a bonfire smokes, a clean hearth barely does, oil billows). 0 turns it off. Rained on, a fire makes MORE — white steam.',
  },
  smokeSize: {
    type: 'float',
    min: 0.2,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke size ×',
    help: 'How big each billow of smoke is. A plume SHOULD outgrow the fire that made it.',
  },
  smokeHeight: {
    type: 'float',
    min: 0.1,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke height ×',
    help: 'How far the plume climbs before it thins away. From above this is how far up the page it reaches.',
  },
  smokeDrift: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke wind drift ×',
    help: 'How far the wind carries the plume sideways. At full wind it streams away in a long ribbon.',
  },
  smokeThickness: {
    type: 'float',
    min: 0,
    max: 1.5,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke thickness ×',
    help: 'How solid the smoke is. It hides what is under it more the thicker it gets.',
  },
  smokeSoot: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.2,
    category: 'Smoke',
    label: 'Smoke soot',
    help: 'How dirty the smoke runs: 0 is the painted maps’ pale warm white, 1 is black wood-smoke. Oil and coal add their own soot on top.',
  },

  // ── Depth ─────────────────────────────────────────────────────────────────
  heightParallax: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Depth',
    label: 'Height parallax',
    help: 'How strongly height moves a flame toward or away from the middle of the screen — what V2’s perspective camera did. It is why a tall flame leans away from the view centre when you pan. 0 is perfectly flat.',
  },
  heightTilt: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.3,
    category: 'Depth',
    label: 'Height tilt',
    help: 'How far height lifts the flame UP THE PAGE: the 3/4 view the painted campfires are drawn in. 0 is straight down (a tall flame is invisible from above); higher shows more of its height.',
  },

  // ── Light ─────────────────────────────────────────────────────────────────
  lightEnabled: {
    type: 'bool',
    default: true,
    category: 'Light',
    label: 'Cast light',
    help: 'Whether this fire lights the scene. Turning it off is by far the biggest performance saving fire offers — a fire costs what its LIGHT costs.',
  },
  lightRadiusScale: {
    type: 'float',
    min: 0.25,
    max: 3,
    step: 0.05,
    default: 2.3, // 2026-10-20 new defaults (was 3)
    category: 'Light',
    label: 'Light reach',
    // ⚠️ NOT WIDENED IN THE 2026-09-04 ROH RANGE PASS, DELIBERATELY — this one has a REAL, EXPLAINED cost curve
    // ("doubling it roughly quadruples the light's cost"), not an arbitrary ceiling.
    help: "Scales the light radius the fire's size already implies. This is the single most expensive number in the effect — doubling it roughly quadruples the light's cost.",
  },
  lightColor: {
    type: 'color',
    space: 'srgb',
    default: '#ffa047', // 2026-10-17 author's live-tuned defaults (was #fe7e06)
    category: 'Light',
    label: 'Light colour',
    help: "The colour this fire throws into the room, separate from the flame's own tint.",
  },

  // ── Motion ────────────────────────────────────────────────────────────────
  windResponse: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.3, // 2026-10-20 new defaults (was 1)
    category: 'Motion',
    label: 'Wind response',
    help: 'How much wind reaches this fire at all — the master gate every other wind dial (Wind lean, ember wind push, the Wind 1 values) multiplies against. At 0 this fire ignores wind entirely. A small fire reaches full response at a lower wind speed than a bonfire does; above 1 a fire reaches it at a gentler breeze still.',
  },
  draftStrength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Indoor drafts ×',
    help: 'A fire in a sealed room still feels a draft now and then: a soft puff that leans the flame and makes it dip. This is how strong those are. (A room that opens to the outside feels the real wind instead, through Wind response.)',
  },

  // ── Response ──────────────────────────────────────────────────────────────
  weatherResponse: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.25, // 2026-10-20 new defaults (was 1)
    category: 'Response',
    label: 'Weather response',
    help: 'How much rain and wind put this fire under stress. At 1 a full gale bends it, shrinks it and makes it gutter, full rain dampens and cools it, and the two together leave it small, dim and barely surviving. At 0 it burns regardless. Rain only reaches fire under open sky, wind only fire that wind reaches. Does NOT weaken how far wind leans the flame (that is Wind response).',
  },
  rainResponse: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 2, // 2026-10-20 new defaults (was 1)
    category: 'Response',
    label: 'Rain response',
    help: 'On top of Weather response: how hard rain douses this fire. 0 = rain does nothing to it (wind still does); 2 = even a drizzle soaks it quickly. Gated by the Outdoors mask per spot, so a roofed hearth stays dry while a campfire in the open does not.',
  },
  canBeSnuffed: {
    type: 'bool',
    default: true,
    category: 'Response',
    label: 'Can blow out',
    help: 'Whether wind and rain can put this fire out. Off, the fire feels only a quarter of the rain and keeps a floor of flame: still bent and flickering, but it never goes out.',
  },
  douseSec: {
    type: 'float',
    min: 2,
    max: 600,
    step: 1,
    default: 28,
    category: 'Response',
    label: 'Rain douse time (s)',
    help: 'Seconds of full rain it takes to soak an open-air fire through and put it out. A light drizzle takes proportionally longer, and the flame only recovers while it dries if the rain stops first.',
  },
  smoulderSec: {
    type: 'float',
    min: 5,
    max: 7200,
    step: 5,
    default: 150,
    category: 'Response',
    label: 'Smoulder time (s)',
    help: 'How long the coals of a put-out fire stay hot, fading from orange to coal red to cold ash. Rain hisses them out up to four times faster.',
  },
  rekindle: {
    type: 'bool',
    default: true,
    category: 'Response',
    label: 'Relights after a dry spell',
    help: 'Whether a put-out fire comes back on its own. It waits out the delay below (counted only while it is dry), then the coals glint, glow, and the flame coughs back to life, very slowly.',
  },
  rekindleDelaySec: {
    type: 'float',
    min: 10,
    max: 86400,
    step: 10,
    default: 900,
    category: 'Response',
    label: 'Relight delay (s)',
    help: 'How long a dead fire stays cold, in dry weather, before it starts coming back. (900 s = 15 minutes.)',
  },
  rekindleRampSec: {
    type: 'float',
    min: 10,
    max: 7200,
    step: 10,
    default: 420,
    category: 'Response',
    label: 'Relight time (s)',
    help: 'How long the comeback takes, from the first glint to a full flame.',
  },
});

/**
 * THE MANIFEST.
 *
 * ⚠️ `photosensitive: TRUE`, unlike the candle's. A candle flame is a small,
 * gentle flicker; a large fire pulses its whole cast light at a real vortex-
 * shedding frequency, and at campfire scale that lands near 1.5 Hz across a
 * significant fraction of the screen. That is squarely in the range the
 * accessibility hard-off exists for (`effect-settings.js`'s
 * `reducePhotosensitive`), and it is not a judgement call this effect gets to
 * make for its viewer.
 */
export const FIRE = Object.freeze({
  id: 'fire',
  title: 'Fire',
  visualWeight: 1.0,
  a11y: Object.freeze({ photosensitive: true }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why: 'Builds its flame/ember/smoke particle engines lazily on the first sync that has something to burn (ensureEngines) — real first-run work, but SYNCHRONOUS, with no pending window a probe could observe, and a "has it built yet?" flag would hold readiness open forever on a scene with no fire in it. It is covered globally instead, and well: each engine’s TSL compute kernels grow the pipeline set, which is precisely the class renderer.compileAsync(scene, camera) structurally cannot reach and precisely what settle.js’s pipeline-growth criterion was added to catch.',
  }),
  params: FIRE_PARAMS,
  authoring: Object.freeze({ paint: 'fire' }),

  /**
   * ⚠️ REWRITTEN 2026-08-29 — the six `adds` strings below used to describe a
   * volumetric slab-integral material (sheets/slices/billow-fold/banding) that
   * `fire-subsystem.js`'s own header says was fully replaced by the sprite/
   * particle system on 2026-08-09. That material (`fire-render.js#
   * buildFireMaterial`, `fireSlabPlan`/`fireSliceTable` in this file's sibling
   * `fire-geometry.js`) still exists in source and still passes its own tests,
   * but is never imported by `vt-pan-viewer.js` or `boot.js` — it is not what
   * ships. See docs/planning/Effect-Tier-Gradient-Audit-2026-08-29.md §3.2 for
   * the audit that found the mismatch.
   *
   * WHAT ACTUALLY RUNS, per rung, is THREE levers read from `fireTierPlan`
   * (`fire-geometry.js`) — `plan.clusterFactor` (how aggressively nearby fires'
   * lights merge into one draw, via `clusterFireSources`); `tier` itself,
   * separately clamped to `animation.quality` 0..2 (the shared candle-flicker
   * ladder: 0 plain, 1 chaotic guttering, 2 lean/oval/boiling edge) — see
   * `buildFireLightSources`'s own two call sites; and, ADDED 2026-08-30,
   * `plan.spriteCountScale` (the flame/ember/smoke particle budget PER FIRE,
   * `fire-subsystem.js`'s own `activeCount` — the sprite layer's dominant
   * per-frame cost, and until this date the one thing about fire that never
   * varied by profile at all). `FIRE_TIER_PLANS`' remaining fields
   * (`sheets`/`maxSlices`/`octaveCap`/`bands`/`smoke`/`shear`) stay DEAD in
   * the live path — real values, consumed only by the orphaned volumetric
   * material and its own tests. Because `Math.floor(tier)` clamps into `0..2`,
   * `animation.quality` reaches its own maximum at rung 2; `spriteCountScale`
   * reaches ITS OWN ceiling (1.0 — today's shipped `PER_FIRE` density,
   * unchanged) at rung 3 — so rungs 3 through 5 differ from each other ONLY
   * in clusterFactor, but rungs 0 through 3 each genuinely move on more than
   * one axis.
   *
   * ⚠️ `estMsPerMp` BELOW IS STALE, KNOWINGLY LEFT RATHER THAN INVENTED. The
   * original numbers were genuinely measured (`tools/shader-lab/bench-
   * fire.js#octave-cost-curve`, a real 3-octave 3D fBm bench) — but they
   * measured the RETIRED material's noise cost, which no longer executes. The
   * real cost driver today — light/draw-call count via `clusterFactor` — has
   * never been separately benched. Overwriting these with fabricated numbers
   * would be a worse lie than a labelled-stale true one
   * (`feedback_instruments_must_not_lie`); a real bench is the honest fix,
   * not a guess with more decimal places.
   *
   * ⚠️ RUNG 0 IS C8 AND THAT IS LEGAL — the monotonic-cost check starts at i=2
   * (`effect-manifest.js:194`), the same shape water uses. A fire that emits no
   * light reads as BROKEN rather than as simple, so the light is in the floor.
   */
  tiers: Object.freeze([
    {
      n: 0,
      name: 'hearth',
      cost: { class: 'C8', estMsPerMp: 0.05 },
      adds:
        'one flame/ember/smoke sprite cluster at 35% of the shipped per-fire density, lit by ONE clustered ' +
        'light merging every fire within a wide radius (clusterFactor 2.0 — the most aggressive merge of any ' +
        'rung), animating on the plain (quality 0) puff clock — right place, right size, lights the room as ' +
        'cheaply as this effect ever gets while still emitting light at all',
    },
    {
      n: 1,
      name: 'billow',
      fromProfile: 'low',
      cost: { class: 'C1', estMsPerMp: 0.14 },
      adds:
        'sprite density rises to 60% of shipped, lights merge less aggressively (clusterFactor 1.5) and the ' +
        'puff clock steps up to chaotic guttering (quality 1)',
    },
    {
      n: 2,
      name: 'plume',
      fromProfile: 'performance',
      cost: { class: 'C1', estMsPerMp: 0.29 },
      adds:
        'sprite density rises to 80% of shipped, clusterFactor drops to 1.0, and the puff clock reaches its ' +
        'own ceiling — full lean/oval/boiling-edge animation (quality 2), the most this effect ever animates.',
    },
    {
      n: 3,
      name: 'smoke',
      fromProfile: 'standard',
      cost: { class: 'C1', estMsPerMp: 0.45 },
      adds:
        'sprite density reaches its own ceiling — 100% of the shipped per-fire count, unchanged above this ' +
        'rung — and clusterFactor drops to 0.6 — noticeably fewer fires now share one light than at the ' +
        'default profile just below. Every rung above this one differs only in clusterFactor.',
    },
    // ⚠️ ONE RUNG PER PROFILE FROM HERE, and that is not cosmetic. An earlier
    // version put `smoke` AND `flicker` both at `standard`, so the default
    // profile resolved to rung 4 while `FIRE_DEFAULT_TIER` said 3 — the
    // fallback for a malformed tier would have shown a different fire from the
    // one every default install gets. The anti-drift test in
    // `__tests__/fire.test.mjs` caught it, which is exactly what it is for.
    {
      n: 4,
      name: 'flicker',
      fromProfile: 'quality',
      cost: { class: 'C3', estMsPerMp: 0.49 },
      adds: 'clusterFactor drops to 0.5',
    },
    {
      n: 5,
      name: 'inferno',
      fromProfile: 'extreme',
      cost: { class: 'C8', estMsPerMp: 0.7 },
      adds: 'clusterFactor reaches its own floor, 0.35 — fires stop sharing lights almost entirely, each one close to its own',
    },
  ]),

  /** Recorded, genuinely not built — the list this effect is judged against.
   * ⚠️ 'smoke-as-a-second-pass' REMOVED (2026-09-14, mythica-machina-press#49)
   * — stale, not merely unbuilt: smoke has been its own separate, genuinely
   * NormalBlending-composited mesh/material/draw call for a while now
   * (`fire-particle-runtime.js`'s own `KINDS.smoke.additive: false`,
   * `fire-subsystem.js`'s `renderOrder` note on why smoke draws over the
   * additive flame/embers) — this note described the pre-fix state and was
   * never updated once the fix landed. The real remaining gap in that same
   * issue (smoke's buoyancy never being deflected around nearby walls the
   * way its wind-driven motion already is) is fixed in the same commit that
   * removed this note. */
  deferredRungs: Object.freeze([
    {
      name: 'embers-and-sparks',
      note: "Via the shared ParticleArena and SPAWN_KINDS.extracted, which was explicitly designed for fire spawn points. Must add ZERO new storage buffers — the arena already uses 6 of WebGPU's guaranteed 8.",
    },
    {
      name: 'coal-bed',
      note: "The glowing fuel under the flames. V2's was 667 lines and 32 uniforms and was the thing that made a campfire read as a campfire when the flames were low; the redesign is Worley chunks plus the same banded ramp at low temperature.",
    },
    {
      name: 'room-smoke-fill',
      note: 'Belongs in world/smoke-field.js as a sibling of wind-field.js, not inside this effect — windows, lighting and vision all want to read it. Needs a ROOM concept the codebase does not have yet (the outdoors mask and skyReach exist; segmentation does not). C7, gated on coverage per Law 7.',
    },
    {
      name: 'fire-whirl',
      note: "A rotate2d on the noise coordinate as a function of height gives spiralling lobes. Uniquely legible from directly above, which is exactly this renderer's camera.",
    },
  ]),
});
