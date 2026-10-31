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

/**
 * The effect's Studio parameters (2026-10-31: the author asked for "lots of controls so that I can fine tune the
 * appearance"). Every Look/Outline/Twigs/Motion dial is a shader uniform or a birth-time CPU number: moving one
 * never rebuilds a shader. Each default reproduces the look she last approved.
 */
export const LEAF_SHED_PARAMS = Object.freeze({
  // ── Shedding ──────────────────────────────────────────────────────────────
  amount: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Shedding',
    label: 'Amount',
    help: 'How many leaves a canopy sheds at a given wind. More wind always means more; this scales the lot.',
  },
  startsAboveMps: {
    type: 'float',
    min: 2,
    max: 40,
    step: 0.5,
    default: 11,
    category: 'Shedding',
    label: 'Starts above (m/s)',
    help: 'Local wind speed below which nothing is torn off. 11 m/s is a strong breeze; 17 m/s a gale; 25 m/s a storm.',
  },
  fullAtMps: {
    type: 'float',
    min: 4,
    max: 70,
    step: 0.5,
    default: 26,
    category: 'Shedding',
    label: 'Full shedding at (m/s)',
    help: 'Wind speed at which shedding reaches its busiest. Between the two, it ramps up.',
  },
  bushShare: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.6,
    category: 'Shedding',
    label: 'Bushes',
    help: 'How much bushes shed compared with trees. 0 keeps bushes still.',
  },
  // ── Mix and size ──────────────────────────────────────────────────────────
  leafSize: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Mix and size',
    label: 'Overall size',
    help: 'Scales every leaf and twig. 1 matches the leaves painted on the Mythica Machina maps (about a fifth of a grid square).',
  },
  clumpShare: {
    type: 'float',
    min: 0,
    max: 0.6,
    step: 0.01,
    default: 0.12,
    category: 'Mix and size',
    label: 'Broad leaves',
    help: 'Share of what a tree sheds that is a broad leaf (maple, trifoliate, heart, spear or serrated) rather than a plain pointed leaf.',
  },
  twigShare: {
    type: 'float',
    min: 0,
    max: 0.6,
    step: 0.01,
    default: 0.1,
    category: 'Mix and size',
    label: 'Twigs',
    help: 'Share of what a tree sheds that is a twig rather than a leaf. Bushes shed no twigs.',
  },
  broadLeafSize: {
    type: 'float',
    min: 0.4,
    max: 2.5,
    step: 0.05,
    default: 1,
    category: 'Mix and size',
    label: 'Broad leaf size',
    help: 'Size of a broad leaf next to a plain one (1 = about one and a half times as long).',
  },
  twigSize: {
    type: 'float',
    min: 0.4,
    max: 2.5,
    step: 0.05,
    default: 1,
    category: 'Mix and size',
    label: 'Twig length',
    help: 'Length of a twig next to a leaf (1 = about two and a half leaves long).',
  },
  // ── Leaves ────────────────────────────────────────────────────────────────
  leafWidth: {
    type: 'float',
    min: 0.4,
    max: 1.8,
    step: 0.05,
    default: 1,
    category: 'Leaves',
    label: 'Leaf width',
    help: 'Slim willow-like leaves (low) to broad round ones (high). Applies to every leaf form.',
  },
  leafVariety: {
    type: 'float',
    min: 0,
    max: 2.5,
    step: 0.05,
    default: 1,
    category: 'Leaves',
    label: 'Shape variety',
    help: 'How differently each leaf is shaped: width, bend, lopsidedness, lobe angles. 0 makes every leaf of a kind identical.',
  },
  colourVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.35,
    category: 'Leaves',
    label: 'Colour variation',
    help: 'How much each leaf strays from the colour painted under it.',
  },
  saturation: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Leaves',
    label: 'Saturation',
    help: 'Colour strength of leaves and twigs. 0 is grey, 1 is the canopy’s own colour.',
  },
  brightness: {
    type: 'float',
    min: 0.4,
    max: 1.6,
    step: 0.02,
    default: 1,
    category: 'Leaves',
    label: 'Brightness',
    help: 'Lightens or darkens every leaf and twig against the map.',
  },
  shading: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.55,
    category: 'Leaves',
    label: 'Lit-side highlight',
    help: 'How much paler the half of a leaf facing the light is (the cel shading in the art).',
  },
  underside: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Leaves',
    label: 'Pale underside',
    help: 'How much paler a leaf is when it has flipped over and shows its underside.',
  },
  veins: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.45,
    category: 'Leaves',
    label: 'Centre vein',
    help: 'Strength of the dark stroke down the middle of a leaf.',
  },
  // ── Outline ───────────────────────────────────────────────────────────────
  outline: {
    type: 'float',
    min: 0,
    max: 2.5,
    step: 0.05,
    default: 1,
    category: 'Outline',
    label: 'Outline width',
    help: 'Thickness of the painted outline. 1 matches the map art. It never eats the whole shape: a body always shows inside it.',
  },
  outlineDarkness: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Outline',
    label: 'Outline darkness',
    help: 'How dark the line is: 1 a deep shade of the leaf’s own green (dark brown on twigs), 0 the same colour as the fill.',
  },
  outlineNoise: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Outline',
    label: 'Brush roughness',
    help: 'How much the line wobbles, like a dragged brush. 0 is a clean vector edge.',
  },
  outlineGrain: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Outline',
    label: 'Brush grain',
    help: 'Size of the wobbles in the line: low is long slow waves, high is fine scratchy grit.',
  },
  // ── Twigs ─────────────────────────────────────────────────────────────────
  twigThickness: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Twigs',
    label: 'Twig thickness',
    help: 'How thick a twig is at its broken base. Every shoot thins from there.',
  },
  twigBranching: {
    type: 'float',
    min: 0,
    max: 1.6,
    step: 0.05,
    default: 1,
    category: 'Twigs',
    label: 'Side shoots',
    help: 'How long the side shoots and spurs grow. 0 leaves bare sticks with stubs where shoots broke off.',
  },
  twigCurl: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Twigs',
    label: 'Crookedness',
    help: 'How much a twig zig-zags and wanders. 0 is a straight stick.',
  },
  cutWood: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Twigs',
    label: 'Broken end',
    help: 'How strongly the torn base of a twig shows its pale fresh wood.',
  },
  // ── Motion ────────────────────────────────────────────────────────────────
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
  fallSpeed: {
    type: 'float',
    min: 0.2,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Fall speed',
    help: 'How fast things sink. Low lets leaves hang in the air and travel further; high drops them quickly.',
  },
  spin: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Spin',
    help: 'How fast leaves and twigs turn and tumble in the air.',
  },
  groundGrip: {
    type: 'float',
    min: 0.2,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Ground grip',
    help: 'How firmly things stay put once landed. Low lets leaves skitter along in the gusts; high pins them down.',
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
  // ── Shadow ────────────────────────────────────────────────────────────────
  shadow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.45,
    category: 'Shadow',
    label: 'Shadow',
    help: 'How dark the little shadow a falling leaf casts is. It shrinks into the leaf as the leaf lands.',
  },
});

/**
 * The manifest. A few thousand quads and one small compute pass, and nothing at
 * all until a strong wind meets a painted canopy, so it is on from `low`.
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const LEAF_SHED = Object.freeze({
  id: 'leafShed',
  title: 'Falling Leaves & Twigs',
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
