/**
 * WALL-CLIPPED POLYGON FOR NON-DOCUMENT POINTS — reuses Foundry's OWN
 * `ClockwiseSweepPolygon` (the exact algorithm every real `AmbientLight`'s
 * `source.shape.points` already comes from, per foundry/scene-lights.js's
 * own header) to compute a wall-aware light shape for a point that is NOT
 * a real Foundry document — MSA's own candle lights
 * (effects/candle-flame-render.js), placed via the anchor system rather
 * than authored as AmbientLight placeables.
 *
 * WHY THIS EXISTS: `candleCirclePolygon()` (candle-flame-render.js) is a
 * naive circle — position + radius only, zero wall awareness. Confirmed
 * live 2026-07-20: candle light visibly bled straight through a solid
 * wall in the author's own scene (screenshot). Foundry's own light
 * sources already solve exactly this problem; reusing their machinery
 * (rather than hand-rolling a second wall-clipping algorithm) is the
 * `foundry/adapter-only` doctrine applied directly — trust Foundry's own
 * geometry, don't reinvent it.
 *
 * THE `level` REQUIREMENT — verified against source (a dedicated research
 * pass, not guessed), because getting this wrong either crashes or
 * silently mis-clips on any map using per-floor wall scoping:
 *   - A REAL Foundry `Level` DOCUMENT is required, not optional or
 *     synthesizable. `ClockwiseSweepPolygon#_identifyEdges` (the step that
 *     gathers candidate walls at all) reads `this.level.edges.getEdges(...)`,
 *     and `Level#edges` is a real `CanvasEdges` instance whose constructor
 *     throws on anything else (`client/canvas/geometry/edges/edges.mjs`).
 *   - Which walls belong to which Level is decided by each WALL's own
 *     `levels` field (`common/documents/wall.mjs`) — EMPTY (the common
 *     default) means "every Level"; explicit means "only these". So an
 *     ordinary map with no per-floor wall scoping would tolerate a wrong
 *     `level` silently; a map that DOES scope walls per floor would not —
 *     worth doing correctly from the start rather than "works on my test
 *     map."
 *   - Foundry's own `canvas.level` ("the currently viewed Level") is NOT the
 *     PRIMARY source here. MSA's own floor switch (`vt-pan-viewer.js#
 *     setFloorIndex`) does NOT call Foundry's real `Scene#view()` and does
 *     NOT update `canvas.level` — calling `Scene#view()` on a same-scene
 *     floor change previously caused a `canvasReady`-triggered reset to
 *     floor 0 plus a full GPU-atlas reallocation (a real, previously-fixed
 *     bug). So `canvas.level` can legitimately point at a DIFFERENT floor
 *     than the one MSA is actually rendering, ON A GENUINELY MULTI-FLOOR
 *     SCENE. The caller passes the real Level id for MSA's OWN current
 *     floor (`vt-pan-viewer.js` computes this via `getActiveSceneFloors()`
 *     for region-darkness elevation filtering — `readElevationFiltered
 *     DarknessRegions()`'s own `currentFloor`, reused here rather than
 *     re-derived) as the PREFERRED source.
 *   - **`canvas.level` IS used as a fallback** (2026-07-20, live-reported:
 *     candle wall-clipping silently did nothing on an ordinary scene) —
 *     `getActiveSceneFloors()` scopes "floor" to "has ITS OWN renderable
 *     background art"; an ordinary scene using Foundry's plain scene-level
 *     background image (no per-Level art authored, the common case) never
 *     matches that and synthesizes a non-Foundry `id:'legacy'`, which
 *     `canvas.scene.levels.get()` correctly fails to resolve. Every scene
 *     still has a real, resolvable Level underneath regardless of whether a
 *     GM ever touched multi-floor authoring — falling back to `canvas.level`
 *     in exactly THIS position is safe, because it only fires when MSA's own
 *     tracked floor id came up empty, i.e. there is no genuine multi-floor
 *     authoring for this scene to drift out of sync with in the first place.
 *
 * Never throws — a live Foundry API surprise (a legacy scene with no real
 * Level schema, a level not yet initialized, anything) must never take a
 * render frame down with it, same reasoning as every other `read*`/
 * `compute*` function in this adapter. `points: null` means "fall back to
 * the existing naive circle", never a crash or a missing light.
 *
 * @module foundry/scene-wall-clip
 */

/**
 * The `ClockwiseSweepPolygonConfig` for a candle-shaped light — everything
 * EXCEPT `level` (the caller's job; see this module's header). Pure and
 * deterministic given `radius`, so it's the one piece of this module worth
 * Node-testing directly.
 *
 * `useThreshold: true` matches real point lights
 * (`point-light-source.mjs#_getPolygonConfiguration`) for parity; `angle:
 * 360` (omnidirectional) and `rotation: 0` since candles have no facing.
 *
 * @param {number} radius - pixel radius (already resolved, not grid units).
 * @returns {object} a config object, missing only `level`.
 */
export function buildCandleWallClipConfig(radius) {
  return {
    type: 'light',
    edgeTypes: { wall: true },
    radius,
    externalRadius: 0,
    angle: 360,
    rotation: 0,
    priority: 0,
    useThreshold: true,
  };
}

/**
 * Compute the flat `[x0,y0,x1,y1,...]` polygon points Foundry's own
 * `ClockwiseSweepPolygon` produces for a wall-clipped light-shaped area at
 * `(x,y,radius)` on a specific level — the SAME shape shape
 * `foundry/scene-lights.js#deriveLightSnapshot` already expects on
 * `shapePoints` for a real light, so this is a drop-in replacement for
 * `candleCirclePolygon`'s own output.
 *
 * @param {object} args
 * @param {number} args.x @param {number} args.y @param {number} args.radius
 * @param {string} args.levelId - MSA's own tracked real-floor Level document
 *   id (see this module's own header) — preferred, but falls back to
 *   `canvas.level` when it doesn't resolve (the "legacy floor" case, an
 *   ordinary non-multi-floor scene — see the `levelSource` fallback logic
 *   inline, added 2026-07-20 after this fell back to the naive circle on
 *   every ordinary scene).
 * @returns {{points: number[]|null, source: 'sweep'|'fallback', reason: string}}
 *   `points === null` (source:'fallback') means the caller should keep
 *   using its existing naive-circle shape for this frame — never a crash,
 *   never a light that silently vanishes. `reason` is always populated
 *   (including on success, carrying which level-resolution path was used —
 *   feedback_instruments_must_not_lie), never null.
 */
export function computeCandleWallClippedShape({ x, y, radius, levelId }) {
  try {
    if (typeof canvas === 'undefined' || !canvas?.scene) {
      return { points: null, source: 'fallback', reason: 'no active scene (canvas.scene is absent)' };
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(radius > 0)) {
      return { points: null, source: 'fallback', reason: 'non-finite position or non-positive radius' };
    }
    // THE "LEGACY FLOOR" FALLBACK (2026-07-20, live-reported: candle wall-
    // clipping silently did nothing on an ordinary, non-multi-floor scene).
    // `foundry/active-scene-source.js#getActiveSceneFloors` — the function
    // `levelId` was derived from — scopes "floor" to "has ITS OWN renderable
    // background art"; a normal scene using Foundry's plain scene-level
    // background image (no per-Level art authored) synthesizes `id:'legacy'`
    // for that one floor (that function's own header: "no Level document to
    // read a band from"). `'legacy'` is NOT a real Foundry Level document
    // id, so `canvas.scene.levels.get('legacy')` correctly returns nothing —
    // the bug was trusting that lookup as the ONLY path. Every Foundry scene
    // still has a real, resolvable Level underneath regardless of whether a
    // GM ever touched multi-floor authoring (confirmed live: real point
    // lights wall-clip correctly on exactly this kind of scene, because
    // Foundry's OWN internal resolution never goes through MSA's art-scoped
    // floor list at all — `base-effect-source.mjs`: `canvas.scene.levels.get
    // (canvas.level.id)`). Falling back to `canvas.level` here — the SAME
    // "currently viewed Level" getter this module's own header says NOT to
    // trust for multi-floor scenes — is safe SPECIFICALLY in this fallback
    // position: it only fires when MSA's OWN tracked floor id came up empty,
    // i.e. no genuine multi-floor authoring exists for this scene to drift
    // out of sync with in the first place. The drift risk only applies to
    // scenes that DO have real, multiple, art-bearing Levels — exactly the
    // case where `levelId` resolves directly and this branch never runs.
    let level = typeof levelId === 'string' ? canvas.scene.levels?.get(levelId) : null;
    let levelSource = 'trackedFloor';
    if (!level) {
      level = canvas.level ?? null;
      levelSource = 'canvasLevelFallback';
    }
    if (!level) {
      return {
        points: null,
        source: 'fallback',
        reason: `no real Level document for levelId "${levelId}", and canvas.level is also unavailable`,
      };
    }
    const PolygonClass = typeof CONFIG !== 'undefined' ? CONFIG.Canvas?.polygonBackends?.light : null;
    if (!PolygonClass) {
      return { points: null, source: 'fallback', reason: 'CONFIG.Canvas.polygonBackends.light is unavailable' };
    }
    const config = { ...buildCandleWallClipConfig(radius), level };
    const polygon = PolygonClass.create({ x, y }, config);
    const points = Array.isArray(polygon?.points) ? Array.from(polygon.points) : null;
    if (!points || points.length < 6 || points.length % 2 !== 0 || !points.every(Number.isFinite)) {
      return {
        points: null,
        source: 'fallback',
        reason: `ClockwiseSweepPolygon returned a degenerate shape (<3 vertices, or non-finite) — level via ${levelSource}`,
      };
    }
    // `reason` carries `levelSource` even on SUCCESS (feedback_instruments_
    // must_not_lie) — a scene silently living entirely on the canvasLevel
    // fallback is worth being able to see, not just infer from the absence
    // of a failure.
    return { points, source: 'sweep', reason: `level via ${levelSource}` };
  } catch (err) {
    return { points: null, source: 'fallback', reason: `ClockwiseSweepPolygon.create threw: ${err?.message ?? err}` };
  }
}
