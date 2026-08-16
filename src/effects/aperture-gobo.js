/**
 * APERTURE GOBO — the declaration (manifest + params schema), pure data, no
 * THREE. Same split as window/specular/sun-shadows: this file is
 * Node-validatable; the TSL builder lives in `effects/lighting/aperture-gobo-
 * render.js` with THREE injected, never imported. `docs/planning/
 * Aperture-Gobo.md` is the design this implements.
 *
 * ============================================================================
 * WHAT THIS IS, IN ONE SENTENCE
 * ============================================================================
 * A window is a rectangle in a vertical plane; a lamp is a point; the pattern
 * that plane casts onto the ground is a plane-to-plane projection — this
 * effect computes that projection per point light, per aperture wall
 * (`foundry/scene-walls.js#deriveWallAperture`: a wall a GM already authored
 * as `move` solid, `light` passable), and multiplies it into that light's own
 * falloff. No new mask, no painting step — the window comes from the SAME
 * wall data a GM already places to make an ordinary Foundry window.
 *
 * ============================================================================
 * NOT THE PAINTED WINDOW COOKIE (`effects/window/window.js`) — READ THIS FIRST
 * ============================================================================
 * `effects/window/window.js`'s own header states its stance plainly: "there
 * is no aperture geometry here... the author has already painted where the
 * light lands." That effect is DAYLIGHT spilling into a room through a
 * hand-painted interior gobo. This effect is the geometric COMPLEMENT: a
 * LAMP's light shaped by a real wall's own aperture, thrown OUT of a room.
 * They can run on the same wall at different hours without conflict — one
 * ADDS onto `buf:scene.illum` from the sky; this one MULTIPLIES into one
 * light's own falloff. Neither reads the other; neither reads a mask this
 * one didn't already need (this effect reads NO mask at all — its only input
 * is wall geometry already in the scene).
 *
 * @module effects/aperture-gobo
 */

import { APERTURE_GOBO_DEFAULTS } from './lighting/aperture-gobo.js';
import { MAX_APERTURES_PER_LIGHT } from './lighting/aperture-gobo-render.js';

/**
 * The knobs. Each is read every frame by `effects/lighting/point-light-
 * pool.js#update` (`params/no-dead-controls` fails the build otherwise) —
 * `APERTURE_GOBO_DEFAULTS` (`effects/lighting/aperture-gobo.js`) is the
 * single source of truth for every default quoted here, exactly as `window-
 * render.js`'s own exported constants are for `WINDOW_PARAMS`.
 *
 * THE SPLIT (mirrors `sun-shadows.js`'s own "not a knob" doctrine, applied to
 * a different axis): window GEOMETRY is authored ART — cols, rows, frame,
 * mullion, sill and head are choices about how a building looks, and this
 * effect exposes them generously. Blur PHYSICS is a MODEL — the near
 * softness, the falloff curve's shape, the far-side bound — and stays a
 * module constant with its own header paragraph in `aperture-gobo.js`, same
 * as `sun-shadows.js`'s own `PENUMBRA_PER_PX`. Exactly ONE softness dial is
 * exposed (`softness`), the bias on that shared model, never the model
 * itself — the difference that keeps this from regrowing V2's
 * one-slider-per-concept disease.
 */
export const APERTURE_GOBO_PARAMS = Object.freeze({
  strength: {
    type: 'float',
    min: 0,
    // Genuinely bounded at 1, unlike WINDOW_PARAMS' own strength (which
    // multiplies a painted light quantity that has real meaning above 1,
    // "brighter than painted"). This strength BLENDS the gobo term toward
    // neutral (`mix(1, gobo, strength)`) — a value above 1 EXTRAPOLATES past
    // the raw pattern, and for any point the pattern shadows below 0.5 that
    // drives the blended term negative, corrupting `combinedFalloff` rather
    // than doing anything a bigger number should sensibly mean. Found live
    // (a strength:2 report), not in review — fixed at the schema so the
    // slider's own range can never suggest a value the maths doesn't support.
    max: 1,
    step: 0.01,
    default: APERTURE_GOBO_DEFAULTS.strength,
    category: 'Look',
    label: 'Pattern strength',
    help: 'How much of the window pattern shows through. 0 = every light renders exactly as it did before this effect existed. 1 = full pattern.',
  },
  softness: {
    type: 'float',
    min: 0.1,
    max: 4,
    step: 0.01,
    default: APERTURE_GOBO_DEFAULTS.softness,
    category: 'Look',
    label: 'Softness',
    help: 'How quickly the pattern blurs away between the light’s own centre and the edge of its dim radius. Higher = the pattern dissolves into a soft fan sooner.',
  },
  paneWidthPx: {
    type: 'float',
    min: 10,
    max: 300,
    step: 5,
    default: APERTURE_GOBO_DEFAULTS.paneWidthPx,
    category: 'Shape',
    label: 'Pane target width',
    help:
      'The pane count is procedural, not authored directly: each light divides its own aperture wall’s real ' +
      'length by this target size, then rounds, so a wide window naturally gets more panes than a narrow one ' +
      'instead of the same fixed count stretched or squeezed to fit.',
  },
  paneHeightPx: {
    type: 'float',
    min: 10,
    max: 300,
    step: 5,
    default: APERTURE_GOBO_DEFAULTS.paneHeightPx,
    category: 'Shape',
    label: 'Pane target height',
    help: 'Same idea as pane target width, applied to the window’s own head-minus-sill span to derive row count.',
  },
  frame: {
    type: 'float',
    min: 0,
    max: 40,
    step: 1,
    default: APERTURE_GOBO_DEFAULTS.frame,
    category: 'Shape',
    label: 'Frame width',
    help: 'The dark border around the whole window opening, in scene pixels.',
  },
  mullion: {
    type: 'float',
    min: 0,
    max: 40,
    step: 1,
    default: APERTURE_GOBO_DEFAULTS.mullion,
    category: 'Shape',
    label: 'Mullion width',
    help: 'The dark bars between panes, in scene pixels.',
  },
  sillPx: {
    type: 'float',
    min: 0,
    max: 500,
    step: 5,
    default: APERTURE_GOBO_DEFAULTS.sillPx,
    category: 'Shape',
    label: 'Sill height',
    help:
      'How far above the wall’s own foot the window opening starts — the sheltered, unlit strip right at the ' +
      'base of the wall. 0 spills light right down to the wall’s own foot with no sheltered gap at all.',
  },
  wallThicknessPx: {
    type: 'float',
    min: 0,
    max: 200,
    step: 1,
    default: APERTURE_GOBO_DEFAULTS.wallThicknessPx,
    category: 'Shape',
    label: 'Wall thickness',
    help:
      'How thick the wall around this window is, in scene pixels. A light standing well off to one side of the ' +
      'window has its own view of the far side of the opening narrowed by the wall’s own reveal — softens the ' +
      'beam’s two lateral edges instead of a hard cutoff. 0 disables this (a perfectly symmetric opening, ' +
      'regardless of where the light stands).',
  },
  headPx: {
    type: 'float',
    min: 10,
    max: 800,
    step: 5,
    default: APERTURE_GOBO_DEFAULTS.headPx,
    category: 'Shape',
    label: 'Head height',
    help: 'How far above the wall’s foot the window opening ends.',
  },
  glassQuality: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: APERTURE_GOBO_DEFAULTS.glassQuality,
    category: 'Glass',
    label: 'Glass quality',
    help:
      'How the pane distorts the pattern seen through it, medieval-style: 0 = cheap, rounded blob glass (a ' +
      'smooth, wavy warp). 1 = costly, angled cut glass (a hard-edged, faceted warp). In between blends both.',
  },
  distortionPx: {
    type: 'float',
    min: 0,
    max: 60,
    step: 1,
    default: APERTURE_GOBO_DEFAULTS.distortionPx,
    category: 'Glass',
    label: 'Distortion amount',
    help: 'How far the glass warps the mullion pattern, in scene pixels. 0 = perfectly clear glass, no warp at all.',
  },
  grimeAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: APERTURE_GOBO_DEFAULTS.grimeAmount,
    category: 'Grime',
    label: 'Grime amount',
    help:
      'How dirty and neglected this window is: layered noise darkens the glass, and — past a threshold this ' +
      'slider also raises — a few unlucky panes turn up cracked, with real hairline shards of open glass. 0 = ' +
      'spotless, every pane intact.',
  },
  defaultLampHeightPx: {
    type: 'float',
    min: APERTURE_GOBO_DEFAULTS.minLampHeightPx,
    max: 300,
    step: 1,
    default: APERTURE_GOBO_DEFAULTS.defaultLampHeightPx,
    category: 'Technical',
    label: 'Lamp height',
    help: 'How high off the ground a light source sits, for the purpose of this effect only. Tier 0 uses this same value for every light — a future rung reads a light’s own Foundry elevation instead.',
  },
  maxAperturesPerLight: {
    type: 'int',
    min: 1,
    max: MAX_APERTURES_PER_LIGHT,
    step: 1,
    default: APERTURE_GOBO_DEFAULTS.maxAperturesPerLight,
    category: 'Technical',
    label: 'Max windows per light',
    help: 'How many nearby windows one light can be shaped by at once. Extra windows beyond this are dropped (report shows how many) — raising it costs a little more per light.',
  },
  maxApertureDistancePx: {
    type: 'float',
    min: 20,
    max: 2000,
    step: 10,
    default: APERTURE_GOBO_DEFAULTS.maxApertureDistancePx,
    category: 'Technical',
    label: 'Max window search distance',
    help:
      'How far away a wall can still count as one of THIS light’s own windows, in scene pixels — independent of ' +
      'the light’s own radius. A large light reaching far across an outdoor map should not treat every distant ' +
      'window-sensed wall as its own; lower this if a big light is still picking up walls that have nothing to ' +
      'do with it, raise it if a lamp genuinely stands well back from its own window.',
  },
  edgeSuppressPercent: {
    type: 'float',
    min: 0,
    max: 100,
    step: 1,
    default: APERTURE_GOBO_DEFAULTS.edgeSuppressPercent,
    category: 'Edge suppression',
    label: 'Window edge suppression (%)',
    help:
      'A direct, manual darkening toward true black near the window opening’s own outer edge (its frame sides, ' +
      'sill, and head), as a percentage of THIS window’s own size — scales automatically with the window, unlike ' +
      'a fixed pixel width would. Separate from and on top of everything else this effect already does. 0 = off, ' +
      'no change at all. Use this if a window’s own outer boundary still reads as a hard line no matter how the ' +
      'other sliders are tuned.',
  },
  dimRadiusFadeStartPercent: {
    type: 'float',
    min: 0,
    max: 100,
    step: 1,
    default: APERTURE_GOBO_DEFAULTS.dimRadiusFadeStartPercent,
    category: 'Edge suppression',
    label: 'Dim radius fade start (%)',
    help:
      'Where the dim-radius suppression is at its STRONGEST (fully black), as a percentage of this light’s own ' +
      'dim radius — 100 = the true outer edge. Pair with "Dim radius fade end" below to set both ends of the ' +
      'gradient yourself; either can be the larger number, the fade always runs smoothly between them. Equal to ' +
      '"fade end" (both default to 100) = off, no change at all.',
  },
  dimRadiusFadeEndPercent: {
    type: 'float',
    min: 0,
    max: 100,
    step: 1,
    default: APERTURE_GOBO_DEFAULTS.dimRadiusFadeEndPercent,
    category: 'Edge suppression',
    label: 'Dim radius fade end (%)',
    help:
      'Where the dim-radius suppression fades away completely (back to no change at all), as a percentage of ' +
      'this light’s own dim radius, moving in from the edge — e.g. start=100, end=80 fades smoothly to true ' +
      'black across the outermost 20% of the light’s reach. Guaranteed, independent of the light’s own ' +
      'Attenuation setting.',
  },
});

/**
 * THE DEBUG CHANNELS — mirrors `window.js#WINDOW_DEBUG_CHANNELS`'/
 * `specular.js#SPECULAR_DEBUG_CHANNELS`' own declared-array shape, so
 * `boot.js`'s picker-building and channel-probe code can treat all three the
 * same way. One real structural difference, named rather than hidden: this
 * effect switches channels by swapping which of TWO MESHES is `.visible`
 * (`point-light-pool.js`'s own per-frame toggle), not by a shader-side
 * `select()` reading a numeric uniform the way window/specular do — so `n`
 * here is a display ordinal only, never wired to anything on the GPU side.
 *
 * RETIRED (round 10, 2026-08-04): `visibility` and `gate-inputs` — both read
 * the separate visibility-gate pass that no longer exists (the gobo pattern
 * is now baked directly into the light's own MAX-blended illumination/
 * coloration materials — see `point-light-illumination.js`'s own "THE GOBO
 * IS PART OF THIS LIGHT'S OWN FALLOFF" header). Down to the two channels
 * that still mean something: the real effect, and the raw pattern alone.
 * @type {ReadonlyArray<{n:number, id:string, label:string, reads:string}>}
 */
export const APERTURE_GOBO_DEBUG_CHANNELS = Object.freeze([
  Object.freeze({ n: 0, id: 'off', label: 'Off — normal render', reads: 'The effect as it ships.' }),
  Object.freeze({
    n: 1,
    id: 'pattern',
    label: '1 · Pattern only',
    reads:
      'The raw gobo term alone: white = unmodulated (open pane), black = fully shadowed (mullion/frame ' +
      "centre). Useful for confirming the mullion/frame GEOMETRY is right, independent of this light's own " +
      'brightness or what else is in the scene.',
  }),
]);

/**
 * The manifest — the effect as data (Effects.md §2 shape). Tier 0 only: the
 * full projection model (frame transform, inverse projection, the Jacobian,
 * the procedural generator, the distance-blur law) is built, but every
 * enrichment named in `deferredRungs` below is not.
 *
 * `visualWeight: 0.35` — a light with no nearby aperture renders completely
 * unchanged, so a scene that never placed a Foundry window notices nothing;
 * a scene that did gets a genuinely new, ownership-worthy look, but losing it
 * under budget reads as "the light looks like a plain torch again", not as a
 * missing floor the way a dead ambient term would.
 *
 * `a11y.photosensitive: false` — a static (non-flickering) pattern; softness
 * changes with a light's own attenuation shape, never with time.
 *
 * NO `authoring.paint` — unlike window light, there is no mask to paint. The
 * ＋ button a mask-driven effect gets does not apply here; the aperture comes
 * from wall data a GM already has a native Foundry tool for (the Wall
 * Config's own Light sense dropdown).
 *
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const APERTURE_GOBO = Object.freeze({
  id: 'apertureGobo',
  title: 'Window light pattern',
  visualWeight: 0.35,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'The gobo pattern is baked into point-light-pool.js’s own light and coloration materials rather than into anything this effect owns, so it allocates no target and loads no asset. Its one draw of its own is a debug visualization, off by default.',
  }),
  params: APERTURE_GOBO_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'projection',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0 }),
      adds:
        'A procedural mullioned-window pattern, shaped by ONE point light through a real Foundry aperture wall ' +
        '(move solid, light PROXIMITY — Foundry’s own window convention), multiplied into that light’s own ' +
        'falloff. Rect panes only, global ' +
        'default geometry (not yet per-wall authored), softened by distance from the light’s own centre to ' +
        'its dim radius, fading to fully neutral before the light’s own hard mesh edge at the dim radius, and ' +
        'narrowed asymmetrically by the wall’s own reveal at oblique light angles. The term that cannot be a ' +
        'silent zero: any light with a nearby aperture wall, strength above 0, always contributes.',
    }),
  ]),
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'perWallGeometry',
      note:
        'Per-wall MSA flags (flags.msa.window = {cols, rows, sill, head, frame, mullion, style}) so a GM can ' +
        'author a DIFFERENT window shape per wall instead of one global default (Aperture-Gobo.md §7 rung 1).',
    }),
    Object.freeze({
      name: 'styleLibrary',
      note:
        'arch/round/diamond/louvre/barred pane styles, plus per-pane glassTint (stained glass — the ' +
        'highest look-per-line-of-code item in the whole design, nearly free once the pane index exists).',
    }),
    Object.freeze({
      name: 'holeStackCorrectness',
      note:
        'Re-evaluate per resident sun-shadow floor slot instead of the viewed floor’s own surface, so a beam ' +
        'crossing a hole keeps travelling to the floor below from a taller effective lamp height ' +
        '(keyhole-orthographic-hole-stack-model).',
    }),
    Object.freeze({
      name: 'shutters',
      note: 'Animate an open01 casement swing; its own shadow sweeps across the pattern as it opens.',
    }),
    Object.freeze({
      name: 'sharedWindowArt',
      note:
        'Read the SAME aperture description effects/door-graphics-render.js already generates procedural door ' +
        'art from, so the drawn window on the wall and the pattern it casts can never disagree.',
    }),
    Object.freeze({
      name: 'elevationHeight',
      note:
        "Read a light's own Foundry elevation (scene-lights.js) instead of the flat defaultLampHeightPx every " +
        'light uses today — the projection model itself needs no change, only where h comes from.',
    }),
  ]),
});
