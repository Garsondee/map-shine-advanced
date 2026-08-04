/**
 * SPECULAR — the declaration (manifest + params schema), pure data, no THREE.
 * Same split as bloom/candle/water: this file is Node-validatable; the TSL
 * builders live in sibling render modules with THREE injected, never imported.
 *
 * ============================================================================
 * ⚠️ THIS FILE USED TO ARGUE THE OPPOSITE. THE ARGUMENT WAS WRONG.
 * ============================================================================
 * Until 2026-07-27 this header claimed: *"A control survives here only if it is
 * a property of a MATERIAL or of the WORLD. Anything that is a property of a
 * noise generator is a symptom."* It justified that by asserting V2's thirty
 * shimmer sliders existed only to hand-build the angular variation an
 * orthographic camera deletes — *"restore the angles and every one becomes a
 * property of the paint."*
 *
 * **There are no angles to restore.** This is a strictly 2D engine over a flat
 * map: `N`, `V` and therefore `N·H` are one number for the entire screen, and
 * no parameter can change that. The effect built on that premise — GGX, Smith,
 * Schlick, a split-sum environment BRDF, a synthesised eye height — shipped
 * invisible FOUR times, each round correctly locating one more zero in a chain
 * of thirteen silent preconditions, and it was never going to converge.
 *
 * So the rule's justification collapses, and pattern controls are legitimate
 * here: **the pattern IS the deliverable.** What survives of the old rule is
 * only its COUNT — V2 shipped 61 controls, most of them the same nine repeated
 * three times with no way to tell which layer you were editing. This ships
 * thirteen top-level controls plus one repeated eight-control layer strip
 * (SIX layers since Round 19, 2026-08-03 — "double the number of things
 * causing the shines to appear" — up from three), each named for its
 * mechanism.
 *
 * This paragraph exists so a future session reads the correction before it
 * reads the doctrine and helpfully undoes the fix
 * (`feedback_plausible_diagnosis_rots`).
 *
 * ============================================================================
 * WHAT THE EFFECT IS
 * ============================================================================
 * An animated field of shimmers, gradients and patterns painted across the
 * metal the specular mask marks — sliding with the camera, evolving slowly in
 * time, responding to the scene's lighting and to indoors/outdoors. The mask is
 * read as **strength + tint**: darker paint is less shiny, and its hue says
 * which metal. V2's structure, on WebGPU, plus the one capability V2 never had
 * — per-island parallax, so each metal object feels like its own surface.
 *
 * @module effects/specular/specular
 */

/**
 * The knobs. Each is read by `effects/specular/specular-render.js` TODAY
 * (`params/no-dead-controls` fails the build otherwise), and that module's
 * exported defaults are the single source of truth for the values.
 */
export const SPECULAR_PARAMS = Object.freeze({
  // ── Look — the pattern's own shape and colour ────────────────────────────
  strength: {
    type: 'float',
    min: 0,
    max: 20,
    step: 0.01,
    // RAISED 1 → 20 = THE SCHEMA'S OWN MAX (2026-08-03, ROUND 18) — THE
    // FIRST LIVE-CONFIRMED DEFAULT this effect has ever shipped: the author
    // dialled this to its max on a real scene, alongside every other Round
    // 18 default below, and reported "we have a basic specular effect
    // working again." See `SPECULAR_DEFAULT_STRENGTH`'s own header
    // (specular-render.js) for the full account.
    default: 20,
    category: 'Look',
    label: 'Shine strength',
    help: 'Master strength of everything this effect draws. Turn it to 0 to see what the map looks like with no shine at all — turn it up past 5-10 to brute-force the shine through anything else that might be dimming it, as a diagnostic before reaching for the more targeted controls under Response.',
  },
  saturation: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    // RAISED 1.3 → 2 = THE SCHEMA'S OWN MAX (2026-08-03, ROUND 18) —
    // live-confirmed; see `strength`'s own comment above and
    // `SPECULAR_DEFAULT_SATURATION`'s header for the full account.
    default: 2,
    category: 'Look',
    label: 'Metal colour',
    help: "How much of the colour you painted into the specular mask survives into the shine. 0 makes every metal a neutral white sheen; 1 keeps gold gold and copper copper; above 1 pushes the colour further than you painted it — the default sits slightly above 1 to counteract the screen's own tonemap, which desaturates highlights as they brighten. This is the control that decides whether a map reads as treasure or as polished stone.",
  },
  shimmerGain: {
    type: 'float',
    min: 0,
    max: 40,
    step: 0.05,
    // LOWERED 5.5 → 2.2 (2026-08-03, ROUND 18) — live-confirmed; the ONE
    // control in this round's set that moved DOWN. See
    // `SPECULAR_DEFAULT_SHIMMER_GAIN`'s own header (specular-render.js) for
    // why: `sheenCeiling` below moved up a great deal this same round, so
    // the base shine now carries more of the look and needs less shimmer
    // modulation on top of it.
    default: 2.2,
    category: 'Look',
    label: 'Shimmer contrast',
    help: 'How far the moving patterns may brighten the metal above its resting shine. Low gives an even satin surface; high gives hard bright glints against darker metal, which is what reads as polished and slightly blown out. At 0 the metal still shines, it just stops moving.',
  },
  patternScalePx: {
    type: 'float',
    min: 512,
    max: 32768,
    step: 64,
    // LOWERED 16384 → 6528 (2026-08-03, ROUND 18) — live-confirmed; a
    // smaller scale means MORE cells across the same map, i.e. a busier,
    // finer field. See `SPECULAR_DEFAULT_PATTERN_SCALE_PX`'s own header.
    default: 6528,
    category: 'Look',
    label: 'Pattern size',
    help: 'How large the shimmer shapes are, measured across the MAP rather than the screen — so they stay the same physical size whether you are zoomed in or out. Large values give a few huge soft sweeps across the whole map; small values give many small busy ones. The fine glitter is not set here: that comes from how brightly you painted the mask.',
  },
  // ── Response — how this effect answers to the SCENE'S OWN LIGHT ─────────
  // Moved here from Look (2026-08-03, ROUND 17): `lightFloor` was always
  // about the effect's relationship to ambient light, not to how the pattern
  // itself looks — and it now has three siblings that answer the exact same
  // question ("how much does darkness suppress this"), so grouping them is
  // what "organised into sections" means here, not four scattered knobs that
  // each happen to touch brightness.
  lightFloor: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Response',
    label: 'Unlit shine',
    help: 'How much metal still catches the eye in a completely unlit room, with no torch, no lamp and no window light reaching it. Defaults to 0 — metal with nothing shining on it should genuinely go dark, the same as everything else on the map — but you can raise this for a stylised look where treasure never quite vanishes. Real light still lights real metal either way: a nearby torch or window brightens it exactly as it should, this only controls the floor underneath that.',
  },
  incidentSteepness: {
    type: 'float',
    min: 0.1,
    max: 8,
    step: 0.05,
    // LOWERED 3 → 2.85 (2026-08-03, ROUND 18) — live-confirmed; barely
    // moved from the Round 17 default, unlike several of its neighbours.
    default: 2.85,
    category: 'Response',
    label: 'Light response',
    // NEW (2026-08-03, ROUND 17) — exposes `SPECULAR_INCIDENT_STEEPNESS`
    // (`specular-pattern.js#steepenIncidentRgb`'s own header has the full
    // design and the arithmetic behind the shipped default). THE FIRST
    // CONTROL TO REACH FOR if the shine reads as globally too faint: the
    // channel probe that prompted this control showed the default (3)
    // crushing an ordinarily-lit point to under 1% of its properly-exposed
    // brightness — 1 removes that crush entirely (a pass-through, no
    // suppression beyond the scene's own exposure curve), and anything below
    // 1 goes further and BOOSTS dim areas above what the raw light alone
    // would give, which is a legitimate way to force the shine to punch
    // through while you diagnose what else might be dimming it.
    help: "How sharply the shine fades through shadow and dim ambient light before it reaches the screen. At 1 the shine tracks the scene's own light exactly, with no extra fade. Above 1, dim areas lose their shine much faster than bright ones do — only candles, point lights and direct sun keep their full sparkle, and the default (3) is fairly aggressive about this. Below 1, dim areas are boosted ABOVE what the plain light level would give — turn this down toward 0.1 if the shine is barely visible anywhere and you want to confirm the effect is there at all before fine-tuning where it should and shouldn't show.",
  },
  sheenCeiling: {
    type: 'float',
    min: 0,
    max: 10,
    step: 0.05,
    // RAISED 0.15 → 1 (ROUND 18), REVERTED BACK TO 0.15 (ROUND 19, same
    // day) — direct author instruction: "the base shine ceiling should be
    // lower, make it very low." This is the exact value Round 10 originally
    // measured and tuned for shimmer contrast, not a fresh guess. See
    // `SPECULAR_SHEEN_CEILING`'s own header (specular-pattern.js).
    default: 0.15,
    category: 'Response',
    label: 'Base shine ceiling',
    help: "How bright the metal's resting shine (no shimmer, just tint × light × strength) may get before this effect reins it in. The shipped default is deliberately low so the moving shimmer pattern keeps real contrast — pushed higher, the whole surface starts reading as an even, lit-from-within wash rather than a pattern of glints, trading contrast for raw visibility. Raise this only if the shine is present but reads too subtly to notice at all; the shimmer's own ceiling below is the one to raise if it is the moving GLINTS specifically that feel too dim.",
  },
  glintCeiling: {
    type: 'float',
    min: 0,
    max: 200,
    step: 1,
    // RAISED 20 → 28 (2026-08-03, ROUND 18) — live-confirmed; see
    // `sheenCeiling` above and `SPECULAR_GLINT_CEILING`'s own header.
    default: 28,
    category: 'Response',
    label: 'Glint ceiling',
    help: "How bright the moving shimmer's own contribution may peak, independent of the base shine above. Shipped high on purpose because a real specular highlight is supposed to blow out toward bloom — raise it further if peaks still read as dim dots rather than hot sparks; lower it if the glints are overpowering the metal's own base colour.",
  },
  // ── Motion ──────────────────────────────────────────────────────────────
  parallaxStrength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    // RAISED 1 → 3 = THE SCHEMA'S OWN MAX (2026-08-03, ROUND 18) —
    // live-confirmed; see `strength`'s own comment above.
    default: 3,
    category: 'Motion',
    label: 'Parallax',
    help: 'How much the shimmer slides across the metal as you pan the map. This is the single most important control for making the shine feel like a REFLECTION rather than a texture someone painted on. At 1 the patterns are nearly locked to your screen, sweeping over the map as you move, which is what light actually does. At 0 they are glued to the map and the illusion collapses.',
  },
  islandSpread: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    // RAISED 1 → 2 = THE SCHEMA'S OWN MAX (2026-08-03, ROUND 18) —
    // live-confirmed; see `SPECULAR_DEFAULT_ISLAND_SPREAD`'s own header
    // (specular-render.js) — the two are pinned equal by a Node test, not a
    // shared import (this file → specular-render.js would be circular,
    // since that file already imports FROM this one).
    default: 2,
    category: 'Motion',
    label: 'Per-object variety',
    help: 'How differently each separate piece of metal moves from its neighbours. The effect finds every connected metal shape on your map and gives it its own drift, so a brass door and a pile of coins never slide in lockstep. At 0 everything moves identically; higher values make each object feel more like its own surface.',
  },
  driftSpeed: {
    type: 'float',
    min: 0,
    max: 0.05,
    step: 0.0005,
    // LOWERED TO EXACTLY 0 (2026-08-03, ROUND 18) — live-confirmed; with
    // `parallaxStrength` now at its own max, camera pan alone is a lot of
    // motion. See `SPECULAR_DEFAULT_DRIFT_SPEED`'s own header.
    default: 0,
    category: 'Motion',
    label: 'Drift speed',
    help: 'How fast the patterns evolve on their own when nobody is moving the camera. Deliberately slow — the camera is meant to be the main source of movement and this only stops a parked view from being frozen. At 0 the metal is perfectly still until you pan, which is how the original effect behaved.',
  },
  pulse: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.005,
    default: 0.06,
    category: 'Motion',
    label: 'Breathing',
    help: 'A gentle rise and fall in overall brightness over several seconds. Keep it small: a visible pulse reads as a shader effect, an almost imperceptible one reads as a living surface.',
  },
  // ── Outdoor ─────────────────────────────────────────────────────────────
  sunBias: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Outdoor',
    label: 'Sun direction',
    help: 'How strongly the sun favours metal whose grain runs across its light, outdoors. This is what makes brushed metal brighten and dim through the day as the sun swings round, and on a flat top-down map it is the only way the sun direction reaches this effect at all. Indoors it does nothing, because indoors there is no sun to be angled against.',
  },
});

/**
 * The per-layer knobs — ONE shared declaration, reused per layer (SIX of them
 * since Round 19, 2026-08-03; three through Round 18). The count is not
 * decoration: the relative slide BETWEEN layers at different parallax depths
 * is most of what sells "a highlight moving over a surface". The third layer
 * defaults to a NEGATIVE depth so it counter-moves, exactly as V2's did; see
 * `SPECULAR_LAYER_DEFAULTS` (specular-render.js) for what each of the six
 * layers is actually tuned for.
 *
 * Held separately from `SPECULAR_PARAMS` so the panel can generate one strip
 * per layer rather than forty-eight flat sliders with digits in their names —
 * V2 shipped exactly that (with thirty) and nobody could tell which layer
 * they were editing.
 *
 * ⚠️ THREE OF THESE NAMES ARE CORRECTIONS OF V2'S, NOT TRANSLATIONS. Its
 * "Scatter" is `streak` (the per-cell rotation that actually makes streaks),
 * its "Elongation" is `rowSpacing` (it elongates nothing — the algebra is in
 * `specular-pattern.js`'s header), and its "Cluster size" is `contrast` (not a
 * size). Porting the labels would have ported the confusion.
 */
export const SPECULAR_LAYER_PARAMS = Object.freeze({
  density: {
    type: 'float',
    min: 0.25,
    max: 64,
    step: 0.25,
    default: 11,
    label: 'Density',
    help: 'How many shimmer shapes fit across the pattern. Higher is finer and busier.',
  },
  grainAngleDeg: {
    type: 'float',
    min: 0,
    max: 360,
    step: 1,
    default: 115,
    label: 'Grain angle',
    help: 'Which way this layer of brushing runs, in degrees. Outdoors this also decides how the sun favours it through the day.',
  },
  streak: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1.7,
    label: 'Streak',
    help: 'Turns round glints into directional streaks, each at its own random angle. THE control for whether metal reads as brushed or as beaded — at 0 you get dots, and this is the first thing to reach for if a surface looks wrong.',
  },
  softness: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.31,
    label: 'Softness',
    help: 'How sharp each glint edge is, from a hard bright speck to a broad soft pool.',
  },
  rowSpacing: {
    type: 'float',
    min: 0.18,
    max: 8,
    step: 0.02,
    default: 4,
    label: 'Row spacing',
    help: 'How far apart the rows of glints sit across the grain. High values give widely separated lines of shine; 1 gives an even scatter.',
  },
  contrast: {
    type: 'float',
    // ⚠️ FLOOR RAISED 0 → 0.5 (ROUND 19, 2026-08-03) — direct instruction:
    // "strictly it needs to be gradients and never cut off angles or edges."
    // Low `contrast` sits the shimmer's smoothstep window closer to the
    // blob's peak, which is ALSO where the blob's own spatial falloff is
    // narrowest (the transition's real-world width shrinks by ~27% from
    // contrast 1 down to 0 — see `SPECULAR_LAYER_DEFAULTS`'s own analysis in
    // specular-render.js) — the sparsest, most "isolated hard spark" end of
    // this control's own range. Raising the floor makes that end
    // structurally unreachable rather than merely discouraged by a good
    // default: an author cannot drag this control into the regime this
    // effect is no longer allowed to render.
    min: 0.5,
    max: 1,
    step: 0.01,
    default: 0.85,
    label: 'Coverage',
    help: 'How much of the surface the glints cover, from a scattering of soft, gradient-edged pools to a broad connected sheen. Never a hard spark — this control cannot go low enough to cut off cleanly.',
  },
  strength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1,
    label: 'Layer strength',
    help: 'This layer contribution. 0 switches it off without disturbing the others.',
  },
  parallaxDepth: {
    type: 'float',
    min: -3,
    max: 3,
    step: 0.01,
    default: 1,
    label: 'Parallax depth',
    help: 'How fast this layer slides as you pan, and which way. NEGATIVE values move it against the camera — having one layer counter-move is what makes the shine feel like it sits above the surface rather than in it.',
  },
});

/**
 * THE DEBUG CHANNELS — the instrument this effect shipped without, four live
 * failures running.
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHY IT IS NOT A `SPECULAR_PARAMS` ENTRY
 * ============================================================================
 * Selecting a channel makes the mesh draw ONE intermediate, opaque and flat,
 * across the metal's own crop — so a black screen NAMES the term that is zero
 * instead of leaving the whole chain alive as a suspect. Channels **1-16 are
 * the CHAIN**, ordered to walk the composite left to right: **the first one
 * that comes up black is the culprit.** (Channel 1 draws before anything is
 * sampled, so a black 1 means the mesh itself is not there — a different
 * investigation.) Channels **17+ are COORDINATE PROBES**, a second tier for the
 * one thing the chain cannot distinguish: a texture reading black because it is
 * empty versus one being sampled in the wrong place.
 *
 * It is deliberately NOT a param: a diagnostic view selector is not a property
 * of the look, the FOH/ROH card is generated from the schema, and a GM must
 * never find "show me the raw cellular noise" on a slider strip. It travels on
 * the render state beside `enabled`, and `getStatus().debugChannel` reports it
 * so it can never be silently left on.
 *
 * ⚠️ It costs NOTHING when off, structurally rather than by promise: the
 * channels compile into their OWN THIRD MATERIAL, which no mesh draws until a
 * channel is picked. This is not `tsl/no-uniform-gates`' "off" that still
 * executes every pixel — at channel 0 the selector is not in a draw call.
 */
export const SPECULAR_DEBUG_CHANNELS = Object.freeze([
  Object.freeze({ n: 0, id: 'off', label: 'Off — normal render', reads: 'The effect as it ships.' }),
  Object.freeze({
    n: 1,
    id: 'quad',
    label: '1 · Quad (magenta)',
    reads:
      'Flat magenta over the metal AABB crop. BLACK/absent = the mesh is not drawing at all — bad mask URL, ' +
      'nothing painted, hidden, or the pass never ran. Magenta in the WRONG PLACE = the mask rect the ' +
      'authority served disagrees with where the metal actually is.',
  }),
  Object.freeze({
    n: 2,
    id: 'mask',
    label: '2 · Mask RGB',
    reads:
      'The specular mask file as this shader samples it. You should see your painted metal, in its own ' +
      'colours. Black = sampling off the painted area, or a genuinely empty file — channel 14 tells you which.',
  }),
  Object.freeze({
    n: 3,
    id: 'strength',
    label: '3 · Strength',
    reads:
      'luma × alpha — the "how shiny is this" scalar the whole effect is built on. Grey where you painted ' +
      'grey, bright where you painted bright. All-black with a healthy channel 2 means the alpha decode ' +
      'is wrong, which is the greyscale-no-alpha authoring case.',
  }),
  Object.freeze({
    n: 4,
    id: 'presence',
    label: '4 · Presence',
    reads: 'The coverage gate — white wherever strength clears the presence edge. This is the mask silhouette.',
  }),
  Object.freeze({
    n: 5,
    id: 'tint',
    label: '5 · Tint',
    reads:
      'The metal colour at its decoded strength. Gold should read gold. Neutral grey everywhere means ' +
      'Metal colour is at 0, or the mask was painted greyscale.',
  }),
  Object.freeze({
    n: 6,
    id: 'islands',
    label: '6 · Islands (a colour each)',
    reads:
      'THE PER-OBJECT MAP, and it names its own failure before showing you the picture. FLAT MAGENTA = ' +
      'the pack never baked at all (the mask never loaded, or the bake threw — check the console and ' +
      'the specular report`s islandPack field). FLAT AMBER = it baked, but found zero islands worth ' +
      'keeping — not a bug, the mask genuinely has nothing that cleared the size floor even after ' +
      'clustering nearby specks together; `preClusterComponents` in the report says whether there was ' +
      'anything to cluster in the first place. Otherwise: every connected metal shape should be a FLAT ' +
      'PATCH of its own VIVID colour (hashed from the island id, so forty objects spread right around ' +
      'the wheel), BLACK wherever no island owns the texel. Speckle inside one object means the label ' +
      'grid is too coarse for it.',
  }),
  Object.freeze({
    n: 7,
    id: 'islandMotion',
    label: '7 · Island motion (R/G = parallax)',
    reads:
      'The decoded parallax VECTOR each island slides by, as red/green around a mid grey. Flat grey-ish ' +
      'everywhere means every island shares one motion — check Per-object variety, then the pack. ' +
      'Distinct colours here plus distinct colours on channel 6 is the feature working.',
  }),
  Object.freeze({
    n: 8,
    id: 'floorGate',
    label: '8 · Floor gate (R=floor, G=drawn, B=not occluded)',
    reads:
      'The scene-attribute verdict, and BOTH lit channels must be lit for the pass to draw. RED = this ' +
      'quad floor matches; GREEN = the attribute buffer says art was drawn here; BLUE = nothing is ' +
      'covering the Level`s background at this pixel. BLUE going black under a Tile or a roof, and ' +
      'staying lit on bare background, is the gate working. ' +
      '⚠️ BLUE IS "NOT OCCLUDED", NOT "IS BACKGROUND" — inverted 2026-08-01. It used to mean the ' +
      'opposite, which made a never-written attr buffer read identically to "a Tile is on top" and ' +
      'switched the whole effect off; now an unwired buffer fails OPEN and the shine draws. ' +
      'GREEN IS EXPECTED TO BE BLACK — that buffer alpha lane is a known live bug and is deliberately ' +
      'not multiplied in. ' +
      '⚠️ THIS CHANNEL LIED FOR THREE LIVE ROUNDS (2026-07-27 to 07-29) and was fixed 2026-08-01: the ' +
      'debug material`s channel selector compiled to real WGSL branches, so B read an unassigned ' +
      'variable and was structurally ALWAYS black regardless of the buffer`s real contents. Any ' +
      'conclusion drawn from this channel before that date is void — see ' +
      '`effects/debug-channel-select.js`. Cross-check against channel 20 (attr, raw) whenever they ' +
      'disagree.',
  }),
  Object.freeze({
    n: 9,
    id: 'outdoors',
    label: '9 · Outdoors gate',
    reads: 'White outdoors, black indoors. Decides whether the sun-direction bias applies. Not a failure either way.',
  }),
  Object.freeze({
    n: 10,
    id: 'illum',
    label: '10 · Incident light (steepened)',
    reads:
      'The scene lighting this effect multiplies through, AFTER its floor AND its steepening curve — this ' +
      'IS the number that decides "connection to lighting". Pan from a lit area into a dark one and this ' +
      'should visibly darken, sharply — a room-lit reading near 1.0 should look BRIGHT here, a dim corner ' +
      'should look decisively DARKER than channel 9`s own outdoors gate suggests. Flat/unchanging across a ' +
      'room with real light/shadow variation means illum is not reaching this pass at all — a wiring bug, ' +
      'not a tuning one.',
  }),
  Object.freeze({
    n: 11,
    id: 'cellular',
    label: '11 · Cellular base',
    reads:
      'The irregular voronoi field that breaks up the layer lattice. Should be organic blotches whose size ' +
      'follows how brightly you painted the mask. Flat = the noise is not varying, which means the pattern ' +
      'coordinate is not varying either.',
  }),
  Object.freeze({
    n: 12,
    id: 'shimmer',
    label: '12 · Shimmer',
    reads:
      'The full combined pattern before it modulates anything. THIS is the animated look — pan the map and ' +
      'it should slide. Static while panning means parallax is 0 or the view centre is not being pushed.',
  }),
  Object.freeze({
    n: 13,
    id: 'sheen',
    label: '13 · Sheen (base, no shimmer)',
    reads:
      'The always-on base alone — tint × incident × strength, no shimmer, gently ceiled. This should track ' +
      'the room`s own lighting closely and never look dramatically bright on its own; it is what makes ' +
      'painted gold read as gold at rest. If THIS looks blown out, the mask`s own colour or the strength ' +
      'slider is too hot, independent of anything shimmer is doing.',
  }),
  Object.freeze({
    n: 14,
    id: 'glint',
    label: '14 · Glint (shimmer only)',
    reads:
      'The shimmer`s own contribution alone, ceiled far higher than the sheen — this is allowed to blow out ' +
      'toward white/bloom at genuine peaks, the same way a real specular highlight does. Should be SPARSE: ' +
      'small bright patches on a mostly-dark field, not a broad wash. Broad and uniformly bright here is ' +
      'the "washed out" bug — reach for Shimmer contrast or a layer`s own Streak/Coverage first.',
  }),
  Object.freeze({
    n: 15,
    id: 'final',
    label: '15 · Final (sheen + glint)',
    reads:
      'Exactly what the mesh contributes — sheen plus glint, each already ceiled. Bright here while the map ' +
      'looks flat means the bug is downstream of this pass (the tonemap, or a grade setting).',
  }),
  Object.freeze({
    n: 16,
    id: 'finalBoosted',
    label: '16 · Final ×16',
    reads: 'Channel 15 amplified — separates "exactly zero" from "non-zero but far too dim to see".',
  }),
  // ── COORDINATE PROBES (17+) — a second tier, not part of the chain ──────
  Object.freeze({
    n: 17,
    id: 'maskUv',
    label: '17 · Mask UV ramp (R=u, G=v)',
    reads:
      'The coordinate the mask is sampled through, unclamped. A smooth red/green gradient across the metal ' +
      'means the lookup is sound and channel 2 black is the texture. Flat means the crop bounds never arrived.',
  }),
  Object.freeze({
    n: 18,
    id: 'patternUv',
    label: '18 · Pattern UV (fractional)',
    reads:
      'The shimmer pattern coordinate, wrapped to 0..1 so it reads as repeating ramps. PAN THE MAP: these ' +
      'should visibly slide. Frozen while panning is the parallax failing; frozen entirely is the world ' +
      'position or the pattern scale.',
  }),
  // ── THE CONTROL CHANNEL (19) — keep it; it is how channel 12 stays honest ──
  // The RAW light, before this effect does anything to it. Its whole value is
  // the COMPARISON with channel 12: same texture, same coordinate, one of them
  // untouched. 2026-07-27 that pair localised a live bug in one reading —
  // 12 read 0 where 19 read 0.866 — after three rounds of theories had missed
  // it. Any future "metal responds wrongly to light" starts by diffing these
  // two, never by re-reading the shader.
  Object.freeze({
    n: 19,
    id: 'illumDirect',
    label: '19 · Illum, RAW (control for 10)',
    reads:
      'The same `buf:scene.illum` at the same screen UV as channel 10, sampled directly with NOTHING ' +
      'applied. Compare the two: 10 darker than 19 is this effect shaping the light (expected — it ' +
      'linearises through the engine transfer curve and its own steepening curve); 10 at ZERO while 19 is bright is a term in ' +
      'between having collapsed, which is a bug every time. Note 19 is GREY (~0.19) in unlit rooms, not ' +
      'black — Foundry bakes ambientDarkness into illum, and taking that grey as "some light" is exactly ' +
      'what used to make metal glow in the dark.',
  }),
  Object.freeze({
    n: 20,
    id: 'attrDirect',
    label: '20 · Attr, RAW (control for 8)',
    reads:
      'The same `buf:scene.attr` at the same screen UV as channel 8 (floor gate), sampled directly with ' +
      'NOTHING applied — R=floor index, G=outdoors, B=the presence bitfield (bit 128 = SOMETHING IS ' +
      'COVERING the Level`s background here; bit 1 = overhead/roof). Reading it on bare background art, ' +
      'B should be near ZERO and channel 8`s blue should be LIT — the two are complements, not copies. ' +
      'B at or above 0.5 on bare background means a Tile/roof is claiming that pixel; B near zero under ' +
      'a Tile means the occluder bit is not reaching this pass, so check `buf:scene.attr` wiring before ' +
      'suspecting the mask. This channel is the CONTROL for channel 8 (a fresh, unshared texture node), ' +
      'and it earned its keep: it is what proved 8`s blue was structurally black rather than measuring ' +
      'anything (2026-08-01, `effects/debug-channel-select.js`).',
  }),
]);

/** Channel 13's amplification. 16× turns a 0.02 contribution (invisible) into
 * 0.32 (plainly visible) without saturating a healthy one into a white field. */
export const SPECULAR_DEBUG_BOOST = 16;

/**
 * The manifest — the effect as data (Effects.md §2 shape). `tiers` lists only
 * what is ACTUALLY BUILT; the rest is recorded in `deferredRungs`, named and
 * ordered but not yet real code, so the manifest never claims more than exists.
 *
 * `visualWeight: 0.7` — a material read: metal that stops responding to light
 * reads as a lighting bug, not as a missing effect.
 *
 * `a11y.photosensitive: false` — the motion is slow drift and camera parallax,
 * ordinary parallax rather than the rapid high-contrast flashing WCAG's
 * photosensitive criterion targets. ⚠️ Revisit if a sparkle rung ever lands;
 * that one twinkles.
 *
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const SPECULAR = Object.freeze({
  id: 'specular',
  title: 'Metal & shine',
  visualWeight: 0.7,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  params: SPECULAR_PARAMS,
  // HOW YOU ADD IT TO A MAP — the ＋ in this effect's card header opens the
  // brush already loaded with this mask (validateAuthoring, effect-manifest.js).
  authoring: Object.freeze({ paint: 'specular' }),
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'presence',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.08 }),
      adds:
        'The mask read as STRENGTH and TINT, multiplied by the scene lighting and drawn where it is painted — ' +
        'cropped to the metal own AABB (Law 6), gated to the visible floor, and gated to wherever the ' +
        'background is still the topmost thing on screen (a Tile, or the Level own foreground/roof, punches ' +
        'a real hole rather than letting the shine glow through it). The composite is ' +
        'tint x (1 + shimmer) x light, so at this tier shimmer is 0 and metal simply shines: the term that ' +
        'CANNOT be zero, which is what four invisible builds were missing.',
    }),
    Object.freeze({
      n: 1,
      name: 'shimmer',
      fromProfile: 'low',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.03 }),
      adds:
        'Six anisotropic blob-lattice layers (three broad-sweep, three fine-sparkle) plus a voronoi cellular ' +
        'base whose cell size follows the mask own brightness — bright gold breaks into fine glitter, dull ' +
        'pewter into broad soft shapes. Pure ALU on tier 0 fetch. This is where it stops being a flat sheen.',
    }),
    Object.freeze({
      n: 2,
      name: 'parallax',
      fromProfile: 'low',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.01 }),
      adds:
        'The pattern slides with the camera at ~1:1, near screen-locked, with each layer at its own depth and ' +
        'the third counter-moving. THE rung that makes it read as a reflection rather than as paint.',
    }),
    Object.freeze({
      n: 3,
      name: 'life',
      fromProfile: 'low',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.005 }),
      adds:
        'A slow global drift and a gentle breathing pulse, so a parked view keeps evolving over ~20s without ' +
        'ever looking like it is scrolling. The camera still leads by an order of magnitude — this only stops ' +
        'a still frame from being frozen. Pure ALU: one spatially-constant vector times the shared clock.',
    }),
    Object.freeze({
      n: 4,
      name: 'islands',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C3', estMsPerMp: 0.02 }),
      adds:
        'Connected metal regions labelled on the CPU and packed to a texture, each with its own parallax ' +
        'vector — so a brass door and a pile of coins never slide in lockstep. THE capability V2 never had: ' +
        'every overlay it drew shared one global pattern frame, so two identical shields behaved identically ' +
        'wherever they sat. One extra texture read, hence C3.',
    }),
    Object.freeze({
      n: 5,
      name: 'sunAndSky',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C3', estMsPerMp: 0.02 }),
      adds:
        'The outdoors mask gates a sun-azimuth grain bias: metal whose brushing runs across the light is ' +
        'favoured over metal running along it, a 2.9x swing per layer over a day. On a flat top-down map this ' +
        'is the only route the sun direction has into the effect.',
    }),
  ]),
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'perIslandLook',
      note:
        'Per-island pattern scale, phase and grain angle, on top of the parallax that landed at tier 3. The ' +
        'author chose parallax alone first, deliberately — one property, the one that reads as separate ' +
        'surfaces rather than as separate textures.',
    }),
    Object.freeze({
      name: 'sparkle',
      note:
        'Footprint-aware glint: count microfacets per pixel from fwidth(worldPos) and blend between discrete ' +
        'twinkle and a roughness-widened smooth lobe, so sparkle RESOLVES with zoom instead of aliasing the ' +
        'way V2 fixed world lattice did (its own sparkle shipped defaulted OFF for exactly that reason).',
    }),
    Object.freeze({
      name: 'weather',
      note:
        'Wet as a smooth clear coat and frost as a cool-tinted crystal field, both outdoors-gated; plus wind ' +
        'drift on the pattern from world/wind-access.js. V2 had all three and they are a large part of why ' +
        'its outdoor maps felt alive.',
    }),
    Object.freeze({
      name: 'lampColour',
      note:
        'buf:scene.coloration for per-lamp highlight colour, so a torch throws a warm glint and a cold ' +
        'crystal a blue one. V2 approximated this by tracking its brightest analytic disc; the real buffer ' +
        'already exists here.',
    }),
    Object.freeze({
      name: 'tokenOcclusion',
      note:
        'Tokens do not occlude the shine — buf:scene.attr is written by floor art only, so a token standing ' +
        'on a gold inlay leaves the attributes under it untouched. V2 solved this with a dedicated ' +
        'screen-space token mask; MSA has no equivalent buffer yet.',
    }),
  ]),
});
