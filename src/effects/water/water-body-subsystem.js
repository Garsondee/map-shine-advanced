/**
 * THE BODY-PACK SUBSYSTEM — owns `res:waterBody`'s render targets, decides
 * WHEN the jump flood runs, and reports what it did (`docs/planning/Water.md`
 * §5.1, Phase 2).
 *
 * `water-body.js` builds the three materials; this drives them. The split is
 * `effects/lighting/sun-shadow.js` ↔ `sun-shadow-subsystem.js`, exactly.
 *
 * ============================================================================
 * §1 — THE ONE RULE THIS MODULE EXISTS TO ENFORCE: BAKE COUNT ≠ FRAME COUNT
 * ============================================================================
 * Water.md §5.1 names the trap in advance, because this codebase has already
 * paid for it once: *"the rebake trigger belongs in the frame loop's version
 * poll, never inside a residency-triggered function."* A uniform sync placed
 * inside a residency pass only runs on pan/zoom, which is how vegetation's
 * sliders did nothing until the camera moved (2026-07-23,
 * `feedback_residency_sync_vs_render_loop`).
 *
 * So {@link createWaterBodySubsystem} exposes exactly one per-frame entry
 * point — `maybeBake(floorIndex)` — which is cheap to CALL and expensive to
 * RUN, and it counts both. `getStatus()` reports `bakes` alongside
 * `pollsSinceLastBake`; a bake count that tracks the frame count is the
 * failure, VISIBLY, which is this phase's own exit criterion.
 *
 * ============================================================================
 * §2 — WHY THE GPU CALLS ARE INJECTED
 * ============================================================================
 * `renderer-state/graph-only` allows `.setRenderTarget(` only inside `vt/`,
 * `graph/`, `diag/`; `gpu/textures-in-vt-only` allows `new ...Texture(` only
 * inside `vt/`. Living in `effects/water/` does not buy an exemption — those
 * walls exist because V2 scattered both across dozens of files until nobody
 * could reason about ownership.
 *
 * So the two literal GPU-touching operations are CALLBACKS the caller defines
 * (`renderWaterPass`, `createWaterMaskTexture`), and this module only decides
 * when to invoke them and with what data. Same shape, same reasoning, and the
 * same one-paragraph explanation as `sun-shadow-subsystem.js` §3 — read that
 * file's own header if this is the first time you are meeting the pattern.
 *
 * ============================================================================
 * §3 — RESOLUTION: THE BODY PACK IS THE SIZE OF ITS INPUT
 * ============================================================================
 * Water.md §5.1 specified a fixed 1024². Building it exposed that as a number
 * with nothing behind it: the mask arrives as the authority's own per-floor
 * grid, which `computeMaskGridSpec` caps at `MASK_GRID_MAX_DIM` (512) on the
 * long side, and a flood run at 2× its input's resolution stores interpolation
 * rather than information. So the pack is allocated AT THE GRID'S OWN
 * DIMENSIONS, which is both honest and 4× cheaper — 3 targets × 512² × RGBA16F
 * ≈ 6 MB instead of ≈ 24 MB, comfortably inside Keyhole §4.2's water/fog
 * reservation with room for the tier-7 field on top.
 *
 * It also removes a constant that would need keeping in sync: if the mask grid
 * ever gets finer (`PAINT_GRID_MAX_DIM` is already 4096 for painted layers),
 * the body pack follows automatically. The allocator's own 2048px law is the
 * backstop if that day comes with a number too big.
 *
 * ⚠️ The grid's dimensions change when the SCENE RECT's aspect changes, so the
 * targets are keyed by `WxH` and reallocated only on a genuine change — the
 * same `gridKey` discipline `vt-pan-viewer.js` already uses for the wind sim's
 * ping/pong pair, and for the same reason (a per-bake realloc of megabytes is
 * how a floor switch turns into a device loss).
 *
 * @module effects/water/water-body-subsystem
 */

import { createLogger } from '../../core/log.js';
import {
  buildWaterSeedMaterial,
  buildWaterJfaStepMaterial,
  buildWaterBodyResolveMaterial,
  jfaStepCount,
  jfaStrideForStep,
  WATER_MASK_FILTER,
} from './water-body.js';
import { resolveWaterFloor } from './water-floor.js';

const log = createLogger('WaterBody');

/** Padding on the measured water AABB, world px — comfortably wider than
 * `WATER_TIER0_SHORE_SOFTNESS_PX` so the surface mesh never clips its own
 * antialiased shoreline, and wider than one coarse mask texel so a shore that
 * sits mid-texel is still fully covered. */
const WATER_BOUNDS_PAD_PX = 64;

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {{create: Function, dispose: Function}} args.allocator - `graph/three-allocator.js`.
 * @param {(floorIndex: number) => {grid: object, completeness: object}|null} args.getWaterMaskGrid -
 *   boot's seam onto `maskAuthority.getDerived('water', floorIndex)`. Returns
 *   null for an unresolvable floor; never throws for a missing water mask
 *   (water is not a `required` kind).
 * @param {() => number[]} args.getFloorsWithWater - boot's seam onto
 *   `maskAuthority.floorsWithAuthored('water')`. The cross-floor rule's input.
 * @param {() => number} args.getMaskAuthorityVersion - the products version,
 *   polled per frame (O(1) integer read).
 * @param {(target: *, quad: *) => void} args.renderWaterPass - the literal
 *   save/bind/render/restore triplet, defined in `vt/` (see §2).
 * @param {(data: Uint8Array, w: number, h: number, filter: string) => *} args.createWaterMaskTexture -
 *   the literal `new THREE.DataTexture(...)` + filter setup, defined in `vt/`.
 * @param {() => number|null} [args.getWaterFloorOverride] - the per-level pin
 *   (Water.md §4 rule 3). Absent/null = the normal borrow-from-below resolve.
 * @returns {{
 *   texture: *,
 *   getRect: () => {minX:number,minY:number,maxX:number,maxY:number},
 *   maybeBake: (floorIndex: number) => void,
 *   getStatus: () => object,
 *   dispose: () => void,
 * }}
 */
export function createWaterBodySubsystem({
  THREE,
  allocator,
  getWaterMaskGrid,
  getFloorsWithWater,
  getMaskAuthorityVersion,
  renderWaterPass,
  createWaterMaskTexture,
  getWaterFloorOverride,
}) {
  // ── STATE ───────────────────────────────────────────────────────────────
  /** A 1×1 all-land mask: no water, and therefore no interface, so the flood
   * finds no seeds and the resolve stores +farDistance everywhere. A
   * placeholder whose failure mode is "no water", never "water everywhere" —
   * the same choice sun-shadows made for its own empty caster field, and for
   * the same reason (a placeholder whose failure is invisible beats one whose
   * failure is the whole screen). */
  let maskTexture = createWaterMaskTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, WATER_MASK_FILTER);
  let maskRect = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

  /** The water's own world AABB (Law 6 — the surface mesh is cropped to THIS,
   * never to the mask rect). `null` = this floor's mask holds no water. */
  let waterBounds = null;
  let bodyRt = null;
  let jfaPingRt = null;
  let jfaPongRt = null;
  /** `WxH` of the targets currently allocated; '' = none yet. */
  let gridKey = '';
  /** Rebuilt whenever `gridKey` changes — the materials bake grid dimensions
   * in as graph-build-time constants (texel size, the neighbour offsets). */
  let materials = null;
  let jfaSteps = 0;

  // ── THE COUNTERS THAT MAKE §1 CHECKABLE ─────────────────────────────────
  let bakes = 0;
  let polls = 0;
  let pollsSinceLastBake = 0;
  let bakedVersion = -1;
  let bakedFloor = -1;
  let bakedOverride = null;
  let lastBake = null;
  let lastResolve = null;

  /**
   * Allocate (or reallocate) the three targets for a grid of this size.
   * RGBA16F, NEAREST, NoColorSpace: this is DATA, not a picture. LINEAR would
   * interpolate the flood's seed OFFSETS between texels, and averaging two
   * different seeds' offsets yields a vector pointing at neither — which is
   * meaningless mid-flood and would put a false crease down every medial axis.
   *
   * ⚠️ THE RESOLVED PACK (`bodyRt`) MUST BE LINEAR, AND SHARING NEAREST WITH
   * THE PING-PONG PAIR WAS A REAL BUG, LIVE-CONFIRMED 2026-07-26. `bodyRt`
   * holds this bake's FINISHED output — a signed distance, a depth, a
   * tangent — three smoothly-varying scalars with none of the ping-pong
   * pair's "these are mid-flood offset vectors" hazard. The surface material
   * samples it over a world-space UV spanning the whole water rect (10,650 ×
   * 4,950 world units in the reported case), at whatever zoom the camera
   * happens to be — nothing like "read at its own resolution", the excuse
   * this comment used to make for sharing NEAREST. The visible result was
   * exactly what NEAREST-sampling a 512×238 grid stretched over that rect
   * predicts: a blocky, low-res, "tiny mask stretched across the whole map"
   * look — the shoreline's own smoothstep transition (§ water-render.js,
   * ~26 world px wide, close to one texel at this grid's density) is the
   * first thing to go blocky, because a hard-edged NEAREST step right where
   * a soft transition was supposed to be is the most visible place a texel
   * boundary can land.
   * @param {number} w @param {number} h
   */
  function ensureTargets(w, h) {
    const key = `${w}x${h}`;
    if (key === gridKey) return;

    allocator.dispose(bodyRt);
    allocator.dispose(jfaPingRt);
    allocator.dispose(jfaPongRt);
    materials?.dispose?.();
    materials = null;

    const describe = (filter) => ({
      resolvedW: w,
      resolvedH: h,
      // Neither `screenSized` nor `allowWorldScale`: the mask grid is capped at
      // MASK_GRID_MAX_DIM (512) on its long side, so this sails under the
      // Keyhole law's plain 2048px cap with no exception claimed. O(1) in map
      // size — a 12,000px map and a 2,000px map both get exactly this.
      screenSized: false,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      filter,
      depth: false,
    });
    // LINEAR — this is the finished, smoothly-varying field every consumer
    // reads (see the header note just above).
    bodyRt = allocator.create('water.body', describe('linear'));
    // NEAREST — mid-flood offset VECTORS; interpolating them is meaningless
    // (see this function's own doc, first paragraph).
    jfaPingRt = allocator.create('water.jfa.ping', describe('nearest'));
    jfaPongRt = allocator.create('water.jfa.pong', describe('nearest'));
    gridKey = key;
    jfaSteps = jfaStepCount(w, h);
  }

  /**
   * Build the three materials against the current mask texture and grid. Torn
   * down and rebuilt on a regrid only — the mask TEXTURE itself is re-pointed
   * live (`.value`), never rebuilt into, which is the same discipline the wind
   * sim uses for its own baked inputs.
   * @param {number} w @param {number} h
   */
  function ensureMaterials(w, h) {
    if (materials) return;
    const seed = buildWaterSeedMaterial({ THREE, maskTexture, width: w, height: h });
    const jfa = buildWaterJfaStepMaterial({ THREE, prevTexture: jfaPingRt.texture, width: w, height: h });
    const resolve = buildWaterBodyResolveMaterial({
      THREE,
      jfaTexture: jfaPingRt.texture,
      maskTexture,
      texelWorldW: 1,
      texelWorldH: 1,
      farDistancePx: 1,
    });
    materials = {
      seed,
      jfa,
      resolve,
      dispose() {
        seed.material?.dispose?.();
        jfa.material?.dispose?.();
        resolve.material?.dispose?.();
        // NOT the quads' geometry — QuadMesh shares ONE module-level
        // QuadGeometry across every QuadMesh in the process (three.webgpu.js).
      },
    };
  }

  /**
   * Upload one floor's water mask as a texture. R carries depth AND presence
   * (see the `water` kind's own `meaning` in scene/mask-catalog.js), so one
   * channel is the whole input.
   *
   * @param {number} floorIndex
   * @returns {{ok: boolean, reason?: string, cols?: number, rows?: number}}
   */
  function uploadMask(floorIndex) {
    let product = null;
    try {
      product = getWaterMaskGrid(floorIndex);
    } catch (err) {
      // Water is NOT a `required` kind, so this should not throw — but the
      // authority throws for anything derived from a missing REQUIRED mask,
      // and a future catalog edit could put water downstream of one. Report
      // rather than swallow, and keep the previous texture (no-silent-catch).
      log.warn(`water mask unavailable for floor ${floorIndex}, keeping the previous body pack —`, err?.message ?? err);
      return { ok: false, reason: String(err?.message ?? err) };
    }
    const grid = product?.grid;
    if (!grid?.spec || !grid?.data) return { ok: false, reason: `no water grid for floor ${floorIndex}` };
    const { w, h } = grid.spec;
    if (!(w > 0 && h > 0)) return { ok: false, reason: `degenerate grid ${w}x${h}` };

    // RGBA/UnsignedByte to match every other DataTexture in this renderer; R
    // is the only channel anything reads. NEAREST — see WATER_MASK_FILTER's
    // own doc for why a soft edge would make the seed pass meaningless.
    //
    // THE SAME PASS ALSO MEASURES THE WATER'S WORLD AABB, because Law 6 is
    // about bounded GEOMETRY and the surface mesh has to be cropped to
    // something. Water.md's own worked example for that law is "a water pass
    // that runs fullscreen while water covers 2% of the view"; a quad over the
    // whole mask rect would BE that. One min/max while the bytes are already
    // being walked costs nothing and is the only measurement of "where the
    // water actually is" anyone has.
    const data = new Uint8Array(w * h * 4);
    let minTx = Infinity;
    let minTy = Infinity;
    let maxTx = -Infinity;
    let maxTy = -Infinity;
    for (let i = 0; i < w * h; i++) {
      const v = grid.data[i] ?? 0;
      data[i * 4 + 0] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
      if (v > 0) {
        const tx = i % w;
        const ty = (i / w) | 0;
        if (tx < minTx) minTx = tx;
        if (tx > maxTx) maxTx = tx;
        if (ty < minTy) minTy = ty;
        if (ty > maxTy) maxTy = ty;
      }
    }
    const tex = createWaterMaskTexture(data, w, h, WATER_MASK_FILTER);

    maskTexture?.dispose?.();
    maskTexture = tex;
    maskRect = {
      minX: grid.spec.x,
      minY: grid.spec.y,
      maxX: grid.spec.x + grid.spec.width,
      maxY: grid.spec.y + grid.spec.height,
    };

    ensureTargets(w, h);
    ensureMaterials(w, h);
    materials.seed.maskTexNode.value = tex;
    materials.resolve.maskTexNode.value = tex;
    materials.resolve.setTexelWorld(grid.spec.texelW, grid.spec.texelH);
    // "No shore anywhere" must read as further away than the map is wide, so
    // every distance consumer degrades continuously instead of special-casing.
    materials.resolve.setFarDistance(Math.hypot(grid.spec.width, grid.spec.height));

    // Texel AABB → WORLD AABB, padded by the shoreline's own soft reach so the
    // mesh never clips its own antialiased edge. `null` when the mask holds no
    // water at all, which the consumer reads as "draw nothing" — an empty
    // bound, never a degenerate zero-size quad.
    waterBounds =
      maxTx >= minTx
        ? {
            minX: grid.spec.x + minTx * grid.spec.texelW - WATER_BOUNDS_PAD_PX,
            minY: grid.spec.y + minTy * grid.spec.texelH - WATER_BOUNDS_PAD_PX,
            maxX: grid.spec.x + (maxTx + 1) * grid.spec.texelW + WATER_BOUNDS_PAD_PX,
            maxY: grid.spec.y + (maxTy + 1) * grid.spec.texelH + WATER_BOUNDS_PAD_PX,
          }
        : null;
    return { ok: true, cols: w, rows: h, waterTexels: maxTx >= minTx ? 'present' : 'none' };
  }

  /**
   * SEED → N JUMP-FLOOD ROUNDS → RESOLVE. Every round ping-pongs, because a
   * fragment shader cannot read the target it is writing; every node in
   * `prevTexNodes` is re-pointed together before each render (there is no
   * confirmed `.uv()` chain method on a TextureNode in this vendored build —
   * `world/wind-sim-gpu.js`'s header carries the citation).
   *
   * @param {string} reason - what triggered this, verbatim, for the report.
   * @param {number} floorIndex - the RESOLVED floor whose mask is loaded.
   * @returns {object} the outcome, for `getStatus()`.
   */
  function runFlood(reason, floorIndex) {
    const started = polls;
    // Seed writes into ping; the ladder alternates from there.
    renderWaterPass(jfaPingRt, materials.seed.quad);
    let readFromPing = true;
    for (let i = 0; i < jfaSteps; i++) {
      const src = readFromPing ? jfaPingRt : jfaPongRt;
      const dst = readFromPing ? jfaPongRt : jfaPingRt;
      materials.jfa.uStride.value = jfaStrideForStep(i, jfaSteps);
      for (const node of materials.jfa.prevTexNodes) node.value = src.texture;
      renderWaterPass(dst, materials.jfa.quad);
      readFromPing = !readFromPing;
    }
    // Whichever target the ladder finished writing is the one to resolve from.
    materials.resolve.jfaTexNode.value = (readFromPing ? jfaPingRt : jfaPongRt).texture;
    renderWaterPass(bodyRt, materials.resolve.quad);

    bakes++;
    pollsSinceLastBake = 0;
    return {
      reason,
      floorIndex,
      grid: gridKey,
      jfaSteps,
      atPoll: started,
    };
  }

  /**
   * THE PER-FRAME QUESTION, kept as cheap as it sounds: has anything that
   * actually changes the water's geometry changed?
   *
   * ⚠️ Must be called from the FRAME LOOP, never from a residency-triggered
   * function — see §1. A mask repaint is not a camera event, so a camera-gated
   * rebake would leave the author's brushstrokes invisible until they panned.
   *
   * @param {number} viewedFloorIndex
   */
  function maybeBake(viewedFloorIndex) {
    polls++;
    pollsSinceLastBake++;

    // THE CROSS-FLOOR RULE (Water.md §4) decides WHICH floor's mask to bake.
    // It rides here rather than at render time because borrowing changes the
    // BAKE's input, not the draw — which is exactly why V2 needed bespoke
    // occluder textures and this does not.
    const resolved = resolveWaterFloor({
      viewedFloor: viewedFloorIndex,
      floorsWithWater: getFloorsWithWater(),
      perLevelOverride: getWaterFloorOverride ? getWaterFloorOverride() : null,
    });
    lastResolve = { viewedFloor: viewedFloorIndex, ...resolved };

    const version = getMaskAuthorityVersion();
    const overrideKey = getWaterFloorOverride ? getWaterFloorOverride() : null;
    const unchanged = version === bakedVersion && resolved.floorIndex === bakedFloor && overrideKey === bakedOverride;
    if (unchanged) return;

    // Captured BEFORE the assignments below — reading `bakedVersion` after
    // writing it would make the reason string say 'mask/floor change' on the
    // very first bake of every session, which is the mild kind of lying
    // instrument that makes a report worthless when it matters.
    const reason = bakes === 0 ? 'first' : 'mask or floor changed';
    bakedVersion = version;
    bakedFloor = resolved.floorIndex;
    bakedOverride = overrideKey;

    // No floor in the scene has water at all. Nothing to bake, and nothing to
    // clear: the body pack keeps whatever it last held, and `lastResolve`
    // says why. A consumer gates on `hasWater`, never on the pack's contents.
    if (resolved.floorIndex == null) {
      lastBake = { reason: 'no water in this scene', floorIndex: null, skipped: true };
      return;
    }

    const upload = uploadMask(resolved.floorIndex);
    if (!upload.ok) {
      lastBake = { reason: upload.reason, floorIndex: resolved.floorIndex, skipped: true };
      return;
    }
    lastBake = { ...runFlood(reason, resolved.floorIndex), ...upload };
  }

  return {
    /** The body pack — R signed distance (world px, negative inside water),
     * G depth01, BA the unit shore tangent. Null until the first bake sizes
     * the targets; a consumer must handle that, exactly as it must handle a
     * scene with no water at all. */
    get texture() {
      return bodyRt?.texture ?? null;
    },
    /** The world rect the pack covers — the mask grid's own rect. */
    getRect() {
      return { ...maskRect };
    },
    /**
     * The water's own world AABB, or `null` when this floor has no water at
     * all. The surface mesh is cropped to THIS, never to `getRect()` — Law 6
     * is about bounded geometry, and a quad over the whole mask rect is that
     * law's own worked counter-example.
     */
    getWaterBounds() {
      return waterBounds ? { ...waterBounds } : null;
    },
    /** Bumps on every completed flood. A consumer holding derived state (the
     * surface mesh's geometry, sized from `getWaterBounds()`) caches this and
     * rebuilds when it moves — the same version-cache discipline the wind and
     * shadow handles use, rather than a push notification. */
    get bakeGeneration() {
      return bakes;
    },
    maybeBake,
    /**
     * The debug-panel report. `bakes` vs `polls` IS this phase's exit
     * criterion (§1): a healthy session shows single-digit bakes against
     * thousands of polls. If those two numbers track each other, the version
     * poll is broken and every frame is paying for a jump flood.
     */
    getStatus() {
      return {
        bakes,
        polls,
        pollsSinceLastBake,
        grid: gridKey || 'not allocated',
        jfaSteps,
        rect: maskRect,
        // The cross-floor rule's own answer, with its reason string — a
        // derived READOUT, never a param (Effect-Registration.md: V2's
        // HealthEvaluatorService writing into product params is the corpse).
        resolve: lastResolve ?? 'never resolved',
        lastBake: lastBake ?? 'never baked',
        floorsWithWater: getFloorsWithWater(),
      };
    },
    dispose() {
      allocator.dispose(bodyRt);
      allocator.dispose(jfaPingRt);
      allocator.dispose(jfaPongRt);
      materials?.dispose?.();
      maskTexture?.dispose?.();
      bodyRt = jfaPingRt = jfaPongRt = null;
      materials = null;
      gridKey = '';
    },
  };
}
