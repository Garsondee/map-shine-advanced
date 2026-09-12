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
    default: 1,
    category: 'Look',
    label: 'Zoom sensitivity',
    help: "How readily the tops appear as the camera zooms out — a multiplier on the camera's own virtual eye height. 1 is this feature's own derived starting point (tied to the old V2 cloud effect's shipped zoom thresholds); above 1 makes the tops appear sooner (at a less zoomed-out view); below 1 makes them wait for a wider view before appearing. Never affects the ground shadow, which draws at every zoom.",
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
