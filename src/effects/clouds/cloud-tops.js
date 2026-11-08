/**
 * CLOUD TOPS — the authorable knobs for the LIT CLOUD SHAPES drawn from
 * above, zoom-gated with parallax. A genuinely separate effect from
 * `clouds.js#CLOUD_LOOK` (the ground-shadow/window-mood layer), per that
 * file's own on-the-record note: "a genuinely separate feature ... not a
 * missing tier of them" — the shadow can be seen, and matters for gameplay
 * mood, at any zoom; the tops are a luxury view of the sky itself, correct
 * only when the camera has pulled back far enough to see it as a view of the
 * sky rather than a shape pasted on top of the tokens the players are using.
 *
 * Same three-way split `clouds.js`'s own header documents: this file is the
 * DECLARATION (pure data, no THREE); the shading math lives in
 * `effects/clouds/cloud-shade.js#buildCloudTopsNode` (built 2026-09-06,
 * slice A — see that file's own header for the full lighting model: wrap
 * lighting, self-shadow march, Beer/powder, silver lining, ambient,
 * highlight roll-off) plus this session's own zoom-gate/parallax addition
 * (`cloudTopsGate`/`buildCloudTopsParallaxWorldXY`, same file); the actual
 * mesh/material/scene wiring lives inline in `vt/vt-pan-viewer.js`
 * (`runCloudTopsPass`), the same "no separate `clouds-render.js`" posture
 * `clouds.js` already established, extended to a genuinely new draw rather
 * than an extra term on an existing material.
 *
 * ============================================================================
 * WHAT THIS MANIFEST DOES AND DOES NOT OWN
 * ============================================================================
 * `cloudCover01`/`cloudType01`/`cloudAltitudePx`/`cloudScalePx` are WEATHER
 * AXES (Weather-Manager LAW 3) — this schema does not duplicate them, exactly
 * like `CLOUD_LOOK_PARAMS`. Everything below is genuinely LOOK: how strong
 * the tops read once visible, and how readily they appear as the camera
 * zooms out. The field's own internal quality knobs (octaves, self-shadow tap
 * count) are JS-time constants chosen by the viewer from the global
 * performance profile, the same "declared cost class, ad-hoc per-consumer
 * quality selection" pattern `depth-of-field.js`'s own pyramid depth and this
 * codebase's several other `resolveTier()`-style consumers already use —
 * never exposed as a live param, because changing them rebuilds the compiled
 * shader graph rather than poking a uniform.
 *
 * `enabledFromProfile: 'standard'` (NOT `'low'`, unlike `CLOUD_LOOK`) is a
 * direct read of doc 03 §3's own tier ladder: "tops | C8 | standard" — the
 * ground shadow is cheap enough to run at every tier and does real gameplay
 * work at every tier (a passing cloud dims a room); the tops are the single
 * most expensive term in the whole feature (six-plus shape evaluations per
 * pixel, doc 02 §2.7) and are pure atmosphere, so they are the first thing a
 * `performance`/`low` profile should give up.
 *
 * @module effects/clouds/cloud-tops
 */

/**
 * @type {Record<string, object>}
 */
export const CLOUD_TOPS_PARAMS = Object.freeze({
  opacity: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    // 2026-10-16 — author's live-tuned "new defaults" dump (was 1).
    // 2026-11-08 — author: clouds "are always semi-transparent which looks kinda bad" (was 0.8).
    default: 1,
    category: 'Look',
    label: 'Tops opacity',
    help: 'Master strength for the lit cloud shapes themselves, once the zoom gate has let them appear. 0 hides them entirely without touching the ground shadow/window mood, which are a separate effect (Clouds). Past 1 pushes them more opaque than their own natural Beer-law alpha.',
  },
  zoomSensitivity: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.01,
    // 2026-10-16 — author's live-tuned "new defaults" dump (was 1): the tops
    // now wait for a wider view before appearing.
    // 2026-11-07 (mmp-63o.30, author: clouds "get in the way too much" zoomed out): 0.79 -> 0.45,
    // the tops wait for about twice as wide a view; cloudTopsZoomOutThin thins them further out.
    default: 0.45,
    category: 'Look',
    label: 'Zoom sensitivity',
    help: 'How readily the cloud tops appear as you zoom out. Above 1 they appear sooner; below 1 they wait for a wider view. Cloud shadows on the ground are drawn at every zoom.',
  },
  interiorCut: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.92,
    category: 'Look',
    label: 'Clear building interiors',
    help: 'Cuts a very soft, blurred hole through the cloud tops wherever the map is marked as indoors (the dark parts of its outdoors mask), so clouds stop covering the insides of buildings. 0 = off; 1 = interiors fully clear. Only the tops are cut; the ground shadow is untouched.',
  },
  interiorCutZoomedOut: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    // 2026-11-08 — author: clouds must never go over inside areas (was 0.12, which let them cover the whole building zoomed out).
    default: 1,
    category: 'Look',
    label: 'Interior clearing when zoomed out',
    help: 'How much of that clearing is left when the view takes in the whole map. The clearing is full strength up close and at medium zoom and fades away as you zoom out, so the sky can cover everything evenly. 0 = gone when fully zoomed out; 1 = never fades.',
  },
  // ── Storybook (2026-11-03; round 7 dial set) — the dials of effects/clouds/storybook-clouds.js. Defaults mirror
  // that file's STORYBOOK_DECK_DEFAULTS (a test holds them equal). Used only while the Clouds card's style is
  // Storybook.
  storybookSize: {
    type: 'float',
    min: 0.25,
    max: 3,
    step: 0.01,
    default: 1.15,
    category: 'Storybook · Layer',
    label: 'Cloud size',
    help: 'How big the clouds are. Every other shape dial works at this scale, so a bigger size keeps the same character, just larger.',
  },
  storybookSpacing: {
    type: 'float',
    min: 0.15,
    max: 1.5,
    step: 0.01,
    default: 0.48,
    category: 'Storybook · Layer',
    label: 'Gap scale',
    help: 'How big the crowded patches of sky and the open stretches between them are. Small = a busy, even sky; large = big fleets of cloud with wide open sea between.',
  },
  storybookHeight: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.01,
    default: 0.12,
    category: 'Storybook · Layer',
    label: 'Deck height',
    help: "How high the clouds hang, as a fraction of the camera's height above the table. Higher = closer to you: bigger, and sliding more against the map as you pan (real parallax).",
  },
  storybookBulge: {
    type: 'float',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 0.5,
    category: 'Storybook · Layer',
    label: 'Dome bulge',
    help: 'How much the cloud layer arches over the table like a dome, with a slight fisheye swell in the middle of the view. 0 = a flat deck.',
  },
  storybookEvolve: {
    type: 'float',
    min: 0,
    max: 5,
    step: 0.01,
    default: 1,
    category: 'Storybook · Layer',
    label: 'Evolve speed',
    help: 'How fast the clouds change shape as they drift: bulging, pinching, merging and splitting. 0 = rigid shapes that only drift.',
  },
  storybookCluster: {
    type: 'float',
    min: 0,
    max: 2.5,
    step: 0.01,
    default: 1.1,
    category: 'Storybook · Shape',
    label: 'Clumping',
    help: 'How strongly clouds gather into groups with open sky between. 0 = evenly scattered; high = tight fleets and wide gaps. (Changes how much sky a given Cloud cover fills.)',
  },
  storybookWarp: {
    type: 'float',
    min: 0,
    max: 0.8,
    step: 0.01,
    default: 0.15,
    category: 'Storybook · Shape',
    label: 'Twist',
    help: 'How much the shapes are pushed and swirled out of round. Low = compact rounded heaps; high = stretched, twisting, ragged forms.',
  },
  storybookShapeDetail: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Storybook · Shape',
    label: 'Shape detail',
    help: 'How finely the overall cloud shapes are broken up. Low = few big simple masses; high = many smaller, more intricate ones.',
  },
  storybookPuffs: {
    type: 'float',
    min: 0,
    max: 2.5,
    step: 0.01,
    default: 1,
    category: 'Storybook · Shape',
    label: 'Cauliflower puffs',
    help: 'How strongly rounded puffs bulge out of the outline — the cauliflower edge of a cumulus. 0 = smooth blobby outlines.',
  },
  storybookPuffSize: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Storybook · Shape',
    label: 'Puff fineness',
    help: 'How small the outline puffs are. Low = a few big rounded lobes; high = many small scallops.',
  },
  storybookErosion: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.42,
    category: 'Storybook · Edges & scraps',
    label: 'Edge erosion',
    help: "How deeply fine billows eat into each cloud's edge (the Horizon Zero Dawn method: detail is subtracted, never added). 0 = clean soft edges; high = deeply frayed.",
  },
  storybookScrapReach: {
    type: 'float',
    min: 0,
    max: 0.6,
    step: 0.01,
    default: 0.2,
    category: 'Storybook · Edges & scraps',
    label: 'Scrap reach',
    help: 'How far past each cloud its torn-off scraps and fragments are scattered.',
  },
  storybookScrapThinning: {
    type: 'float',
    min: 0.4,
    max: 2,
    step: 0.01,
    default: 1.15,
    category: 'Storybook · Edges & scraps',
    label: 'Scrap thinning',
    help: 'How quickly the scraps thin out with distance from their parent cloud. Low = a dense halo of fragments; high = only a few close in.',
  },
  storybookScrapSoftness: {
    type: 'float',
    min: 0.02,
    max: 1,
    step: 0.01,
    default: 0.3,
    category: 'Storybook · Edges & scraps',
    label: 'Scrap softness',
    help: 'How soft each scrap is. Low = crisp little cut-outs; high = faint misty smudges.',
  },
  storybookFraySize: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Storybook · Edges & scraps',
    label: 'Fray fineness',
    help: 'How fine the fraying billows are, at the edges and inside. Low = chunky tufts; high = fine fluff.',
  },
  storybookSwirl: {
    type: 'float',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 0.12,
    category: 'Storybook · Edges & scraps',
    label: 'Fray swirl',
    help: 'How much the fraying billows are dragged into swirls. Too high streaks them into stripes.',
  },
  storybookEdgeDensity: {
    type: 'float',
    min: 0.5,
    max: 10,
    step: 0.05,
    // 2026-11-08 — author: thin cloud read as see-through ("looks silly"). Was 3.2.
    default: 7,
    category: 'Storybook · Edges & scraps',
    label: 'Edge density',
    help: 'How quickly thin cloud becomes opaque. Low = soft see-through edges and veils; high = solid clouds with harder edges.',
  },
  storybookBreakup: {
    type: 'float',
    min: 0,
    max: 1.2,
    step: 0.01,
    default: 0.75,
    category: 'Storybook · Edges & scraps',
    label: 'Inner break-up',
    help: 'How much the billows break up the inside of each cloud, so it reads as fluffy and painterly rather than one smooth blob.',
  },
  storybookMist: {
    type: 'float',
    min: 0,
    max: 0.6,
    step: 0.01,
    default: 0.1,
    category: 'Storybook · Mist & wisps',
    label: 'Mist',
    help: 'A diffuse, undefined veil round and between the clouds.',
  },
  storybookTails: {
    type: 'float',
    min: 0,
    max: 2.5,
    step: 0.01,
    default: 1,
    category: 'Storybook · Mist & wisps',
    label: 'Wisps',
    help: 'Thin streaks torn off the clouds and streaming along the wind. 0 = none.',
  },
  storybookAbsorb: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1.1,
    category: 'Storybook · Light',
    label: 'Light absorption',
    help: 'How strongly cloud standing between a point and the sun shades it (Beer’s law). Low = luminous; high = deep shaded flanks and strong cloud-on-cloud shadows.',
  },
  storybookSelfShadow: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Storybook · Light',
    label: 'Self & cast shadows',
    help: 'Strength of the shadows clouds throw — on their own billows and across neighbouring clouds. 0 = no shadows within the deck.',
  },
  storybookDepth: {
    type: 'float',
    min: 0.3,
    max: 8,
    step: 0.05,
    default: 3,
    category: 'Storybook · Light',
    label: 'Cloud depth',
    help: 'How tall the clouds stand in the light. Taller clouds shade more of their own far side and throw longer shadows across their neighbours; low = flat, evenly lit sheets.',
  },
  storybookShadowReach: {
    type: 'float',
    min: 0.2,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Storybook · Light',
    label: 'Shadow reach',
    help: 'How far those shadows reach. A low sun stretches them further on its own.',
  },
  storybookPowder: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.55,
    category: 'Storybook · Light',
    label: 'Powder',
    help: 'The soft darkening on the thin, sunlit rims of billows (the "powdered sugar" look) that makes the dense middles glow by contrast.',
  },
  storybookGlow: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Storybook · Light',
    label: 'Inner glow',
    help: 'Light scattered around inside thick cloud. High = clouds glow softly from within; 0 = shaded parts go flat and dark.',
  },
  storybookAmbient: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Storybook · Light',
    label: 'Ambient fill',
    help: 'Sky light filling the shaded parts. Low = deep shade tones; high = bright, washed shade.',
  },
  storybookContrast: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Storybook · Light',
    label: 'Contrast',
    help: 'Contrast between the lit and shaded parts of each cloud.',
  },
  storybookBrush: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 0.5,
    category: 'Storybook · Light',
    label: 'Brush texture',
    help: 'A little broken colour across the clouds, so they sit with painted map art. 0 = clean.',
  },
  storybookDrama: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Storybook · Golden hour',
    label: 'Golden-hour drama',
    help: 'How much a low sun (dawn and dusk) splits each cloud into a blazing sunlit side and a deep shade side, and stretches its shadows across its neighbours. 0 = a low sun lights like midday.',
  },
  storybookLitSide: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Storybook · Golden hour',
    label: 'Sunlit side glow',
    help: 'How brightly the flank facing the sun blazes.',
  },
  storybookShadeSide: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Storybook · Golden hour',
    label: 'Shade side depth',
    help: 'How deep the side away from a low sun falls into the cool shadow tone.',
  },
  storybookRim: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.45,
    category: 'Storybook · Golden hour',
    label: 'Silver lining',
    help: 'The bright backlit rim on thin cloud facing the sun — strongest at golden hour.',
  },
  storybookLowHeight: {
    type: 'float',
    min: 0.1,
    max: 0.95,
    step: 0.01,
    default: 0.55,
    category: 'Storybook · Layers',
    label: 'Low deck height',
    help: "How high the low deck hangs, as a fraction of the main deck's height. Lower = it slides more slowly than the main clouds as you pan, and sits in their shadow.",
  },
  storybookLowSize: {
    type: 'float',
    min: 0.2,
    max: 3,
    step: 0.01,
    default: 0.6,
    category: 'Storybook · Layers',
    label: 'Low deck cloud size',
    help: 'How big the low deck’s clouds are, against the main deck’s.',
  },
  storybookLowPace: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 0.75,
    category: 'Storybook · Layers',
    label: 'Low deck pace',
    help: 'How fast the low deck drifts and changes, against the main deck (low cloud usually runs slower).',
  },
  storybookLowAmount: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.6,
    category: 'Storybook · Layers',
    label: 'Low deck amount',
    help: 'How much low cloud there is. It grows with Cloud cover: at Amount 1 it matches the main deck at full cover; 0 = no low deck.',
  },
  storybookLowOpacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Storybook · Layers',
    label: 'Low deck opacity',
    help: 'How solid the low deck reads. 0 = off.',
  },
  storybookLowShear: {
    type: 'float',
    min: -90,
    max: 90,
    step: 1,
    default: -10,
    category: 'Storybook · Layers',
    label: 'Low deck wind turn',
    help: 'How many degrees the low deck’s drift turns from the main wind (wind shear: decks at different heights rarely move the same way).',
  },
  storybookHighHeight: {
    type: 'float',
    min: 1.05,
    max: 3,
    step: 0.01,
    default: 1.45,
    category: 'Storybook · Layers',
    label: 'High deck height',
    help: "How high the high deck hangs, as a fraction of the main deck's height. Higher = nearer the camera: bigger, and sliding faster over everything below as you pan.",
  },
  storybookHighSize: {
    type: 'float',
    min: 0.2,
    max: 3,
    step: 0.01,
    default: 0.75,
    category: 'Storybook · Layers',
    label: 'High deck cloud size',
    help: 'How big the high deck’s clouds are, against the main deck’s.',
  },
  storybookHighPace: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.01,
    default: 1.6,
    category: 'Storybook · Layers',
    label: 'High deck pace',
    help: 'How fast the high deck drifts and changes, against the main deck (high cloud usually runs faster).',
  },
  storybookHighAmount: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.6,
    category: 'Storybook · Layers',
    label: 'High deck amount',
    help: 'How much high cloud there is. It grows with Cloud cover: at Amount 1 it matches the main deck at full cover; 0 = no high deck.',
  },
  storybookHighOpacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Storybook · Layers',
    label: 'High deck opacity',
    help: 'How solid the high deck reads — lower lets the decks below show through it. 0 = off.',
  },
  storybookHighShear: {
    type: 'float',
    min: -90,
    max: 90,
    step: 1,
    default: 18,
    category: 'Storybook · Layers',
    label: 'High deck wind turn',
    help: 'How many degrees the high deck’s drift turns from the main wind.',
  },
});

/** The schema defaults as a flat object — mirrors `cloudLookDefaults`'s own
 * shape for parity, unused today (no presets ship). */
const CLOUD_TOPS_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(CLOUD_TOPS_PARAMS).map(([k, decl]) => [k, decl.default]))
);

/**
 * @returns {Record<string, number>}
 */
export function cloudTopsDefaults() {
  return { ...CLOUD_TOPS_DEFAULTS };
}

/**
 * The manifest — Effects.md §2 shape. `id: 'cloudTops'` is load-bearing: the
 * Studio card and the diagnostic-report door both key off this exact id.
 *
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const CLOUD_TOPS = Object.freeze({
  id: 'cloudTops',
  title: 'Cloud Tops',
  // Only ever visible once genuinely zoomed out AND only outdoors-adjacent
  // (the sky) — weighted below CLOUD_LOOK's 0.6 (that layer's shadow/mood is
  // always-on outdoors at any zoom; this is a situational, zoomed-out view).
  visualWeight: 0.35,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'standard',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: 'Pure ALU TSL graph (the same cloud field, lit) drawn on one lazily-built quad — no lazy target, no asset, no bake, same posture clouds.js/depth-of-field.js already take. The first draw compiles one pipeline, covered by the global pipeline-growth criterion.',
  }),
  params: CLOUD_TOPS_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'lit-tops-single-deck',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.6 }),
      adds:
        'the weather deck drawn from above, zoom-gated (fails asleep below the gate — Effects.md Law 4, no ' +
        'mesh submitted, not just alpha 0), with the physical "rising through the decks" parallax (doc 02 §9): ' +
        'wrap lighting, self-shadow march, Beer/powder, silver lining, ambient fill, surface grain and the ' +
        'highlight roll-off, all from cloud-shade.js#buildCloudTopsNode — reading the SAME field/recipe/drift ' +
        "phase the ground shadow already resolves each frame, so the tops are provably the ground shadow's own " +
        'shape, lit, never a second cloud layer that could disagree with it.',
    }),
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0).
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'second-deck',
      note:
        'the high veil/anvil deck (doc 02 §6: 2x altitude, faster/rotated drift, brighter+flatter, ~0.25x ' +
        'relief, drawn over and not shadowing the first) — doc 03 build order places this at slice E, after ' +
        'slice D (this tier). Deliberately out of scope for the same reason: two decks roughly doubles the ' +
        'cost of an already-C8 draw, and the single-deck picture has not been seen in a real scene yet.',
    }),
    Object.freeze({
      name: 'cloud-on-cloud-shadowing',
      note: 'doc 02 §6: the upper deck does not shadow the lower one. Named in the design as an explicit deferred rung, not an oversight.',
    }),
  ]),
});
