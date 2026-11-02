/**
 * FOG OF WAR — the look of MSA's fog: how its edge fades, how it moves, how remembered ground reads.
 *
 * The author, 2026-11-02, after the soft fog field shipped (dd9c0729): *"Build the card."* The field
 * itself (`vision-mask-render.js`, "THE SOFT FOG FIELD") decides WHAT is visible; this card only shapes
 * how that answer is drawn. Nothing here can show a player more: every knob below is applied inside the
 * hard reveal rule (a softer edge, more ink, a slower reveal all darken what is already revealed).
 *
 * WORLD DEFAULTS, like the Grid card: the values are ONE world setting
 * (`foundry/world-effect-defaults.js`, key `fogWorldParams`), so a GM's edit restyles the fog on every
 * scene, for everyone at the table. Off draws plain fog: still antialiased, no ink, no mist, no fade.
 *
 * Sizes are in GRID SQUARES, so a look tuned on a 100 px grid reads the same on a 150 px one.
 *
 * @module effects/vision/fog-of-war
 */

/** The effect's Studio parameters, in card order. Defaults are the look that shipped in dd9c0729. */
export const FOG_OF_WAR_PARAMS = Object.freeze({
  // ── Edge ────────────────────────────────────────────────────────────────
  edgeSoftness: {
    type: 'float',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 0.32,
    category: 'Edge',
    label: 'Edge softness',
    help: 'How far, in grid squares, the edge of sight fades into memory and darkness. 0 is a crisp (still smoothed) edge.',
  },
  ink: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.6,
    category: 'Edge',
    label: 'Ink',
    help: 'How much a painterly, uneven wash eats into the fading edge. 0 is a clean gradient.',
  },
  inkSize: {
    type: 'float',
    min: 0.1,
    max: 3,
    step: 0.05,
    default: 0.6,
    category: 'Edge',
    label: 'Ink size',
    help: 'The size of the ink blots, in grid squares.',
  },
  motion: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Edge',
    label: 'Drift',
    help: 'How fast the ink and mist slowly breathe. 0 holds them still.',
  },
  // ── Reveal ──────────────────────────────────────────────────────────────
  revealSec: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.32,
    category: 'Reveal',
    label: 'Reveal fade',
    help: 'Seconds for newly seen ground to fade in. Anything leaving sight still vanishes at once. 0 reveals instantly.',
  },
  // ── Memory ──────────────────────────────────────────────────────────────
  memoryBrightness: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.35,
    category: 'Memory',
    label: 'Remembered brightness',
    help: 'How bright ground the token has seen but cannot see now is drawn, before the time of day dims it further.',
  },
  memoryColour: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.7,
    category: 'Memory',
    label: 'Remembered colour',
    help: 'How much colour remembered ground keeps. 1 is full colour, 0 is grey.',
  },
  mist: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.01,
    default: 0.14,
    category: 'Memory',
    label: 'Mist',
    help: 'A slow mist that lifts and lowers remembered ground. 0 turns it off.',
  },
  mistSize: {
    type: 'float',
    min: 0.5,
    max: 12,
    step: 0.1,
    default: 3.5,
    category: 'Memory',
    label: 'Mist size',
    help: 'The size of the mist banks, in grid squares.',
  },
  gridOverMemory: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.3,
    category: 'Memory',
    label: 'Grid over memory',
    help: 'How visible grid lines stay over remembered ground. They are never drawn over the unexplored dark.',
  },
});

export const FOG_OF_WAR = Object.freeze({
  id: 'fogOfWar',
  title: 'Fog of War',
  visualWeight: 0.1,
  a11y: Object.freeze({ photosensitive: false }),
  // On for everyone: it is how MSA draws the fog unless a GM turns the card off.
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'Uniforms on the soft fog field, which runs whenever MSA owns vision: no texture, no asset, no pass of its own.',
  }),
  params: FOG_OF_WAR_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'painted-fog',
      cost: Object.freeze({ class: 'C0', estMsPerMp: 0.01 }),
      adds: 'a soft, inked edge of sight, a fade-in for newly seen ground, and dim, misted remembered ground',
    }),
  ]),
});
