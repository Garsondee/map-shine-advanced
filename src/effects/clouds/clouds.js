/**
 * CLOUDS — the LOOK layer's authorable knobs (params schema + manifest), same
 * three-way split `depth-of-field.js`'s own header names as the template
 * every post-DOF effect copies: this file is the DECLARATION (pure data, no
 * THREE); the field itself lives in `world/cloud-field.js` (data owner, per
 * `world/cloud-field.js`'s own header: *"this file is a sibling of `sun.js`
 * and `wind-field.js`: pure... `effects/clouds/` owns the manifest, the
 * params and the tier ladder; it reads this."*); the TSL material wiring
 * lives inline in `vt/vt-pan-viewer.js` (there is no separate `clouds-
 * render.js` — the shadow/window/point-light terms are built directly where
 * their host materials already are, `environmental-light.js`/`window-
 * render.js`/`point-light-illumination.js`, each taking the field builder
 * and these uniforms as injected params per `zones/one-door`).
 *
 * ============================================================================
 * WHAT THIS MANIFEST DOES AND DOES NOT OWN
 * ============================================================================
 * `cloudCover01`/`cloudType01`/`cloudAltitudePx`/`cloudScalePx` are WEATHER
 * AXES (`world/weather.js#WEATHER_AXES`, Weather-Manager LAW 3: "weather axes
 * own the data, effects are look-only") — authored on the astrolabe/weather
 * board, NOT here, and this schema does not duplicate them. Everything below
 * is genuinely LOOK: how dark a shadow gets, how blurred, how fast the deck
 * drifts, how far a low sun can throw it, how loud the window's own overcast
 * mood reads. `enabled: false` (the cascade's own toggle) turns off the
 * shadow/window/point-light DARKENING specifically (forces the live shadow
 * strength to 0) without touching the field's own silhouette or the
 * grade/sky desaturation, which shipped wired-in before this card existed
 * and are not this effect's own look, the same scope DOF's own "enabled"
 * only ever gated its blur pass, never the floor buffer it reads.
 *
 * Author's ask (2026-09-10, live-test round 2, after confirming shadows
 * finally render and move): *"Every effect needs a very wide selection of
 * controls to author the look of them and you've provided me with nothing.
 * I even want specific controls to change the blur, tightness, strength,
 * darkness of shadows and lots and lots more, with very wide ranges so that
 * I can find you good values."* Ten params, four categories — genuinely wide
 * per-param ranges (a caller can push well past the shipped default in
 * either direction) rather than a narrow band around today's tuning.
 *
 * @module effects/clouds/clouds
 */

/**
 * @type {Record<string, object>}
 */
export const CLOUD_LOOK_PARAMS = Object.freeze({
  // ── Look ────────────────────────────────────────────────────────────────
  shadowStrength: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Look',
    label: 'Shadow strength',
    help: "How dark a passing cloud can make the ground and window light. 0 = no shadow at all; 1 = today's natural depth (derived from the sun/sky split, shallow at dawn, absent at night); past 1 exaggerates it darker than that natural ceiling allows.",
  },
  shadowBlur: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.08,
    category: 'Look',
    label: 'Shadow blur',
    help: "How soft the shadow's own edge is, even under a clear sky with light cloud. 0 = the shadow traces the cloud's own silhouette exactly; higher values widen the transition into a soft penumbra.",
  },
  shadowBlurCoverGain: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 0.4,
    category: 'Look',
    label: 'Shadow blur (overcast gain)',
    help: 'How much EXTRA blur gets added on top of Shadow blur as cover rises toward fully overcast — real heavy overcast diffuses light into a much bigger source, so its shadows read far softer than a single fair-weather puff. Total blur = Shadow blur + this × current cover.',
  },
  visualCoverMax: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.45,
    category: 'Look',
    label: 'Visual cover cap',
    help: "Caps how solid the RENDERED cloud silhouette can look, independent of how gloomy the mood gets — a meteorologically 100% overcast sky still feels maximally gloomy through the shadow/grade/window terms even at this cap, it just never paints every pixel flat white. Raise toward 1 for a sky that visually whites out at high cover; today's default keeps texture visible even at max cover.",
  },
  // ── Motion ──────────────────────────────────────────────────────────────
  speedMul: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    // 2026-09-10 — author's own literal ask: "Clouds move far too fast at
    // full wind speed, halve all wind speed effects on cloud movement."
    default: 0.5,
    category: 'Motion',
    label: 'Cloud speed',
    help: "Multiplies how fast the deck drifts with wind. 1 = the ambient wind's own speed, unscaled; this ships at half that (the author's own live-tested value) because a deck moving at full wind speed read as too fast. 0 holds the deck still regardless of wind.",
  },
  minWindSpeed01: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.12,
    category: 'Motion',
    label: 'Minimum drift (calm floor)',
    help: "A floor under the wind speed this deck's own drift reads — never fed back into the ambient wind itself, so grass/particles still see genuine calm. Keeps the deck crawling even at total ground-level dead calm, since upper-level wind exists even on a still surface day. 0 lets the deck freeze solid at calm.",
  },
  // ── Extent ──────────────────────────────────────────────────────────────
  maxOffsetPx: {
    type: 'float',
    min: 0,
    max: 20000,
    step: 50,
    default: 9000,
    category: 'Extent',
    label: 'Max shadow reach',
    help: "How far, in world pixels, a low sun can throw a cloud's shadow before its own soft knee caps further growth — a cloud's cause being off toward the map's edge at sunset is correct and expected, this just bounds how far that reach is allowed to go.",
  },
  // ── Light (the window's own overcast mood) ─────────────────────────────
  windowOvercastBlur: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.22,
    category: 'Light',
    label: 'Window blur (overcast)',
    help: "How much extra softening heavy overcast adds to a window's own light cookie edge, independent of any cloud directly overhead — a global sky-mood response, not a moving shadow. 0 = window edges never soften with overcast.",
  },
  windowOvercastFlatten: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.6,
    category: 'Light',
    label: 'Window flatten (overcast)',
    help: "How much heavy overcast flattens a window cookie's own internal contrast toward neutral — the other half of a diffuse, gloomy interior look. 0 = window contrast never responds to overcast.",
  },
  windowOvercastMinStrength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    category: 'Light',
    label: 'Window dim floor (overcast)',
    help: "The darkest heavy overcast can push a window's own light strength to. 1 = overcast never dims window light at all; 0 = a fully overcast sky can extinguish it entirely. The author's own ask was 'drop its overall brightness by up to 50%', which is exactly this default.",
  },
});

/** The schema defaults as a flat object — the base a preset diffs over.
 * No presets ship yet (author asked for wide ranges to explore, not a
 * curated ladder) — kept for parity with `depth-of-field.js`'s own shape in
 * case that changes later; unused today. */
const CLOUD_LOOK_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(CLOUD_LOOK_PARAMS).map(([k, decl]) => [k, decl.default]))
);

/**
 * Resolve to a FULL params object (defaults, since no named presets exist
 * yet) — mirrors `depth-of-field.js#dofPreset`'s shape for a future preset
 * table to slot into without a call-site change.
 * @returns {Record<string, number>}
 */
export function cloudLookDefaults() {
  return { ...CLOUD_LOOK_DEFAULTS };
}

/**
 * The manifest — the effect as data (Effects.md §2 shape). `id: 'clouds'` is
 * load-bearing: `boot.js`'s existing `MapShine.debug.registerReport('clouds',
 * ..., {effect: 'clouds'})` diagnostic and the Studio card both already key
 * off this exact id.
 *
 * `enabledFromProfile: 'low'` = ON at every performance profile by default
 * (feedback_default_on_new_features) — matches the research note this
 * feature's own design doc left on this exact question ("clouds must be
 * enabledFromProfile: 'low' because sun-shadows.js is off entirely there" —
 * the shadow/window/point-light terms here have no tier-gated cost of their
 * own to hide behind a higher floor). A single tier-0 rung is fully legal
 * (`effect-manifest.js` only requires a non-empty `tiers` array); there is
 * no second rung because nothing about this look layer scales with
 * performance profile the way DOF's pyramid depth does — the SAME `octaves`/
 * `cells`/`erode` tier ladder that DOES scale with cost lives on the field
 * itself (`world/cloud-field.js`), read by `buildCloudFieldNode`'s own
 * callers, not by anything this manifest's `params` touch.
 *
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const CLOUD_LOOK = Object.freeze({
  id: 'clouds',
  title: 'Clouds',
  // A whole-sky atmospheric effect, always visible outdoors once weather
  // carries any cover at all — weighted above DOF's situational 0.55 (DOF
  // only shows through a hole to a lower floor; this is visible on every
  // outdoor scene with cloud cover set).
  visualWeight: 0.6,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: "Pure ALU TSL graphs reading a CPU-pushed uniform set (world/cloud-field.js) — no lazy target, no asset, no bake, same posture depth-of-field.js's own readiness note takes. The first draw compiles pipelines, covered by the global pipeline-growth criterion.",
  }),
  params: CLOUD_LOOK_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'shadow-and-window-mood',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.05 }),
      adds:
        "the ground-ambient cloud shadow (streaked by sun angle), the window's per-pixel cloud factor + global " +
        "overcast blur/flatten/dim, and the SAME shadow term reaching every point light's own background floor " +
        "— all reading this manifest's own live params (strength/blur/speed/reach/window-mood).",
    }),
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0).
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'cloud-tops',
      note:
        'lit cloud shapes seen from above, zoom-gated with parallax (docs 02) — effects/clouds/cloud-shade.js ' +
        'already builds the shading; nothing calls it from the live viewer yet. A genuinely separate feature ' +
        "from this manifest's own shadow/mood params, not a missing tier of them.",
    }),
    Object.freeze({
      name: 'streak-and-tap-count-as-live-params',
      note:
        "the sun-angle streak spread/tap-count and the field sample's own octave/cells/erode tier are JS-time " +
        "constants baked into the compiled shader graph's STRUCTURE at material construction — changing them " +
        'live needs a material rebuild, not a uniform poke, unlike every param in this schema. Left as tuned ' +
        'constants (world/cloud-field.js#CLOUD_SHADOW_STREAK_SPREAD and callers) rather than exposed here, this round.',
    }),
  ]),
});
