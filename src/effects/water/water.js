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
  tint: {
    type: 'color',
    space: 'srgb',
    // A muted blue-green with a deliberate green bias: pure blue reads as
    // swimming-pool. Matches WATER_TIER0_TINT in water-render.js.
    default: '#173d47',
    category: 'Look',
    label: 'Water colour',
    help: 'The flat body colour of the water. Deliberately flat at this tier — depth-dependent colour (deep reading deep, shallows reading sandy) is a later rung and must not be faked with a hand-tuned gradient here.',
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.62,
    category: 'Look',
    label: 'Opacity',
    help: 'How much of the riverbed painted underneath still reads through. Below 1 on purpose: the map art beneath is doing the work a proper volume/absorption rung will do later.',
  },
  absorption: {
    type: 'float',
    min: 0.2,
    max: 8,
    step: 0.1,
    default: 1.4,
    category: 'Look',
    label: 'Depth falloff',
    help: 'How quickly the water hides the riverbed as it deepens. Low = a clear stream you can see the bottom of everywhere; high = shallows read sandy and the deep channel reads solid water. Push this too high and the bed disappears entirely, at which point the water stops looking like water and starts looking like a flat wash of colour — if that happens, this is the slider to bring back down.',
  },
  inscatter: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.3,
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
    default: 1,
    category: 'Light',
    label: 'Sun glint',
    help: 'The bright, tight sparkle where the sun catches the water directly. This is the highlight that sweeps as you pan the view — turn it up for a dazzling noon glare on open water, down for a duller, overcast look.',
  },
  skySheen: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.02,
    default: 1,
    category: 'Light',
    label: 'Sky sheen',
    help: 'A soft, broad reflection of the sky itself across the whole surface — the reason still water looks pale near the horizon and darker overhead. Subtler and steadier than the sun glint; turn it down for water that reads as its own colour rather than a mirror.',
  },
  glossiness: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.92,
    category: 'Light',
    label: 'Glossiness',
    help: 'How mirror-like the surface is. High values give a tight, glassy sun sparkle; low values spread the same light into a duller, broader sheen. This is independent of how choppy the surface looks — a later rung, not this slider, is what makes water physically rougher.',
  },
  viewerHeight: {
    type: 'float',
    min: 0.3,
    max: 6,
    step: 0.05,
    default: 1.5,
    category: 'Light',
    label: 'Reflection sensitivity',
    help: 'How dramatically the sun glint sweeps as you pan or zoom, expressed as how high overhead the eye sits relative to what is on screen. Lower values sweep more; higher values hold a steadier, calmer highlight. Rarely needs touching — it is here to fix a scene where the glint feels either too twitchy or too static.',
  },
  // ── Motion ──────────────────────────────────────────────────────────────
  foam: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.35,
    category: 'Motion',
    label: 'Foam',
    help: 'White broken water where the surface crests, concentrated near the bank because that is where real water shoals and breaks. This is the strongest "that is a liquid, not a tinted sheet" cue available before the lighting rung lands — turn it to 0 for a glassy pond.',
  },
  flowSpeedPx: {
    type: 'float',
    min: 0,
    max: 400,
    step: 5,
    default: 60,
    category: 'Motion',
    label: 'Flow speed',
    help: 'How fast the surface travels downstream, in canvas pixels per second. 0 for a still pond or lake; a lazy river is around 40–80, rapids much higher.',
  },
  flowAngleDeg: {
    type: 'float',
    min: 0,
    max: 360,
    step: 5,
    default: 0,
    category: 'Motion',
    label: 'Flow direction',
    help: 'Which way the current runs, in degrees, 0 being to the right of the screen. The banks bend it automatically — you are setting the general downstream heading, not steering every bend of the river.',
  },
  waveScalePx: {
    type: 'float',
    min: 32,
    max: 1024,
    step: 8,
    default: 220,
    category: 'Motion',
    label: 'Surface scale',
    help: 'How big the surface structure is, in canvas pixels. Small values look like fine ripples or noise; large values like slow, broad swells. Scale it to your map — a value that reads well on a stream looks like stains on a lake.',
  },
  // ── Shape ───────────────────────────────────────────────────────────────
  depthScalePx: {
    type: 'float',
    min: 16,
    max: 1200,
    step: 8,
    default: 256,
    category: 'Shape',
    label: 'Depth reach',
    help: 'How far in from the bank the water reaches its full depth, in canvas pixels. This is what gives a river shallow, sandy edges and a deep middle WITHOUT the mask having to paint a depth gradient — set it to roughly half the width of your widest channel. Small values make a narrow shelf and a deep body; very large values make the whole thing read as shallow.',
  },
  wetBandPx: {
    type: 'float',
    min: 0,
    max: 200,
    step: 2,
    default: 34,
    category: 'Shape',
    label: 'Wet margin width',
    help: 'How far past the waterline the ground reads as damp, in canvas pixels. Set to 0 for a dry, hard-edged bank.',
  },
  wetStrength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.35,
    category: 'Shape',
    label: 'Wet margin strength',
    help: 'How strongly the damp margin tints the ground at the waterline. Subtle by default — damp sand is a shade darker, not a painted outline.',
  },
  shorelineDepth: {
    type: 'float',
    min: 0.004,
    max: 0.5,
    step: 0.004,
    default: 48 / 255,
    category: 'Shape',
    label: 'Shoreline threshold',
    help: 'How deep the painted mask must be before water is fully opaque. Everything shallower fades out, which is what antialiases the shoreline — turning this to its minimum gives a hard, jagged edge, and very high values erase shallow water entirely. Raise it if your mask paints shallows you would rather not see.',
  },
});

/**
 * The manifest — the effect as data (Effects.md §2 shape). `tiers` lists only
 * what is ACTUALLY BUILT (mirrors bloom.js's own precedent: tier 0 there,
 * nothing further, until later tiers land for real). Tiers 1–8 are recorded
 * as `deferredRungs` — named, ordered, but not yet real code — matching the
 * ladder `docs/planning/Water.md` §6 designs in full, without the manifest
 * claiming more exists than does.
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
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0), the full ladder
  // Water.md §6 designs. Each becomes a real `tiers` entry, with its own
  // cost class and its own phase's render code, in build order.
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'shore',
      note:
        'SDF-driven shoreline foam filaments and wave shoaling, plus caustics from the surface ' +
        "field's Jacobian projected onto the bed — no derivatives, no divergent-flow UB.",
    }),
    Object.freeze({
      name: 'refraction',
      note: 'Dependent read of buf:scene.color offset by slope × thickness, plus chromatic dispersion.',
    }),
    Object.freeze({
      name: 'reflection',
      note: 'Short screen-space march along the wave normal for shoreline objects and tokens.',
    }),
    Object.freeze({
      name: 'sim',
      note:
        'Spectral cascade + interactive ripple integrator + flow advection, ADDED into the tier-2 ' +
        'field (never substituted for it). Rain rings, token wakes, waves reflecting off banks. ' +
        'Coverage- and zoom-gated.',
    }),
    Object.freeze({
      name: 'spray',
      note:
        'Splash and spray particles through the one particle engine, spawned from decode-time ' +
        'extracted shore points and sim impact events. Never a readback, never a second engine.',
    }),
  ]),
});
