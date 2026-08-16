/**
 * UI WINDOW SHADOW — MSA's FIRST registered effect, declared as data.
 *
 * The runtime (the box-SDF shader + the DOM window reader) lives in
 * `effects/lighting/light-visibility.js` and `vt/vt-pan-viewer.js`; THIS file is
 * the effect's DECLARATION — its params schema and its manifest — the two data
 * artifacts the registry, the settings cascade and the (future) governor read.
 * Keeping the declaration separate from the runtime is the point: the manifest
 * is pure data with no `apply` and no field name, so nothing can special-case
 * this effect by id (docs/planning/Effect-Registration.md §6).
 *
 * NOTE what is NOT here: `enabled` is not a param — whether the effect runs is
 * resolved by the CASCADE (profile → GM → player → a11y, effect-cascade.js),
 * not stored as a knob. And the runtime's `lastWindowCount`/`lastStampCount` are
 * READOUTS (derived status the debug panel shows), never params — V2's
 * diagnostics mutated product params precisely because status had no other home
 * (Params.md §3.6.2). This schema is the LOOK + TECHNICAL knobs only.
 *
 * @module effects/ui-window-shadow
 */

/**
 * The authorable knobs. Validated by `core/params-schema.js` (Node-tested), and
 * the single source the config UI is generated from (Effects-UI.md — no control
 * is ever hand-written). `category` is presentation (which panel group), not
 * contract, so it rides beside `label`/`help`. Defaults match the effect's
 * current live tuning (vt-pan-viewer.js `_uiShadowState` / DEFAULT_WORKSPACE_LIGHT).
 *
 * @type {Record<string, object>}
 */
export const UI_SHADOW_PARAMS = Object.freeze({
  strength01: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.4,
    category: 'Look',
    label: 'Shadow strength',
    help: 'How dark the window shadow is at its core (0 = invisible, 1 = black). A soft grey reads best.',
  },
  azimuthDeg: {
    type: 'float',
    min: 0,
    max: 360,
    step: 1,
    default: 315,
    category: 'Look',
    label: 'Light direction',
    help: 'Compass direction the (imaginary) workspace light comes from. 315 = upper-left, throwing the shadow down-right.',
  },
  elevationDeg: {
    type: 'float',
    min: 1,
    max: 90,
    step: 1,
    default: 55,
    category: 'Look',
    label: 'Light height (angle)',
    help: 'How high the light sits. 90 = straight overhead (shadow directly under the window); lower = a longer, softer throw.',
  },
  offsetScale: {
    type: 'float',
    min: 0.1,
    max: 20,
    step: 0.1,
    default: 5,
    category: 'Look',
    label: 'Shadow distance',
    help: 'How far the shadow is thrown from its window. Purely how FAR — does not change the softness.',
  },
  heightPx: {
    type: 'float',
    min: 0,
    max: 200,
    step: 1,
    default: 26,
    category: 'Look',
    label: 'Float height',
    help: 'How high the window "floats" above the map. Higher = a softer, more spread-out shadow edge.',
  },
  baseSoftnessPx: {
    type: 'float',
    min: 0,
    max: 100,
    step: 1,
    default: 10,
    category: 'Look',
    label: 'Edge softness',
    help: 'The minimum feather on the shadow edge, in pixels. Higher = blurrier edge.',
  },
  maxOffsetPx: {
    type: 'float',
    min: 0,
    max: 2000,
    step: 10,
    default: 400,
    category: 'Technical',
    label: 'Max shadow distance (px)',
    help: 'A cap so a very low light angle cannot throw the shadow off across the whole map.',
  },
  scanEveryNFrames: {
    type: 'int',
    min: 1,
    max: 60,
    step: 1,
    default: 6,
    category: 'Technical',
    label: 'Window scan interval (frames)',
    help: 'How often the open windows are re-measured. Higher = less CPU cost, slightly laggier shadow while a window is dragged.',
  },
  flipY: {
    type: 'bool',
    default: false,
    category: 'Technical',
    label: 'Flip shadow vertically',
    help: 'Escape hatch: turn on only if the shadow ever lands on the mirror-image (wrong) side of every window.',
  },
});

/**
 * The manifest — the effect as data (Effects.md §2 shape). `enabledFromProfile:
 * 'extreme'` is the author's "optional, expensive, powerful systems only"
 * decision expressed as a profile gate (it costs ~50fps; Effect-Registration.md
 * §4). As it gets cheaper, that field walks down the profiles until it is simply
 * always on — the ambition lives in the same field that gates it.
 *
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const UI_WINDOW_SHADOW = Object.freeze({
  id: 'uiWindowShadow',
  // Human-facing name for generated settings/UI (presentation, not contract).
  title: 'UI window shadows',
  // Decorative chrome — the first thing to drop when the frame budget shrinks.
  visualWeight: 0.3,
  // Does not flash — but the flag is declared so the accessibility gate is real
  // for the flashing effects (lightning, animated light) that come later.
  a11y: Object.freeze({ photosensitive: false }),
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'A uniform push and nothing else — it has no draw call at all by design (the v6 perf fix removed its extra pass), so there is no target, no asset, no bake and no pipeline of its own to wait for.',
  }),
  // Off by default below Extreme (expensive). See the header.
  enabledFromProfile: 'extreme',
  params: UI_SHADOW_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'soft-offset',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.1 }),
      adds: 'open UI windows cast a soft, offset shadow on the map',
    }),
  ]),
  // Recorded, NOT built — rungs so the deferred features do not rot (Effects.md §0).
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'parallax-by-floor',
      note: "scale the shadow's throw + softness by the active floor's elevation (native scene.levels) — the illusion of height when looking at an upper floor",
    }),
    Object.freeze({ name: 'tinted-shadow', note: 'a warm workspace-key tint instead of neutral grey' }),
    Object.freeze({
      name: 'per-window-height',
      note: 'a small tooltip floats lower (shorter shadow) than a full character sheet',
    }),
  ]),
});
