/**
 * depth-proxy-material-pool.js — stop paying a TSL graph rebuild for a
 * material that hasn't changed (DEFERRED-S1b, `docs/holy/V4-Testament.md`;
 * full mechanism in `docs/planning/Trace-Analysis-2026-08-11.md` §2a).
 *
 * ============================================================================
 * THE MECHANISM THIS CLOSES, VERIFIED IN THE VENDORED SOURCE, NOT ASSUMED
 * ============================================================================
 *
 * `rebuildSceneDepthProxies` (vt-pan-viewer.js) used to build a BRAND NEW
 * `buildSceneDepthWriterMaterial(...)` for every tile on EVERY residency pass
 * and dispose the previous one unconditionally. `material.dispose()` drives
 * three's per-cache-key `nodeBuilderState.usedTimes` refcount to zero — and
 * only WHOLESALE disposal (every material sharing that key going away at
 * once) can actually reach zero — which evicts the compiled shader graph
 * from `Nodes#nodeBuilderCache`. The next material built from the same
 * `writerArgs` therefore misses and pays a full `NodeBuilder.build()`
 * (`getForRender`, `three.webgpu.js:58505`) — live-measured at 3,831ms /
 * 10.7% of an entire 35.6s main thread, sustained across the whole capture,
 * not a one-time compile.
 *
 * `nodeBuilderCache`'s key (`getForRenderCacheKey` → `renderObject.
 * initialCacheKey`) is derived from the MATERIAL's own properties plus
 * scene/lighting/renderer-context state — verified by reading `RenderObject`'s
 * constructor and `getMaterialCacheKey`/`getDynamicCacheKey`
 * (`three.webgpu.js:45500-45535`, `:45795-45925`) — it does NOT depend on the
 * mesh or its geometry at all. That is why pooling only the MATERIAL, while
 * leaving the wholesale MESH rebuild exactly as it was, is sufficient: a new
 * mesh sharing a pooled (unchanged) material produces a render object whose
 * `initialCacheKey` is the SAME number as the previous pass's, so
 * `getForRender`'s second-level lookup (`nodeBuilderCache.get(cacheKey)`)
 * hits even though the render object itself is new.
 *
 * ============================================================================
 * VEGETATION IS POOLED TOO, kept collision-safe by `variantKey` (since `25b81cff`)
 * ============================================================================
 *
 * Vegetation's proxy carries a `positionNode` closure built over `overlay.motion`
 * (see `buildVegetationSwayDisplacementNode`'s own header) — this used to be the
 * reason vegetation was excluded from this pool entirely (pooling it wrong risks
 * a pooled material silently animating the wrong item's canopy). `25b81cff`
 * ("Fix the shader-rebuild churn: pool vegetation depth proxies") closed that gap
 * instead of leaving it open: `vt-pan-viewer.js` caches each overlay's
 * `positionNode` per `overlay.motion` in `vegetationProxyNodeCache`, and routes
 * the resulting depth-writer material through `depthProxyMaterialPool.get(...)`
 * with `variantKey: veg:${nodeEntry.id}` — a per-overlay id, never shared across
 * canopies. `computeDepthProxyMaterialSignature` below REQUIRES a `variantKey`
 * whenever `positionNode` is present (throws otherwise, see its own JSDoc) —
 * that requirement, not "vegetation never calls this module," is the real
 * safety measure: it is what makes two different canopies' positionNode-bearing
 * materials collide-proof rather than something a future caller must remember.
 *
 * ============================================================================
 * WHY OPAQUE ITEMS KEY ACROSS TEXTURES BUT ALPHA-TESTED ONES DO NOT
 * ============================================================================
 *
 * `buildSceneDepthWriterMaterial`'s own early-return branch
 * (`alwaysOpaque || (!tex && !fluidMaskTex)`, extended for
 * mythica-machina-press#543's second round — see below) never calls
 * `texture(tex)` at all — the returned material's fragment graph is
 * `Fn(() => vec4(uFloorIndex, float(0), uFlags, float(1)))()`, identical
 * regardless of which texture the caller passed. Two opaque items with
 * DIFFERENT textures therefore share ONE pooled material correctly; the
 * non-opaque (alpha-tested) branch DOES sample `tex`, so its signature must
 * include the texture's own identity (`tex.uuid`) or two different items'
 * art would render through the wrong proxy. Read from `scene-depth.js`
 * directly before encoding this, not guessed from the parameter names.
 *
 * ============================================================================
 * SECOND ROUND, mythica-machina-press#543 — `fluidMaskTex` extends the SAME
 * RULE, NOT A NEW ONE
 * ============================================================================
 *
 * A Fluid carrier tile's depth-writer material now OPTIONALLY samples a
 * SECOND texture (`fluidMaskTex`, its authored fluid mask — see
 * `scene-depth.js#buildSceneDepthWriterMaterial`'s own doc) at a per-tile UV
 * remap (`fluidMaskUvOffset`/`fluidMaskUvScale` — a SPLIT item's several
 * sub-tiles each need a different one). Exactly the same reasoning as `tex`
 * above applies: whenever the fragment graph genuinely samples a texture,
 * that texture's identity (and, here, the offset/scale that address it) must
 * be part of the key, or two items — or two sub-tiles of the SAME item —
 * would collide onto one pooled material and one of them would occlude by
 * the WRONG silhouette. The opaque bucket is unaffected either way: neither
 * `tex` nor `fluidMaskTex` is ever sampled there, so it still keys the same
 * regardless of what either one is.
 *
 * @module vt/depth-proxy-material-pool
 */

/**
 * A stable signature for one `buildSceneDepthWriterMaterial(writerArgs)`
 * call — two calls that would produce the SAME shader graph get the SAME
 * string, so the pool can recognise a repeat without ever calling the build
 * function.
 *
 * @param {object} args
 * @param {*} [args.tex] - a `THREE.Texture`-shaped object with a `.uuid`, or
 *   absent (matches `buildSceneDepthWriterMaterial`'s own "no tex" case).
 * @param {number} [args.alphaThreshold]
 * @param {number} args.floorIndex
 * @param {number} args.flags
 * @param {boolean} [args.alwaysOpaque]
 * @param {*} [args.positionNode] - presence only. PRESENCE IS NOT IDENTITY:
 *   two different canopies both carry a positionNode, and their nodes animate
 *   DIFFERENT items. A caller passing a positionNode must therefore also pass
 *   a `variantKey` that distinguishes it, or two canopies would share one
 *   pooled material and one of them would sway to the other's wind. That
 *   requirement is enforced below (this function throws rather than returning
 *   a silently-aliasing key) — see `variantKey`.
 * @param {string} [args.variantKey] - REQUIRED whenever `positionNode` is
 *   present; ignored otherwise. Anything stable that identifies which item's
 *   node graph this is (the caller's own per-overlay id). Folded into the key
 *   so two positionNode-bearing materials can never collide.
 * @param {boolean} [args.colorWrite] - `false` for S1.4's prepass twin,
 *   otherwise the real proxy — MUST differentiate the key: two materials
 *   that differ only in `colorWrite` are not interchangeable (one paints the
 *   frame's real picture, the other must not), and they cannot share a
 *   single `THREE.NodeMaterial` object at all since `colorWrite` is a
 *   material-level property, not a per-draw one.
 * @param {*} [args.fluidMaskTex] - mythica-machina-press#543, SECOND ROUND.
 *   `buildSceneDepthWriterMaterial`'s new second texture (see its own doc):
 *   when present, the fragment graph samples it too, at a per-tile UV remap
 *   (`fluidMaskUvOffset`/`fluidMaskUvScale`, below), so — exactly like `tex`
 *   in the alpha-tested branch — its IDENTITY must be part of the key, or
 *   two items with different masks (or the same item's different sub-tile
 *   crops) would collide onto one pooled material and occlude by the WRONG
 *   silhouette. Absent/`null` reproduces today's key exactly (see the
 *   `alwaysOpaque` fast-path branch below, which now also covers `!tex &&
 *   !fluidMaskTex`, mirroring the material builder's own condition).
 * @param {number[]} [args.fluidMaskUvOffset] @param {number[]} [args.fluidMaskUvScale] -
 *   folded into the key alongside `fluidMaskTex`'s own identity — a SPLIT
 *   item's several sub-tiles share one `fluidMaskTex` but need DIFFERENT
 *   offset/scale uniforms, so two of them must never share one pooled
 *   material either (the exact `variantKey` aliasing class this module's own
 *   `positionNode` guard above already exists to prevent, applied here to a
 *   value instead of a node identity).
 * @param {number} [args.fluidMaskEpsilon] - folded in too, even though every
 *   real caller today passes the same constant (`scene-depth.js`'s own
 *   `FLUID_PRESENCE_EDGE0` default) — a signature describes the material's
 *   ACTUAL shader inputs, not just the ones some caller happens to vary yet.
 * @returns {string}
 */
export function computeDepthProxyMaterialSignature({
  tex,
  alphaThreshold,
  floorIndex,
  flags,
  alwaysOpaque = false,
  positionNode,
  variantKey,
  colorWrite = true,
  fluidMaskTex,
  fluidMaskUvOffset,
  fluidMaskUvScale,
  fluidMaskEpsilon,
}) {
  const cw = colorWrite === false ? 0 : 1;
  // FAIL LOUD RATHER THAN ALIAS (2026-08-11). The original version folded only
  // the PRESENCE of a positionNode into the key, which was safe ONLY because
  // the one caller that had one never used this pool. Now that it
  // does, presence-only would map every canopy to a single shared entry and
  // animate them all from whichever overlay happened to build first — a wrong
  // -picture bug that no test of THIS module would catch, because the aliasing
  // is only visible on screen. A required, explicit id is what makes that
  // class of bug unrepresentable instead of merely unlikely.
  if (positionNode && !variantKey) {
    throw new Error(
      'computeDepthProxyMaterialSignature: a positionNode-bearing material MUST also pass a variantKey. ' +
        'Without one, two different canopies would share a pooled material and sway to the wrong item’s ' +
        'wind — silent, on-screen-only, and invisible to this module’s own tests.'
    );
  }
  const pos = positionNode ? `pos:${variantKey}` : 'nopos';
  // mythica-machina-press#543, SECOND ROUND — matches
  // `buildSceneDepthWriterMaterial`'s OWN early-Z fast-path condition
  // exactly (`alwaysOpaque || (!tex && !fluidMaskTex)`): that is the ONLY
  // shape whose fragment graph samples no texture at all, so it is the only
  // one two DIFFERENT items may still share one pooled material for,
  // regardless of which tex/fluidMaskTex either happens to carry (see this
  // module's own header, "WHY OPAQUE ITEMS KEY ACROSS TEXTURES").
  if (alwaysOpaque || (!tex && !fluidMaskTex)) {
    return `opaque|${floorIndex}|${flags}|${cw}|${pos}`;
  }
  const texId = tex ? (tex.uuid ?? String(tex.id ?? 'notex')) : 'notex';
  // The fluid-mask part of the key is OMITTED entirely when no mask was
  // passed — an ordinary alpha-tested (non-Fluid) tile's key stays
  // byte-for-byte what it was before this round, so nothing already pooled
  // gets evicted and rebuilt for a change that does not concern it.
  const fluidPart = fluidMaskTex
    ? `|fluid:${fluidMaskTex.uuid ?? String(fluidMaskTex.id ?? 'nofluidtex')}` +
      `:${fluidMaskUvOffset?.[0] ?? 0},${fluidMaskUvOffset?.[1] ?? 0}` +
      `:${fluidMaskUvScale?.[0] ?? 1},${fluidMaskUvScale?.[1] ?? 1}` +
      `:${fluidMaskEpsilon ?? ''}`
    : '';
  return `alpha|${texId}|${floorIndex}|${flags}|${alphaThreshold}|${cw}|${pos}${fluidPart}`;
}

/**
 * A pass-scoped mark-and-sweep pool. Pure state machine — no THREE
 * dependency, `dispose`/`build` are both injected, so this is fully
 * Node-testable with plain object stand-ins for materials.
 *
 * Usage, once per `rebuildSceneDepthProxies` call:
 * ```js
 * pool.beginPass();
 * for (const tile of tiles) {
 *   const material = pool.get(signature, () => buildSceneDepthWriterMaterial(args));
 * }
 * const { kept, evicted } = pool.endPass((material) => material.dispose());
 * ```
 *
 * @returns {{
 *   beginPass: () => void,
 *   get: (signature: string, build: () => *) => *,
 *   endPass: (dispose: (material: *) => void) => {kept: number, evicted: number},
 *   size: () => number,
 *   disposeAll: (dispose: (material: *) => void) => void,
 *   stats: () => {hits: number, misses: number, evictions: number},
 * }}
 */
export function createDepthProxyMaterialPool() {
  const entries = new Map();
  /** @type {Set<string>|null} null outside a beginPass/endPass bracket — a
   * get() call outside the bracket is a caller bug, not a state to paper
   * over silently (see get()'s own throw). */
  let keepSet = null;
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  return {
    beginPass() {
      keepSet = new Set();
    },
    get(signature, build) {
      if (keepSet === null) {
        throw new Error('depth-proxy-material-pool: get() called outside a beginPass()/endPass() bracket.');
      }
      keepSet.add(signature);
      let material = entries.get(signature);
      if (material === undefined) {
        misses++;
        material = build();
        entries.set(signature, material);
      } else {
        hits++;
      }
      return material;
    },
    endPass(dispose) {
      if (keepSet === null) {
        throw new Error('depth-proxy-material-pool: endPass() called without a matching beginPass().');
      }
      let evicted = 0;
      for (const [signature, material] of entries) {
        if (!keepSet.has(signature)) {
          dispose(material);
          entries.delete(signature);
          evicted++;
        }
      }
      evictions += evicted;
      keepSet = null;
      return { kept: entries.size, evicted };
    },
    size() {
      return entries.size;
    },
    disposeAll(dispose) {
      for (const material of entries.values()) dispose(material);
      entries.clear();
      keepSet = null;
    },
    /** Lifetime counters for the perf report — see diag/perf-report.js's
     * pipelineStats before/after pattern; this is the same shape. */
    stats() {
      return { hits, misses, evictions, size: entries.size };
    },
  };
}
