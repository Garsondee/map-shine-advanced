/**
 * DOOR GRAPHICS — the animated textured door leaf, as a self-owned subsystem
 * (`docs/planning/Doors.md` is unwritten; `effects/door-graphics.js` +
 * `door-graphics-render.js` are the declaration and the DoorMesh-parity maths
 * this drives).
 *
 * Extracted from `vt-pan-viewer.js` on 2026-07-26 as prep for Water Phase 3,
 * which needed headroom in `startVtPanViewer()` and had none. Per the standing
 * directive (memory `feedback_ratchet_proactive_not_reactive`) the fix is the
 * planned split, done first, never a loosened cap.
 *
 * ⚠️ **This is also the template tier-0 water follows.** A door is an OPAQUE,
 * LIT part of the map — a wooden leaf in a doorway, not an additive glow — so
 * its meshes live in their own `THREE.Scene` and are drawn INTO
 * `buf:scene.color` right after the main scene, *before* lighting, which is
 * why the lighting pass darkens a door at night and a torch pools on it for
 * free, exactly like the tile beside it. Water's surface wants the identical
 * treatment and should read this file before inventing its own.
 *
 * They are NOT routed through buildItems/residency (which manages STATIC
 * streamed tiles): a door's four vertices are re-derived every animating frame
 * from the DoorMesh-parity math, a motion the residency reconcile is not built
 * for. So this is a small, fully-owned manager the same shape as the candle's
 * — reconcile the set on change, animate open/close on the frame clock,
 * dispose cleanly.
 *
 * ORDERING CAVEAT (door-graphics.js's `roof-occlusion` rung): drawn after the
 * whole main scene, a door sits above tiles AND tokens (as Foundry's
 * foreground DoorMesh does) — but also above overhead ROOF art, which Foundry
 * hides it under. The common doorway has no separate roof over it, so this is
 * correct there; the fix is to sort the leaf into the main draw list by a real
 * LayerKey, deferred to that rung.
 *
 * FOG (door-graphics.js's HIGH-PRIORITY `fog-reveal-sync` rung): each leaf's
 * `progress` IS the eased openFactor (0 closed .. 1 open) the incoming V3 fog
 * system will read to fade a doorway's reveal in — tracked here already for
 * the leaf's own rendering. Nothing consumes it yet; when fog lands it reads
 * this, no new door math.
 *
 * ============================================================================
 * WHY THE DRAW CALL IS NOT IN HERE (trap #5)
 * ============================================================================
 * `renderer-state/graph-only` allows `.autoClear* =` only inside `vt/`,
 * `graph/`, `diag/`, and the draw needs to suppress the clear so the leaves
 * composite over the map rather than erasing it. So the seven-line
 * bind-and-draw stays in `vt-pan-viewer.js` and reads `scene` + `leafCount`
 * from here — the same split `sun-shadow-subsystem.js` §3 documents, and the
 * frame-graph pattern those walls' own `instead:` text prescribes.
 *
 * @module effects/door-graphics-subsystem
 */

import { createLogger } from '../core/log.js';
import {
  buildDoorMaterial,
  doorLeafStyles,
  computeDoorClosedSnapshot,
  applyDoorAnimation,
  doorSnapshotToPlacement,
  // The zone door (effects/index.js) re-exports this as `doorEaseInOutCosine`
  // for outside consumers; intra-zone we take its real name and alias here.
  easeInOutCosine as doorEaseInOutCosine,
} from './door-graphics-render.js';
// Cross-zone imports go through each zone's own index.js door
// (`zones/one-door`); intra-zone (`./door-graphics-render.js`) does not.
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../scene/index.js';
import { computeQuadCorners } from '../foundry/index.js';

const log = createLogger('DoorGraphics');

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported (the bloom split's rule).
 * @param {{size?: number}} args.dimensions - the scene's px/square.
 * @param {() => {enabled: boolean, params: object, doors: Array<object>}} args.getDoorRenderState -
 *   boot's data seam. Default-off means an un-wired caller draws no doors.
 * @returns {{scene: *, readonly leafCount: number, sync: (nowMs: number) => void, dispose: () => void}}
 */
export function createDoorGraphicsSubsystem({ THREE, dimensions, getDoorRenderState }) {
  const doorScene = new THREE.Scene();
  /** url -> { texture, width, height } once loaded; 'pending'/'failed' while not. */
  const doorTextureCache = new Map();
  /** wallId -> Array<leaf state> (1 for a single door, 2 for a double). */
  const doorLeaves = new Map();
  // POOL HEALTH (cache-completeness pass, 2026-08-12) — doorTextureCache:
  // hit = a real cached {texture,...} object reused (line below); miss = a
  // URL never seen before, a fresh TextureLoader().load() kicked off.
  // 'pending'/'failed' reads are NEITHER — no new decision was made, same
  // "not ready yet" doctrine mask-authority.js's own bakeRuns/bakeSkips
  // uses for !scene.gridSpec. doorLeaves: hit = existing leaves reused
  // untouched; miss = leaf count or texture changed, buildDoorLeaves reran.
  let doorTextureHits = 0;
  let doorTextureMisses = 0;
  let doorLeavesHits = 0;
  let doorLeavesMisses = 0;
  let doorLastTimeMs = null;
  /** px/square — stable per scene (foundry/scene-geometry.js#computeSceneDimensions). */
  const DOOR_GRID_SIZE = dimensions?.size > 0 ? dimensions.size : 100;

  /** Kick off (once) an async load of a door texture — sRGB + flipY:false to
   * match the world-quad convention (v=0 = image top row) EXACTLY like a map
   * tile (see setTileGeometry's own tex setup), so a door is never upside-down.
   * Returns the cache entry once ready, or null while still loading/failed. */
  function ensureDoorTexture(url) {
    const cached = doorTextureCache.get(url);
    if (cached === 'pending' || cached === 'failed') return null;
    if (cached) {
      doorTextureHits += 1;
      return cached;
    }
    doorTextureMisses += 1;
    doorTextureCache.set(url, 'pending');
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.flipY = false; // v=0 = image top row — the world-quad convention
        tex.colorSpace = THREE.SRGBColorSpace; // art is sRGB; sample decodes to linear
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        const img = tex.image;
        doorTextureCache.set(url, { texture: tex, width: img?.width || 100, height: img?.height || 100 });
      },
      undefined,
      () => {
        log.error(`door texture failed to load: ${url}`);
        doorTextureCache.set(url, 'failed');
      }
    );
    return null;
  }

  /** A stable signature of everything that changes a leaf's CLOSED placement
   * (endpoints, the geometry-affecting animation config, grid size, texture
   * size) — so the closed snapshot is recomputed only on a real change, never
   * per frame. */
  function doorClosedSignature(door, style, tex) {
    return [
      Math.round(door.x1),
      Math.round(door.y1),
      Math.round(door.x2),
      Math.round(door.y2),
      door.animation.type,
      style,
      door.animation.flip ? 1 : 0,
      door.textureGridSize,
      tex.width,
      tex.height,
      DOOR_GRID_SIZE,
    ].join(':');
  }

  function destroyDoorLeaves(wallId) {
    const leaves = doorLeaves.get(wallId);
    if (!leaves) return;
    for (const leaf of leaves) {
      doorScene.remove(leaf.mesh);
      leaf.geometry?.dispose();
      leaf.mesh.material?.dispose();
    }
    doorLeaves.delete(wallId);
  }

  /** Build (or rebuild) the leaf meshes for one door, replacing any existing.
   * Each leaf snaps to the door's CURRENT open state (progress 0 or 1) — a
   * rebuild is not an animation, matching V2's recreate-then-snap. */
  function buildDoorLeaves(door, tex) {
    destroyDoorLeaves(door.wallId);
    const leaves = [];
    for (const style of doorLeafStyles(door.animation.double)) {
      const mat = buildDoorMaterial({ THREE, texture: tex.texture });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
      geometry.setIndex(Array.from(QUAD_INDICES));
      const mesh = new THREE.Mesh(geometry, mat.material);
      mesh.frustumCulled = false; // world-space, camera bounds vary per frame
      doorScene.add(mesh);
      leaves.push({
        style,
        texUrl: door.animation.texture,
        texWidth: tex.width,
        texHeight: tex.height,
        mesh,
        geometry,
        uTint: mat.uTint,
        uAlpha: mat.uAlpha,
        closed: null,
        closedSig: null,
        // `progress` IS the eased openFactor the fog rung reads (0..1).
        progress: door.open ? 1 : 0,
        animating: false,
        fromProgress: door.open ? 1 : 0,
        toProgress: door.open ? 1 : 0,
        elapsedS: 0,
        durationS: 0,
        lastOpen: door.open,
      });
    }
    doorLeaves.set(door.wallId, leaves);
    return leaves;
  }

  /** Per-frame: reconcile the door set, advance each leaf's open/close
   * animation on the (wall-time) frame clock, and re-derive its four vertices.
   * Runs before the pass plan (beside syncTokenPlacements) so the geometry is
   * fresh when runGeometryWorldPass draws doorScene. */
  function syncDoorGraphics(nowMs) {
    const state = getDoorRenderState();
    const doors = state.enabled && Array.isArray(state.doors) ? state.doors : [];

    // dt for the animation clock — WALL time (a door swing is a real-world
    // duration, not tied to the sim/ToD clock).
    const dtS = doorLastTimeMs === null ? 0 : Math.max(0, (nowMs - doorLastTimeMs) / 1000);
    doorLastTimeMs = nowMs;

    // Reap doors that vanished (or the effect went off → doors empty).
    const liveIds = new Set(doors.map((d) => d.wallId));
    for (const wallId of [...doorLeaves.keys()]) if (!liveIds.has(wallId)) destroyDoorLeaves(wallId);
    if (!doors.length) return;

    const animate = state.params?.animateMotion !== false;
    const durScaleRaw = Number(state.params?.motionDurationScale);
    const durScale = Number.isFinite(durScaleRaw) && durScaleRaw > 0 ? durScaleRaw : 1;

    for (const door of doors) {
      const tex = ensureDoorTexture(door.animation.texture);
      if (!tex) {
        // Texture still loading (or failed) — drop any stale leaves so a
        // half-updated door never lingers, and wait for the next frame.
        destroyDoorLeaves(door.wallId);
        continue;
      }
      let leaves = doorLeaves.get(door.wallId);
      // Rebuild when the leaf COUNT (single<->double) or the texture changed —
      // exactly the cases fresh geometry/material are needed (matches V2's
      // needsRecreate on animation.texture/double).
      const wantLeaves = door.animation.double ? 2 : 1;
      if (!leaves || leaves.length !== wantLeaves || leaves[0].texUrl !== door.animation.texture) {
        doorLeavesMisses += 1;
        leaves = buildDoorLeaves(door, tex);
      } else {
        doorLeavesHits += 1;
      }

      for (const leaf of leaves) {
        // (Re)derive the CLOSED placement only when an input to it changed.
        const sig = doorClosedSignature(door, leaf.style, tex);
        if (sig !== leaf.closedSig) {
          leaf.closed = computeDoorClosedSnapshot(door, leaf.style, {
            gridSize: DOOR_GRID_SIZE,
            texWidth: tex.width,
          });
          leaf.closedSig = sig;
        }

        // Detect an open/close toggle → start (or snap) the animation.
        if (door.open !== leaf.lastOpen) {
          leaf.lastOpen = door.open;
          const target = door.open ? 1 : 0;
          if (animate) {
            leaf.animating = true;
            leaf.fromProgress = leaf.progress;
            leaf.toProgress = target;
            leaf.elapsedS = 0;
            leaf.durationS = Math.max(1 / 60, (door.animation.duration / 1000) * durScale);
          } else {
            leaf.progress = target;
            leaf.animating = false;
          }
        }

        // Advance the eased animation (matches V2's DoorMesh.update: ease the
        // time fraction, lerp progress between the start and the target).
        if (leaf.animating) {
          leaf.elapsedS += dtS;
          const raw = leaf.durationS > 0 ? leaf.elapsedS / leaf.durationS : 1;
          if (raw >= 1) {
            leaf.progress = leaf.toProgress;
            leaf.animating = false;
          } else {
            const eased = doorEaseInOutCosine(raw);
            leaf.progress = leaf.fromProgress + (leaf.toProgress - leaf.fromProgress) * eased;
          }
        }

        // Re-derive the four world vertices + the tint/alpha for this progress
        // — but ONLY when an input to `applyDoorAnimation` actually changed
        // (PERF, 2026-08-09: this used to run — and force a GPU buffer
        // re-upload via `needsUpdate = true` — every frame for every leaf,
        // whether or not the door had moved since the last one; steady-state
        // is the overwhelming majority of a door's life). `sig` already
        // covers everything `closedSig` tracks (endpoints, animation type,
        // style, flip, texture); `direction`/`strength` are the two
        // `applyDoorAnimation` also reads that `doorClosedSignature` does
        // not (they gate the CLOSED placement, not the animated one), and
        // `leaf.progress` is the one input that legitimately changes every
        // frame WHILE animating.
        const animChanged =
          sig !== leaf.lastAnimSig ||
          door.animation.direction !== leaf.lastAnimDirection ||
          door.animation.strength !== leaf.lastAnimStrength ||
          leaf.progress !== leaf.lastAnimProgress;
        if (animChanged) {
          const snap = applyDoorAnimation(leaf.closed, door, leaf.progress);
          const placement = doorSnapshotToPlacement(snap, { texWidth: leaf.texWidth, texHeight: leaf.texHeight });
          const positions = buildQuadPositions(computeQuadCorners(placement));
          const posAttr = leaf.geometry.getAttribute('position');
          if (posAttr && posAttr.array.length === positions.length) {
            posAttr.array.set(positions);
            posAttr.needsUpdate = true; // same buffer, new contents — re-upload, don't reallocate
          } else {
            leaf.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          }
          leaf.uTint.value.set(snap.tint[0], snap.tint[1], snap.tint[2]);
          leaf.uAlpha.value = snap.alpha;
          leaf.lastAnimSig = sig;
          leaf.lastAnimDirection = door.animation.direction;
          leaf.lastAnimStrength = door.animation.strength;
          leaf.lastAnimProgress = leaf.progress;
        }
        leaf.mesh.visible = true;
      }
    }
  }

  /** Free every door leaf + cached texture. Safe whether or not any was built. */
  function disposeDoorGraphics() {
    try {
      for (const wallId of [...doorLeaves.keys()]) destroyDoorLeaves(wallId);
      for (const entry of doorTextureCache.values()) {
        if (entry && entry !== 'pending' && entry !== 'failed') entry.texture?.dispose();
      }
      doorTextureCache.clear();
    } catch (err) {
      log.error('door graphics dispose failed — GPU buffers may leak until renderer.dispose():', err);
    }
    doorLastTimeMs = null;
  }

  return {
    /** The leaves' own scene — the viewer's `renderDoorGraphicsInto` draws THIS
     * into the currently-bound target without clearing it (see the header for
     * why that seven-line call cannot live in here). */
    scene: doorScene,
    /** How many doors currently have built leaves — the viewer skips its draw
     * entirely at zero, so a scene with no doors costs nothing. A getter, not a
     * value: the count changes on every reconcile. */
    get leafCount() {
      return doorLeaves.size;
    },
    sync: syncDoorGraphics,
    dispose: disposeDoorGraphics,
    /** POOL HEALTH — doorTextureCache/doorLeaves' own hit/miss counters. See
     * their declaration for the exact hit/miss doctrine. */
    getPoolStats() {
      return {
        doorTextureCache: { hits: doorTextureHits, misses: doorTextureMisses, size: doorTextureCache.size },
        doorLeaves: { hits: doorLeavesHits, misses: doorLeavesMisses, size: doorLeaves.size },
      };
    },
  };
}
