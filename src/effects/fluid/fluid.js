/**
 * FLUID — the declaration (manifest + params schema), pure data, no THREE.
 * Goo in thin glass tubes, seen from above. `docs/planning/Fluid.md` is the
 * design; this file is its Node-validatable half. The TSL builders live in
 * sibling render modules with THREE injected and never imported, exactly as
 * water/bloom/candle split.
 *
 * ============================================================================
 * WHAT EXISTS TODAY (Phase 3) — read this before trusting the manifest
 * ============================================================================
 *
 * Tiers 0–3 RENDER: `fluid-net.js` extracts the tube net, `fluid-pack.js` bakes
 * it, `fluid-surface-subsystem.js` owns the whole chain and the mesh,
 * `fluid-render.js` draws the ADD half of the two-blend split, and
 * `fluid-registration.js` gives it a card and a console setter. The four
 * `tiers` entries below are real code.
 *
 * **Still NOT built, so the manifest must not be read as claiming them:** the
 * MULTIPLY half (absorption under the map art — `Fluid.md` §5.6), the 1-D sim
 * (§5.3; the slugs today are the PRESCRIBE mode, an analytic scroll), bubbles,
 * optics, emission-as-a-light and spray. Those are the `deferredRungs` below,
 * named and ordered, and none of them has a line of code.
 *
 * @module effects/fluid/fluid
 */

/**
 * The look knobs. Every key here is read by `effects/fluid/fluid-render.js`,
 * whose exported defaults are the single source of truth for the VALUES — a
 * change lands in both places or in neither.
 *
 * They arrived in Phase 3, the same phase as the surface that consumes them,
 * never ahead of it. That ordering is what `params/no-dead-controls` enforces
 * and what V2's water failed: 46 uniforms behind live sliders with no
 * implementing GLSL, including a fully-labelled folder that did nothing.
 */
export const FLUID_PARAMS = Object.freeze({
  // ── Look ────────────────────────────────────────────────────────────────
  tint: {
    type: 'color',
    space: 'srgb',
    default: '#26f2b3',
    category: 'Look',
    label: 'Goo colour',
    help: 'The base colour of the fluid. Pushed into HDR by Glow, so a saturated colour here reads as a lit, glowing liquid rather than as paint. The iridescent film shifts it around this base rather than replacing it.',
  },
  glow: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1.6,
    category: 'Look',
    label: 'Glow',
    help: 'How brightly the goo burns. Above about 1 it starts to bloom, which is where the "magic" reading comes from — turn it down for a mundane liquid in a plain glass tube, up for something you would not want to drink.',
  },
  iridescence: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.8,
    category: 'Look',
    label: 'Sheen',
    help: 'An oil-on-water rainbow across the fluid. It is driven by the real thickness of liquid the light passes through, so it bands across the tube and shifts at the front of every slug rather than drifting independently. At 0 the goo is a flat colour.',
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Look',
    label: 'Strength',
    help: 'Overall strength of the whole effect. The quick way to dial it back without retuning everything else.',
  },
  // ── Motion ──────────────────────────────────────────────────────────────
  speedPx: {
    type: 'float',
    min: 0,
    max: 400,
    step: 5,
    default: 90,
    category: 'Motion',
    label: 'Flow speed',
    help: 'How fast the goo travels along its tube. 0 stops it dead, which is useful for a dormant apparatus. Direction is decided by the mask: the goo flows away from the BRIGHTEST end of each tube.',
  },
  slugCount: {
    type: 'float',
    min: 1,
    max: 24,
    step: 0.5,
    default: 6,
    category: 'Motion',
    label: 'Blobs per tube',
    help: 'How many separate blobs of liquid are in flight down one tube at a time. Low numbers read as slow, deliberate pulses; high numbers as a fast, busy circulation.',
  },
  slugWidth: {
    type: 'float',
    min: 0.05,
    max: 0.95,
    step: 0.01,
    default: 0.55,
    category: 'Motion',
    label: 'Blob length',
    help: 'How much of each blob-and-gap cycle is liquid. Near 1 the tube is almost continuously full with small breaks; near 0 you get short darts with long empty stretches between them.',
  },
});

/**
 * The manifest — the effect as data (`Effects.md` §2 shape).
 *
 * `visualWeight: 0.3` — deliberately LOW, and the brief is the reason: the
 * author called this *"never integral to the gameplay, just a decoration"*.
 * Under budget pressure this should be given up early and without ceremony,
 * which is precisely what a low weight means to the governor. Water is 0.8
 * because a river is a landscape focal feature; a bubbling tube in the corner
 * of an alchemist's lab is not.
 *
 * `enabledFromProfile: 'low'` — on everywhere by default
 * (`feedback_default_on_new_features`). Tier 0 is one mask read and a tint; a
 * machine that cannot afford that cannot afford the map.
 *
 * `a11y.photosensitive: false` — TRUE FOR TIER 0 AND ONLY TIER 0, which is a
 * static tinted mask read with no flicker of any kind. ⚠️ REVISIT AT TIER 2:
 * that rung adds emission, and the pump's gulp events (`Fluid.md` §6) are
 * discrete brightness changes by design. V2's own shipped default ran a
 * `sin(t · 1.15 · 4.7)` shimmer — roughly 5.4 Hz, inside the 3–30 Hz band the
 * photosensitive guidance is about. Low-contrast shimmer is not a strobe (bloom
 * makes the same call in its own header), but the judgement must be made
 * against real emission amplitudes when they exist, not inherited from here.
 * The design rule that keeps this honest: **the pump modulates flow, and
 * brightness follows flow smoothly — a gulp must never be a brightness step.**
 *
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const FLUID = Object.freeze({
  id: 'fluid',
  title: 'Fluid',
  visualWeight: 0.3,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  params: FLUID_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'placement',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.05 }),
      adds:
        // The suffix literal itself belongs in scene/mask-catalog.js and nowhere
        // else (`masks/authority-only`, which caught this line in prose form on
        // the first run — the wall does not distinguish a comment from a lookup,
        // and it is right not to: V2's suffix knowledge spread by exactly this
        // kind of harmless-looking copy). The kind is `fluid`; the catalog owns
        // what file that means.
        'The fluid mask, tinted and emissive, in the right place on the right floor. The tube has ' +
        'glowing goo in it. Never gated.',
    }),
    Object.freeze({
      n: 1,
      name: 'tube',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.01 }),
      adds:
        'Cross-section from the pack`s `across`: optical path length sqrt(1-across^2), longest down ' +
        'the centreline and zero at the glass, plus the wall rim. Pure ALU on a read tier 0 already ' +
        'paid for. THIS is the rung where a tube stops reading as a painted line — V2 could not ' +
        'express it at all, because everything it drew was a function of arc length alone.',
    }),
    Object.freeze({
      n: 2,
      name: 'flow',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.04 }),
      adds:
        'The pack read: slugs scrolling in GEODESIC arc length (so speed means the same thing on a ' +
        'long tube and a short one, unlike V2`s hand-painted ramp), and the meniscus driven by where ' +
        'the fill CHANGES along the tube — the right axis, where V2`s was a function of distance to ' +
        'the WALL and defaulted to 0 because it could never have looked right.',
    }),
    Object.freeze({
      n: 3,
      name: 'film',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.01 }),
      adds:
        'Thin-film iridescence driven by that same optical thickness, so the rainbow bands across ' +
        'the cross-section and shifts at every slug front instead of being an unrelated noise field. ' +
        'V2 spent 13 parameters here; grounding it in a real thickness leaves 1.',
    }),
  ]),
  /**
   * Recorded, NOT built — the honest rungs (`Effects.md` §0), matching
   * `Fluid.md` §7's ladder in full. Each becomes a real `tiers` entry, with its
   * own cost class and its own phase's render code, in build order. The full
   * ladder is `C4 → C1 → C1 → C2 → C4 → C4 → C5 → C6 → C8`.
   */
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'structure',
      note:
        'C2. One resident tiling noise fetch in the MATERIAL COORDINATE τ (analytic at this rung: ' +
        'τ = s − v̄t). Marbling, striation and grain that ride WITH the fluid instead of past it. ' +
        'First motion. This one channel is what fixes all eight of the decoration families V2 shipped ' +
        'switched OFF — they failed for one shared reason, that they were screen-space noise.',
    }),
    Object.freeze({
      name: 'fill',
      note:
        'THE SIM. Tier 2 draws slugs from an ANALYTIC scroll (the PRESCRIBE mode); this replaces the ' +
        'source of that same φ with a transported one, changing nothing downstream. Slugs gain ' +
        'IDENTITY — they stretch, compress, merge and arrive; dye marbles; bulbs fill and drain; and ' +
        'v = Q/A makes the goo genuinely speed up through a constriction.',
    }),
    Object.freeze({
      name: 'bubbles',
      note:
        'C4. The gas channel rendered as real bubbles in (τ, w) — riding, bunching at constrictions, ' +
        'pinning to the upper wall, popping at a free surface. Same fetch, more ALU.',
    }),
    Object.freeze({
      name: 'optics',
      note:
        'C5. Dependent read of buf:scene.color: the tube as a CYLINDRICAL LENS magnifying the art ' +
        'beneath, chromatic dispersion on the same offset, bubble lensing. First rung that forces ' +
        'surface.fluid to become a real pass — the same rule surface.water states for its own tier 5.',
    }),
    Object.freeze({
      name: 'emission',
      note:
        'C6. The goo becomes a real light source: its emission injected so the glow spills onto the ' +
        'floor and nearby walls. An extra small target and a stage-crossing read into light.accumulate.',
    }),
    Object.freeze({
      name: 'spray',
      note:
        'C8. Vapour at open ends, drips, condensation running down the glass, spill from a broken ' +
        'tube — through the ONE particle engine, never a second one.',
    }),
  ]),
});
