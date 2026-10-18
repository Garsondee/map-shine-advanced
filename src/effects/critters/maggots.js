/**
 * MAGGOTS — THE DECLARATION. Params schema + manifest, pure data, no THREE and no
 * TSL. The third critter effect, with the same engine as the flies and fireflies
 * (`effects/particles/critter-runtime.js`, `kind: 'maggot'`), its own painted mask
 * (`_Maggots`) and its own Studio card.
 *
 * ============================================================================
 * WHY A SEPARATE EFFECT AND NOT A SLIDER ON THE FLIES
 * ============================================================================
 *
 * They began as a slider on the flies' card ("maggots per swarm", in the flies' zone). That made
 * the one thing a GM wants to say — "this corpse has maggots, that puddle of blood has none, and
 * the compost heap has maggots and no flies at all" — impossible: the two always shared one paint.
 * Maggots are now painted on their own mask and tuned on their own card, so a scene can have any
 * combination, and each of the three critters has a card, a mask and a set of weather responses
 * that mean exactly one thing.
 *
 * ============================================================================
 * WHAT A MAGGOT DECIDES
 * ============================================================================
 *
 * Very little, which is the character: it mostly WRITHES in place, now and then CRAWLS a body
 * length or two toward where the crowd is thickest, and stops again. The crowd finds its own
 * middle without any maggot talking to another: each one biases its heading up the zone field's
 * depth gradient (`clustering`), so a heap forms where the paint is deepest. The body is a
 * nine-point spine with two travelling bend waves and a peristaltic squeeze
 * (`maggot-body.js`), so every look control below is a number a real body feature reads.
 *
 * Weather acts differently on them than on a fly: rain does not clear a maggot heap, it drives the
 * heap to writhe harder (`rainAgitation`), and cold does not send them away, it stills them
 * (`coldSlowdown`). Both are still dials, and every cause can clear them too.
 *
 * ⚠️ THE DEFAULTS ARE A FIRST PASS, tuned in the lab and not yet by the author on a real scene.
 *
 * @module effects/critters/maggots
 */
import { freezeParams, presenceParams, weatherParams } from './critter-params.js';

export const MAGGOTS_PARAMS = freezeParams({
  // ── Presence ─────────────────────────────────────────────────────────────
  ...presenceParams({
    countId: 'countPerZone',
    noun: 'maggots',
    unit: 'writhing mass',
    max: 300,
    count: 30,
    areaScaling: 0.5,
    countHelpExtra: 'They crawl a body length or two at a time, so a mass stays in its paint.',
  }),

  // ── Look ─────────────────────────────────────────────────────────────────
  size: {
    type: 'float',
    min: 6,
    max: 120,
    step: 1,
    default: 20,
    category: 'Look',
    label: 'Maggot size',
    help: 'Body length in pixels.',
  },
  sizeVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.25,
    category: 'Look',
    label: 'Size variation',
    help: 'How much individual maggots differ in size.',
  },
  color: {
    type: 'color',
    space: 'srgb',
    default: '#e6dcb8',
    category: 'Look',
    label: 'Maggot colour',
    help: 'The body colour. Real maggots run from cream to dull yellow, and a blowfly brood on a bright day looks nearly white.',
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Opacity',
    help: 'Overall opacity of the maggots (and their contact shadows).',
  },
  girth: {
    type: 'float',
    min: 0.6,
    max: 1.6,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Girth ×',
    help: 'How fat each body is, without making it longer. Thin and wiry reads as a fresh hatch; fat and bloated is a feasting brood.',
  },
  lightInfluence: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Lit by the scene',
    help: 'How much the scene’s own lighting darkens and tints a maggot: 1 puts it in the torchlight or the gloom like everything else, 0 draws it full-bright whatever the room is doing. Needs the "lit" quality rung (2) or above.',
  },
  contactShadow: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Look',
    label: 'Contact shadow ×',
    help: 'How dark the soft shadow is where each body presses on the ground, which is what makes a maggot sit on a surface instead of floating over it.',
  },

  // ── Detail ───────────────────────────────────────────────────────────────
  gloss: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Detail',
    label: 'Moist gloss',
    help: 'How wet the skin looks: the soft highlight along the back. 0 is dry and matte; 2 is slick. The "detail" quality rung (3) makes the highlight crisper.',
  },
  segmentDepth: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Detail',
    label: 'Segment grooves ×',
    help: 'How deep the grooves between a maggot’s body segments are drawn, deeper toward the tail. 0 is a smooth tube.',
  },
  gutLine: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Detail',
    label: 'Gut line ×',
    help: 'How clearly the dark digestive tract shows through the skin along the back. Higher is a well-fed brood.',
  },

  // ── Motion ───────────────────────────────────────────────────────────────
  wriggle: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Wriggle ×',
    help: 'How violently the body writhes — the sideways S-wave and the squeeze-and-stretch along its length.',
  },
  waveCount: {
    type: 'float',
    min: 0.4,
    max: 2.5,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Ripples per body ×',
    help: 'How many bend waves fit along one body. Under 1 is a slow, lazy S; over 1 is a tight, fast ripple.',
  },
  crawlSpeed: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Crawl speed ×',
    help: 'How fast maggots crawl. Even at 1 they mostly writhe in place, then shuffle a body length or so and stop.',
  },
  crawlChance: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.55,
    category: 'Motion',
    label: 'Crawl or writhe',
    help: 'The chance that a maggot which has finished writhing sets off crawling rather than writhing again. 0 is a heap that only squirms in place; 1 never stops moving house.',
  },
  crawlLength: {
    type: 'float',
    min: 0.3,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Crawl distance ×',
    help: 'How far each crawl goes, as a multiple of the default (about a body length and a half).',
  },
  pauseMin: {
    type: 'float',
    min: 0.1,
    max: 20,
    step: 0.1,
    default: 0.9,
    category: 'Motion',
    label: 'Shortest rest (s)',
    help: 'The shortest a maggot writhes in place before it decides what to do next.',
  },
  pauseMax: {
    type: 'float',
    min: 0.2,
    max: 30,
    step: 0.1,
    default: 3.6,
    category: 'Motion',
    label: 'Longest rest (s)',
    help: 'The longest a maggot writhes in place before it decides what to do next.',
  },
  clustering: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.6,
    category: 'Motion',
    label: 'Clustering',
    help: 'How strongly maggots pile toward the middle of a zone, where the thing they are eating is. 0 spreads them evenly over the paint.',
  },
  speed: {
    type: 'float',
    min: 0.1,
    max: 6,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Tempo',
    help: 'A master clock for the whole mass — how quickly they ripple, rest and set off. 1 is the natural pace.',
  },

  // ── Weather ──────────────────────────────────────────────────────────────
  ...weatherParams({
    noun: 'maggots',
    defaults: {
      rain: 0.25,
      snow: 0.5,
      windThreshold: 0.7,
      wind: 0,
      coldBelow: 0.25,
      cold: 0,
      floor: 0,
      fadeTime: 1.5,
    },
  }),
  rainAgitation: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 0.8,
    category: 'Weather',
    label: 'Rain makes them squirm ×',
    help: 'How much harder the maggots writhe in rain: their wriggle is multiplied by 1 + this × the rain. Wet ground drives them to the surface.',
  },
  coldSlowdown: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.8,
    category: 'Weather',
    label: 'Cold slows them',
    help: 'How sluggish a cold day makes the maggots: every ripple, rest and crawl slows. Uses the same "too cold below" temperature.',
  },
});

/**
 * The Studio card's front-of-house strip: how many, how big, what colour, how they writhe and crawl, how tightly they
 * clump, and how much rain drives them under. Everything else is on the card's ROH. Held to the schema by a Node test.
 */
export const MAGGOTS_FOH = Object.freeze([
  'countPerZone',
  'size',
  'color',
  'wriggle',
  'crawlSpeed',
  'clustering',
  'rainResponse',
]);

/** Built-in presets — see `SMELLY_FLIES_PRESETS`. */
export const MAGGOTS_PRESETS = Object.freeze({
  'Writhing mass': Object.freeze({
    countPerZone: 60,
    wriggle: 1.4,
    clustering: 0.85,
    crawlChance: 0.4,
    areaScaling: 0.7,
  }),
  Sluggish: Object.freeze({ crawlSpeed: 0.4, wriggle: 0.6, speed: 0.7, pauseMin: 1.5, pauseMax: 6 }),
  Infested: Object.freeze({ countPerZone: 150, size: 16, areaScaling: 0.9, clustering: 0.7 }),
  'Restless brood': Object.freeze({
    crawlChance: 0.95,
    crawlSpeed: 1.8,
    crawlLength: 1.8,
    clustering: 0.15,
    speed: 1.3,
  }),
  'Ignores the weather': Object.freeze({
    rainResponse: 0,
    snowResponse: 0,
    windResponse: 0,
    coldResponse: 0,
    rainAgitation: 0,
    coldSlowdown: 0,
  }),
});

/** @param {string} name @returns {Record<string, *>} a fresh patch, `{}` for an unknown name. */
export function maggotsPreset(name) {
  return { ...(MAGGOTS_PRESETS[name] ?? {}) };
}

/**
 * THE MANIFEST.
 *
 * `photosensitive: false`: nothing flashes — a body writhes at a couple of hertz, smoothly, and
 * the largest thing on screen is a few dozen pixels long.
 */
export const MAGGOTS = Object.freeze({
  id: 'maggots',
  title: 'Maggots',
  // Ambient decoration on the ground, the smallest of the three in screen area.
  visualWeight: 0.3,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why: 'Builds its maggot engine lazily on the first sync that has a painted zone (ensureEngine) — real first-run work (a compute kernel and a material), but SYNCHRONOUS, with no pending window a probe could observe, and a "built yet?" flag would hold readiness open forever on a scene with no maggots painted. It is covered globally instead: the kernels grow the pipeline set, which is precisely what settle.js’s pipeline-growth criterion exists to catch.',
  }),
  params: MAGGOTS_PARAMS,
  authoring: Object.freeze({ paint: 'maggots' }),

  /**
   * THE LADDER — what each rung buys. Maggots follow the fly ladder's flags (`critter-species.js`),
   * and the descriptions say what those flags mean for a body with no legs or wings.
   */
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'smudges',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.02 }),
      adds: 'half the mass, each a bending tube with its travelling wriggle, flat-coloured and with a faint highlight — right place, right motion, as cheap as the effect gets',
    }),
    Object.freeze({
      n: 1,
      name: 'larvae',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.03 }),
      adds: 'three quarters of the mass',
    }),
    Object.freeze({
      n: 2,
      name: 'lit',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.04 }),
      adds: 'the full mass, lit by the scene (two illumination reads), with the dark mouth hooks and the two breathing holes on the tail',
    }),
    Object.freeze({
      n: 3,
      name: 'wet',
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.05 }),
      adds: 'a crisp moist highlight along each back',
    }),
    Object.freeze({
      n: 4,
      name: 'infestation',
      fromProfile: 'extreme',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.06 }),
      adds: 'a quarter more maggots than the author asked for',
    }),
  ]),

  /** Recorded, genuinely not built — the list this effect is judged against. */
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'burrowing',
      note: 'Maggots sinking out of sight into the thing they are eating and re-emerging, instead of only fading in and out with the head-count. Needs a per-agent depth the arena has no slot for.',
    }),
    Object.freeze({
      name: 'flies-from-maggots',
      note: 'A mass that matures: maggots pupating over a long in-world time and flies emerging from the same paint. Needs a world-clock-keyed life cycle shared between two effects.',
    }),
  ]),
});
