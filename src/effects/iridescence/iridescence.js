/**
 * IRIDESCENCE — a light-reactive oil-slick/soap-bubble rainbow sheen
 * (mythica-machina-press#136).
 *
 * ============================================================================
 * WHAT THIS IS, IN THE AUTHOR'S OWN WORDS
 * ============================================================================
 * "Prism and Iridescence don't need artwork because what they are is
 * generated procedurally... I have maps with `_Prism` and `_Iridescence`
 * suffixed textures and that's all we need for these things to be working."
 * — the INPUT is an author-painted MASK, same convention as `_Specular`/
 * `_Prism` (`scene/mask-catalog.js`'s own `iridescence` entry): a file next
 * to the map/tile art marking WHERE the surface shimmers. The VISUAL — the
 * shifting spectral colour itself — is 100% procedural math, never a texture
 * library.
 *
 * "You have full permission to make [it] better than it was, obviously you
 * should be using TSL and WebGPU." This is NOT a straight port of V2's own
 * `IridescenceEffectV2.js` (recovered from git history, `c328c9bd~1`, 1001
 * lines, for the CONCEPT — mask-gated procedural spectral shimmer that reacts
 * to real light — never copied as GLSL). The one genuine architectural
 * upgrade: V2 re-implemented its own `MAX_LIGHTS = 64` per-light loop because
 * V2 had no shared illumination buffer; this build reads the buffer this
 * engine already has, `buf:scene.illum` (`iridescence-render.js`'s own header
 * has the full account) — real light reactivity for a fraction of the code.
 *
 * ============================================================================
 * WHERE THIS SITS IN THE FRAME GRAPH — THE SAME PRECEDENT `surface.prism` SET
 * ============================================================================
 * `docs/reference/v2-effect-params/iridescence-effect.md` slated Iridescence
 * for `surface.response` — the SAME pass Specular currently owns
 * (`graph/passes.js`'s own `surface.response` entry USED TO list
 * `IridescenceEffectV2` among its `absorbs`; that line is gone as of this
 * module — see that pass's own note for the honest update, mirroring
 * `surface.prism`'s own identical removal one effect earlier). Specular has
 * been through 20+ rounds of live-author-confirmed tuning — touching its
 * material for an unrelated new effect risks disturbing an already-shipped
 * look. `graph/passes.js`'s own `surface.iridescence` entry follows that
 * identical path, one effect later than Prism: a real, independent
 * surface-stage pass, never folded into `surface.response`.
 *
 * ============================================================================
 * STATUS: LIVE — WIRED INTO THE REAL FRAME LOOP FROM THE START (mythica-
 * machina-press#136)
 * ============================================================================
 * `graph/passes.js#surface.iridescence` is `status: 'live'` from the day this
 * module landed — never an unwired `status: 'seam'` the way the FIRST Prism
 * attempt was (a real mistake, corrected before Prism shipped; not repeated
 * here). `vt-pan-viewer.js#runSurfaceIridescencePass` runs every frame in the
 * `surface` stage, right after `surface.prism` and before `surface.water`: it
 * asks `iridescence-seams.js#getIridescenceMaskItems` for the CURRENT viewed
 * floor's own active tiles FIRST, and if that list is empty it returns
 * immediately — a true JS early-return (Effects.md Law 4), so a scene with no
 * `_Iridescence` mask anywhere pays for exactly one array-length check and
 * nothing else: no mesh sync, no draw call, no allocation.
 *
 * Every supporting module this needed is real and Node-tested: the
 * manifest+params (this file), the pure phase/noise/palette maths
 * (`iridescence-motion.js`), the TSL material builder
 * (`iridescence-render.js`), the per-tile mask-discovery seam
 * (`iridescence-seams.js`) and the per-tile mesh population
 * (`iridescence-surface-subsystem.js`). Correctness here means structurally
 * sound, follows this codebase's own established conventions exactly (the
 * depth-authority rank gate, the JS-time tier/noiseType branch), and passes
 * the full automated verify gate — this project's own standing rule is that
 * only the author's own live look, not a passing test suite, confirms a
 * visual effect actually looks right.
 *
 * @module effects/iridescence/iridescence
 */

/**
 * The authorable knobs (validated by core/params-schema.js), grouped by the
 * fixed ROH categories IN TIER ORDER (Sheen → Flow → Light — see
 * `iridescence-render.js`'s own tier ladder). Every numeric default below is
 * V2's OWN shipped default (`IridescenceEffectV2.js`'s own constructor
 * `this.params = {...}`, recovered from git history — NOT its
 * `getControlSchema()`'s own separate, drifted `default` fields, which this
 * module deliberately does not follow: the constructor is what actually ran).
 * @type {Record<string, object>}
 */
export const IRIDESCENCE_PARAMS = Object.freeze({
  // ── Sheen (tier 0 — mask-gated placement) ─────────────────────────────────
  maskThreshold: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.4,
    category: 'Sheen',
    label: 'Mask threshold',
    help: 'How strongly the painted Iridescence mask must read (luminance/peak x alpha) before the surface starts shimmering, on a smooth ramp up to fully-authored. Raise this if a soft, antialiased mask edge is shimmering further than the crisp shape you painted.',
  },
  invertMask: {
    type: 'bool',
    default: false,
    category: 'Sheen',
    label: 'Invert mask',
    help: "Off (default) reads brighter painted pixels as more shine, the usual white-on-black convention. On flips it — the mask's dark pixels shine instead, for a mask painted the other way round.",
  },
  alpha: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.9,
    category: 'Sheen',
    label: 'Opacity',
    help: 'Master alpha for the additive sheen — how strongly the rainbow colour adds onto the surface beneath it. This is an ADD, not a replace (unlike Prism`s glass): raising this brightens the shimmer without hiding the art underneath.',
  },

  // ── Flow (tier 1 — the procedural spectral phase field) ───────────────────
  intensity: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.5,
    category: 'Flow',
    label: 'Intensity',
    help: 'A flat multiplier on how much the rainbow colour contributes, alongside opacity — the two together set how strongly the shimmer reads over the art.',
  },
  distortionStrength: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.13,
    category: 'Flow',
    label: 'Distortion strength',
    help: 'How strongly the mask`s own painted strength warps the phase field — a higher value makes brighter-painted regions cycle through the rainbow measurably faster than dim ones, rather than every painted texel sharing one phase.',
  },
  noiseScale: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.44,
    category: 'Flow',
    label: 'Noise scale',
    help: 'A 0-1 dial mapped internally to the actual noise frequency, remapped separately per noise type below (higher = finer detail) — see `iridescence-motion.js#mapNoiseScale`.',
  },
  noiseType: {
    type: 'enum',
    values: ['liquid', 'glitter'],
    default: 'liquid',
    category: 'Flow',
    label: 'Noise type',
    // A genuine JS-time branch, not a live uniform (`iridescence-render.js`'s
    // own header) — changing this rebuilds the material, the same cost a
    // tier change already pays.
    help: 'Liquid (default) is a smooth, continuous oily field. Glitter is a blocky, grainy, more faceted sparkle. Changing this rebuilds the surface`s own material, the same real cost a performance-tier change already pays.',
  },
  flowSpeed: {
    type: 'float',
    min: 0,
    max: 5,
    step: 0.01,
    default: 0.15,
    category: 'Flow',
    label: 'Flow speed',
    help: 'How quickly the phase field scrolls over time — 0 freezes it at whatever pattern the noise/sweep/mask terms land on; higher values read as a visibly flowing, living sheen.',
  },
  phaseMult: {
    type: 'float',
    min: 0.5,
    max: 12,
    step: 0.1,
    default: 6,
    category: 'Flow',
    label: 'Phase multiplier',
    help: 'Scales how densely the rainbow`s own interference fringes pack together — higher values read as more, narrower bands of colour.',
  },
  colorCycleSpeed: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.25,
    category: 'Flow',
    label: 'Colour cycle speed',
    help: 'How fast the rainbow`s own hue rotates as the phase field evolves — a slow value reads as a gently drifting oil slick; a fast one strobes through the spectrum (kept well outside the 3-30 Hz photosensitivity band at any authored value here — see this manifest`s own `a11y` note).',
  },
  angleDeg: {
    // CYCLIC, not a plain float — `core/params-schema.js`'s own `angle` type
    // (`water.js#flowAngleDeg` is the established precedent): 359 and 1 are
    // two degrees apart, so an out-of-range write WRAPS rather than clamps.
    // No min/max declared — the range IS 0..360 by definition.
    type: 'angle',
    default: 0,
    category: 'Flow',
    label: 'Angle',
    help: 'The screen-space direction the diagonal sweep term runs across — V2`s own authoring convention (degrees), kept here as a compass heading rather than a plain float.',
  },
  parallaxStrength: {
    type: 'float',
    min: 0,
    max: 5,
    step: 0.01,
    default: 4.31,
    category: 'Flow',
    label: 'Parallax strength',
    help: 'How much the pattern`s own phase shifts as the camera pans, the way a real thin-film sheen catches different colours from different viewing positions. 0 pins the pattern with no parallax at all.',
  },

  // ── Light (tier 2 — real light reactivity via buf:scene.illum) ────────────
  ignoreDarkness: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.6,
    category: 'Light',
    label: 'Ignore darkness',
    help: "How much the shimmer resists the scene's own darkness/night tint (read off `buf:scene.illum`, the same buffer Specular's own lamp-direction trick reads) — 0 fully obeys it (dark in an unlit room), 1 ignores it entirely (always full brightness, as if self-illuminating).",
  },
});

/** The schema defaults as a flat object. */
const IRIDESCENCE_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(IRIDESCENCE_PARAMS).map(([k, decl]) => [k, decl.default]))
);

/** No named presets ship yet — mirrors `PRISM_PRESETS`'s own "a real (if
 * currently empty) table" shape, so a caller never has to special-case "this
 * effect has no presets".
 * @type {Record<string, Record<string, number|boolean|string>>} */
export const IRIDESCENCE_PRESETS = Object.freeze({ none: {} });

/**
 * Resolve a named preset to a full params object. @param {string} name
 * @returns {Record<string, number|boolean|string>}
 */
export function iridescencePreset(name) {
  return { ...IRIDESCENCE_DEFAULTS, ...(IRIDESCENCE_PRESETS[name] || {}) };
}

/**
 * The manifest.
 *
 * `visualWeight: 0.3` — mirrors `PRISM.visualWeight` exactly: a real,
 * deliberate surface finish, but a NARROW one, only ever covering whatever
 * small area an author paints `_Iridescence` onto.
 *
 * `a11y.photosensitive: false` — the phase field is a smooth, continuous
 * function of time, never a strobe; nowhere near the 3-30 Hz flicker band by
 * construction, even at `colorCycleSpeed`'s own ceiling, the same considered
 * judgement `PRISM`'s own header records for its glint.
 *
 * `enabledFromProfile: 'extreme'` — mirrors `PRISM.enabledFromProfile`
 * exactly, for the identical reason: nobody has watched Iridescence run
 * against a real scene yet (this project's own standing rule — only a live
 * human check promotes a built effect to a trusted default). `extreme` is the
 * honest ceiling to declare until the author's own eyes confirm the look —
 * off by default, on by choice (the Studio card's own enable switch reaches
 * it at any profile).
 *
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const IRIDESCENCE = Object.freeze({
  id: 'iridescence',
  title: 'Iridescence',
  visualWeight: 0.3,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'extreme',
  authoring: Object.freeze({ paint: 'iridescence' }),
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'partial',
    why:
      'COUNTED: the per-tile mask-image fetch (`iridescence-surface-subsystem.js#loadAndBuild`), async, ' +
      'with a mid-flight flag that clears on success and on failure alike — the identical shape ' +
      '`prismTileMaskLoad`/`specularMaskLoad` already count for their own per-tile population. NOT ' +
      'COUNTED: the material build it feeds is synchronous (no bake, no scene-capture subsystem at all — ' +
      'unlike Prism, this effect`s own dependent read is `buf:scene.illum`, already finished by the time ' +
      'the surface stage runs, so there is no first-tick allocation to cover here the way Prism`s own ' +
      'refraction capture needs).',
    probes: ['iridescenceTileMaskLoad'],
  }),
  params: IRIDESCENCE_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'sheen',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.08 }),
      adds:
        'THE MASK, IN THE RIGHT PLACE — the painted Iridescence mask file discovered per tile ' +
        '(`iridescence-seams.js#getIridescenceMaskItems`, mirroring `getPrismMaskItems`), a smoothstep ' +
        'presence gate off `max(luminance, peak-channel) x alpha` (V2`s own deliberate formula — never ' +
        'alpha-only, `iridescence-motion.js#computeMaskPresence`s own doc has the full "opaque black ' +
        'padding" trap this avoids), and the SAME rank-gate occlusion window Prism/Specular already use ' +
        '(`buf:scene.depth`, one ordinal `step()` comparison) so a token or an upper floor correctly ' +
        'covers the sheen. A flat, unmoving pastel tint at this tier alone — the phase field is pinned at ' +
        '0 until tier 1. Never gated — the admission price, same posture Prism`s/Specular`s own tier 0.',
    }),
    Object.freeze({
      n: 1,
      name: 'flow',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.03 }),
      adds:
        'THE REAL SHIMMER — the procedural phase field (`iridescence-motion.js#computePhase`): a ' +
        'directional screen-space sweep, one of two noise flavours (Liquid, a smooth two-octave sine ' +
        'field; Glitter, a per-grid-cell hash jitter — an author toggle, a genuine JS-time graph branch, ' +
        'never a live uniform mix of both), the mask`s own distortion contribution, a flowing clock term ' +
        'and camera parallax, all summed into one phase fed through V2`s own Inigo-Quilez-style cosine ' +
        'palette (`computeRainbowColor`) for the actual shifting spectral colour. Pure ALU on tier 0`s own ' +
        'fetch plus `positionWorld` already in hand — no new texture read.',
    }),
    Object.freeze({
      n: 2,
      name: 'spectral',
      fromProfile: 'quality',
      // ONE EXTRA TEXTURE READ, matching `specular`'s own `islands`/`sunAndSky`
      // rungs at the identical C3 — `buf:scene.illum` is a plain, already-
      // finished target by the time this pass runs (`light.accumulate` runs
      // earlier in the SAME frame), so this is an ordinary texture sample,
      // never a dependent-read-on-a-capture the way Prism`s own tier 3 is
      // (that needs a whole scene-capture subsystem; this needs none).
      cost: Object.freeze({ class: 'C3', estMsPerMp: 0.02 }),
      adds:
        'REAL LIGHT REACTIVITY — a `buf:scene.illum` sample at this fragment`s own screen position ' +
        '(`iridescence-render.js`s own header has the full `buf:scene.illum` decision: the SAME shared ' +
        'illumination buffer `surface.response`s (Specular`s) own lamp-direction trick reads, replacing ' +
        'V2`s own `MAX_LIGHTS = 64` per-light-array loop for a fraction of the code and no new light-' +
        'feeding infrastructure). `ignoreDarkness` dials between fully obeying the buffer`s own darkness ' +
        '(dim/off in an unlit room) and ignoring it entirely (always full brightness). A genuine per-light ' +
        'system (V2`s own loop, reproduced faithfully rather than replaced) is a real, separate, bigger ' +
        'undertaking — noted as a follow-up, not attempted tonight.',
    }),
  ]),
  // Nothing deferred — every real rung V2's own reference algorithm covers
  // (mask gate, phase field + palette, light reactivity) is a real, built,
  // LIVE-WIRED tier above. A real, separate follow-up exists (a floor-level
  // population alongside the tile one, mirroring Prism's own identical
  // follow-up — `iridescence-seams.js`'s own header — and a genuine per-light
  // system replacing the `buf:scene.illum` simplification, this manifest's
  // own tier 2 note above), but neither is a rendering RUNG this manifest's
  // own tier ladder would record — `Object.freeze([])` mirrors `PRISM`'s own
  // "nothing left to defer" declaration.
  deferredRungs: Object.freeze([]),
});
