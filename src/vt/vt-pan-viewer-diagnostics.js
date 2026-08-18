/**
 * `_active.getDiagnostics()` — the whole-viewer report — pulled out of
 * `vt-pan-viewer.js` (extraction step 5, `docs/planning/VT-Pan-Viewer-Extraction.md`).
 *
 * Deferred deliberately to LAST, per the plan's own reasoning: this reads
 * nearly every subsystem, so it is easiest once each already exposes its own
 * `getStatus()` — sun shadows, vegetation shadows, and the point-light pool
 * (steps 1-3) all do now. Step 4 (whole-image loading) was SKIPPED, not
 * forgotten: this function only READS whole-image state through the closure
 * variables already named below, it does not touch the loader itself, so
 * nothing here depended on step 4 landing first.
 *
 * ============================================================================
 * WHY THIS WAS THE 2026-07-26 UNBLOCK, NOT A DEFERRED NICE-TO-HAVE
 * ============================================================================
 * Water Phase 2d needs ~20 lines of headroom in `startVtPanViewer()` to wire
 * in the body-pack subsystem, and the function was already at its frozen
 * budget. The ratchet is right to have stopped that — see
 * `feedback_ratchet_proactive_not_reactive` — but the fix is to do the
 * PLANNED split now, as prep, not to loosen the cap. This is that split.
 *
 * ============================================================================
 * TRAP #1 (mutable locals read live) DOES NOT APPLY HERE, AND HERE IS WHY
 * ============================================================================
 * Every earlier extraction (sun shadows, vegetation shadows, point lights)
 * built a LONG-LIVED subsystem object, constructed once, that needed to keep
 * observing viewer-closure values that changed AFTER construction — hence
 * getters (`getShadowHandle: () => shadowHandle`), never bare values.
 *
 * This extraction is different in kind: `buildViewerDiagnostics(args)` is not
 * constructed once, it is CALLED FRESH every time `_active.getDiagnostics()`
 * runs. The caller's own wrapper — `getDiagnostics() { return
 * buildViewerDiagnostics({ frameTimes, itemStates, ... }) }` — reads each
 * name's CURRENT binding via ordinary JS closure capture at the moment of the
 * call, which is exactly what the original inline method body did too. There
 * is nothing to go stale, because nothing is held between calls. Pass plain
 * values, not getters, for every argument below.
 *
 * ============================================================================
 * WHAT MOVED, AND WHY EACH PIECE LANDED WHERE IT DID
 * ============================================================================
 * `percentileMs` and `sampleDiagnostics` were both viewer-closure functions
 * with NO free variables of their own beyond their own parameters — a grep
 * confirmed neither is called from anywhere except inside `getDiagnostics`'
 * own body. They move wholesale (same lines, new home — VT-Pan-Viewer-
 * Extraction.md §6's own rule), not passed as args, which is both simpler and
 * shrinks `vt-pan-viewer.js` a little further for free.
 *
 * `describeRenderMode`, `getCompressedTextureStats`, `getDecodeStats`,
 * `mipChainByteLength`, `tokenFootprint` are ordinary module imports in the
 * original file (not viewer-closure state) — this module imports them
 * directly from the same sources, exactly like `mask-authority-report.js`
 * imports straight from `mask-catalog.js`/`mask-derive.js` rather than taking
 * them as arguments.
 *
 * Everything else — 36 names, all genuine viewer-closure state (some `let`
 * and reassigned elsewhere in the file, some `const` objects whose CONTENTS
 * mutate but whose binding never does) — is an explicit named field on the
 * one `args` object `buildViewerDiagnostics` destructures. The destructured
 * names are IDENTICAL to their original bare identifiers, so the 500-line
 * body below needed zero internal rewrites — only the function's own
 * signature line changed. That is deliberate: the lower the textual diff on a
 * body this dense with forensic reasoning comments, the lower the chance of a
 * silent transcription mistake.
 *
 * @module vt/vt-pan-viewer-diagnostics
 */

import { mipChainByteLength } from './block-compress.js';
import { getCompressedTextureStats } from './compressed-textures.js';
import { getDecodeStats } from './decode-pool.js';
import { tokenFootprint } from '../foundry/index.js';
import { describeRenderMode } from '../diag/render-fallback.js';

/**
 * Nearest-rank percentile of a small sample array, rounded to 0.1ms. Pure,
 * no clock, no allocation-sensitive hot-path concern — this is only ever
 * called from a manually-triggered diagnostics report, never per frame.
 * `null` on an empty array (no lying: "no samples yet" must never read as 0ms).
 * @param {number[]} samples
 * @param {number} p - 0..1
 * @returns {number|null}
 */
export function percentileMs(samples, p) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[idx] * 10) / 10;
}

/** Ground truth, not theory: actual rendered canvas pixels + one pack's actual indirection buffer contents. */
/** The cheap, synchronous half: one pack's indirection buffer (plain JS state). */
export function sampleDiagnostics(pack) {
  const out = {};
  if (pack) {
    let nonZeroTexels = 0;
    const distinctSlots = new Set();
    for (let i = 0; i < pack.buf.length; i += 4) {
      if (pack.buf[i + 3] > 0) {
        nonZeroTexels++;
        distinctSlots.add(pack.buf[i] | (pack.buf[i + 1] << 8));
      }
    }
    out.indirectionBuffer = {
      totalTexels: pack.buf.length / 4,
      residentTexels: nonZeroTexels,
      distinctSlotCount: distinctSlots.size,
      distinctSlotsSample: Array.from(distinctSlots).slice(0, 10),
    };
  }
  return out;
}

/**
 * The layer-residency scan: per (item × pack), the GROUND-TRUTH coarse-pin
 * residency (not the request size — see the inline comment for the real
 * 2026-07-16 bug that distinction fixed) plus the running totals the report's
 * `layerResidencyTotals` block needs. Split out of `buildViewerDiagnostics`
 * 2026-07-26 (this scan reads only `itemStates`/`itemLoadErrors`/`cache`, so
 * it is a genuine, narrow, independently-nameable unit — not a slice cut
 * arbitrarily to satisfy a line count).
 *
 * @param {object} args
 * @param {Map} args.itemStates @param {any[]} args.itemLoadErrors @param {any} args.cache
 * @returns {{layerResidency: any[], layerLoadErrors: any[], totalViewResident: number,
 *   totalCoarsePinned: number, totalCoarseIntended: number, coarsePinShortfall: number}}
 */
function computeLayerResidency({ itemStates, itemLoadErrors, cache }) {
  const layerResidency = [];
  const layerLoadErrors = [];
  let totalViewResident = 0;
  let totalCoarsePinned = 0;
  let totalCoarseIntended = 0;
  for (const [itemId, state] of itemStates) {
    for (const pack of state.packs.values()) {
      // GROUND TRUTH, not intent (real bug, 2026-07-16: this used to
      // report `pack.coarsePages.length` — the SET SIZE ASKED for —
      // which stayed the same whether or not those pages actually landed
      // in the cache. A coarse-pin request CAN fail under pressure (see
      // updateResidency's phase-1/phase-2 fix comment for the exact
      // scenario) — this masked exactly that failure: a report showing
      // "651 coarse pinned" sat right next to `cacheStats.pinnedCoarse:
      // 434`, a live discrepancy nobody could see. Count actual cache
      // residency per coarse-page key instead.
      const coarseIntended = pack.coarsePages.length;
      let coarseResident = 0;
      for (const page of pack.coarsePages) if (cache.isResident(page.key)) coarseResident++;
      const viewN = pack.residentViewKeys.size;
      totalCoarsePinned += coarseResident;
      totalCoarseIntended += coarseIntended;
      totalViewResident += viewN;
      layerResidency.push({
        item: itemId,
        kind: state.item.kind,
        layer: pack.name,
        coarsePinned: coarseResident,
        coarseIntended,
        viewResident: viewN,
      });
    }
    for (const e of state.layerErrors ?? []) layerLoadErrors.push({ item: itemId, ...e });
  }
  for (const e of itemLoadErrors) layerLoadErrors.push(e);
  return {
    layerResidency,
    layerLoadErrors,
    totalViewResident,
    totalCoarsePinned,
    totalCoarseIntended,
    // Non-zero here means the "coarse pins are the guaranteed floor"
    // invariant is currently VIOLATED for at least one pack — a page with
    // no resident data at any mip renders magenta, not blur. Should always
    // be 0 after the phase-1/phase-2 ordering fix; kept as a tripwire.
    coarsePinShortfall: totalCoarseIntended - totalCoarsePinned,
  };
}

/**
 * THE DRAW LIST, in paint order — the direct answer to "why is this on top of
 * that". Each entry's renderOrder came from sortByLayer (scene/layer-order.js)
 * over its (elevation, sortLayer, sort, zIndex) key, so this table IS the
 * layering, not a summary of it. Split out of `buildViewerDiagnostics`
 * 2026-07-26 — reads only `lastItems`/`itemStates` (plus the imported
 * `tokenFootprint`), so it stands alone cleanly.
 *
 * @param {object} args
 * @param {any[]} args.lastItems @param {Map} args.itemStates
 * @returns {any[]}
 */
function buildDrawList({ lastItems, itemStates }) {
  return lastItems.map((i) => {
    const state = itemStates.get(i.id);
    return {
      renderOrder: i.renderOrder,
      id: i.id,
      kind: i.kind,
      elevation: i.key.elevation,
      sortLayer: i.key.sortLayer,
      sort: i.key.sort,
      zIndex: i.key.zIndex,
      visible:
        state?.mesh?.visible ?? (state?.wholeImage ? state.wholeImage.tiles.some((tt) => tt.mesh?.visible) : false),
      occlusionModes: i.occlusion?.modes ?? 0,
      // GROUND TRUTH vs RENDERED, for tokens only (2026-07-17 — "stops
      // slightly short" after the moveToken fix). `state.placement` is
      // what refreshItemPlacement last actually wrote to the mesh — a
      // SNAPSHOT from whenever the last residency pass ran. `i._placement
      // .tokenDoc` is the SAME live document reference `lastItems` was
      // built from, re-read HERE, at report-generation time, which can be
      // LATER than the last pass. Re-deriving the footprint fresh from it
      // (not trusting any cached footprint) answers the only question that
      // matters: is MSA's rendered position CURRENTLY behind Foundry's
      // live document, or does it already match right now?
      //   liveVsRendered: null  -> not a token, or not placed yet.
      //   deltaPx ~0            -> MSA matches Foundry AT REPORT TIME. The
      //                            "short" stop was transient (report taken
      //                            mid-movement) or is a rendering/geometry
      //                            issue, not a sync gap.
      //   deltaPx > 0, and a SECOND report taken later still shows the SAME
      //   nonzero delta -> MSA is genuinely stuck behind the live document.
      // WHERE THIS QUAD ACTUALLY IS, and what its page grid was built from
      // (2026-07-17 — the "very large, wrong position, partially
      // transparent, never evicted" ghost). Those four properties together
      // do NOT describe a virtual-texture fault: the sampler's two failure
      // colours are both OPAQUE (magenta = broken pin invariant, black =
      // out-of-world), and a page-level lie would still be confined to that
      // page's own world area rather than appearing "very large". A
      // MISPLACED/MIS-SIZED QUAD explains all four at once — including
      // "never evicted", because a mesh is not a page and zooming can never
      // reclaim it. These two fields tell those apart from ONE report,
      // instead of a fourth round of theory.
      //
      //   placementPx wildly larger than the scene, or origin far outside
      //   world{} -> the quad is wrong: computeItemPlacement / imageSizePx.
      //   placementPx sane, artefact still on screen -> genuinely the
      //   sampler, and the pyramid/mip math is next.
      //
      // imageSizePx is included because it is placement's hidden INPUT
      // (`state.imageSize`, read once from getSourceDimensions at load) and
      // a wrong value there silently mis-sizes the quad forever after —
      // exactly the "never evicted" signature. It is also the field that
      // would expose a regression in readLeadingBytes' PNG-header parse.
      placementPx: state?.placement
        ? {
            x: Math.round(state.placement.x),
            y: Math.round(state.placement.y),
            width: Math.round(state.placement.width),
            height: Math.round(state.placement.height),
            rotation: state.placement.rotation ?? 0,
          }
        : null,
      imageSizePx: state?.imageSize ?? null,
      liveVsRendered: (() => {
        if (i.kind !== 'token' || !i._placement?.tokenDoc) return null;
        if (!state?.placement) return null;
        const live = tokenFootprint(i._placement.tokenDoc, i._placement.gridSize);
        const dx = live.centerX - state.placement.x;
        const dy = live.centerY - state.placement.y;
        return {
          liveX: live.centerX,
          liveY: live.centerY,
          renderedX: state.placement.x,
          renderedY: state.placement.y,
          deltaPx: Math.round(Math.hypot(dx, dy) * 10) / 10,
        };
      })(),
      // THE ACTUAL UNIFORM VALUES the shader is running on, read straight off the
      // JS side -- exact, and involving no shader at all. Kept after the bisect
      // scaffolding was stripped because it earned it: printing these is what
      // proved the occlusion weights were clean zeros, which is what forced the
      // search onto the OPERATION rather than the values and found the .mix()
      // trap (reference_tsl_method_chaining_trap).
      uniforms: (() => {
        const a = state?.appearance;
        if (!a) return null;
        return {
          occlusionWeights: a.uOcclusionWeights.value.toArray(),
          occlusionElevation: a.uOcclusionElevation.value,
          alpha: a.uAlpha.value,
          unoccludedAlpha: a.uUnoccludedAlpha.value,
          occludedAlpha: a.uOccludedAlpha.value,
          tint: a.uTint.value.toArray(),
          srgbDecode: state?.vt?.uniforms.srgbDecode.value ?? null,
        };
      })(),
    };
  });
}

/**
 * WHOLE-IMAGE MODE STATE — the primary instrument for the "load images like
 * PIXI" path (2026-07-17). Split out of `buildViewerDiagnostics` 2026-07-26 —
 * it was ALREADY a self-contained IIFE in the original body (reading only
 * `itemStates`/`textureLimit`/`alphaGridStats`/`sunShadows`/`envLight`, plus
 * the imported `mipChainByteLength`/`getCompressedTextureStats`), so giving it
 * a name and a top-level home is a mechanical move, not a redesign.
 *
 * @param {object} args
 * @param {Map} args.itemStates @param {number} args.textureLimit @param {any} args.alphaGridStats
 * @param {any} args.sunShadows @param {any} args.envLight
 * @returns {object}
 */
function summarizeWholeImage({ itemStates, textureLimit, alphaGridStats, sunShadows, envLight }) {
  const perItem = [];
  let totalBytes = 0;
  let totalBc1Bytes = 0;
  let ready = 0;
  let errors = 0;
  let freed = 0;
  let retained = 0;
  let appliedCount = 0;
  for (const [id, s] of itemStates) {
    const wi = s.wholeImage;
    if (!wi) continue;
    // HONEST bytes: count what the GPU actually holds for THIS item —
    // BC1 (8×) or BC7 (2× vs BC1) when compressed, raw RGBA8 otherwise.
    // (Before BC7 landed this always counted raw and over-reported the
    // compressed floors ~8× — memory: feedback_instruments_must_not_lie.)
    const isBc7 = wi.compressed && wi.compressed.startsWith('bc7');
    const isBc1 = wi.compressed && wi.compressed.startsWith('bc1');
    const rs = wi.rawScale || 1; // <1 only on the capped raw fallback
    let bytes = 0;
    for (const tt of wi.tiles) {
      // BC1 reference size (projection column) — the FULL chain's
      // bytes, matching what real BC1 usage now costs (mip-chain fix).
      totalBc1Bytes += mipChainByteLength('bc1', tt.tile.sw, tt.tile.sh);
      if (isBc7) bytes += mipChainByteLength('bc7', tt.tile.sw, tt.tile.sh);
      else if (isBc1) bytes += mipChainByteLength('bc1', tt.tile.sw, tt.tile.sh);
      // raw RGBA8 at the ACTUALLY uploaded size (the fallback cap shrinks
      // it), *4/3 for its own now-real mip chain — see the other
      // wholeImage snapshot above for why this one stays an
      // approximation instead of an exact per-level sum.
      else bytes += Math.round(tt.tile.sw * rs) * Math.round(tt.tile.sh * rs) * 4 * (4 / 3);
    }
    totalBytes += bytes;
    freed += wi.bitmapsFreed;
    retained += wi.bitmapsRetained;
    if (isBc1 || isBc7) appliedCount++;
    if (wi.status === 'ready') ready++;
    if (wi.status === 'error') errors++;
    perItem.push({
      id,
      src: wi.src,
      status: wi.status, // loading | ready | error
      error: wi.error,
      grid: wi.plan ? `${wi.plan.cols}×${wi.plan.rows}${wi.plan.whole ? ' (whole)' : ''}` : null,
      imageSize: wi.imageSize,
      tilesDecoded: wi.tiles.length,
      tilesPlanned: wi.plan?.tiles ?? null,
      approxVramMB: +(bytes / (1024 * 1024)).toFixed(1),
      visible: wi.tiles.some((tt) => tt.mesh?.visible),
      renderOrder: wi.renderOrder,
      bitmapsFreed: wi.bitmapsFreed,
      bitmapsRetained: wi.bitmapsRetained,
      compressed: wi.compressed, // null | bc1|bc7 (+ (cached)) | error:fellback
      alphaStats: wi.alphaStats, // {min,max,mean} of the DECODED source alpha, pre-encode, or null
    });
  }
  return {
    textureLimit,
    itemCount: perItem.length,
    ready,
    errors,
    approxVramMB: +(totalBytes / (1024 * 1024)).toFixed(1),
    bitmapsFreed: freed,
    bitmapsRetained: retained,
    estTextureVramMB: +(totalBytes / (1024 * 1024)).toFixed(1),
    // PROJECTION (not yet applied): what these exact floors would occupy
    // as GPU-compressed textures. The device dies ~2.5GB uncompressed
    // (estTextureVramMB); compressed, both floors fit well under 1GB —
    // the fight-for-WebGPU fix. Encoder is landed + Node-tested
    // (block-compress.js); encode→IndexedDB-cache→CompressedTexture is next.
    compressed: {
      // REFERENCE projections (hypothetical whole-scene costs), NOT the
      // live bill — that is estTextureVramMB above, now honest per-format.
      bc1IfAllMB: +(totalBc1Bytes / (1024 * 1024)).toFixed(1), // 0.5 B/px, 8× smaller
      bc7IfAllMB: +((totalBc1Bytes * 2) / (1024 * 1024)).toFixed(1), // 1 B/px, 4×, carries alpha
      applied: appliedCount > 0, // are any items ACTUALLY compressed now?
      appliedItems: appliedCount,
      worker: getCompressedTextureStats(), // requests/bc1/bc7/failed/cached
    },
    // THE ART-OPACITY SEAM (2026-07-24). `delivered` is the number
    // that matters: it is the count of items the mask authority can
    // derive cover from, and it was structurally ZERO from the
    // streaming engine's retirement until this landed. If sky-reach
    // shadows or rain-under-a-bridge look wrong, read this FIRST —
    // requested-but-not-delivered is a load problem, never-requested
    // is a wiring problem, and they need different fixes.
    coarseAlpha: { ...alphaGridStats },
    // SUN SHADOWS (docs/planning/Sun-Shadows.md) — the caster field
    // and the last march, verbatim. Read by boot's `sun-shadows`
    // report, which is where the interpretation lives.
    sunShadows: {
      compiled: envLight.sunShadowCompiled,
      ...sunShadows.getStatus(),
    },
    interpretation:
      'Every item draws as plain whole texture(s) with NO page streaming — the fix ' +
      'for the upload-churn device loss (the streaming/virtual-texture engine this replaced ' +
      'was removed 2026-07-22 — see feedback_mode_forks_silently_drop_features; there is no ' +
      'other mode any more). Per item, status is loading|ready|error (error names ' +
      'the failed src). grid "1×1 (whole)" = one texture (a 12000² floor at the 16384 cap); ' +
      '"2×2" = the quarter-split fallback on a smaller texture limit. tilesDecoded < ' +
      'tilesPlanned mid-load is normal; staying below it, or status:error, is a LOAD failure ' +
      '(check src/error). CRUCIAL: if the screen is BLACK yet every item is ' +
      'status:ready + visible:true, it is NOT a load failure — the quads are drawing wrong ' +
      '(offscreen placement, a Y-flip, or a colorSpace/sample bug); that is a geometry/shader ' +
      'issue, not a decode one. MEMORY (the floor-switch device-loss hunt, 2026-07-18): bitmapsFreed ' +
      'is decoded CPU bitmaps closed right after GPU upload; bitmapsRetained MUST stay 0 — a ' +
      'nonzero value means a ~w·h·4 bitmap (576 MB for a 12000² tile) is still held alongside ' +
      'its GPU copy, the exact doubling that blew the memory ceiling. estTextureVramMB is the ' +
      'honest whole-image texture bill (no atlas exists any more to add on top). It is honest ' +
      'PER FORMAT: opaque items are BC1 (8× smaller), alpha items BC7 (4×), raw only ' +
      'if compression was unavailable. Uncompressed, both floors full-res is ~2.75 GB (the old ' +
      'device-loss trigger); with BC1+BC7 the same scene is ~0.5 GB — the `compressed` block shows ' +
      'the reference projections. If estTextureVramMB still climbs toward ~2.5 GB, compression is ' +
      'NOT being applied (check compressed.applied / per-item compressed) — Chrome WebGPU TDRs the ' +
      'device on a big allocation under pressure where its WebGL would not. Per-item alphaStats ' +
      '{min,max,mean} (2026-07-18) is the SOURCE alpha the decoder handed the worker, BEFORE BC7 ' +
      'touches it — added because a BC7 item can be status:ready+visible:true+compressed:"bc7" ' +
      '(every OTHER instrument says success) and still render solid black. min/max near 255 means ' +
      'the decode is fine and the bug is downstream (encode/pack/GPU-upload); min/max near 0 means ' +
      'it was ALREADY wrong before BC7 ever ran (decode/premultiply). null = raw path or pre-fix cache.',
    items: perItem,
  };
}

/**
 * The whole-viewer diagnostics report — `_active.getDiagnostics()`'s former
 * body, now orchestrating three extracted helpers above plus the fields small
 * enough to stay inline, reading its 36 dependencies from `args` instead of
 * the viewer's own closure. See this module's header for why plain values
 * (never getters) are correct here.
 *
 * @param {object} args
 * @param {any} args._active - the viewer's own public API object (for
 *   `getSceneColorInfo`/`getFramePlanInfo`/etc. — self-referential because
 *   this property lives ON that same object; safe because the method body
 *   only runs after `_active = {...}` has finished assigning).
 * @param {any} args.canvas @param {boolean} args.loopActive
 * @param {any} args.frameTimes @param {any[]} args.lastItems @param {Map} args.itemStates
 * @param {any[]} args.itemLoadErrors @param {any} args.cache @param {any} args.renderer
 * @param {number|null} args.shaderCompileMs @param {number|null} [args.warmUpMs]
 * @param {number|null} [args.warmUpPipelinesCreated] @param {number} args.prefetchSkippedPacks
 * @param {any} args.lastUpdate @param {number} args.passSeq @param {any[]} args.tokenPassLog
 * @param {number} args.canvasW @param {number} args.canvasH @param {number} args.drawBufW @param {number} args.drawBufH
 * @param {number} args.pixelRatio @param {any} args.mount @param {number} args.textureLimit
 * @param {any} args.alphaGridStats @param {any} args.sunShadows @param {any} args.envLight @param {any} args.world
 * @param {string} args.displayLayerName @param {any} args.currentCoarseBudget @param {any} args.gpuProbe
 * @param {number[]} args.frameGapTimes @param {number} args.HITCH_THRESHOLD_MS @param {any[]} args.hitchLog
 * @param {any} args.lastError @param {Set<string>} args.heldPanKeys @param {{x:number,y:number}} args.panVelocity
 * @param {number|null} args.targetHalfSpanPx @param {any} args.view
 * @returns {object} the report — see the field-level comments in the body for what each means.
 */
export function buildViewerDiagnostics({
  _active,
  canvas,
  loopActive,
  frameTimes,
  lastItems,
  itemStates,
  itemLoadErrors,
  cache,
  renderer,
  shaderCompileMs,
  warmUpMs = null,
  warmUpPipelinesCreated = null,
  prefetchSkippedPacks,
  lastUpdate,
  passSeq,
  tokenPassLog,
  canvasW,
  canvasH,
  drawBufW,
  drawBufH,
  pixelRatio,
  mount,
  textureLimit,
  alphaGridStats,
  sunShadows,
  envLight,
  world,
  displayLayerName,
  currentCoarseBudget,
  gpuProbe,
  frameGapTimes,
  HITCH_THRESHOLD_MS,
  hitchLog,
  lastError,
  heldPanKeys,
  panVelocity,
  targetHalfSpanPx,
  view,
}) {
  const avgMs = frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0;
  // The viewed floor's first item, as the sample subject for the
  // pixel/indirection ground-truth probe below.
  const sampleState = lastItems.length ? itemStates.get(lastItems[0].id) : undefined;
  const albedo = sampleState?.albedoPack;
  const {
    layerResidency,
    layerLoadErrors,
    totalViewResident,
    totalCoarsePinned,
    totalCoarseIntended,
    coarsePinShortfall,
  } = computeLayerResidency({ itemStates, itemLoadErrors, cache });
  const drawList = buildDrawList({ lastItems, itemStates });

  // A scan of drawList so a token desync doesn't require reading the
  // whole (potentially long) table by eye. Empty array = every token
  // currently matches its live document — the good state.
  const tokenSyncSummary = drawList
    .filter((e) => e.liveVsRendered && e.liveVsRendered.deltaPx > 1)
    .map((e) => ({ id: e.id, deltaPx: e.liveVsRendered.deltaPx }));

  return {
    view,
    // buf:scene.color — the first real render target, and the proof that
    // Keyhole's law is IN THE PATH rather than merely imported. If
    // `throughAllocator` is ever false, the law has been routed around.
    sceneColor: _active?.getSceneColorInfo?.() ?? { allocated: false },
    // THE PASS RUNNER (2026-07-18) — proof `renderFrame` is graph-driven,
    // not hardcoded. `ranThisFrame` is what `runPassPlan` actually
    // invoked on the most recent frame; `skipped` names every pass in
    // range that is NOT live yet (seam/future), with its status, so a
    // pass that should have started running (a status flip in
    // passes.js with no code behind it) shows up here as a thrown error
    // instead of silently staying in `skipped`.
    framePlan: _active?.getFramePlanInfo?.() ?? { available: false },
    // frame.snapshot's res:env third, live every frame — time/sun/
    // darkness as measured facts. `status:'future'` is honest: res:view/
    // res:scene are not built, so the DECLARED pass is not fully live
    // even though this reading genuinely is.
    envSnapshot: _active?.getEnvSnapshotInfo?.() ?? { available: false },
    // PILLAR 11 — MSA's own vision/fog mask. Reports the rasteriser's health
    // (pooled/drawn/gating) SEPARATELY from `owningVision` (is the composite
    // actually reading it), because "works but not wired in" and "wired in but
    // draws nothing" are opposite problems one boolean would collapse into an
    // indistinguishable "off" (`feedback_instruments_must_not_lie`).
    visionMask: _active?.getVisionMaskInfo?.() ?? { available: false },
    // masks.occlusion (2026-07-18) — see graph/passes.js's own note for
    // the RADIAL-only scope. `elevationTable` should read something
    // other than [-Infinity] whenever an occludable token is on screen.
    occlusion: _active?.getOcclusionMaskInfo?.() ?? { available: false },
    // light.accumulate's point-light rung (2026-07-18) — see
    // graph/passes.js's own note for the illumination-only scope.
    // `activeLights` should be > 0 whenever the scene has torches/
    // lamps within the current view.
    pointLights: _active?.getPointLightsInfo?.() ?? { available: false },
    // APERTURE GOBO (2026-08-03, docs/planning/Aperture-Gobo.md) — apertures
    // found/dropped/lit-lights as of the point-light pool's last update().
    // `available: false` means the viewer itself never started (there is no
    // `_active` at all) — a genuinely running viewer always has this method,
    // even when the effect is disabled or no light has a nearby window.
    apertureGobo: _active?.getApertureGoboInfo?.() ?? { available: false },
    // region-driven darkness (2026-07-19) — see graph/passes.js's own
    // note. `activeRegions` should be > 0 whenever a darkness-
    // adjusting region is on screen.
    regionDarkness: _active?.getRegionDarknessInfo?.() ?? { available: false },
    // THE WATER BODY PACK (2026-07-26, docs/planning/Water.md §5.1) — the
    // jump-flood distance field. Read `bakes` against `polls` FIRST: they
    // must NOT track each other (see getWaterBodyInfo's own doc for why that
    // comparison is this phase's whole exit criterion). `resolve.floorIndex:
    // null` means no floor has an authored water mask — not an error.
    waterBody: _active?.getWaterBodyInfo?.() ?? { available: false },
    // THE CURRENT CAMERA'S WORLD RECT (2026-08-17) — any diagnostic that
    // samples points must intersect against THIS, not a baked body's own
    // (possibly much larger) world AABB, or every sample off-camera reads as
    // a false zero instead of "not measured" (see water-health's own coverage
    // sweep, which shipped this exact bug its first time out).
    viewWorldRect: _active?.getViewWorldRect?.() ?? null,
    // SHINE (2026-07-26, docs/planning/Specular.md) — tiers 0-3. Read
    // `maskImage` FIRST: 'not loaded' means the viewed floor has no authored
    // specular file at all, so the effect is inert BY DESIGN and nothing below
    // it matters. `outdoorsGate`/`floorGate` report which branches actually
    // COMPILED, and both are silent on screen if they did not.
    specular: _active?.getSpecularInfo?.() ?? { available: false },
    // WINDOW LIGHT (2026-07-27, docs/planning/Windows.md) — tier 0. Read
    // `maskImage` FIRST: 'not loaded' means the viewed floor has no authored
    // `_Window` file at all, so the effect is inert BY DESIGN. `floorGate`
    // reports whether that branch actually COMPILED — silent on screen if it
    // did not.
    windowLight: _active?.getWindowLightInfo?.() ?? { available: false },
    // FLUID (2026-07-27, docs/planning/Fluid.md) — one entry per masked ITEM
    // (a tile, not a floor — see `fluid-registration.js`'s own header for the
    // bug that cost two rounds). `maskedItemCount: 0` alongside a nonzero
    // authored-mask count in boot's `fluid` report means the FLOOR FILTER
    // rejected the item; `tubeCount: 0` on an item that DID bake means the
    // mask's red channel produced no components.
    //
    // ⚠️ This field was ABSENT for the effect's first live test — `getFluid
    // Status` existed on `_active` (vt-pan-viewer.js) but nothing here called
    // it, so `boot.js`'s report read `surface: null` even while the tubes
    // rendered correctly on screen. The instrument was silently disconnected
    // from the thing it was reporting on, one link short of the pattern
    // `waterBody`/`specular` both already establish immediately above.
    fluid: _active?.getFluidStatus?.() ?? { available: false },
    // SHADERS (docs/planning/Shaders.md).  is the fork
    // in the road, not a detail: WITH it, compileAsync hands work to driver
    // threads; WITHOUT it, compileAsync resolves instantly having done
    // nothing and the compile stalls the first useProgram instead. This
    // project does not guess about extensions on the design-floor GPU.
    shaders: {
      parallelShaderCompile: !!renderer.backend?.extensions?.get?.('KHR_parallel_shader_compile'),
      precompileMs: shaderCompileMs,
      // THE WARM-UP DRAW (vt-pan-viewer.js#warmUpDrawState) — the follow-up to
      // precompileMs that reaches the seven scenes/post-passes compileAsync(
      // scene, camera) cannot: depth, candle, wind overlay, specular, particle/
      // gust, doors, and present itself. `warmUpPipelinesCreated` is the direct
      // evidence it did real work rather than nothing — a run that creates 0
      // new pipelines on a scene with real effects in it is a red flag, not a
      // clean bill of health (a scene with genuinely nothing to warm reads the
      // same as a warm-up that silently failed to reach anything, which is why
      // this is reported as a number rather than a boolean "ran").
      warmUpMs,
      warmUpPipelinesCreated,
      // Program COUNT is the thing that explodes as effects land (N effects x
      // M variants), so it is watched from the start. Identical ShaderMaterial
      // source shares ONE program (three.module.js:36407 keys the cache on
      // source identity), so today every item mesh costs 1 program between them.
      // renderer.info.programs is WebGLRenderer-only; the node renderer
      // reports differently. Left null rather than guessing a number.
      programCount: renderer.info?.programs?.length ?? null,
      backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2',
    },
    // GROUND TRUTH: is MSA the thing on screen right now, or is Foundry?
    // This could NOT be answered from a report during the 2026-07-16
    // non-square incident — the diagnostics described MSA's internals in
    // detail while saying nothing about whether any of it reached the
    // display. Read from the DOM, not from intent.
    ...describeRenderMode({ canvas, loopActive }),
    // Non-zero = at least one pack could not afford its speculative tier this
    // update. A few is healthy self-limiting; ALL of them, every update,
    // means the required working set itself is at the budget.
    prefetchSkippedPacks,
    // DOES A DOCUMENT CHANGE REACH THE SCREEN? Three counters that make
    // the three candidate causes distinguishable in ONE report — see
    // `lastUpdate`'s declaration for the decision table. Move a token,
    // do NOT pan, then read this.
    documentSync: {
      ...lastUpdate,
      totalPasses: passSeq,
      // Newest last. `docRefreshes` counts HOOK FIRINGS; `totalPasses`
      // counts REAL updateResidency() executions — hooks firing back-to-
      // back synchronously (exactly what two movement segments' paired
      // updateToken+moveToken do) coalesce into fewer passes via
      // scheduleResidencyUpdate's do-while. The two numbers disagreeing is
      // NORMAL, not a bug on its own.
      passLog: tokenPassLog,
      interpretation:
        'Move a token WITHOUT panning, then read these. `byHook` names WHICH hooks drove a ' +
        'refresh. `passLog` is the decisive one for a REMAINING mismatch: it is one row per ' +
        'token per REAL pass (not per hook — see totalPasses vs docRefreshes above). Find the ' +
        "moved token's id in passLog: if its LAST row already equals liveVsRendered.live{X,Y} " +
        'for that item in drawList, MSA is caught up and any on-screen lag is the render not ' +
        'having painted a new frame yet, not a stale read. If its last row does NOT match, and ' +
        'a SECOND report (taken a few seconds later, nothing else touched) shows no NEW row for ' +
        'that id, no further pass is even being attempted — Foundry is not telling us. If a ' +
        'later report DOES add a new, correct row, this is TRANSIENT lag under cache pressure ' +
        '(cross-reference cacheStats.freePages and layerResidencyTotals.coarsePinShortfall — ' +
        'both nonzero means the cache is already oversubscribed and streaming the moved-to ' +
        'position can legitimately take a beat).',
    },
    canvasSizePx: { width: canvasW, height: canvasH },
    // The pixel-ratio-parity fix (2026-07-19): drawBufSizePx is what the
    // world quad actually renders/samples at; it now legitimately
    // differs from canvasSizePx whenever pixelRatio > 1. If they ever
    // look wrong together, this is the first thing to check.
    drawBufSizePx: { width: drawBufW, height: drawBufH },
    pixelRatio,
    mountedInBoard: mount.fill && mount.host !== document.body,
    cacheStats: cache.stats(),
    // WHOLE-IMAGE MODE STATE — the primary instrument for the "load images
    // like PIXI" path (2026-07-17). Read this FIRST when the new path
    // misbehaves: it names, per item, exactly what happened.
    wholeImage: summarizeWholeImage({ itemStates, textureLimit, alphaGridStats, sunShadows, envLight }),
    drawList,
    // Empty = every token matches its live document right now (the good
    // state). Non-empty names exactly which tokens are behind and by how
    // much, without reading the full (potentially long) drawList by eye.
    tokenSyncSummary,
    itemsLoaded: itemStates.size,
    world,
    // Multi-LAYER (Keyhole §4.1, the mask pile-up killer): which layer is
    // currently displayed, the packs loaded on the viewed floor, and the
    // per-(floor×pack) residency breakdown + its totals — the evidence
    // that every mask coexists with albedo inside the ONE fixed cache.
    displayLayer: displayLayerName,
    sampleItemLayers: sampleState ? Array.from(sampleState.packs.keys()) : [],
    layerResidency,
    // Why any mask is missing from layerResidency — 404 (not synced to the
    // Foundry server) vs a decode/other error. Empty = every layer loaded.
    layerLoadErrors,
    layerResidencyTotals: {
      packs: layerResidency.length,
      coarsePinnedPages: totalCoarsePinned, // GROUND TRUTH — actually resident, not just requested
      coarseIntendedPages: totalCoarseIntended, // what was ASKED for (pack.coarsePages.length summed)
      // Must be 0 — any shortfall means a coarse-pin request failed under
      // pressure, i.e. some page has NO resident fallback at any mip
      // (renders magenta, not blur). See updateResidency's phase-1/
      // phase-2 comment for the exact bug this tripwire caught.
      coarsePinShortfall,
      viewResidentPages: totalViewResident,
      residentPages: cache.stats().residentPages,
      capacityPages: cache.stats().capacityPages,
    },
    // THE SCENE-WIDE COARSE BUDGET (item 1b, 2026-07-17) — what every
    // pack's coarse-pin request is capped against, and why. Fixes a
    // real 3-floor scene that measured coarseIntendedPages:808 against a
    // 246-page shortfall, freePages:0, and a 2.6s frame freeze — nothing
    // was dividing "~tens of pages total" (§4.1) by how many packs the
    // scene actually had.
    coarsePinBudget: {
      ...currentCoarseBudget,
      // GROUND TRUTH for whether the reserve is actually holding —
      // check THESE two, not the interpretation text below. The first
      // cut (capping what each pack ASKS for) landed alone and still
      // measured a real 81-page shortfall on the author's scene: it
      // capped the ask but never reserved the ROOM, so a busy viewport
      // could still pin the whole cache with 'view' pages before a
      // background pack's coarse request got a turn. cacheStats below
      // is where that second half (page-cache.js's coarseReservePages)
      // actually lives.
      cacheReserveCheck: {
        coarseReservePages: cache.stats().coarseReservePages,
        coarseReserveMisses: cache.stats().coarseReserveMisses,
        interpretation:
          'coarseReserveMisses should read 0 — the reserve is specifically what makes a coarse-pin ' +
          'miss structurally impossible (page-cache.js). If nonzero, the reserve itself is undersized ' +
          'or was not set before some pack requested its coarse pin — a real bug, not routine pressure.',
      },
      interpretation:
        `Every new pack's coarse pin is capped at perPackMaxPages (currently ` +
        `${currentCoarseBudget.perPackMaxPages}), so the SUM across all ${currentCoarseBudget.packCount} ` +
        `packs in the scene stays at or under totalBudgetPages (${currentCoarseBudget.totalBudgetPages}) — ` +
        `a fixed fraction of capacityPages, not a per-pack allowance nobody was adding up. That caps the ` +
        'ASK; cacheReserveCheck (above) covers the ROOM — page-cache.js reserves totalBudgetPages worth ' +
        "of slots that 'view' requests may never claim, so a busy viewport can't fill the whole cache " +
        "before a background pack's coarse request gets a turn. The tradeoff: a pack that would have " +
        'gotten more (a big Level background, previously ~82 pages) now gets less when many packs share ' +
        'the scene, AND the view tier itself now has less room at its OWN peak (it can no longer ever ' +
        'claim the pages reserved for coarse) — both a softer coarse/blurred fallback and slightly less ' +
        'peak view-tier sharpness under heavy pan/zoom, traded for the shortfall/freeze going away. Tune ' +
        'coarseBudgetFraction (residency.js, default 0.25) if that tradeoff feels wrong.',
    },
    // Decode-memory proof (the Bush-failure fix): heldSources is the peak
    // number of full 576MB source bitmaps alive at once — bounded by the
    // semaphore, NOT by layers×floors. idbHits climbing vs idbSlices means
    // pages are being served from IndexedDB (no source re-decode).
    decodeStats: getDecodeStats(),
    // Multi-floor compositing (§ header note): which OTHER floors are
    // ALSO being rendered alongside the current one this update. Derived
    // from the draw list rather than tracked separately: an item knows
    // which levels it is visible on, so the composited set is a fact about
    // the list, not a second piece of state that can disagree with it.
    compositedLevelIds: Array.from(new Set(lastItems.flatMap((i) => i.visibleOnLevelIds ?? []))),
    currentFloorResidentCount: albedo?.residentViewKeys.size ?? 0,
    // Multi-mip state (coarse-fallback gate evidence): the finest mip
    // being tried this view, the floor's top-level, its coarse-pin depth
    // + page count, and the packed-pyramid indirection dimensions (all
    // for the DISPLAYED pack).
    mip: {
      requested: sampleState?.vt?.uniforms.requestedMip.value ?? null,
      // 1 = the sRGB decode is live. Still-washed-out + 0 here = the fix never bound.
      srgbDecode: sampleState?.vt?.uniforms.srgbDecode.value ?? null,
      // Smooth mip blending (2026-07-16): the fractional companion to
      // `requested` — its integer part MUST equal `requested`; its
      // fractional part is the blend weight toward `requested+1`. If
      // these ever disagree, the blend uniform desynced from the walk's
      // starting mip — flag it.
      requestedFraction: sampleState?.vt?.uniforms.requestedMipFrac.value ?? null,
      max: sampleState?.vt?.uniforms.maxMip.value ?? null,
      coarseTopMips: albedo?.coarseTopMips ?? null,
      coarsePinnedPages: albedo?.coarsePages.length ?? null,
      indirectionPyramid: albedo ? `${albedo.width}x${albedo.height}` : null,
    },
    renderMsAvgLast120: Math.round(avgMs * 100) / 100,
    // GPU PROBE (2026-07-20) — real GPU execution ms per frame, the number
    // renderMsAvgLast120 (CPU command-encode only) is structurally blind to.
    // `active:false` when idle (the perf lab flips it on for a sweep); a null
    // median with active:true means "measuring, no completed sample yet" — it
    // never reads as 0ms (instruments must not lie). See diag/gpu-probe.js.
    gpuProbe: gpuProbe.getStats(),
    // HITCH STATS (2026-07-16) — the true "did we freeze" signal,
    // distinct from renderMsAvgLast120 above (which only measures
    // render()'s own duration, never a stall elsewhere on the single JS
    // thread that delays the NEXT frame from running at all). Non-empty
    // recentHitches with a real gapMs is direct, ground-truth evidence
    // of an actual main-thread block — see runZoomThrashTest for a
    // dedicated, repeatable way to trigger and capture these.
    hitchStats: {
      frameGapAvgMs:
        frameGapTimes.length > 0
          ? Math.round((frameGapTimes.reduce((a, b) => a + b, 0) / frameGapTimes.length) * 10) / 10
          : null,
      frameGapMaxMs: frameGapTimes.length > 0 ? Math.round(Math.max(...frameGapTimes) * 10) / 10 : null,
      // PERCENTILES (2026-07-18) — added for the infrastructure menu's
      // baseline-capture report (Track 2, item 5): avg/max alone hide
      // whether a session was smooth-with-one-spike or consistently
      // choppy. Computed from a SORTED COPY of the same rolling window
      // avg/max already read — no new sampling, no new clock (this
      // report only runs on demand, not per frame, so sorting ≤300
      // numbers here is free).
      frameGapP50Ms: percentileMs(frameGapTimes, 0.5),
      frameGapP95Ms: percentileMs(frameGapTimes, 0.95),
      frameGapP99Ms: percentileMs(frameGapTimes, 0.99),
      frameGapSampleCount: frameGapTimes.length,
      hitchThresholdMs: HITCH_THRESHOLD_MS,
      hitchCount: hitchLog.length,
      recentHitches: hitchLog.slice(-10),
    },
    lastError,
    ...sampleDiagnostics(sampleState?.packs.get(displayLayerName) ?? albedo),
    // Camera smoothing (2026-07-16): live state of the held-key pan /
    // eased-zoom system — the first thing to check if panning ever
    // seems stuck (heldPanKeys non-empty with no key actually held is
    // exactly the "stuck key" class clearHeldKeys guards against) or
    // zoom never settles (targetHalfSpanPx should converge toward
    // mip.requestedFraction's implied value, not sit far from it forever).
    continuousInput: {
      heldPanKeys: Array.from(heldPanKeys),
      panVelocity,
      targetHalfSpanPx,
      currentHalfSpanPx: view.halfSpanPx,
    },
    controls:
      'Drag to pan, wheel to zoom (native Foundry feel, now eased). Also: Arrow keys/WASD pan (continuous while held), +/- zoom, 0-2 or Tab floor-switch (keys work anywhere, not in a text field).',
  };
}
