/**
 * FLUID's SURFACE — the TSL materials. THREE is INJECTED, never imported.
 *
 * ============================================================================
 * THE TWO-BLEND SPLIT, BUILT — AND A CORRECTION TO WHERE IT SITS
 * ============================================================================
 * `Fluid.md` §5.6 (inherited from `keyhole-water-tsl-design` correction #5):
 * goo does two physically different things and one alpha cannot express both.
 * ABSORPTION tints whatever is beneath the goo — a MULTIPLY. EMISSION, sheen
 * and the iridescent film add light on top of that — an ADD. Both are built
 * here, mirroring `water-render.js`'s `absorbMaterial`/`inscatterMaterial`
 * exactly: one builder, one shared `configureShared()`, two materials that
 * differ ONLY in blend state and colour.
 *
 * ⚠️ **CORRECTED 2026-07-27 — the ADD half does NOT draw "over the art".**
 * The first version of this header claimed the emissive pass belongs visually
 * on top of the masked tile's own texture, "because a highlight on glass is
 * physically on top of it," and picked `THREE.AdditiveBlending` with no
 * particular renderOrder story. That is not how this renderer's layering
 * works, and the claim was never checked against it.
 *
 * `scene/layer-order.js#sortByLayer` stamps EVERY drawable's `renderOrder` as
 * its index in the painter's-algorithm sort — ascending order, later paints on
 * top. The level background is always index 0; every real item (a tile, a
 * token, a tree) gets an INTEGER index ≥ 1. Water and the candle flame both
 * reserve the open FRACTIONAL band `(0, 1)` for exactly this reason: a value
 * in that band is guaranteed, by construction, to draw AFTER the background
 * and BEFORE every real item — nowhere else, no lookup required. Fluid's
 * fixed `FLUID_RENDER_ORDER_EMIT = 0.6` (`fluid-surface-subsystem.js`) sits in
 * that same band, so it draws — like water, like the candle — **underneath
 * the masked tile's own art, not over it**. That is *why* the emissive glow
 * only becomes visible through whatever the artist painted as glass: the
 * tile's own semi-transparent texture composites over fluid's colour via
 * ordinary alpha blending, exactly V2's "under the texture" placement (the
 * account in `legacy/compositor-v2/effects/FluidEffectV2.js`'s own comment,
 * `Fluid.md` §1 item 6). The author's live report confirmed the tubes are
 * visible under this arrangement; the fix here is to the DOCUMENTATION and to
 * `depthTest`/blend-factor precision, not to the placement, which was already
 * correct by accident of the shared fractional band.
 *
 * The two fluid meshes are sequenced RELATIVE TO EACH OTHER, not relative to
 * the tile: absorb (multiply) draws first, so it establishes a tinted base;
 * emit (add) draws second, so its glow is never itself darkened by the
 * absorption term it is paired with. Both stay comfortably inside `(0, 1)`.
 *
 * ⚠️ **THE MULTIPLY IDENTITY IS WHITE, NOT ZERO** — the trap
 * `feedback_blend_neutral_element_is_per_blend` names, and water's own
 * `absorbMaterial.mrtNode` is the precedent copied here verbatim: `attr =
 * vec4(1,1,1,1)` for the multiply pass, `vec4(0,0,0,0)` for the additive one.
 *
 * ⚠️ **THE KEY MUST BE THE LITERAL STRING `attr`, NOT `gAttr`.** `MRTNode`
 * matches each `mrt({...})` key against the BOUND render target's attachment
 * NAME by exact string equality (`vt/scene-attr.js`'s own header, verified
 * against `three.webgpu.js`); a key with no matching attachment is silently
 * SKIPPED — no error, no effect. This file shipped with `gAttr` for one
 * round: the primary `output` key still matched (so the visible colour was
 * never in doubt), but the attr override silently never applied, and the
 * renderer's global default (`vt/scene-attr.js#buildSceneAttrZeroMrt`, itself
 * `attr: vec4(0,0,0,0)`) took over instead. That was harmless for the emit
 * pass only by coincidence — zero IS additive's own identity. It would NOT
 * have been harmless here: combined with THIS pass's multiply blend factors,
 * the effective global default would have zeroed `buf:scene.attr` under
 * every tube, which is the exact failure this whole warning block exists to
 * name in the abstract. Caught before it shipped; the key is `attr` below.
 *
 * ============================================================================
 * WHAT EACH TERM IS, AND WHERE IT COMES FROM
 * ============================================================================
 *   SILHOUETTE   the high-res mask file, thresholded — never the pack. The pack
 *                is a ~1,536-wide derived grid and `feedback_sdf_does_not_draw_
 *                the_edge` is unambiguous that a derived grid cannot supply an
 *                edge, however finely it is sampled.
 *   s, across    the pack (`fluid-pack.js`). Arc length along the tube and
 *                distance from its centreline, both baked once per mask change.
 *   CYLINDER     `√(1 − across²)` — the optical path length through a round
 *                tube seen from directly above. Longest down the centreline,
 *                zero at the glass — the cue that stops a tube reading as a
 *                painted line, shared by BOTH passes: it is what the goo
 *                absorbs through (multiply) and how bright its body reads
 *                (add).
 *   φ (FILL)     `fluid-sim.js`'s own transported state — a genuine 1-D
 *                simulation, NOT the analytic `fract()` scroll tier `flow`
 *                shipped with. Reading it is a DEPENDENT READ: the pack gives
 *                THIS pixel's `(s, tubeId)`, and those two numbers are what
 *                address the state texture — `Effects.md`'s own C5
 *                definition, which is why tier `fill` is C5 in the manifest
 *                and not the C4 first guessed before anything was built.
 *   FILM         thin-film interference driven by the optical thickness, so
 *                the rainbow bands across the cross-section and shift with
 *                the fill's own arrival instead of floating free.
 *   STRUCTURE(τ) tier `structure`'s material coordinate — `τ = s − v̄·t`, a
 *                SPATIALLY CONSTANT time shift (one scalar per tube, not
 *                per-pixel), which is exactly the SAFE half of the trap
 *                `water-field.js`'s own header names ("never multiply a
 *                per-pixel direction by unbounded time"): that bug came from
 *                a per-pixel-VARYING direction times unbounded t causing
 *                adjacent pixels to diverge; here every pixel's τ differs
 *                from its `s` by the IDENTICAL amount, so nothing can shear
 *                however long the scene runs. One `mx_fractal_noise_vec3`
 *                fetch at `(τ, across)` reads as marbling (tint) and grain
 *                (brightness) that ride WITH the flow instead of past it —
 *                V2's eight abandoned decoration families were screen-space
 *                noise for exactly this reason (`fluid.js`'s own `structure`
 *                tier text).
 *   ABSORPTION   Beer–Lambert per channel, the SAME formula
 *                `water-render.js`'s tier 1 already uses (`sigma = -log(tint)
 *                / mean(-log(tint))`, `transmit = exp(-sigma · depth)`) —
 *                reused rather than re-derived, so there is never a second,
 *                disagreeing absorption model in this codebase (`Water.md`
 *                §2.4 names two disagreeing GGX stacks as exactly this
 *                failure). `depth` here is the cylinder thickness gated by
 *                φ itself, so an empty stretch of tube (no liquid)
 *                transmits at `exp(0) = 1` — white, the multiply identity,
 *                automatically, with no separate gate needed.
 *
 * @module effects/fluid/fluid-render
 */

import { FLUID_TARGET_TRAVERSAL_SECONDS } from './fluid-sim.js';

/** Tier 0's tint — a cyan-green "alchemical" glow. Matches FLUID_PARAMS.tint.
 * Shared by both passes: the same hue that glows is the hue that absorbs. */
export const FLUID_TIER0_TINT = [0.15, 0.95, 0.7];

/** How hard the goo is pushed into HDR for `post.bloom` to find it. */
export const FLUID_TIER0_GLOW = 1.6;

/** Mask bytes below this are not tube; above the upper edge they fully are. The
 * narrow band between them is the antialiased edge of the AUTHORED file, which
 * is what makes the silhouette crisp at any zoom (the water shoreline's own
 * lesson, applied without re-deriving it). */
export const FLUID_PRESENCE_EDGE0 = 0.04;
export const FLUID_PRESENCE_EDGE1 = 0.18;

/** How far along the tube (in normalised arc length, 0..1) the meniscus
 * finite-difference steps to find the fill's local gradient. One `fluid-sim`
 * bin at the design resolution (`FLUID_PROFILE_SAMPLES` in `fluid-net.js`);
 * not imported for that exact number because the render material does not
 * otherwise need to know the sim's own resolution, and a constant this small
 * is forgiving of a mismatch either way. */
const FLUID_MENISCUS_EPSILON = 1 / 512;

/** Thin-film strength, 0 = flat tint. */
export const FLUID_TIER3_IRIDESCENCE = 0.8;

/**
 * Beer–Lambert strength for the absorption pass — how strongly the goo tints
 * what is beneath it at full thickness. NOT a live param yet (mirrors how
 * water's own `WATER_TIER1_ABSORPTION` shipped as a bare constant before
 * `absorption` became a schema key): `opacity` already scales this pass's
 * optical depth, so the one control the author has today is "how much",
 * dialing both passes at once — a separate strength knob is a later rung, if
 * the two ever need to move independently.
 */
export const FLUID_ABSORPTION_STRENGTH = 1.4;

/** Tier 5 (`structure`) default strength — how visible the marbling/grain
 * reads. Matches FLUID_PARAMS.structure. */
export const FLUID_TIER5_STRUCTURE = 0.5;

/** How many marble "bands" fit along one tube's full normalised length, and
 * across its width — tuned to look like organic marbling at a typical tube
 * width, not derived from anything physical (the same posture `film`'s own
 * `9.0`/`2.0` constants already have in this file). */
const FLUID_STRUCTURE_FREQ_ALONG = 6.0;
const FLUID_STRUCTURE_FREQ_ACROSS = 3.0;

/** Maximum fractional tint/brightness swing at `structure = 1` — kept small
 * so the pattern reads as texture riding on the goo, never a competing
 * second light source. Grain is allowed a bit more range than marbling
 * because a fine brightness texture is where "grain" actually reads. */
const FLUID_STRUCTURE_TINT_SCALE = 0.15;
const FLUID_STRUCTURE_GRAIN_SCALE = 0.25;

/**
 * Build fluid's two surface materials — absorb (multiply) and emit (add).
 *
 * @param {object} args
 * @param {*} args.THREE - injected.
 * @param {*} args.maskTexture - the high-res `_Fluid` file (RED, linear).
 * @param {*} args.packTexture - `fluid-pack.js`'s RGBA pack.
 * @param {*} args.stateTexture - `fluid-sim.js`'s ping-pong state, R = φ.
 *   `samplesPerTube × tubeCount`, re-pointed to whichever half is CURRENT
 *   after every tick (`fluid-surface-subsystem.js`'s own tick function).
 * @param {number} args.tubeCount - how many rows `stateTexture` has — a
 *   per-item bake-time constant (the pack's own `tubeId` is 1-based against
 *   this same count), needed to turn a `tubeId` into the state texture's V.
 * @param {*} args.timeMsNode - THE SHARED CLOCK (`core/frame-clock.js`). Never a
 *   private time node: `time/one-clock` exists because V2's water sampled eight
 *   independent ones. Still consumed here for the film's own slow drift —
 *   the FILL windowing itself no longer needs it; that is `fluid-sim.js`'s job now.
 * @param {number[]} [args.tint] @param {number} [args.glow]
 * @param {number} [args.iridescence] @param {number} [args.opacity]
 * @param {number} [args.flowSpeed] - the SAME live "flow speed" the pump's own
 *   `Q` is scaled by (`fluid-surface-subsystem.js#prepareSimTick`) — reused
 *   here so τ's own drift rate stays consistent with how fast the fill
 *   ACTUALLY moves, rather than drifting at a rate the user's own speed
 *   control has no effect on.
 * @param {number} [args.structure] - tier 5's marbling/grain strength, 0..1.
 * @returns {{absorbMaterial: *, emitMaterial: *, uniforms: object, maskTexNode: *, packTexNode: *,
 *   stateTexNodes: Array<*>}} `stateTexNodes` has exactly TWO entries (the
 *   `fill` sample and the meniscus's `fillAhead` sample) — re-point BOTH
 *   `.value`s to the current ping-pong source every tick, mirroring
 *   `fluid-sim.js`'s own `prevTexNodes` convention exactly.
 */
export function buildFluidSurfaceMaterials({
  THREE,
  maskTexture,
  packTexture,
  stateTexture,
  tubeCount,
  timeMsNode,
  tint = FLUID_TIER0_TINT,
  glow = FLUID_TIER0_GLOW,
  iridescence = FLUID_TIER3_IRIDESCENCE,
  opacity = 1,
  flowSpeed = 1,
  structure = FLUID_TIER5_STRUCTURE,
}) {
  const {
    texture,
    uv,
    vec2,
    vec3,
    vec4,
    float,
    uniform,
    smoothstep,
    clamp,
    max,
    sqrt,
    sin,
    mix,
    log,
    exp,
    dot,
    abs,
    mrt,
    mx_fractal_noise_vec3,
  } = THREE.TSL;

  const uTint = uniform(vec3(tint[0], tint[1], tint[2]));
  const uGlow = uniform(float(glow));
  const uIridescence = uniform(float(iridescence));
  const uOpacity = uniform(float(opacity));
  const uFlowSpeed = uniform(float(flowSpeed));
  const uStructure = uniform(float(structure));
  // `tubeCount` is a per-item BAKE-TIME constant (fixed until the next
  // rebake), not a per-frame value — a plain `float()` literal, never a
  // `uniform()`, matching Law 4: nothing here can change without rebuilding
  // this whole material anyway (a rebake calls this builder fresh), so a
  // uniform slot for it would be a distinction with no behavioural difference.
  const tubeCountF = float(Math.max(1, tubeCount));

  // ── THE QUAD'S OWN UV, not a world rect ─────────────────────────────────
  // Fluid is a PER-ITEM effect: the mesh IS the masked item's quad, and the
  // mask/pack each cover exactly that quad, so the quad's own UV is the
  // mapping — the identical one the item's albedo already uses. That also
  // makes a ROTATED tile correct for free, which a world-rect mapping could
  // not do at all (a rect has no rotation).
  const quadUv = uv();
  const maskTexNode = texture(maskTexture, quadUv);
  const packTexNode = texture(packTexture, quadUv);

  // THE SILHOUETTE — from the FILE, at its own resolution.
  const inside = smoothstep(float(FLUID_PRESENCE_EDGE0), float(FLUID_PRESENCE_EDGE1), maskTexNode.r).toVar();

  const s = packTexNode.r.toVar();
  const across = clamp(packTexNode.g, 0, 1).toVar();
  // Needed by TIER 3 (the film's slow drift) and TIER 5 (τ, below) — hoisted
  // here once so both tiers read from one declaration instead of two
  // independent `.mul(1/1000)`s. TIER 4 (fill) owns its own clock, none here.
  const tSec = timeMsNode.mul(float(1 / 1000));

  // ── TIER 5: STRUCTURE — τ, the material coordinate ──────────────────────
  // `τ = s − v̄·t`, computed BEFORE tier 1 needs `across`/`thickness` so it
  // reads top-to-bottom as "the pack's own coordinates, then the ONE derived
  // coordinate the rest of this tier ladder can also use." `v̄` is
  // `flowSpeed / FLUID_TARGET_TRAVERSAL_SECONDS` — a SINGLE SCALAR, the same
  // for every pixel on this tube — because `computeFluidLengthQScale`
  // (`fluid-sim.js`) already calibrates each tube's own `Q` so its real
  // traversal time lands near `FLUID_TARGET_TRAVERSAL_SECONDS` regardless of
  // that tube's length/width; τ's own rate is the mirror of that same
  // calibration, not a second guess at it. `uFlowSpeed` (not the JS-side
  // scale bare) so a live speed-control change moves the material pattern in
  // the SAME direction and proportion as the visible fill speeds up.
  //
  // ⚠️ SPATIALLY CONSTANT, not per-pixel — the safe half of `water-field.js`'s
  // own "never multiply a per-pixel direction by unbounded time" trap. That
  // bug came from a per-pixel-VARYING direction times unbounded t causing
  // adjacent pixels to diverge into a fan of streaks; here `v̄` is the
  // IDENTICAL value at every pixel on this tube, so τ and `s` differ by
  // exactly the same amount everywhere — nothing can shear, however long the
  // tick clock has been running (matches that file's own safe "TRAVEL" term,
  // not its dangerous one).
  const tau = s.sub(uFlowSpeed.div(float(FLUID_TARGET_TRAVERSAL_SECONDS)).mul(tSec)).toVar();

  // ── TIER 1: THE CYLINDER ────────────────────────────────────────────────
  // Optical path length through a round tube from directly above. Maximum down
  // the centreline, zero at the glass — which is what a real capillary looks
  // like and what V2 had no way to express (everything it drew was a function
  // of arc length alone, so nothing varied ACROSS the tube). Shared by both
  // passes: it IS the depth the absorb pass attenuates over, and it IS the
  // brightness ramp the emit pass shows.
  const thickness = sqrt(max(float(1).sub(across.mul(across)), float(0))).toVar();

  // The wall rim: a thin bright band where the glass catches light. One
  // smoothstep on a value already in a register.
  const rim = smoothstep(float(0.72), float(0.99), across).toVar();

  // ── TIER 3: THE FILM ────────────────────────────────────────────────────
  // Thin-film interference as a readout of REAL optical thickness, so the
  // rainbow bands across the cross-section drift on their own instead of
  // floating free. Three constants where V2 needed thirteen.
  const filmPhase = thickness
    .mul(float(9.0))
    .add(s.mul(float(2.0)))
    .add(tSec.mul(float(0.35)));
  const film = vec3(
    sin(filmPhase).mul(0.5).add(0.5),
    sin(filmPhase.add(float(2.1)))
      .mul(0.5)
      .add(0.5),
    sin(filmPhase.add(float(4.2)))
      .mul(0.5)
      .add(0.5)
  );
  const tinted = mix(uTint, film, uIridescence.mul(float(0.6))).toVar();

  // ── TIER 5: STRUCTURE — the noise fetch, at τ not `s` ───────────────────
  // ONE `mx_fractal_noise_vec3` fetch (Law 8: the vendored MaterialX node,
  // never a hand-rolled hash — `water-field.js#buildWaterSurfaceField`'s own
  // identical "ONE fetch" comment is the precedent copied here), reading TWO
  // of its three channels rather than calling noise twice. Sampled at
  // `(τ, across)`, NOT `(s, across)` — τ is what makes the pattern ride WITH
  // the flow instead of sitting static in the pack's own fixed coordinate;
  // this is the one channel `fluid.js`'s own `structure` tier note says fixes
  // all eight of V2's abandoned decoration families, all of which sampled
  // noise in screen space instead.
  //
  // Output range is SIGNED, centred near zero (confirmed against
  // `water-field.js`'s own usage: "turbidity... centred on zero"), so both
  // channels below are read as a SMALL fractional swing around 1, clamped to
  // a sane band rather than left able to invert a colour channel on an
  // extreme sample.
  const structureNoise = mx_fractal_noise_vec3(
    vec3(tau.mul(float(FLUID_STRUCTURE_FREQ_ALONG)), across.mul(float(FLUID_STRUCTURE_FREQ_ACROSS)), float(0)),
    3,
    2.0,
    0.5
  ).toVar();
  // MARBLING — a further modulation of the already-tinted colour, exactly
  // the way FILM modulates the raw tint: one more multiplicative layer, never
  // a competing colour source.
  const marbled = tinted
    .mul(
      clamp(
        float(1).add(structureNoise.x.mul(uStructure).mul(float(FLUID_STRUCTURE_TINT_SCALE))),
        float(0.5),
        float(1.5)
      )
    )
    .toVar();
  // GRAIN — a brightness perturbation, applied to `body` below (not here):
  // `body` is already zero wherever `fill` is zero, so multiplying it by
  // `grain` inherits that gating for free — no separate "only where there is
  // liquid" test needed, the SAME reasoning `opticalDepth`'s own comment
  // already gives for why it needs no separate outside-the-tube gate.
  const grain = clamp(
    float(1).add(structureNoise.y.mul(uStructure).mul(float(FLUID_STRUCTURE_GRAIN_SCALE))),
    float(0.5),
    float(1.5)
  );

  // ── TIER 4: FILL — a genuine 1-D SIMULATION, not a scroll ───────────────
  // `fluid-sim.js` owns transport now; this is the DEPENDENT READ Effects.md's
  // own C5 definition describes — the pack gives THIS pixel's `(s, tubeId)`,
  // and those two numbers are the COORDINATE that addresses the sim's state
  // texture. There is no way to read φ here without first reading where to
  // read it from. `s` and the sim's own U are the same 0..1 arc-length
  // coordinate BY CONSTRUCTION (both derive from `fluid-net.js`'s
  // `distFromRoot / lengthPx`), so no conversion belongs between them.
  const tubeId = packTexNode.b.toVar();
  const stateV = tubeId.sub(float(0.5)).div(tubeCountF);
  const stateTexNode = texture(stateTexture, vec2(s, stateV));
  const fill = stateTexNode.r.toVar();

  // The meniscus — bright right where φ CHANGES along the tube, not at the
  // wall. A moving front is a near-step in φ; a two-tap finite difference
  // spikes there and reads flat everywhere else, since a fully-filled or
  // fully-empty stretch has zero gradient by construction. On the RIGHT AXIS
  // this time: V2's `meniscusStrength` was a function of distance to the wall
  // and defaulted to 0 because it could never have looked right.
  //
  // ⚠️ A SECOND independent sample of the SAME ping-ponged texture — not a
  // re-read of `stateTexNode` above. `world/wind-sim-gpu.js`'s own header
  // names this exact trap: a texture that gets re-pointed every tick needs
  // EVERY node that samples it re-pointed together, and there is no `.uv()`
  // chain method on a built TextureNode in this vendored THREE, so a second
  // UV needs a genuinely second `texture(...)` call — which means a second
  // node the caller must track. Both live in `stateTexNodes` below, never
  // just the first.
  //
  // ⚠️ CLAMPED, not left to the texture's own wrap mode. Near a tube's tip
  // (`s` close to 1) this offset can exceed 1.0; a REPEAT-wrapped sample
  // would wrap around to the tube's ROOT — a false gradient spike comparing
  // the tip against the opposite end. `fluid-sim.js`'s own backtrace clamps
  // its UV explicitly for the identical reason (never relies on wrap mode);
  // this is the same discipline applied here.
  const fillAheadU = clamp(s.add(float(FLUID_MENISCUS_EPSILON)), float(0), float(1));
  const fillAheadTexNode = texture(stateTexture, vec2(fillAheadU, stateV));
  const fillAhead = fillAheadTexNode.r;
  const meniscus = clamp(abs(fillAhead.sub(fill)).mul(float(24)), 0, 1)
    .mul(fill)
    .toVar();

  // ── EMIT (ADD) — the goo's own light ─────────────────────────────────────
  const body = thickness
    .mul(fill)
    .mul(float(0.9))
    .add(meniscus.mul(float(0.8)))
    .add(rim.mul(fill).mul(float(0.35)))
    .mul(grain);
  const radiance = marbled.mul(body).mul(uGlow).mul(inside).mul(uOpacity);

  // ── ABSORB (MULTIPLY) — Beer–Lambert, THE SAME FORMULA water's tier 1 uses ──
  // σ = −log(tint) / mean(−log(tint)) · strength — normalising by the mean
  // keeps "how deep it reads" (optical depth) and "what colour it is" (hue)
  // independent, exactly as water-render.js's own comment states for the
  // identical line. The two floors guard the same two degeneracies: `max(tint,
  // eps)` stops `log(0)`, and `max(mean, eps)` stops a 0/0 on a pure-white tint
  // (which correctly yields σ = 0 — colourless goo that absorbs nothing).
  const absorbHue = log(max(uTint, vec3(2e-3, 2e-3, 2e-3))).negate();
  const absorbMean = max(dot(absorbHue, vec3(1 / 3, 1 / 3, 1 / 3)), float(1e-4));
  const sigma = absorbHue.div(absorbMean).mul(float(FLUID_ABSORPTION_STRENGTH));
  // Optical depth: the SAME cylinder thickness, gated by the fill fraction and
  // by the silhouette, scaled by `opacity` so the one strength control moves
  // both passes together. Zero wherever there is no tube or no liquid RIGHT
  // NOW — which makes `transmit` equal `exp(0) = 1` (WHITE, the multiply
  // identity) there automatically, with no separate outside-the-tube gate to
  // get wrong.
  const opticalDepth = thickness.mul(fill).mul(inside).mul(uOpacity);
  const transmit = exp(sigma.negate().mul(opticalDepth));

  // Shared by both meshes. Split out so the two materials cannot drift apart
  // on the settings that make them agree about WHERE they are, which is every
  // setting except the blend — the exact shape `water-render.js#configureShared`
  // uses, copied rather than re-derived.
  function configureShared(material) {
    material.transparent = true;
    // The painter's-algorithm contract every drawable in this renderer shares
    // (`scene/layer-order.js`): ascending renderOrder IS the layering, so depth
    // testing would only fight it. `depthWrite: false` for the same reason.
    material.depthTest = false;
    material.depthWrite = false;
    // EVERY world-space quad in this renderer sets this (`scene/world-quad.js`'s
    // own `QUAD_INDICES` doc): a negative scale (Foundry's horizontal-flip
    // convention) mirrors the mesh's corners and reverses the effective
    // winding, and `FrontSide` would cull the quad as a backface — visible in
    // every JS-side status field and invisible on screen
    // (`feedback_doubleside_invisible_to_status_reports`).
    material.side = THREE.DoubleSide;
    material.toneMapped = false;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendEquationAlpha = THREE.AddEquation;
    // Destination alpha is left alone by both passes — `buf:scene.color`'s
    // alpha is level-composite coverage, and neither term is a statement
    // about coverage. `Zero·src + One·dst` is the identity on it.
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
  }

  // ── MESH 1: ABSORB ────────────────────────────────────────────────────────
  const absorbMaterial = new THREE.NodeMaterial();
  absorbMaterial.colorNode = vec4(transmit, 1);
  configureShared(absorbMaterial);
  // `dst · src`: Zero·src + SrcColor·dst = src_colour * dst_colour.
  absorbMaterial.blendSrc = THREE.ZeroFactor;
  absorbMaterial.blendDst = THREE.SrcColorFactor;
  // WHITE, not the renderer-global zero — the multiplicative identity. `attr ·
  // 0` would erase the floor attributes under every tube; blend state is not
  // per-attachment on WebGL2, so the SAME factors above apply to this MRT
  // output too.
  absorbMaterial.mrtNode = mrt({ attr: vec4(1, 1, 1, 1) });

  // ── MESH 2: EMIT ──────────────────────────────────────────────────────────
  const emitMaterial = new THREE.NodeMaterial();
  emitMaterial.colorNode = vec4(radiance, 1);
  configureShared(emitMaterial);
  // `src + dst`: One·src + One·dst.
  emitMaterial.blendSrc = THREE.OneFactor;
  emitMaterial.blendDst = THREE.OneFactor;
  // Additive's identity IS the renderer-global default zero — stated because
  // the pass beside it is a counter-example, and the next reader needs to see
  // that this one was checked rather than left to luck.
  emitMaterial.mrtNode = mrt({ attr: vec4(0, 0, 0, 0) });

  return {
    absorbMaterial,
    emitMaterial,
    maskTexNode,
    packTexNode,
    // BOTH samples of the ping-ponged state texture, so a tick function can
    // re-point every one the same way `fluid-sim.js`'s own `prevTexNodes`
    // works — re-pointing only `stateTexNode` would leave the meniscus
    // reading a stale half of the ping-pong pair forever.
    stateTexNodes: [stateTexNode, fillAheadTexNode],
    uniforms: {
      uTint,
      uGlow,
      uIridescence,
      uOpacity,
      uFlowSpeed,
      uStructure,
    },
  };
}
