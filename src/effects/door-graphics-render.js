/**
 * DOOR GRAPHICS — THE RUNTIME (pure parity math + the textured-quad material).
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * Foundry draws a textured door as `DoorMesh` (client/canvas/containers/
 * elements/door-mesh.mjs) — a sprite pinned to the wall that swings / slides /
 * ascends / descends / swivels between closed and open. This file replicates
 * that math so MSA draws the SAME leaf. `effects/door-graphics.js` is the
 * DECLARATION (params + manifest); `foundry/scene-doors.js` READS the door
 * documents; `vt/vt-pan-viewer.js` owns the GPU lifecycle and per-frame clock,
 * calling these pure builders — the exact declaration / adapter / runtime split
 * the candle already follows.
 *
 * ============================================================================
 * COORDINATES — WHY THIS IS SIMPLER THAN THE LEGACY DoorMeshManager
 * ============================================================================
 * V3 world space IS Foundry canvas space (+Y DOWN); the viewer's ORTHOGRAPHIC
 * camera owns the one Y-flip (`top = worldRect.minY`, scene/world-quad.js). So
 * a door built at the wall's raw canvas endpoints needs ZERO manual Y math —
 * and this file's placement feeds the SAME `computeQuadCorners`
 * (foundry/scene-geometry.js) every tile already uses, whose rotation
 * convention IS Foundry's own (it cites `RectangleShapeData#_createCenter`).
 *
 * The legacy `DoorMeshManager` (legacy/scene/DoorMeshManager.js) instead ran
 * everything through `Coordinates.toWorld` because ITS world was Y-UP — a flip
 * that would be WRONG here. Reproducing Foundry's formulas against raw canvas
 * coordinates, rather than porting the legacy Y-up variant, is the whole reason
 * the recurring Y-flip bug (feedback_y_flip_recurring_risk) cannot bite: there
 * is no hand-rolled world↔screen mapping in this file at all.
 *
 * Everything here is pure — no THREE (except the one clearly-marked material
 * builder that TAKES `THREE`), no Foundry, no DOM — and Node-tested against
 * `DoorMesh`'s own formulas.
 *
 * @module effects/door-graphics-render
 */

/**
 * The three rendering styles of a door leaf (`DoorMesh.DOOR_STYLES`, verbatim).
 * A single door is one SINGLE leaf; a double door is a DOUBLE_LEFT + a
 * DOUBLE_RIGHT leaf, hinged at opposite ends.
 * @enum {string}
 */
export const DOOR_STYLES = Object.freeze({
  SINGLE: 'single',
  DOUBLE_LEFT: 'doubleL',
  DOUBLE_RIGHT: 'doubleR',
});

/**
 * The door animation types Foundry ships (`CONFIG.Wall.animationTypes`,
 * config.mjs:2509) and the things that matter here about each: whether it
 * pivots around the door's MIDPOINT (ascend/descend/swivel) or its HINGE EDGE
 * (swing/slide); and — DOOR-LEAF-OCCLUSION (see `computeAnimatingLeafSegments`
 * below) — whether the leaf's motion is representable as a 2D line segment
 * rotating about a fixed hinge, i.e. can act as a real-time vision occluder.
 * Only swing/swivel qualify: ascend/descend move perpendicular to the map
 * plane (a fade/scale, not a rotation — no segment to project) and slide
 * translates rather than rotates (a near-free follow-on — needs only a
 * translate-based segment deriver — but not built; the leaf never actually
 * leaves the doorway's footprint mid-slide the way a swing leaf does, so the
 * visual payoff is smaller too). This is the render-side authority for the
 * key set; `foundry/scene-doors.js#KNOWN_ANIMATION_TYPES` mirrors the keys as
 * its validation whitelist (a test pins the KEYS equal — not the per-type
 * shape, so adding `occludesAsSegment` here needed no test update there).
 * @type {Record<string, {midpoint: boolean, occludesAsSegment: boolean}>}
 */
export const DOOR_ANIMATION_TYPES = Object.freeze({
  ascend: Object.freeze({ midpoint: true, occludesAsSegment: false }),
  descend: Object.freeze({ midpoint: true, occludesAsSegment: false }),
  slide: Object.freeze({ midpoint: false, occludesAsSegment: false }),
  swing: Object.freeze({ midpoint: false, occludesAsSegment: true }),
  swivel: Object.freeze({ midpoint: true, occludesAsSegment: true }),
});

/** @param {*} v @returns {number} clamped to [0,1]; non-finite reads as 0 */
export function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * The ease Foundry animates doors with (`CanvasAnimation.easeInOutCosine`) —
 * the caller (the viewer's per-frame clock) eases the TIME fraction with this,
 * then the attribute math below is LINEAR in the eased progress, exactly as
 * `CanvasAnimation.animate` interpolates each attribute from closed to open.
 * @param {number} t - raw 0..1 time fraction @returns {number} eased 0..1
 */
export function easeInOutCosine(t) {
  return (1 - Math.cos(clamp01(t) * Math.PI)) / 2;
}

/**
 * Which leaves a door needs: one SINGLE, or a DOUBLE_LEFT + DOUBLE_RIGHT pair.
 * @param {boolean} double @returns {string[]}
 */
export function doorLeafStyles(double) {
  return double ? [DOOR_STYLES.DOUBLE_LEFT, DOOR_STYLES.DOUBLE_RIGHT] : [DOOR_STYLES.SINGLE];
}

/**
 * Does this animation type pivot around the door's midpoint (vs its hinge edge)?
 * Drives BOTH the pivot point and the sprite anchor (`DoorMesh#initialize`:
 * `anchor.set(midpoint ? 0.5 : 0, 0.5)`).
 * @param {string} type @returns {boolean}
 */
export function isMidpointAnimation(type) {
  return DOOR_ANIMATION_TYPES[type]?.midpoint === true;
}

/**
 * DOOR-LEAF-OCCLUSION — does this animation type's leaf motion reduce to a
 * line segment rotating about a fixed hinge, i.e. can it be treated as a
 * real-time vision occluder? See {@link DOOR_ANIMATION_TYPES}'s own header
 * for why only swing/swivel qualify.
 * @param {string} type @returns {boolean}
 */
export function isSwingLikeAnimation(type) {
  return DOOR_ANIMATION_TYPES[type]?.occludesAsSegment === true;
}

/**
 * The CLOSED-state snapshot for ONE door leaf, in canvas/world space.
 * Replicates `DoorMesh#getClosedPosition` (door-mesh.mjs:188) exactly, returning
 * Foundry's own `DoorStateSnapshot` fields (x, y, rotation in RADIANS, scaleX,
 * scaleY) plus the derived anchor flag. The animation (`applyDoorAnimation`)
 * lerps FROM this toward its open target.
 *
 * @param {ReturnType<typeof import('../foundry/scene-doors.js').deriveDoorSnapshot>} door
 *   a door snapshot (endpoints + animation config).
 * @param {string} style - one of {@link DOOR_STYLES}.
 * @param {{gridSize: number, texWidth: number}} ctx - the scene grid size (px)
 *   and the door texture's native pixel WIDTH (for scaleX). texture HEIGHT is
 *   not needed here — scaleY is grid-derived, independent of the texture's
 *   pixel height (see `doorSnapshotToPlacement`).
 * @returns {{x: number, y: number, rotation: number, scaleX: number,
 *   scaleY: number, alpha: number, tint: [number,number,number], style: string,
 *   midpoint: boolean}}
 */
export function computeDoorClosedSnapshot(door, style, { gridSize, texWidth }) {
  const { x1, y1, x2, y2 } = door;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx); // radians, canvas space — no flip (camera owns it)
  const midpoint = isMidpointAnimation(door.animation.type);
  const S = DOOR_STYLES;

  // Pivot: the hinge for edge animations, the door midpoint for midpoint ones.
  // Foundry projects DOUBLE_LEFT/RIGHT hinges to the quarter/three-quarter
  // points for midpoint anims, and to the A/B endpoints for edge anims.
  let px;
  let py;
  if (style === S.DOUBLE_RIGHT) {
    px = midpoint ? x1 + dx * 0.75 : x2;
    py = midpoint ? y1 + dy * 0.75 : y2;
  } else if (style === S.DOUBLE_LEFT) {
    px = midpoint ? x1 + dx * 0.25 : x1;
    py = midpoint ? y1 + dy * 0.25 : y1;
  } else {
    px = midpoint ? x1 + dx * 0.5 : x1;
    py = midpoint ? y1 + dy * 0.5 : y1;
  }

  // The leaf fills the full wall (single) or half of it (each double leaf).
  const width = style === S.SINGLE ? distance : distance / 2;
  const tw = texWidth > 0 ? texWidth : 100; // texturePadding = 0 (Foundry's default)
  const scaleX = width / tw;

  // Vertical scale by the texture's native grid size; sign flips the leaf
  // (authored `flip`, and the mirrored second leaf of a double door).
  const tgs = door.textureGridSize > 0 ? door.textureGridSize : 200;
  const scaleY = (gridSize / tgs) * (door.animation.flip ? -1 : 1) * (style === S.DOUBLE_RIGHT ? -1 : 1);

  // The right leaf of a double door is mirrored, so its texture rotates a half
  // turn (Foundry: `ray.angle - Math.PI`).
  const rotation = style === S.DOUBLE_RIGHT ? angle - Math.PI : angle;

  return { x: px, y: py, rotation, scaleX, scaleY, alpha: 1, tint: [1, 1, 1], style, midpoint };
}

/**
 * Lerp a tint from white (0xFFFFFF) toward a target hex by `p`, per channel —
 * how Foundry's ascend/descend darken the leaf as it opens (`animateAscend`
 * tints toward 0x222222; `animateDescend` toward 0x666666).
 * @param {number} hex @param {number} p - 0..1 @returns {[number,number,number]}
 */
function lerpTintToHex(hex, p) {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return [1 + (r - 1) * p, 1 + (g - 1) * p, 1 + (b - 1) * p];
}

/**
 * Apply a door's open/close animation at (already-eased) progress `p` ∈ [0,1]
 * (0 = closed, 1 = open) to its closed snapshot, producing the animated
 * snapshot. Replicates `DoorMesh.animate{Swing,Slide,Ascend,Descend}` — each
 * attribute is LINEAR in `p` because Foundry eases the TIME and lerps each
 * attribute from its closed value to its open `to` value; the caller supplies
 * the eased `p` (see {@link easeInOutCosine}). `swivel` shares swing's motion
 * (config.mjs: `animate: DoorMesh.animateSwing`), differing only in its midpoint
 * pivot, already baked into `closed`.
 *
 * @param {ReturnType<typeof computeDoorClosedSnapshot>} closed
 * @param {ReturnType<typeof import('../foundry/scene-doors.js').deriveDoorSnapshot>} door
 * @param {number} p01 - eased open fraction, 0..1.
 * @returns {ReturnType<typeof computeDoorClosedSnapshot>} the animated snapshot.
 */
export function applyDoorAnimation(closed, door, p01) {
  const p = clamp01(p01);
  const { type, direction: rawDirection, strength } = door.animation;
  // THE DOUBLE-DOOR MIRROR FIX (2026-07-24, live-reported: "double doors open
  // in opposite directions"). `door.animation.direction` is ONE authored value
  // shared by the whole wall, but the two leaves' CLOSED poses are already
  // mirrored 180° apart (doorSnapshotToPlacement's DOUBLE_RIGHT rotation —
  // see computeDoorClosedSnapshot). Applying the SAME signed delta to both
  // means the right leaf ends up rotated a further 180° from the left at
  // every progress — each leaf swings to the OPPOSITE side of the wall.
  // Foundry's own `DoorMesh#configure` flips the RIGHT leaf's direction
  // exactly once (`this.#animation.direction *= -1`) for this reason — done
  // HERE (not baked into the door snapshot) because it is a per-LEAF, not
  // per-wall, adjustment. With the flip, both leaves reach the SAME absolute
  // swing rotation at full open (verified by hand against computeQuadCorners:
  // a horizontal single-swing double door, strength 1, ends with BOTH free
  // ends at the same (x, +halfWidth) offset from their own hinge — same side,
  // not mirrored).
  const direction = closed.style === DOOR_STYLES.DOUBLE_RIGHT ? -rawDirection : rawDirection;
  const out = {
    x: closed.x,
    y: closed.y,
    rotation: closed.rotation,
    scaleX: closed.scaleX,
    scaleY: closed.scaleY,
    alpha: 1,
    tint: [1, 1, 1],
    style: closed.style,
    midpoint: closed.midpoint,
  };

  switch (type) {
    case 'slide': {
      // Retract towards endpoint A (x1,y1). Each half-leaf of a double door
      // slides half as far (`m = strength/2`).
      const m = closed.style === DOOR_STYLES.SINGLE ? strength : strength * 0.5;
      out.x = closed.x + (door.x1 - door.x2) * direction * m * p;
      out.y = closed.y + (door.y1 - door.y2) * direction * m * p;
      break;
    }
    case 'ascend': {
      out.alpha = 1 - 0.25 * strength * p;
      const inc = 0.1 * strength * p;
      out.scaleX = (Math.abs(closed.scaleX) + inc) * Math.sign(closed.scaleX);
      out.scaleY = (Math.abs(closed.scaleY) + inc) * Math.sign(closed.scaleY);
      out.tint = lerpTintToHex(0x222222, p);
      break;
    }
    case 'descend': {
      const dec = 0.05 * strength * p;
      out.scaleX = (Math.abs(closed.scaleX) - dec) * Math.sign(closed.scaleX);
      out.scaleY = (Math.abs(closed.scaleY) - dec) * Math.sign(closed.scaleY);
      out.tint = lerpTintToHex(0x666666, p);
      break;
    }
    case 'swing':
    case 'swivel':
    default: {
      // A quarter turn at full strength (`Math.PI * direction * strength / 2`).
      // `default` catches any type that slipped validation — Foundry itself
      // falls back to swing, never renders a frozen door.
      out.rotation = closed.rotation + (Math.PI / 2) * direction * strength * p;
      break;
    }
  }
  return out;
}

/**
 * Convert an animated door snapshot into a `computeQuadCorners`
 * (foundry/scene-geometry.js) placement — so the viewer draws a door with the
 * SAME geometry path a tile uses. `computeQuadCorners` treats `(x,y)` as the
 * ANCHOR POINT (not a corner) and `rotation` as DEGREES; a door's anchor is the
 * hinge (edge anims: 0,0.5) or the centre (midpoint anims: 0.5,0.5), and its
 * rotation is radians here, so both are translated.
 *
 * `width`/`height` are the SIGNED rendered extents (`scale * texturePx`): a
 * negative height mirrors the leaf vertically, which is exactly how Foundry's
 * negative `scaleY` flips it (`computeQuadCorners`'s corner math + the
 * renderer's `side: DoubleSide` honour the sign — see world-quad.js).
 *
 * @param {ReturnType<typeof computeDoorClosedSnapshot>} snap
 * @param {{texWidth: number, texHeight: number}} tex - the door texture's
 *   native pixel size.
 * @returns {{x: number, y: number, width: number, height: number,
 *   anchorX: number, anchorY: number, rotation: number}} a placement accepted
 *   by `computeQuadCorners`.
 */
export function doorSnapshotToPlacement(snap, { texWidth, texHeight }) {
  const tw = texWidth > 0 ? texWidth : 100;
  const th = texHeight > 0 ? texHeight : 100;
  return {
    x: snap.x,
    y: snap.y,
    width: snap.scaleX * tw,
    height: snap.scaleY * th,
    anchorX: snap.midpoint ? 0.5 : 0,
    anchorY: 0.5,
    rotation: (snap.rotation * 180) / Math.PI,
  };
}

/**
 * Summarize door-leaf animation state for the fog-reveal-sync consumer
 * (`effects/vision/vision-mask-render.js`'s gate fade) — a pure reduction over
 * the SAME `animating`/`progress` fields `door-graphics-subsystem.js` already
 * tracks per leaf for its own rendering, per `door-graphics.js`'s
 * `fog-reveal-sync` deferred rung: "no new door math is needed, only the
 * consumer." This is that consumer's one shared piece of pure logic.
 *
 * `minProgress` (not average/max) is deliberately the MOST CONSERVATIVE
 * reading when several leaves are mid-animation at once: the fog fade this
 * feeds multiplies a newly-exposed pixel's brightness by this value, so the
 * least-open leaf in a simultaneous batch caps how much anything can show —
 * never the wrong direction to be wrong in.
 *
 * `clamp01` (not a bare Number check) is deliberate too: a non-finite
 * `progress` reads as 0 rather than being skipped, which is the SAFE
 * direction for a value that gates fog brightness — garbage input keeps the
 * newly-exposed sliver dark rather than accidentally reading as fully open.
 *
 * @param {Array<{animating: boolean, progress: number}>} leafStates
 * @returns {{anyActive: boolean, minProgress: number, activeCount: number}}
 */
export function computeTransitionSummary(leafStates) {
  let minProgress = 1;
  let activeCount = 0;
  for (const leaf of Array.isArray(leafStates) ? leafStates : []) {
    if (!leaf?.animating) continue;
    activeCount++;
    const p = clamp01(leaf.progress);
    if (p < minProgress) minProgress = p;
  }
  return { anyActive: activeCount > 0, minProgress, activeCount };
}

/**
 * DOOR-LEAF-OCCLUSION — the leaf's current FREE (swinging) endpoint, given
 * its fixed hinge and its CURRENT animated rotation/width. For swing/swivel
 * (the only types this is ever called for — see `isSwingLikeAnimation`), the
 * hinge never moves (`applyDoorAnimation` leaves `x,y` untouched for these
 * two types — only `rotation` changes), so this is the one thing that DOES
 * move each frame: a point at `width` distance from the hinge, at the
 * leaf's current rotation.
 *
 * @param {{x: number, y: number}} hinge - world-space, e.g. `leaf.closed`.
 * @param {number} rotation - radians, the CURRENT (animated) rotation —
 *   `applyDoorAnimation(...).rotation`, not the closed one.
 * @param {number} width - `doorSnapshotToPlacement(...).width` (signed is
 *   fine; only the free endpoint's position matters here, not the sign).
 * @returns {{x: number, y: number}}
 */
export function computeDoorLeafFreeEndpoint(hinge, rotation, width) {
  return {
    x: hinge.x + Math.cos(rotation) * width,
    y: hinge.y + Math.sin(rotation) * width,
  };
}

/**
 * DOOR-LEAF-OCCLUSION — every leaf CURRENTLY mid-swing, reduced to the one
 * thing `effects/vision/door-leaf-occlusion.js` needs from each: its current
 * physical segment (hinge → free endpoint), in world space. Pure reduction,
 * same shape as {@link computeTransitionSummary} — over fields
 * `door-graphics-subsystem.js` already tracks per leaf for its own
 * rendering, no new door math.
 *
 * Only swing/swivel leaves are included (`isSwingLikeAnimation`) — see
 * {@link DOOR_ANIMATION_TYPES}'s own header for why the other three types
 * don't reduce to a segment at all. `progress` bounds are STRICT (`0 < p <
 * 1`, not `animating` alone): a leaf can be marked `animating` for one frame
 * at exactly progress 0 or 1 (the instant a transition starts/ends), where
 * it casts either a full-doorway shadow (redundant — Foundry's own polygon
 * already excludes everything there) or none at all (flush with the wall) —
 * excluding those two instants is a pure perf/no-op skip, never a
 * correctness difference, since {@link clipPolygonBySegmentShadow} would
 * compute the same no-op result anyway, just for free instead of for a walk
 * over every source's polygon.
 *
 * @param {Array<{animating: boolean, progress: number, animType: string,
 *   currentRotation: number, currentWidth: number, closed: {x: number, y: number}}>} leafStates
 * @returns {Array<{hingeX: number, hingeY: number, freeX: number, freeY: number}>}
 */
export function computeAnimatingLeafSegments(leafStates) {
  const segments = [];
  for (const leaf of Array.isArray(leafStates) ? leafStates : []) {
    if (!leaf?.animating) continue;
    if (!isSwingLikeAnimation(leaf.animType)) continue;
    const p = clamp01(leaf.progress);
    if (!(p > 0 && p < 1)) continue;
    const hinge = leaf.closed;
    if (!hinge || !Number.isFinite(hinge.x) || !Number.isFinite(hinge.y)) continue;
    if (!Number.isFinite(leaf.currentRotation) || !Number.isFinite(leaf.currentWidth)) continue;
    const free = computeDoorLeafFreeEndpoint(hinge, leaf.currentRotation, leaf.currentWidth);
    segments.push({ hingeX: hinge.x, hingeY: hinge.y, freeX: free.x, freeY: free.y });
  }
  return segments;
}

/**
 * DOOR-FOG MULTI-DOOR RATCHET (Bug-Tracker #35) — `uDoorFogProgress`'s own
 * value, but never allowed to DECREASE while a transition window stays
 * open. Without this, `computeTransitionSummary`'s `minProgress` (the
 * MINIMUM across every currently-animating leaf, by design the most
 * conservative reading — see that function's own header) drags a room that
 * already faded in mostly-visible back toward dark the instant a SECOND
 * door starts opening nearby, because `uDoorFogProgress` is one global
 * uniform applied to every pixel newly revealed since the floor froze,
 * door 1's territory included.
 *
 * Deliberately a PARTIAL fix, not a full per-door redesign: this trades a
 * visible, ugly re-darkening (the bug) for a smaller, self-correcting
 * artifact — a SECOND door's own brand-new sliver reads the
 * already-ratcheted value instead of starting from black, so it pops in
 * partway bright rather than fully fading in, then finishes fading
 * normally. A fully correct per-door fade would need per-pixel door
 * attribution (which door's shadow is THIS pixel behind), a real
 * architecture change — not this function's job.
 *
 * Owns none of `frozenFloorSources` itself (a reference to real vision
 * source objects, not a value this module should hold) — the caller keeps
 * deciding when to freeze/drop it on the exact same inactive↔active edges
 * it already did; `startedThisFrame` is that SAME edge, just also handed
 * here so the ratchet resets in lockstep with the freeze, never out of
 * sync with it.
 *
 * @param {object} args
 * @param {boolean} args.anyActive - `computeTransitionSummary(...).anyActive`.
 * @param {number} args.minProgress - `computeTransitionSummary(...).minProgress`.
 * @param {boolean} args.startedThisFrame - true exactly on the frame a
 *   transition window opens (the same `anyActive && !frozenFloorSources`
 *   edge the caller freezes on) — resets the ratchet for the new window.
 * @param {number} args.peak - the previous frame's ratchet value.
 * @returns {{peak: number, uniformValue: number}} `peak` is what the
 *   caller should hold and pass back in as next frame's `peak`;
 *   `uniformValue` is what `uDoorFogProgress.value` should be set to.
 */
export function advanceDoorFogRatchet({ anyActive, minProgress, startedThisFrame, peak }) {
  if (!anyActive) return { peak: 0, uniformValue: 1 };
  const basePeak = startedThisFrame ? 0 : peak;
  const nextPeak = Math.max(basePeak, clamp01(minProgress));
  return { peak: nextPeak, uniformValue: nextPeak };
}

/**
 * THE DOOR MATERIAL — a textured world-quad, tinted + alpha'd, drawn INTO the
 * lit scene albedo (so the lighting pass darkens a door at night and a torch
 * pools on it, for free, exactly like the map tile beside it). Mirrors the
 * viewer's own `buildWholeImageMaterial` idiom (same node graph, minus the
 * occlusion/uv-scale a streamed tile needs): `texture(map, uv) * uTint`, alpha
 * `* uAlpha`, `transparent`, `depthTest:false`, `DoubleSide` (a negative scaleY
 * flips winding — world-quad.js).
 *
 * The two uniforms are the ONLY per-frame writes the viewer makes: `uTint`
 * carries the ascend/descend darkening, `uAlpha` the ascend fade. The geometry
 * (the swing/slide/scale) is baked into the vertex positions each frame from
 * {@link doorSnapshotToPlacement}, not a shader transform — a door has four
 * vertices, so re-writing them is free and keeps this material trivial.
 *
 * @param {{THREE: any, texture: any}} args - the live THREE namespace and the
 *   already-loaded door texture (viewer sets `flipY:false` + SRGBColorSpace to
 *   match the world-quad convention).
 * @returns {{material: any, uTint: any, uAlpha: any}}
 */
export function buildDoorMaterial({ THREE, texture: doorTexture }) {
  const { Fn, uniform, vec3, float, uv, texture } = THREE.TSL;
  const uTint = uniform(vec3(1, 1, 1));
  const uAlpha = uniform(float(1));

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide; // negative scaleY flips winding — see world-quad.js
  material.colorNode = Fn(() => {
    const c = texture(doorTexture, uv()).toVar();
    c.rgb.mulAssign(uTint);
    c.a.mulAssign(uAlpha);
    return c;
  })();

  return { material, uTint, uAlpha };
}
