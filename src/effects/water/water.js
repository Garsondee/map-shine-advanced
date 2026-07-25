/**
 * WATER — the declaration (manifest + params schema), pure data, no THREE.
 * Same split as bloom/candle/door-graphics: this file is Node-validatable;
 * the TSL builders live in sibling render modules, THREE injected, never
 * imported (`water-body.js`, `water-field.js`, `water-render.js`, as each
 * lands — see `docs/planning/Water.md` §7 for the full module layout).
 *
 * ============================================================================
 * WHY `WATER_PARAMS` IS EMPTY RIGHT NOW — declaration first, implementation
 * second, taken literally
 * ============================================================================
 *
 * Every other effect in this codebase (bloom, candle, door-graphics) shipped
 * its declaration and its render module in the SAME change — so their params
 * schemas already had real consumers the moment they existed. Water's build
 * order (`docs/planning/Water.md` §10) deliberately splits differently: this
 * phase (1) is the manifest shape + the cross-floor rule + three new
 * structural walls; tier 0's actual render code (and its first real params —
 * tint colour, tint strength) lands in phase 3, one phase later, after the
 * body pack (phase 2).
 *
 * `params/no-dead-controls` (built alongside this file, same phase) fails the
 * build the moment a param key exists with no consuming render module —
 * exactly the disease V2's water shipped at scale (46 inert uniforms with
 * live UI sliders, including a whole "Bathymetry (Volumetric)" folder with
 * zero implementing GLSL). Declaring tier-0 params here, before
 * `water-render.js` exists to consume them, would trip that wall on day one
 * of building the wall meant to prevent exactly this. Params arrive
 * incrementally, tier by tier, each in the SAME phase as the code that reads
 * them — never ahead of it.
 *
 * @module effects/water/water
 */

/** No authorable knobs yet — see the module header. Grows one tier at a time. */
export const WATER_PARAMS = Object.freeze({});

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
 * kind (a static tinted mask read); revisit once tiers 3–4 (specular glints,
 * caustics) exist for real, though ordinary rippling specular highlights at
 * normal frame rates are not the rapid high-contrast flashing WCAG/Foundry's
 * photosensitive concern targets (bloom's own header makes the same call for
 * "a soft glow, not a strobe").
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
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'placement',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.1 }),
      adds:
        'The water mask, tinted, in the right place on the right floor — the cross-floor borrow ' +
        '(resolveWaterFloor) and the buf:scene.attr punch under opaque upper geometry. Never gated.',
    }),
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0), the full ladder
  // Water.md §6 designs. Each becomes a real `tiers` entry, with its own
  // cost class and its own phase's render code, in build order.
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'volume',
      note:
        'Beer-Lambert absorption over depth so deep reads deep and shallow reads sandy, plus the ' +
        'wet-ground band outside the shoreline (free from the body pack SDF being signed). Pure ALU.',
    }),
    Object.freeze({
      name: 'motion',
      note:
        'A resident seamless tiling slope+foam texture, scrolled and blended along the flow vector. ' +
        'Foam arrives here — a channel of a read already paid for, not a separate tier.',
    }),
    Object.freeze({
      name: 'light',
      note: 'GGX specular + Fresnel-weighted sky reflection from the sky handle. No new bandwidth.',
    }),
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
