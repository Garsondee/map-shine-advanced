/**
 * LEAF SHED — leaves and twigs torn off trees and bushes by a strong wind.
 *
 * The author, 2026-10-31: *"Build a new particle effect for trees which get blown
 * by high velocity winds, the goal would be to have procedural twigs and leaves
 * shed off from below the main tree graphic. Bonus points if you match the colour
 * of the leaf to the tree, bonus points for carefully examining the art style of
 * the trees in my art style and get the leaves to match as closely as possible.
 * Bushes could do something similar."*
 *
 * WHAT IT IS: every painted canopy (`_Tree`, `_Bush`) is an EMITTER. Once the
 * wind at a canopy is past `startsAboveMps`, it proposes births at a rate that
 * climbs with the wind; the GPU then asks the REAL local air (gusts and
 * turbulence included, the same field the wind trails ride) whether that leaf
 * actually lets go — so leaves tear off in bursts as each gust front passes,
 * not as a steady drip. A leaf is born at canopy height somewhere UNDER its
 * canopy and is drawn BELOW the canopy art, so it slides out from beneath the
 * leaves on the downwind side, tumbles and flutters down through the air, lands,
 * skitters along the ground while the gale keeps pushing it, and fades.
 *
 * THE LOOK IS THE AUTHOR'S ART (measured 2026-10-31 on the Wilderness pack's
 * deep-forest `_Tree`/`_Bush`, see `leaf-shed-shape.js`): a flat leaf fill with a
 * soft lighter half, a brushy outline ≈ 4 art px wide at ~0.3× the fill's own
 * colour (not black), a short dark mid-stroke, and pink-brown branches
 * (~#6a544e) outlined the same way. Each leaf's colour is the canopy's own,
 * read from the art under it when it was born.
 *
 * Pure data + two builders. No THREE, no Foundry — Node-tested.
 *
 * @module effects/leaf-shed
 */

/** The effect's Studio parameters. */
export const LEAF_SHED_PARAMS = Object.freeze({
  amount: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Amount',
    help: 'How many leaves a canopy sheds at a given wind. More wind always means more; this scales the lot.',
  },
  startsAboveMps: {
    type: 'float',
    min: 2,
    max: 40,
    step: 0.5,
    default: 11,
    category: 'Wind',
    label: 'Starts above (m/s)',
    help: 'Local wind speed below which nothing is torn off. 11 m/s is a strong breeze; 17 m/s a gale; 25 m/s a storm.',
  },
  fullAtMps: {
    type: 'float',
    min: 4,
    max: 70,
    step: 0.5,
    default: 26,
    category: 'Wind',
    label: 'Full shedding at (m/s)',
    help: 'Wind speed at which shedding reaches its busiest. Between the two, it ramps up.',
  },
  bushShare: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.6,
    category: 'Look',
    label: 'Bushes',
    help: 'How much bushes shed compared with trees. 0 keeps bushes still.',
  },
  leafSize: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Leaf size',
    help: 'Scales every leaf and twig. 1 matches the leaves painted on the Mythica Machina maps (about a fifth of a grid square).',
  },
  twigShare: {
    type: 'float',
    min: 0,
    max: 0.6,
    step: 0.01,
    default: 0.1,
    category: 'Look',
    label: 'Twigs',
    help: 'Share of what a tree sheds that is a twig rather than a leaf. Bushes shed no twigs.',
  },
  clumpShare: {
    type: 'float',
    min: 0,
    max: 0.6,
    step: 0.01,
    default: 0.12,
    category: 'Look',
    label: 'Leaf clumps',
    help: 'Share of what a tree sheds that is a small torn-off clump of leaves.',
  },
  colourVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.35,
    category: 'Look',
    label: 'Colour variation',
    help: 'How much each leaf strays from the colour painted under it.',
  },
  outline: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Outline',
    help: 'Thickness of the dark painted outline. 1 matches the map art.',
  },
  shadow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.45,
    category: 'Look',
    label: 'Shadow',
    help: 'How dark the little shadow a falling leaf casts is. It shrinks into the leaf as the leaf lands.',
  },
  flutter: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Flutter',
    help: 'How much a leaf swings side to side and flips over as it falls. Twigs barely flutter.',
  },
  turbulence: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Turbulence',
    help: 'How wildly the air tosses a leaf about: sideways jinks, sudden lifts and drops. Grows with the wind. Twigs barely notice.',
  },
  carry: {
    type: 'float',
    min: 0.2,
    max: 1.5,
    step: 0.05,
    default: 0.45, // leaf lab 2026-10-31: at 1 a 24 m/s gale crosses 16 squares a second — gone before it reads as a leaf
    category: 'Motion',
    label: 'Carried by the wind',
    help: 'How closely a leaf keeps up with the air around it. 1 = as fast as the wind itself.',
  },
  groundSec: {
    type: 'float',
    min: 0,
    max: 20,
    step: 0.5,
    default: 4,
    category: 'Motion',
    label: 'Time on the ground',
    help: 'Seconds a leaf stays after landing (skittering along while the wind holds) before it fades.',
  },
});

/**
 * The manifest. A few thousand quads and one small compute pass, and nothing at
 * all until a strong wind meets a painted canopy, so it is on from `low`.
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const LEAF_SHED = Object.freeze({
  id: 'leafShed',
  title: 'Leaf Shed',
  visualWeight: 0.35,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why: 'Builds its compute kernel and leaf material the first time a canopy meets a strong wind, synchronously inside a frame — covered by settle.js’s global pipeline-growth and frame-steadiness criteria, the same posture as Wind Trails (a calm scene never builds it).',
  }),
  params: LEAF_SHED_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'leaves',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.03 }),
      adds: 'leaves, clumps and twigs torn off painted canopies by strong wind, in the canopy’s own colours',
    }),
  ]),
});

/** Leaves the engine can hold at once, by graphics profile. */
export const LEAF_SHED_CAPACITY = Object.freeze({
  low: 512,
  performance: 1024,
  standard: 2048,
  quality: 3072,
  extreme: 4096,
});

/**
 * The slot count for a performance profile. An unknown profile reads as standard.
 * @param {string} [profile]
 * @returns {number}
 */
export function leafShedCapacity(profile) {
  return LEAF_SHED_CAPACITY[profile] ?? LEAF_SHED_CAPACITY.standard;
}

/**
 * Resolved params with every missing/garbage value replaced by its default, and
 * the two wind thresholds kept in order (full can never sit below start).
 * @param {object} [params]
 * @returns {Record<keyof typeof LEAF_SHED_PARAMS, number>}
 */
export function resolveLeafShedParams(params = {}) {
  const out = {};
  for (const [k, d] of Object.entries(LEAF_SHED_PARAMS)) {
    const v = Number(params?.[k]);
    out[k] = Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.default;
  }
  out.fullAtMps = Math.max(out.fullAtMps, out.startsAboveMps + 1);
  return out;
}
