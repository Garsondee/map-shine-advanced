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
    default: 0.8,
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
    default: 0.79,
    category: 'Look',
    label: 'Zoom sensitivity',
    help: "How readily the tops appear as the camera zooms out — a multiplier on the camera's own virtual eye height. 1 is this feature's own derived starting point (tied to the old V2 cloud effect's shipped zoom thresholds); above 1 makes the tops appear sooner (at a less zoomed-out view); below 1 makes them wait for a wider view before appearing. Never affects the ground shadow, which draws at every zoom.",
  },
  // ── Storybook (2026-11-03) — the dials of effects/clouds/storybook-clouds.js. Defaults mirror that file's
  // STORYBOOK_DECK_DEFAULTS (a test holds them equal). Used only while the Clouds card's style is Storybook.
  storybookSpacing: {
    type: 'float',
    min: 0.15,
    max: 1.5,
    step: 0.01,
    default: 0.48,
    category: 'Storybook',
    label: 'Cloud spacing',
    help: "How far apart clouds can be, as a fraction of the map's shorter side. Each cloud lives in its own square of a drifting grid, so there is always sky between neighbours; bigger spacing = fewer, bigger clouds. Cloud cover decides how many squares hold a cloud.",
  },
  storybookSize: {
    type: 'float',
    min: 0.25,
    max: 1.5,
    step: 0.01,
    default: 1.15,
    category: 'Storybook',
    label: 'Cloud size',
    help: 'How big each cloud is inside its square. Past about 1.15 the clouds hit the size their square allows and stop growing (raise Cloud spacing for bigger ones).',
  },
  storybookHeight: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.01,
    default: 0.12,
    category: 'Storybook',
    label: 'Deck height',
    help: "How high the clouds hang, as a fraction of the camera's height above the table. Higher = they look closer to you: bigger, and sliding more against the map as you pan (real parallax — the clouds are drawn in 3-D).",
  },
  storybookBulge: {
    type: 'float',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 0.5,
    category: 'Storybook',
    label: 'Dome bulge',
    help: 'How much the cloud layer arches over the table like a dome — high over the middle of the map and sinking past its edges, with a fisheye swell in the middle of the view. 0 = a flat deck.',
  },
  storybookDomain: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.55,
    category: 'Storybook',
    label: 'Reach past the map',
    help: "With the Table on, how far past the map's edge clouds still drift (a fraction of the map's shorter side) before shrinking away. Without the Table clouds stay over the map itself.",
  },
  storybookLine: {
    type: 'float',
    min: 0,
    max: 8,
    step: 0.1,
    default: 2.4,
    category: 'Storybook',
    label: 'Ink line width',
    help: 'Outline thickness in screen pixels — the same at every zoom, like an inked drawing.',
  },
  storybookInk: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.65,
    category: 'Storybook',
    label: 'Ink strength',
    help: 'How dark the outlines and the creases between billows are. 0 = no ink at all (soft painted clouds).',
  },
  storybookRim: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.45,
    category: 'Storybook',
    label: 'Silver lining',
    help: 'The thin light band painted just inside the outline on the side facing the light.',
  },
  storybookBands: {
    type: 'float',
    min: 0.002,
    max: 0.3,
    step: 0.001,
    default: 0.07,
    category: 'Storybook',
    label: 'Tone softness',
    help: 'How soft the step is between the three painted tones (light, body, shadow). Low = crisp cel shading; high = soft and airbrushed.',
  },
  storybookBrush: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Storybook',
    label: 'Brush texture',
    help: 'How much the tone edges wobble like brush strokes, plus the fine paper grain. 0 = clean vector shading.',
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
