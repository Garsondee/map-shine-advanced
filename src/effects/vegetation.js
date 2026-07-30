/**
 * VEGETATION — `_Tree` and `_Bush`, ONE effect, driven by the shared wind field.
 *
 * THIS FILE IS THE DECLARATION (params schema + manifest + the kinds table) —
 * the data the registry, the settings cascade and the (future) governor read.
 * Zero imports, matching `effects/candle-flame.js`'s own posture: a
 * declaration is backend-agnostic data, not code that touches THREE or the
 * mask catalog. The runtime (detection, geometry, materials) lives in
 * `effects/vegetation-render.js` (pure, Node-tested) and `vt/vt-pan-viewer.js`
 * (THREE/TSL glue) — see `docs/planning/Vegetation.md` for the full design and
 * `docs/planning/Wind.md` §5.1 for the wind handle this reads.
 *
 * ============================================================================
 * WHY TREE AND BUSH ARE ONE EFFECT, NOT TWO
 * ============================================================================
 *
 * V2 shipped `TreeEffectV2.js` (2,833 lines) and `BushEffectV2.js` (2,362) —
 * measured, not remembered — and they are the SAME FILE TWICE: identical
 * `populate()`, identical shadow model, identical uniform blocks. The real
 * differences were ~40 default numbers. Here, "tree" and "bush" are two
 * entries in {@link VEGETATION_KINDS} — a mask kind id plus a handful of
 * code-level tuning constants (never authored, never a param — the same
 * posture V2's own per-file Z-offset constants had, just no longer forking
 * the FILE to do it). Adding a third kind (`_Grass`, `_Crop`) is one catalog
 * line (`scene/mask-catalog.js`) plus one entry here — the velocity test
 * `Skeleton.md` law 2 names: a declaration must be FASTER than hand-rolling a
 * new effect, or the abstraction has already lost.
 *
 * ============================================================================
 * WHAT V2's WIND GOT WRONG, AND WHY THIS EFFECT NEEDS NONE OF ITS OWN
 * ============================================================================
 *
 * V2 read exactly two numbers for wind — one global speed scalar, one global
 * direction — and invented ~8 "response curve" params per effect
 * (`flutterWindStart`/`bendWindFull`/etc.) purely to hand-fake the spatial
 * variation a global scalar cannot have: a tree in a sealed courtyard swayed
 * identically to one on an open moor. This effect has no wind math of its
 * own at all — every sway sample goes through `world/wind-access.js`'s
 * handle (`handle.node()`, Wind.md §5.1), which already knows about walls,
 * doors, openness and turbulence. `windResponse` below is the ONLY dial —
 * the same per-effect gain shape `effects/candle-flame.js`'s own
 * `windResponse` uses (Wind.md §8.1).
 *
 * @module effects/vegetation
 */

/**
 * The KINDS table — structural differences between vegetation kinds,
 * expressed as plain data, never as a second copy of the runtime. Every
 * field here is a code-level constant (tuned by eye, like V2's own per-file
 * Z-offsets), NOT an authored param — the three params below (`windResponse`/
 * `swayAmount`/`intensity`) are shared by every kind a scene has; a kind only
 * changes how strongly ITS OWN default response reads.
 *
 * @typedef {object} VegetationKind
 * @property {string} id - 'tree' | 'bush' — also this kind's own settings-key fragment.
 * @property {string} maskKindId - the `scene/mask-catalog.js` kind id this
 *   reads (`maskKindById(maskKindId)` — the ONLY door to suffix knowledge;
 *   `masks/authority-only` forbids spelling `_Tree`/`_Bush` anywhere outside
 *   that catalog, including here).
 * @property {string} label - human-facing name for generated UI.
 * @property {number} swayMultiplier - a fixed per-kind gain on the shared
 *   `swayAmount` param — trees carry more canopy mass higher off the ground
 *   than a bush at the same wind strength, so they read as swaying FURTHER
 *   at an identical `swayAmount` setting (V2's own Tree/Bush defaults had
 *   this same relative relationship, `bulkSway: 0.029` vs `0.013`). Applied
 *   multiplicatively; 1.0 would mean "no per-kind difference at all".
 * @property {number} renderOrderNudge - added to the owning item's own
 *   `renderOrder` (a plain JS number, no integer constraint) so a kind's
 *   overlay draws in a stable order relative to a SECOND kind's overlay on
 *   the same item (a background painted with both `_Tree` and `_Bush`) —
 *   canopy above undergrowth. Irrelevant when only one kind is present.
 * @property {number} shadowHeightPx - HOW HIGH THIS KIND SITS ABOVE THE
 *   GROUND, in world px. The author's own shadow brief (2026-07-23) asked for
 *   exactly this and nothing more: *"only different offsets and the ability to
 *   simulate different heights from the ground (which will have a separate
 *   impact on shadow sharpness)"*. ONE honest physical number, from which
 *   `effects/shadow-access.js` derives BOTH how far the shadow is thrown AND
 *   how soft its edge is — so a tree gets a long, diffuse shadow and a bush a
 *   short, crisp one WITHOUT either declaring an offset slider or a softness
 *   slider. That is the whole cure for V2's per-aspect slider explosion,
 *   expressed as data.
 * @property {number} flutterSpaceFreq - world→noise scale for this kind's leaf
 *   flutter (see `world/wind-field.js#curlNoise2D`). Larger = finer chatter. A
 *   bush's small leaves shimmer at a finer scale than a tree canopy's masses.
 *
 * @type {ReadonlyArray<VegetationKind>}
 */
export const VEGETATION_KINDS = Object.freeze([
  Object.freeze({
    id: 'tree',
    maskKindId: 'tree',
    label: 'Tree canopy',
    swayMultiplier: 1.3,
    renderOrderNudge: 0.6,
    // A canopy sits well above head height — long, soft shadow.
    shadowHeightPx: 70,
    flutterSpaceFreq: 0.035,
  }),
  Object.freeze({
    id: 'bush',
    maskKindId: 'bush',
    label: 'Bush foliage',
    swayMultiplier: 0.8,
    renderOrderNudge: 0.5,
    // Waist-high — a tight, comparatively crisp shadow hugging its own base.
    shadowHeightPx: 16,
    flutterSpaceFreq: 0.06,
  }),
]);

/**
 * The authorable LOOK + MOTION knobs (validated by `core/params-schema.js`),
 * shared by every vegetation source in the scene — one dial set for however
 * many trees/bushes are present, matching `CANDLE_FLAME_PARAMS`'s own
 * "one knob set, many instances" shape.
 *
 * ============================================================================
 * WHY THIS GREW FROM 5 PARAMS TO 18 (2026-07-23, SAME DAY AS TIER 2)
 * ============================================================================
 *
 * Tier 2 shipped sway/flutter/shadow with the internal tuning — sway curve,
 * gale gains, flutter rate, clump spread — living as CODE CONSTANTS in
 * `vt-pan-viewer.js#buildVegetationMaterial`, deliberately minimal (Tier-1-
 * honest: only what a scene author would plausibly want to touch). The
 * author's own follow-up reversed that call directly: *"Currently distortions
 * are very very strong. I need controls over frequency, evolution rate,
 * amplitude and things like that, the more controls the better."* So every
 * one of those constants is now a live param — every `VEG_*` name that used
 * to live in `vt-pan-viewer.js` now has a matching entry below, wired as a
 * genuinely live uniform (`syncVegetationMotionUniforms`), not merely baked
 * in at mesh construction. This is NOT the V2 slider-explosion this project
 * otherwise guards against (`feedback_v3_code_cleanliness_standard` /
 * `v2-postmortem`): it is still ONE shared set for both kinds (V2 had ~50 PER
 * KIND, two near-identical files), every knob maps to a real, distinct effect
 * (none are decorative padding), and it was asked for by name, not
 * defaulted-into out of habit.
 *
 * Several defaults also moved DOWN in this same pass — `swayAmount`,
 * `flutterAmount`, and the new `galeBendAmount`/`galeRateGain`/
 * `flutterGaleFrequency` — because the complaint was about the CURRENT shipped
 * look (Tier 2's constants), not merely about the absence of controls. Having
 * live knobs now means a wrong guess here costs the author one slider drag,
 * not a rebuild — but they still deserve to open the panel to something
 * closer to right.
 *
 * `edgeFadeWidthPx` (18th) landed the SAME day, one live-test round later,
 * alongside a set of NON-authored internal safety terms (hard displacement
 * caps + asymmetric gale damping on flutter, all in `vt-pan-viewer.js` —
 * "at gale strength the trees can self intersect... a distorted dissolved
 * blob") reverse-engineered from the OLD V2 vegetation shader, which never
 * exhibited that failure. Those caps are deliberately NOT params, matching
 * V2's own posture: they are structural "never exceed" backstops, not
 * creative dials — see `vt-pan-viewer.js`'s own `VEG_MAX_LOCAL_SPEED`/
 * `VEG_MAX_DISPLACE_PX`/`VEG_FLUTTER_UV_CAP`/`VEG_FLUTTER_GALE_DAMP_*`.
 *
 * @type {Record<string, object>}
 */
export const VEGETATION_PARAMS = Object.freeze({
  intensity: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1.0,
    category: 'Look',
    label: 'Intensity',
    help: 'Master visibility of the canopy/foliage layer (alpha gain). 0 hides it entirely without disabling the effect.',
  },
  // WIND RESPONSE (Wind.md §8.1) — the SAME per-effect gain shape
  // `effects/candle-flame.js`'s own `windResponse` uses: one honest dial over
  // everything the shared wind field can move here. 0 = a plant wind cannot
  // touch (e.g. a warded grove); 1 = the tuned default; 2 = twice as dramatic.
  windResponse: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Wind response',
    help: 'How much this vegetation reacts to the shared wind field — sealed rooms and courtyards stay nearly still by construction; open ground catches the full gust. 0 = wind cannot touch it; 2 = twice as dramatic as the tuned default.',
  },
  swayAmount: {
    type: 'float',
    min: 0,
    max: 120,
    step: 1,
    // Was 20 — turned down alongside the internal gale terms below (see this
    // file's own "WHY THIS GREW" note): "distortions are very very strong".
    default: 14,
    category: 'Motion',
    label: 'Sway amount',
    help: 'World-pixel displacement at the canopy top under a full-strength wind sample (before the per-kind multiplier and Wind response). The root of the mesh never moves; the top moves this far.',
  },
  swayFrequency: {
    type: 'float',
    min: 0.05,
    max: 3,
    step: 0.01,
    default: 0.45,
    category: 'Motion',
    label: 'Sway frequency',
    help: 'How fast the canopy oscillates back and forth at dead calm, roughly in cycles per second. Rises further with wind strength — see Gale rate gain.',
  },
  swayCurve: {
    type: 'float',
    min: 0.5,
    max: 3,
    step: 0.05,
    default: 1.3,
    category: 'Motion',
    label: 'Sway response curve',
    help: 'Shapes how sway amplitude grows with local wind strength. 1 = proportional; higher makes a strong gust swing disproportionately further than a gentle breeze would suggest.',
  },
  galeBendAmount: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    // Was 1.6 — the single biggest contributor to "very very strong" at
    // gale, since it stacks additively with the oscillating sway below.
    default: 1.0,
    category: 'Motion',
    label: 'Gale lean',
    help: 'How far the canopy holds a persistent downwind lean at full gale, relative to its own oscillating swing. 0 = it only oscillates about neutral and never bends over.',
  },
  galeRateGain: {
    type: 'float',
    min: 0,
    max: 6,
    step: 0.05,
    default: 1.6,
    category: 'Motion',
    label: 'Gale rate gain',
    help: 'Extra oscillation speed at full gale, as a multiple of the calm-wind frequency above — the difference between a gale that thrashes and one that just swings wider.',
  },
  // LEAF FLUTTER (2026-07-23, author: "there needs to be mass preserving
  // distortions to give leaves a flutter which increases as the wind speed
  // increases"). Was ONE knob; the same-day follow-up asked for the family
  // below instead — flutterAmount stays the simple "how pronounced" dial,
  // the rest are the direct frequency/amplitude/grain controls requested.
  flutterAmount: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    // Was 1 — flutter's amplitude scales up to ~5x between calm and gale
    // (see flutterGaleFrequency below), so this needed to come down further
    // than sway did to land at a comparable "very strong" complaint.
    default: 0.55,
    category: 'Motion',
    label: 'Leaf flutter',
    help: 'How much individual leaves shimmer and shuffle in the wind, on top of the whole-plant sway. Still at dead calm, more pronounced in a gale. The distortion preserves area, so foliage never visibly stretches or thins — it just moves. 0 = a perfectly rigid plant.',
  },
  flutterFrequency: {
    type: 'float',
    min: 0,
    max: 8,
    step: 0.1,
    default: 1.6,
    category: 'Motion',
    label: 'Flutter frequency',
    help: 'How fast the leaf-shimmer pattern evolves at dead calm.',
  },
  flutterGaleFrequency: {
    type: 'float',
    min: 0,
    max: 15,
    step: 0.1,
    // Was 7 (giving up to ~5.4x the calm rate's worth of amplitude at full
    // gale) — turned down alongside swayAmount/galeBendAmount above.
    default: 4.0,
    category: 'Motion',
    label: 'Flutter frequency (gale)',
    help: 'EXTRA evolution speed added to the flutter pattern at full gale, on top of the calm-wind frequency above.',
  },
  flutterUvScale: {
    type: 'float',
    min: 0,
    max: 0.05,
    step: 0.001,
    default: 0.007,
    category: 'Motion',
    label: 'Flutter base amplitude',
    help: 'Raw texture-space displacement at full flutter strength, before the Leaf flutter dial above multiplies it. Small — this moves leaves, not branches.',
  },
  flutterScale: {
    type: 'float',
    min: 0.2,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Extent',
    label: 'Flutter grain size',
    help: "Scales how fine or coarse the leaf-shimmer pattern reads, relative to each kind's own default. Higher = finer, more granular chatter; lower = broader, slower-looking movement.",
  },
  clumpSizePx: {
    type: 'float',
    min: 20,
    max: 600,
    step: 5,
    default: 150,
    category: 'Extent',
    label: 'Clump size (px)',
    help: 'World-pixel size of one independently-swaying region — roughly one plant. Smaller = more, finer-grained variation between neighbours; larger = broad stands moving together.',
  },
  clumpPhaseSpread: {
    type: 'float',
    min: 0,
    max: 12,
    step: 0.1,
    default: 4.0,
    category: 'Motion',
    label: 'Clump phase spread',
    help: "Timing offset, in seconds, between neighbouring clumps' sway — the main cure for everything swaying in lockstep. 0 = every clump swings perfectly in sync.",
  },
  clumpAmpSpread: {
    type: 'float',
    min: 0,
    max: 0.9,
    step: 0.01,
    default: 0.3,
    category: 'Motion',
    label: 'Clump strength spread',
    help: "How much stronger or weaker one clump's sway is than its neighbour's, as a fraction either way. 0 = every clump sways with identical strength.",
  },
  clumpDirSpread: {
    type: 'float',
    min: 0,
    max: 60,
    step: 1,
    default: 20,
    category: 'Motion',
    label: 'Clump direction spread',
    help: "How far one clump's lean direction can rotate from its neighbour's, in degrees, so a stand never reads as one rigid sheet. 0 = every clump leans exactly the same way.",
  },
  // EDGE-FADE PINNING (2026-07-23, SAME live-test round, author: "pin the
  // edges to the edge of the map by having a fading zone which lowers the
  // amount of movement/distortion as it approaches the scene edge"). Mirrors
  // V2's own `vegetationSceneEdgeFade` (legacy/compositor-v2/effects/
  // vegetation-bulk-wind.js) — measured from the REAL scene bounds, not the
  // mesh's own placement, so a canopy tile sitting right at the boundary
  // pins there too. 0 = no pinning at all (the pre-existing behaviour).
  edgeFadeWidthPx: {
    type: 'float',
    min: 0,
    max: 2000,
    step: 10,
    default: 200,
    category: 'Extent',
    label: 'Edge fade width (px)',
    help: 'How close to the scene edge sway/flutter starts fading out, in world pixels. 0 = no pinning at all — motion reaches all the way to the boundary.',
  },
  // SHADOW — deliberately the ONLY shadow knob (author, 2026-07-23: "the old
  // V2 had a separate slider for every different aspect of scene shadows and
  // we don't need that"). Offset, softness, direction, dawn elongation, cloud
  // diffusion and night fading are ALL derived — from this kind's own
  // `shadowHeightPx` and the shared sky (`effects/shadow-access.js`). Nothing
  // here, and nothing on a future caster, re-declares any of them. Category
  // 'Look' (not the earlier ad hoc 'Shadow', which isn't one of `diag/
  // effect-controls.js`'s fixed categories and was silently landing in
  // Technical) — matches `ui-window-shadow.js`'s own `strength01` precedent.
  shadowStrength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.45,
    category: 'Look',
    label: 'Shadow strength',
    help: 'How dark the shadow cast on the ground is under a clear midday sky. Everything else about it — length, direction, softness — follows the sun and the weather automatically, and trees cast longer, softer shadows than bushes because they are taller. 0 = casts no shadow.',
  },
});

/**
 * The manifest — the effect as data (Effects.md §2 shape). `enabledFromProfile:
 * 'low'` matches `CANDLE_FLAME`'s own reasoning: a handful of swaying overlays
 * is cheap (one wind sample per MESH, never per fragment — see
 * `docs/planning/Vegetation.md` §7's own cost constraint), and the author
 * wants to SEE it working now (`feedback_default_on_new_features`).
 *
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const VEGETATION = Object.freeze({
  id: 'vegetation',
  title: 'Vegetation (trees & bushes)',
  visualWeight: 0.6,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  params: VEGETATION_PARAMS,
  // HOW YOU ADD IT TO A MAP — the ＋ in this effect's card header opens the
  // brush already loaded with this mask (validateAuthoring, effect-manifest.js).
  authoring: Object.freeze({ paint: ['tree', 'bush'] }),
  // ============================================================================
  // THE LADDER — BUILT 2026-07-29, one rung per PERFORMANCE_PROFILES entry.
  // ============================================================================
  //
  // Until this pass every profile got the IDENTICAL effect — one rung, declared
  // unconditional. That was honest (nothing above tier 0 existed), but it also
  // meant the effect's two genuinely expensive parts — the per-fragment leaf
  // flutter and the ground shadow's multi-tap smear — ran full-strength on every
  // machine regardless of profile, which is exactly the `feedback_unconsumed_
  // api_rots_silently` shape this project keeps re-discovering: a ladder with
  // nowhere to climb is not a ladder.
  //
  // Both costs are real and measured (docs/planning/Performance-Insights.md §4):
  // the flutter is a curl-noise UV shuffle plus a second full wind-field sample,
  // per fragment, wherever the coarse-mip presence gate finds foliage; the ground
  // shadow is a SECOND full mesh per (item × kind) — a padded, alpha-blended
  // overlay that a weak machine pays draw-call and fill cost for whether or not
  // its multi-station smear resolves as anything more than a blur.
  //
  // Ordered by COST CLASS (Law 3), each rung maps to a row of
  // `VEGETATION_TIER_PLANS` (vegetation-render.js) — the prose here, the
  // arithmetic there, index-aligned, exactly like the candle ladder's own split.
  //
  // 🔒 Tier 3 == today's shipped behaviour exactly (flutter on, shadow at its
  // original 6-station smear), and the default `standard` profile resolves to
  // tier 3 — switching this system on restyles nothing for anyone who has never
  // touched the performance profile setting. Below `standard` the picture
  // genuinely simplifies (no shadow below `performance`, no flutter below
  // `low`); above it the shadow's smear gets progressively finer, ending at
  // `extreme` — which is also this ladder's RESERVED SLOT: a future rung that
  // should only ever run on the top profile (self-shadowing and true per-plant
  // clump differentiation, both already named in `deferredRungs` below) extends
  // tier 5 in place rather than requiring the ladder to be renumbered.
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'placed-and-swaying',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.05 }),
      adds:
        'correct-placement canopy/foliage overlays (both a tile whose OWN texture IS the mask, and a ' +
        'plain albedo with a discovered sibling mask file) with real wind-driven sway — one wind ' +
        'sample per mesh, at its own world position, so a walled courtyard reads calmer than open ' +
        'ground without any authored setup. The floor: never a static decal, never gated away.',
    }),
    Object.freeze({
      n: 1,
      name: 'shimmer',
      fromProfile: 'low',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.02 }),
      adds:
        'leaves individually shimmer and shuffle in the wind — a per-fragment curl-noise UV shuffle, ' +
        'already gated to only the pixels with foliage on them, so its true cost is far below a naive ' +
        'per-pixel estimate. Below this rung the canopy sways as one coherent mass with no per-leaf detail.',
    }),
    Object.freeze({
      n: 2,
      name: 'shadow-coarse',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.08 }),
      adds:
        'the canopy casts a ground shadow that follows the sun — a coarse 3-station smear, enough to ' +
        'read as a real shadow, with visible banding on the longest dawn/dusk throws. The first rung to ' +
        'pay for a second mesh (extra draw call, extra overdraw), which is why it waits until here.',
    }),
    Object.freeze({
      n: 3,
      name: 'shadow-smooth',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.12 }),
      adds:
        "the shadow's smear reaches its ORIGINAL shipped resolution (6 stations) — the banding above is " +
        'gone at any sun angle this scene can produce. Nobody who has not touched the performance ' +
        'profile sees anything different from before this ladder existed.',
    }),
    Object.freeze({
      n: 4,
      name: 'shadow-finer',
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.16 }),
      adds:
        'the shadow smear gets finer still (9 stations) — a visibly smoother streak on the longest ' +
        'dawn/dusk throws, for machines with room to spare.',
    }),
    Object.freeze({
      n: 5,
      name: 'shadow-finest',
      fromProfile: 'extreme',
      cost: Object.freeze({ class: 'C8', estMsPerMp: 0.2 }),
      adds:
        'the finest shadow smear this effect draws (12 stations). Also the reserved top rung: the next ' +
        'extreme-only addition to this effect (self-shadow, true clump differentiation — see ' +
        'deferredRungs) extends this rung rather than needing a new one appended.',
    }),
  ]),
  // Recorded, NOT built — honest rungs (Effects.md §0), matching
  // `Vegetation.md`'s own tier ladder. NONE of these are silently dropped —
  // each is a named, deliberate scope boundary for THIS pass.
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'true-clump-differentiation',
      note:
        "connected-component islands within ONE texture (V2's one genuinely good idea) so each ACTUAL " +
        'plant sways as one rigid body with its own anchor, via CPU analysis of the mask coarse pin ' +
        "(scene/mask-derive.js's per-page extraction is the right foundation). PARTLY SUPERSEDED " +
        '2026-07-23: tessellation + world-cell hashing already gives per-region phase/amplitude/' +
        'direction variation with no CPU analysis, which was the visible half of the problem. What ' +
        'remains is that a single plant can still shear slightly across a cell boundary.',
    }),
    Object.freeze({
      name: 'spring-response',
      note:
        'a critically-damped spring per swaying region so foliage lags the wind and overshoots on ' +
        'release, instead of tracking it instantaneously. The persistent-bend term added 2026-07-23 ' +
        'gives the STEADY-state half of this (a canopy that stays bent in a gale); a real spring ' +
        'would add the TRANSIENT half (the whip when a gust arrives or drops).',
    }),
    Object.freeze({
      name: 'self-shadow',
      note:
        'foliage shadowing ITSELF — an offset, blurred re-sample of the mask against its own canopy, ' +
        'giving interior depth. Distinct from the ground shadow (built 2026-07-23), which is the ' +
        'plant darkening the terrain beneath it.',
    }),
    Object.freeze({
      name: 'shared-shadow-casters',
      note:
        'effects/shadow-access.js is built as a GENERAL caster API (any caster declares only a height ' +
        'and an offset scale); vegetation is currently its only consumer. Tokens, walls and structures ' +
        'adopting it is the point of the abstraction, not yet done.',
    }),
    Object.freeze({
      name: 'live-disable-for-self-vegetation-tiles',
      note:
        "a self-vegetation tile's material choice is made ONCE, at first load (vt-pan-viewer.js#" +
        'ensureWholeImageMeshes is idempotent forever) — toggling this effect off after such a tile ' +
        'already loaded does not stop it swaying until the next scene load. The SAME accepted tradeoff ' +
        "Wind.md §8/§9 already documents for the candle flame's own material; a discovered-sibling-mask " +
        'OVERLAY (the other attachment mode) does not have this gap — it hides immediately on disable, ' +
        'since an overlay has no non-vegetation content to fall back to showing.',
    }),
  ]),
});
