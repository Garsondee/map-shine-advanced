/**
 * PRISM — a crystal/glass refraction surface finish (mythica-machina-press#137).
 *
 * ============================================================================
 * WHAT THIS IS, IN THE AUTHOR'S OWN WORDS
 * ============================================================================
 * "Prism and Iridescence don't need artwork because what they are is
 * generated procedurally... I have maps with `_Prism` and `_Iridescence`
 * suffixed textures and that's all we need for these things to be working."
 * — the INPUT is an author-painted MASK, same convention as `_Specular`/
 * `_Water`/`_Fluid` (`scene/mask-catalog.js`'s own `prism` entry): a
 * black-and-white (or coloured) file next to the map/tile art marking WHERE
 * the surface refracts. The VISUAL — facets, chromatic dispersion, a rotating
 * glint — is 100% procedural math, never a texture library.
 *
 * "You have full permission to make Prism better than it was, obviously you
 * should be using TSL and WebGPU... Glassy textures or crystals or fun things
 * like that, it's meant to do it all." This is NOT a straight port of V2's own
 * `PrismEffectV2.js` (recovered from git history, `c328c9bd~1`, 577 lines,
 * for the CONCEPT — mask-gated refraction + chromatic spread + facet glinting
 * — never copied as GLSL). Where TSL/WebGPU can do this better, this module
 * does: `prism-refraction-subsystem.js` captures a REAL finished frame and
 * `prism-render.js` refracts THAT (this codebase's own proven "capture the
 * scene, then refract it" pattern, `effects/water/water-refraction-
 * subsystem.js`), rather than V2's cruder same-frame texel-offset
 * approximation.
 *
 * ============================================================================
 * WHERE THIS SITS IN THE FRAME GRAPH — THE SAME PRECEDENT post.lens ALREADY SET
 * ============================================================================
 * `docs/reference/v2-effect-params/prism-effect.md` slated Prism for
 * `surface.response` — the SAME pass Specular currently owns
 * (`graph/passes.js`'s own `surface.response` entry USED TO list
 * `PrismEffectV2` among its `absorbs`; that line is gone as of this module —
 * see that pass's own note for the honest update, mirroring `post.bloom`'s
 * own "bloom is now the separate post.bloom pass" precedent exactly). Specular
 * has been through 20+ rounds of live-author-confirmed tuning
 * (`specular.js`/`specular-render.js`'s own "ROUND N" headers) — touching its
 * material for an unrelated new effect risks disturbing an already-shipped
 * look. `effects/lens.js`'s own header already lived through this EXACT
 * question for `post.grade` and shipped standalone instead ("`post.bloom`
 * already sets the precedent... shipped standalone instead once it was
 * actually built... `post.lens` follows the identical path"). `graph/
 * passes.js`'s own `surface.prism` entry follows that identical path one
 * effect later: a real, independent surface-stage pass, never folded into
 * `surface.response`.
 *
 * ============================================================================
 * STATUS: LIVE — WIRED INTO THE REAL FRAME LOOP (mythica-machina-press#137)
 * ============================================================================
 * `graph/passes.js#surface.prism` is `status: 'live'`. `vt-pan-viewer.js#
 * runSurfacePrismPass` runs every frame in the `surface` stage, right after
 * `surface.response` (Specular) and before `surface.water`: it asks
 * `prism-seams.js#getPrismMaskItems` for the CURRENT viewed floor's own
 * active tiles FIRST, and if that list is empty it returns immediately — a
 * true JS early-return (Effects.md Law 4), so a scene with no `_Prism` mask
 * anywhere pays for exactly one array-length check and nothing else: no
 * capture tick, no mesh sync, no draw call, no allocation. When at least one
 * tile IS active, it ticks `prism-refraction-subsystem.js` (the scene
 * capture tier 3 needs — bounded to the UNION of every active tile's own
 * rect, re-captured every frame it runs, mirroring `water-refraction-
 * subsystem.js`'s own "capture, then draw, same frame" shape exactly), syncs
 * `prism-surface-subsystem.js` (the per-tile mesh population — builds/
 * rebuilds materials, re-points the shared capture onto every live entry,
 * pushes the resolved look params), and finally draws whatever meshes came
 * back visible into `buf:scene.color`, additively, the identical guarded-
 * clear shape `runSurfaceResponsePass` already uses for Specular.
 *
 * Every supporting module this needed was already real and Node-tested
 * before the wiring landed: the manifest+params (this file), the pure
 * facet/glint/dispersion maths (`prism-motion.js`), the TSL material builder
 * (`prism-render.js`), the per-tile mask-discovery seam (`prism-seams.js`),
 * the scene-capture subsystem (`prism-refraction-subsystem.js`) and the
 * per-tile mesh population (`prism-surface-subsystem.js`, the one piece
 * added alongside the wiring itself, mirroring `specular-tile-surface-
 * subsystem.js`'s own shape). Correctness here means structurally sound,
 * follows this codebase's own established conventions exactly (the depth-
 * authority rank gate, the capture-then-draw same-frame shape, the JS-time
 * tier branch), and passes the full automated verify gate — this project's
 * own standing rule is that only the author's own live look, not a passing
 * test suite, confirms a visual effect actually looks right.
 *
 * @module effects/prism/prism
 */

/**
 * The authorable knobs (validated by core/params-schema.js), grouped by the
 * fixed ROH categories IN TIER ORDER (Glass → Facets → Glint → Dispersion —
 * see `prism-render.js`'s own tier ladder). Every numeric default below is
 * V2's OWN shipped default (`PrismEffectV2.js`'s own `this.params = {...}`,
 * recovered from git history) unless a comment says otherwise — the one
 * place this schema adds a genuinely new knob (`maskTintStrength`) is called
 * out as new, not disguised as a V2 value.
 * @type {Record<string, object>}
 */
export const PRISM_PARAMS = Object.freeze({
  // ── Glass (tier 0 — mask-gated placement) ─────────────────────────────────
  maskThreshold: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.9,
    category: 'Glass',
    label: 'Mask threshold',
    help: 'How bright the painted Prism mask must read before the surface starts refracting, on a smooth ramp up to fully-authored (1.0). Raise this if a soft, antialiased mask edge is refracting further than the crisp shape you painted.',
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.25,
    category: 'Glass',
    label: 'Opacity',
    help: "How strongly the refracted result replaces the plain surface beneath it. Low values read as a subtle sheen of glass over the art; high values read as if the surface itself were replaced by crystal. V2's own default keeps this subtle.",
  },
  brightness: {
    type: 'float',
    min: 0.5,
    max: 3,
    step: 0.01,
    default: 1.5,
    category: 'Glass',
    label: 'Brightness',
    help: 'A flat multiplier on the refracted colour — real glass and crystal both concentrate and brighten the light passing through them, so this is rarely left at a plain 1:1 pass-through.',
  },
  maskTintStrength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Glass',
    label: 'Mask colour tint',
    // NEW in this build — V2 only ever read the mask's R channel (a
    // greyscale threshold). `scene/mask-catalog.js`'s own `prism` entry
    // reads the file as a MATERIAL, the same upgrade `specular`'s own mask
    // already made: this lets an author paint a genuinely COLOURED crystal
    // (a green gem, a rose-quartz pane) whose refraction picks up that hue,
    // entirely opt-in — default 0 means an ordinary black-and-white mask
    // behaves exactly like V2's glass, tinting nothing.
    help: "How much the mask's own painted colour tints the light bending through it — 0 (default) is clear glass regardless of the mask's hue, matching V2's own greyscale-only reading; 1 fully tints the refraction toward whatever colour you painted (green mask, green-tinted crystal). Has no visible effect on an ordinary black-and-white mask.",
  },

  // ── Facets (tier 1 — procedural crystal shading) ──────────────────────────
  facetScale: {
    type: 'float',
    min: 1,
    max: 1000,
    step: 1,
    default: 254,
    category: 'Facets',
    label: 'Facet size',
    help: 'How many procedural crystal facets tile across the surface — higher values carve the glass into smaller, denser facets; lower values read as a few large flat panes.',
  },
  facetAnimate: {
    type: 'bool',
    default: true,
    category: 'Facets',
    label: 'Animate facets',
    help: "Lets the facet pattern itself slowly reshape over time, like light catching a slowly turning gem, rather than a perfectly still crystal. Off freezes the pattern at whatever shape it lands on — useful for a large, still architectural pane where V2's own live shimmer would read as busy.",
  },
  facetSpeed: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1.01,
    category: 'Facets',
    label: 'Facet animation speed',
    help: 'How quickly the facet pattern reshapes when animation above is on. Has no effect while it is off.',
  },
  facetSoftness: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.85,
    category: 'Facets',
    label: 'Facet softness',
    help: 'Blends between a hard-edged, obviously faceted crystal (0) and a smooth, glass-like surface with no visible facet edges at all (1). Most crystal looks sit high on this range; pure glass sits at 1.',
  },
  parallaxStrength: {
    type: 'float',
    min: 0,
    max: 5,
    step: 0.05,
    default: 2.4,
    category: 'Facets',
    label: 'Parallax strength',
    help: 'How much the facet pattern itself appears to shift as the camera pans, the way real facets catch different glints from different viewing angles. 0 pins the pattern to the surface with no parallax at all.',
  },

  // ── Glint (tier 2 — the moving highlight) ─────────────────────────────────
  glintStrength: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.4,
    category: 'Glint',
    label: 'Glint strength',
    help: 'How bright the rotating highlight reads where a facet catches the light edge-on. 0 removes the glint entirely, leaving a flatter (but still refractive) surface.',
  },
  glintThreshold: {
    type: 'float',
    min: 0,
    max: 0.99,
    step: 0.01,
    default: 0.13,
    category: 'Glint',
    label: 'Glint threshold',
    help: 'How precisely a facet must face the light before it catches the glint above — low values let many facets glint softly at once; high values reserve the glint for only the most precisely-aligned facets, reading as sharper, rarer sparkle.',
  },

  // ── Dispersion (tier 3 — real refraction of what's behind the glass) ─────
  intensity: {
    type: 'float',
    min: 0,
    max: 5,
    step: 0.05,
    default: 0.3,
    category: 'Dispersion',
    label: 'Refraction strength',
    help: "How far the image behind the glass bends, in the direction each facet's own slope points. 0 leaves the background undistorted (a tinted, glinting but optically flat pane); higher values read as thicker, more distorting glass.",
  },
  spread: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.6,
    category: 'Dispersion',
    label: 'Chromatic spread',
    help: "How far red and blue split apart from green at each facet's edge — the rainbow fringe real dispersive glass/crystal shows. 0 keeps refraction colour-neutral; higher values read as a more prismatic, rainbow-edged bend.",
  },
});

/** The schema defaults as a flat object. */
const PRISM_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(PRISM_PARAMS).map(([k, decl]) => [k, decl.default]))
);

/** No named presets ship yet — mirrors `lens.js#LENS_PRESETS`'s own "a real
 * (if currently empty) table" shape, so a caller never has to special-case
 * "this effect has no presets".
 * @type {Record<string, Record<string, number|boolean>>} */
export const PRISM_PRESETS = Object.freeze({ none: {} });

/**
 * Resolve a named preset to a full params object. @param {string} name
 * @returns {Record<string, number|boolean>}
 */
export function prismPreset(name) {
  return { ...PRISM_DEFAULTS, ...(PRISM_PRESETS[name] || {}) };
}

/**
 * The manifest.
 *
 * `visualWeight: 0.3` — a real, deliberate surface finish (the same class as
 * specular/water), but a NARROW one: unlike water/specular it only ever
 * covers whatever small area an author paints `_Prism` onto (a gem, a
 * stained-glass window, a crystal formation), never a whole floor by
 * default — closer to Fluid's own footprint than to Water's.
 *
 * `a11y.photosensitive: false` — the glint (tier 2) is a smooth, continuous
 * function of a slowly-rotating direction, never a strobe; nowhere near the
 * 3-30 Hz flicker band by construction, the same considered judgement
 * `lens.js`'s own header records for its autofocus pulses.
 *
 * `enabledFromProfile: 'extreme'` — mirrors `LENS`'s own current posture
 * (mythica-machina-press#556: "off by default" for a brand-new, not-yet-
 * live-tuned effect), for the identical reason even though this pass is now
 * genuinely `live`: nobody has watched Prism run against a real scene yet
 * (this project's own standing rule — only a live human check promotes a
 * built effect to a trusted default), and its own priciest rung is a real
 * scene-capture dependent read (tier 3, `Dispersion`, cost class C5 — the
 * same class `water`'s own tier 5 refraction is priced at) with an
 * ESTIMATED, not measured, `estMsPerMp`. `extreme` is the honest ceiling to
 * declare until the author's own eyes confirm the look and a real GPU sweep
 * confirms the cost — off by default, on by choice (the Studio card's own
 * enable switch reaches it at any profile), matching `Effects.md`'s own "an
 * effect nobody has tuned live yet does not get to claim a cheap profile"
 * posture.
 *
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const PRISM = Object.freeze({
  id: 'prism',
  title: 'Prism',
  visualWeight: 0.3,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'extreme',
  authoring: Object.freeze({ paint: 'prism' }),
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'partial',
    why:
      'COUNTED: the per-tile mask-image fetch (`prism-surface-subsystem.js#loadAndBuild`), async, with a ' +
      'mid-flight flag that clears on success and on failure alike — the identical shape `specularMaskLoad` ' +
      'already counts for its own per-tile population. NOT COUNTED: the material build it feeds is ' +
      'synchronous (no bake), and the scene-capture subsystem (`prism-refraction-subsystem.js`) allocates ' +
      'its own render target lazily on first tick, covered by settle.js`s pipeline-growth criterion rather ' +
      'than a dedicated probe — the same posture `bloom`/`post.lens` take for their own first-tick target ' +
      'allocation.',
    probes: ['prismTileMaskLoad'],
  }),
  params: PRISM_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'glass',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.08 }),
      adds:
        'THE MASK, TINTED, IN THE RIGHT PLACE — the painted Prism mask file discovered per tile ' +
        '(`prism-seams.js#getPrismMaskItems`, mirroring `getSpecularMaskItems`), a smoothstep presence ' +
        'gate off the mask`s own LUMA (never a strict R-only read — this kind`s own `meaning` in ' +
        'scene/mask-catalog.js), an optional colour tint from the mask`s own hue, and the SAME rank-gate ' +
        'occlusion window/specular already use (`buf:scene.depth`, one ordinal `step()` comparison) so a ' +
        'token or an upper floor correctly covers the glass. Never gated — the admission price, same ' +
        'posture water`s own tier 0.',
    }),
    Object.freeze({
      n: 1,
      name: 'facets',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.03 }),
      adds:
        'THE CRYSTAL ITSELF — a procedural facet field (`prism-motion.js#computeVoronoiFacet`, a pure-ALU ' +
        'cellular pattern transcribing V2`s own `voronoi()`, never a texture), each cell`s own offset read ' +
        'as a fake surface slope, blended toward a smooth glass fallback by `facetSoftness`, optionally ' +
        'animated (`facetAnimate`/`facetSpeed`) and nudged by a small camera-parallax term ' +
        '(`parallaxStrength`). Pure ALU on a UV already in hand — no new fetch beyond tier 0`s own mask ' +
        'read, which is why this rung is CHEAPER than tier 0`s admission-price VT read (Law 3 exempts ' +
        'tier 0 from the rungs-1..N monotonicity chain, the same shape water`s own tier 1 uses).',
    }),
    Object.freeze({
      n: 2,
      name: 'glint',
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.02 }),
      adds:
        'THE MOVING HIGHLIGHT — `dot()` between the facet slope above and a slowly rotating light ' +
        'direction, gated by `glintThreshold` and scaled by `glintStrength` (V2`s own formula, ' +
        '`PrismEffectV2.js#voronoi`/`main`, transcribed rather than reinvented). Pure ALU, no new fetch, ' +
        'so this stays at tier 1`s own C1 rather than manufacturing a false step up the ladder — the two ' +
        'rungs are split because glint is a genuinely separate, independently disable-able LOOK decision ' +
        '(a still, unlit-looking crystal vs. one that visibly catches light), not because it costs more.',
    }),
    Object.freeze({
      n: 3,
      name: 'dispersion',
      fromProfile: 'extreme',
      // FIRST RUNG THAT IS A DEPENDENT READ, NOT PURE ALU — same shape and
      // same reason `water`'s own tier 5 (`water.js#WATER.tiers[5]`) is
      // priced at C5: this needs a REAL capture of the finished frame
      // (`prism-refraction-subsystem.js`), which a same-pass drawable cannot
      // read (undefined behaviour on the GPU — the reason `surface.prism` is
      // its own pass rather than a drawable folded into `geometry.world`).
      cost: Object.freeze({ class: 'C5', estMsPerMp: 0.16 }),
      adds:
        'REAL REFRACTION — the facet slope above offsets a sample into a captured copy of the finished ' +
        "scene (`prism-refraction-subsystem.js`, adapting `water-refraction-subsystem.js`'s own proven " +
        'rect-capture math to a per-frame UNION of every active Prism tile`s rect), read as three ' +
        'separately-offset taps (R/G/B, spread apart by `spread`) for the rainbow chromatic fringe real ' +
        'dispersive glass shows — `intensity` sets how far the bend itself reaches. A genuine upgrade on ' +
        "V2`s own same-frame texel-offset approximation (`PrismEffectV2.js#main`'s own " +
        '`texture2D(uBaseMap, vUv + offsetR)`, which could only ever sample the SAME tile`s own art, never ' +
        'the actual scene behind the glass) — this is why the author`s own "make it better" permission ' +
        "names this exact pattern. Tap-validated against `buf:scene.depth` exactly like `water`'s own tier " +
        '5 (a refracted sample landing on something ranked above the glass falls back to the centre, ' +
        'undistorted UV) so a token standing on the crystal is never smeared into its own refraction.',
    }),
  ]),
  // Nothing deferred — every rung V2's own reference algorithm covers (mask
  // gate, facets, glint, chromatic dispersion) is a real, built, LIVE-WIRED
  // tier above. A real, separate follow-up exists (a floor-level population
  // alongside the tile one — `prism-seams.js`'s own header — and tile-motion
  // wiring — `prism-surface-subsystem.js`'s own header), but neither is a
  // rendering RUNG this manifest's own tier ladder would record —
  // `Object.freeze([])` mirrors `lens.js`'s/`precipitation.js`'s own "nothing
  // left to defer" declaration.
  deferredRungs: Object.freeze([]),
});
