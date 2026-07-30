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
  // The candle LIGHT-POOL animation richness (effects/lighting/animations/
  // candle-flicker.js's own quality ladder). A graph-BUILD-time tier, not a
  // per-frame cost — 'low' is the original single-octave flicker; 'standard'
  // adds a two-octave flicker + warm/cool temperature shift; 'lavish' adds a
  // breathing core + angular edge turbulence. The governor drives this axis
  // per performance profile later (Effects.md §6); default 'lavish' because a
  // handful of candle lights is cheap and the richer look is the point
  // (feedback_default_on_new_features — ship the best look, dial DOWN on
  // request, never up).
  animationQuality: {
    type: 'enum',
    values: ['auto', 'low', 'standard', 'lavish'],
    // `auto` = FOLLOW THE PERFORMANCE PROFILE (2026-07-29). Previously `lavish`,
    // whose own note reasoned "a handful of candle lights is cheap and the
    // richer look is the point" — a measurement later contradicted the premise
    // (candle lights: 13.1 ms of a 20.4 ms frame on a candle-heavy scene), and
    // a hardcoded default cannot respond to a machine either way. `auto` is
    // still default-ON in the sense that matters: at the default `standard`
    // profile it resolves to exactly the old `lavish` behaviour
    // (feedback_default_on_new_features — ship the best look, dial DOWN on
    // request). Picking any explicit value pins it and beats the profile, per
    // Effects.md Law 5 ("measurements AND explicit settings").
    default: 'auto',
    category: 'Light',
    label: 'Flicker richness',
    help: 'How lively the cast light pool is. Auto follows your performance profile. Low = a gentle flicker (cheapest); Standard adds a two-octave flicker and warm/cool colour shift; Lavish adds a breathing core and a wavering, non-circular edge.',
  },
  // WIND RESPONSE (Wind.md §8.1 — "each consuming effect declares a
  // windResponse knob (the fixed Motion category literally lists 'wind
  // response' as its example)"). ONE honest dial over everything the shared
  // wind field (world/wind-field.js#sampleWind, Tiers 0-2) can move on a
  // candle: the flame's own lean/curl, the cast light's lean/oval stretch,
  // wind-triggered guttering, and a strong-gust snuff — see effects/candle-
  // flame-render.js#buildCandleFlameMaterial and effects/lighting/
  // animations/candle-flicker.js for exactly what each reads this for. 0 =
  // a candle wind cannot touch at all (a warded flame, or simply "keep it
  // decorative"); 1 = the tuned default; 2 = a candle that reacts twice as
  // dramatically as the reference tuning, for a GM who wants the drama
  // turned up. Default 1, matching "a scene nobody has dialled wind into
  // looks and behaves exactly as it did before this Tier existed" — Tier 0's
  // own promise, carried through here.
  windResponse: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Wind response',
    help: 'How much this candle reacts to the shared wind field — its flame lean, its cast light sway, gusts that make it gutter, and a strong-enough draft that snuffs it out. 0 = wind cannot touch it; 2 = twice as dramatic as the tuned default.',
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
  // ============================================================================
  // THE LADDER — REWRITTEN 2026-07-29 against what this effect ACTUALLY does.
  // ============================================================================
  //
  // ⚠️ The previous version declared ONE rung ("a simple teardrop marker at each
  // imported candle anchor — placement proof, not a finished flame") and filed
  // `animated-flicker` under `deferredRungs` as NOT BUILT. Both had been false
  // for weeks: the shipped flame runs a nine-noise chaotic life envelope with
  // wind lean, gutter and snuff, and every candle cluster emits a full
  // Foundry-parity point light with a `lavish` flicker. The manifest described
  // an effect that no longer existed — which is precisely what happens to a
  // declaration nothing reads (feedback_unconsumed_api_rots_silently). It is
  // read now, by effect-cascade.js#resolveEffectTier.
  //
  // Rungs are ordered by COST CLASS (Law 3), and each maps to a row of
  // `CANDLE_TIER_PLANS` (candle-flame-geometry.js) — the prose here, the
  // arithmetic there, index-aligned.
  //
  // 🔴 THE COST IS THE LIGHT, NOT THE FLAME, and that is measured rather than
  // assumed: on a candle-heavy scene `light.drawCandleFlame` (every billboard in
  // the scene) came in at 0.022 ms while the two point-light zones came to
  // 13.1 ms of a 20.4 ms frame across 91 draw calls. So the rungs that move the
  // needle are the ones changing light GRANULARITY, not flame prettiness.
  //
  // Tier 3 == today's shipped behaviour exactly, and the default `standard`
  // profile resolves to tier 3, so switching this system on restyles nothing.
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'ember',
      cost: Object.freeze({ class: 'C0', estMsPerMp: 0.01 }),
      adds: 'a calm flame at every candle, and one merged warm pool per room — placement and mood, at the floor price',
    }),
    Object.freeze({
      n: 1,
      name: 'flicker',
      fromProfile: 'low',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.01 }),
      adds: 'the cast light gains a two-octave flicker and a warm/cool temperature shift — pure ALU inside light it already covers',
    }),
    Object.freeze({
      n: 2,
      name: 'life',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.02 }),
      adds: 'the flame comes alive — chaotic per-candle guttering, wind lean, and a strong draft that snuffs it out',
    }),
    Object.freeze({
      n: 3,
      name: 'boil',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.03 }),
      adds: 'the silhouette boils and curls, and each light gains a breathing core and a wavering, non-circular edge',
    }),
    Object.freeze({
      n: 4,
      name: 'perCandle',
      fromProfile: 'extreme',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.3 }),
      adds: 'candles stop sharing a light — nearly one full point light each, so a candelabra pools per flame',
    }),
  ]),
  // Recorded, NOT built — still genuinely absent (Effects.md §0).
  deferredRungs: Object.freeze([
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
