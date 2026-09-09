/**
 * TILE-MOTION TSL NODES — shared by every per-item effect surface that needs
 * to track a Tile's LIVE tile-motion pose (mythica-machina-press#538/#539).
 * THREE is INJECTED (`TSL` only, never imported), matching every render
 * module in this tree.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS, RATHER THAN A THIRD/FOURTH INLINE COPY
 * ============================================================================
 * `vt-pan-viewer.js` already carries TWO copies of this exact rigid-transform
 * formula — `buildWholeImageMaterial`'s own `material.positionNode` (the
 * tile's real, visible mesh) and `tileMotionDepthProxyNodeCache`'s cached
 * depth-proxy twin — each with its own header explaining why it is a
 * deliberate, cross-referenced duplicate rather than a shared helper (the
 * depth-proxy one is keyed and cached differently, and `vt/` owns GPU
 * lifecycle in a way `effects/` render modules structurally cannot reach
 * into). Window and Specular's new per-TILE surfaces
 * (`window-tile-surface-subsystem.js`, `specular-tile-surface-subsystem.js`)
 * need the IDENTICAL formula a third and fourth time, and unlike the depth
 * proxy they are genuinely interchangeable consumers — so THIS is the one
 * new shared copy, used by both, rather than two more hand-copies. Keep this
 * module's two functions byte-for-byte in lockstep with `vt-pan-viewer.js`'s
 * own `buildWholeImageMaterial` if either ever changes; there is no
 * mechanical check that they agree, only this comment.
 *
 * ============================================================================
 * WHY THE SURFACE REUSES THE TILE'S OWN `tileMotion` BAG, NEVER A COPY
 * ============================================================================
 * `syncAllTileMotionForFrame` (vt-pan-viewer.js) already writes fresh
 * `uMotionPivot`/`uMotionRot`/`uMotionTranslate`/`uTexPivotUV`/
 * `uTexScrollUV`/`uTexRotUV` values into the tile's own uniform bag every
 * frame, for the tile's OWN visible mesh. A per-tile Window/Specular surface
 * that built ITS OWN, separate uniform bag would need a second per-frame
 * writer to keep it live — a second authority for one fact, the exact
 * shape `tileMotionDepthProxyNodeCache`'s own header already names and
 * avoids ("this needs no new per-frame write of its own"). These two
 * builders therefore take the tile's EXISTING bag (resolved by the viewer,
 * see `resolveItemTileMotion` in `vt-pan-viewer.js`) and read it BY
 * REFERENCE, exactly as the depth-proxy cache does.
 *
 * ============================================================================
 * THE TWO MODES, AND WHY EACH BUILDER OWNS ONLY ONE
 * ============================================================================
 * `transform` mode moves the GEOMETRY (`buildTileMotionPositionNode`);
 * `texture` mode leaves the quad still and scrolls the MASK's own UV sample
 * instead (`buildTileMotionMaskUvNode`). `computeTileWorldTransforms`
 * (`foundry/tile-motion.js`) already resolves each tile to exactly one of
 * these — a `texture`-mode tile's `uMotionPivot/Rot/Translate` are pushed as
 * the identity transform every frame, and a `transform`-mode tile's
 * `uTexPivotUV/ScrollUV/RotUV` are pushed as the identity UV pose — so a
 * caller wires BOTH builders UNCONDITIONALLY onto every tile-motion-bearing
 * surface, with no per-mode branch of its own: whichever half is inactive
 * this frame is algebraically the identity (a no-op sub/rotate/add chain),
 * never a missing feature. `window-tile-surface-subsystem.js`/`specular-
 * tile-surface-subsystem.js` both do exactly this — one fewer cross-file
 * "which mode is this tile in" question to keep in sync, at the cost of a
 * few negligible ALU ops on the far more common `transform`/no-scroll case.
 *
 * A tile with NO tile-motion configured at all never reaches either
 * builder — its surface is built with `positionNode`/`maskUvNode` both
 * omitted, which is an ordinary static per-tile surface (identity
 * transform), matching this module's callers' own doc.
 *
 * @module effects/tile-motion-nodes
 */

/**
 * The transform-mode position node — moves the surface's own quad in lock
 * step with the tile's visible mesh. BYTE-FOR-BYTE the same formula as
 * `vt-pan-viewer.js#buildWholeImageMaterial`'s `material.positionNode` and
 * `tileMotionDepthProxyNodeCache`'s cached twin: `v' = pivot + Rot(delta)*(v
 * - pivot) + translate`, applied to the REST-pose world vertex (this
 * renderer bakes a tile's static rotation into its position attribute at
 * mesh-build time — `world-quad.js` — so `positionLocal.xy` IS the rest-pose
 * WORLD xy, with no separate model matrix to account for).
 *
 * The pure-JS twin proving this arithmetic is `foundry/tile-motion.js#
 * applyRigidDelta`, already asserted in Node — `uMotionPivot`/`uMotionRot`/
 * `uMotionTranslate` are exactly `{pivotWorldX, pivotWorldY}`, `{cos, sin}`
 * of `deltaRotationRad`, and `{translateWorldX, translateWorldY}` from that
 * function's own `RigidDelta` argument.
 *
 * @param {*} TSL - `THREE.TSL`, injected.
 * @param {{uMotionPivot:*, uMotionRot:*, uMotionTranslate:*}} tileMotion -
 *   the tile's OWN live uniform bag (`resolveItemTileMotion`'s return),
 *   never a fresh copy — see this module's own header.
 * @returns {*} a position node, ready to assign to `material.positionNode`.
 */
export function buildTileMotionPositionNode(TSL, tileMotion) {
  const { Fn, vec2, vec3, positionLocal } = TSL;
  return Fn(() => {
    const rel = positionLocal.xy.sub(tileMotion.uMotionPivot);
    const rotated = vec2(
      rel.x.mul(tileMotion.uMotionRot.x).sub(rel.y.mul(tileMotion.uMotionRot.y)),
      rel.x.mul(tileMotion.uMotionRot.y).add(rel.y.mul(tileMotion.uMotionRot.x))
    );
    const xy = tileMotion.uMotionPivot.add(rotated).add(tileMotion.uMotionTranslate);
    return vec3(xy.x, xy.y, positionLocal.z);
  })();
}

/**
 * The texture-mode UV node — leaves the quad still and scrolls/rotates the
 * MASK's own sample coordinate instead, so a `texture`-mode tile's mask
 * scrolls exactly the way its albedo does. BYTE-FOR-BYTE the same formula as
 * `vt-pan-viewer.js#buildWholeImageMaterial`'s `colorNode` texture-mode
 * branch — translate to the pivot, rotate, translate back, then scroll,
 * verified there against `THREE.Texture`'s own `Matrix3#setUvTransform`
 * composition rather than guessed. The pure-JS twin is `foundry/tile-
 * motion.js#applyTileMotionTextureUv`.
 *
 * ⚠️ Takes the BASE uv node as a parameter rather than calling `uv()`
 * itself — the mask quad's own UV attribute (never `uv().mul(uUvScale)`,
 * which is `buildWholeImageMaterial`'s OWN concern for a possibly-padded
 * compressed art texture; a mask loaded through `loadMaskImage` carries no
 * such padding, so its caller passes the mask's own `uv()` unscaled).
 *
 * @param {*} TSL - `THREE.TSL`, injected.
 * @param {{uTexPivotUV:*, uTexScrollUV:*, uTexRotUV:*}} tileMotion - the
 *   tile's OWN live uniform bag, never a fresh copy.
 * @param {*} baseUv - the untransformed base UV node (e.g. `uv()`).
 * @returns {*} the transformed UV node, ready to feed a `texture()` sample.
 */
export function buildTileMotionMaskUvNode(TSL, tileMotion, baseUv) {
  const { vec2 } = TSL;
  const rel = baseUv.sub(tileMotion.uTexPivotUV);
  const rc = tileMotion.uTexRotUV.x;
  const rs = tileMotion.uTexRotUV.y;
  const rotated = vec2(rel.x.mul(rc).add(rel.y.mul(rs)), rel.y.mul(rc).sub(rel.x.mul(rs)));
  return tileMotion.uTexPivotUV.add(tileMotion.uTexScrollUV).add(rotated);
}
