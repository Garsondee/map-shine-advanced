/**
 * WATER — the declaration (manifest + params schema), pure data, no THREE.
 * Same split as bloom/candle/door-graphics: this file is Node-validatable;
 * the TSL builders live in sibling render modules, THREE injected, never
 * imported (`water-body.js`, `water-field.js`, `water-render.js`, as each
 * lands — see `docs/planning/Water.md` §7 for the full module layout).
 *
 * ============================================================================
 * PARAMS ARRIVE WITH THEIR CONSUMER, ONE TIER AT A TIME
 * ============================================================================
 *
 * `WATER_PARAMS` was deliberately EMPTY through phases 1–2, and that was not
 * an oversight: `params/no-dead-controls` (built in the same phase as this
 * file) fails the build the moment a param key exists with no consuming
 * source. Declaring tier-0's knobs before `water-render.js` existed to read
 * them would have tripped, on day one, the very wall built to prevent exactly
 * this — V2's water shipped 46 inert uniforms with live UI sliders, including
 * a fully-labelled "Bathymetry (Volumetric)" folder with zero implementing
 * GLSL.
 *
 * The three keys below arrived in PHASE 3, the same phase as the tier-0
 * surface that reads every one of them. Tiers 1–8 add theirs the same way,
 * each alongside the code that consumes it, never ahead of it.
 *
 * @module effects/water/water
 */

/**
 * TIER 0's knobs — and only tier 0's. Each is read by
 * `effects/water/water-render.js`; the defaults there are the single source of
 * truth for the values, so a change lands in both places or in neither.
 */
export const WATER_PARAMS = Object.freeze({
  // ── Look ────────────────────────────────────────────────────────────────
  depth: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    // Water-Testament §3.3's own calibration target: "the author's current
    // river settings ≈ 0.45".
    default: 0.45,
    category: 'Look',
    label: 'Depth',
    help: 'How deep this whole body reads, from a shallow ford to a dark abyss — the single dial the shallow-to-deep colour journey, how murky the water gets, and how strongly it shows its own colour all answer to. Not the same control as "Depth reach" (Shape): that sets HOW FAR from the bank the deep read begins; this sets how dramatic the deep read IS once you get there.',
  },
  pollution: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    // The author's own "large polluted medieval town river" target sits
    // toward the murky end, not at either pole.
    default: 0.6,
    category: 'Look',
    label: 'Pollution',
    help: 'Clean water at 0, silty sludge at 1 — blends between two real colour references (clear tropical shallows/abyss and murky silt-brown shallows/black-brown depths) rather than just darkening one tint. Also thickens the murk, so heavily polluted water hides its bed sooner than the Depth slider alone would.',
  },
  tint: {
    type: 'color',
    space: 'srgb',
    // A muted blue-green with a deliberate green bias: pure blue reads as
    // swimming-pool. Matches WATER_TIER0_TINT in water-render.js.
    default: '#173d47',
    category: 'Look',
    label: 'Colour trim',
    help: "A hand-tune nudge blended a minority share into the colour Depth/Pollution derive — for the rare map whose river needs to lean a little off the physical reference without fighting it outright. Was the water's ONLY colour source before Depth/Pollution existed; if the water reads oddly tinted after raising Pollution, this is the first thing to bring back toward neutral.",
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Look',
    label: 'Opacity',
    help: 'How much of the riverbed painted underneath still reads through. Below 1 on purpose: the map art beneath is doing the work a proper volume/absorption rung will do later.',
  },
  absorption: {
    type: 'float',
    min: 0.2,
    max: 8,
    step: 0.1,
    default: 3.2,
    category: 'Look',
    label: 'Depth falloff',
    help: 'How quickly the water hides the riverbed as it deepens. Low = a clear stream you can see the bottom of everywhere; high = shallows read sandy and the deep channel reads solid water. Push this too high and the bed disappears entirely, at which point the water stops looking like water and starts looking like a flat wash of colour — if that happens, this is the slider to bring back down.',
  },
  inscatter: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.18,
    category: 'Look',
    label: 'Own colour',
    help: 'How much colour the water shows in its own right, as opposed to only tinting what lies beneath it. At 0 the water is a pure coloured filter — the ground shows through, shifted toward your water colour. Turn it up for silty, turbid or stylised water. Turn it up too far and the water reads as paint laid over the map rather than a body you can see into.',
  },
  // ── Light ───────────────────────────────────────────────────────────────
  sunGlint: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.02,
    default: 2,
    category: 'Light',
    label: 'Sun glint',
    help: 'The bright, tight sparkle where the sun catches the water directly. This is the highlight that sweeps as you pan the view — turn it up for a dazzling noon glare on open water, down for a duller, overcast look.',
  },
  skySheen: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.02,
    default: 0.54,
    category: 'Light',
    label: 'Sky sheen',
    help: 'A soft, broad reflection of the sky itself across the whole surface — the reason still water looks pale near the horizon and darker overhead. Subtler and steadier than the sun glint; turn it down for water that reads as its own colour rather than a mirror.',
  },
  glossiness: {
    type: 'float',
    min: 0,
    // ⚠️ THE CEILING IS DERIVED, NOT 1 (2026-08-17). The shader computes
    // `roughness = clamp(1 − glossiness, WATER_MIN_ROUGHNESS, 1)`, so every
    // glossiness from `1 − 0.089 = 0.911` upward collapses to the SAME alpha:
    // the top 9% of this slider was inert, and moving through it changed
    // nothing on screen. The author dragged to 1.0 while tuning their river and
    // got 0.911's picture — a control that silently ignores part of its own
    // travel is the UI half of `feedback_instruments_must_not_lie`.
    // 0.911 IS `1 − WATER_MIN_ROUGHNESS` (water-light.js). Typed out rather
    // than imported because this module is deliberately pure data with no
    // imports at all; a Node test pins the two equal, the same anti-drift
    // discipline every other mirrored constant in this file relies on.
    max: 0.911,
    step: 0.01,
    // ⚠️ AT THE CEILING BY THE AUTHOR'S OWN TUNING (2026-08-17), up from the
    // calibrated 0.755. `WATER_TIER3_GLOSSINESS`'s header carries the Cox-Munk
    // grounding for that calibration and the measurement showing this tight a
    // lobe blows its brightest facets past the buffer while sparkling on less
    // of the surface — all still true, and all now a deliberate trade rather
    // than a bug: on a dark, heavily-absorbing river the author wants hard
    // bright specks, not a broad sheen, and a look parameter's shipped value is
    // the author's call. A Node test pins this equal to the code constant.
    default: 0.911,
    category: 'Light',
    label: 'Glossiness',
    help: 'How mirror-like the surface is, at scales too fine to see individually — the polish BETWEEN the wavelets. High values give a tight, hard sparkle; low values spread the same light into a duller, broader sheen. This is not the same as how choppy the water is: Surface chop sets how much the wavelets themselves lean, and that is what decides where the sparkles land.',
  },
  viewerHeight: {
    type: 'float',
    min: 0.3,
    max: 6,
    step: 0.05,
    default: 1,
    category: 'Light',
    label: 'Reflection sensitivity',
    help: 'How dramatically the sun glint sweeps as you pan or zoom, expressed as how high overhead the eye sits relative to what is on screen. Lower values sweep more; higher values hold a steadier, calmer highlight. Rarely needs touching — it is here to fix a scene where the glint feels either too twitchy or too static.',
  },
  shadowResponse: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    // Matches WATER_TIER3_SHADOW_RESPONSE (water-light.js), which carries the
    // reasoning; a Node test pins the two equal.
    default: 1,
    category: 'Light',
    label: 'Shadows kill glint',
    help: 'How completely a cast shadow puts out the sparkle on the water. At 1 — the default, and what real water does — a bridge, a tree or a tower blocks the sun, so there is no sun there to catch and the glitter simply stops at the edge of the shadow. Turn it down for a stylised look where the water sparkles everywhere regardless of what is standing over it. The broad sky sheen is deliberately only half-affected at any setting: shadowed water still sees most of the sky, which is why real shadows read blue rather than black.',
  },
  // ── Motion ──────────────────────────────────────────────────────────────
  foam: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Motion',
    label: 'Foam',
    help: 'White broken water where the surface crests, concentrated near the bank because that is where real water shoals and breaks. This is the strongest "that is a liquid, not a tinted sheet" cue available before the lighting rung lands — turn it to 0 for a glassy pond.',
  },
  flowSpeedPx: {
    type: 'float',
    min: 0,
    max: 400,
    step: 5,
    default: 90,
    category: 'Motion',
    label: 'Flow speed',
    help: 'How fast the surface travels downstream, in canvas pixels per second. 0 for a still pond or lake; a lazy river is around 40–80, rapids much higher.',
  },
  // ⚠️ `angle`, NOT `float` — a compass bearing is CYCLIC, so 359 and 1 are two
  // degrees apart and an out-of-range write must WRAP rather than clamp
  // (core/params-schema.js's own `angle` note). The renderer's compass dial
  // falls out of the type, never out of a widget hint on the declaration.
  //
  // ⚠️ THE MEANING CHANGED WITH THE TYPE, 2026-08-16, and a scene that saved a
  // value under the old one will read it differently. That is deliberate: the
  // old convention was 0 = +x with degrees running CLOCKWISE on screen (this
  // renderer's world space is Y-down), and it advected the wrong way besides —
  // so "0" meant "flows WEST", which is neither what the help text said nor
  // anything an author would have chosen on purpose. See
  // `water-field.js#waterFlowVector` for both bugs and the fix.
  flowAngleDeg: {
    type: 'angle',
    // Matches WATER_TIER2_FLOW_ANGLE_DEG (water-field.js); a Node test pins the
    // two equal, the same way `chop` and `glossiness` are pinned.
    default: 180,
    category: 'Motion',
    label: 'Flow direction',
    help: 'Which way the current runs, as a compass heading — the direction the water travels TOWARD. North is up the screen. Point it downstream and the whole surface travels that way; the banks still bend it locally, so you are setting the general heading, not steering every meander. A pond does not care: set Flow speed to 0 instead.',
  },
  waveScalePx: {
    type: 'float',
    min: 32,
    max: 1024,
    step: 8,
    default: 152,
    category: 'Motion',
    label: 'Surface scale',
    help: 'How big the surface structure is, in canvas pixels. Small values look like fine ripples or noise; large values like slow, broad swells. Scale it to your map — a value that reads well on a stream looks like stains on a lake.',
  },
  chop: {
    type: 'float',
    min: 0,
    max: 1.5,
    step: 0.01,
    // Matches WATER_TIER3_CHOP (water-field.js), which carries the Cox-Munk
    // sea-surface slope statistics this number is calibrated against AND the
    // measured reason it is not higher.
    default: 0.86,
    category: 'Motion',
    label: 'Surface chop',
    help: 'How steeply the wavelets lean — and therefore how hard the water sparkles in sunlight. This is the control that decides whether a river glitters. At 0 the surface is mirror-flat and catches the sun in one place or not at all. The default is a light breeze, and is close to where sparkle is strongest: pushing it much higher does NOT keep adding sparkle, it tips the wavelets so far past the sun that the surface goes broad and dull again — which is a real look if you want a churned, storm-tossed river, but not a brighter one. If your water looks dead in daylight, start here.',
  },
  // ── Shape ───────────────────────────────────────────────────────────────
  depthScalePx: {
    type: 'float',
    min: 16,
    max: 1200,
    step: 8,
    default: 312,
    category: 'Shape',
    label: 'Depth reach',
    help: 'How far in from the bank the water reaches its full depth, in canvas pixels. This is what gives a river shallow, sandy edges and a deep middle WITHOUT the mask having to paint a depth gradient — set it to roughly half the width of your widest channel. Small values make a narrow shelf and a deep body; very large values make the whole thing read as shallow.',
  },
  wetBandPx: {
    type: 'float',
    min: 0,
    max: 200,
    step: 2,
    default: 84,
    category: 'Shape',
    label: 'Wet margin width',
    help: 'How far past the waterline the ground reads as damp, in canvas pixels. Set to 0 for a dry, hard-edged bank.',
  },
  wetStrength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.38,
    category: 'Shape',
    label: 'Wet margin strength',
    help: 'How strongly the damp margin tints the ground at the waterline. Subtle by default — damp sand is a shade darker, not a painted outline.',
  },
  shorelineDepth: {
    type: 'float',
    min: 0.004,
    max: 0.5,
    step: 0.004,
    default: 0.5,
    category: 'Shape',
    label: 'Shoreline threshold',
    help: 'How deep the painted mask must be before water is fully opaque. Everything shallower fades out, which is what antialiases the shoreline — turning this to its minimum gives a hard, jagged edge, and very high values erase shallow water entirely. Raise it if your mask paints shallows you would rather not see.',
  },
  // ── TIER 4 (2026-08-16) ────────────────────────────────────────────────────
  swashFoam: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    // Matches WATER_TIER4_SWASH_FOAM (water-render.js); a Node test pins the
    // two equal, the same discipline chop/glossiness/shadowResponse use.
    default: 1,
    category: 'Motion',
    label: 'Shore swash',
    help: 'Bands of foam that run up the shore and drain back, the way spent waves do on a beach. They travel toward the land rather than sitting still, which is the cue that reads as "waves are arriving here". Turn it down for a sheltered pond or a canal with no wave action; turn it up for an open lake or a sea shore.',
  },
  breakFoam: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    // Matches WATER_TIER4_BREAK_FOAM (water-render.js).
    default: 1,
    category: 'Motion',
    label: 'Break foam',
    help: 'White water where the current runs INTO something — the upstream face of a rock, the outside of a bend, a pier, a bank the river is pushing against. It is deliberately one-sided: the sheltered side of an obstacle stays clear, which is what makes a river read as actually flowing rather than as a still pond with a foam outline. Set the flow direction and speed first, since this follows them.',
  },
  foamTrail: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    // Matches WATER_TIER4_FOAM_TRAIL (water-render.js); a Node test pins them.
    default: 0.8,
    category: 'Motion',
    label: 'Foam trails',
    help: 'How far white water streams away downstream from whatever made it — the wake trailing off a bridge pier, a rock, the outside of a bend. This is what makes foam read as something the river is CARRYING rather than a pattern painted onto it, so on any moving water it is worth keeping up. Set it to 0 for a still pond, where there is no current to carry anything.',
  },
  caustics: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    // Matches WATER_TIER4_CAUSTICS (water-render.js).
    default: 0.33,
    category: 'Light',
    label: 'Caustics',
    help: 'The shifting net of bright light patches on the riverbed you get from sunlight refracting through a moving surface — strongest in clear, shallow water, and gone wherever the bed is too deep, murky or foam-covered to see at all. Turn it down for a stiller, less busy bed; 0 removes it entirely.',
  },
});

/**
 * THE FOH DIALS (U6, docs/holy/UI-Testament.md §9, Effects-UI.md §3) — five
 * plain-language macro controls replacing the six raw `fohKeys` sliders in
 * the Studio card's front strip (`fohKeys` stays the ROH-exclusion set and
 * the fallback for any effect with no dials schema — see `ui/rooms/studio/
 * effects-department.js`). Each is validated against `WATER_PARAMS` by
 * `core/dials-schema.js#validateDialsSchema` in `water.test.mjs`, the
 * `dials/valid-reference` wall's own real-content half.
 *
 * ⚠️ `flowAngleDeg` AND `tint` ARE DELIBERATELY UNCOVERED. `flowAngleDeg` is
 * an `angle` type — `validateDialsSchema` refuses it as a drive target on
 * principle (no fixed range a `to` window can clamp into; see dials-
 * schema.js's own header). `tint` is `color`-typed for the identical
 * structural reason. Both stay reachable through ROH only — direction and
 * colour-trim are already single, already-plain-language controls in their
 * own right (see their own `help` text above), not knobs a macro dial would
 * meaningfully simplify further.
 *
 * ⚠️ `opacity` IS ALSO DELIBERATELY UNCOVERED — a curation choice, not an
 * oversight. It was one of the original six `fohKeys` (a flat "top 6" list
 * chosen before dials existed), but its own help text calls it a stopgap
 * ("the map art beneath is doing the work a proper volume/absorption rung
 * will do later"), not one of the five creative levers an author reaches
 * for most. Effects-UI.md's own vision for a dial strip is a SMALLER,
 * curated set replacing the flat list, not a 1:1 rename of every promoted
 * key — opacity drops to ROH-only under that standard. Worth the author's
 * own countersign if they disagree (see the U6 Petition).
 *
 * Every `drives` window is deliberately CO-INCREASING with its own dial
 * (higher dial position -> higher param value) — `resolveDialDrives`/
 * `validateDialsSchema` only support `to[0] < to[1]` today, so an inverse
 * relationship (e.g. "Clarity" lowering `pollution` as it rises) is out of
 * v1 scope on purpose, not a gap discovered by accident.
 * @type {Record<string, import('../../core/dials-schema.js').DialDecl>}
 */
export const WATER_DIALS = Object.freeze({
  murkiness: {
    label: 'Murkiness',
    help: 'From a clear stream to thick, silty sludge — clean water at one end, a large polluted town river at the other.',
    range: [0, 1],
    default: 0.6,
    drives: {
      pollution: { to: [0, 1], curve: 'linear' },
      // Murkier water also shows more of its OWN colour rather than acting
      // as a clear filter (inscatter's own help text) — a real but smaller
      // secondary effect, so it ramps in mostly toward the muddy end.
      inscatter: { to: [0.1, 0.5], curve: 'ease-in' },
    },
  },
  depth: {
    label: 'Depth',
    help: 'How deep this whole body reads, from a shallow ford to a dark abyss — and how fast the bed disappears as it deepens.',
    range: [0, 1],
    default: 0.45,
    drives: {
      depth: { to: [0, 1], curve: 'linear' },
      absorption: { to: [2.5, 4.5], curve: 'linear' },
    },
  },
  shine: {
    label: 'Shine',
    help: 'Whether the water glitters in daylight or lies dull and flat — the two knobs that decide whether it sparkles at all.',
    range: [0, 1],
    default: 0.55,
    drives: {
      // A window centred on chop's own calibrated sweet spot (default 0.86
      // of a 0..1.5 range) rather than the curve shape doing that work —
      // pushing chop past its peak tips the wavelets broad and dull again
      // (chop's own help text), so the dial's own travel is pre-narrowed to
      // stay inside the useful band.
      chop: { to: [0.4, 1.1], curve: 'linear' },
      glossiness: { to: [0.6, 0.911], curve: 'linear' },
    },
  },
  foaminess: {
    label: 'Foaminess',
    help: 'How much white water shows: at the shore, against anything the current pushes on, and trailing away downstream.',
    range: [0, 1],
    default: 0.8,
    drives: {
      foam: { to: [0, 1], curve: 'linear' },
      swashFoam: { to: [0, 1], curve: 'linear' },
      breakFoam: { to: [0, 1], curve: 'linear' },
      foamTrail: { to: [0, 1], curve: 'linear' },
    },
  },
  flow: {
    label: 'Flow',
    help: 'How fast the surface travels downstream — still for a pond, brisk for a lazy river, fast for rapids. Set direction in Advanced.',
    range: [0, 400],
    default: 90,
    drives: {
      flowSpeedPx: { to: [0, 400], curve: 'linear' },
    },
  },
});

/**
 * The manifest — the effect as data (Effects.md §2 shape). `tiers` lists only
 * what is ACTUALLY BUILT (mirrors bloom.js's own precedent: tier 0 there,
 * nothing further, until later tiers land for real) — as of 2026-08-23 that
 * is rungs 0-5, refraction included. Rungs 6-8 are recorded as
 * `deferredRungs` — named, ordered, but not yet real code — matching
 * `docs/holy/Water-Testament.md` §3.6, the newer LOCKED ladder (NOT
 * `docs/planning/Water.md` §6, which still lists a now-deleted `reflection`
 * rung), without the manifest claiming more exists than does.
 *
 * `visualWeight: 0.8` — a landscape focal feature, defended well under
 * budget (matches the pre-Phase-0 Water.md sketch's own number, still
 * reasonable). `enabledFromProfile: 'low'` — tier 0 is a mask read + a tint,
 * nearly free, on by default at every profile (feedback_default_on_new_
 * features). `a11y.photosensitive: false` — tier 0 has no flicker of any
 * kind (a static tinted mask read); tier 3's sun-disc GGX lobe now exists for
 * real and does not change this call — an ordinary specular highlight that
 * sweeps as the camera pans is not the rapid, high-contrast, screen-filling
 * flashing WCAG/Foundry's photosensitive concern targets (bloom's own header
 * makes the same call for "a soft glow, not a strobe"). Revisit once tier 4
 * (caustics) exists for real, which is closer to that concern's shape.
 *
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const WATER = Object.freeze({
  id: 'water',
  title: 'Water',
  visualWeight: 0.8,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'partial',
    why: 'Two pieces of lazy first-run work, and only one of them is probeable. COUNTED: the surface mask-image fetch (ensureMaskImage), genuinely async, with a mid-flight flag that clears on success AND on failure — exposed as prefetchMask specifically so vt-pan-viewer.js#prepareFloor can start it during floor-prepare, deliberately WITHOUT the rest of sync() (which also resolves the tier gate and can REBUILD materials, and pushes a depth-authority-derived uniform that is not safe to compute for a floor that is not yet viewed). Fixed 2026-08-16 after window light\'s own identical gap was live-reported ("pops into view a second later" on a floor switch) — before this, nothing asked for either effect\'s mask until the first real frame rendered on the new floor. NOT COUNTED: the body’s three RGBA16F targets (~25MB at 3x the mask grid) and its jump-flood, which run SYNCHRONOUSLY inside the first sync() that has water in it — there is no pending window to observe, and the flag that would express it ("has it baked yet?") is a gate that fails CLOSED when the effect is switched off, holding readiness open forever for an effect that will never bake. The bake is covered instead by settle.js’s global criteria: it grows the pipeline set and it produces a frame-time hitch, and either one restarts the quiet clock.',
    probes: ['waterSurfaceMask'],
  }),
  params: WATER_PARAMS,
  // HOW YOU ADD IT TO A MAP — the ＋ in this effect's card header opens the
  // brush already loaded with this mask (validateAuthoring, effect-manifest.js).
  authoring: Object.freeze({ paint: 'water' }),
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'placement',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.1 }),
      adds:
        'The water mask, tinted, in the right place on the right floor — the cross-floor borrow ' +
        '(resolveWaterFloor), a shoreline drawn from the mask file at its authored resolution, and ' +
        'occlusion under upper geometry from the painter`s-algorithm draw order. Never gated.',
    }),
    Object.freeze({
      n: 1,
      name: 'volume',
      fromProfile: 'low',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.02 }),
      adds:
        'Beer-Lambert absorption over depth — shallows read sandy, deeps read solid water — plus the ' +
        'wet-ground band OUTSIDE the shoreline, free from the body pack being signed. Pure ALU on ' +
        'reads tier 0 already paid for: one exp(), one smoothstep, no new fetch beyond the SDF the ' +
        'wet band needs. C1 against tier 0`s C4 is the ladder`s own shape (Effects.md §4) — tier 0`s ' +
        'class is the admission price, monotonicity governs rungs 1..N upward from here.',
    }),
    Object.freeze({
      n: 2,
      name: 'motion',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.06 }),
      adds:
        'The surface field — one fractal-noise fetch, scrolled along the flow vector (the body pack`s ' +
        'tangent, PROJECTED onto a global current so the sign flip at the medial axis cancels), read ' +
        'twice: as FOAM where it crests, gated toward the bank because that is where water shoals, and ' +
        'as TURBIDITY modulating optical depth so the absorption varies across the surface instead of ' +
        'being one flat number. Deliberately NOT slope-shading: from directly above a slope is invisible ' +
        'without refraction (rung 5) or specular (rung 3), and a fake light here would fight the real ' +
        'one later. This is the rung where water stops being a decal.',
    }),
    Object.freeze({
      n: 3,
      name: 'light',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C3', estMsPerMp: 0.08 }),
      adds:
        'GGX specular + Fresnel-weighted sky reflection from the sky handle. A separate transcription ' +
        'of the same synthesised-eye, flat-N approach `effects/specular/` proved (own F0 for water`s ' +
        'own IOR, never tinted by the water`s own colour — a dielectric`s mirror reflection takes its ' +
        'colour from the sky, not the medium beneath it). Stays inside tier 0-2`s own pass rather than ' +
        'moving to a post-lighting scene the way shine has to: everything it needs (the sky handle, the ' +
        'static authored outdoors mask) is already available there, so water keeps its free paint-order ' +
        'occlusion instead of trading it for an explicit buf:scene.attr gate. No lamp glint at this rung ' +
        '(the ladder`s own "no new bandwidth") and gated by the same shoreline mask and foam-hide factor ' +
        'tiers 0-2 already compute — a channel of reads already paid for, not a new one.',
    }),
    Object.freeze({
      n: 4,
      name: 'shore',
      // FIRST RUNG TO BUY `quality`/`extreme` A WATER OF THEIR OWN — tiers 0-3
      // all resolve by `standard`, so this is the first rung either of those
      // two profiles reaches past what `standard` already has. Deliberate: a
      // real GPU sweep against `mx_fractal_noise_vec3` (WATER_CAUSTICS_K`s own
      // doc) shows caustics alone triples this rung`s noise cost over tier 2,
      // which is exactly the shape `quality`-and-above exists to afford.
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.12 }),
      adds:
        'Shoreline foam filaments (a second, finer noise read at a tight band hugging the waterline), ' +
        'wave shoaling (the SAME shared n.y/n.z pair tier 2 already reads for crest+slope, amplified ' +
        "toward the bank per Green's law, so tier 3's specular sees steeper water at the shore for " +
        'free), and caustics (the surface field`s own Jacobian, from two extra world-space taps of the ' +
        'SAME already-safe warped domain — never a screen-space derivative, never divergent-flow UB). ' +
        'Filaments genuinely ADD a fetch (C4, real cost); shoaling and caustics ride tier 2`s own fetch ' +
        'and its two extra taps, which is why this rung is priced by the taps, not by a new VT read.',
    }),
    Object.freeze({
      n: 5,
      name: 'refraction',
      // FIRST RUNG THAT IS A DEPENDENT READ, NOT A DRAWABLE (2026-08-23) —
      // tiers 0-4 all live inside `geometry.world` as a plain drawable mesh;
      // this one needs LAST frame's buf:scene.color, which a same-pass
      // drawable cannot read (undefined behaviour on the GPU), so it is the
      // reason `graph/passes.js#surface.water` flipped from 'seam' to 'live'
      // — see that pass's own note. `estMsPerMp` is an honest first estimate
      // (this rung's own C5 sibling in tier 4 measures 0.12; three co-located
      // chromatic-fringe taps plus one conditional depth-validation tap is
      // genuinely more texture traffic than anything below it), NOT a real
      // GPU sweep — `tools/shader-lab/bench-water.js` owns turning this into
      // a measured number.
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C5', estMsPerMp: 0.18 }),
      adds:
        'Refraction — the water surface bends what is beneath it. A world-anchored, one-frame-stale ' +
        'capture of buf:scene.color (water-refraction-subsystem.js), sampled through a UV offset by ' +
        'tier 2`s own slope field × depth (no new fetch for the offset itself), validated against ' +
        'buf:scene.depth`s rank so a token or wall standing where the bend would look falls back to the ' +
        'centre, unrefracted sample (V2`s own "tap validation"), finished with a ±1-texel R/B chromatic ' +
        'fringe. World-anchored on purpose: the capture remembers the WORLD rect its own UV space maps ' +
        'across, so this frame`s position remaps through it with no camera-delta math at all.',
    }),
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0), the ladder
  // Water-Testament.md §3.6 (the newer, LOCKED table — NOT Water.md §6, which
  // still lists a now-deleted `reflection` rung between refraction and sim;
  // see §3.6's own "C6 SSR-style reflection is DELETED from the ladder"). Each
  // becomes a real `tiers` entry, with its own cost class and its own phase's
  // render code, in build order.
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'sim:memory',
      note: 'Foam advect/decay buffer + wetness watermark + convergence scum. Coverage- and zoom-gated.',
    }),
    Object.freeze({
      name: 'sim:interactive',
      note:
        'Interactive ripple integrator, wakes, rain rings — ADDED into the tier-2 field (never ' +
        'substituted for it), never a readback.',
    }),
    Object.freeze({
      name: 'spray',
      note:
        'Splash and spray particles through the one particle engine, spawned from decode-time ' +
        'extracted shore points and sim impact events. Never a readback, never a second engine.',
    }),
  ]),
});

/**
 * THE DEBUG-CHANNEL LADDER — `docs/holy/Water-Testament.md` W0: *"instruments
 * FIRST... every future 'term is invisible' question is a debug-channel click,
 * not a guess."*
 *
 * ============================================================================
 * WHY THIS EXISTS, IN ONE SENTENCE
 * ============================================================================
 * Water has shipped TWO live silent-gate bugs in the same 2026-08-16 session
 * this ladder was commissioned to end: caustics with no `insideWater` gate
 * (multiplying the wrong 100% of the screen) and shoreline foam whose ridge
 * width was calibrated against an assumed noise distribution (lighting the
 * wrong 41.6% of the band). Both were `feedback_count_silent_preconditions` in
 * a new costume — a product of many gates where exactly one factor was wrong,
 * diagnosed only by the author's eyes because nothing else could see inside
 * the product. Specular paid this exact tax twelve rounds before building
 * `SPECULAR_DEBUG_CHANNELS`; this is water's turn to stop paying it.
 *
 * ============================================================================
 * ARITHMETIC SELECTION, NOT `select()` — SEE `effects/debug-channel-select.js`
 * ============================================================================
 * `buildDebugChannelColor` (imported by `water-render.js`) sums every channel
 * scaled by a zero/one picker built from `step()`, never from TSL's `select()`.
 * A `select()` fold puts each channel's maths inside real WGSL control flow, so
 * a `.toVar()` shared between channels is ASSIGNED wherever the graph walk
 * reaches it first and reads as an unassigned zero everywhere else — twelve
 * live rounds of specular's own history, named in that module's header. Water
 * shares plenty of subgraphs across channels (`bodyTexNode`, `field`, `shore`);
 * arithmetic selection is not optional here, it is the one thing that makes
 * this ladder trustworthy at all.
 *
 * ============================================================================
 * THE LADDER'S ORDER IS THE PRODUCT'S OWN ORDER
 * ============================================================================
 * Channels 1-18 walk the composite roughly in COMPUTATION order — placement,
 * then depth, then the surface field, then tier-4 foam term by term, then
 * light, then the two meshes' own finished output. Read top to bottom: the
 * FIRST channel that comes up black (or, for a signed/remapped channel, at its
 * documented "nothing here" value) is the term that kills everything below it.
 * `foamD01`/`worleyLace`/`swashBand`/`breakFacing` are FOUR SEPARATE readings
 * on purpose, not four views of one number — they answer four different
 * questions ("am I near the shore", "does the cellular structure exist", "is
 * the wave pattern firing", "is the direction math even right"), and this
 * week's own invisible-foam bug is exactly the shape where three of those four
 * were fine and the fourth (the ridge width, upstream of `lace`) was wrong.
 *
 * It is deliberately NOT a param — see `SPECULAR_DEBUG_CHANNELS`'s own header
 * for why (never on the FOH/ROH card as a look control, never persisted,
 * travels on the render state beside `enabled`, reported by
 * `getStatus().debugChannel` so it can never be silently left on) — and it
 * costs NOTHING when off: at channel 0 the compiled `debugMaterial` is attached
 * to no mesh (`water-surface-subsystem.js#refreshVisibility`), so the selector
 * is not in a draw call, the same structural (not promised) zero-cost shape
 * `SPECULAR_DEBUG_CHANNELS` uses.
 */
export const WATER_DEBUG_CHANNELS = Object.freeze([
  Object.freeze({ n: 0, id: 'off', label: 'Off — normal render', reads: 'The effect as it ships.' }),
  Object.freeze({
    n: 1,
    id: 'quad',
    label: '1 · Quad (magenta)',
    reads:
      'Flat magenta over the water AABB crop. BLACK/absent = the mesh is not drawing at all — no bake yet, ' +
      'no mask loaded, the floor has no water, or the depth-authority gate hid it. Magenta in the WRONG PLACE ' +
      'means the measured water bounds disagree with where the water actually is.',
  }),
  Object.freeze({
    n: 2,
    id: 'mask',
    label: '2 · Mask (R = depth/presence)',
    reads:
      'The high-res water mask, as this shader samples it, greyscale. You should see your painted ' +
      'silhouette. Black = sampling off the painted area, or a genuinely empty file.',
  }),
  Object.freeze({
    n: 3,
    id: 'inside',
    label: '3 · Inside (shoreline gate)',
    reads:
      'White inside the water, black on dry land — the antialiased threshold every other term multiplies ' +
      'by. A hard, jagged edge here (rather than a soft ramp) means `shorelineDepth` is set too low for the ' +
      "mask's own antialiasing to survive it.",
  }),
  Object.freeze({
    n: 4,
    id: 'shoreDist01',
    label: '4 · Shore distance (tier 1 depth ramp)',
    reads:
      'Black at the bank, white at `depthScalePx` in — the geometric ramp that turns a flat silhouette into ' +
      'shallow edges and a deep channel. All-white everywhere means the SDF body pack never baked (below ' +
      'tier 1, or the bake genuinely failed) and depth is riding the mask alone.',
  }),
  Object.freeze({
    n: 5,
    id: 'depth01',
    label: '5 · Optical depth',
    reads:
      "Mask x depth-ramp x inside x opacity x turbidity — the number Beer-Lambert's exp(-sigma*d) actually " +
      'consumes. Should track channel 4 modulated by the mask and by `opacity`. All-black on real water means ' +
      '`opacity` is 0 or the mask is not reading as painted here.',
  }),
  Object.freeze({
    n: 6,
    id: 'bedVisibility',
    label: '6 · Bed visibility (mean transmittance)',
    reads:
      'White = you can see the bed clearly; black = fully absorbed, deep-tarn water. Should fall smoothly ' +
      'from the bank toward the channel. Uniform grey everywhere on a silhouette mask means depth01 has no ' +
      'variation — the exact "flat wash" failure this rung was built to fix.',
  }),
  Object.freeze({
    n: 7,
    id: 'turbidity',
    label: '7 · Turbidity (remapped, mid-grey = neutral)',
    reads:
      'Tier 2\'s own noise channel, biased so 0.5 grey means "no effect" — brighter patches thin the water, ' +
      'darker patches murk it. Flat 0.5 everywhere below tier 2, or if the surface field never built.',
  }),
  Object.freeze({
    n: 8,
    id: 'foamCrest',
    label: '8 · Foam — tier 2 crest only',
    reads:
      "Tier 2's own crest foam, BEFORE tier 4 adds anything — white on the steepest, shoaling-amplified " +
      'wave crests near the bank. Present here but absent from channel 14 (`totalFoam`) would be a real bug: ' +
      'tier 4 is supposed to ADD to this, never replace it (Law 2).',
  }),
  Object.freeze({
    n: 9,
    id: 'foamD01',
    label: '9 · Foam band position (0=waterline, 1=band edge)',
    reads:
      'Black at the very waterline, white at the outer edge of the foam band (`depthScalePx x ' +
      'WATER_FOAM_SHORE_FRACTION`, clamped). ALL WHITE across the whole water means the reach is too SMALL ' +
      'for this body — the entire visible water is already past the band and every foam term downstream ' +
      'reads its "far from shore" value. ALL BLACK means the reach is enormous relative to the body.',
  }),
  Object.freeze({
    n: 10,
    id: 'worleyLace',
    label: '10 · Cellular structure (Worley lace)',
    reads:
      'The net-with-holes pattern alone, independent of shore distance or direction — should look like a ' +
      'foam texture (bright walls, darker cell interiors) tiling the WHOLE water, not just the shore. Flat ' +
      'grey means the Worley cut (`WATER_FOAM_CELL_EDGE0/1`) is not landing where the real distribution puts ' +
      'it, or the cell scale is too fine/coarse to resolve at this zoom.',
  }),
  Object.freeze({
    n: 11,
    id: 'swashBand',
    label: '11 · Swash wave (raw, unscaled)',
    reads:
      'The travelling-band pattern by itself, before the shore fade or the author`s `swashFoam` strength — ' +
      'you should see moving bands sweep the WHOLE water (not just the shore) if the periodic maths is firing ' +
      'at all. Flat black means the sine threshold never crosses (check `WATER_SWASH_WIDTH`); a static ' +
      '(non-moving) pattern means the time term is not reaching this shader (`timeMsNode` unwired).',
  }),
  Object.freeze({
    n: 12,
    id: 'breakFacing',
    label: '12 · Break direction (raw, pre-gate)',
    reads:
      'max(-dot(flow, shoreNormal), 0) — white on whichever bank the CURRENT is running INTO, black ' +
      'everywhere else, with NO shore-distance or strength gating applied yet. This is the single channel ' +
      'that answers "is the direction math even right" independent of everything else: if it lights the ' +
      'WRONG bank (the one the flow runs AWAY from), the tangent-to-normal rotation has the wrong sign.',
  }),
  Object.freeze({
    n: 13,
    id: 'breakFoam',
    label: '13 · Break foam (final, gated)',
    reads:
      'Channel 12, sharpened and gated by shore distance and the `breakFoam` strength — the actual ' +
      'contribution reaching the composite. Present in channel 12 but absent here means the gate (reach, or ' +
      'the strength slider) is killing it, not the direction.',
  }),
  Object.freeze({
    n: 14,
    id: 'foamTail',
    label: '14 · Foam tail (streamed downstream)',
    reads:
      'Break foam CARRIED downstream from where it was generated — the stateless stand-in for foam memory ' +
      '(see `water-shore.js#WATER_TAIL_TAPS`). Should read as wakes trailing off obstacles and off the outside ' +
      'of every bend, pointing the way the current runs. Black everywhere while channel 13 (breakFoam) shows ' +
      'real signal means the body-pack tap never reached the shore module — the tail compiles out entirely ' +
      'without it. Present but trailing the WRONG WAY means the upstream march has the sign of the flow ' +
      'direction backwards.',
  }),
  Object.freeze({
    n: 15,
    id: 'totalFoam',
    label: '14 · Total foam (what the composite sees)',
    reads:
      "Tier 2's crest foam PLUS tier 4's shoreline foam, clamped once — the ONE number every downstream " +
      'term (bed occlusion, the foam emission, the reflection gate) actually reads. If this is black while ' +
      'channels 8/11/13 show real signal, the ADD at the tier-4 call site in `water-render.js` is broken.',
  }),
  Object.freeze({
    n: 16,
    id: 'causticExcess',
    label: '15 · Caustics (remapped, mid-grey = neutral)',
    reads:
      "The bed-brightness multiplier's excess over 1, biased so 0.5 grey means no caustic effect at this " +
      'pixel — brighter than grey focuses light (a bright caustic line), darker diverges it. Should be near ' +
      'grey almost everywhere with occasional bright threads; a flat NON-grey wash across the whole water is ' +
      'the exact `insideWater`-gate bug this effect shipped once already ' +
      "(`feedback_uv_clamp_is_an_extrusion_not_a_boundary`'s sibling — see the module header).",
  }),
  Object.freeze({
    n: 17,
    id: 'reflection',
    label: '16 · Sun/sky reflection (tier 3)',
    reads:
      'The GGX sun glint plus sky sheen, before the shadow gate is even relevant to reading this channel ' +
      '(it is already baked in). Flat black outdoors at a real sun elevation with real chop means the wave ' +
      'normal is not reaching tier 3 — check `getStatus().waveNormal`.',
  }),
  Object.freeze({
    n: 18,
    id: 'absorbFinal',
    label: '17 · Mesh 1 output (the multiply pass)',
    reads:
      'What the ABSORPTION mesh actually writes — the bed, darkened/tinted/foam-hidden/caustic-brightened. ' +
      'This is the closest thing to "what will the bed look like", read before the additive mesh 2 lands on ' +
      'top of it.',
  }),
  Object.freeze({
    n: 19,
    id: 'inscatterFinal',
    label: '18 · Mesh 2 output (the add pass)',
    reads:
      "What the IN-SCATTER mesh actually adds — the water's own returned light, the foam's white, and the " +
      'reflection, all occluded by the depth-authority gate together. Flat black on real water with real ' +
      '`inscatter`/`foam`/`sunGlint` means the depth-authority gate is closing when it should be open — check ' +
      '`getStatus().floorGateCompiled` and `expectedDepth`.',
  }),
  Object.freeze({
    n: 20,
    id: 'obstacleFoam',
    label: '19 · Obstacle proximity (depth-buffer ring, size-independent)',
    reads:
      'Fraction of an 8-tap ring around this pixel that found something ranked above water in `buf:scene.' +
      'depth` (`water-render.js#WATER_OBSTACLE_RING_TAPS`) — a SEPARATE detector from the mask-SDF shore foam ' +
      'above, sourced from what actually rendered this frame rather than the painted water mask, so a small ' +
      'rock the mask derivation missed still lights this up. White in a ring around ANY solid item sitting ' +
      'on or near water; flat black everywhere (including right beside a visible obstacle) below tier 4, or ' +
      'if `depthTexture`/`uViewRect` never reached this material (`getStatus().floorGateCompiled`).',
  }),
  Object.freeze({
    n: 21,
    id: 'maskProximityFoam',
    label: '20 · Mask proximity (full-res direct read, no derivation)',
    reads:
      'Fraction of the SAME 8-tap ring reading LAND in the full-resolution painted water mask directly — ' +
      'never the coarse derived grid `shore`/`shoreDist` above read from. THE decisive channel for "the mask ' +
      'clearly has a hole here, why is nothing foaming": if this is white around a painted feature while ' +
      'channels 2-14 (the derivation-grid-driven ones) are flat, the derivation grid lost that feature — this ' +
      'ring did not, because it never asked the derivation grid anything. Flat black below tier 4, or if this ' +
      'reads black RIGHT ON TOP of a visibly painted hole, the world→mask-UV mapping itself is wrong — compare ' +
      'against channel 2 at the same point, which shares the identical `uMaskRect` formula.',
  }),
  Object.freeze({
    n: 22,
    id: 'flowSolidity',
    label: '21 · Flow pack solidity (S2, docs/planning/Water-Simulation-Turn.md)',
    reads:
      "`res:waterFlow`'s own finished pack (`water-flow.js`), ALPHA channel — area-averaged solidity over " +
      'this SAME full-resolution painted water mask, at the flow grid`s own (coarser, 1024px-longest-side) ' +
      'resolution. Grey blob centred on ANY solid feature the flow bake can see, including rocks small ' +
      'enough that the derivation-grid channels (2-14) miss them entirely — 16 sub-samples per flow texel, ' +
      'never a single point sample. Available at EVERY tier (solidity is not a foam-ladder concept). Flat ' +
      'black everywhere means the flow pack has not baked yet for this floor (check ' +
      '`getWaterBodyInfo()[floor].flow` — `"not baked"` or `lastBake.skipped` names why; waiting on this ' +
      'same mask`s own async load is normal and temporary). Nothing downstream reads this yet — S4 is the ' +
      'phase that gives it a real consumer.',
  }),
  Object.freeze({
    n: 23,
    id: 'flowVelocity',
    label: '22 · Flow pack velocity — direction=hue, speed=value (S3 ★ KEYSTONE)',
    reads:
      "`res:waterFlow`'s own finished pack, RG (velocity, normalised — free-stream speed = 1.0) and B " +
      '(speed01) — the coarse-to-fine pressure-projection solve`s own output ' +
      '(`docs/planning/Water-Simulation-Turn.md` §3 B3, `water-flow-solve.js``s CPU-proven algorithm, ' +
      'ported function-for-function). Colour IS the reading: hue is the flow`s own direction ' +
      '(`atan(vy,vx)`, wrapped to [0,1] — NOT a display remap, this channel doubles as a real compass), ' +
      'brightness is local speed relative to the free-stream (dim near a stagnation point upstream of an ' +
      'obstacle, BRIGHT beside it where the plan`s own "constriction speed-up" shows, black inside solid ' +
      'or wherever the pack has not baked). THE PROOF LINE THIS CHANNEL EXISTS FOR: hue should visibly BEND ' +
      'around a painted rock — flow arriving from upstream curving to pass alongside it — not point straight ' +
      'through as if the rock were not there. If the hue field looks uniform (no bend, no brightening beside ' +
      'obstacles), the routing solve is not reaching this pixel; cross-check channel 21 first (is solidity ' +
      'even correctly placed there) before suspecting the velocity solve itself.',
  }),
]);

// ===========================================================================
// PRESETS — named looks, as DATA. A preset is just params (the same shape and
// the same reasoning as `grade-ops.js#GRADE_PRESETS`).
// ===========================================================================

/**
 * Named water looks, each one a COMPLETE param set.
 *
 * ⚠️ **COMPLETE, NOT A DIFF, AND THAT IS THE WHOLE POINT.** A preset that only
 * listed the keys differing from today's defaults would silently change meaning
 * every time a default moved — and these defaults move often, because they are
 * re-baselined from the author's own live tuning (this table's first entry IS
 * that tuning). Spelling out all 21 keys makes a preset a fixed anchor: "the
 * look I approved on this date", restorable in one click no matter what has
 * drifted since. It costs a few lines and buys the only property a named look
 * actually needs.
 *
 * ⚠️ NOT THE SPECIES TABLE. `docs/holy/Water-Testament.md` §3.2 (W3) specifies
 * pond/lake/river/ocean as DATA ROWS over one engine, with their own precedence
 * rules against saved scenes — a real subsystem with a real design. This is not
 * an early draft of it and must not grow into one: these are author-approved
 * LOOKS, the way a colour-grade preset is, and W3's rows will arrive beside
 * them rather than by mutating this object.
 *
 * @type {Record<string, object>}
 */
export const WATER_PRESETS = Object.freeze({
  /**
   * The author's own tuning for a large polluted medieval town river, dialled
   * in live on their map and handed over 2026-08-17 with *"these are the best
   * settings for 'a large polluted medieval town river' that I could get so
   * far"*. Every value here is simultaneously the shipped default — this entry
   * exists so it STAYS reachable once the defaults move on.
   *
   * Worth reading as a set, because it is coherent: heavy `absorption` (3.2)
   * and full `opacity` hide the bed almost entirely, so the river reads as
   * opaque and dirty rather than as a window; low `inscatter` (0.18) keeps it
   * from glowing with its own colour; and the light is then pushed the other
   * way — `sunGlint` at its ceiling and `glossiness` at the roughness floor —
   * for a hard, tight glitter that reads ON a dark surface instead of in it.
   * Foam is at maximum on all three of its controls.
   *
   * `depth`/`pollution` (2026-08-17, added after the author's own tuning
   * session — NOT part of what they dialled in) are set to name the same
   * INTENT this whole preset already carries ("large polluted medieval town
   * river") rather than left at the schema's own generic defaults: `depth`
   * 0.5 (a proper river, not a ford) and `pollution` 0.75 (solidly toward
   * the sludge end — a shade past the schema default of 0.6, matching this
   * preset's own name). `absorption`/`tint` stay exactly as the author left
   * them; see those params' own updated help text for how the two systems
   * now compose (the derived colour is primary, tint is a minority trim).
   */
  pollutedTownRiver: {
    depth: 0.5,
    pollution: 0.75,
    tint: '#173d47',
    opacity: 1,
    absorption: 3.2,
    inscatter: 0.18,
    sunGlint: 2,
    skySheen: 0.54,
    glossiness: 0.911,
    viewerHeight: 1,
    shadowResponse: 1,
    foam: 1,
    flowSpeedPx: 90,
    flowAngleDeg: 180,
    waveScalePx: 152,
    chop: 0.86,
    depthScalePx: 312,
    wetBandPx: 84,
    wetStrength: 0.38,
    shorelineDepth: 0.5,
    swashFoam: 1,
    breakFoam: 1,
    foamTrail: 0.8,
    caustics: 0.33,
  },
});

/**
 * A preset's params by name, or `null` for an unknown name.
 *
 * ⚠️ `null`, NEVER a silent fall-back to the defaults. A picker that quietly
 * applied "everything at default" for a typo'd name would look exactly like a
 * preset that legitimately happens to match the defaults — which, today, the
 * only entry in this table genuinely does. The caller reports the miss instead
 * (`feedback_instruments_must_not_lie`).
 *
 * @param {string} name @returns {object|null}
 */
export function waterPreset(name) {
  const p = WATER_PRESETS[name];
  return p ? { ...p } : null;
}
