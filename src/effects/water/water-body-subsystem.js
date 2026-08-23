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
 * §3 — RESOLUTION: WATER-OWNED, SIZED FROM THE WORLD RECT, AND WHY THIS
 * SECTION USED TO ARGUE THE OPPOSITE (TWICE)
 * ============================================================================
 * Water.md §5.1 specified a fixed 1024². This section originally corrected
 * that to "the pack is the size of its input" — the mask arrives at
 * `MASK_GRID_MAX_DIM` (512) on the long side, and ran the flood at exactly
 * that resolution, reasoning that a flood run finer than its input "stores
 * interpolation rather than information."
 *
 * That reasoning was WRONG, live-confirmed 2026-07-26 ("an extremely
 * pixelated mask which has been blurred... the shoreline looks like a square
 * wave"): a jump flood is provably EXACT at whatever resolution it runs (this
 * file's own Node suite proves it against brute force), but its SEEDS exist
 * only at texel centres — so a shoreline crossing a 512-wide grid at an angle
 * gets a real staircase of seed POSITIONS, not a filtering artefact, and no
 * amount of downstream blur on the finished field can recover data the seed
 * pass never captured. "Interpolation rather than information" was the wrong
 * frame: the mask IS all the information there is, and reconstructing what
 * plausibly happens between its texels via linear sampling at a finer flood
 * resolution is the standard, correct technique for exactly this class of
 * problem (real-time SDF-from-low-res-coverage-mask generation always does
 * this) — not an invention.
 *
 * The FIRST fix, `WATER_BODY_SUPERSAMPLE = 3` (`water-body.js`), ran the
 * flood at `3×` the coarse cross-effect derivation grid's own width/height —
 * and was reverted the SAME DAY back to 1, because the derivation grid it was
 * multiplying was itself POINT-sampled: supersampling a grid that already
 * discarded sub-texel information cannot recover it, however densely you
 * resample. `water-body.js#WATER_BODY_SUPERSAMPLE`'s own doc names this in
 * full and is worth reading before touching this section again.
 *
 * The SECOND, water-owned fix (2026-08-19, `WATER_BODY_GRID_MAX_DIM`) is a
 * different mechanism, not a retry of the first: it sizes the flood directly
 * from the water body's OWN world rect (`sizeBodyGrid`, this file), the exact
 * technique `water-flow.js#WATER_FLOW_GRID_MAX_DIM`/`sizeFlowGrid` already
 * uses — never as a multiplier on the shared 512 grid. Combined with the seed
 * pass's own 2026-08-18 fix (reading the FULL-RESOLUTION mask directly, area-
 * averaged, never the coarse derived grid), the flood now both SEES the real
 * mask at full detail AND has enough of its own output texels to place a
 * distinct seed near small or closely-packed obstacles — the thing a bigger
 * multiplier on an already-coarse grid could never have bought. 1,536 matches
 * the flow pack's own cap exactly, comfortably under the Keyhole allocator's
 * 2,048px cap with no exception claimed; 3 targets × 1,536×714 × RGBA16F ≈
 * 25 MB, the same cost the (reverted) first attempt already budgeted for,
 * comfortably inside Keyhole §4.2's water/fog reservation. `WATER_MASK_FILTER`
 * stays `'linear'` — sampling the mask more densely only helps once the
 * filter can actually interpolate between what it reads.
 *
 * ⚠️ The grid's dimensions change when the SCENE RECT's aspect changes, so the
 * targets are keyed by `WxH` (the FLOOD's own, water-owned dimensions) and
 * reallocated only on a genuine change — the same `gridKey` discipline
 * `vt-pan-viewer.js` already uses for the wind sim's ping/pong pair, and for
 * the same reason (a per-bake realloc of megabytes is how a floor switch
 * turns into a device loss).
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
  WATER_BODY_GRID_MAX_DIM,
} from './water-body.js';
import { resolveWaterFloor } from './water-floor.js';

const log = createLogger('WaterBody');

/**
 * Size the flood's own grid over a world rect — the water-owned replacement
 * for "supersample the coarse cross-effect derivation grid" (see
 * `water-body.js#WATER_BODY_GRID_MAX_DIM`'s own doc for why that mechanism
 * was superseded). Deliberately the SAME aspect-preserving formula
 * `water-flow-subsystem.js#sizeFlowGrid` uses, duplicated rather than
 * imported for the identical reason that function's own header states:
 * effects-zone subsystems do not reach into each other's siblings for four
 * lines of arithmetic.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect
 * @returns {{w:number,h:number}}
 */
function sizeBodyGrid(rect) {
  const width = Math.max(1, rect.maxX - rect.minX);
  const height = Math.max(1, rect.maxY - rect.minY);
  const scale = WATER_BODY_GRID_MAX_DIM / Math.max(width, height);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

/** Padding on the measured water AABB, world px — comfortably wider than
 * `WATER_TIER0_SHORE_SOFTNESS_PX` so the surface mesh never clips its own
 * antialiased shoreline, and wider than one coarse mask texel so a shore that
 * sits mid-texel is still fully covered. */
const WATER_BOUNDS_PAD_PX = 64;

/**
 * Intersect a padded water AABB with the rect the mask actually covers — pure,
 * exported, and Node-tested, because the bug it fixes was VISIBLE ON SCREEN and
 * invisible to every status field water reports (`getStatus().bounds` printed
 * the escaped rect and looked entirely reasonable).
 *
 * Returns `null` for an empty intersection rather than an inverted rect: a
 * degenerate quad is the shape that renders as a stripe or as nothing depending
 * on winding, which is a far worse failure than an honest "no bounds".
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} padded
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} mask
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
 */
export function clipRectToMask(padded, mask) {
  if (!padded || !mask) return padded ?? null;
  const minX = Math.max(padded.minX, mask.minX);
  const minY = Math.max(padded.minY, mask.minY);
  const maxX = Math.min(padded.maxX, mask.maxX);
  const maxY = Math.min(padded.maxY, mask.maxY);
  if (!(maxX > minX && maxY > minY)) return null;
  return { minX, minY, maxX, maxY };
}

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
 *   Only builds the pre-first-load 1×1 placeholder now (2026-08-18) — the
 *   seed/resolve passes' own mask comes from `waterSurface` below.
 * @param {{getFullResMaskTexture: () => *|null}} args.waterSurface - THIS
 *   floor's own `createWaterSurfaceSubsystem()` handle (2026-08-18, second
 *   attempt — see `vt-pan-viewer.js#createWaterBodyForFloor`'s own comment
 *   for why the first attempt regressed and what makes this one safe). The
 *   SAME accessor `water-flow-subsystem.js` already depends on, and for the
 *   identical reason: it is the only mask reference in this codebase that is
 *   never downsampled before a shore/obstacle test reads it. A lazy
 *   reference is required at the call site (`vt-pan-viewer.js`) — surface
 *   itself depends on this subsystem's own `getRect()`, so resolving it
 *   eagerly here would be circular.
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
  waterSurface,
  getWaterFloorOverride,
}) {
  // ── STATE ───────────────────────────────────────────────────────────────
  /** A 1×1 all-land mask: no water, and therefore no interface, so the flood
   * finds no seeds and the resolve stores +farDistance everywhere. A
   * placeholder whose failure mode is "no water", never "water everywhere" —
   * the same choice sun-shadows made for its own empty caster field, and for
   * the same reason (a placeholder whose failure is invisible beats one whose
   * failure is the whole screen). */
  const maskTexture = createWaterMaskTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, WATER_MASK_FILTER);
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
      // Neither `screenSized` nor `allowWorldScale`: the flood is capped at
      // WATER_BODY_GRID_MAX_DIM (1,536) on its long side, so this sails under
      // the Keyhole law's plain 2048px cap with no exception claimed. O(1) in
      // map size — a 12,000px map and a 2,000px map both get exactly this.
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

    // ⚠️ THE ACTUAL OBSTACLE-PRESENCE DATA (2026-08-18) — this coarse derived
    // grid (`getWaterMaskGrid` → `maskAuthority.getDerived('water', …)`, the
    // SAME cross-effect grid `_Outdoors` etc. share, capped at
    // `WATER_GRID_MAX_DIM`) is STILL walked below for the water body's own
    // world AABB (Law 6's crop rect) — a coarse approximation is fine for
    // "roughly where does water exist". It is NO LONGER what the seed/resolve
    // passes sample for PER-TEXEL presence — see this module's own header and
    // `vt-pan-viewer.js#createWaterBodyForFloor` for the full account,
    // including the live regression the first attempt at this shipped and
    // the separate bookkeeping bug (`water-surface-subsystem.js#sync`) that
    // fix required.
    let minTx = Infinity;
    let minTy = Infinity;
    let maxTx = -Infinity;
    let maxTy = -Infinity;
    for (let i = 0; i < w * h; i++) {
      const v = grid.data[i] ?? 0;
      if (v > 0) {
        const tx = i % w;
        const ty = (i / w) | 0;
        if (tx < minTx) minTx = tx;
        if (tx > maxTx) maxTx = tx;
        if (ty < minTy) minTy = ty;
        if (ty > maxTy) maxTy = ty;
      }
    }

    // The REAL mask, at its own native resolution — `water-surface-
    // subsystem.js`'s already-loaded texture, borrowed not owned: this
    // module must never dispose it, and must decline the bake (not
    // substitute a placeholder) until it exists, exactly as
    // `water-flow-subsystem.js#maybeBake` already does for the same texture.
    // A decline here is now SAFE to retry indefinitely — see this module's
    // own header on why the first attempt at this could get permanently
    // stuck instead of actually retrying.
    const tex = waterSurface.getFullResMaskTexture();
    if (!tex) return { ok: false, reason: 'no full-resolution mask loaded for this floor yet' };
    maskRect = {
      minX: grid.spec.x,
      minY: grid.spec.y,
      maxX: grid.spec.x + grid.spec.width,
      maxY: grid.spec.y + grid.spec.height,
    };

    // THE FLOOD runs at its OWN water-owned resolution (2026-08-19,
    // `WATER_BODY_GRID_MAX_DIM`), sized from `maskRect` (just computed above)
    // — see `water-body.js#WATER_BODY_GRID_MAX_DIM`'s own doc for why this
    // replaced supersampling the coarse cross-effect derivation grid.
    // `maskTexture` above stays at the coarse grid's native w×h (still used
    // for the AABB scan below); only the flood's own targets/materials are
    // sized to the water-owned grid, and the REAL full-resolution mask (`tex`)
    // is sampled through them via UV — resolution-independent, never assumed
    // to match either grid 1:1.
    const { w: floodW, h: floodH } = sizeBodyGrid(maskRect);
    ensureTargets(floodW, floodH);
    ensureMaterials(floodW, floodH);
    // ⚠️ EVERY node in `maskTexNodes`, not `maskTexNode` alone
    // (`feedback_texture_nodes_must_be_repointed_together`) — the seed
    // pass's area-averaged boundary test (2026-08-18) samples the mask at
    // many sub-positions per texel; each is its own `texture()` node, and a
    // tap missed here samples whatever placeholder `ensureMaterials` first
    // built the seed material against, forever.
    for (const node of materials.seed.maskTexNodes) node.value = tex;
    materials.resolve.maskTexNode.value = tex;
    // ONE FLOOD TEXEL is `(world rect width) / floodW` in world px — the
    // resolve pass converts the flood's own internal offsets (in FLOOD-texel
    // units) to world px, so it must use the FLOOD's own texel size, derived
    // from the SAME world rect the flood was just sized against, not the
    // coarse derivation grid's texel size (`grid.spec.texelW/H`, a different
    // grid entirely as of this fix).
    materials.resolve.setTexelWorld((maskRect.maxX - maskRect.minX) / floodW, (maskRect.maxY - maskRect.minY) / floodH);
    // "No shore anywhere" must read as further away than the map is wide, so
    // every distance consumer degrades continuously instead of special-casing.
    materials.resolve.setFarDistance(Math.hypot(grid.spec.width, grid.spec.height));

    // Texel AABB → WORLD AABB, padded by the shoreline's own soft reach so the
    // mesh never clips its own antialiased edge, then CLIPPED BACK TO THE MASK
    // RECT. `null` when the mask holds no water at all, which the consumer
    // reads as "draw nothing" — an empty bound, never a degenerate zero-size
    // quad.
    //
    // ⚠️ **THE PAD USED TO ESCAPE THE MAP, AND THE AUTHOR SAW IT** (2026-08-16,
    // with an arrow drawn at a band of water floating in the black above the
    // map art): *"I also noticed that water can appear outside the bounds of
    // the actual map."* A river that runs off the edge of the map has its
    // measured AABB flush against the mask's own edge, and this pad then pushes
    // the MESH 64 px past it. The surface shader clamps its mask UV to stay
    // legal, and a clamp does not stop at a boundary — it EXTRUDES the edge row
    // outward — so those 64 px sampled the map's outermost row of water texels
    // and drew water across the full width of the void beyond the map.
    //
    // The pad is still right for its own job (an interior shoreline needs the
    // room); what was missing is that the mask rect is a HARD boundary and the
    // pad is a soft one. `clipRectToMask` intersects them. `water-render.js`'s
    // own `inRect` gate closes the same hole from the other side — belt and
    // braces, deliberately, because they fail differently: this one keeps the
    // GEOMETRY honest (and so costs nothing to rasterise), that one keeps any
    // FRAGMENT that still lands outside from contributing.
    waterBounds =
      maxTx >= minTx
        ? clipRectToMask(
            {
              minX: grid.spec.x + minTx * grid.spec.texelW - WATER_BOUNDS_PAD_PX,
              minY: grid.spec.y + minTy * grid.spec.texelH - WATER_BOUNDS_PAD_PX,
              maxX: grid.spec.x + (maxTx + 1) * grid.spec.texelW + WATER_BOUNDS_PAD_PX,
              maxY: grid.spec.y + (maxTy + 1) * grid.spec.texelH + WATER_BOUNDS_PAD_PX,
            },
            maskRect
          )
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

    // No floor in the scene has water at all. Nothing to bake, and nothing to
    // clear: the body pack keeps whatever it last held, and `lastResolve`
    // says why. A consumer gates on `hasWater`, never on the pack's contents.
    // This IS a stable terminal state (retrying costs nothing to skip and
    // buys nothing either), so it is one of the two places this function
    // stamps `bakedVersion`/`bakedFloor`/`bakedOverride` — see the OTHER one,
    // below, for the one place it deliberately does NOT.
    if (resolved.floorIndex == null) {
      bakedVersion = version;
      bakedFloor = resolved.floorIndex;
      bakedOverride = overrideKey;
      lastBake = { reason: 'no water in this scene', floorIndex: null, skipped: true };
      return;
    }

    const upload = uploadMask(resolved.floorIndex);
    if (!upload.ok) {
      // ⚠️ DO NOT STAMP `bakedVersion`/`bakedFloor`/`bakedOverride` HERE —
      // real, live-reported regression (2026-08-23), water silently never
      // rendering on any map. This branch means `water-surface-subsystem.js`
      // #ensureMaskImage's own async fetch has not resolved yet — which is
      // NOT a mask-authority version change and therefore never re-trips the
      // `unchanged` gate above on its own. Stamping here (as this function
      // used to, unconditionally, before the two early-returns) made
      // `unchanged` read true on every subsequent poll even though nothing
      // had ever actually baked: the very first poll of a session almost
      // always races ahead of a real image fetch+decode, fails once, and
      // then — with the OLD code — never tries again for the rest of the
      // session, silently. This module's own header calls a decline here
      // "safe to retry indefinitely"; leaving the stamp out is what actually
      // delivers that, matching `water-flow-subsystem.js#maybeBake`'s own
      // identical-shaped decline for the exact same texture one module over.
      lastBake = { reason: upload.reason, floorIndex: resolved.floorIndex, skipped: true };
      return;
    }
    bakedVersion = version;
    bakedFloor = resolved.floorIndex;
    bakedOverride = overrideKey;
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
     * The pack's size IN TEXELS — the FLOOD's own dimensions, which is what the
     * `bodyRt` texture actually is (`sizeBodyGrid`'s own water-owned result,
     * `WATER_BODY_GRID_MAX_DIM` on the long side — see this file's §3).
     *
     * Exposed for `water-sampling.js`'s smooth reconstruction, which is
     * phase-locked to the grid: it has to know where the texel centres are, and
     * inferring them from the world rect would need the texel size, which is a
     * second derivation of the same fact. `[1, 1]` before the first bake — a
     * placeholder that is never sampled, because the surface mesh stays hidden
     * until a bake lands.
     * @returns {[number, number]}
     */
    getGridSize() {
      const [w, h] = gridKey.split('x').map(Number);
      return w > 0 && h > 0 ? [w, h] : [1, 1];
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
        // The FLOOD's own water-owned resolution (`sizeBodyGrid`) — a
        // DIFFERENT number from `lastBake.cols`×`lastBake.rows` (the coarse
        // MASK's own native grid, still used for the AABB scan) on purpose;
        // seeing them disagree is the water-owned grid working, not a
        // mismatch (see this file's §3).
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
