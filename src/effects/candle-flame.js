/**
 * CANDLE FLAME — MSA's SECOND registered effect, and the first ported from V2.
 *
 * THIS FILE IS THE DECLARATION (params schema + manifest) — the data the
 * registry, the settings cascade and the (future) governor read. The runtime
 * (what actually draws a flame) is separate and, for Tier 0, deliberately
 * minimal: a simple teardrop marker at each candle anchor, whose ONLY job is to
 * prove the new renderer picks up old-scene candle PLACEMENT (author directive,
 * 2026-07-20: "produce a very simple teardrop… see if the new renderer will
 * correctly pick up old scene candle placement first"). The pretty, animated,
 * glowing flame is later — its real home is the `surface.particles` draw pass +
 * `sims.fluids` sim (graph/passes.js already lists `CandleFlamesEffectV2` in both
 * `absorbs`), the GPU-instanced path that the particle wall (particles/one-
 * engine) reserves. This declaration is backend-agnostic, so none of that
 * changes when the draw lands.
 *
 * It renders anchors of kind `candleFlame` (scene/anchor-catalog.js); the anchor
 * authority serves them (`anchorsForEffect('candleFlame', …)`). Registering it is
 * the velocity test from Effect-Registration.md §6: ONE manifest + ONE schema +
 * ONE registry line, strictly less than a bespoke `_candleState` + hand-written
 * settings + resolver — proof the one door is also the fast door.
 *
 * @module effects/candle-flame
 */

/**
 * The authorable LOOK knobs (validated by core/params-schema.js). Per-anchor
 * intensity is NOT here — it lives on the anchor (scene/anchor-catalog.js), one
 * value per placed candle, imported from a V2 group's emission.intensity. These
 * are the effect-wide knobs every candle shares.
 *
 * @type {Record<string, object>}
 */
export const CANDLE_FLAME_PARAMS = Object.freeze({
  sizePx: {
    type: 'float',
    min: 1,
    max: 400,
    step: 1,
    default: 24,
    category: 'Look',
    label: 'Flame size',
    help: 'Height of the flame in canvas pixels. Small — a candle flame is roughly a grid-quarter tall.',
  },
  color: {
    type: 'color',
    // Author-picked warm tint, shown in a colour picker — decode before use.
    space: 'srgb',
    // V2's candleFlame colour (legacy/scene/map-points-manager.js:1941 = 0xffaa00).
    default: '#ffaa00',
    category: 'Look',
    label: 'Flame colour',
    help: 'The warm colour of the candle flame (tints both the flame and the light it casts).',
  },
  lightRadiusPx: {
    type: 'float',
    min: 0,
    max: 2000,
    step: 1,
    default: 400,
    category: 'Light',
    label: 'Light radius',
    help: 'How far the candle casts light, in canvas pixels. 0 = a flame with no light. This is the point light we control.',
  },
});

/**
 * The manifest — the effect as data (Effects.md §2 shape).
 *
 * `enabledFromProfile: 'low'` = ON at every performance profile by default: a
 * handful of teardrop markers is cheap, and the author wants to SEE placement
 * now (feedback_default_on_new_features — default ON; the UI-shadow's Extreme
 * gate was the expensive exception, not the rule). `a11y.photosensitive: false`
 * — a candle is a gentle glow, not a strobe; if a future flicker rung ever
 * pulses hard, this flips true and the accessibility gate protects it for free.
 *
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const CANDLE_FLAME = Object.freeze({
  id: 'candleFlame',
  title: 'Candle flames',
  // Small, atmospheric, discrete — defended before decorative chrome, after the
  // structural world/lighting passes.
  visualWeight: 0.5,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  params: CANDLE_FLAME_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'teardrop-marker',
      cost: Object.freeze({ class: 'C0', estMsPerMp: 0.01 }),
      adds: 'a simple teardrop marker at each imported candle anchor — placement proof, not a finished flame',
    }),
  ]),
  // Recorded, NOT built — the pretty flame, as honest rungs (Effects.md §0). The
  // real draw is the surface.particles / sims.fluids path (graph/passes.js).
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'animated-flicker',
      note: 'TSL-noise flicker driven by the frame clock — no per-flame CPU (particles/one-engine)',
    }),
    Object.freeze({
      name: 'emissive-glow',
      note: 'flame writes emissive into buf:scene.illum + bloom instead of a separate composite (light.accumulate / post.grade)',
    }),
    Object.freeze({
      name: 'gpu-instanced-draw',
      note: 'one instanced draw for all candles via the particle engine (surface.particles) — never a scene object per flame',
    }),
    Object.freeze({
      name: 'per-floor-height',
      note: 'flame throw/size scaled by the anchor floor’s elevation, like the UI-shadow parallax rung',
    }),
  ]),
});
