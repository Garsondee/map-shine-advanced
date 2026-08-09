/**
 * `buf:scene.attr` — THE FLOOR-ATTRIBUTE BUFFER (`docs/planning/v3/B0-1-floor-
 * attribute-buffer.md`). A second MRT attachment on `scene.color`, written by
 * the SAME unified geometry pass, carrying per-pixel R=floor index,
 * G=outdoors, B=presence bitflags, A=authored solidity.
 *
 * ============================================================================
 * THE MRT MECHANISM (verified against src/vendor/three/three.webgpu.js)
 * ============================================================================
 *
 * three's WebGPU/TSL MRT is TWO cooperating pieces, not a per-material-only
 * feature:
 *
 *   renderer.setMRT(mrt({ output, attr: someNode }))   — a RENDERER-GLOBAL
 *   material.mrtNode = mrt({ attr: someOtherNode })     — a PER-MATERIAL override,
 *                                                          merged over the global
 *                                                          (material's keys win)
 *
 * `MRTNode.setup()` matches each key (`'output'`, `'attr'`, ...) against the
 * CURRENTLY BOUND render target's `textures[i].name` by exact string equality
 * (`getTextureIndex`, three.webgpu.js:48501-48507) — a key with no matching
 * texture name is silently skipped, no error, no shader output. This is why
 * `graph/three-allocator.js` grew a `desc.attachments[i].outputName` field:
 * an MRT render target's attachments must be named `'output'`/`'attr'`
 * VERBATIM (never the allocator's own `v3:name:i` debug tag) or the whole
 * mechanism silently does nothing.
 *
 * `output` itself (`THREE.TSL.output`) is a symbolic PropertyNode three
 * assigns per-material, per-build, to "whatever this material's own
 * colorNode pipeline already computed" — reusing the same JS reference across
 * every material's shader graph is safe, it resolves correctly per material.
 *
 * ⚠️ MRT MUST BE SCOPED, NEVER LEFT GLOBALLY SET. `renderer.setMRT(...)`
 * affects EVERY subsequent offscreen render() call, not just the one meant to
 * use it — and if a render target with fewer/differently-named attachments
 * is bound while a stale MRT node is active, `MRTNode.setup()` finds no
 * matching texture for ANY key and produces an EMPTY output struct (no
 * fragment output at all) for that other pass. `runGeometryWorldPass` (vt-
 * pan-viewer.js) saves the previous MRT, sets this module's node, and
 * restores it immediately after — the same save/set/restore discipline
 * three's own internals use around every render-target swap while MRT is
 * active (three.webgpu.js:41643-41646 et al).
 *
 * ============================================================================
 * THE SAFE DEFAULT — why most materials need ZERO changes
 * ============================================================================
 *
 * Under NormalBlending, a fragment output of EXACT `vec4(0,0,0,0)` leaves the
 * destination attachment untouched: the attachment's OWN alpha channel (here,
 * 0) is what the blend equation reads as its src-alpha factor —
 * `dst*(1-0) + 0*0 = dst` — regardless of what the material's COLOR
 * attachment's own alpha is. (WebGL2 has no per-attachment blend EQUATION
 * without `OES_draw_buffers_indexed`, but each attachment's blend SOURCE is
 * always its own output — this is not the same limitation, and the "vec4(0)
 * trick" the design doc names relies on exactly this distinction.)
 *
 * So the renderer-global default declared here (`SCENE_ATTR_ZERO_MRT`) —
 * `attr: vec4(0,0,0,0)` — already satisfies B0-1 §2.2's "transparent
 * fragments do not write attributes" rule for EVERY material in the unified
 * pass that doesn't opt in. Confirmed by audit (2026-07-25): every material
 * touching the main world scene + doorScene (`buildWholeImageMaterial`,
 * `buildVegetationMaterial` in its Case-2 overlay form, `buildDoorMaterial`)
 * is `transparent:true`, zero `alphaTest` usage anywhere. Only the REAL
 * writers (§ below) need a `material.mrtNode` override at all.
 *
 * ============================================================================
 * THE REAL WRITERS — floor art and embedded vegetation ARE the floor
 * ============================================================================
 *
 * `buildWholeImageMaterial` (the base map/tile art) and `buildVegetationMaterial`'s
 * Case-1 embedded form (a self-vegetation TILE — grass drawn AS the ground,
 * not a tree drawn ON it) both get a real `packFloorAttr(...)` output:
 *   R = this item's own floor index — its OWNING Level (`item.levelId`) when it
 *       has one, falling back to `scene/layer-order.js#resolveElevationFloorIndex`
 *       for a drawable with no owner (a loose tile). Resolved ONCE at item-build
 *       time — never re-derived per frame, since neither an item's elevation nor
 *       its owning Level changes live. ⚠️ The ownership half is load-bearing, not
 *       an optimisation: a Level's foreground sits AT its own `elevation.top`,
 *       and the elevation lookup's band is top-EXCLUSIVE, so resolving purely by
 *       elevation attributed every Level's foreground to the floor above it —
 *       see `resolveItemFloorAttrUniforms` for the live bug that caused.
 *   G = the outdoors value AT THIS FRAGMENT'S WORLD POSITION
 *       (`buildWorldSpaceOutdoorsGate` — NOT the screen-space `buildOutdoorsGate`
 *       bloom/grade use; a tile's own `uv()` is local sample space, not a
 *       screen-spanning one, so the screen-space gate would silently sample
 *       the wrong world position here)
 *   B = presence bit 0 (overhead/roof — `layer-order.js#isInForeground`,
 *       resolved at the SAME build-time site, same floors list, OR a Tile's
 *       own `restrictsLight` — see `PRESENCE_BIT_OVERHEAD`'s own doc); bit 1
 *       (levelsHidden) is NOT derived — see the KNOWN GAP note below. Bit 7
 *       (`PRESENCE_BIT_OCCLUDES_BACKGROUND`, added 2026-07-29, POLARITY
 *       INVERTED 2026-08-01) is 1 for art that covers a Level's background —
 *       a Tile or the Level's own foreground/roof — and 0 for the background
 *       itself. Read that constant's own doc before touching the polarity:
 *       it is set the way it is so that an UNWRITTEN buffer reads as "not
 *       occluded", never as "occluded". This is what lets a consumer (today,
 *       only `effects/specular`) tell "a Tile painted over my background"
 *       apart from "still my own background, unoccluded" — a distinction the
 *       floor-index channel alone cannot make, since a same-floor Tile
 *       shares its background's floor index.
 *   A = the material's OWN alpha, read via `TSL.output.a` (see
 *       `buildRealFloorAttrMrtNode`'s own doc for why it must be `output`,
 *       never a JS-closure-captured node) — this is what makes the punch-
 *       through work for free: where the base art is opaque (alpha≈1), attr
 *       overwrites with real data (destination almost entirely replaced);
 *       where it has an authored hole (alpha=0), attr's blend leaves
 *       whatever drew before it — typically the floor below — untouched.
 *       The SAME alpha-as-blend-source mechanism the safe zero-default
 *       relies on, just with a real payload instead of zero.
 *
 * ============================================================================
 * KNOWN GAP, STATED HONESTLY (not silently deferred)
 * ============================================================================
 *
 * 1. Bit 1 (levelsHidden / below-viewed) is NOT written. Deriving it needs a
 *    per-item "is this item's floor below the CURRENTLY VIEWED floor"
 *    comparison — a per-FRAME question (the viewed floor changes at runtime)
 *    that this module answers at per-ITEM BUILD time (an item's own floor is
 *    static, but the viewed floor is not). Wiring it needs either a rebuild
 *    on floor-switch or a separate small per-frame uniform; left for a
 *    follow-up rather than guessed at here.
 * 2. The buffer's CLEAR value is the renderer's ordinary (0,0,0,0), not
 *    B0-1 §2.1's specified `(255,0,0,0)` "no geometry" sentinel — three's
 *    MRT has no documented per-attachment clear-value control found in the
 *    vendored build. Consequence: "floor 0, fully indoors, no flags, zero
 *    solidity" and "nothing drawn here at all" both read as raw (0,0,0,0)
 *    today. Consumers that need to distinguish "no geometry" should check
 *    `attr.a > 0` (solidity) rather than trusting R's zero as a sentinel,
 *    until a dedicated clear pass closes this gap.
 *
 * @module vt/scene-attr
 */

import { getActiveSceneFloors } from '../foundry/index.js';
import { resolveElevationFloorIndex, isInForeground } from '../scene/index.js';
import { buildWorldSpaceOutdoorsGate } from '../effects/index.js';

/**
 * The MRT descriptor for `scene.color` — same shape every OTHER
 * `describeSceneColor()`-style descriptor in `vt-pan-viewer.js` uses, plus
 * the second, real attribute attachment. Kept here (not inlined in the
 * viewer) so the exact channel format (RGBA8/Nearest/NoColorSpace, per B0-1
 * §2.1) has one written-down source.
 *
 * @param {object} args
 * @param {*} args.THREE - the injected THREE namespace.
 * @param {number} args.resolvedW @param {number} args.resolvedH - device px.
 * @returns {object} a `ThreeAllocator`-shaped descriptor.
 */
export function describeSceneAttrMrt({ THREE, resolvedW, resolvedH }) {
  return {
    resolvedW,
    resolvedH,
    screenSized: true,
    // Attachment 0 (color) keeps scene.color's EXISTING shape — HalfFloat/
    // linear/NoColorSpace — set at the top level, same as every other
    // describeSceneColor()-style descriptor already in this file.
    type: THREE.HalfFloatType,
    colorSpace: THREE.NoColorSpace,
    filter: 'linear',
    depth: false,
    mrtCount: 2,
    attachments: [
      { outputName: 'output' },
      {
        outputName: 'attr',
        filter: 'nearest',
        type: THREE.UnsignedByteType,
        colorSpace: THREE.NoColorSpace,
      },
    ],
  };
}

/**
 * The renderer-global safe default: every material that does NOT declare its
 * own `mrtNode` gets `attr = vec4(0,0,0,0)` for free — see this module's own
 * "THE SAFE DEFAULT" header section for why that is provably a no-op write
 * under NormalBlending. Built once per viewer instance (it references
 * `TSL.output`, a stable symbolic node — no per-frame allocation needed).
 *
 * @param {*} THREE
 * @returns {*} an `MRTNode`, ready for `renderer.setMRT(...)`.
 */
export function buildSceneAttrZeroMrt(THREE) {
  const { mrt, output, vec4 } = THREE.TSL;
  return mrt({ output, attr: vec4(0, 0, 0, 0) });
}

/**
 * Pack the four real B0-1 channels into one vec4, 0..1 per channel (the
 * shape an RGBA8 `attr` attachment expects — three's own uint8 conversion on
 * write handles the quantization, same as any ordinary 8-bit render target).
 *
 * @param {*} TSL
 * @param {object} args
 * @param {*} args.floorIndex01 - R: this item's floor index / 255 (a uniform,
 *   resolved once at build time — see `resolveItemFloorAttrUniforms` below).
 * @param {*} args.outdoors01 - G: `buildWorldSpaceOutdoorsGate`'s result, or
 *   `null` if no outdoors mask is available (reads as 0 — "indoors" — rather
 *   than compiling out, since G is real per-pixel data here, not a feature
 *   gate; a floor with no authored outdoors mask is legitimately "all indoors").
 * @param {*} args.presenceBits01 - B: presence bitfield / 255 (a uniform).
 * @param {*} args.solidityAlpha - the material's own alpha (the SAME node
 *   driving its colour blend — never a second, independently-computed alpha).
 *   ⚠️ NOT written to A verbatim any more — see `ATTR_SOLIDITY_ALPHA_TEST_
 *   THRESHOLD`'s own doc, just below, for why this function alpha-TESTS it
 *   instead of packing it through.
 * @returns {*} a vec4 node.
 */
export function packFloorAttr(TSL, { floorIndex01, outdoors01, presenceBits01, solidityAlpha }) {
  const { vec4, float } = TSL;
  const g = outdoors01 ?? float(0);
  // ============================================================================
  // ⚠️ ALPHA-TEST, NOT A CONTINUOUS BLEND (2026-08-04, ROUND 15) — READ BEFORE
  // PACKING A NEW VALUE FIELD (as opposed to a single boolean bit) INTO `attr`
  // ============================================================================
  // This vec4's own 4th component IS the blend factor THREE's fixed-function
  // alpha blending uses for this MRT attachment: `attr_new = attr_old·(1−a) +
  // attr_src·a` (see `PRESENCE_BIT_OCCLUDES_BACKGROUND`'s own header, and
  // [[feedback_alpha_blended_write_needs_wide_margin]]). Packing the raw,
  // CONTINUOUS `solidityAlpha` there — as this function did before this round
  // — means a merely TRANSLUCENT fragment (an author's soft-painted overlay,
  // a compressed/mip-blurred edge, anything short of bit-exact 1.0) scales the
  // ENTIRE packed byte by that same fraction. A margin (bit 7's own fix)
  // protects ONE boolean bit surviving a threshold; it cannot protect a
  // multi-bit VALUE field (receiver-elevation level, bits 2-5) — attenuating
  // the byte's raw integer value does not attenuate each sub-field's bits
  // independently, so a scaled byte decodes to arithmetic garbage with no
  // relationship to either endpoint. Live proof: a Tile with `restrictsLight`
  // painted at ~35% opacity (byte 169) blended against a background (byte 0)
  // produced byte 60 — decoded receiver level 15, matching NEITHER item,
  // reproducing on every probed point under that tile regardless of its true
  // elevation. `[[keyhole-light-elevation-occlusion]]` round 14→15 is the full
  // live investigation (two independent agent traces plus a legacy-renderer
  // comparison) that found this.
  //
  // The fix: binarize the blend factor itself. Below the threshold, this
  // fragment contributes NOTHING (`attr_old` passes through at its own 100%
  // weight); at or above, it writes as though fully solid (a hard overwrite
  // via the SAME blend equation, α forced to exactly 1). This turns the
  // question back into the binary "is there a surface here" the whole
  // hole-stack model already assumes for occlusion purposes, and — critically
  // — composes correctly no matter how many soft layers stack on one pixel
  // (a pre-divide/"unpremultiply" alternative was considered and rejected for
  // exactly this reason: it only cancels cleanly for a single overlapping
  // layer). The VISIBLE colour/light blend is a DIFFERENT MRT attachment,
  // reading `output.a` directly, never this function — an author's soft-edged
  // art still looks soft on screen; only this invisible metadata channel's
  // occlusion classification stops being an arithmetic accident.
  const solidBinary = solidityAlpha
    .greaterThanEqual(float(ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD))
    .select(float(1), float(0));
  return vec4(floorIndex01, g, presenceBits01, solidBinary);
}

/**
 * The alpha-test cutoff `packFloorAttr` applies to its own 4th (blend-driving)
 * component — see that function's own "ALPHA-TEST, NOT A CONTINUOUS BLEND"
 * header for the live bug this fixes.
 *
 * 0.5, not a tighter value — the SAME "a wide margin, not a narrow one" lesson
 * `PRESENCE_BIT_OCCLUDES_BACKGROUND`'s own history already taught this file
 * once (see that constant's own "THE POLARITY IS THE WHOLE POINT" header): a
 * fragment must be at least HALF-solid to count as solid at all, symmetric in
 * both directions — a genuinely near-opaque fragment (alpha ~0.9, ordinary
 * compression/mip noise) survives comfortably; a genuinely soft overlay
 * (alpha ~0.35, this round's live case) is correctly excluded rather than
 * corrupting whatever solid content is already there.
 */
export const ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD = 0.5;

/**
 * Presence-bitfield bit 0 — overhead/roof (`layer-order.js#isInForeground`),
 * OR a Tile whose own Foundry `restrictions.light` is ticked
 * (`item.restrictsLight` — see `computeFloorAttrValues`'s own "A TILE'S OWN
 * 'RESTRICT LIGHTING' FLAG" comment for the full reasoning and the
 * self-block guard that scopes this to `kind === 'tile'` only).
 */
export const PRESENCE_BIT_OVERHEAD = 1;
/**
 * Presence-bitfield bit 7 (THE TOP BIT, weight 128) — 1 for art that OCCLUDES
 * a Level's own background: a Tile, or the Level's own foreground/roof image.
 * **0 for the background itself, and 0 for everything that never writes real
 * attr at all.** See `occludesBackgroundPresenceBit` for what sets it.
 *
 * ============================================================================
 * ⚠️ THE POLARITY IS THE WHOLE POINT — INVERTED 2026-08-01, AND DO NOT FLIP IT
 * ============================================================================
 * This bit shipped 2026-07-29 meaning the OPPOSITE — "1 = the Level's own
 * background is still the topmost draw here" — and `effects/specular` gated its
 * entire output on it. That polarity has a fatal property: **the buffer's clear
 * value is (0,0,0,0)** (see this module's own KNOWN GAP #2), so "a Tile is on
 * top of me" and "nothing ever wrote attr here at all" were byte-identical, and
 * BOTH turned the effect off. Any upstream failure — a material that never got
 * its `mrtNode`, a pass that didn't bind the attachment, an item drawn through a
 * path nobody remembered to wire — silently deleted the whole effect, with no
 * error anywhere and every JS status field reporting healthy.
 *
 * It did exactly that, twice, within a day of shipping. The second attempt
 * "fixed" it by widening the bit's margin (weight 4 → 128, threshold 3.5 → 64),
 * which addressed a REAL hazard — the write rides ordinary NormalBlending
 * (`attr_new = attr_old·(1−α) + attr_src·α`, α being the drawing material's own
 * post-clarity, post-occlusion alpha), so an attenuated α under-reports the bit
 * — but on evidence that has since been shown to be an artifact: specular's
 * debug channel 8, the reading that diagnosis rested on, could never display
 * this bit at all (`effects/debug-channel-select.js`).
 *
 * Inverting removes the class rather than widening the margin against it:
 *
 * | state                          | raw b | old gate  | NEW gate |
 * | ------------------------------ | ----- | --------- | -------- |
 * | background is topmost          | 0     | **CLOSED** if the write was ever attenuated | OPEN |
 * | a Tile / roof drew over it     | 128·α | open→closed only at full α | CLOSED |
 * | attr never written / cleared   | 0     | **CLOSED — the whole effect dies** | OPEN |
 *
 * The α-attenuation hazard survives inversion but changes SIGN, which is what
 * makes it tolerable: a weakly-drawn occluder now under-reports occlusion (the
 * shine leaks through a faint tile — visible, local, cosmetic) instead of
 * under-reporting presence (the effect vanishes everywhere — invisible, global,
 * and indistinguishable from a dead shader). A correctness gate is allowed to
 * be wrong at the edges; it is not allowed to have "off" as its failure mode.
 * `feedback_count_silent_preconditions`: delete a precondition rather than
 * repair one.
 *
 * The wide margin is KEPT regardless (weight 128, threshold 64/255 — tolerating
 * an occluder's write surviving at 50% strength), because the reasoning for it
 * was sound even though its evidence was not, and because the overhead bit
 * (weight 1) must never be mistaken for this one.
 *
 * Bit 1 (weight 2, `levelsHidden`) stays reserved either way — it is
 * documented but NOT YET DERIVED (see the KNOWN GAP section below).
 */
export const PRESENCE_BIT_OCCLUDES_BACKGROUND = 128;

/**
 * The top bit of the presence bitfield for ONE item — see
 * `PRESENCE_BIT_OCCLUDES_BACKGROUND` for the polarity and why it is that way.
 *
 * ============================================================================
 * ⚠️ WHY THE LEVEL'S OWN FOREGROUND/ROOF *IS* INCLUDED
 * ============================================================================
 * `effects/specular` — the one consumer today — reads its mask from
 * `mask-authority.js#authoredStatus`, which resolves `backgroundItemOf` ONLY
 * (`scene/mask-authority.js`), never the foreground. So a roof drawn opaquely
 * over the background is exactly the same kind of occlusion as a Tile:
 * something else is now what the player actually sees at that pixel, and the
 * background's own effects must stop showing through it. Dropping the
 * foreground from this list reopens the original live bug with a roof standing
 * in for the Tile that first reported it.
 *
 * ============================================================================
 * WHAT IT IS FOR
 * ============================================================================
 * `buf:scene.attr` records whichever item drew LAST (topmost, alpha ≈ 1) at
 * each texel (this module's own "THE REAL WRITERS" section) — so reading this
 * bit back answers "did something paint over the Level's background here". That
 * is the per-pixel occlusion `effects/specular` was missing entirely: its
 * floor-index gate (channel R) only tells two FLOORS apart, and a same-floor
 * Tile shares its background's floor index — so a Tile drawn above the
 * background still let the background's OWN shine glow through it (reported
 * live, 2026-07-29).
 *
 * ⚠️ A token does NOT set it, and that is unchanged scope, not an oversight:
 * tokens never become real attr writers at all (`SPECULAR.deferredRungs
 * .tokenOcclusion`), so they leave whatever the art beneath them wrote.
 *
 * @param {{kind?: string}} [item] - the drawable's own item descriptor.
 * @returns {number} `PRESENCE_BIT_OCCLUDES_BACKGROUND` or 0.
 */
export function occludesBackgroundPresenceBit(item) {
  const kind = item?.kind;
  return kind === 'tile' || kind === 'levelForeground' ? PRESENCE_BIT_OCCLUDES_BACKGROUND : 0;
}

/**
 * PRESENCE BITS 2-5 (weights 4,8,16,32) — how far above ITS OWN FLOOR's
 * `elevationBottom` a receiver sits, quantized to 16 levels. Added
 * 2026-08-03 for `effects/lighting/point-light-illumination.js`'s height
 * gate ("a lantern's own cover, sitting above the flame, should not be lit by
 * it"; "a tree canopy near the top of its floor should not light up from a
 * lamp that never reaches that high").
 *
 * ============================================================================
 * WHY THESE FOUR BITS, AND NOT BIT 1 OR BIT 6
 * ============================================================================
 * Bit 1 (weight 2) is ALREADY RESERVED for `levelsHidden` (this module's own
 * KNOWN GAP #1) — a DIFFERENT axis of information (is this item's floor
 * below the CURRENTLY VIEWED floor, a per-FRAME question) that must not be
 * silently squatted on by a per-BUILD-time field. Bit 6 (weight 64) is
 * `PRESENCE_BIT_OCCLUDES_BACKGROUND`'s own read THRESHOLD
 * (`SPECULAR_OCCLUDES_BACKGROUND_THRESHOLD01 = 64/255`) — a receiver-
 * elevation value reaching 64 on its own (occluder bit clear) would read as
 * "occluded" to that consumer, a false positive. Bits 2-5 are the only
 * contiguous span that touches neither: their own maximum (4+8+16+32=60)
 * stays under 64 even summed with bit 0 (61), and ORing in bit 7 (128) still
 * reads unambiguously above 64 regardless of this field's value — the two
 * consumers can never be confused for one another.
 *
 * ============================================================================
 * ⚠️ THIS FIELD IS ONLY HALF AN ELEVATION — R (THE FLOOR INDEX) IS THE OTHER
 * ============================================================================
 * A basement floor at -40 and a tower floor at +400 quantize on the SAME
 * scale here: `RECEIVER_ELEVATION_RANGE_UNITS` is a span measured from THIS
 * item's own floor's ground, not an absolute world coordinate — the same idea
 * `VegetationKind#passiveElevationFraction` expresses as a 0..1 fraction.
 *
 * **That makes this field, ON ITS OWN, unable to compare two things on
 * DIFFERENT floors — and a consumer that forgets it will silently ship a
 * severe bug.** It already happened once (2026-08-03, found live): `point-
 * light-illumination.js`'s height gate compared this value against a light's
 * own floor-relative height and nothing else, so a light at -20 on a floor
 * spanning [-20, 0) and an upper storey's floorboards at +5 on a floor
 * spanning [5, 15) BOTH read as "0 above my own floor". The gate concluded
 * they were at the same height and passed half of a blown-out light straight
 * through two floors of solid geometry.
 *
 * The fix lives in the CONSUMER, not here (this field is doing exactly what
 * it says): pair it with `attr.R`, the floor index written by this same
 * function, into a single comparable rank — see `effects/lighting/point-
 * light-illumination.js#elevationRank`. **Any future consumer of these bits
 * that spans floors must do the same.** Within ONE floor (the case the
 * fraction override below serves) this field alone is sufficient and correct.
 */
export const RECEIVER_ELEVATION_LEVELS = 16; // 0..15

/**
 * The world-elevation-unit span the 16 levels above cover, measured from an
 * item's own floor's `elevationBottom`. A receiver further than this clamps
 * to the topmost bucket (treated as "very high", never wrapping back around
 * to "ground").
 *
 * ⚠️ **CUT FROM 100 TO 15 (2026-08-03, ROUND 2 OF THE LIVE REPORT) — the
 * first value was an ungrounded guess and it was roughly 10× too coarse.**
 * A live test (light elevation 5, cover tile elevation 9-10 — a 4-5 unit
 * real gap) still leaked ~26% of the light through at RANGE=100: 16 levels
 * spread across 100 units gives a ~6.7-unit quantization STEP, which alone
 * eats more than the entire real-world gap being tested. The fix isn't "add
 * more bits" (there are none free — see this field's own bit-choice doc);
 * it's picking a range that matches THIS PROJECT'S OWN actual scale. Real
 * authored floor bands in this codebase's own reference maps (the half-
 * open-band bug's River Town Bridge fixture, `feedback_half_open_band_
 * excludes_its_own_member`) run ~10 units per floor — so "how far above its
 * own floor's ground might an ordinary drawable sit" is realistically
 * single-digit-to-low-double-digit, not up to 100. 15 gives an EXACT
 * (zero-rounding-error) 1-unit-per-level step for the whole-number
 * elevations an author actually types in, and still covers 1.5× a typical
 * floor's own height before clamping.
 *
 * Unlike the exact floor-INDEX match `PRESENCE_BIT_OCCLUDES_BACKGROUND`'s
 * neighbour channel needs, this field only ever feeds an INEQUALITY (`is
 * the light at or above roughly this height`), so quantization noise softens
 * a transition band rather than flipping a hard match — a coarser field
 * here is a smaller risk than it would be for an exact-match channel. See
 * `effects/lighting/point-light-illumination.js#HEIGHT_GATE_TOLERANCE_UNITS`
 * / `#HEIGHT_GATE_SOFTNESS_UNITS` for the matching gate band.
 */
export const RECEIVER_ELEVATION_RANGE_UNITS = 15;

/**
 * Quantize "how far above its OWN floor's ground" a receiver sits into the
 * discrete bucket `resolveItemFloorAttrUniforms` packs into presence bits
 * 2-5. Pure — the CPU-side twin of the shader's own decode
 * (`point-light-illumination.js`), so a test can predict a shader reading
 * without a GPU (`feedback_smooth_output_hides_ported_bugs`).
 *
 * @param {number} elevationAboveFloorBottom - raw world-elevation units
 *   (item elevation minus its own floor's `elevationBottom`); may be negative
 *   (clamps to 0 — "at or below my own floor's ground reads as ground level").
 * @returns {number} an integer in [0, RECEIVER_ELEVATION_LEVELS - 1].
 */
export function quantizeReceiverElevationAboveFloor(elevationAboveFloorBottom) {
  const raw = Number.isFinite(elevationAboveFloorBottom) ? elevationAboveFloorBottom : 0;
  const clamped = Math.max(0, Math.min(RECEIVER_ELEVATION_RANGE_UNITS, raw));
  return Math.round((clamped / RECEIVER_ELEVATION_RANGE_UNITS) * (RECEIVER_ELEVATION_LEVELS - 1));
}

/**
 * The inverse quantization — an approximate world-elevation-units value for
 * a decoded level, so a caller (or a test) can reason in real units rather
 * than raw bucket indices. Rounds to the bucket's own step, never claims
 * more precision than `RECEIVER_ELEVATION_LEVELS` actually carries.
 *
 * @param {number} level - 0..RECEIVER_ELEVATION_LEVELS-1 (clamped if outside).
 * @returns {number} world-elevation units above the receiver's own floor bottom.
 */
export function receiverElevationLevelToUnits(level) {
  const lvl = Number.isFinite(level) ? Math.max(0, Math.min(RECEIVER_ELEVATION_LEVELS - 1, level)) : 0;
  return (lvl / (RECEIVER_ELEVATION_LEVELS - 1)) * RECEIVER_ELEVATION_RANGE_UNITS;
}

/**
 * Decode JUST the receiver-elevation sub-field (bits 2-5) out of a raw
 * (0..255) presence-bits byte, ignoring bit 0 (overhead), bit 1 (reserved)
 * and bit 7 (occludes-background) regardless of their state — the exact
 * mirror of the TSL decode `point-light-illumination.js` uses
 * (`floor(mod(byte, 64) / 4)`), so this is the Node-testable CPU twin of
 * that shader arithmetic, not a second, independently-derived formula.
 *
 * @param {number} presenceBitsByte - 0..255.
 * @returns {number} the decoded level, 0..RECEIVER_ELEVATION_LEVELS-1.
 */
export function decodeReceiverElevationLevel(presenceBitsByte) {
  const b = Number.isFinite(presenceBitsByte) ? Math.round(presenceBitsByte) : 0;
  const low6 = ((b % 64) + 64) % 64; // strip bit 6 (64) and bit 7 (128); defensive against a negative input
  return Math.floor(low6 / 4); // strip bit 0 (1) and bit 1 (2)
}

/**
 * Decode JUST `PRESENCE_BIT_OVERHEAD` (bit 0) out of a raw (0..255)
 * presence-bits byte — the exact mirror of `point-light-illumination.js#
 * buildHeightGateNode`'s TSL decode (`mod(byte, 2)`), the CPU twin for the
 * SAME reason `decodeReceiverElevationLevel` exists: one arithmetic shape,
 * not two independently-typed ones that can silently drift apart.
 *
 * @param {number} presenceBitsByte - 0..255.
 * @returns {number} 0 or 1.
 */
export function decodeOverheadBit(presenceBitsByte) {
  const b = Number.isFinite(presenceBitsByte) ? Math.round(presenceBitsByte) : 0;
  return ((b % 2) + 2) % 2; // defensive against a negative input, same posture as decodeReceiverElevationLevel
}

/**
 * `buf:scene.attr`'s R (floor index) and B-bits 0/2-5 (overhead/roof,
 * receiver elevation) for ONE item. Moved here from `vt-pan-viewer.js`
 * (2026-07-25) purely to stay under the size ratchet's per-file/per-function
 * cap — same logic, new home; see `docs/planning/VT-Pan-Viewer-Extraction.md`
 * trap #6 for why a NESTED helper wouldn't have bought anything (this one is
 * a genuine sibling module, not a function nested inside `startVtPanViewer`,
 * so it counts as its own file from the start).
 *
 * ⚠️ **NOT build-time-only any more (2026-08-03) — see `refreshItemFloorAttr
 * Uniforms`'s own header for the live bug this used to cause.** An item's
 * floor MEMBERSHIP is static for its lifetime, but resolving it depends on
 * `getActiveSceneFloors`, whose OUTPUT (the index each floor gets) is a
 * function of every OTHER floor's own state too — so "static input" does not
 * imply "safe to resolve exactly once and never check again," which is
 * exactly the assumption that shipped here originally and broke silently.
 * This function is pure and cheap enough to call every frame; the caller
 * decides the cadence, this file no longer assumes "once" is fine.
 *
 * Uses `getActiveSceneFloors` + `scene/layer-order.js#resolveElevationFloor
 * Index`/`isInForeground` — the SAME Level data every other floor-aware
 * reader in the viewer already reads (`readElevationFilteredDarknessRegions`,
 * `bakeWindField`), never a second, private floor-index scheme.
 *
 * Wrapped fail-open, same posture as those readers: a lookup failure (no
 * active scene, no matching floor) falls back to the CURRENTLY VIEWED floor
 * (`viewedFloorIndex`) rather than a fabricated "no geometry" sentinel —
 * geometry genuinely exists here, we just couldn't identify which Level it
 * belongs to, and reporting "255 = nothing drawn" would be a lie.
 *
 * ⚠️ KNOWN GAP, stated honestly (this module's own header, "KNOWN GAP"
 * section): B-bit-1 (levelsHidden / below the VIEWED floor) is NOT derived
 * here — it needs the CURRENTLY VIEWED floor, compared against THIS item's
 * OWN floor. That comparison belongs to a per-frame reader; left for a
 * follow-up (this round's fix makes the INPUTS to that future comparison
 * live, but does not add the comparison itself).
 *
 * @param {object} args
 * @param {object} args.item - the drawable's own item descriptor (`item.key
 *   .elevation` and `item.kind` are read — the latter for bit 7, see
 *   `occludesBackgroundPresenceBit`).
 * @param {number} args.viewedFloorIndex - the CURRENTLY viewed floor
 *   (`view.floorIndex` in the viewer) — the fallback when the real lookup
 *   fails, never a fabricated sentinel.
 * @param {object|null} args.sceneDoc - `globalThis.canvas?.scene ?? null`,
 *   read by the CALLER (not here — this module has no Foundry-global access
 *   of its own; `foundry/adapter-only` scopes that pattern to the viewer's
 *   own established `readElevationFilteredDarknessRegions`-style call sites).
 * @param {(msg: string, err: unknown) => void} [args.logError] - defaults to
 *   a no-op; the caller's own logger, so a lookup failure is reported through
 *   the ONE log door (`log/one-door`), never a private console call here.
 * @param {number} [args.receiverHeightFt] - when finite AND this item's
 *   resolved floor has a BOUNDED band (`elevationTop` declared, not
 *   Infinity), REPLACES `item.key.elevation` for the receiver-elevation
 *   sub-field (presence bits 2-5) ONLY, resolved as `bottom + receiverHeightFt`
 *   — the SAME `bottom + heightFt` shape `vegetation-render.js#
 *   vegetationCanopyElevation` uses for sort order (2026-08-06 — renamed from
 *   `receiverElevationFraction01`/a `bottom + (top-bottom)*fraction` shape
 *   when vegetation moved off a clamped-fraction model onto a real,
 *   unbounded height; same role, same gate, new units). Floor resolution and
 *   the overhead check still use the item's own real elevation/`levelId`,
 *   unchanged. For a vegetation Case-2 overlay (a tree/bush drawn ON a host
 *   tile, not the tile itself): the CANOPY's own real height belongs here,
 *   since the overlay's true floor is still its HOST's, but its
 *   light-reachable HEIGHT is the canopy's, not the host's near-ground
 *   placement — and passing a HEIGHT (not a pre-resolved absolute elevation)
 *   means the caller never needs to separately resolve the floor's own band;
 *   this function already has it in scope. An unbounded band falls back to
 *   the item's own elevation, unchanged — the same "no scale to work
 *   against" posture `stampVegetationRenderOrders` takes for its own
 *   sort-order fallback. Omitted (the overwhelming common case — background
 *   art, tiles, Case-1 embedded vegetation) → identical to before this
 *   parameter existed.
 * @returns {{floorIndex01: number, presenceBits01: number}} plain 0..1
 *   numbers — never a uniform. Callers that need TSL uniforms use
 *   `resolveItemFloorAttrUniforms`/`refreshItemFloorAttrUniforms` below.
 */
function computeFloorAttrValues({ item, viewedFloorIndex, sceneDoc, logError, receiverHeightFt }) {
  // Bit 7 depends only on `item.kind`, never on the floor lookup below, so it
  // is folded in BEFORE the try block — every return path (early-return on no
  // floors, on no resolved floor, or the catch below) carries it correctly,
  // the same posture the overhead bit already has for its own success path.
  const occluderBit = occludesBackgroundPresenceBit(item);
  let floorIndex01 = viewedFloorIndex / 255;
  let presenceBits01 = occluderBit / 255;
  try {
    const floorsResult = getActiveSceneFloors(sceneDoc);
    if (!floorsResult.ok || !floorsResult.floors.length) return { floorIndex01, presenceBits01 };
    const elevation = item?.key?.elevation ?? 0;
    // ⚠️ MEMBERSHIP FIRST, THRESHOLD ONLY AS FALLBACK (memory:
    // feedback_membership_beats_derived_threshold). Live bug, 2026-08-02: the
    // author's River Town Bridge map showed NO sun shadow at all while the
    // identical data rendered a near-black shadow in Shader Lab.
    //
    // ROOT CAUSE, and it is a straight two-authorities-disagree: a Level's
    // FOREGROUND art sits at that Level's own `elevation.top` — that is
    // exactly what `isInForeground` (same module as the resolver below)
    // DEFINES as "this Level's foreground", `elevation >= top`. But
    // `resolveElevationFloorIndex`'s band is half-open, `[bottom, top)`, so
    // `elevation === top` falls OUT of the owning Level and INTO the one
    // above. Every Level's own foreground was therefore stamped into
    // `buf:scene.attr`.R as the floor ABOVE it. On the bridge map floor 0's
    // band is [0, 10) and its foreground sits at 10, so the water surface —
    // most of the visible map — claimed to be floor 1.
    //
    // `environmental-light.js` then gates the baked sun-shadow field to
    // pixels whose `attr.r` matches the BAKED floor, and `mix(1, sunVis,
    // floorMatch)` returns a provable 1 on a mismatch: no shadow, at any
    // strength, with nothing logged. (The mirror image is the long-standing
    // "shadow overlaid on the upper floor" report — same single cause.)
    //
    // The fix is not to widen the band (that would hand a genuine
    // next-floor-bottom drawable to the floor below — the two Levels really
    // do share that number). A Level's background/foreground are AUTHORED
    // members of that Level; `item.levelId` states it outright
    // (`foundry/scene-layers.js` — the owning level id for level art, `''`
    // for tiles, so a loose tile still falls through to the elevation
    // lookup, which is the right answer for something with no owner).
    // `vt-pan-viewer.js`'s own floor-id lookup already prefers `levelId`
    // this way; this call site was the one place that did not.
    const owned = item?.levelId ? floorsResult.floors.find((f) => f.id === item.levelId) : null;
    const resolved = owned
      ? { index: owned.index, floor: owned }
      : resolveElevationFloorIndex(floorsResult.floors, elevation);
    if (!resolved) return { floorIndex01, presenceBits01 };
    floorIndex01 = resolved.index / 255;
    // ⚠️ THE OVERHEAD TEST USES A SEPARATE, EPSILON-ADJUSTED LOOKUP (2026-08-03,
    // round 8 — found writing THIS round's own Shader Lab proof, not guessed).
    // A levelId-less TILE (every real Tile — `levelId` is `''` always,
    // `foundry/scene-layers.js`'s own doc) deliberately raised to EXACTLY its
    // intended floor's own `elevationTop` — the one natural way to say "mark
    // this as that floor's roof" — falls straight into the SAME half-open-band
    // trap `feedback_half_open_band_excludes_its_own_member` already named
    // once: `resolveElevationFloorIndex`'s `[bottom, top)` puts elevation===top
    // in the band ABOVE, so `resolved.floor` above is the WRONG floor here, and
    // testing `isInForeground` against ITS top (a strictly higher number) can
    // never pass for a modest, intentional raise. A Level's OWN foreground
    // never hits this (it carries `levelId`, resolved by MEMBERSHIP two lines
    // up, per that same fix's own "membership first" rule) — this is the
    // SAME lesson, recurring in a consumer that did not exist when it was
    // first learned.
    //
    // The fix is scoped to ONLY this lookup — R (`uFloorIndex01` above) is
    // UNCHANGED, still the exact resolution every other consumer (sun-shadow
    // floor-gating, specular, this module's own elevationRank floor index)
    // already relies on; widening that broadly-shared behaviour would risk
    // regressing all of them for one narrow question. Subtracting a tiny
    // epsilon before the SAME real `resolveElevationFloorIndex` (never a
    // second, hand-rolled band search) re-asks it "which floor was I an
    // instant BEFORE this elevation" — at an exact boundary that is the LOWER
    // floor, exactly the "AT my own floor's ceiling, not the next floor's
    // ground" reading `isInForeground` needs. Elsewhere in the band (not on a
    // boundary) the epsilon changes nothing.
    // `owned` (when present) is a RAW floor object (`floorsResult.floors.find`'s
    // own return); `resolveElevationFloorIndex`'s result is `{index, floor}` —
    // two genuinely different shapes (`resolved` above already reconciles them
    // once; this is that SAME reconciliation, done again for the epsilon-
    // adjusted lookup, not a shortcut through `resolved` itself).
    const overheadFloor =
      owned ?? resolveElevationFloorIndex(floorsResult.floors, elevation - 1e-6)?.floor ?? resolved.floor;
    const top = overheadFloor.elevationTop ?? Infinity;
    // ⚠️ A TILE'S OWN "RESTRICT LIGHTING" FLAG IS A SECOND, INDEPENDENT
    // OVERHEAD SIGNAL (2026-08-04 — the lantern-cover report, round 9).
    // `isInForeground` alone answers "did this item's elevation cross ITS
    // FLOOR'S declared ceiling" — a coarse, whole-floor-relative heuristic
    // that has nothing to do with the specific object the author flagged.
    // Foundry's OWN mechanism for this exact feature is neither numeric nor
    // floor-relative: a Tile with `restrictions.light` ticked
    // (`common/documents/tile.mjs` — the vendored v14 source) blocks light
    // through it, full stop, regardless of what floor band its elevation
    // happens to land in. `foundry/scene-layers.js#collectTiles` already
    // reads this into `item.restrictsLight`, faithfully, and it has sat
    // unconsumed ever since — the height gate (point-light-illumination.js)
    // was built in a completely different, later session that had no reason
    // to reopen that already-committed file. See
    // [[feedback_unconsumed_api_rots_silently]].
    //
    // Scoped to `item.kind === 'tile'` ONLY — never OR'd in unconditionally.
    // A Level's own BACKGROUND art gets `restrictsLight: true` UNCONDITIONALLY
    // (`collectLevelTextures` above, mirroring real Foundry's own
    // `primary.mjs#restrictsLight = true` for `isBackground`), so treating
    // `item.restrictsLight` as "overhead" for ANY kind would make a floor's
    // own ground set the overhead bit on itself everywhere it draws —
    // `overheadGate` ANDs into every light's falloff
    // (`point-light-illumination.js#buildHeightGateNode`), so that would
    // black out every light on every floor, unconditionally. A Tile's own
    // `restrictions.light` defaults to `false` (opt-in, per-object) and this
    // module has no reason to treat Level foreground/background any
    // differently than it already does — floor-index dominance in the fine
    // gate already handles a lower light shining up through an UPPER floor's
    // own background correctly (a Level's background sits on a strictly
    // higher floor's rank, which the fine gate alone already outranks).
    const overhead = isInForeground(elevation, { top }) || (item?.kind === 'tile' && item?.restrictsLight === true);
    // RECEIVER ELEVATION (bits 2-5) — see that constant's own doc for the bit
    // choice and the "relative to MY OWN floor" reasoning. `bottom` defaults
    // to 0 (an undeclared elevationBottom, same fallback resolveElevation
    // FloorIndex itself uses) rather than leaving this item's height
    // undefined relative to a floor with no declared ground. The HEIGHT
    // override (see this function's own param doc) swaps ONLY the height fed
    // into the quantizer — floor membership above is still resolved from the
    // item's real elevation/levelId, never the override.
    const bottom = resolved.floor.elevationBottom ?? 0;
    const bandIsBounded = Number.isFinite(top);
    const heightElevation = Number.isFinite(receiverHeightFt) && bandIsBounded ? bottom + receiverHeightFt : elevation;
    const elevationLevel = quantizeReceiverElevationAboveFloor(heightElevation - bottom);
    presenceBits01 = (occluderBit + (overhead ? PRESENCE_BIT_OVERHEAD : 0) + elevationLevel * 4) / 255;
  } catch (err) {
    logError?.('buf:scene.attr floor-index lookup (getActiveSceneFloors) failed — using the viewed floor:', err);
  }
  return { floorIndex01, presenceBits01 };
}

/**
 * Build this item's `buf:scene.attr` uniforms — thin wrapper over
 * `computeFloorAttrValues`, which does the actual resolution (and which
 * `refreshItemFloorAttrUniforms` below re-runs to keep these LIVE).
 *
 * @param {object} args
 * @param {*} args.THREE - the injected THREE namespace.
 * @param {object} args.item - the drawable's own item descriptor (`item.key
 *   .elevation` and `item.kind` are read — the latter for bit 7, see
 *   `occludesBackgroundPresenceBit`).
 * @param {number} args.viewedFloorIndex - the CURRENTLY viewed floor
 *   (`view.floorIndex` in the viewer) — the fallback when the real lookup
 *   fails, never a fabricated sentinel.
 * @param {object|null} args.sceneDoc - `globalThis.canvas?.scene ?? null`,
 *   read by the CALLER (not here — this module has no Foundry-global access
 *   of its own; `foundry/adapter-only` scopes that pattern to the viewer's
 *   own established `readElevationFilteredDarknessRegions`-style call sites).
 * @param {(msg: string, err: unknown) => void} [args.logError] - defaults to
 *   a no-op; the caller's own logger, so a lookup failure is reported through
 *   the ONE log door (`log/one-door`), never a private console call here.
 * @param {number} [args.receiverHeightFt] - when finite AND this item's
 *   resolved floor has a BOUNDED band (`elevationTop` declared, not
 *   Infinity), REPLACES `item.key.elevation` for the receiver-elevation
 *   sub-field (presence bits 2-5) ONLY — see `computeFloorAttrValues`'s own
 *   body for the full reasoning. Omitted (the overwhelming common case —
 *   background art, tiles, Case-1 embedded vegetation) → identical to before
 *   this parameter existed.
 * @returns {{uFloorIndex01: object, uPresenceBits01: object}} two TSL
 *   uniforms — call `refreshItemFloorAttrUniforms` on this SAME pair to keep
 *   them live; see that function's own header for why that matters.
 */
export function resolveItemFloorAttrUniforms({ THREE, item, viewedFloorIndex, sceneDoc, logError, receiverHeightFt }) {
  const { uniform, float } = THREE.TSL;
  const { floorIndex01, presenceBits01 } = computeFloorAttrValues({
    item,
    viewedFloorIndex,
    sceneDoc,
    logError,
    receiverHeightFt,
  });
  return { uFloorIndex01: uniform(float(floorIndex01)), uPresenceBits01: uniform(float(presenceBits01)) };
}

/**
 * ⚠️ THE FIX FOR A REAL LIVE BUG (2026-08-03): an item's floor membership used
 * to be resolved EXACTLY ONCE, at whatever moment its material happened to be
 * built, and NEVER AGAIN — this module's own return doc used to say so
 * outright ("never updated again after this call"). Live report: specular
 * worked on the basement and ground floor of a scene but was completely
 * invisible on the newest, uppermost floor — the channel probe showed `mask`/
 * `strength`/`tint`/`presence`/`islands` all reading real, healthy values (the
 * mask genuinely loaded) while `floorGate`'s floor-match bit read exactly 0 at
 * EVERY point on that floor, including a non-metallic control point — i.e.
 * this ONE floor's background art disagreed with the viewer's own current
 * floor number, uniformly, and a full client reload did NOT fix it (ruling
 * out "just a stale cache from earlier this session").
 *
 * `getActiveSceneFloors` (this module's own data source) is a pure,
 * deterministic function of the CURRENT scene document — it caches nothing
 * itself. But the OLD code only ever ran it the one time a background/tile/
 * vegetation material was first built, which can happen at a different moment
 * than every OTHER consumer of "which floor is this" settles on the same
 * answer (residency, mask discovery and the viewer's own floor-switch path
 * each read the floor list on THEIR OWN schedule) — and once wrong, nothing
 * ever asked again.
 *
 * The fix: make this a genuinely LIVE value, the same way `specular-render.
 * js#setFloorIndex` already is for the VIEWED floor. `vt-pan-viewer.js`'s
 * `syncAllFloorAttrUniformsForFrame` calls this every frame for every item
 * that received uniforms from `resolveItemFloorAttrUniforms`/`buildRealFloor
 * AttrMrtNode` — cheap (one array scan per item, no shader recompilation,
 * just writing `.value` on already-built uniforms) and self-correcting: even
 * if a bake races or a floor's rank shifts, the NEXT frame fixes it.
 *
 * @param {{uFloorIndex01: object, uPresenceBits01: object}} uniforms - the
 *   SAME pair `resolveItemFloorAttrUniforms` returned for this item — updated
 *   in place, never replaced.
 * @param {object} args - identical shape to `resolveItemFloorAttrUniforms`'s
 *   own args, minus `THREE` (nothing here builds a TSL node).
 */
export function refreshItemFloorAttrUniforms(uniforms, args) {
  const { floorIndex01, presenceBits01 } = computeFloorAttrValues(args);
  uniforms.uFloorIndex01.value = floorIndex01;
  uniforms.uPresenceBits01.value = presenceBits01;
}

/**
 * The whole "become a real writer" recipe, ONE call — `resolveItemFloor
 * AttrUniforms` + `buildWorldSpaceOutdoorsGate` + `packFloorAttr` + `mrt(...)`.
 * Both real-writer call sites in `vt-pan-viewer.js` (`buildWholeImageMaterial`,
 * `buildVegetationMaterial`'s Case-1 embedded form) were duplicating this
 * exact five-step sequence; factored here so there is ONE place it can drift.
 *
 * ⚠️ SOLIDITY ALPHA DEFAULTS TO `TSL.output`, AND THAT DEFAULT IS ONLY SAFE
 * FOR AN ITEM WITH NO OCCLUSION FADE. Read this before wiring a new caller.
 *
 * Original trap (live crash, 2026-07-25): the first draft took
 * `solidityAlpha` as a param fed by the caller capturing its own `colorNode`'s
 * final alpha via a JS closure variable set INSIDE that material's
 * `Fn(() => {...})()` body. That is broken by construction — `Fn(cb)()` does
 * NOT run `cb` synchronously; it returns a lazy call node (`FnNode.call` →
 * `ShaderCallNodeInternal`), and `cb` only executes later, when the shader
 * graph is actually walked at compile time. The closure variable was still
 * `null` the instant this function ran (confirmed live: `packFloorAttr`'s
 * `vec4(...)` received a literal `null` and TSL's `getConstNode` threw on it
 * — every whole-image tile failed to load). `TSL.output` (a `PropertyNode`
 * three itself populates via `output.assign(resultNode)` during THIS
 * material's own fragment-stage build, BEFORE the MRT merge runs) is the
 * sanctioned way to reference "this material's own computed result" —
 * reusing the same JS object across every material's graph resolves
 * correctly per material, by design (this module's own header, "THE MRT
 * MECHANISM"). Swizzling `.a` off it works regardless of its declared
 * node-type string ("output", not "vec4") — TSL swizzle access is generic,
 * resolved at codegen, not gated on the declared type.
 *
 * ============================================================================
 * ⚠️ A SECOND, DIFFERENT TRAP: `output.a` ANSWERS THE WRONG QUESTION FOR AN
 * OCCLUDABLE ITEM (live report, 2026-08-03)
 * ============================================================================
 * `output` is this material's FINAL on-screen alpha — which, for a Tile/
 * background with `occlusion.modes` set (`scene/occlusion.js`, Foundry's own
 * "a roof fades so you can see your token underneath" mechanic), already has
 * `occlusionAlphaFactor(occ)` multiplied in (`vt-pan-viewer.js#build
 * WholeImageMaterial`/`#buildVegetationMaterial`). Using THAT alpha as
 * solidity conflates two different questions with one number
 * (`feedback_one_byte_two_quantities`): "how should this pixel look on
 * screen right now" (should fade for a token standing under the roof — a
 * player-convenience concern, driven by TOKEN POSITION) vs "is there
 * physically a surface here" (should NOT fade — the roof did not move or
 * disappear; a light under it must stay occluded exactly as if no token were
 * there at all).
 *
 * Live symptom: a roof tile set to FADE occlusion mode, with a token
 * standing in the room under it (ordinary, correct, wanted gameplay — you
 * should see your own character) faded `output.a` toward 0 across the WHOLE
 * tile. `buf:scene.attr`'s alpha-blended write (`feedback_alpha_blended_
 * write_needs_wide_margin`) then ALSO faded toward the floor's own
 * underlying value, so `PRESENCE_BIT_OCCLUDES_BACKGROUND` cleared and the
 * NEW height/elevation gate (`point-light-illumination.js#buildHeightGate
 * Node`) saw "nothing above this light" — exactly the moment a token walks
 * into a lit room, the room's own point light stopped being occluded by its
 * own roof. Three rounds of Shader Lab work never caught it because the
 * bench's synthetic roof had NO occlusion concept at all — an idealised
 * input `feedback_bench_must_build_inputs_like_production` exists to warn
 * against.
 *
 * Fix: an OPTIONAL `solidityAlpha` param, a genuine pre-built TSL node (never
 * a closure variable — the ORIGINAL trap above still applies), representing
 * the item's PHYSICAL presence before any occlusion-convenience fade. Omit
 * it for an item with no occlusion concept (every existing call site except
 * the two below) and this function is byte-identical to before.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {object} args.item
 * @param {number} args.viewedFloorIndex
 * @param {object|null} args.sceneDoc
 * @param {Function} [args.logError]
 * @param {object} args.envLight - needs `.uOutdoorsRect`/`.outdoorsTexNode`.
 * @param {number} [args.receiverHeightFt] - forwarded verbatim to
 *   `resolveItemFloorAttrUniforms` — see that function's own param doc.
 * @param {*} [args.solidityAlpha] - a real, already-constructed TSL node (the
 *   item's PRE-occlusion-fade alpha). Omit to fall back to `TSL.output.a`
 *   (this material's own final on-screen alpha) — correct for anything with
 *   no occlusion fade, WRONG for an occludable item (see above).
 * @returns {{mrtNode: *, floorAttrUniforms: {uFloorIndex01: object,
 *   uPresenceBits01: object}}} `mrtNode` — assign to `material.mrtNode`, same
 *   as before. `floorAttrUniforms` — ⚠️ NEW (2026-08-03): retain this and
 *   pass it to `refreshItemFloorAttrUniforms` every frame, or this item's
 *   floor-index goes stale exactly the way `refreshItemFloorAttrUniforms`'s
 *   own header describes. Every call site was updated the same round this
 *   return shape changed; there is no "old shape" caller left to break.
 */
export function buildRealFloorAttrMrtNode({
  THREE,
  item,
  viewedFloorIndex,
  sceneDoc,
  logError,
  envLight,
  receiverHeightFt,
  solidityAlpha,
}) {
  const { mrt, output } = THREE.TSL;
  const floorAttrUniforms = resolveItemFloorAttrUniforms({
    THREE,
    item,
    viewedFloorIndex,
    sceneDoc,
    logError,
    receiverHeightFt,
  });
  const { uFloorIndex01, uPresenceBits01 } = floorAttrUniforms;
  const outdoors01 = buildWorldSpaceOutdoorsGate(THREE.TSL, {
    uOutdoorsRect: envLight.uOutdoorsRect,
    outdoorsTexNode: envLight.outdoorsTexNode,
  });
  const mrtNode = mrt({
    attr: packFloorAttr(THREE.TSL, {
      floorIndex01: uFloorIndex01,
      outdoors01,
      presenceBits01: uPresenceBits01,
      solidityAlpha: solidityAlpha ?? output.a,
    }),
  });
  return { mrtNode, floorAttrUniforms };
}
