/**
 * PARALLAX — real depth between the floors. The author, 2026-10-28: *"could we use this 3D table as
 * a way to frame some real parallax depth in the scene based on the elevation of the layer being
 * displayed? … trees, bushes, tiles and everything else … keep our frame of reference or origin on
 * the current floor so that the grid rendering remains faithful and does not parallax drift, but
 * other floors would be allowed to be displaced in the z direction … a subtle parallax and depth
 * effect … hand in hand with our existing DOF effect … improve floor to floor transitions."*
 *
 * HOW IT WORKS (see `parallax-model.js` for the maths). The viewer's camera is orthographic, so every
 * layer is drawn flat at scale 1. This effect gives each layer a height above the viewed floor and
 * scales it about the view centre by `eyeH / (eyeH − h)`: canopies, roofs and the floors above ride
 * outward, the floors beneath sink inward, and the viewed floor never moves — the grid stays true.
 * The eye is the Table's own pretend eye, so the brass rim, the recess walls and the layers all
 * agree. A floor change glides one number (the viewed elevation), so the old floor recedes while
 * the new one settles into place and the rim rises or sinks: the transition is the depth.
 *
 * THIS FILE IS THE DECLARATION (params + manifest), pure data. The maths is `parallax-model.js`;
 * the per-frame transforms are `parallax-subsystem.js`.
 *
 * @module effects/parallax/parallax
 */

/** The effect's Studio parameters, in card order. */
export const PARALLAX_PARAMS = Object.freeze({
  // ── Depth ───────────────────────────────────────────────────────────────
  strength: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Depth',
    label: 'Strength',
    help: 'Overall amount of parallax. 0 turns the depth off (the map is flat again); 1 is the designed look; higher exaggerates every height at once.',
  },
  floorHeightPct: {
    type: 'float',
    min: 0,
    max: 6,
    step: 0.05,
    default: 1,
    category: 'Depth',
    label: 'Floor height',
    help: 'How tall one floor looks, as a percentage of the board’s shorter side. It sets how far the floors below sink and the floors above rise as you pan. Small is subtle.',
  },
  maxScale: {
    type: 'float',
    min: 1.01,
    max: 1.3,
    step: 0.01,
    default: 1.06,
    category: 'Depth',
    label: 'Limit',
    help: 'The most any layer may be scaled, however tall the building or close the zoom. Keeps a many-storey scene from blowing up.',
  },

  // ── Layers ──────────────────────────────────────────────────────────────
  // Trees and bushes need no height of their own here: the Vegetation card's Tree height and Bush
  // height (feet above their floor) already say how tall they stand, and they ride at that height.
  tileLift: {
    type: 'bool',
    default: true,
    category: 'Layers',
    label: 'Tiles use their elevation',
    help: 'Tiles with an elevation (roofs, awnings, bridges) ride at that height above the floor they belong to. Off keeps every tile on its floor’s plane.',
  },

  // ── Table ───────────────────────────────────────────────────────────────
  tableFollows: {
    type: 'bool',
    default: true,
    category: 'Table',
    label: 'Fit the stack to the table',
    help: 'While the Table is on, the tallest layer (the highest roof or treetop) stands exactly level with the top of the brass rim: a short stack is lifted to meet it, and a tall building deepens the recess so the floors below sink into the table as you climb.',
  },
  treeEdgeShadow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.15,
    category: 'Table',
    label: 'Edge shadow on treetops',
    help: 'How much of the Table’s board shadow the tallest canopy keeps. Raised layers stand up out of the crease under the brass, so they sit in less of its shadow: the floor keeps all of it, and the share falls with height down to this at treetop height. 1 shades every layer alike.',
  },

  // ── Floor change ────────────────────────────────────────────────────────
  glideSec: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 0.8,
    category: 'Floor change',
    label: 'Glide time',
    help: 'How long a floor change takes to rise or sink through the depth, in seconds. 0 snaps straight to the new floor.',
  },
});

/**
 * The manifest. `enabledFromProfile: 'extreme'` — the opt-in posture (same as `TABLE`): a depth
 * look a GM chooses. It adds no shader and no texture: it moves meshes the world pass already draws.
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const PARALLAX = Object.freeze({
  id: 'parallax',
  title: 'Parallax',
  visualWeight: 0.15,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'extreme',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'Per-frame transforms of meshes the world pass already draws: no texture to bake, no shader to compile, no asset to load.',
  }),
  params: PARALLAX_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'floor-depth',
      cost: Object.freeze({ class: 'C0', estMsPerMp: 0 }),
      adds: 'each layer scaled about the view centre by its height above the viewed floor, so floors, trees and roofs slide against one another as the view pans, and a floor change glides through the depth',
    }),
  ]),
});
