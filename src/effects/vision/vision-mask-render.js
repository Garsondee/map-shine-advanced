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
 * @returns {*} a boolean TSL node.
 */
function buildRevealedNode({ THREE, mask, illum, threshold }) {
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
  return insideSight.or(insideLight.and(litEnough));
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
export function buildVisionGateMaterial({ THREE, maskTexture, illumTexture, threshold, doorFogProgress = null }) {
  const { texture, uv, float, vec4, select } = THREE.TSL;

  const mask = texture(maskTexture).sample(uv());
  const illum = texture(illumTexture).sample(uv());
  const revealed = buildRevealedNode({ THREE, mask, illum, threshold });

  // wasFloorRevealed=true (or no doorFogProgress supplied at all) → factor 1,
  // byte-for-byte today's behaviour. Only a pixel that is revealed now AND
  // was NOT on the frozen floor gets the fade — see this param's own doc.
  const doorProgress = doorFogProgress ? doorFogProgress.clamp(0, 1) : float(1);
  const wasFloorRevealed = mask.g.greaterThan(float(0.5));
  const revealFactor = select(wasFloorRevealed, float(1), doorProgress);
  const factor = select(revealed, revealFactor, float(0));

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
}) {
  const { texture, uv, float, vec3, vec4, select, mix, vec2 } = THREE.TSL;

  const mask = texture(maskTexture).sample(uv());
  const illum = texture(illumTexture).sample(uv());
  const revealed = buildRevealedNode({ THREE, mask, illum, threshold });

  // Screen UV → world position → explored-buffer UV. Identical mapping to
  // `sun-occlusion-render.js#buildSunVisibilityNode`, reused rather than
  // re-derived so the two cannot drift (and so a Y-flip mistake here would
  // have to be a mistake there too, where it is already proven correct).
  const worldX = mix(uViewRect.x, uViewRect.z, uv().x);
  const worldY = mix(uViewRect.y, uViewRect.w, uv().y);
  const eu = worldX.sub(uExploredRect.x).div(uExploredRect.z.sub(uExploredRect.x));
  const ev = worldY.sub(uExploredRect.y).div(uExploredRect.w.sub(uExploredRect.y));
  const bufferUv = vec2(eu.clamp(0, 1), ev.clamp(0, 1));
  const isExplored = texture(exploredTexture).sample(bufferUv).r.greaterThan(float(0.5));
  const snapshotColor = texture(exploredSnapshotTexture).sample(bufferUv).rgb;

  const shouldDim = isExplored.and(revealed.not());
  const outColor = select(shouldDim, snapshotColor.mul(float(dimFactor)), vec3(0, 0, 0));

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
  const shouldWrite = revealed.and(onScreen.greaterThan(float(0.5)));

  // LIT, NOT RAW ALBEDO — `captureMapOnlySnapshot()` re-renders the SAME
  // materials `geometry.world` uses, which output raw albedo; the
  // composite's own brightness comes from a LATER, separate multiply by
  // `buf:scene.illum` (`environmental-light.js`) that capture never gets.
  // Mirrors that module's OWN composite exactly — `illum` is already
  // sampled above for the reveal test, reused here for brightness too:
  // `EOTF( OETF(albedo) × illum )`, in gamma space (`buf:scene.illum` is
  // Foundry's own sRGB ambient — that module's header).
  const rawMapColor = texture(mapOnlyTexture).sample(screenUv).rgb;
  const litMapColor = sRGBTransferEOTF(sRGBTransferOETF(rawMapColor).mul(illum.rgb));
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
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    // LINEAR: this holds real remembered colour, not a boolean — a blocky
    // 2048-texel staircase across painted map art would be an obvious tell,
    // same reasoning `exploredRtDesc` already gives for its own boundary.
    filter: 'linear',
    depth: false,
  };
  const exploredSnapshotTarget = allocator.create(`${rtName}.exploredSnapshot`, exploredSnapshotRtDesc);

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
  }

  function dispose() {
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
    dispose,
    getInfo,
  };
}
