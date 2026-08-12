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
    default: 0.5,
    category: 'Look',
    label: 'Strength',
    help: 'Overall blend intensity of the below-floor blur. 0 = invisible; 1 = the blurred floors fully replace their sharp source.',
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
export const DOF_PRESETS = Object.freeze({
  none: {},
  subtle: { strength: 0.55, blurPerFloor: 0.7, maxBlur: 0.6 },
  moderate: { strength: 0.85, blurPerFloor: 1.2, maxBlur: 0.85 },
  heavy: { strength: 1.0, blurPerFloor: 2.2, maxBlur: 1.0 },
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
  params: DOF_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'floor-distance-mip-blur',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.15 }),
      adds:
        'a 4-level downsample pyramid of scene.lit, sampled per-pixel at a fractional mip level driven by ' +
        "buf:scene.depth's floor index vs the currently viewed floor, composited back via NormalBlending " +
        '(alpha=0 on the current floor, so it is left byte-identical)',
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
    Object.freeze({
      name: 'performance-tiers',
      note: 'governor-driven mip count / resolution scale per performance profile (Effects.md §6) — tier 0 is a fixed 4-mip chain',
    }),
  ]),
});
