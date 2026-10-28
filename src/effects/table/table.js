/**
 * TABLE — the scene sits recessed in a brass-rimmed, green-velvet games table.
 *
 * The author, 2026-10-27: *"a brass border of metal around the scene and the
 * padded region would become a velvet pool table like surface with crease/panel
 * lines at the corners … as if the scene were recessed into the table and the
 * table would move with perspective from the cameras POV. All textures and
 * materials should be procedural … GM and players could put things on the green
 * velvet to show it as being essentially on the table but off the board … Players
 * should never have vision of what a GM has placed in this area but can see their
 * own tokens if they have ownership."*
 *
 * HOW THE DEPTH IS FAKED (no new geometry, one screen pass):
 *  The viewer's camera is orthographic. The table pretends a pinhole eye hangs
 *  over the view centre at the height that frames the current zoom with the
 *  card's field of view (`table-model.js#tableEyeHeight`). Each pixel's ray is
 *  traced against three planes in closed form — the table top (`depth` above the
 *  board), the four inner walls of the recess, and the board itself — so the
 *  rim and velvet slide a little faster than the map when panning, the inner
 *  wall shows on the side away from the eye, and the lip covers the board's edge
 *  once the eye is past it. The board's own pixels are never moved.
 *
 * THIS FILE IS THE DECLARATION (params + manifest), pure data. The ray model
 * and the off-board visibility rule are `table-model.js`; the TSL is
 * `table-render.js`.
 *
 * @module effects/table/table
 */

/** The effect's Studio parameters, in card order. */
export const TABLE_PARAMS = Object.freeze({
  // ── Depth ───────────────────────────────────────────────────────────────
  depthPct: {
    type: 'float',
    min: 0,
    max: 10,
    step: 0.1,
    default: 1,
    category: 'Depth',
    label: 'Recess depth',
    help: 'How far the board sits below the table top, as a percentage of the board’s shorter side. 0 makes the board flush with the velvet.',
  },
  fovDeg: {
    type: 'float',
    min: 5,
    max: 90,
    step: 1,
    default: 45,
    category: 'Depth',
    label: 'Perspective',
    help: 'The pretend camera’s field of view, in degrees. Wider swings the rim and walls more as you pan; narrow is almost flat.',
  },
  // ── Ambient occlusion ───────────────────────────────────────────────────
  edgeShadow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Ambient occlusion',
    label: 'Board AO strength',
    help: 'How dark the board gets where it tucks under the brass border. 0 turns the shadow off.',
  },
  edgeShadowPct: {
    type: 'float',
    min: 0.1,
    max: 10,
    step: 0.1,
    default: 5,
    category: 'Ambient occlusion',
    label: 'Board AO width',
    help: 'How far the shadow reaches onto the board, as a percentage of the board’s shorter side.',
  },
  edgeShadowSoft: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Ambient occlusion',
    label: 'Board AO softness',
    help: 'How gradually the shadow fades out. Low is a tight crease right at the border; high is a wide, airy falloff.',
  },
  velvetAo: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.61,
    category: 'Ambient occlusion',
    label: 'Velvet AO strength',
    help: 'How much the velvet darkens where it meets the outside of the brass border.',
  },
  velvetAoPct: {
    type: 'float',
    min: 0.1,
    max: 6,
    step: 0.1,
    default: 3.6,
    category: 'Ambient occlusion',
    label: 'Velvet AO width',
    help: 'How far the velvet’s shadow reaches from the border, as a percentage of the board’s shorter side.',
  },

  // ── Brass rim ───────────────────────────────────────────────────────────
  rimPct: {
    type: 'float',
    min: 0.2,
    max: 6,
    step: 0.05,
    default: 2.65,
    category: 'Brass rim',
    label: 'Rim width',
    help: 'Width of the brass rim, as a percentage of the board’s shorter side. Seams, stitches and the brushing scale with it.',
  },
  edgePct: {
    type: 'float',
    min: 0.1,
    max: 4,
    step: 0.05,
    default: 0.2,
    category: 'Brass rim',
    label: 'Outer edge width',
    help: 'Width of the rounded brass edge that finishes the table, as a percentage of the board’s shorter side. Beyond it is the void: pure black.',
  },
  rimColor: {
    type: 'color',
    space: 'srgb',
    default: '#b8893e',
    category: 'Brass rim',
    label: 'Brass colour',
    help: 'The metal’s base colour. Warmer for old brass, paler for gilt, grey-pink for copper.',
  },
  rimRound: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Brass rim',
    label: 'Roundness',
    help: 'How rounded the rim’s profile is. 0 is a flat strip; 1 is a full half-round bead.',
  },
  rimShine: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1.7,
    category: 'Brass rim',
    label: 'Shine',
    help: 'Brightness of the lamp’s reflection in the brass.',
  },
  rimPolish: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.2,
    category: 'Brass rim',
    label: 'Polish',
    help: 'How sharp the reflection is. Low is satin, high is mirror-bright.',
  },
  rimBrushed: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Brass rim',
    label: 'Brushed lines',
    help: 'Fine brushing along the length of the rim.',
  },
  rimEngrave: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Brass rim',
    label: 'Engraved line',
    help: 'A fine engraved line running round the rim, and the mitre lines at its corners.',
  },

  // ── Velvet ──────────────────────────────────────────────────────────────
  feltColor: {
    type: 'color',
    space: 'srgb',
    default: '#1d6b45',
    category: 'Velvet',
    label: 'Velvet colour',
    help: 'The cloth’s colour under the lamp.',
  },
  feltNap: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.22,
    category: 'Velvet',
    label: 'Nap texture',
    help: 'How visible the cloth’s pile is up close.',
  },
  feltNapSize: {
    type: 'float',
    min: 1,
    max: 40,
    step: 0.5,
    default: 9,
    category: 'Velvet',
    label: 'Nap size',
    help: 'The size of the pile’s grain, in map pixels.',
  },
  feltMottle: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.79,
    category: 'Velvet',
    label: 'Brushed patches',
    help: 'Soft lighter and darker patches where the pile has been brushed different ways.',
  },
  feltSheen: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.84,
    category: 'Velvet',
    label: 'Panel sheen',
    help: 'Each panel’s pile runs outward, so the panels catch the light differently and shift as you pan.',
  },
  seams: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.58,
    category: 'Velvet',
    label: 'Corner seams',
    help: 'Strength of the creased seams running from the board’s corners out to the table’s corners.',
  },
  stitching: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Velvet',
    label: 'Stitching',
    help: 'A line of stitches beside each seam and along the rim. 0 hides them.',
  },

  midSeams: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.75,
    category: 'Velvet',
    label: 'Middle panel lines',
    help: 'Strength of the creased panel lines running straight out from the middle of each side of the board.',
  },
  panelBump: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.7,
    category: 'Velvet',
    label: 'Panel bump',
    help: 'How padded each velvet panel looks: the cloth sinks into the seams and lifts gently in the middle of each panel.',
  },
  panelBumpPct: {
    type: 'float',
    min: 0.2,
    max: 15,
    step: 0.1,
    default: 6.3,
    category: 'Velvet',
    label: 'Panel bump width',
    help: 'How far in from each seam and edge the padding rises to full height, as a percentage of the board’s shorter side.',
  },

  // ── Stitches ────────────────────────────────────────────────────────────
  stitchColor: {
    type: 'color',
    space: 'srgb',
    default: '#c9a14a',
    category: 'Stitches',
    label: 'Thread colour',
    help: 'The colour of the stitching thread.',
  },
  stitchLength: {
    type: 'float',
    min: 0.1,
    max: 0.95,
    step: 0.01,
    default: 0.46,
    category: 'Stitches',
    label: 'Stitch length',
    help: 'How much of each stitch spacing is thread. Low is a dotted line; high is nearly continuous.',
  },
  stitchSpacing: {
    type: 'float',
    min: 0.3,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Stitches',
    label: 'Stitch spacing',
    help: 'Distance between stitches, relative to the rim.',
  },
  stitchWidth: {
    type: 'float',
    min: 0.3,
    max: 4,
    step: 0.05,
    default: 0.5,
    category: 'Stitches',
    label: 'Thread thickness',
    help: 'How thick the thread is.',
  },
  stitchOutline: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.7,
    category: 'Stitches',
    label: 'Dark outline',
    help: 'A dark outline round each stitch, where the thread pulls the cloth down into its hole.',
  },
  stitchInset: {
    type: 'float',
    min: 0.3,
    max: 4,
    step: 0.05,
    default: 0.4,
    category: 'Stitches',
    label: 'Distance from seam',
    help: 'How far the lines of stitches sit from the seams and from the brass rim.',
  },

  // ── Lamp ────────────────────────────────────────────────────────────────
  lampStrength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 0.35,
    category: 'Lamp',
    label: 'Lamp brightness',
    help: 'The single spot light over the table. It lights the velvet and puts the highlights on the brass. The table is also lit by the scene’s own light, so it darkens at night with the map: raise this to keep it readable.',
  },
  lampColor: {
    type: 'color',
    space: 'srgb',
    default: '#ffe6bf',
    category: 'Lamp',
    label: 'Lamp colour',
    help: 'Warm for an old club lamp, white for a modern room.',
  },
  lampSpread: {
    type: 'float',
    min: 0.2,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Lamp',
    label: 'Lamp spread',
    help: 'How wide the spot’s pool of light is, relative to the board. Its edge fades out softly.',
  },
  cornerDark: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.74,
    category: 'Lamp',
    label: 'Dark corners',
    help: 'How much darker the four diagonal corners of the table are than its sides. Gives the table depth and atmosphere.',
  },
  roomDark: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Lamp',
    label: 'Dark room',
    help: 'How dark the room is beyond the lamp’s pool. 0 lights the whole table evenly.',
  },

  // ── Off the board ───────────────────────────────────────────────────────
  privateOffBoard: {
    type: 'bool',
    default: true,
    category: 'Off the board',
    label: 'Private table',
    help: 'Tokens on the velvet are out of play: players see only the ones they own; tokens the GM puts there stay hidden from them. Applies while the Table is on.',
  },
});

/**
 * The manifest. `enabledFromProfile: 'extreme'` — the opt-in posture (same as
 * `PRISM`): the table is a look a GM chooses, not something every map should
 * gain on upgrade. One full-screen pass of closed-form maths, no textures.
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const TABLE = Object.freeze({
  id: 'table',
  title: 'Table',
  visualWeight: 0.2,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'extreme',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'Pure procedural maths in one pass: no texture to bake, no asset to load. Its pipeline is compiled deferrable like every per-frame effect.',
  }),
  params: TABLE_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'recessed-table',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.04 }),
      adds: 'a procedural brass rim and velvet table round the board, traced per pixel against a pretend perspective eye (closed-form, no texture taps), plus a contact shadow under the rim',
    }),
  ]),
});
