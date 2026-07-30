/**
 * FLUID — the declaration (manifest + params schema), pure data, no THREE.
 * Goo in thin glass tubes, seen from above. `docs/planning/Fluid.md` is the
 * design; this file is its Node-validatable half. The TSL builders live in
 * sibling render modules with THREE injected and never imported, exactly as
 * water/bloom/candle split.
 *
 * ============================================================================
 * WHAT EXISTS TODAY (Phase 6) — read this before trusting the manifest
 * ============================================================================
 *
 * Tiers 0–5 RENDER, as BOTH halves of the two-blend split, the real 1-D sim,
 * AND the material coordinate: `fluid-net.js` extracts the tube net,
 * `fluid-pack.js` bakes it, `fluid-pump.js` decides what each tube's
 * apparatus is doing, `fluid-sim.js` transports it (a genuine semi-Lagrangian
 * ping-pong, not the old analytic scroll), `fluid-surface-subsystem.js` owns
 * the whole chain and builds TWO meshes per masked item (sharing one
 * geometry), `fluid-render.js` builds the MULTIPLY (absorb) and ADD (emit)
 * materials — reading the SIM's state (superseding tier `flow`'s original
 * analytic windowing the same phase it was built, see that tier's own `adds`
 * text) and sampling ONE noise fetch at τ for tier `structure`'s marbling and
 * grain — and `fluid-registration.js` gives it a card and a console setter.
 * The six `tiers` entries below are real code.
 *
 * **Still NOT built, so the manifest must not be read as claiming them:**
 * bubbles, optics, emission-as-a-light and spray. Those are the
 * `deferredRungs` below, named and ordered, and none of them has a line of
 * code.
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
  // `slugCount`/`slugWidth` (the analytic scroll's blob-count and blob-width
  // knobs) are GONE, not renamed: tier `fill`'s real sim decides how chunky
  // the flow reads per tube, from each tube's own pump personality
  // (`fluid-pump.js#fluidPumpPersonality`'s `dutyFraction`/`gulpPeriodS`) —
  // there is no single global count or width left to tune, and no consumer
  // for either key once `fluid-render.js` stopped reading them
  // (`params/no-dead-controls`). Exposing the pump's per-tube personality as
  // a live control is a real future rung, not this one.
  flowSpeed: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Flow speed',
    help: 'Scales how fast the pump drives goo through every tube. 1 is the pump`s own natural pace; 0 stops it dead, which is useful for a dormant apparatus. Each tube keeps its own rhythm of surges and gaps — this only speeds all of them up or down together, uniformly. Also sets how fast the marbling pattern (Structure) drifts, so slowing the flow slows the pattern with it.',
  },
  // ── Detail ──────────────────────────────────────────────────────────────
  structure: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    category: 'Detail',
    label: 'Structure',
    help: 'Marbling and grain that ride WITH the flow rather than sitting still on top of it — driven by the material coordinate τ, not the mask`s own fixed position. At 0 the goo is a flat colour with no visible texture; higher values read as a more mottled, organic liquid.',
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
  // HOW YOU ADD IT TO A MAP — the ＋ in this effect's card header opens the
  // brush already loaded with this mask (validateAuthoring, effect-manifest.js).
  authoring: Object.freeze({ paint: 'fluid' }),
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
        'The fluid mask, in the right place on the right floor, as TWO passes (never one alpha): a ' +
        'MULTIPLY that tints whatever is beneath the goo, and an ADD that is the goo`s own glow. The ' +
        'tube has translucent, glowing goo in it. Never gated.',
    }),
    Object.freeze({
      n: 1,
      name: 'tube',
      fromProfile: 'low',
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
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.04 }),
      adds:
        'The pack read: `s`, the GEODESIC arc-length coordinate (so position along a tube means the ' +
        'same thing on a long one and a short one, unlike V2`s hand-painted ramp), and the fill-change ' +
        'axis the meniscus reads — the right axis, where V2`s was a function of distance to the WALL ' +
        'and defaulted to 0 because it could never have looked right. ⚠️ This rung`s ORIGINAL windowing ' +
        'technique — an analytic `fract(s·count − t·speed)` scroll — was SUPERSEDED by tier `fill`' +
        '`s real transport the same phase it was built, matching this codebase`s own established ' +
        'precedent (no shipped effect keeps a live per-tier code switch; the governor that would need ' +
        'one is unbuilt — Effects.md §6). What tier `flow` still owns is `s` itself and the meniscus ' +
        'axis; the WINDOW now comes from `fill`.',
    }),
    Object.freeze({
      n: 3,
      name: 'film',
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.01 }),
      adds:
        'Thin-film iridescence driven by that same optical thickness, so the rainbow bands across ' +
        'the cross-section and shifts at every slug front instead of being an unrelated noise field. ' +
        'V2 spent 13 parameters here; grounding it in a real thickness leaves 1.',
    }),
    Object.freeze({
      n: 4,
      name: 'fill',
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C5', estMsPerMp: 0.08 }),
      adds:
        'THE SIM (`fluid-sim.js`, `fluid-pump.js`): a semi-Lagrangian ping-pong per masked item, ' +
        '`v = Q/A` so the goo genuinely speeds up through a constriction, slugs with real IDENTITY ' +
        '(they stretch, compress, merge, arrive — never redrawn from a formula), a pump that never ' +
        'quite repeats. C5, not the C4 first guessed at design time (`Fluid.md` §7`s original table): ' +
        'reading the SIM STATE needs the pack`s own `(s, tubeId)` output as the NEXT read`s coordinate ' +
        '— a genuine dependent read, Effects.md`s own C5 definition exactly. Estimates are wrong; this ' +
        'is the correction, made once the real thing was built rather than left stale in the manifest.',
    }),
    Object.freeze({
      n: 5,
      name: 'structure',
      fromProfile: 'quality',
      // ⚠️ C5, NOT the C2 `Fluid.md` §7's original design-time sketch guessed
      // — the SAME correction tier `fill` above already had to make, for the
      // SAME reason: `cost.class` in this manifest is the CEILING the rung
      // runs within, not its own marginal operation type (`validateEffect
      // Manifest`'s own enforced rule, Law 3: "must be non-decreasing" —
      // mechanically checked, not prose). Tier 3 (`film`, pure ALU on values
      // already read) is ALREADY listed C4 for the identical reason: it
      // stands on tier 0's own C4 admission price and inherits that floor.
      // `structure`'s OWN new work — one resident `mx_fractal_noise_vec3`
      // fetch, ALU besides that — genuinely IS C2-shaped in isolation
      // (`estMsPerMp` below reflects that cheap marginal cost honestly), but
      // it reads `s` (tier 2, C4) and `tinted` (tier 3, C4) and sits after
      // `fill`'s own genuine C5 dependent read, so the CEILING it inherits is
      // C5. Reclassifying was the honest move once this was actually built —
      // NOT a hand-wave that the mechanical check somehow doesn't apply here.
      cost: Object.freeze({ class: 'C5', estMsPerMp: 0.02 }),
      adds:
        'THE MATERIAL COORDINATE τ (`fluid-render.js`): ONE `mx_fractal_noise_vec3` fetch at `(τ, ' +
        'across)`, reading two of its three channels as marbling (tint) and grain (brightness). ' +
        '`τ = s − v̄·t` is analytic at this rung, exactly as `Fluid.md` §7`s original sketch called ' +
        'for — a SPATIALLY CONSTANT per-tube time shift, never a per-pixel one (the safe half of ' +
        '`water-field.js`\'s own "never multiply a per-pixel direction by unbounded time" trap, not ' +
        "the dangerous half). `v̄` reuses `computeFluidLengthQScale`'s own calibration (`fluid-sim.js`) " +
        'so τ`s drift rate stays consistent with how fast the fill actually moves, scaled live by the ' +
        'same `flowSpeed` control that scales the pump`s `Q`. This is the one channel that fixes all ' +
        "eight of the decoration families V2 shipped switched off (`deferredRungs`' own former note " +
        'for this tier) — they failed because they sampled noise in screen space, never riding with ' +
        'the flow.',
    }),
  ]),
  /**
   * Recorded, NOT built — the honest rungs (`Effects.md` §0). Each becomes a
   * real `tiers` entry, with its own cost class and its own phase's render
   * code, in build order.
   *
   * Built ladder so far: `placement C4 → tube C1 → flow C4 → film C4 → fill
   * C5 → structure C5`. Non-decreasing, as Law 3 requires. `structure`'s OWN
   * marginal cost (`estMsPerMp: 0.02`) is genuinely tiny — the C5 CLASS
   * records what it runs on TOP OF (tier 4's dependent read), not what it
   * itself newly costs; see that tier's own comment for why `cost.class` is
   * a ceiling, not a marginal-operation label, in this manifest's convention.
   */
  deferredRungs: Object.freeze([
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
