/**
 * STYLIZE — selectable whole-frame photographic/graphic looks
 * (mythica-machina-press#36), the "Sepia/Invert/Dot Screen/Halftone/ASCII"
 * cluster V2 shipped as separate opt-in fullscreen filters
 * (`compositor-v2/effects/{Sepia,Invert,DotScreen,Halftone,Ascii}EffectV2.js`,
 * each `optInEnable=true`, off by default, no mask, no cross-effect
 * dependency — the archaeology's own "SIMPLE, self-contained" read on all
 * five). Ported here as ONE small effect with a `style` picker rather than
 * five separate cards, both because they are mutually exclusive whole-frame
 * looks (never stacked in V2 either) and because five near-empty cards would
 * be exactly the panel-crowding the Studio UX pass (mythica-machina-press#548)
 * is trying to avoid adding to.
 *
 * THIS FILE IS THE DECLARATION (params schema + manifest) — pure data, no
 * THREE, the same shape as `grade.js`/`bloom.js`. The shader lives in
 * `effects/grade/grade-present.js`'s own final tail (the true "last thing
 * before pixels hit the screen," matching V2's own `post.grade absorbs
 * SepiaEffectV2` placement almost exactly) rather than a second fullscreen
 * pass of its own — one fewer draw call, and it composes for free with
 * Colour Grade's tone-map + LUT since it runs strictly after both.
 *
 * @module effects/stylize
 */

/** The `style` enum's non-'none' choices — each a shipped, tested look.
 * Screen-space patterns needing real pixel resolution (dot screen, halftone,
 * ASCII) are deliberately NOT here yet — see `deferredRungs` below. */
export const STYLIZE_LOOK_NAMES = Object.freeze(['none', 'sepia', 'invert']);

/**
 * The authorable knobs (validated by core/params-schema.js).
 * @type {Record<string, object>}
 */
export const STYLIZE_PARAMS = Object.freeze({
  style: {
    type: 'enum',
    values: [...STYLIZE_LOOK_NAMES],
    default: 'none',
    category: 'Look',
    label: 'Style',
    help: 'A selectable whole-frame photographic look, applied after Colour Grade (so it layers on top of exposure/tone-map/LUT, not instead of them). None (default) is a deliberate choice, same as Film response and Cinematic preset — nothing is applied until you pick one.',
  },
  amount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Look',
    label: 'Amount',
    help: 'How much of the style to blend in — 1 is the full look, lower eases it back toward the graded (but unstylized) image. Has no effect while Style is None.',
  },
});

/**
 * The manifest — the effect as data (Effects.md §2 shape). Ships with
 * `style: 'none'` (a no-op, like `grade.js`'s `toneMapping`/`lutName`), so
 * `enabledFromProfile: 'low'` costs nothing on a fresh scene — the compile-
 * time branch this rides (`grade-present.js`'s `currentStyle`) simply never
 * fires until an author picks a look. `a11y.photosensitive: false` — every
 * shipped style here is a static per-pixel colour transform, no flashing/
 * motion (unlike, say, Detective Vision's pulse).
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const STYLIZE = Object.freeze({
  id: 'stylize',
  title: 'Stylize',
  visualWeight: 0.15,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'A per-pixel colour-matrix branch folded into the present composite shader — no target, no asset, no bake. The compile-time style switch is covered by the global pipeline-growth criterion, same as a tone-map change.',
  }),
  params: STYLIZE_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'sepia-and-invert',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.02 }),
      adds: 'a classic warm-brown sepia matrix and a photographic colour inversion, each blendable by Amount',
    }),
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0).
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'dot-screen',
      note: "V2's DotScreenEffectV2 — a rotated sine-grid halftone dot pattern. Needs real pixel resolution (not just UV) to keep dot SIZE resolution-independent, which grade-present.js's material does not currently receive — same missing input every screen-space-pattern style below shares.",
    }),
    Object.freeze({
      name: 'halftone',
      note: "V2's HalftoneEffectV2 — CMYK-style halftone, selectable dot/ellipse/line/square shapes, scatter, blend modes. Same resolution dependency as dot-screen, plus more shape/blend surface than a first cut should try to cover at once.",
    }),
    Object.freeze({
      name: 'ascii',
      note: "V2's AsciiEffectV2 — converts the frame to letters/symbols via a generated font atlas, with an optional letter-shuffle flicker. Needs a real font-atlas asset/build step this engine has never had (MSA renders no text into its WebGPU scene anywhere today) — a genuinely separate piece of infrastructure, not a shader tweak.",
    }),
    Object.freeze({
      name: 'sharpen',
      note: "V2's SharpenEffectV2 — unsharp-mask edge/local-contrast boost. Not built here because it wants neighbour-texel taps (a small blur-and-subtract), a different shape of shader than this effect's other per-pixel-only styles; candidate for its own small pass once wanted.",
    }),
  ]),
});
