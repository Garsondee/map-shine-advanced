/**
 * THE VISION MASK RASTERISER — slice 2b of "MSA owns vision/fog" (Testament
 * Pillar 11, `docs/planning/Vision-Fog-Ownership.md`).
 *
 * Draws every active vision source's Foundry-computed polygons into ONE
 * screen-space mask that the composite then reads. The RULE it serves is
 * `./vision-mask.js#decideRevealed` — that function is the CPU twin and the
 * single definition; this file must never drift from it (Law 7:
 * player-facing information gating is sacred).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE CHANNELS, and why the rule is split across them rather than
 * evaluated here
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   R = inside the SIGHT/FOV polygon (`visionSource.shape` — already bounded
 *       by `sight.range` AND wall-clipped; darkvision, illumination-INDEPENDENT)
 *   G = unused
 *   B = inside the lightPerception polygon (`visionSource.light` — already
 *       bounded by `lightRadius` AND wall-clipped)
 *
 * The composite finishes the rule, because the last clause needs MSA's own
 * per-pixel illumination and that lives in a DIFFERENT buffer
 * (`buf:scene.illum`) which this pass has no business sampling mid-rasterise:
 *
 *   revealed = R OR (B AND illum >= threshold)      ← UNION, never AND
 *
 * MAX blending unions the sources: two tokens each contribute their own
 * polygons and a pixel either token can see reads 1 in the right channel.
 * MAX (not additive) because these are BOOLEANS — additive would saturate to
 * the same answer for R/G/B here, but would silently start lying the moment
 * anyone introduced a partial value, and this is not a buffer to be subtle in.
 *
 * ⚠️ A BLINDED SOURCE IS DROPPED ENTIRELY rather than drawn and masked later.
 * Foundry does the same (`refreshVisibility`'s `!blinded` guard), and it is
 * the fail-safe direction: a bug that drops a source shows a player LESS than
 * they should see, a bug that draws one shows them MORE.
 *
 * ⚠️ COORDINATE CONVENTION IS COPIED FROM THE WORKING LIGHT PATH, NOT DERIVED
 * — `point-light-pool.js` does `mesh.position.set(x, y, 0)` with Foundry's
 * world coordinates straight in, no Y flip. This file does the same and
 * differs in exactly one way: it calls `triangulateLightFan` with
 * **`radius = 1`**, which makes the "normalisation" an identity and yields
 * plain local-space offsets, so no compensating `scale` is needed. Y-flip has
 * bitten this project five times (`feedback_y_flip_recurring_risk`); copying a
 * proven call site is the cheapest way not to make it six.
 *
 * @module effects/vision/vision-mask-render
 */

import { triangulateLightFan } from '../lighting/point-light-illumination.js';

/**
 * `triangulateLightFan` divides by this to reach the light shader's
 * unit-circle space. Passing 1 makes that an identity, which is exactly what
 * a mask wants: local-space offsets in real world units, so the mesh needs
 * only a position and no scale.
 */
const NO_RADIUS_NORMALISATION = 1;

/** The longest side of the two remembered-fog buffers, texels. 3072 x 3072 RGBA8 is ~38 MB each, the most a square map spends. */
const EXPLORED_MAX_DIM = 3072;
/** The shortest either side may get, so a thin map still has a usable buffer. */
const EXPLORED_MIN_DIM = 256;

/**
 * Build the material that stamps the SIGHT (FOV) polygon into R.
 *
 * ⚠️ NO RADIUS UNIFORM, AND AN EARLIER VERSION'S ONE WAS BOTH REDUNDANT AND
 * HARMFUL. `visionSource.shape` is Foundry's own sweep already bounded by
 * `sight.range` AND clipped by walls, so the polygon IS the darkvision answer
 * — re-testing the radius in the shader re-derived something we had already
 * consumed. Worse, the first cut then ANDed this channel into the final rule,
 * and a token with no darkvision has `sight.range = 0`, which makes
 * `.shape` a degenerate speck (`PointEffectSource#_getPolygonConfiguration`
 * builds it at `radius: 0`). The whole map went black. R is now simply
 * "inside the FOV", and the rule UNIONS it — see `vision-mask.js`.
 *
 * @param {*} THREE @returns {{material: *}}
 */
export function buildVisionLosMaterial({ THREE }) {
  const { float, vec4 } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(float(1), float(0), float(0), float(1));
  return { material };
}

/**
 * Build the material that stamps the light-perception polygon (B).
 *
 * No radius uniform: Foundry has ALREADY clipped `source.light` to the
 * light-perception range AND to walls, so the polygon itself is the answer.
 * Re-testing the radius here would be re-deriving something we consumed —
 * the exact discipline this build is built on.
 *
 * @param {*} THREE @returns {{material: *}}
 */
export function buildVisionLightMaterial({ THREE }) {
  const { float, vec4 } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(float(0), float(0), float(1), float(1));
  return { material };
}

/**
 * Build the material that stamps a FROZEN "floor" polygon into G — the
 * door-fog-reveal-sync consumer's own channel (`vt-pan-viewer.js`'s door-fog
 * glue calls this the transition "floor": what was already safely revealed
 * the moment a door started swinging, from a held reference to a PRIOR
 * frame's vision sources — see `door-graphics.js`'s `fog-reveal-sync`
 * deferred rung for the feature this exists for).
 *
 * Deliberately ONE channel, not a G/A mirror of the live R/B split: the floor
 * only ever answers "was this pixel already safe to show before the door(s)
 * currently mid-swing started opening" for `buildVisionGateMaterial`'s fade
 * below — it does not need to re-run the full illumination-conditioned
 * reveal rule, only union whatever was ALREADY true (sight or light) at
 * freeze time. Over-approximating "already revealed" here can only make
 * FEWER pixels get the fade (they fall back to today's instant reveal
 * instead), never show anything the live R/B channels don't already
 * authorize.
 *
 * ⚠️ A IS NOT AVAILABLE FOR THIS — checked, not assumed. Both
 * `buildVisionLosMaterial` and `buildVisionLightMaterial` hard-code alpha to
 * `float(1)` with `MaxEquation`/`OneFactor` blending, and the frame host
 * clears this render target with alpha 1 in both the gated and ungated case
 * — so alpha is provably a constant 1 across this whole texture today.
 * Reclaiming it would mean editing those two already-shipped materials and
 * the shared clear call; G costs nothing and is genuinely unused.
 *
 * @param {*} THREE @returns {{material: *}}
 */
export function buildVisionFloorMaterial({ THREE }) {
  const { float, vec4 } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(float(0), float(1), float(0), float(1));
  return { material };
}

/**
 * THE REVEAL TEST, shared by every material in this file that needs it — the
 * live gate, the explored-dim quad, and the snapshot publish quad all ask the
 * exact same question ("is this ALREADY-SAMPLED mask/illum pair revealed?"),
 * each from a DIFFERENT uv (screen-space for the gate, reprojected for the
 * other two). Sharing this instead of hand-copying it three times is what
 * keeps Law 7 honest: a future change to the rule that only reaches one copy
 * is exactly the silent-divergence shape this exists to prevent.
 *
 * Mirrors `./vision-mask.js#decideRevealed` — that function remains the
 * single CPU-side definition:
 *     revealed = R OR (B AND illum >= threshold)      ← UNION, never AND
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.mask - an ALREADY-SAMPLED vec4 from this subsystem's R/G/B mask.
 * @param {*} args.illum - an ALREADY-SAMPLED vec4 from `buf:scene.illum`.
 * @param {number} args.threshold - `REVEAL_ILLUMINATION_THRESHOLD`.
 * @param {((screenUV:*) => *)|null} [args.extraRevealed] - a boolean-node builder: pixels it says
 *   are revealed stay revealed whatever the mask says (the Table's padding). Needs `screenUV`.
 * @param {*} [args.screenUV] - the screen UV `mask` and `illum` were sampled at.
 * @returns {*} a boolean TSL node.
 */
function buildRevealedNode({ THREE, mask, illum, threshold, extraRevealed = null, screenUV = null }) {
  const { float, max } = THREE.TSL;
  // The SAME illumination the composite lit the frame with — deliberately not
  // a second, differently-derived brightness, so "bright enough to see" and
  // "bright enough to look lit" can never disagree on screen.
  const luminance = max(max(illum.r, illum.g), illum.b);
  const litEnough = luminance.greaterThanEqual(float(threshold));
  // UNION, not intersection — a no-darkvision token has a degenerate .shape,
  // and ANDing against it once blacked out the entire map (the regression
  // `vision-mask.js#decideRevealed`'s own header documents in full).
  const insideSight = mask.r.greaterThan(float(0.5));
  const insideLight = mask.b.greaterThan(float(0.5));
  const sighted = insideSight.or(insideLight.and(litEnough));
  // THE TABLE (effects/table/table-subsystem.js): while it is on, the scene's padding is the
  // table top, not fog. A screen-space caller passes both pieces; every other caller omits them
  // and gets exactly the rule above.
  return extraRevealed && screenUV ? sighted.or(extraRevealed(screenUV)) : sighted;
}

/**
 * THE SHARED REVEAL QUERY (mythica-machina-press#386) — `buildRevealedNode`
 * above, exposed OUTSIDE this file, plus the texture-sample step every
 * external caller would otherwise have to copy from `buildVisionGateMaterial`
 * by hand. This is the "one shared occlusion/visibility contract" #386 asks
 * for, for the vision/fog-of-war half specifically (the floor/tile-rank half
 * already has one: `vt/scene-depth.js#querySceneDepth`).
 *
 * ⚠️ THIS FUNCTION DOES NOT WIRE ANY NEW CONSUMER. It makes the rule callable
 * from outside this file for the first time — closing #49 (fire smoke poking
 * through walls) or the reverse half of #39 (a visible source's bloom
 * smearing into an already-gated pixel) is real, separate shader work in
 * each effect's OWN render module, using this. Not attempted here: neither
 * of those two consumers can be added and verified without a live GPU
 * session, which this pass does not have. What IS here is proven —
 * `buildRevealedNode` is the exact function `buildVisionGateMaterial` (the
 * one shipped, live consumer) already builds the whole-frame gate from; nothing
 * about the rule itself is new or unverified, only its being callable a second
 * place is.
 *
 * A caller wanting the SAME door-fog-transition softening
 * {@link buildVisionGateMaterial} applies is not served by this function —
 * that transition is specific to the one whole-frame composite gate, not a
 * property of "is this pixel revealed" in general. A future caller that
 * genuinely needs it should take `doorFogProgress` the same way that
 * function already does, not invent a second copy of that logic here.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture - this subsystem's own R/G/B mask (the SAME
 *   texture `buildVisionGateMaterial`'s own `maskTexture` param takes —
 *   typically a live `createVisionMaskSubsystem()` instance's `.texture`).
 * @param {*} args.illumTexture - `buf:scene.illum`.
 * @param {*} args.screenUV - a vec2 TSL node; pass `THREE.TSL.uv()` for a
 *   fullscreen quad reading screen-space directly, or a reprojected UV for
 *   a caller sampling from a different geometry's own fragment position
 *   (mirrors `buildVisionSnapshotPublishMaterial`'s own reprojection use of
 *   the identical mask/illum pair, a few functions below).
 * @param {number} args.threshold - `REVEAL_ILLUMINATION_THRESHOLD`
 *   (`./vision-mask.js`) — pass the SAME constant `buildVisionGateMaterial`
 *   is given, never a second, independently-chosen number.
 * @param {((screenUV:*) => *)|null} [args.extraRevealed] - the Table's "padding is not fog" term;
 *   pass the SAME one the gate was given.
 * @returns {{revealed: *, factor: *}} `revealed`: the boolean TSL node.
 *   `factor`: `1` where revealed, `0` where not — the same multiplicative
 *   shape `buildVisionGateMaterial`'s own gate quad uses (minus the door-fog
 *   softening; see this function's own header), ready to multiply into a
 *   caller's own additive contribution.
 */
export function sampleVisionRevealFactor({
  THREE,
  maskTexture,
  illumTexture,
  screenUV,
  threshold,
  extraRevealed = null,
}) {
  const { texture, float, select } = THREE.TSL;
  const mask = texture(maskTexture).sample(screenUV);
  const illum = texture(illumTexture).sample(screenUV);
  const revealed = buildRevealedNode({ THREE, mask, illum, threshold, extraRevealed, screenUV });
  return { revealed, factor: select(revealed, float(1), float(0)) };
}

/**
 * THE SHARED "EVER SEEN" QUERY — the explored buffer at a screen UV. Used by
 * the explored-dim quad below AND by the present's fog hold
 * (`grade/grade-present.js`, 2026-10-27), so "explored" means one thing.
 *
 * Screen UV → world position → explored-buffer UV. Identical mapping to
 * `sun-occlusion-render.js#buildSunVisibilityNode`, reused rather than
 * re-derived so the two cannot drift (and so a Y-flip mistake here would
 * have to be a mistake there too, where it is already proven correct).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.exploredTexture - the boolean "ever seen" buffer.
 * @param {*} args.uViewRect - current camera's world-space view rect.
 * @param {*} args.uExploredRect - the explored buffer's own world rect.
 * @param {*} args.screenUV - a vec2 TSL node.
 * @param {*} [args.exploredSnapshotTexture] - the remembered-colour buffer, whose ALPHA marks every
 *   texel the full reveal test ever passed on (see "SEEN BY DAYLIGHT" below). Omit → sight shape only.
 * @returns {{isExplored: *, bufferUv: *}} the boolean node, and the buffer UV
 *   (for a caller that also reads the snapshot at the same place).
 */
export function sampleExploredNode({
  THREE,
  exploredTexture,
  uViewRect,
  uExploredRect,
  screenUV,
  exploredSnapshotTexture = null,
}) {
  const { texture, float, mix, vec2 } = THREE.TSL;
  const worldX = mix(uViewRect.x, uViewRect.z, screenUV.x);
  const worldY = mix(uViewRect.y, uViewRect.w, screenUV.y);
  const eu = worldX.sub(uExploredRect.x).div(uExploredRect.z.sub(uExploredRect.x));
  const ev = worldY.sub(uExploredRect.y).div(uExploredRect.w.sub(uExploredRect.y));
  const bufferUv = vec2(eu.clamp(0, 1), ev.clamp(0, 1));
  const insideSightEver = texture(exploredTexture).sample(bufferUv).r.greaterThan(float(0.5));
  if (!exploredSnapshotTexture) return { isExplored: insideSightEver, bufferUv };
  // SEEN BY DAYLIGHT (2026-10-27). The author: a token *"outside, at noon"*
  // and its explored fog *"is not what I would expect to see"*. The world
  // buffer above only ever reads R — the SIGHT shape, which under PF2e's
  // rules-based vision is a speck for any token without darkvision (sight
  // range 0) — so ground revealed by light perception (B AND lit: daylight,
  // torches) was shown live and then forgotten. Foundry's own fog remembers
  // everything its vision revealed. The snapshot publish quad writes alpha 1
  // exactly where the FULL reveal test passed (and the snapshot is cleared to
  // alpha 0), so its alpha is that memory; union it in.
  const seenEver = texture(exploredSnapshotTexture).sample(bufferUv).a.greaterThan(float(0.5));
  return { isExplored: insideSightEver.or(seenEver), bufferUv };
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE SOFT FOG FIELD (2026-11-02). The author: the fog's *"blackness
 * especially, is very low resolution, ugly and cheap looking with badly AA'd
 * edges"*, with *"lighter grey jagged internal artefacts around edges"*.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Two causes, both measured in a private Foundry before this was built:
 *  1. Every fog decision was a per-pixel BOOLEAN on a NEAREST mask, so each
 *     edge was a hard one-pixel staircase (and a bigger one wherever the
 *     render scale ran below native).
 *  2. The remembered ("explored") buffer is world-space and coarser than the
 *     screen. Its fans were rasterised hard and then thresholded, so its
 *     outline stair-stepped up to half a texel PAST the live sight edge, and
 *     the dim memory showed through there as a pale grey sawtooth.
 *
 * The cure is one smooth field, built once a frame and read by every fog
 * consumer (the gate, the memory quad, the present's hold, the coverage
 * publish), so they all agree on one edge:
 *
 *   resolve (full res)  — the reveal rule as a 0..1 value per pixel
 *   blur H, blur V (half res, Gaussian, jittered taps) — the soft field R,
 *     plus two slow world-space noises: G = ink (eats into the fade band),
 *     B = mist (drifts over remembered ground)
 *
 * ⚠️ LAW 7 STILL HOLDS, BY CONSTRUCTION. A blurred mask reads above 0.5 a
 * little OUTSIDE a reflex corner of the revealed shape, so the field alone
 * could leak a sliver. It never stands alone: `fogVisibility` multiplies by
 * the exact hard rule (`buildRevealedNode`), and only remaps the part of the
 * field ABOVE 0.5, which a straight edge reaches exactly AT the polygon. So
 * the fade lies wholly inside what is already revealed: it can darken a
 * visible pixel, never brighten a hidden one. The ink noise only raises the
 * threshold (erodes), never lowers it.
 */

/** Gaussian taps EACH SIDE of the centre in each blur pass (13 per pass). */
export const FOG_SOFT_TAPS = 6;
/** Sigma of the blur kernel, in taps. */
const FOG_SOFT_SIGMA_TAPS = 3;
/** A lit pixel inside light perception counts fully from this many times the reveal threshold. */
const FOG_LIT_SOFT_SPAN = 2.5;
/** The reveal fade's history is this many times coarser than the explored buffer (it shapes a fade, not an edge). */
const REVEAL_HISTORY_DIVISOR = 3;
/** The share of the frame, at each edge, over which newly recorded memory fades out (see the coverage publish). */
const FOG_SCREEN_EDGE_FADE = 0.06;

/** The kernel's weights, centre first (index = |tap|), normalised over all 2*TAPS+1 taps. */
export function fogSoftWeights(taps = FOG_SOFT_TAPS, sigma = FOG_SOFT_SIGMA_TAPS) {
  const raw = [];
  for (let k = 0; k <= taps; k++) raw.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const sum = raw[0] + 2 * raw.slice(1).reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

/**
 * The step between blur taps, in UV of the full frame, for a fade band
 * `featherPx` screen pixels wide. A Gaussian blur of a step edge, read through
 * `fogBandT`, climbs from 0 at the edge to ~0.95 at two sigmas, so the band
 * is two sigmas wide.
 * @param {number} featherPx @param {number} framePx - the frame's width (or height) in the same pixels.
 */
export function fogSoftStepUv(featherPx, framePx) {
  const sigmaPx = Math.max(0.5, featherPx) / 2;
  return sigmaPx / FOG_SOFT_SIGMA_TAPS / Math.max(1, framePx);
}

/**
 * The fog look's live knobs, shared by every fog material. Values are pushed
 * by the viewer each frame; nothing here rebuilds a shader.
 * @param {*} TSL
 */
export function createFogLookUniforms(TSL) {
  const { uniform, float, vec2 } = TSL;
  return {
    /** Per-tap UV offset of the horizontal / vertical blur. */
    uStepH: uniform(vec2(1 / 2048, 0)),
    uStepV: uniform(vec2(0, 1 / 2048)),
    /** Seconds, for the slow drift of ink and mist. */
    uTime: uniform(float(0)),
    /** How far the ink noise eats into the fade band, 0 (a clean gradient) .. 1. */
    uInk: uniform(float(0.6)),
    /** World px per ink cell, and per mist cell. */
    uInkCellPx: uniform(float(90)),
    uMistCellPx: uniform(float(520)),
    /** How much the mist lifts and lowers remembered ground, 0..1. */
    uMist: uniform(float(0.14)),
    /** Colour kept in remembered ground (1 = full colour, 0 = grey). */
    uMemorySaturation: uniform(float(0.7)),
    /** How visible grid lines stay over remembered ground (0..1); never over unexplored black. */
    uMemoryGrid: uniform(float(0.3)),
    /** How bright remembered ground is drawn (the Fog of War card; `EXPLORED_DIM_FACTOR` before it). */
    uMemoryDim: uniform(float(0.35)),
    /** The reveal fade: the share of the gap to full sight closed this frame (pushed from real time). */
    uRevealRate: uniform(float(1)),
    /** Set by the host BEFORE any fog material is built (they read them at build time): the reveal
     *  fade's history texture and the two rects that place it. Null leaves the fade out. */
    revealTexture: null,
    uViewRect: null,
    uExploredRect: null,
  };
}

/**
 * THE RESOLVE — the reveal rule as a value, full resolution, into a LINEAR
 * target the blur then reads with bilinear taps (so no tap ever skips a pixel).
 * Light perception counts by how lit it is, so the torch-lit edge of what a
 * token can see fades into the dark instead of stopping on a contour line.
 * @param {object} args
 * @returns {*} a NodeMaterial for a fullscreen quad.
 */
export function buildVisionSoftResolveMaterial({ THREE, maskTexture, illumTexture, threshold, extraRevealed = null }) {
  const { texture, uv, float, vec4, max, smoothstep, step, select } = THREE.TSL;
  const mask = texture(maskTexture).sample(uv());
  const illum = texture(illumTexture).sample(uv());
  const luminance = max(max(illum.r, illum.g), illum.b);
  const lit = smoothstep(float(threshold), float(threshold * FOG_LIT_SOFT_SPAN), luminance);
  let soft = max(step(float(0.5), mask.r), step(float(0.5), mask.b).mul(lit));
  if (extraRevealed) soft = max(soft, select(extraRevealed(uv()), float(1), float(0)));
  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = vec4(soft, float(0), float(0), float(1));
  return material;
}

/**
 * ONE BLUR PASS of the soft field (13 Gaussian taps along `uStep`). The taps
 * are jittered per pixel by up to half a step (interleaved gradient noise), so
 * a wide band, whose taps sit several pixels apart, dissolves into fine grain
 * instead of showing thirteen contour lines.
 *
 * With `look` + `uViewRect` this is the SECOND pass, and also writes the two
 * world-space noises the consumers share (see the field's header): computing
 * them here, at half resolution, costs one pass instead of four.
 * @param {object} args
 * @returns {*} a NodeMaterial for a fullscreen quad.
 */
export function buildVisionSoftBlurMaterial({ THREE, inputTexture, uStep, look = null, uViewRect = null }) {
  const { texture, uv, float, vec2, vec3, vec4, fract, dot, screenCoordinate, mix, smoothstep, mx_noise_float } =
    THREE.TSL;
  const weights = fogSoftWeights();
  const jitter = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))))).sub(0.5);
  const src = texture(inputTexture);
  let sum = src.sample(uv()).r.mul(weights[0]);
  for (let k = 1; k <= FOG_SOFT_TAPS; k++) {
    const off = uStep.mul(float(k).add(jitter.mul(0.5)));
    sum = sum.add(
      src
        .sample(uv().add(off))
        .r.add(src.sample(uv().sub(off)).r)
        .mul(weights[k])
    );
  }
  let ink = float(0);
  let mist = float(0.5);
  if (look && uViewRect) {
    const world = vec2(mix(uViewRect.x, uViewRect.z, uv().x), mix(uViewRect.y, uViewRect.w, uv().y));
    const t = look.uTime;
    // INK: two octaves of slow noise in world space, so it sticks to the map while the camera pans and
    // only breathes, never crawls. Remapped to 0..1 and shaped so most of the edge is touched a little
    // and some of it a lot: a wash, not a fringe.
    const pInk = world.div(look.uInkCellPx);
    const n1 = mx_noise_float(vec3(pInk.x, pInk.y, t.mul(0.07)));
    const n2 = mx_noise_float(vec3(pInk.x.mul(2.31).add(17.1), pInk.y.mul(2.31).sub(3.7), t.mul(0.13)));
    ink = smoothstep(float(0.18), float(0.82), n1.mul(0.65).add(n2.mul(0.35)).mul(0.5).add(0.5));
    // MIST: one large, slower octave drifting on a gentle diagonal.
    const pMist = world.div(look.uMistCellPx).add(vec2(t.mul(0.011), t.mul(-0.007)));
    mist = mx_noise_float(vec3(pMist.x, pMist.y, t.mul(0.025)))
      .mul(0.5)
      .add(0.5)
      .clamp(0, 1);
  }
  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = vec4(sum, ink, mist, float(1));
  return material;
}

/**
 * THE REVEAL FADE (2026-11-02) — ground that comes into sight fades in over a
 * moment instead of popping, so a walking token's view creeps forward like
 * light. A small WORLD-space buffer (so panning never re-fades anything) holds
 * how long each place has been in sight, eased toward the current visibility:
 *
 *   history' = history + (vNow - history) * rate      while on screen, rising only
 *   history' = vNow                                   where vNow fell (hiding is instant)
 *
 * Consumers show `min(v, history)`, so this can only DELAY a reveal, never
 * extend one (Law 7), and anything leaving sight is gone at once — a fade-out
 * would show a token that has already stepped out of view.
 *
 * Off screen the buffer is left alone: the last thing known there is kept, so
 * panning back to ground still in sight does not fade it in again.
 * @param {object} args
 * @param {*} args.uRate - a float uniform, the share of the gap closed this frame (1 - exp(-dt/tau)).
 * @returns {*} a NodeMaterial for a fullscreen quad bound to the NEXT history target.
 */
export function buildVisionRevealHistoryMaterial({
  THREE,
  historyTexture,
  softTexture,
  maskTexture,
  illumTexture,
  threshold,
  uViewRect,
  uExploredRect,
  uRate,
  look,
  extraRevealed = null,
}) {
  const { uv, float, vec2, vec4, mix, min, select, texture } = THREE.TSL;
  const worldX = mix(uExploredRect.x, uExploredRect.z, uv().x);
  const worldY = mix(uExploredRect.y, uExploredRect.w, uv().y);
  const screenU = worldX.sub(uViewRect.x).div(uViewRect.z.sub(uViewRect.x));
  const screenV = worldY.sub(uViewRect.y).div(uViewRect.w.sub(uViewRect.y));
  const onScreen = screenU
    .greaterThanEqual(0)
    .and(screenU.lessThanEqual(1))
    .and(screenV.greaterThanEqual(0))
    .and(screenV.lessThanEqual(1));
  const { vPlain } = sampleFogVisibility({
    THREE,
    softTexture,
    maskTexture,
    illumTexture,
    threshold,
    screenUV: vec2(screenU, screenV),
    look,
    extraRevealed,
  });
  const prev = texture(historyTexture).sample(uv()).r;
  const eased = min(prev.add(vPlain.sub(prev).mul(uRate)), vPlain);
  const next = select(onScreen, eased, prev);
  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = vec4(next, float(0), float(0), float(1));
  return material;
}

/**
 * THE MEMORY STAMP (2026-11-02) — draws one token's SAVED coverage (`foundry/fog-memory-persistence.js`)
 * into the explored buffer, MAX-blended, so loading memory only ever adds. `uStoredRect` is the world rect
 * the record was saved over; it is mapped onto the buffer's current rect, so a resized scene still lines up.
 * Swap `memoryTexNode.value` between draws to stamp several tokens with one material.
 * @returns {{material: *, memoryTexNode: *, uStoredRect: *}}
 */
export function buildVisionMemoryStampMaterial({ THREE, placeholderTexture, uExploredRect }) {
  const { uv, float, vec2, vec4, mix, texture, uniform, select } = THREE.TSL;
  const uStoredRect = uniform(THREE.TSL.vec4(0, 0, 1, 1));
  const worldX = mix(uExploredRect.x, uExploredRect.z, uv().x);
  const worldY = mix(uExploredRect.y, uExploredRect.w, uv().y);
  const su = worldX.sub(uStoredRect.x).div(uStoredRect.z.sub(uStoredRect.x));
  const sv = worldY.sub(uStoredRect.y).div(uStoredRect.w.sub(uStoredRect.y));
  const inside = su.greaterThanEqual(0).and(su.lessThanEqual(1)).and(sv.greaterThanEqual(0)).and(sv.lessThanEqual(1));
  const memoryTexNode = texture(placeholderTexture);
  const cover = select(inside, memoryTexNode.sample(vec2(su, sv)).r, float(0));
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(cover, float(0), float(0), cover);
  return { material, memoryTexNode, uStoredRect };
}

/** A plain copy quad (history B → A), so consumers always read one fixed texture. */
export function buildVisionCopyMaterial({ THREE, sourceTexture }) {
  const { uv, texture } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = texture(sourceTexture).sample(uv());
  return material;
}

/** How far into the reveal fade a screen uv is (1 when there is no history buffer). */
function sampleRevealHistory(THREE, look, screenUV) {
  if (!look.revealTexture || !look.uViewRect || !look.uExploredRect) return null;
  const { texture, mix, vec2, float, select } = THREE.TSL;
  const r = look.uViewRect;
  const e = look.uExploredRect;
  const worldX = mix(r.x, r.z, screenUV.x);
  const worldY = mix(r.y, r.w, screenUV.y);
  const hu = worldX.sub(e.x).div(e.z.sub(e.x));
  const hv = worldY.sub(e.y).div(e.w.sub(e.y));
  // Outside the scene rect (the Table's padding) there is no history: never hold anything back there.
  const inside = hu.greaterThanEqual(0).and(hu.lessThanEqual(1)).and(hv.greaterThanEqual(0)).and(hv.lessThanEqual(1));
  return select(inside, texture(look.revealTexture).sample(vec2(hu.clamp(0, 1), hv.clamp(0, 1))).r, float(1));
}

/** The field's fade band: 0 at the revealed edge (field 0.5), 1 once fully inside. */
function fogBandT(TSL, soft) {
  return soft.sub(0.5).mul(2).clamp(0, 1);
}

/**
 * Let the ink eat into a 0..1 band: raises the threshold where the noise is
 * high, never lowers it (so it can only hide), and leaves 1 at 1.
 */
function inkErode(TSL, t, ink, amount) {
  const { float, max } = TSL;
  const bite = ink.mul(amount);
  return t
    .sub(bite)
    .div(max(float(1).sub(bite), float(1e-3)))
    .clamp(0, 1);
}

/**
 * THE FOG AT ONE SCREEN UV — what every consumer reads. `v` is how visible the
 * pixel is now (0..1, zero wherever the hard rule says hidden), `vPlain` the
 * same without the ink (what memory records), `field` the raw sample (for its
 * ink and mist).
 * @param {object} args
 * @returns {{v:*, vPlain:*, field:*, revealed:*}}
 */
export function sampleFogVisibility({
  THREE,
  softTexture,
  maskTexture,
  illumTexture,
  threshold,
  screenUV,
  look,
  extraRevealed = null,
}) {
  const { texture, float, select, smoothstep } = THREE.TSL;
  const TSL = THREE.TSL;
  const field = texture(softTexture).sample(screenUV);
  const mask = texture(maskTexture).sample(screenUV);
  const illum = texture(illumTexture).sample(screenUV);
  const revealed = buildRevealedNode({ THREE, mask, illum, threshold, extraRevealed, screenUV });
  const hard = select(revealed, float(1), float(0));
  const t = fogBandT(TSL, field.r);
  const vPlain = smoothstep(float(0), float(1), t).mul(hard);
  let v = smoothstep(float(0), float(1), inkErode(TSL, t, field.g, look.uInk)).mul(hard);
  // THE REVEAL FADE: only ever lowers `v` (see `buildVisionRevealHistoryMaterial`).
  const history = sampleRevealHistory(THREE, look, screenUV);
  if (history) v = TSL.min(v, history);
  return { v, vPlain, field, revealed };
}

/**
 * How REMEMBERED a pixel is (0..1): the explored buffer's coverage — the soft
 * visibility it was published from, so its edge is as smooth as the live one —
 * through the same ink, so the edge of the known world breathes too.
 * @param {object} args - `field` from {@link sampleFogVisibility} at the same uv.
 * @returns {*} a float node.
 */
export function sampleFogMemory({ THREE, exploredTexture, uViewRect, uExploredRect, screenUV, field, look }) {
  const { texture, float, smoothstep, mix, vec2, select } = THREE.TSL;
  const worldX = mix(uViewRect.x, uViewRect.z, screenUV.x);
  const worldY = mix(uViewRect.y, uViewRect.w, screenUV.y);
  const eu = worldX.sub(uExploredRect.x).div(uExploredRect.z.sub(uExploredRect.x));
  const ev = worldY.sub(uExploredRect.y).div(uExploredRect.w.sub(uExploredRect.y));
  // Outside the scene rect nothing was ever recorded: clamp-to-edge would smear the border texel outward.
  const inside = eu.greaterThanEqual(0).and(eu.lessThanEqual(1)).and(ev.greaterThanEqual(0)).and(ev.lessThanEqual(1));
  const coverage = texture(exploredTexture).sample(vec2(eu.clamp(0, 1), ev.clamp(0, 1))).r;
  const e = smoothstep(float(0), float(1), inkErode(THREE.TSL, coverage, field.g, look.uInk));
  return select(inside, e, float(0));
}

/**
 * THE COVERAGE PUBLISH — a fullscreen quad bound to the explored buffer that
 * MAX-writes the plain soft visibility of every on-screen texel into R. This
 * replaces drawing the sight fans into that buffer: fans rasterised at world
 * resolution are a hard staircase (cause 2 in the field's header), this is the
 * same smooth edge the player sees. MAX, so memory only ever grows.
 * @param {object} args
 * @returns {*} a NodeMaterial for a fullscreen quad bound to the explored buffer.
 */
export function buildVisionCoveragePublishMaterial({
  THREE,
  softTexture,
  maskTexture,
  illumTexture,
  threshold,
  uViewRect,
  uExploredRect,
  look,
}) {
  const { uv, float, vec2, vec4, mix, min, smoothstep } = THREE.TSL;
  const worldX = mix(uExploredRect.x, uExploredRect.z, uv().x);
  const worldY = mix(uExploredRect.y, uExploredRect.w, uv().y);
  const screenU = worldX.sub(uViewRect.x).div(uViewRect.z.sub(uViewRect.x));
  const screenV = worldY.sub(uViewRect.y).div(uViewRect.w.sub(uViewRect.y));
  // Only what is on screen can be remembered (the colour comes from this frame's picture), and a hard
  // cut there left dead-straight edges in memory wherever sight ran past the frame. Fade out over the
  // outer few percent instead: the edge of a glance is remembered faintly, and MAX fills it in later.
  const edgeU = min(screenU, float(1).sub(screenU));
  const edgeV = min(screenV, float(1).sub(screenV));
  const onScreen = smoothstep(float(0), float(FOG_SCREEN_EDGE_FADE), edgeU).mul(
    smoothstep(float(0), float(FOG_SCREEN_EDGE_FADE), edgeV)
  );
  const { vPlain } = sampleFogVisibility({
    THREE,
    softTexture,
    maskTexture,
    illumTexture,
    threshold,
    screenUV: vec2(screenU, screenV),
    look,
  });
  const cover = vPlain.mul(onScreen);
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(cover, float(0), float(0), cover);
  return material;
}

/**
 * Build the FULLSCREEN GATE — one MULTIPLY quad that finishes the reveal rule
 * over the whole composited frame.
 *
 * ⚠️ WHY THIS IS A SEPARATE FULLSCREEN PASS AND NOT A TERM IN THE COMPOSITE
 * MATERIAL — found live, not reasoned about. The first cut put the gate inside
 * `environmental-light.js`'s composite. A verification run showed the map
 * correctly blacked out where unrevealed AND candle flames, fire particles and
 * light coronas drawing straight through the fog: they are ADDITIVE draws that
 * land on `scene.lit` AFTER the composite quad and therefore never pass
 * through it. Gating "the composite" gates the map and nothing else. Only a
 * pass that runs after every contributor can gate every contributor.
 *
 * ⚠️ AND IT MUST RUN BEFORE BLOOM. Bloom reads `scene.lit` and smears bright
 * pixels outward; gating afterwards would let a hidden candle bloom across the
 * fog and betray its position through a wall. Gate first, then bloom only ever
 * sees what the viewer is allowed to see.
 *
 * MULTIPLY (rather than reading `scene.lit` and writing it back) because a
 * pass may not sample the target it writes. The quad reads only the mask and
 * the illumination buffer, and the blend does the rest.
 *
 * ⚠️ PURELY THE LIVE ZONE NOW (currently visible → 1, everything else → 0).
 * The explored-dim zone moved OUT to `buildVisionExploredDimMaterial` below,
 * a SEPARATE additive quad — a single multiply cannot express "replace with a
 * DIFFERENT colour", only "scale what is already here", and the dim zone
 * needs the former (see that function's own header for the full mechanism).
 * This quad still correctly zeroes the dim zone to black FIRST — it has no
 * `isExplored` clause at all, so an explored-but-not-visible pixel already
 * has `revealed = false` and gets multiplied to black here, which is exactly
 * the clean base the dim quad's ADD then paints onto.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture - this subsystem's own R/G/B mask.
 * @param {*} args.illumTexture - `buf:scene.illum`, MSA's own per-pixel brightness.
 * @param {number} args.threshold - `REVEAL_ILLUMINATION_THRESHOLD`.
 * @param {*} [args.doorFogProgress] - DOOR-FOG-REVEAL-SYNC: an optional live
 *   TSL float uniform, 0 (just started opening) .. 1 (fully open / no
 *   transition active). Omit for today's behaviour unchanged (instant
 *   reveal). When supplied, a pixel that is revealed NOW (R/B) but was NOT
 *   already revealed on the frozen "floor" (G, `buildVisionFloorMaterial`,
 *   populated only while a door is mid-swing) is exactly the sliver a
 *   transitioning door newly exposes — faded by this value instead of
 *   snapping straight to 1. Every OTHER pixel (already safe before the
 *   transition, or nothing transitioning at all) is completely unaffected.
 * @returns {*} a NodeMaterial for a fullscreen quad.
 */
export function buildVisionGateMaterial({
  THREE,
  maskTexture,
  illumTexture,
  threshold,
  doorFogProgress = null,
  extraRevealed = null,
  softTexture = null,
  look = null,
}) {
  const { texture, uv, float, vec4, select } = THREE.TSL;

  const mask = texture(maskTexture).sample(uv());
  const illum = texture(illumTexture).sample(uv());
  const revealed = buildRevealedNode({ THREE, mask, illum, threshold, extraRevealed, screenUV: uv() });

  // wasFloorRevealed=true (or no doorFogProgress supplied at all) → factor 1,
  // byte-for-byte today's behaviour. Only a pixel that is revealed now AND
  // was NOT on the frozen floor gets the fade — see this param's own doc.
  const doorProgress = doorFogProgress ? doorFogProgress.clamp(0, 1) : float(1);
  const wasFloorRevealed = mask.g.greaterThan(float(0.5));
  const revealFactor = select(wasFloorRevealed, float(1), doorProgress);
  // THE SOFT FIELD (2026-11-02): how visible, not whether — zero wherever the hard rule says hidden.
  const visible =
    softTexture && look
      ? sampleFogVisibility({
          THREE,
          softTexture,
          maskTexture,
          illumTexture,
          threshold,
          screenUV: uv(),
          look,
          extraRevealed,
        }).v
      : select(revealed, float(1), float(0));
  const factor = visible.mul(revealFactor);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  // dst * src — the classic multiply. Alpha is left alone (OneFactor/
  // ZeroFactor would stamp the quad's own alpha over the scene's).
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.ZeroFactor;
  material.blendDst = THREE.SrcColorFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(factor, factor, factor, float(1));
  return material;
}

/**
 * Build the EXPLORED-DIM QUAD — a SECOND fullscreen pass, ADDITIVE-blended,
 * that paints the remembered map into the zone `buildVisionGateMaterial`
 * just multiplied to black.
 *
 * ── THE THREE ZONES (slice 3, finished here) ────────────────────────────
 * Foundry's own fog has three states and players depend on all three:
 *   currently visible     → full brightness (the gate quad's factor=1 no-op)
 *   explored, not visible → DIM remembered map (THIS quad)
 *   never explored        → black (the gate quad's factor=0, nothing added)
 *
 * ⚠️ WHY ADD, NOT REPLACE — a pass may not sample the target it writes, so
 * there is no "read scene.lit, overwrite with snapshot colour" available
 * here. But the gate quad ALREADY multiplied this exact zone to exactly
 * black (0,0,0) — see that function's own header — so ADDING the dimmed
 * snapshot colour on top achieves an identical result to a true replace,
 * via ordinary blend arithmetic: `0 + snapshotColour*dim = snapshotColour*dim`.
 *
 * ⚠️ WHY THIS CANNOT LEAK LIVE CONTENT, UNLIKE THE FIRST ATTEMPT AT THIS
 * (`docs/planning/Vision-Fog-Ownership.md` §4 slice 3's boxed note). It reads
 * `exploredSnapshotTexture`, which is populated EXCLUSIVELY from
 * `captureMapOnlySnapshot()` (`vt-pan-viewer.js`) — a render of floor-art
 * meshes ONLY, tokens and vegetation overlays never submitted to that draw at
 * all. There is no fragment in that source buffer a token could have written,
 * so there is nothing here for the dim multiply to leak.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture @param {*} args.illumTexture @param {number} args.threshold - SAME as the gate quad, own reveal test.
 * @param {*} args.exploredTexture - the boolean "ever seen" buffer (slice 3).
 * @param {*} args.exploredSnapshotTexture - the remembered floor-art colour (this slice).
 * @param {*} args.uViewRect - current camera's world-space view rect, [x0,y0,x1,y1] as a vec4-like.
 * @param {*} args.uExploredRect - the explored buffers' own world rect.
 * @param {number} [args.dimFactor] - `EXPLORED_DIM_FACTOR`.
 * @param {*} [args.memoryLight] - a vec3 uniform node, the current ambient (sRGB). With it the
 *   snapshot must hold UNLIT colour (`storeUnlit`); omit for a snapshot that was stored already lit.
 * @returns {*} a NodeMaterial for a fullscreen quad.
 */
export function buildVisionExploredDimMaterial({
  THREE,
  maskTexture,
  illumTexture,
  threshold,
  exploredTexture,
  exploredSnapshotTexture,
  uViewRect,
  uExploredRect,
  dimFactor,
  extraRevealed = null,
  memoryLight = null,
  softTexture = null,
  look = null,
}) {
  const { texture, uv, float, vec3, vec4, select, dot, mix, sRGBTransferEOTF, sRGBTransferOETF } = THREE.TSL;

  const mask = texture(maskTexture).sample(uv());
  const illum = texture(illumTexture).sample(uv());
  const revealed = buildRevealedNode({ THREE, mask, illum, threshold, extraRevealed, screenUV: uv() });

  const { isExplored, bufferUv } = sampleExploredNode({
    THREE,
    exploredTexture,
    uViewRect,
    uExploredRect,
    screenUV: uv(),
    exploredSnapshotTexture,
  });
  // The snapshot is cleared to (0,0,0,0) and written with alpha 1, so a bilinear read across the edge of what
  // was seen averages real colour with that black. Divide the coverage back out and the edge keeps the map's
  // own colour instead of a dark halo a texel wide.
  const snap = texture(exploredSnapshotTexture).sample(bufferUv);
  const storedColor = snap.rgb.div(snap.a.max(float(0.001))).min(float(1));
  // RELIT BY THE CURRENT TIME OF DAY (2026-10-28). The snapshot holds plain map
  // colour (`buildVisionSnapshotPublishMaterial`'s `storeUnlit`); the light on
  // it is today's ambient, so memory dims and warms with the sky like the rest
  // of the scene instead of keeping the noon or torchlight it was seen under.
  // Only the ambient: a torch lit now in a room nobody can see must not show.
  const snapshotColor = memoryLight ? sRGBTransferEOTF(sRGBTransferOETF(storedColor).mul(memoryLight)) : storedColor;

  let outColor;
  if (softTexture && look) {
    // THE SOFT FIELD (2026-11-02): the gate left `live x v`; add `memory x (1 - v) x e`, so live ground
    // fades into memory and memory fades into black, each over the field's band instead of a staircase.
    const { v, field } = sampleFogVisibility({
      THREE,
      softTexture,
      maskTexture,
      illumTexture,
      threshold,
      screenUV: uv(),
      look,
      extraRevealed,
    });
    const e = sampleFogMemory({ THREE, exploredTexture, uViewRect, uExploredRect, screenUV: uv(), field, look });
    // REMEMBERED, NOT SEEN: a little of the colour drains out, and a slow mist lifts and lowers it, so
    // memory reads as memory at a glance (the Look still grades it in the present).
    const grey = dot(snapshotColor, vec3(0.2126, 0.7152, 0.0722));
    const faded = mix(vec3(grey, grey, grey), snapshotColor, look.uMemorySaturation);
    const mistLift = float(1).add(look.uMist.mul(field.b.mul(2).sub(1)));
    outColor = faded.mul(look.uMemoryDim).mul(mistLift).mul(float(1).sub(v).mul(e));
  } else {
    const shouldDim = isExplored.and(revealed.not());
    outColor = select(shouldDim, snapshotColor.mul(float(dimFactor)), vec3(0, 0, 0));
  }

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  // dst + src — plain additive. The gate quad already zeroed this exact zone,
  // so adding here is a replace in every pixel that matters (see header).
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(outColor, float(0));
  return material;
}

/**
 * Build the SNAPSHOT PUBLISH QUAD — a SCREEN-space fullscreen draw, bound
 * directly to `exploredSnapshotTarget`, that writes
 * `captureMapOnlySnapshot()`'s screen-space capture into it.
 *
 * ⚠️ REBUILT 2026-08-16 AS A FULLSCREEN QUAD, NOT A WORLD-SPACE MESH — the
 * first cut positioned/scaled a `PlaneGeometry` to span the scene rect,
 * rendered it through `exploredCamera`, and derived screen coordinates from
 * its camera-projected `positionWorld` inside the shader. That version
 * published data (`snapshotPublishCount` climbed, no errors) but a live
 * pixel-probe proved it was wrong: `exploredSnapshotTarget` read back
 * near-black at the controlled token's own position while the SAME world
 * position's real albedo (a SEPARATE, independent diagnostic tool) read
 * bright and warm. Three rounds of re-deriving that mesh/camera/
 * `positionWorld` chain by hand found nothing provably wrong in it — which
 * is itself the reason not to trust it further. This version removes the
 * whole chain: `uv()` is NATURALLY 0..1 across whatever target is bound
 * (`exploredSnapshotTarget`, via a plain `QuadMesh`, exactly like the other
 * two quads in this pass), so world position comes from the SAME kind of
 * `mix(rect.x, rect.z, uv().x)` the dim quad already uses successfully —
 * one degree of transform fewer, and the ONE degree that was never proven
 * elsewhere in this file.
 *
 * ⚠️ STILL A WORLD ↔ SCREEN ROUND TRIP, JUST ONE HOP SHORTER — this quad's
 * OWN `uv()` → world (via `uExploredRect`) → screen (via `uViewRect`), where
 * the old version's mesh-projected `positionWorld` stood in for the first
 * hop. Same two uniforms as the dim quad, opposite final direction — get
 * that backwards and the memory paints in the wrong place, the recurring
 * shape `feedback_y_flip_recurring_risk` warns about, just on a different
 * axis pair.
 *
 * ⚠️ THE ON-SCREEN BOUNDS CHECK IS NOT OPTIONAL. `texture().sample()` clamps
 * out-of-range UV to the edge texel rather than returning "nothing" — without
 * an explicit check, every world texel OUTSIDE the current view would sample
 * and re-write whatever colour sits at the screen's own edge, smearing it
 * across the entire unseen map on every publish tick.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.mapOnlyTexture - `scene.colorMapOnly`, tokens/overlays excluded by construction.
 * @param {*} args.maskTexture @param {*} args.illumTexture @param {number} args.threshold - SAME reveal test as the other two quads.
 * @param {*} args.uViewRect - current camera's world-space view rect.
 * @param {*} args.uExploredRect - the explored buffers' own world rect — what THIS quad's `uv()` spans.
 * @param {boolean} [args.storeUnlit] - store plain map colour, not colour x illum (pair with the dim quad's `memoryLight`).
 * @returns {*} a NodeMaterial for a fullscreen quad bound to `exploredSnapshotTarget`.
 */
export function buildVisionSnapshotPublishMaterial({
  THREE,
  mapOnlyTexture,
  maskTexture,
  illumTexture,
  threshold,
  uViewRect,
  uExploredRect,
  storeUnlit = false,
  exploredTexture = null,
}) {
  const { texture, uv, float, vec3, vec4, select, mix, vec2, step, sRGBTransferEOTF, sRGBTransferOETF } = THREE.TSL;

  // This quad's own uv() → world position, via the SAME uExploredRect
  // mapping `buildVisionExploredDimMaterial`'s READ direction already uses
  // (screen→world there samples uExploredRect the same way this WRITE
  // direction does) — proven shape, just consumed here instead of there.
  const worldX = mix(uExploredRect.x, uExploredRect.z, uv().x);
  const worldY = mix(uExploredRect.y, uExploredRect.w, uv().y);

  // world → screen: the inverse of `mix(uViewRect.x, uViewRect.z, someUV)`.
  const screenU = worldX.sub(uViewRect.x).div(uViewRect.z.sub(uViewRect.x));
  const screenV = worldY.sub(uViewRect.y).div(uViewRect.w.sub(uViewRect.y));
  const screenUv = vec2(screenU, screenV);

  // Explicit on-screen test — see header. step(edge,x) is 0 below edge, 1 at/above.
  const onScreen = step(float(0), screenU)
    .mul(step(screenU, float(1)))
    .mul(step(float(0), screenV))
    .mul(step(screenV, float(1)));

  const mask = texture(maskTexture).sample(screenUv);
  const illum = texture(illumTexture).sample(screenUv);
  const revealed = buildRevealedNode({ THREE, mask, illum, threshold });
  // REMEMBERED GROUND REFILLS ITS COLOUR (2026-11-02): memory reloaded from a token's saved coverage
  // (`foundry/fog-memory-persistence.js`) arrives without colour, so any remembered texel on screen takes
  // the map's own art again — what Foundry's fog shows in explored areas too. Only with `storeUnlit`
  // (plain art): a lit store would freeze tonight's darkness into it.
  const remembered =
    exploredTexture && storeUnlit ? texture(exploredTexture).sample(uv()).r.greaterThan(float(0.02)) : null;
  const shouldWrite = (remembered ? revealed.or(remembered) : revealed).and(onScreen.greaterThan(float(0.5)));

  // LIT, NOT RAW ALBEDO — `captureMapOnlySnapshot()` re-renders the SAME
  // materials `geometry.world` uses, which output raw albedo; the
  // composite's own brightness comes from a LATER, separate multiply by
  // `buf:scene.illum` (`environmental-light.js`) that capture never gets.
  // Mirrors that module's OWN composite exactly — `illum` is already
  // sampled above for the reveal test, reused here for brightness too:
  // `EOTF( OETF(albedo) × illum )`, in gamma space (`buf:scene.illum` is
  // Foundry's own sRGB ambient — that module's header).
  const rawMapColor = texture(mapOnlyTexture).sample(screenUv).rgb;
  // `storeUnlit` (2026-10-28): keep the plain map colour and let the dim quad
  // light it with the CURRENT ambient — a lit snapshot freezes the noon sun or a
  // torch it was seen under, and then outshines the live scene at dusk.
  const litMapColor = storeUnlit ? rawMapColor : sRGBTransferEOTF(sRGBTransferOETF(rawMapColor).mul(illum.rgb));
  const outColor = select(shouldWrite, litMapColor, vec3(0, 0, 0));

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  // NormalBlending's zero-alpha-leaves-destination-untouched trick
  // (`vt/scene-attr.js`'s own header has the full mechanism) — a texel this
  // frame does not confirm as on-screen-and-revealed keeps whatever it held
  // from the last frame that DID confirm it, which is the persistence this
  // whole buffer exists for.
  material.blending = THREE.NormalBlending;
  material.fragmentNode = vec4(outColor, select(shouldWrite, float(1), float(0)));
  return material;
}

/**
 * Write a fan-triangulated polygon into a mesh's geometry, reusing the
 * existing attribute array whenever it still fits.
 *
 * ⚠️ REUSES THE ARRAY AND SETS `needsUpdate` — never allocates a new
 * `BufferAttribute` per frame, and never calls `dispose()` on one (there is no
 * such method; `reference_bufferattribute_no_dispose_trap`). A fresh attribute
 * every frame on every vision source is a real GPU-buffer leak, and vision
 * sources rebuild on every token move.
 *
 * @param {*} THREE @param {*} mesh @param {number[]} points @param {number} ox @param {number} oy
 * @returns {number} the vertex count now drawn
 */
function writeFanGeometry(THREE, mesh, points, ox, oy) {
  const existing = mesh.geometry.getAttribute('position');
  const { array, vertexCount } = triangulateLightFan(
    points,
    ox,
    oy,
    NO_RADIUS_NORMALISATION,
    existing ? existing.array : undefined
  );
  if (!existing || existing.array !== array) {
    mesh.geometry.setAttribute('position', new THREE.BufferAttribute(array, 3));
  } else {
    existing.needsUpdate = true;
  }
  // `setDrawRange` rather than resizing: the buffer is deliberately allowed to
  // stay larger than this frame's polygon (see triangulateLightFan's own reuse
  // contract), so the draw range is what makes stale tail vertices invisible.
  mesh.geometry.setDrawRange(0, vertexCount);
  return vertexCount;
}

/**
 * The subsystem. Self-contained on purpose — `vt-pan-viewer.js` is a ~15k-line
 * god object under concurrent edit, so its integration surface here is a
 * constructor, one `update()` and one `dispose()`.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.allocator - `graph/three-allocator.js`'s instance.
 * @param {string} [args.rtName]
 * @param {number} [args.resolvedW] - initial drawing-buffer width, device pixels.
 * @param {number} [args.resolvedH] - initial drawing-buffer height, device pixels.
 * @returns {{scene: *, texture: *, renderTarget: *, update: Function, dispose: Function, getInfo: Function}}
 */
export function createVisionMaskSubsystem({ THREE, allocator, rtName = 'vision.mask', resolvedW = 1, resolvedH = 1 }) {
  const scene = new THREE.Scene();
  // ⚠️ `resolvedW`/`resolvedH` ARE NOT OPTIONAL DECORATION.
  // `ThreeAllocator.describe()` reads `desc.resolvedW | 0` for a
  // `screenSized: true` target's ACTUAL initial size — `screenSized: true` is
  // only a LAW-CHECK flag (`enforceKeyholeLaw`'s ceiling is `LAW_MAX_SCREEN_
  // DIM`, not the drawing buffer), never an instruction to derive the size
  // from anywhere. Omitting these silently creates a 1×1 target (`Math.max(1,
  // undefined | 0)`) that renders nothing useful and stays that way until the
  // next `resize()` call — found live 2026-08-15 chasing a report of the gate
  // going solid black: every OTHER `screenSized: true` target in this
  // codebase is created through a `describeX = () => ({..., resolvedW:
  // drawBufW, resolvedH: drawBufH})` closure; this was the one built as a
  // static object literal instead, so it never got a real size, at
  // construction OR ever after.
  const rtDesc = {
    // SCREEN-SIZED: this mask is consumed by the fullscreen composite at
    // `uv()`, and is drawn with the SAME world camera as the light pass, so
    // it shares the screen's own resolution rather than claiming a world-space
    // budget of its own.
    screenSized: true,
    resolvedW,
    resolvedH,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    // NEAREST: every channel is a boolean. Linear filtering would invent
    // half-revealed pixels along a wall edge — a soft fog edge is a
    // presentation choice for the composite to make deliberately, never a
    // sampling accident in the information buffer.
    filter: 'nearest',
    depth: false,
  };
  const renderTarget = allocator.create(rtName, rtDesc);

  /**
   * THE SOFT FOG FIELD's three targets (see `buildVisionSoftBlurMaterial`): the
   * resolve at full size, the two blur passes at half size. LINEAR, unlike the
   * mask: these are the presentation of the rule, read with bilinear taps.
   * Screen-sized, resized with the mask.
   */
  const half = (n) => Math.max(1, Math.ceil(n / 2));
  const softResolveDesc = { ...rtDesc, filter: 'linear' };
  const softHDesc = { ...rtDesc, filter: 'linear', resolvedW: half(resolvedW), resolvedH: half(resolvedH) };
  const softDesc = { ...softHDesc };
  const softResolveTarget = allocator.create(`${rtName}.softResolve`, softResolveDesc);
  const softHTarget = allocator.create(`${rtName}.softH`, softHDesc);
  const softTarget = allocator.create(`${rtName}.soft`, softDesc);

  /**
   * THE EXPLORED-AREA BUFFER (slice 3) — WORLD space, never cleared.
   *
   * ⚠️ WORLD-SPACE, NOT SCREEN-SPACE, AND THAT IS THE WHOLE DIFFICULTY. The
   * live mask above is screen-space because it is consumed by a fullscreen
   * gate. Exploration must survive the camera moving, so it is accumulated
   * against the SCENE rect and sampled back through a screen→world→buffer UV
   * mapping. A screen-space accumulation would smear a trail across the map
   * every time the GM panned.
   *
   * ⚠️ NEVER CLEARED, BY DESIGN. Every other target here is cleared each
   * frame; this one is the opposite — it MAX-accumulates forever, because
   * "explored" is monotonic within a session. `resetExploration` exists for
   * the one legitimate reason to wipe it (a scene change, or a GM resetting
   * fog), and nothing else may clear it.
   *
   * 2048² is the world-res cap `docs/planning/Vision-Fog-Ownership.md` §4
   * commits to, matching the sun-shadow field's own ladder — O(1) in map size,
   * so a 12,000px map and a 2,000px map cost the same.
   */
  const exploredRtDesc = {
    resolvedW: 2048,
    resolvedH: 2048,
    screenSized: false,
    // Sized from the scene rect by `setExploredRect` (up to EXPLORED_MAX_DIM), so it is the named fog exception.
    allowWorldScale: true,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    // LINEAR here, unlike the live mask's NEAREST: the explored boundary is a
    // remembered edge a player has already seen, so a soft ramp reads better
    // than a 2048-texel staircase, and no information is gated on its exact
    // position (the LIVE gate is what decides what is currently visible).
    filter: 'linear',
    depth: false,
  };
  const exploredTarget = allocator.create(`${rtName}.explored`, exploredRtDesc);

  /**
   * THE EXPLORED SNAPSHOT (slice: dim explored zone) — finishes what slice 3
   * left at `exploredDimNode = 0`. See `vision-mask.js`'s own header and
   * `docs/planning/Vision-Fog-Ownership.md` §4 slice 3's boxed note for why a
   * naive dim was rejected: the gate multiplies the FULLY COMPOSITED frame,
   * so any non-zero dim there would show live tokens/candles/particles at
   * reduced brightness in areas the viewer cannot currently see — a leak,
   * not a look. The fix the doc names is "gate tokens/effects OUT of
   * `buf:scene.color` AT THE GEOMETRY STAGE".
   *
   * WORLD-space, PERSISTENT (never cleared except on scene change, same
   * trigger as `exploredTarget` above), holds the last-seen floor-art colour.
   * The caller (`vt-pan-viewer.js`, which owns the world-draw item list) is
   * responsible for:
   *   1. Capturing a "map-only" pass — the SAME `geometry.world` scene,
   *      SAME main camera, SAME already-built materials, with every
   *      token/vegetationOverlay-kind mesh's `.visible` temporarily false —
   *      into a screen-sized scratch target. Reusing the real, already-built
   *      materials (rather than a parallel material this subsystem would
   *      have to construct and keep in sync with `buildWholeImageMaterial`)
   *      is deliberate: it is the low-risk direction, and it means a token
   *      is EXCLUDED BY CONSTRUCTION — it is never in the scene this draw
   *      walks, not merely masked out after the fact.
   *   2. "Publishing" that screen-space capture into THIS world-space target
   *      via a fullscreen quad through `exploredCamera`, gated per-fragment
   *      on the SAME reveal test the live gate uses (so an unexplored room
   *      can never be peeked into permanent memory) and outputting
   *      `vec4(0,0,0,0)` elsewhere — the same "zero alpha leaves the
   *      destination untouched" NormalBlending trick `vt/scene-attr.js`
   *      already relies on for its own safe default, reused rather than
   *      reinvented. `buildVisionSnapshotPublishMaterial` below builds that
   *      quad's material; this module only owns the persistent target itself.
   * A texel this buffer has painted once stays painted forever (until the
   * next repaint from that same world position), which is exactly
   * "remembered", and it can NEVER hold a token or a candle flame because
   * those meshes are never in the capture this publishes from.
   */
  const exploredSnapshotRtDesc = {
    resolvedW: 2048,
    resolvedH: 2048,
    screenSized: false,
    allowWorldScale: true, // as `exploredRtDesc`: sized by `setExploredRect`
    // (kept on the descriptor so `allocator.resize` accepts the larger size)
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    // LINEAR: this holds real remembered colour, not a boolean — a blocky
    // 2048-texel staircase across painted map art would be an obvious tell,
    // same reasoning `exploredRtDesc` already gives for its own boundary.
    filter: 'linear',
    depth: false,
  };
  const exploredSnapshotTarget = allocator.create(`${rtName}.exploredSnapshot`, exploredSnapshotRtDesc);

  /**
   * THE REVEAL FADE's history, ping-pong (`buildVisionRevealHistoryMaterial`): world space over the
   * explored rect, a third of the explored buffer's size (it only shapes a fade, never an edge).
   * LINEAR, R only in use. `next` is drawn from `current`, then copied back, so consumers read one texture.
   */
  const revealDesc = { ...exploredRtDesc, resolvedW: 512, resolvedH: 512 };
  const revealCurrentTarget = allocator.create(`${rtName}.revealHistory`, revealDesc);
  const revealNextTarget = allocator.create(`${rtName}.revealHistoryNext`, { ...revealDesc });

  /** The world rect the explored buffer covers, as [x0,y0,x1,y1]. */
  let exploredRect = [0, 0, 1, 1];
  /** Ortho camera over `exploredRect` — rebuilt only when the rect changes. */
  let exploredCamera = null;
  let exploredNeedsClear = true;

  /** sourceId → {losMesh, lightMesh} */
  const pool = new Map();
  let lastDrawn = 0;
  let lastGate = null;

  /**
   * DOOR-FOG-REVEAL-SYNC — the frozen "floor" scene (see
   * `buildVisionFloorMaterial`'s own header). `floorSourcesRef` is a
   * reference-equality gate: the mesh set is rebuilt only when the caller
   * hands `syncFloor` a DIFFERENT sources array — once per transition
   * start/end, never per frame, because `vt-pan-viewer.js`'s glue holds one
   * frozen reference for the whole transition window. The DRAW still
   * happens every frame the caller asks for it (this target is cleared
   * every frame by the live mask draw above it); only the geometry rebuild
   * is skipped.
   */
  const floorScene = new THREE.Scene();
  let floorSourcesRef = null;
  let floorMeshes = [];

  function clearFloorMeshes() {
    for (const mesh of floorMeshes) {
      floorScene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    floorMeshes = [];
  }

  function addFloorMesh(points, ox, oy) {
    const { material } = buildVisionFloorMaterial({ THREE });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.frustumCulled = false; // bounding sphere never computed — see createEntry's own note
    writeFanGeometry(THREE, mesh, points, ox, oy);
    mesh.position.set(ox, oy, 0);
    floorScene.add(mesh);
    floorMeshes.push(mesh);
  }

  function rebuildFloorMeshes(sources) {
    clearFloorMeshes();
    for (const src of sources) {
      // Dropped, not drawn-then-masked — same fail-safe direction the live
      // pool uses for a blinded source (this file's own header).
      if (!src || src.blinded) continue;
      if (src.losPoints) addFloorMesh(src.losPoints, src.x, src.y);
      if (src.lightPoints) addFloorMesh(src.lightPoints, src.x, src.y);
    }
  }

  function createEntry() {
    const los = buildVisionLosMaterial({ THREE });
    const light = buildVisionLightMaterial({ THREE });
    const losMesh = new THREE.Mesh(new THREE.BufferGeometry(), los.material);
    const lightMesh = new THREE.Mesh(new THREE.BufferGeometry(), light.material);
    // Frustum culling OFF: the geometry is rewritten in place every frame and
    // its bounding sphere is never recomputed, so three's own cull test would
    // be deciding against a stale volume — the classic way a correct mesh
    // silently stops drawing.
    losMesh.frustumCulled = false;
    lightMesh.frustumCulled = false;
    losMesh.renderOrder = 0;
    lightMesh.renderOrder = 1;
    scene.add(losMesh);
    scene.add(lightMesh);
    return { losMesh, lightMesh };
  }

  function disposeEntry(entry) {
    scene.remove(entry.losMesh);
    scene.remove(entry.lightMesh);
    entry.losMesh.geometry.dispose();
    entry.lightMesh.geometry.dispose();
    entry.losMesh.material.dispose();
    entry.lightMesh.material.dispose();
  }

  /**
   * DOOR-FOG-REVEAL-SYNC — draw the frozen floor into THIS SAME render
   * target's G channel, on top of whatever `sync()` already drew this frame
   * (MAX blending, so R/B/A are untouched — see `buildVisionFloorMaterial`).
   * Rebuilds the mesh set only when `sources` is a DIFFERENT reference than
   * last call; pass `null` (or an empty array) to freeze nothing / drop an
   * ended transition's floor.
   *
   * @param {{sources: Array<object>|null}} args
   * @returns {{target: *, scene: *, drawn: number}} the draw the host should
   *   perform IMMEDIATELY after `sync()`'s own live-mask render, same
   *   target, no clear in between — every frame a transition is active, not
   *   just once at freeze time (this target is cleared every frame).
   */
  function syncFloor({ sources }) {
    const next = Array.isArray(sources) && sources.length > 0 ? sources : null;
    if (next !== floorSourcesRef) {
      floorSourcesRef = next;
      if (next) rebuildFloorMeshes(next);
      else clearFloorMeshes();
    }
    return { target: renderTarget, scene: floorScene, drawn: floorMeshes.length };
  }

  /**
   * Reconcile the pool against this frame's sources and rebuild geometry.
   *
   * ⚠️ DELIBERATELY DOES NOT TOUCH THE RENDERER. `renderer-state/graph-only`
   * is a structure wall with a body count behind it: V2 had 452
   * `setRenderTarget` sites across 60 files and 262 touches of a global
   * `autoClear`, which is the bug class that produces "it works unless you
   * enable bloom, then shadows break" — unfixable at the call site because
   * the call site isn't wrong. So this returns a DESCRIPTION of the draw and
   * the frame host performs it, exactly as `regionScene`/`lightScene` already
   * work. The structure check caught an earlier version of this file binding
   * its own target; the wall was right.
   *
   * ⚠️ THE CLEAR COLOUR IS PART OF THE ANSWER, not a detail for the caller to
   * pick. When `gate` is false the mask must clear to WHITE — "revealed
   * everywhere" — which is the correct view for a GM with nothing selected
   * (Foundry skips its whole visibility group there too). Leaving it stale
   * would freeze the last token's view onto the GM's screen; clearing to
   * BLACK would blind them. When gating IS on it clears to BLACK, so nothing
   * is revealed until a source actually draws it — the fail-safe direction,
   * because an empty mask then hides the map rather than exposing it.
   *
   * @param {object} args
   * @param {Array<object>} args.sources - from `foundry/scene-vision.js`.
   * @param {boolean} args.gate - from `vision-mask.js#decideFogGating`.
   * @returns {{target: *, scene: *, clearColor: number, drawn: number}} the
   *   draw the host should perform.
   */
  function sync({ sources, gate }) {
    lastGate = gate;
    const live = Array.isArray(sources) ? sources : [];

    if (!gate) {
      for (const [, entry] of pool) {
        entry.losMesh.visible = false;
        entry.lightMesh.visible = false;
      }
      lastDrawn = 0;
      return { target: renderTarget, scene, clearColor: 0xffffff, drawn: 0 };
    }

    const seen = new Set();
    let drawn = 0;
    for (const src of live) {
      const id = src?.sourceId;
      if (typeof id !== 'string' || id.length === 0) continue;
      if (seen.has(id)) continue; // a duplicate id must not produce two meshes
      seen.add(id);
      // A blinded source contributes NOTHING — see this module's header for
      // why dropping (rather than drawing-then-masking) is the safe direction.
      if (src.blinded) continue;

      let entry = pool.get(id);
      if (!entry) {
        entry = createEntry();
        pool.set(id, entry);
      }

      if (src.losPoints) {
        writeFanGeometry(THREE, entry.losMesh, src.losPoints, src.x, src.y);
        entry.losMesh.position.set(src.x, src.y, 0);
        entry.losMesh.visible = true;
        drawn++;
      } else {
        entry.losMesh.visible = false;
      }

      if (src.lightPoints) {
        writeFanGeometry(THREE, entry.lightMesh, src.lightPoints, src.x, src.y);
        entry.lightMesh.position.set(src.x, src.y, 0);
        entry.lightMesh.visible = true;
        drawn++;
      } else {
        entry.lightMesh.visible = false;
      }
    }

    // Drop anything that went away — a pool that only grows is a GPU leak, and
    // vision sources churn on every selection, move and refreshVision.
    for (const [id, entry] of [...pool]) {
      if (seen.has(id)) continue;
      disposeEntry(entry);
      pool.delete(id);
    }

    lastDrawn = drawn;
    // Consumed ONCE, shared by `explored` and `snapshot` below — a scene
    // change wipes both the boolean "ever seen" buffer and the remembered
    // colour together, since they describe the same underlying concept.
    const clearFirst = exploredNeedsClear;
    exploredNeedsClear = false;
    return {
      target: renderTarget,
      scene,
      clearColor: 0x000000,
      drawn,
      // The SECOND draw the host must perform: the same fan scene, into the
      // world-space explored buffer, MAX-accumulated and NEVER cleared.
      explored: {
        target: exploredTarget,
        camera: exploredCamera,
        clearFirst,
      },
      // THE PUBLISH DRAW (dim-explored slice) — see `exploredSnapshotTarget`'s
      // own header for the full mechanism — REBUILT 2026-08-16 as a plain
      // screen-space fullscreen quad (no `camera` field needed here any
      // more; the quad's own `uv()` covers `exploredSnapshotTarget`
      // directly, the same way `explored.target` above is written by real
      // geometry through a camera but this one no longer is).
      snapshot: {
        target: exploredSnapshotTarget,
        clearFirst,
      },
    };
  }

  /**
   * Point the explored buffer at a world rect (the scene rect). Rebuilds the
   * ortho camera and schedules ONE clear.
   *
   * ⚠️ CALLING THIS WIPES EXPLORATION, so it must be driven by a real scene
   * change and nothing else — not by a resize, not by a floor switch. Wiping
   * exploration mid-session hands players back territory they had already
   * mapped, which is a gameplay event, not a rendering one.
   *
   * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect
   */
  function setExploredRect(rect) {
    const next = [rect.minX, rect.minY, rect.maxX, rect.maxY];
    if (next.every((v, i) => v === exploredRect[i]) && exploredCamera) return;
    exploredRect = next;
    // RESOLUTION FOLLOWS THE SCENE (2026-10-31). The author: previously explored areas were *"very very low
    // resolution"*. A fixed 2048² square squeezed a 10,000 x 8,000 px map to ~5 world px per texel (and
    // stretched it, since the scene is not square). Give the buffers the scene's own shape instead, one texel
    // per world px at most, capped so a huge map cannot spend more than ~75 MB across the two buffers.
    {
      const w = Math.max(1, rect.maxX - rect.minX);
      const h = Math.max(1, rect.maxY - rect.minY);
      const k = Math.min(1, EXPLORED_MAX_DIM / Math.max(w, h));
      const tw = Math.max(EXPLORED_MIN_DIM, Math.round(w * k));
      const th = Math.max(EXPLORED_MIN_DIM, Math.round(h * k));
      if (tw !== exploredRtDesc.resolvedW || th !== exploredRtDesc.resolvedH) {
        for (const desc of [exploredRtDesc, exploredSnapshotRtDesc]) {
          desc.resolvedW = tw;
          desc.resolvedH = th;
        }
        allocator.resize(exploredTarget, tw, th, exploredRtDesc);
        allocator.resize(exploredSnapshotTarget, tw, th, exploredSnapshotRtDesc);
      }
      const rw = Math.max(64, Math.round(tw / REVEAL_HISTORY_DIVISOR));
      const rh = Math.max(64, Math.round(th / REVEAL_HISTORY_DIVISOR));
      if (rw !== revealDesc.resolvedW || rh !== revealDesc.resolvedH) {
        revealDesc.resolvedW = rw;
        revealDesc.resolvedH = rh;
        allocator.resize(revealCurrentTarget, rw, rh, revealDesc);
        allocator.resize(revealNextTarget, rw, rh, { ...revealDesc });
      }
    }
    // Ortho over the world rect. Y is NOT flipped: MSA's world space is
    // Foundry pixel space with +Y down, the same convention the light meshes
    // use (`point-light-pool.js` positions with raw Foundry coords), so top =
    // minY and bottom = maxY. Getting this backwards would mirror exploration
    // vertically — the recurring Y-flip trap, avoided by matching the proven
    // call site rather than reasoning from scratch.
    exploredCamera = new THREE.OrthographicCamera(rect.minX, rect.maxX, rect.minY, rect.maxY, -1, 1);
    exploredCamera.updateProjectionMatrix();
    exploredNeedsClear = true;
  }

  /** The gate needs to know which world rect the buffer covers. */
  function getExploredRect() {
    return exploredRect;
  }

  /** Wipe exploration — a GM resetting fog, or a scene change. */
  function resetExploration() {
    exploredNeedsClear = true;
  }

  /**
   * Re-enforce the live mask's SCREEN-SIZED contract at the new drawing-buffer
   * size, on window resize / sidebar toggle / Foundry relayout. Reuses the
   * SAME `rtDesc` object `create()` was given above — never a hand-copied
   * duplicate — so this can't drift into resizing the target against a
   * description that no longer matches what it was actually created with,
   * and so `enforceKeyholeLaw` checks it against the descriptor this target
   * really owns.
   *
   * ⚠️ THE EXPLORED BUFFER IS DELIBERATELY NOT HERE. It is `screenSized:
   * false` (a fixed 2048² world-res budget, see its own doc comment above) —
   * resizing it with the drawing buffer would be exactly the "a world-res
   * target smuggled past the screen-sized law" bug `enforceKeyholeLaw`
   * exists to catch, not a fix.
   *
   * @param {number} w @param {number} h - new drawing-buffer size, device pixels.
   */
  function resize(w, h) {
    // Keep `rtDesc` truthful, not just the live target — it is the SAME
    // object `enforceKeyholeLaw` checks against on every future call, and the
    // one place `resolvedW`/`resolvedH` were wrong in the first place.
    rtDesc.resolvedW = w;
    rtDesc.resolvedH = h;
    allocator.resize(renderTarget, w, h, rtDesc);
    softResolveDesc.resolvedW = w;
    softResolveDesc.resolvedH = h;
    allocator.resize(softResolveTarget, w, h, softResolveDesc);
    for (const [target, desc] of [
      [softHTarget, softHDesc],
      [softTarget, softDesc],
    ]) {
      desc.resolvedW = half(w);
      desc.resolvedH = half(h);
      allocator.resize(target, desc.resolvedW, desc.resolvedH, desc);
    }
  }

  function dispose() {
    allocator.dispose(softResolveTarget);
    allocator.dispose(revealCurrentTarget);
    allocator.dispose(revealNextTarget);
    allocator.dispose(softHTarget);
    allocator.dispose(softTarget);
    for (const [, entry] of pool) disposeEntry(entry);
    pool.clear();
    clearFloorMeshes();
    allocator.dispose(renderTarget);
    allocator.dispose(exploredTarget);
    allocator.dispose(exploredSnapshotTarget);
  }

  /** For the Diagnostics report — a mask that silently stopped drawing must be
   *  visible as a number, not inferred from a dark screen
   *  (`feedback_diagnostics_must_land_in_perf_report`). */
  function getInfo() {
    return {
      pooled: pool.size,
      meshesDrawn: lastDrawn,
      gated: lastGate,
      // The explored buffer never clears, so "is it accumulating" cannot be
      // read off a screenshot — report the rect it covers instead.
      exploredRect: [...exploredRect],
      // DOOR-FOG-REVEAL-SYNC — a floor that silently stopped drawing (or
      // never started) must be visible as a number here too, same doctrine
      // as every other count in this report.
      doorFogFloorActive: floorSourcesRef !== null,
      doorFogFloorMeshCount: floorMeshes.length,
      // The live mask's OWN current size — added 2026-08-15 chasing a report
      // of the gate going solid black after resize/pan/zoom. Sits next to
      // the viewer's own `drawBufSize` in `getVisionMaskInfo` so a mismatch
      // between the two is a subtraction, not an inference
      // (`feedback_diagnostics_must_land_in_perf_report`: a number nobody
      // printed cannot be checked from a pasted-back report).
      maskSize: [renderTarget.width, renderTarget.height],
    };
  }

  return {
    scene,
    renderTarget,
    get texture() {
      return renderTarget.texture;
    },
    sync,
    syncFloor,
    resize,
    setExploredRect,
    getExploredRect,
    resetExploration,
    get exploredTexture() {
      return exploredTarget.texture;
    },
    get exploredSnapshotTexture() {
      return exploredSnapshotTarget.texture;
    },
    // The RAW render target (not just its `.texture`) — a one-pixel diagnostic
    // readback needs `.width`/`.height` plus the target itself for
    // `renderer.readRenderTargetPixelsAsync(target, ...)`. Only `vt/` may call
    // that API directly (`no-gpu-readback`, tools/verify-structure.mjs); this
    // effect module may not, so the readback itself lives at the call site
    // (`vt-pan-viewer.js`'s `probeExploredSnapshotColor`, next to its sibling
    // `probeMapOnlyGrid`) and this getter is the one door it reads through.
    get exploredSnapshotTarget() {
      return exploredSnapshotTarget;
    },
    /** The explored buffer itself, for the coverage publish to bind (its R is now soft coverage). */
    get exploredTarget() {
      return exploredTarget;
    },
    /** The soft fog field's targets, in draw order (resolve → blur H → blur V). */
    softTargets: { resolve: softResolveTarget, blurH: softHTarget, field: softTarget },
    /** The reveal fade's history pair (`buildVisionRevealHistoryMaterial`): draw `next` from `current`, copy back. */
    revealTargets: { current: revealCurrentTarget, next: revealNextTarget },
    get softTexture() {
      return softTarget.texture;
    },
    dispose,
    getInfo,
  };
}
