/**
 * COLOUR GRADE (the "Look" grade) — MSA's fully-featured artistic colour
 * corrector, as a first-class registered effect (docs/planning/Grade.md §14).
 *
 * THIS FILE IS THE DECLARATION (params schema + manifest) — pure data, no THREE,
 * the same shape as `bloom.js`. The runtime is `grade/grade-ops.js` (the ONE
 * primitive) + `grade/grade-present.js` (folded into present); a
 * `runPostGradePass`-equivalent lives in the present-pass wiring. Because it is
 * a registered effect, its params flow through the SAME settings cascade bloom
 * and the candle use, and its FOH/ROH card is GENERATED from this schema — no
 * hand-wired controls, the whole point of `Effects-UI.md`.
 *
 * TWO GRADES, ONE ENGINE (Grade.md §13): the ENVIRONMENTAL grade (physically
 * present in the scene, outdoor-gated, `f(env)`) lives on the astrolabe's
 * Atmosphere slider. THIS is the ARTISTIC grade — layered on the whole final
 * image, hand-authored — and it owns the whole-frame display tail (tone map +
 * LUT) that the environmental grade must NOT have (a filmic curve applied twice
 * is a double transform).
 *
 * @module effects/grade/grade
 */

import { TONE_MAP_NAMES } from './grade-ops.js';

/** The bundled LUT names (the enum's non-`none` choices). Textures load lazily
 * from `assets/luts/<name>.cube`; an unresolved name is a no-op (Grade.md §15). */
export const BUNDLED_LUT_NAMES = Object.freeze(['none', 'warmFilm', 'coolFilm', 'bleachBypass']);

/**
 * The authorable knobs (validated by core/params-schema.js), grouped by the
 * fixed ROH categories. A "full primary" colourist set: exposure, white balance,
 * contrast, saturation, vibrance, split-tone shadows/highlights, a filmic
 * tone-map curve, and a 3D LUT. Every control is LIVE.
 * @type {Record<string, object>}
 */
export const GRADE_LOOK_PARAMS = Object.freeze({
  // ── Look (the plain-language strip) ──────────────────────────────────────
  exposure: {
    type: 'float',
    min: -3,
    max: 3,
    step: 0.01,
    default: 0,
    category: 'Look',
    label: 'Exposure',
    help: 'Overall brightness, in stops. +1 doubles the light, −1 halves it. The first thing to set — everything else grades the exposed image.',
  },
  contrast: {
    type: 'float',
    min: 0.5,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Look',
    label: 'Contrast',
    help: 'Push tones away from mid-grey (>1) or pull them toward it (<1). Higher reads punchier; lower reads flatter/softer.',
  },
  saturation: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Look',
    label: 'Saturation',
    help: 'Overall colour intensity. 0 is greyscale, 1 unchanged, 2 vivid. Brightness is never touched — this only drains or lifts chroma.',
  },
  temperature: {
    type: 'float',
    min: -1,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Look',
    label: 'Temperature',
    help: 'Warm (+, toward orange) or cool (−, toward blue) white balance. The master mood knob.',
  },
  vibrance: {
    type: 'float',
    min: -1,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Look',
    label: 'Vibrance',
    help: 'A gentler saturation that boosts muted colours more than already-vivid ones — lifts a drab scene without making skies and skin go radioactive.',
  },
  toneMapping: {
    type: 'enum',
    values: [...TONE_MAP_NAMES],
    default: 'neutral',
    category: 'Look',
    label: 'Film response',
    help: 'The HDR→display curve. Neutral (default) keeps colour and contrast close to the source; AgX compresses highlights hardest but reads flatter/desaturated without extra contrast; ACES is punchier/contrastier; None keeps the raw rolloff.',
  },

  // ── Technical (behind Advanced) ──────────────────────────────────────────
  tint: {
    type: 'float',
    min: -1,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Technical',
    label: 'Tint',
    help: 'Green (−) vs magenta (+) balance — the second white-balance axis, to correct a colour cast the temperature knob cannot.',
  },
  shadows: {
    type: 'color',
    space: 'srgb',
    default: '#000000',
    category: 'Technical',
    label: 'Shadow tint',
    help: 'Split-tone the SHADOWS. Black = neutral; a cool blue reads as classic teal shadows, a warm brown as vintage. (Drives the grade lift.)',
  },
  highlights: {
    type: 'color',
    space: 'srgb',
    default: '#ffffff',
    category: 'Technical',
    label: 'Highlight tint',
    help: 'Split-tone the HIGHLIGHTS. White = neutral; a warm orange reads as golden highlights (the teal-and-orange look pairs this with cool shadows). (Drives the grade gain.)',
  },
  // NOTE: the 3D-LUT knobs (`lutName`/`lutStrength`) are DELIBERATELY not
  // declared yet — the LUT shader path is built and tested (grade-ops
  // `buildGradeNode` tail + `lut-cube.js` parser + `grade-present.setLut`), but
  // the bundled `.cube` ASSET loading is a separate browser-only rung (see
  // `deferredRungs.bundled-lut-loading`). Declaring the enum now would be a dead
  // control until those assets load — precisely the thing Effects-UI.md forbids.
  // The moment the loading rung lands, these two params drop straight in.
});

/**
 * The manifest — the effect as data (Effects.md §2 shape). Ships ENABLED (like
 * bloom) because a film response curve is a KEY part of "the environment looks
 * right", and the author chose Neutral as the default (AgX's base curve reads
 * flat/desaturated on this content without an added contrast pass — Grade.md
 * fork). `toneMapping: 'none'`
 * restores raw/parity for anyone who wants it. `a11y.photosensitive: false` —
 * a static colour transform, no motion.
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const GRADE = Object.freeze({
  id: 'grade',
  title: 'Colour Grade',
  visualWeight: 0.75,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'Folded into the present composite shader with a placeholder identity 3D LUT built at graph time — nothing is fetched or baked today. ⚠️ THIS ANSWER EXPIRES: the bundled .cube asset load (deferredRungs, Grade.md §15) is exactly a first-run fetch+upload, so whoever builds that rung must flip this to “full” and add a probe, or the curtain will lift while the LUT is still loading and the scene will visibly re-grade itself afterwards.',
  }),
  params: GRADE_LOOK_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'full-primary-tonemap-lut',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.15 }),
      adds: 'exposure/white-balance/contrast/saturation/vibrance/split-tone (one node chain), a selectable filmic tone map (ACES/AgX/Neutral/Reinhard/Cineon, three built-ins), and an optional 3D LUT (trilinear texture3D), folded into the present pass',
    }),
  ]),
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'bundled-lut-loading',
      note: 'ship assets/luts/*.cube (warm/cool/bleach film looks) + fetch→parseCubeLut→Data3DTexture→setLut, then re-declare the lutName/lutStrength params. The whole SHADER path (buildGradeNode tail, the parser, grade-present.setLut, the placeholder identity texture) is already built and tested; only the asset load + upload remain (Grade.md §15)',
    }),
    Object.freeze({
      name: 'author-supplied-luts',
      note: 'a Foundry file-picker path param → parseCubeLut → Data3DTexture, so an author can load their own .cube beyond the bundled set (Grade.md §15)',
    }),
    Object.freeze({
      name: 'hsl-secondaries',
      note: 'hue-vs-hue / hue-vs-sat qualifiers (push only the reds, desaturate only the greens) — DaVinci-class secondaries, a bigger shader + UI rung',
    }),
    Object.freeze({
      name: 'per-channel-gamma-wheel',
      note: 'the midtones colour wheel (grade gamma) — exposed as preset-only today; the shadows/highlights split covers the common case',
    }),
    Object.freeze({
      name: 'one-d-lut-curves',
      note: 'per-channel tone curves (a 1D LUT / the schema `curve` param) once effect-controls grows a curve widget',
    }),
  ]),
});
