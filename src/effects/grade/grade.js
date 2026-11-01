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
  exposureInside: {
    type: 'float',
    min: -2,
    max: 2,
    step: 0.01,
    default: 0,
    category: 'Look',
    label: 'Exposure: interiors',
    help: 'Extra exposure, in stops, under roofs only (where the outdoors mask of the map says indoors). Lift a dim interior without blowing out the street outside.',
  },
  exposureOutside: {
    type: 'float',
    min: -2,
    max: 2,
    step: 0.01,
    default: 0,
    category: 'Look',
    label: 'Exposure: exteriors',
    help: 'Extra exposure, in stops, under the open sky only. Pull a glaring street down without plunging the interiors into black. A map with no outdoors mask counts as all exterior.',
  },
  contrast: {
    type: 'float',
    min: 0.5,
    max: 2,
    step: 0.01,
    // 2026-10-15 — back to the neutral default by the author's call (the
    // 2026-09-25 live-tuned dump had it at 1.02).
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
    // 2026-10-15 — back to the neutral default by the author's call (the
    // 2026-09-25 live-tuned dump had it at 0.9).
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
    // 2026-10-15 — back to the neutral default by the author's call (the
    // 2026-09-25 live-tuned dump had it at 0.1).
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
    // 2026-10-15 — back to the neutral default by the author's call (the
    // 2026-09-25 live-tuned dump had it at 0.2).
    default: 0,
    category: 'Look',
    label: 'Vibrance',
    help: 'A gentler saturation that boosts muted colours more than already-vivid ones — lifts a drab scene without making skies and skin go radioactive.',
  },
  toneMapping: {
    type: 'enum',
    values: [...TONE_MAP_NAMES],
    // 2026-10-15 — back to 'none' by the author's call: the shipped default is
    // a neutral film response again (was 'reinhard' from the 2026-09-25 dump).
    default: 'none',
    category: 'Look',
    label: 'Film response',
    help: 'The HDR→display curve. None (default, "off") keeps the raw rolloff — the most basic option, so picking a look here is a deliberate choice, not something the author has to opt out of. Neutral keeps colour and contrast close to the source; AgX compresses highlights hardest but reads flatter/desaturated without extra contrast; ACES is punchier/contrastier; Reinhard is a gentle classic filmic rolloff.',
  },
  lutName: {
    type: 'enum',
    values: [...BUNDLED_LUT_NAMES],
    default: 'none',
    category: 'Look',
    label: 'Cinematic preset',
    help: 'A one-click bundled film-style look (Grade.md §15). None (default) applies no LUT — every other Look slider above still works normally either way. Layers on top of Film response, not instead of it.',
  },
  lutStrength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Look',
    label: 'Preset strength',
    help: 'How much of the cinematic preset to blend in — 1 is the full look, lower values ease it back toward the ungraded image. Has no effect while the preset above is None.',
  },

  // ── Style (2026-11-01, the Remote's Looks) ───────────────────────────────
  // Stylised grades a Look can call on: keep one colour, wash the frame in one
  // tint, darken the corners. Each is a no-op at its default.
  spotAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Style',
    label: 'One colour',
    help: 'Drain every colour to grey EXCEPT the one chosen below — 1 is the full effect (the red-coat-in-a-grey-world look).',
  },
  spotHue: {
    type: 'float',
    min: 0,
    max: 360,
    step: 1,
    default: 0,
    category: 'Style',
    label: 'Colour kept',
    help: 'Which hue survives One colour, in degrees round the colour wheel: 0 red, 30 orange, 60 yellow, 120 green, 190 cyan, 230 blue, 280 violet, 320 magenta.',
  },
  spotWidth: {
    type: 'float',
    min: 10,
    max: 120,
    step: 1,
    default: 40,
    category: 'Style',
    label: 'Colour kept: width',
    help: 'How far either side of the kept hue still counts as that colour. Narrow keeps one exact shade; wide keeps a family (all the reds and oranges).',
  },
  colourise: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Style',
    label: 'Colourise',
    help: 'Turn the frame into a monochrome of one tint (sepia, cyanotype, an infernal red) while keeping its light and shade. 1 is the full wash.',
  },
  colouriseColor: {
    type: 'color',
    space: 'srgb',
    default: '#b5864f',
    category: 'Style',
    label: 'Colourise tint',
    help: 'The tint Colourise washes the frame in. Mid-tones take this colour; shadows darken to black and highlights ease toward white.',
  },
  colouriseHold: {
    type: 'float',
    min: 0.05,
    max: 1.5,
    step: 0.01,
    default: 0.18,
    category: 'Style',
    label: 'Colourise: tint holds to',
    help: 'How bright a pixel can get and still take the tint before it eases to white. Low reads like an old print; high drowns the whole frame in the colour and leaves only real lights white.',
  },
  colouriseKeepLamps: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Style',
    label: 'Colourise: lamps stay their own colour',
    help: 'Where lamps, torches and fires shine, the tint steps back so their light keeps its own colour — with Light colour at 0, every lamp burns white in a tinted world.',
  },
  vignette: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Style',
    label: 'Vignette',
    help: 'Darken the corners of the frame, drawing the eye to the middle. 1 is a heavy, old-lens vignette.',
  },

  // ── Light (2026-11-01) — a separate CC for the LIGHTING ───────────────────
  // These act on the light before it meets the painted art (the lighting
  // composite), so the art keeps its colours while the light changes.
  lightLevel: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Light',
    label: 'Light level',
    help: 'How strong all the light is — sun, sky and lamps alike. Below 1 dims the scene the way the light would, not the way a darker photo would.',
  },
  lightSaturation: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Light',
    label: 'Light colour',
    help: 'How coloured the light is. 0 turns every light white (a torch, a fire and the moon all burn clean white); above 1 makes coloured light richer.',
  },
  lightTint: {
    type: 'color',
    space: 'srgb',
    default: '#ffffff',
    category: 'Light',
    label: 'Light tint',
    help: 'Tint every light this colour — a scene lit by sickly green, by cold moonlight, by firelight. White leaves the light as it is.',
  },
  lightGlow: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Light',
    label: 'Lamp glow',
    help: 'How strongly lamps and fires wash their colour onto the ground around them. 0 keeps only their light, not their colour.',
  },
  // DAYLIGHT LAMP GLOW (2026-11-01, measured): at noon a lamp's coloured glow was still adding
  // +0.17 red onto sunlit cobbles on Docklands — a real lamp is invisible next to the sun.
  // Scales the glow by how much of full daylight the ambient is (grade-ops.js#daylightWeight).
  lightGlowDay: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.25,
    category: 'Light',
    // grade-ops.js#DEFAULT_LIGHT_GLOW_DAY — kept equal by a test.
    label: 'Lamp glow in daylight',
    help: 'How much of their coloured glow lamps keep in full daylight. Real lamps are lost in sunlight; 1 keeps them as strong as at night. Fades in smoothly as the light falls.',
  },
  // THE LIGHT SHAPE (2026-11-01) — point-light-illumination.js#NATURAL_FALLOFF_K.
  lightSoftness: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0, // Foundry's disc until the roll-off is the default too (point-light-illumination.js#DEFAULT_POINT_LIGHT_SOFTNESS)
    category: 'Light',
    label: 'Light shape',
    help: "How a lamp's light falls away. 0 is Foundry's own: an even disc of light with a soft rim. 1 is natural: a bright core that fades smoothly with distance, like a real lamp.",
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
 * bloom) so the OTHER Look sliders (exposure/contrast/saturation/etc, all at
 * their own defaults) are live without an extra toggle. A 2026-09-25
 * live-tuned dump briefly shipped a real look (Reinhard, contrast 1.02,
 * saturation 0.9, temperature 0.1, vibrance 0.2); since 2026-10-15 the author
 * reset the whole card to its neutral defaults — every Look slider is a no-op
 * and the film response is `'none'` again — so an un-authored scene is
 * pixel-unchanged until a slider is moved (the Foundry-parity guarantee).
 * `a11y.photosensitive: false` — a static colour transform, no motion.
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const GRADE = Object.freeze({
  id: 'grade',
  title: 'Colour Grade',
  visualWeight: 0.75,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'full',
    probes: Object.freeze(['gradeLut']),
    why: 'Folded into the present composite shader with a placeholder identity 3D LUT built at graph time, but picking a non-"none" `lutName` now fetches+parses that bundled .cube and uploads it as a real Data3DTexture (vt-pan-viewer.js#loadNamedLut) — real first-run network+GPU work, counted by the gradeLut probe (vt/settle.js) so the curtain waits for it exactly once per name change.',
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
