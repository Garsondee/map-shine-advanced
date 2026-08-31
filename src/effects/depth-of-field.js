/**
 * DEPTH OF FIELD — the floor-distance blur, and the first `post` stage
 * effect to consume `buf:scene.depth` (docs/planning/Depth-of-Field.md,
 * `graph/passes.js` `post.dof`).
 *
 * THIS FILE IS THE DECLARATION (params schema + manifest + presets) — pure
 * data, no THREE. The pure blur-distance math lives in
 * `effects/depth-of-field-blur.js` (Node-testable, no THREE); the TSL
 * material builders live in `effects/depth-of-field-render.js` (THREE
 * injected). Runtime is a `runPostDofPass` closure in `vt/vt-pan-viewer.js`.
 * Same three-way split as bloom (`bloom.js` + `bloom-render.js` +
 * `runPostBloomPass`), which `post.bloom` names as the template every later
 * post effect copies.
 *
 * THE TECHNIQUE (docs/planning/Depth-of-Field.md): a modernized rebuild of
 * V2's `FloorDepthBlurEffect` (a per-floor Kawase blur, re-rendering and
 * Porter-Duff compositing each floor below the active one separately). The
 * INTENT survives — more blur, the further below the viewer a floor sits —
 * but the mechanism is now one unified pass reading `buf:scene.depth`'s
 * per-pixel floor index, instead of N separate floor renders: a plain
 * downsample pyramid of `scene.lit` is built once, and each pixel samples a
 * fractional mip level chosen from how many floors below the CURRENTLY
 * VIEWED floor that pixel's own content sits on. The current floor's own
 * graphics are guaranteed untouched by construction — see
 * `depth-of-field-render.js`'s header for the blend-arithmetic proof, not a
 * conditional branch.
 *
 * @module effects/depth-of-field
 */

/**
 * The authorable knobs (validated by core/params-schema.js). One band, not
 * bloom's two — this effect has a single blur ramp, so it needs fewer
 * controls. Grouped by the fixed ROH categories (diag/effect-controls.js
 * CATEGORY_ORDER).
 *
 * @type {Record<string, object>}
 */
export const DOF_PARAMS = Object.freeze({
  // ── Look ────────────────────────────────────────────────────────────────
  strength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    // 2026-08-27 — was 0.5, ~4x too strong per Ingram's own live read (even
    // ONE floor below already reached lod~0.6 of a 3-level ramp against the
    // old default; see DOF_PRESETS' own note just below for the matching
    // preset rescale). `strength` is a clean multiplier on the blur RADIUS
    // (computeDofMipSample, depth-of-field-blur.js) with no other coupling,
    // so a straight divide-by-4 is the correct, isolated fix.
    default: 0.125,
    category: 'Look',
    label: 'Strength',
    help: "Overall amount of blur applied to floors below the one you're viewing — scales the blur radius, not its opacity. 0 = no extra blur (floors below sample the least-blurred mip); 1 = the full ramp set by Blur per floor and Maximum blur. A below-floor pixel is always a full replace, never a sharp/blurred cross-fade.",
  },

  // ── Extent (reach / spread) ───────────────────────────────────────────────
  blurPerFloor: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1.2,
    category: 'Extent',
    label: 'Blur per floor',
    help: "How fast the blur ramps up per floor of distance below the one you're viewing. Higher = a floor just one level down already reads strongly out of focus.",
  },
  maxBlur: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1.0,
    category: 'Extent',
    label: 'Maximum blur',
    help: 'Caps how far the blur can reach, as a fraction of the full range. Lower this if very distant floors turn to unreadable mush.',
  },
});

/**
 * Named looks, shipped as DATA (the grade-ops.js preset pattern). Reuses V2
 * `FloorDepthBlurEffect`'s own preset NAMES (`docs/reference/v2-effect-params/
 * floor-depth-blur-effect.md`) — only the intent carries over (a Kawase-px
 * radius has no equivalent here), matching bloom's own "re-tuned for the new
 * math" precedent.
 *
 * @type {Record<string, Record<string, number>>}
 */
// 2026-08-27 — `strength` rescaled ÷4 in step with the schema default above
// (each was already `strength.default`-relative when authored: subtle
// 0.55 ≈ 1.1× the old 0.5 default, moderate 0.85 ≈ 1.7×, heavy 1.0 = 2×) —
// same ÷4, so "subtle" still reads as gentler than the new 0.125 default and
// the ladder's own relative spacing survives untouched. `blurPerFloor`/
// `maxBlur` are unaffected — Ingram's own report was about overall blur
// AMOUNT (strength), not how fast it ramps per floor or where it caps.
export const DOF_PRESETS = Object.freeze({
  none: {},
  subtle: { strength: 0.14, blurPerFloor: 0.7, maxBlur: 0.6 },
  moderate: { strength: 0.21, blurPerFloor: 1.2, maxBlur: 0.85 },
  heavy: { strength: 0.25, blurPerFloor: 2.2, maxBlur: 1.0 },
});

/** The schema defaults as a flat object — the base a preset diffs over. */
const DOF_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(DOF_PARAMS).map(([k, decl]) => [k, decl.default]))
);

/**
 * Resolve a named preset to a FULL params object (defaults + the named diff).
 * Unknown name ⇒ the plain defaults. Mirrors `bloom.js#bloomPreset`.
 * @param {string} name
 * @returns {Record<string, number>}
 */
export function dofPreset(name) {
  return { ...DOF_DEFAULTS, ...(DOF_PRESETS[name] || {}) };
}

/**
 * The manifest — the effect as data (Effects.md §2 shape).
 *
 * `enabledFromProfile: 'low'` = ON at every performance profile by default
 * (feedback_default_on_new_features: ship the best look, dial DOWN on
 * request — matches bloom's and grade's own default). Cost is a downsample
 * pyramid (4 small mips, no upsample/recombination pass — cheaper than
 * bloom's own 6-mip dual-band pipeline) plus one fullscreen composite draw,
 * and the whole pass is a zero-GPU-work early return whenever the viewed
 * floor is the ground floor (nothing can be below it) — see
 * `vt-pan-viewer.js#runPostDofPass`. `a11y.photosensitive: false` — a
 * blur, not a strobe.
 *
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const DEPTH_OF_FIELD = Object.freeze({
  id: 'depthOfField',
  title: 'Depth of Field',
  // A situational whole-image effect — only ever visible from an elevated
  // floor looking down through a hole, so weighted below bloom (0.7, always
  // contributing something) but still a meaningful part of "the environment
  // reads as real" once triggered.
  visualWeight: 0.55,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'A post chain over frame-graph-owned buffers — no lazy target, no asset, no bake. Its first draw compiles pipelines, which the global pipeline-growth criterion covers. Worth noting for whoever changes this: the whole pass switches on and off with the viewed floor, so its FIRST draw can be a floor switch rather than scene load.',
  }),
  params: DOF_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'floor-distance-mip-blur',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.08 }),
      adds:
        'a 2-level downsample pyramid of scene.lit, sampled per-pixel at a fractional mip level driven by ' +
        "buf:scene.depth's floor index vs the currently viewed floor, composited back via NormalBlending " +
        '(alpha=0 on the current floor, so it is left byte-identical) — a genuinely coarser blur ramp than ' +
        'the full pyramid (tier 1), not a crop of the same one: a below-floor pixel still reads as blurred, ' +
        'just with less resolvable falloff between "just below" and "far below".',
    }),
    Object.freeze({
      n: 1,
      name: 'four-level-pyramid',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.15 }),
      adds:
        "the pyramid deepens to 4 levels — twice today's tier-0 resolution in the blur ramp, the SAME " +
        'pipeline this effect has always shipped. Wired 2026-08-29: `buildDofMaterials` (depth-of-field-' +
        'render.js) was already fully generic in mip count (`mipCount`/`topLod` derive from however many ' +
        'textures it is handed, never a hardcoded 4) — the gap was that the VIEWER always built it with ' +
        'all 4 mips regardless of profile. See docs/planning/Effect-Tier-Gradient-Audit-2026-08-29.md §3.3.',
    }),
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0).
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'soft-floor-edge',
      note:
        'a smoothstep-based feather across the floor-index boundary instead of a hard cut — cosmetic polish, ' +
        'the hard edge is already pixel-crisp (NEAREST full-screen-res sample), not blocky',
    }),
    Object.freeze({
      name: 'fog-of-war-clip',
      note: "darken/skip the blur under fog-of-war once MSA renders its own fog — same deferred hook bloom's own clamp names (keyhole-vision-fog-direction)",
    }),
  ]),
});
