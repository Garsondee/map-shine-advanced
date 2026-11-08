/**
 * BLOOM — MSA's first POST-processing effect, and the first citizen of the
 * `post` stage in the frame graph (graph/passes.js `post.bloom`).
 *
 * THIS FILE IS THE DECLARATION (params schema + manifest + presets) — pure data,
 * no THREE. The runtime (the dual-filter blur pyramid) lives in
 * `effects/bloom-render.js` (TSL builders, THREE injected) and is driven by a
 * `runPostBloomPass` closure in `vt/vt-pan-viewer.js`. Same split as the candle
 * (candle-flame.js declaration + candle-flame-render.js material), so this is
 * backend-agnostic and Node-validatable.
 *
 * THE TECHNIQUE (docs/planning/Bloom.md): the modern "physically-based" bloom
 * from Jimenez / Call of Duty: Advanced Warfare — a progressive downsample
 * (13-tap, Karis average on the first step to kill fireflies) + a progressive
 * tent-filter upsample. It replaces the stock three UnrealBloomPass port (hard
 * threshold → grainy; separable Gaussian per mip) and V2's `BloomEffectV2`
 * (also separable Gaussian). It looks better AND is cheaper, and its pyramid
 * gives the author's "tight CORE + wide ATMOSPHERE" for free: the two are just
 * shallow vs deep levels of the SAME pyramid, each weighted independently —
 * exactly V2's Surface/Atmosphere split, one blur chain, two taps.
 *
 * THE CLAMP (why bloom can't leak where it shouldn't): the bright-pass INPUT is
 * darkened by a world-space mask BEFORE any blur runs, so a bright source in a
 * masked region contributes zero energy to the pyramid and physically cannot
 * bloom outward. Today that mask is `_Outdoors` (the "outdoor spill suppress"
 * below — stops indoor window-glow haloing onto dark exterior ground). The SAME
 * input hook is where a native fog-of-war visibility texture connects the day
 * MSA renders its own fog (keyhole-vision-fog-direction) — the architecture is
 * built now; the fog wire is a documented seam, not a faked control.
 *
 * THE CAMERA'S GLARE (2026-11-08, mmp-ilo.1 / mmp-ilo.2) — one camera: Dynamic Range is its exposure, this card is
 * its glare. Three rules make it a lens and not a computer-game halo:
 *  1. THE BRIGHT PASS READS THE SCENE AT THE CAMERA'S EXPOSURE (stops only; dynamic-range.js). "Glow from" is in the
 *     picture's own units: 1 = white at this exposure. With the camera off the exposure is 1 (the scene's own units).
 *  2. ENERGY, NOT A HALO PER PIXEL. Each band is a NORMALISED kernel and the dials scale a FRACTION of the light over
 *     "Glow from": at the defaults about 12% goes into the narrow core and 5% into the faint wide tail
 *     ({@link GLARE_ENERGY}). Before, each band summed three mips (≈3× the bright energy per band), so the default
 *     added ~4× the over-white light around every highlight — the "fat chunky bloom" round metal.
 *  3. A BUDGET: the camera's meter measures the frame's bright energy each reading and, when a map has so many lamps
 *     (or so much noon snow) that the glare would veil the frame, eases the glare down (vt-pan-viewer.js, the
 *     glare budget; {@link glareBudgetGain}).
 *
 * @module effects/bloom
 */

/**
 * The energy scale of the glare (2026-11-08): a band's kernel carries `GLARE_ENERGY × strength × band strength` of
 * the bright energy. At the defaults (0.96 / 1.01 / 0.43) that is ~0.12 in the core and ~0.05 in the tail — a real
 * lens's veiling glare is a few percent; the core reads as the highlight's own soft edge.
 */
export const GLARE_ENERGY = 0.12;

/** The lowest "Glow from" the glare honours, in the picture's units at the camera's exposure (see `threshold`). */
export const GLARE_MIN_FROM = 0.8;

/**
 * THE GLARE BUDGET (mmp-ilo.2): the mean glow the glare may lay over the whole frame (exposed units: 0.02 = 2% of
 * white) before it is eased down. Because the kernels are normalised, the frame's mean glow is simply
 * (core + tail fraction) × the frame's mean bright excess — which the camera's meter already measures.
 */
export const GLARE_VEIL_BUDGET = 0.02;

/**
 * The glare's gain from the budget: ~1 while the frame's mean glow is well under the budget, easing so the glow
 * settles near the budget however many lights a map has (1/√(1+(veil/budget)²): at the budget 0.71, at 4× 0.24).
 * @param {number} glowEnergy the meter's mean bright excess (dynamic-range.js#meterStats)
 * @param {number} fraction the glare's total energy fraction (GLARE_ENERGY × strength × (core + atmosphere))
 * @param {number} [budget]
 */
export function glareBudgetGain(glowEnergy, fraction, budget = GLARE_VEIL_BUDGET) {
  const e = Number.isFinite(glowEnergy) ? Math.max(0, glowEnergy) : 0;
  const f = Number.isFinite(fraction) ? Math.max(0, fraction) : 0;
  const b = Number.isFinite(budget) && budget > 0 ? budget : GLARE_VEIL_BUDGET;
  const v = (e * f) / b;
  return 1 / Math.sqrt(1 + v * v);
}

/**
 * The authorable knobs (validated by core/params-schema.js). Grouped by the
 * fixed ROH categories (diag/effect-controls.js CATEGORY_ORDER). Every control
 * here is LIVE — there is deliberately no dead "fog clip" toggle: the fog clamp
 * arrives wired, with the fog system, rather than as a switch that does nothing
 * (Effects-UI.md's dead-control rule; feedback_required_masks_fail_loud).
 *
 * @type {Record<string, object>}
 */
export const BLOOM_PARAMS = Object.freeze({
  // ── Look ────────────────────────────────────────────────────────────────
  threshold: {
    type: 'float',
    // 2026-11-08 (one camera): the threshold is now in the PICTURE's units at the camera's exposure (1 = white). Below
    // ~0.8 a night exposure (+1-1.6 stops) made ordinary lamp-lit floors glow; the floor is the camera's
    // GLARE_MIN_FROM. Stored scene values under it (0.33-0.7, tuned for the old raw-scene bloom that Dynamic Range had
    // overridden since 2026-11-04) read as the floor.
    min: 0.8,
    max: 4,
    step: 0.01,
    // LOWERED 4 → 1.79 (2026-09-08) — new live-tuned defaults, alongside
    // `strength` and `coreStrength` below. Recovered from a stash that
    // missed both this file's own commit and the 0.6.4 release; applied
    // 2026-09-18.
    // 2026-09-25 — author's live-tuned "new defaults" dump (was 1.79).
    // 2026-10-16 — second dump: lowered hard (was 1.52), so far more of the
    // image sits above the glow cutoff.
    // 2026-10-27 — third dump (was 0.33).
    // 2026-11-08 — 0.51 -> 1.0: "only light too bright for the picture glows" (one camera, mmp-ilo.1).
    default: 1,
    category: 'Look',
    label: 'Threshold',
    help: 'How bright a pixel must be, at the camera’s exposure, before it starts to glow (1 = white in the picture). Only the light ABOVE this glows, and only a small share of it, so lowering it lets dimmer things glow faintly rather than making a haze.',
  },
  // THE DAYLIGHT FLOOR (2026-11-01, measured): the threshold above was tuned on night scenes,
  // where only lamps cross it. At noon a sunlit cobble alone reads ~0.65 in scene.lit, so a
  // 0.51 threshold blooms the WHOLE exterior — the attribution probe put bloom at +1.5 on top
  // of a 0.65 surface on Docklands' south docks (the "blown-out mess" the author named). This
  // floor scales with the ambient light: at night it is near 0 and the threshold rules; in
  // daylight only what is brighter than sunlit white glows (lamps, glints, fire), like a
  // camera exposed for the day. See `bloomEffectiveThreshold`.
  dayThreshold: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1.1,
    category: 'Look',
    label: 'Daylight threshold',
    help: 'In daylight, how much brighter than sunlit white a pixel must be to glow (1 = sunlit white itself). Keeps ordinary sunlit ground from blooming into haze at noon; at night the Threshold above rules. 0 = off.',
  },
  knee: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    category: 'Look',
    label: 'Soft knee',
    help: 'How gently the glow fades in around the threshold. 0 = a hard cutoff (can shimmer/grain on moving highlights); 1 = a very soft, forgiving roll-in. This is the modern fix for the "sparkly bloom" look.',
  },
  strength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    // RAISED 0.05 → 0.14 (2026-09-08) — new live-tuned defaults. Recovered
    // from a stash that missed both this file's own commit and the 0.6.4
    // release; applied 2026-09-18.
    // 2026-09-25 — author's live-tuned "new defaults" dump (was 0.14).
    // 2026-10-16 — second dump: the master dial runs full (was 0.29).
    // 2026-10-27 — third dump (was 1).
    default: 0.96,
    category: 'Look',
    label: 'Strength',
    help: 'Overall glow — how much of the light brighter than the threshold spreads into the glow, for the tight core and the wide atmosphere together. The master dial. Maps with many lights are eased down automatically so they never glow into a haze.',
  },
  coreStrength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    // RAISED 1.0 → 2.25 (2026-09-08) — new live-tuned defaults. Recovered
    // from a stash that missed both this file's own commit and the 0.6.4
    // release; applied 2026-09-18.
    // 2026-09-25 — author's live-tuned "new defaults" dump (was 2.25).
    default: 1.01,
    category: 'Look',
    label: 'Core strength',
    help: 'Intensity of the TIGHT glow that hugs bright sources (lamps, fire, specular glints). This is the crisp halo right on the source.',
  },
  coreTint: {
    type: 'color',
    space: 'srgb',
    default: '#ffffff',
    category: 'Look',
    label: 'Core tint',
    help: 'Colour of the tight core glow. White keeps it faithful to the source colour; tint it to push a mood.',
  },
  atmoStrength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    // 2026-09-25 — author's live-tuned "new defaults" dump (was 2.45).
    // 2026-10-16 — second dump: the wide haze steps well back (was 0.75) —
    // the tight core carries the glow now.
    // 2026-10-27 — third dump (was 0.24).
    default: 0.43,
    category: 'Look',
    label: 'Atmosphere strength',
    help: 'Intensity of the WIDE, soft glow — the sense of air catching the light, haze around a scene. This is the "atmospherics" layer, separate from the tight core.',
  },
  atmoTint: {
    type: 'color',
    space: 'srgb',
    // Warm haze by default (V2's atmosphere tint intent).
    default: '#fff0dc',
    category: 'Look',
    label: 'Atmosphere tint',
    help: 'Colour of the wide atmospheric glow. A warm tint reads as dusty/golden air; a cool tint as misty/moonlit.',
  },

  // ── Extent (reach / spread) ───────────────────────────────────────────────
  coreSpread: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.4,
    category: 'Extent',
    label: 'Core spread',
    help: 'How far the tight core glow reaches from its source. Small keeps it crisp on the highlight; larger softens and grows it.',
  },
  atmoSpread: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.7,
    category: 'Extent',
    label: 'Atmosphere spread',
    help: 'How far the wide atmospheric glow reaches. Larger = a broader, softer wash of air-glow across the scene.',
  },

  // ── Response (masking / clamping) ─────────────────────────────────────────
  outdoorSpillSuppress: {
    type: 'bool',
    default: true,
    category: 'Response',
    label: 'Suppress outdoor spill',
    help: 'Stops bright indoor window-light from blooming out onto the dark ground OUTSIDE a building. Uses the painted indoor/outdoor mask. Leave on for exteriors around lit buildings.',
  },
  spillLumLo: {
    type: 'float',
    min: 0.05,
    max: 1.5,
    step: 0.01,
    default: 0.42,
    category: 'Response',
    label: 'Spill floor (× threshold)',
    help: 'Advanced. Outdoor ground darker than threshold × this value gets NO spilled bloom at all. Lower = suppress more aggressively.',
  },
  spillLumHi: {
    type: 'float',
    min: 0.1,
    max: 2,
    step: 0.01,
    default: 0.92,
    category: 'Response',
    label: 'Spill ceiling (× threshold)',
    help: 'Advanced. Outdoor pixels brighter than threshold × this value keep their FULL bloom (real outdoor highlights — sun, torches, water glints — still glow). Between floor and ceiling it fades in.',
  },
});

/**
 * Named looks, shipped as DATA (the grade-ops.js preset pattern). A preset is
 * just a partial diff over the schema defaults — the exact shape the effect
 * cascade takes as a `paramLayers` entry, so applying one is dropping it into
 * the resolver, not a bespoke code path.
 *
 * Ported from BloomEffectV2's authored set (docs/reference/v2-effect-params/
 * bloom-effect.md) and RE-TUNED for the new dual-filter math — the V2 numbers
 * were tuned against separable-Gaussian GLSL that no longer exists, so only the
 * INTENT of each look carries over, never the literal values.
 *
 * @type {Record<string, Record<string, number|string>>}
 */
export const BLOOM_PRESETS = Object.freeze({
  none: {},
  subtle: { strength: 0.55, coreStrength: 0.85, atmoStrength: 0.25, threshold: 1.25, atmoSpread: 0.55 },
  strong: { strength: 1.6, coreStrength: 1.35, atmoStrength: 0.95, threshold: 0.85 },
  dreamy: {
    strength: 1.3,
    coreStrength: 0.9,
    atmoStrength: 1.2,
    threshold: 0.75,
    knee: 0.85,
    atmoSpread: 0.9,
    coreSpread: 0.6,
  },
  neon: { strength: 1.5, coreStrength: 1.7, atmoStrength: 0.7, threshold: 0.6, knee: 0.35, atmoTint: '#ff8fd6' },
  clearNoon: { strength: 0.8, threshold: 1.45, coreStrength: 1.0, atmoStrength: 0.3, atmoTint: '#fff6e8' },
  goldenHour: { strength: 1.15, threshold: 0.9, atmoStrength: 0.75, atmoTint: '#ffcf9e', atmoSpread: 0.8 },
  overcastDay: { strength: 0.7, threshold: 1.1, atmoStrength: 0.5, atmoTint: '#dfe6ee', coreStrength: 0.85 },
  storm: { strength: 0.9, threshold: 1.0, atmoStrength: 0.6, atmoTint: '#b8c2d0' },
  moonlitNight: { strength: 0.95, threshold: 0.7, atmoStrength: 0.85, atmoTint: '#9fb6d6', atmoSpread: 0.85 },
  interiorNight: { strength: 1.05, threshold: 0.8, coreStrength: 1.2, atmoStrength: 0.5, atmoTint: '#ffb877' },
});

/** The schema defaults as a flat object — the base a preset diffs over. */
const BLOOM_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(BLOOM_PARAMS).map(([k, decl]) => [k, decl.default]))
);

/**
 * Resolve a named preset to a FULL params object (defaults + the named diff).
 * Unknown name ⇒ the plain defaults. Mirrors grade-ops.js#gradePreset.
 * @param {string} name
 * @returns {Record<string, number|string>}
 */
export function bloomPreset(name) {
  return { ...BLOOM_DEFAULTS, ...(BLOOM_PRESETS[name] || {}) };
}

/**
 * The manifest — the effect as data (Effects.md §2 shape).
 *
 * `enabledFromProfile: 'low'` = ON at every performance profile by default.
 * Bloom is a KEY environment effect (the author's own framing) and the pyramid
 * is cheap — half-resolution and below, ~11 small passes, ~8 MB of render
 * targets (Keyhole.md §4.2's RT inventory already budgets "bloom chain ~8").
 * feedback_default_on_new_features: ship the best look, dial DOWN on request.
 * `a11y.photosensitive: false` — a soft glow, not a strobe.
 *
 * @type {import('./effect-manifest.js').EffectManifest}
 */
/** sRGB transfer → linear, one channel. */
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * The threshold the bright pass actually uses: the authored threshold, raised in daylight to
 * `dayThreshold` × the brightness a WHITE surface reaches under the current ambient light.
 * The composite is `EOTF(OETF(albedo) × illum)`, so white under an sRGB ambient `bg` reads
 * EOTF(bg) — 0.85 at noon (bg 0.93), ~0 at night.
 * @param {number} threshold @param {number} dayThreshold
 * @param {readonly number[]|null} ambientSrgb - the frame's raised ambient background (sRGB)
 * @returns {number}
 */
export function bloomEffectiveThreshold(threshold, dayThreshold, ambientSrgb) {
  const t = Number.isFinite(threshold) ? threshold : 1;
  const d = Number.isFinite(dayThreshold) ? Math.max(0, dayThreshold) : 0;
  if (!d || !ambientSrgb) return t;
  const lin = ambientSrgb.map((v) => srgbToLinear(Math.max(0, Number(v) || 0)));
  const white = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return Math.max(t, d * white);
}

export const BLOOM = Object.freeze({
  id: 'bloom',
  title: 'Bloom',
  // A whole-image atmosphere effect — high perceptual weight, defended well
  // above decorative chrome (it is a big part of "the environment looks right").
  visualWeight: 0.7,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'A post chain over buffers the frame graph already owns: it allocates no targets, loads no assets and bakes nothing of its own. Its only genuine first-run cost is pipeline compilation on first draw, and that is covered globally by settle.js’s pipeline-growth criterion rather than per-effect — a per-effect probe here would count the same compile twice.',
  }),
  params: BLOOM_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'dual-filter-two-band',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.18 }),
      adds:
        'Jimenez/COD progressive downsample (13-tap + Karis) + tent upsample, split into an ' +
        'independently-weighted tight core (mips 0-1) and wide atmosphere band (mips 2-3), masked ' +
        'bright-pass input (outdoor-spill clamp via the outdoors mask), additively composited into ' +
        'scene.lit before the grade — a genuinely shorter 4-mip pyramid, both bands still present, just ' +
        "each one rung shallower than tier 1's.",
    }),
    Object.freeze({
      n: 1,
      name: 'six-mip-pyramid',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.3 }),
      adds:
        'the pyramid deepens to 6 mips (core 0-2, atmosphere 3-5) — the SAME pipeline this effect has ' +
        'always shipped. Wired 2026-08-29: `buildBloomMaterials` (bloom-render.js) was already fully ' +
        'generic in mip count — its downsample/upsample materials are reused, swappable-input passes with ' +
        'no hardcoded depth, and its composite only ever takes two FIXED textures (whichever the caller ' +
        'names "core" and "atmosphere") — the gap was that the VIEWER always built and looped 6 mips ' +
        'regardless of profile. See docs/planning/Effect-Tier-Gradient-Audit-2026-08-29.md §3.3.',
    }),
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0).
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'fog-of-war-clip',
      note: "darken the bright-pass input inside fog-of-war too — connects the SAME input hook to MSA's native fog visibility texture the day it exists (keyhole-vision-fog-direction)",
    }),
    Object.freeze({
      name: 'selective-emissive-bloom',
      note: "bloom only flagged emissive surfaces (candle flames, magic) via an MRT emissive channel — needs geometry.world to MRT buf:scene.attr's emissive first",
    }),
    Object.freeze({
      name: 'lens-dirt-and-streaks',
      note: 'a screen-space dirt texture and anamorphic streak tap on the bright-pass for a lens feel',
    }),
  ]),
});
