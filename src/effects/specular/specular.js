/**
 * SPECULAR — the declaration (manifest + params schema), pure data, no THREE.
 * Same split as bloom/candle/door-graphics/water: this file is Node-validatable;
 * the TSL builders live in sibling render modules with THREE injected, never
 * imported. `docs/planning/Specular.md` is the design this implements.
 *
 * ============================================================================
 * ELEVEN CONTROLS REPLACE SIXTY-ONE, AND THAT IS THE HEADLINE
 * ============================================================================
 * V2's specular shipped 61 authored controls: 30 shimmer sliders across three
 * layers (density, speed, grain angle, cluster size, strength, parallax mix,
 * scatter, softness, elongation, on — each, three times), 11 wet-surface
 * controls, 4 sparkle, 4 frost, and the rest. Every one of them was global, so
 * a brass candlestick and a steel portcullis on the same map shared one grain
 * angle.
 *
 * They are not ported, and not because of a line budget. They existed to
 * hand-build the angular variation an orthographic camera over a flat map
 * deletes (`specular-material.js`'s header proves why V2 had no other option).
 * Restore the angles — a synthesised finite eye height, a real half-vector, a
 * real Fresnel — and every one of those thirty becomes a property of the paint
 * instead of a slider:
 *
 *   V2's "grain angle / cluster size / elongation" → the mask's own hue+value.
 *   V2's 11 wet controls                          → `roughness × (1 − wetness)`.
 *   V2's 4 frost controls                         → three shifts on one lobe.
 *
 * A control survives here only if it is a property of a MATERIAL or of the
 * WORLD. Anything that is a property of a noise generator is a symptom.
 *
 * ============================================================================
 * PARAMS ARRIVE WITH THEIR CONSUMER, ONE TIER AT A TIME
 * ============================================================================
 * `params/no-dead-controls` fails the build the moment a key exists with no
 * consuming source — the wall that exists because V2's water shipped 46 live
 * sliders over zero implementing GLSL, and V2's specular shipped a
 * fully-labelled "Micro sparkle" folder whose `sparkleEnabled` defaulted to
 * `false`. Every key below is read by `specular-render.js` TODAY. Tiers 3-8
 * add theirs alongside the code that consumes them, never ahead of it.
 *
 * @module effects/specular/specular
 */

/**
 * Tiers 0-2's knobs — and only theirs. Each is read by
 * `effects/specular/specular-render.js`, whose exported defaults are the single
 * source of truth for the values, so a change lands in both places or neither.
 */
export const SPECULAR_PARAMS = Object.freeze({
  // ── Look ────────────────────────────────────────────────────────────────
  strength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Look',
    label: 'Shine strength',
    help: 'Master strength of every highlight this effect draws. Turn it down if metal reads as too hot against the rest of the map; turn it to 0 to see what the map looks like with no shine at all.',
  },
  polish: {
    type: 'float',
    min: -1,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Look',
    label: 'Polish',
    help: 'Shifts every painted surface toward duller (left) or more mirror-like (right), without repainting the mask. How polished each thing is comes from how BRIGHT you painted it — this is the global thumb on the scale when a whole map reads too glossy or too flat.',
  },
  metalResponse: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.85,
    category: 'Look',
    label: 'Metal response',
    help: 'Whether the shiny things on this map are METAL or something clear like glass, glaze or wet stone. High = metal: bright, strongly reflective, and it takes over from the art underneath. Low = a clear coating: a faint sheen sitting on top of art that still shows through. This is one statement about a map rather than something you paint per-brushstroke, because what your mask already tells us is WHICH metal (from its colour), not whether it is one.',
  },
  viewerHeight: {
    type: 'float',
    min: 0.3,
    max: 8,
    step: 0.05,
    default: 1.5,
    category: 'Look',
    label: 'Viewer height',
    help: 'How far above the map your eye sits, measured against how much of the map is on screen. This is what makes highlights SWEEP as you scroll, the way a real shield glints when you lean over a table. Low = leaning right over it, a strong obvious sweep; high = standing well back, the flat static look where a highlight never moves. Measuring it against the view rather than in pixels is deliberate — it means the sweep behaves the same whether you are zoomed out on the whole map or in close on one blade.',
  },
  relief: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1.2,
    category: 'Look',
    label: 'Relief',
    help: 'How much the map art’s own painted detail shapes the highlights. Your artist already painted every cobble, plank and rivet with its light and shade, and this reads that back as surface shape — so a highlight breaks up across texture instead of sitting as one flat sheen. This is the control that makes metal look like metal rather than like a glow. Turn it to 0 for a perfectly smooth, glassy surface.',
  },
  // ── Outdoor ─────────────────────────────────────────────────────────────
  sunGlint: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.01,
    default: 1,
    category: 'Outdoor',
    label: 'Sun glint',
    help: 'Strength of the single hard highlight the sun makes on outdoor metal. Its position follows the time of day, so it sweeps across the map as the hours pass and stretches into a long streak near sunrise and sunset.',
  },
  skySheen: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Outdoor',
    label: 'Sky sheen',
    help: 'Strength of the broad, even glow outdoor surfaces pick up from the open sky above them. This is the one that makes wet stone read blue-grey on a clear day and flat grey under cloud — the sky is a huge soft light source and metal underneath it can see all of it.',
  },
  // ── Indoor ──────────────────────────────────────────────────────────────
  ambientSheen: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Indoor',
    label: 'Ambient sheen',
    help: 'The flat, everywhere-at-once shine metal picks up just from being in a lit room, with no torch pointed at it in particular — the indoor twin of Sky sheen. This is what lets a gold fixture read as gold in ordinary room light, not only under a torch. Turn it down for metal that should only catch light directly from a nearby source.',
  },
  lampGlint: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.01,
    default: 1,
    category: 'Indoor',
    label: 'Lamp glint',
    help: 'Strength of the SHARP highlight indoor metal picks up when a torch, lantern or other light sits close enough to catch it directly — on top of the ambient sheen above, not instead of it. This is the one that makes a candlestick glint as you carry a torch past it.',
  },
  lampHeight: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.55,
    category: 'Indoor',
    label: 'Lamp height',
    help: 'How high the lights hang above the floor. Low values make long grazing streaks across a flagstone hall; high values make tight pools of glint directly under each sconce.',
  },
});

/**
 * The manifest — the effect as data (Effects.md §2 shape). `tiers` lists only
 * what is ACTUALLY BUILT (bloom and water set the same precedent); the rest of
 * the ladder `docs/planning/Specular.md` §6 designs is recorded in
 * `deferredRungs` — named, ordered, but not yet real code — so the manifest
 * never claims more exists than does.
 *
 * `visualWeight: 0.7` — a material read, defended below water's landscape-scale
 * 0.8 but above pure polish: metal that stops responding to light reads as a
 * lighting bug, not as a missing effect.
 *
 * `enabledFromProfile: 'low'` — tiers 0-2 are one mask read and arithmetic, and
 * the effect is inert on any scene with no `_Specular` file (`absentValue: 0`
 * in the catalog), so default-on cannot surprise a scene that never opted in.
 * That is what makes `feedback_default_on_new_features` the easy call here,
 * where the sky light had to take a logged exception.
 *
 * `a11y.photosensitive: false` — tiers 0-2 have no flicker of any kind. The
 * highlights move, but they move with the CAMERA and with the CLOCK, which is
 * ordinary parallax, not the rapid high-contrast flashing WCAG's photosensitive
 * criterion targets. ⚠️ **Revisit at tier 3**, which is the glint rung and the
 * first that twinkles.
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
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'presence',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.08 }),
      adds:
        'The specular mask, at its authored resolution, in the right place on the right floor, ' +
        'responding to how lit it is — cropped to the metal`s own AABB (Law 6) and gated to the ' +
        'visible floor by buf:scene.attr. Never gated; carries the correctness gate.',
    }),
    Object.freeze({
      n: 1,
      name: 'material',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.02 }),
      adds:
        'The mask read as a MATERIAL rather than a tint — hue→F0, saturation→metalness, ' +
        'value→smoothness — and the two-blend composite that lets real metal suppress the diffuse ' +
        'it replaces. Pure ALU on tier 0`s fetch. Gold stops being a yellow glow.',
    }),
    Object.freeze({
      n: 2,
      name: 'skyAndLamps',
      cost: Object.freeze({ class: 'C3', estMsPerMp: 0.05 }),
      adds:
        'The synthesised finite eye height, Schlick Fresnel, and the indoor/outdoor split: two ' +
        'analytic sky lobes outdoors (dome + sun disc, from the sky handle), TWO analogous terms ' +
        'indoors (an ambient dome from illum`s own value, plus a directional lamp lobe from its ' +
        'gradient), mixed per-pixel by the outdoors mask. THE rung where a highlight first MOVES. ' +
        'The ambient-indoor half landed 2026-07-26 after shipping without it: a room lit only by ' +
        'ambient/global fill, with no lamp close enough to create a gradient, measured to exactly 0.',
    }),
    Object.freeze({
      n: 3,
      name: 'relief',
      cost: Object.freeze({ class: 'C3', estMsPerMp: 0.05 }),
      adds:
        'THE RUNG THAT MAKES THE OTHERS VISIBLE. Four taps of buf:scene.color give the map art`s own ' +
        'painted luminance gradient, read as surface slope — so the normal varies per pixel and the ' +
        'highlight breaks across texture instead of sitting as one flat wash. Measured: a flat normal ' +
        'holds every pixel at 0.39 of scene brightness; tilting toward the mirror angle reaches 6.3. ' +
        'Costed as a C4 VT read when it was designed as rung 6 — wrong, buf:scene.color is already in ' +
        'the graph, so it is C3 and always belonged here. Fades out by itself when zoomed out.',
    }),
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0), the ladder
  // docs/planning/Specular.md §6 designs in full. Each becomes a real `tiers`
  // entry, with its own cost class and its own phase's render code, in order.
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'microsurface',
      note:
        'Footprint-aware glint: count microfacets per pixel from fwidth(worldPos) and blend between ' +
        'discrete twinkle (few) and roughness-widened smooth lobe (many), so sparkle RESOLVES with ' +
        'zoom instead of aliasing the way V2`s fixed world lattice did.',
    }),
    Object.freeze({
      name: 'context',
      note:
        'buf:scene.coloration for per-lamp highlight colour, sun-occlusion visibility on the glint, ' +
        'and weather — wet as a smooth dielectric clear coat, frost as roughness-up + cool F0.',
    }),
    Object.freeze({
      name: 'grain',
      note:
        'The specular SDF pack (the same jump flood water bakes): per-object anisotropy along the ' +
        'shape`s own tangent, the edge bevel that traces each metal silhouette, distance-driven polish.',
    }),
    Object.freeze({
      name: 'dispersion',
      note:
        'Thin-film iridescence and prism dispersion as a function of the now-varying cos θ and a ' +
        'thickness from the distance field. Absorbs IridescenceEffectV2 + PrismEffectV2.',
    }),
    Object.freeze({
      name: 'reflection',
      note:
        'Roughness-indexed sample of the PREVIOUS frame`s bloom pyramid along the reflection vector — ' +
        'a bright-pass pyramid holds exactly what a dark polished floor reflects. Coverage/zoom-gated.',
    }),
  ]),
});
