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
    help: 'How hard everything burns. Above 1 pushes hotter and brighter; below 1 banks it down toward embers.',
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
    // ⚠️ NOT WIDENED IN THE 2026-09-04 ROH RANGE PASS — this is a threshold
    // against a NORMALISED [0,1] paint value, not a reference multiplier;
    // 0.6 already means "requires very bold, solid paint", and nothing past
    // 1 can ever mean anything (no paint value exceeds 1). A real definitional
    // bound, not an arbitrary ratchet.
    // ⚠️ 0.05, NOT 0.2 (2026-08-16, author live on Tower Bridge — the real
    // multi-blob `_Fire.webp` in example_map/, ~20 painted regions). At 0.2
    // only 3 of the ~20 valid areas produced flame particles; the rest are
    // faint/small strokes (a few native px wide, well inside a ~20-29 px-per-
    // texel derived grid) that a bolder threshold simply never sees. 0.05
    // lit every one of them. See fire-mask.js's own MIN_PEAK_TEXELS/
    // PAINT_THRESHOLD headers — real authored fire is routinely this small.
    default: 0.05,
    category: 'Presence',
    label: 'Mask sensitivity',
    help: 'How much of the painted fire mask counts as real paint before a fire registers there. LOWER catches fainter or smaller painted strokes — turn this DOWN if fire you painted is not appearing. HIGHER requires bolder, more solid paint before a fire lights at all.',
  },

  // ── Look ──────────────────────────────────────────────────────────────────
  // ⚠️ FIXED, 2026-08-30 — `color`/`posterize`/`bandCount` were all SCHEMA-ONLY
  // on the live particle fire until today: `fireRuntimeFromParams` computed
  // `flameColor`/`posterize`/`bands` from them, but `fire-subsystem.js`'s
  // `sync()` never forwarded any of the three into `engine.setParams`, so
  // dragging any of them changed nothing (`feedback_unconsumed_api_rots_
  // silently` — the exact "reads the param, never uses the value" shape this
  // file's own `lightRadiusScale` note already names once). `brightness`
  // (below) is the one member of this category left deliberately dead —
  // "Fire intensity" (Presence) is already the live brightness control an
  // author reaches for; wiring a second one would just be two knobs for one
  // job. All three fixes below, plus the new `colorHueShift`, are the
  // "CC tool set" the author asked for on 2026-08-30. See fire-sprite.js
  // #buildFlameShading and fire-geometry.js#fireTintMul for the mechanism.
  color: {
    type: 'color',
    space: 'srgb',
    default: '#fdba35',
    category: 'Look',
    label: 'Flame tint',
    help: 'Tints the flame only — never the smoke, which is lit by the fire rather than made of it. The default matches the reference ramp’s own golden midpoint exactly, so it is a genuine no-op until you move it.',
  },
  posterize: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    // ⚠️ 0, NOT 0.85. This param's own default predates the particle rebuild
    // and was written for a volumetric material that no longer ships
    // (fire-render.js is orphaned — see fire.js's tiers doc above). Because
    // this was dead, every fire the author has already live-approved
    // (Tower Bridge included) was rendered at an EFFECTIVE posterize of 0 —
    // shipping the old 0.85 the moment this control came alive would have
    // silently reshaped every existing scene's fire into cel-shaded bands
    // nobody asked for. 0 preserves the smooth look already seen live; the
    // slider now genuinely bands the ramp for anyone who dials it up.
    default: 0,
    category: 'Look',
    label: 'Banding',
    help: 'How hard the colour steps between temperature bands. 0 is a smooth photographic ramp (today’s look); 1 is flat cel-shaded bands.',
  },
  bandCount: {
    type: 'int',
    min: 3,
    max: 12,
    step: 1,
    default: 8,
    category: 'Look',
    label: 'Band count',
    help: 'How many distinct colour steps the banding uses once Banding is above 0. Fewer reads as more stylised.',
  },
  colorHueShift: {
    type: 'float',
    min: -180,
    max: 180,
    step: 1,
    default: 0,
    category: 'Look',
    label: 'Hue shift',
    help: 'Rotates the flame, embers and smoke around the colour wheel together — the way to get a green alchemical fire or a blue foxfire without hand-picking every stop. Adds to whatever the chosen Fuel already contributes (magical fuel carries its own built-in 180° shift). ±180° already covers the whole wheel in either direction; there is no further edge to push past.',
  },
  brightness: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 0.25,
    category: 'Look',
    label: 'Flame brightness',
    help: 'Master brightness for the flame itself. Push it too far and the banding blows out into a flat disc.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // THE TUNING SET (2026-08-09) — the author drives the look from here.
  //
  // ⚠️ EVERY RANGE HERE IS DELIBERATELY ABSURD, AND THAT IS THE REQUIREMENT.
  // Author: *"give me lots of controls... critically I want you to give me
  // extremely wide ranges for everything. I'll find better values for you."*
  // A slider that cannot reach the answer is worse than no slider — it quietly
  // rules out the region the answer was in. So these span far past anything
  // plausible in both directions, and the DEFAULT of every multiplier is 1.0,
  // meaning "exactly the V2-derived constant". A value is therefore always
  // readable as a distance from the reference rather than an absolute nobody
  // can calibrate.
  // ══════════════════════════════════════════════════════════════════════════

  // ── Flame ─────────────────────────────────────────────────────────────────
  flameCount: {
    type: 'float',
    min: 0,
    max: 500,
    step: 1,
    default: 20,
    category: 'Flame',
    label: 'Flame count',
    help: 'Flame sprites per fire, PER ARCHETYPE — there are four, so the real total is four times this. V2 ran about 51 for a whole floor.',
  },
  // ⚠️ SPLIT INTO A WIND0/WIND1 PAIR, 2026-09-04 (was a single `flameLifeScale`)
  // — author: "two separate controls for each element for Wind being 0 and
  // wind being 1, we blend between those two so that I can fine tune what it
  // looks like in both setups." Blended per-particle against how exposed
  // THIS flame's own spawn point is to wind right now — not the map-wide
  // dial — so a hearth tucked out of the wind keeps its Wind 0 character
  // even while an exposed one nearby is already reading Wind 1.
  flameLifeAtWind0: {
    type: 'float',
    min: 0.05,
    max: 60,
    step: 0.05,
    default: 2.8,
    category: 'Flame',
    label: 'Flame lifetime × (Wind 0)',
    help: 'Multiplies how long each flame sprite lives (base 2.4-4.2s) in still air. Short lives read as puffs that vanish; long ones as a steady body of fire.',
  },
  flameLifeAtWind1: {
    type: 'float',
    min: 0.05,
    max: 200,
    step: 0.05,
    default: 1.5,
    category: 'Flame',
    label: 'Flame lifetime × (Wind 1)',
    help: 'The same multiplier, but for a flame sitting in full wind exposure. Lower than the Wind 0 value reads as guttering — quick, flickery puffs instead of a steady body of fire. Set equal to Wind 0 to turn off wind-driven lifespan change entirely.',
  },
  flameSizeScale: {
    type: 'float',
    min: 0.02,
    max: 100,
    step: 0.02,
    default: 0.52,
    category: 'Flame',
    label: 'Flame size ×',
    help: 'Multiplies sprite size on top of the automatic scaling to the fire’s painted width.',
  },
  flameOpacity: {
    type: 'float',
    min: 0,
    max: 50,
    step: 0.05,
    default: 1.5,
    category: 'Flame',
    label: 'Flame opacity ×',
    help: 'How solid each flame sprite is. Raise this if the fire looks thin or washed out.',
  },
  flameEmission: {
    type: 'float',
    min: 0,
    max: 250,
    step: 0.1,
    default: 23.9,
    category: 'Flame',
    label: 'Flame emission ×',
    help: 'Raw brightness of the flame colour. Above about 3 the hues start saturating toward white where sprites overlap — that is the "white blur" failure.',
  },
  flameColorAge: {
    type: 'float',
    min: 0.1,
    max: 30,
    step: 0.05,
    default: 12,
    category: 'Flame',
    label: 'Colour cooling rate',
    help: 'How fast a sprite walks down the reference ramp. LOW = stays pale/white-hot for most of its life. HIGH = drops to deep orange and rust almost immediately. This is the orange-vs-white dial.',
  },
  flameSpawnBias: {
    type: 'float',
    min: -20,
    max: 20,
    step: 0.1,
    default: 2.5,
    category: 'Flame',
    label: 'Spawn brightness bias',
    help: 'Which painted texels flames prefer to spawn on. 0 = evenly across every painted texel, matching intensity to shade. Positive pulls spawns toward the brightest paint; negative toward the darkest. Saturates well before the ends of the range — no need to reach them.',
  },
  flameCohesion: {
    type: 'float',
    min: -2,
    max: 3,
    step: 0.02,
    // ⚠️ NOT 0 (2026-08-17, author-confirmed live on Tower Bridge after the
    // label-scoped rebuild — see `fire-spawn-points.js#applyCohesion`'s own
    // header). Cohesion used to default OFF because "belongs to" was a
    // raw-distance guess that could pull one fire's flames toward a
    // different, disconnected fire; it is now a structural per-blob
    // guarantee, so a real default that actually gives every fire a visible
    // hot core is the correct ship state, not an opt-in experiment. Retuned
    // to 0.66 in the 2026-08-27 author preset pass.
    default: 0.66,
    category: 'Flame',
    label: 'Cohesion (pull together)',
    help: 'Pulls every flame toward the brightest part of its own fire. 0 = spawns spread across the full painted shape. 1 = every flame collapses onto that single hottest point. Negative pushes flames apart instead, beyond their painted region.',
  },
  flameWindPush: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 1,
    category: 'Flame',
    label: 'Flame wind push ×',
    help: "How hard wind physically shoves flame sideways, on top of the engine's own baked-in guarantee that full wind moves a flame several times its own size. 1 = exactly that guarantee; higher throws flame further, lower holds it closer to the hearth even in a gale. Only affects flame that is actually exposed to wind (see the Response category) — sheltered flame is untouched regardless of this dial.",
  },

  // ── Ember ─────────────────────────────────────────────────────────────────
  emberCount: {
    type: 'float',
    min: 0,
    max: 500,
    step: 1,
    default: 39,
    category: 'Ember',
    label: 'Ember count',
    help: 'Sparks per fire. V2 ran about 95 for a whole floor.',
  },
  emberSizeScale: {
    type: 'float',
    min: 0.02,
    max: 100,
    step: 0.02,
    default: 0.52,
    category: 'Ember',
    label: 'Ember size ×',
    help: 'Base is 2.3-8.7 world px — already a third of V2’s own, at the author’s request.',
  },
  // ⚠️ LIFE/CHAOS/RISE ARE ALL WIND0/WIND1 PAIRS, 2026-09-04 (were single
  // `emberLifeScale`/`emberChaos`/`emberRise` dials) — same mechanism as
  // flame's `flameLifeAtWind0`/`flameLifeAtWind1`, see that pair's own note.
  // Author: *"embers need investigating and adding into this system too so
  // that I can get chaotic rising embers at wind 0 and wind driven embers at
  // high wind values that move sideways and not upwards."* The shipped
  // defaults do exactly that split — high chaos/rise at Wind 0, low at
  // Wind 1 — but every range is wide enough to push the balance the other
  // way entirely.
  emberLifeAtWind0: {
    type: 'float',
    min: 0.05,
    max: 200,
    step: 0.05,
    default: 0.45,
    category: 'Ember',
    label: 'Ember lifetime × (Wind 0)',
    help: 'How long a spark survives in still air. Longer lives let embers travel further before dying.',
  },
  emberLifeAtWind1: {
    type: 'float',
    min: 0.05,
    max: 200,
    step: 0.05,
    default: 0.7,
    category: 'Ember',
    label: 'Ember lifetime × (Wind 1)',
    help: 'The same, for a spark in full wind exposure. Higher than Wind 0 by default — a wind-blown ember gets a little longer to travel sideways before it dies. Set equal to Wind 0 to turn off wind-driven lifespan change entirely.',
  },
  emberChaosAtWind0: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 6.2,
    category: 'Ember',
    label: 'Ember chaos × (Wind 0)',
    help: 'Strength of the swirling flow that pushes embers around in still air. 0 leaves them drifting only with wind.',
  },
  emberChaosAtWind1: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 1.5,
    category: 'Ember',
    label: 'Ember chaos × (Wind 1)',
    help: 'The same, for an ember in full wind exposure. Lower than Wind 0 by default, so a real gale reads as WIND-DRIVEN motion rather than random swirl — raise it back up if you want embers to stay chaotic even in a storm.',
  },
  emberRiseAtWind0: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 1,
    category: 'Ember',
    label: 'Ember rise × (Wind 0)',
    help: 'How fast embers climb in still air. Height drives the perspective effect, so this also controls how much they grow and splay outward as they go.',
  },
  emberRiseAtWind1: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 0.15,
    category: 'Ember',
    label: 'Ember rise × (Wind 1)',
    help: "The same, for an ember in full wind exposure. Held low by default so wind-driven embers read as moving SIDEWAYS rather than climbing — raise it back toward Wind 0's value if you want embers to keep rising even in a gale.",
  },
  emberWindPush: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 1,
    category: 'Ember',
    label: 'Ember wind push ×',
    help: "How hard wind physically shoves embers sideways, on top of the engine's own baked-in guarantee that full wind moves an ember many times its own (tiny) size. 1 = exactly that guarantee; higher throws sparks further, lower keeps them closer even in a gale. Only affects embers actually exposed to wind (see the Response category).",
  },
  emberEmission: {
    type: 'float',
    min: 0,
    max: 250,
    step: 0.1,
    default: 50,
    category: 'Ember',
    label: 'Ember brightness ×',
    help: 'Embers are ~8x hotter than flames by design — that ratio is what makes a tiny dot read as a spark rather than a speck.',
  },

  // ── Smoke ─────────────────────────────────────────────────────────────────
  smokeCount: {
    type: 'float',
    min: 0,
    max: 1000,
    step: 1,
    default: 24,
    category: 'Smoke',
    label: 'Smoke count',
    help: 'Smoke puffs per fire. V2 ran about 139 for a whole floor.',
  },
  smokeSizeScale: {
    type: 'float',
    min: 0.02,
    max: 100,
    step: 0.02,
    default: 1,
    category: 'Smoke',
    label: 'Smoke size ×',
    help: 'Base is 151-400 world px, and a plume SHOULD outgrow the fire that made it.',
  },
  smokeLifeScale: {
    type: 'float',
    min: 0.05,
    max: 200,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke lifetime ×',
    help: 'Longer-lived smoke drifts further and builds a denser column.',
  },
  smokeOpacity: {
    type: 'float',
    min: 0,
    max: 100,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke opacity ×',
    help: 'Smoke is the one layer that DARKENS the map rather than adding light, so this genuinely obscures what is beneath it.',
  },
  smokeGrowth: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke spread ×',
    help: 'How much a puff swells over its life. Base is a 10x expansion.',
  },
  smokeRise: {
    type: 'float',
    min: 0,
    max: 200,
    step: 0.05,
    default: 1,
    category: 'Smoke',
    label: 'Smoke rise ×',
    help: 'How fast smoke climbs, which drives its perspective growth and outward drift.',
  },

  // ── Depth ─────────────────────────────────────────────────────────────────
  perspective: {
    type: 'float',
    min: 0,
    max: 100,
    step: 0.05,
    default: 1,
    category: 'Depth',
    label: 'Perspective strength',
    help: 'Fakes V2’s perspective camera per particle: risen particles grow and splay away from the view centre. 1 = V2 exactly (camera 1000 units up). 0 = perfectly flat. Best judged while panning.',
  },

  // ── Detail ────────────────────────────────────────────────────────────────
  smokeAmount: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.05,
    category: 'Detail',
    label: 'Smoke',
    help: 'How much smoke this fire makes, on top of what its size already implies. 0 turns it off entirely.',
  },
  grain: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    category: 'Detail',
    label: 'Smoke grain',
    help: 'The dry-brush speckle and soot flecks through the smoke. The painted reference has quite a lot of this.',
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
    default: 1,
    category: 'Light',
    label: 'Light reach',
    // ⚠️ NOT WIDENED IN THE 2026-09-04 ROH RANGE PASS, DELIBERATELY — unlike
    // the tuning-set "×" dials, this one has a REAL, EXPLAINED cost curve
    // (own help text: "doubling it roughly quadruples the light's cost"), not
    // an arbitrary ceiling. A wider max here would be an invitation to a real
    // performance cliff, not "more room to find a look".
    help: "Scales the light radius the fire's size already implies. This is the single most expensive number in the effect — doubling it roughly quadruples the light's cost.",
  },
  lightColor: {
    type: 'color',
    space: 'srgb',
    default: '#fe7e06',
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
    default: 1,
    category: 'Motion',
    label: 'Wind response',
    help: 'How much wind reaches this fire at all — the master gate every other wind dial (Flame/Ember wind push, lifetime/chaos/rise Wind 1 values) multiplies against. At 0 this fire ignores wind entirely, at 2 it reacts to a fraction of the map wind other fires need. The lean grows with height on its own, so a tall fire streams further than a short one at the same setting.',
  },
  animationSpeed: {
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Speed',
    help: 'How fast the fire itself moves — the flame silhouette boiling and the turbulence carrying embers and smoke. Separate from the Life× dials (how long a particle survives) and the chaos/rise dials (how hard it gets pushed around).',
  },

  // ── Response ──────────────────────────────────────────────────────────────
  weatherResponse: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Response',
    label: 'Weather response',
    help: 'How much rain and wind affect this fire. At 1, rain cools and steams it and a hard enough gale blows it out; at 0 it burns regardless.',
  },
  canBeSnuffed: {
    type: 'bool',
    default: true,
    category: 'Response',
    label: 'Can blow out',
    help: 'Whether a strong enough wind can put this fire out. The threshold scales with size on its own — a lamp gutters in a breeze a bonfire ignores.',
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

  /** Recorded, genuinely not built — the list this effect is judged against. */
  deferredRungs: Object.freeze([
    {
      name: 'smoke-as-a-second-pass',
      note: "Smoke is drawn in the flame's ADDITIVE pass today, so it can only add light and reads as a warm haze rather than something that darkens the map beneath it. The correct shape is a second, alpha-blended pass — which is what V2 did (flame additive, smoke NormalBlending).",
    },
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
