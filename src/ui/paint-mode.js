/**
 * PAINT MODE — the browser half of the in-app painter (UX + feature pass).
 *
 * A modal AUTHORING surface (map-maker, opt-in). The overlay is VISUAL ONLY
 * (`pointer-events: none`); input is captured at the window in the capture
 * phase so that:
 *   - LEFT        → paint (brush) or place a vertex (point/line/polygon tools)
 *   - RIGHT-drag  → Foundry pans NATIVELY (we don't touch it — confirmed
 *                   against source: board.mjs's `_onDragRightStart` is
 *                   Foundry's OWN canvas-pan handler, distinct from
 *                   `_onDragLeftStart` used for placeable/selection input)
 *   - WHEEL       → Foundry zooms NATIVELY (we don't touch it)
 * LEFT paints because that is the primary-action button in every paint tool
 * (and in Foundry itself); RIGHT was tried first (2026-07-20) and reported
 * broken navigation — it was capturing Foundry's actual pan gesture, not a
 * free button. Swapped the same day.
 *
 * Never touches the gameplay input path beyond suppressing the LEFT button
 * while active (keyhole-input-model-decision: Foundry owns gameplay input;
 * this is authoring, and it un-suppresses on exit). The right button and its
 * context menu are never touched — Foundry owns its own pan/menu handling.
 *
 * UI PASS-THROUGH (2026-07-20 fix): a stroke starts ONLY when the press
 * target is Foundry's own board canvas (`ctx.boardElement`, foundry/paint-
 * adapter.js) — a positive match against the one element that IS the map.
 * The bug this replaces: the window-capture listener checked only the mouse
 * button, so a left-click on the TOOLBAR (or the debug panel, or Foundry's
 * own sidebar/hotbar) still resolved a screen position and painted through
 * it. A hand-excluded list of "not the toolbar" would have fixed the report
 * but kept missing every other panel; checking FOR the board is the one
 * check that can never miss the next one.
 *
 * Pure model/brush/codec/persistence: scene/paint-mask.js (Node-tested).
 * All Foundry/PIXI access: foundry/paint-adapter.js. This file is DOM glue,
 * verified live.
 *
 * SCOPE: any authored mask kind (dropdown), PER-FLOOR masks (a Floor stepper —
 * paint on floor N only ever touches floor N, AND drives the live 3D view to
 * floor N via vt/'s own `setVtPanViewerFloor` — the same cheap residency-only
 * path Foundry's native floor navigation already uses, not a fresh reinvention;
 * mask editing itself never depends on that call succeeding), a 4096² grid with
 * a dirty-rect preview (re-packs only what changed), embed persistence with an
 * unsaved-changes guard (on close, on effect switch, AND on a scene load — see
 * `hydrateFromScene`, which never overwrites unsaved work), a spray/paint/erase
 * brush, AND the Author-Mode vector tools — point / line (stroked) / polygon
 * (filled) — all rasterizing into the SAME mask the brush writes
 * (Shapes-and-Regions.md), with an optional 4×4 sub-grid snap, per-layer undo,
 * and a live draft preview. Deferred: retained/editable vector shapes + a
 * Select tool, the package gate.
 *
 * MSA READY (2026-11-01, author: "add tools for quickly painting shapes which
 * can be snapped to the grid ... let the painting tool see a version of the
 * scene with effects turned off ... save a full resolution version of the mask
 * ... re-upload ... alongside the map albedo"):
 *   - Rectangle, Grid cells and Fill room tools; snapping Off / ¼ grid / whole
 *     grid (Foundry's own snapper, so hexes work).
 *   - Every edit is ALSO recorded as a world-space op (`scene/mask-ops.js`), so
 *     "Save next to map" / "Download" can draw the mask at the map art's own
 *     pixel size with sharp shape edges (`ui/mask-file-actions.js`). The history
 *     rides in the scene flag beside each layer's grid (`ops`), compacted when big.
 *   - A layer whose floor already HAS a file for its kind opens FROM that file
 *     (`ensureSeeded`) — so a Save next to map can never overwrite a Photoshop
 *     mask with only the strokes painted on top of it.
 *   - `_Outdoors` paints Indoors (black) / Outdoors (white), starts all
 *     outdoors, offers Start from walls, and its preview tints the INDOOR part.
 *   - Clean view: Foundry's plain map art under the overlay (boot.js owns the
 *     switch — `deps.setCleanView`), with an overlay opacity slider.
 *
 * ⚠️ PAINT → RENDER, ON SAVE (2026-08-18) — "paint fire, see fire" is now
 * genuinely true, on Save. `deps.onLayersChanged` (see `installPainter`'s
 * own param doc) hands boot.js the live layer set, which feeds
 * `scene/mask-authority.js#ingestPaintedMask` — the door that file's own
 * header used to name as two-doors-only (file discovery, VT decode) before
 * this. NOT yet live mid-stroke, before Save: that would mean hooking the
 * per-frame preview loop (`paint-mode-canvas.js#loop`, tuned for cheap
 * dirty-rect-only repaints) rather than the already-explicit Save action, a
 * real, separate, higher-risk follow-up — named, not silently claimed.
 *
 * @module ui/paint-mode
 */

import {
  createPaintLayer,
  stampBrushWorld,
  rasterizePolygon,
  rasterizeStrokedLine,
  serializePaintedMasks,
  hydratePaintedMasks,
  encodedByteEstimate,
  isPaintLayerEmpty,
  PAINT_EMBED_BYTE_BUDGET,
  MASK_KINDS,
  applyOp,
  seedFromGrid,
  fileSeed,
  compactOps,
  isValidOpList,
  rectPoints,
  roomCoverFromWalls,
} from '../scene/index.js';
import {
  readPaintContext,
  savePaintedMasks,
  loadPaintedMasks,
  readFloorWalls,
  readMaskFileToGrid,
} from '../foundry/index.js';
import { saveMaskFileFlow, downloadMaskFlow, importMaskFlow } from './mask-file-actions.js';
import { setVtPanViewerFloor } from '../vt/index.js';
// The painter's DOM chrome + preview renderer, split out 2026-07-25 (the
// size-ratchet god-object reversal — this file was 1,083 lines / an 867-line
// installPainter). Each is a factory bound to the SAME `state` object below,
// so the moved bodies still close over exactly what they always did.
import { createConfirmModal } from './paint-mode-widgets.js';
import { createPaintCanvas } from './paint-mode-canvas.js';
import { createToolbar } from './paint-mode-toolbar.js';

const UNDO_LIMIT = 10; // at PAINT_GRID_MAX_DIM=4096 each undo snapshot is ~16MB — keep the stack bounded

/** Authored (paintable) kinds only — derived products (skyReach…) have no suffix. */
const PAINTABLE_KINDS = MASK_KINDS.filter((k) => Array.isArray(k.suffixes) && k.suffixes.length > 0);

/**
 * @param {object} MapShine
 * @param {object} [deps]
 * @param {(floorIndex:number)=>void} [deps.onFloorChanged] - told AFTER the
 *   Floor stepper moves, win or lose on the live-view follow. `setVtPanViewerFloor`
 *   is `vt/`'s own residency swap and knows nothing of boot.js's
 *   `activeFloorContext` — without this callback, fire/candle/lightning's
 *   floor-scoped reads and door scoping stayed pinned to whichever floor
 *   `canvasReady` last natively synced to while this stepper moved the
 *   painter (and the live view) on ahead of it (found live, 2026-08-12: fire
 *   kept burning on the floor below, the newly-painted floor's own region
 *   never ignited). Optional so tests/tools that construct the painter
 *   without a full boot() still work. Superseded for real callers by
 *   `onRequestFloorSwitch` below (2026-08-24) — kept as a fallback path only.
 * @param {(floorIndex:number)=>Promise<{ok:boolean,reason?:string}>} [deps.onRequestFloorSwitch] -
 *   boot.js's `switchToPreparedFloor` (2026-08-24) — the SAME prepare-then-
 *   commit sequence (progress bar, GPU pipeline warm-up, `reapplyAll`,
 *   `syncInterfaceSeam`, adjacent-floor prewarm) native Foundry floor
 *   navigation already gets, injected here so the Floor stepper stops being
 *   a second, partial reimplementation of it (see
 *   `feedback_direct_floor_switch_caller_skips_context_sync` for the last
 *   time that gap was found live). Falls back to a bare `setVtPanViewerFloor`
 *   call — today's behaviour — when absent, so tests/tools that construct
 *   the painter without a full boot() still work.
 * @param {(layersByKey: Record<string, import('../scene/mask-derive.js').MaskGrid>)=>void} [deps.onLayersChanged] -
 *   THE BRUSH→RENDER BRIDGE (2026-08-18) — told the CURRENT, COMPLETE
 *   in-memory layer set (every `"<kind>::<floor>"` key this painter knows
 *   about, painted-empty ones included) right after a successful `save()`
 *   makes it the scene's own authoritative content. boot.js's own consumer
 *   feeds each layer straight to `maskAuthority.ingestPaintedMask(floorIndex,
 *   kindId, layer)` — see that function's own doc for why a painted-empty
 *   layer is safe to re-ingest unconditionally (self-alpha composites it as
 *   a no-op) rather than this file needing to track and separately signal
 *   "was cleared". ⚠️ NOT fired from `hydrateFromScene()`'s own normal path
 *   — see that method's own doc for why (a scene-load ordering hazard); the
 *   caller reads `getLayers()` and calls the bridge itself there instead.
 *   The ONE exception is a LATE hydrate the author resolves by hand long
 *   after that hook finished (`applyHydrate(..., {announce:true})`), where
 *   the hazard cannot apply because `reset()` and the caller's own re-ingest
 *   have both already run and nothing else will feed the render. NOT
 *   called on every brush stamp either — see this module's own header for
 *   why live, mid-stroke ingest is a deliberately separate, not-yet-built
 *   follow-up.
 */
export function installPainter(
  MapShine,
  {
    onFloorChanged = null,
    onLayersChanged = null,
    onRequestFloorSwitch = null,
    // MSA READY (2026-11-01) — boot.js's answers the painter cannot work out
    // itself: where this floor's art and existing mask file are
    // (`getMaskFile(floorIndex, kindId)` → ui/mask-file-actions.js's
    // MaskFileInfo, or null), "a mask file was just written — find it"
    // (`onMaskFileWritten`), and the Clean view switch (`setCleanView(on)`).
    getMaskFile = null,
    onMaskFileWritten = null,
    setCleanView = null,
  } = {}
) {
  const state = {
    active: false,
    ctx: null,
    kind: PAINTABLE_KINDS[0]?.id ?? 'fire',
    layers: {}, // `${kind}::${floor}` -> MaskGrid
    // THE LAST-KNOWN-GOOD SNAPSHOT (2026-08-31). `layers` alone could never
    // answer "what is actually ON the scene?" — so "Discard & close" discarded
    // nothing (it only tore down the DOM, leaving the rejected edit in memory
    // to be swept into the NEXT unrelated Save) and there was no state to fall
    // back TO when a scene load arrived over unsaved work. This is a DEEP copy
    // (each layer's Uint8Array `.slice()`d; `spec` is an immutable descriptor
    // and is shared by reference), re-taken at exactly the two moments
    // `layers` becomes the scene's own truth: right after a successful save,
    // and right after a hydrate populates from the scene. `null` = never
    // established (a painter that has not hydrated or saved yet) — Discard
    // then falls back to today's just-close rather than throwing.
    committedLayers: null,
    // A scene load arrived while `layers` held unsaved work and was DEFERRED
    // rather than allowed to overwrite it (see `hydrateFromScene`). While true,
    // the in-memory layers are NOT this scene's authoritative content.
    pendingHydrate: false,
    floor: 0, // which floor these strokes apply to — masks are PER-FLOOR (the Floor stepper picks it)
    floorSwitching: false, // a live setVtPanViewerFloor call is in flight — buttons disable so rapid clicks can't retrigger the flagged rapid-floor-switch residency bug
    gridCanvases: {}, // key -> offscreen canvas
    gridImageData: {}, // key -> cached ImageData for that canvas (reused, not reallocated, per frame)
    // POOL HEALTH (cache-completeness pass, 2026-08-12) — incremented in
    // paint-mode-canvas.js#renderGrid, the actual read/write site (this file
    // only owns state; that one owns the draw loop). canvas* = the offscreen
    // canvas element itself; imageData* = the packed ImageData buffer, which
    // can miss on its own even when the canvas hit (a resize keeps the same
    // canvas element but needs a fresh ImageData sized to match).
    gridCachePoolStats: { canvasHits: 0, canvasMisses: 0, imageDataHits: 0, imageDataMisses: 0 },
    dirty: new Set(), // keys whose gridCanvas needs re-rendering
    previewRect: {}, // key -> {x0,y0,x1,y1} cell bounds changed since last render, or `true` for the whole grid
    dirtySinceSave: false, // any unsaved edits? drives the Save indicator + the close/switch guards
    modalOpen: false, // a confirm dialog is up — paint input pauses while it is
    overlay: null,
    canvas: null,
    toolbar: null,
    raf: 0,
    painting: false,
    pointerId: null, // the pointer whose capture this stroke holds (see `endStroke`)
    lastWorld: null,
    mouseClient: null,
    hoverOnBoard: false, // is the CURRENT hover over Foundry's board (not a UI panel)? gates the ring
    brush: { radius: 90, strength: 180, hardness: 0.55, mode: 'add' }, // mode: paint | add | erase
    tool: 'brush', // brush | point | line | polygon | rect | cells | room
    draft: null, // in-progress line/polygon/rect: { type, vertices: [{x,y}...] }
    // Vertex snapping: 'off' | 'quarter' (the old 4×4 sub-grid) | 'grid' (whole
    // grid corners). OFF by default (precision-first); the shape tools are what
    // 'grid' is for.
    snapMode: 'off',
    // THE WORLD-SPACE HISTORY (MSA Ready) — `${kind}::${floor}` -> op[]; see
    // scene/mask-ops.js. Recorded beside every grid edit, replayed full-size on export.
    ops: {},
    stroke: null, // the brush stroke op being recorded
    seeded: {}, // key -> true once `ensureSeeded` has decided this layer's starting point
    loading: {}, // key -> true while a mask file is being read into the grid
    fileBacked: {}, // key -> true while the grid equals its mask FILE (no draft to keep)
    cellsDone: null, // Set of cell keys painted this cells-drag
    cleanView: false,
    overlayOpacity: 0.5, // the map must read through the tint — Clean view is for SEEING the art
    busy: null, // a file action in flight: a short status string
    cursorWorld: null, // live cursor in world coords, for the rubber-band preview
    // UNDO IS PER-LAYER, NOT GLOBAL (2026-08-31): `${kind}::${floor}` -> snapshot[].
    // One flat stack meant Ctrl+Z popped whatever was pushed LAST — which could
    // belong to a floor or kind you are not looking at, so the screen did not
    // change and a stroke on another layer silently rolled back instead.
    undo: {},
    handlers: null,
    refreshToolbar: null,
  };

  const notify = (msg, type = 'info') => globalThis.ui?.notifications?.[type]?.(msg);
  const keyOf = (kind) => `${kind}::${state.floor}`;
  const activeKey = () => keyOf(state.kind);
  const kindDef = (kind) => PAINTABLE_KINDS.find((k) => k.id === kind) ?? null;

  function layerFor(kind) {
    const key = keyOf(kind);
    if (!state.layers[key]) state.layers[key] = createPaintLayer(state.ctx.sceneRect);
    return state.layers[key];
  }

  /** The active layer's history (created empty on first use). */
  function opsFor(key = activeKey()) {
    return (state.ops[key] ??= []);
  }
  function recordOp(op) {
    opsFor().push(op);
  }

  /** Snap a world point by the current snap mode. */
  function snapPoint(p) {
    if (state.snapMode === 'grid') return state.ctx.snapVertex(p.x, p.y);
    if (state.snapMode === 'quarter') return state.ctx.snapWorld(p.x, p.y);
    return p;
  }

  /**
   * DECIDE WHERE THIS LAYER STARTS (MSA Ready). Once per layer per painter
   * session:
   *   - it already has a history (from the scene flag) → keep it;
   *   - its floor has a mask FILE for this kind → read the file into the grid,
   *     then lay any older painted draft over it; the history starts with a
   *     file seed, so a full-size export reads the file itself;
   *   - an older draft with no history → its picture becomes the history;
   *   - a blank `_Outdoors` → all outdoors (white): the GM paints the buildings.
   */
  async function ensureSeeded(kind = state.kind) {
    const key = keyOf(kind);
    if (state.seeded[key] || !state.ctx) return;
    state.seeded[key] = true;
    const layer = layerFor(kind);
    if (state.ops[key]?.length) return;
    const info = getMaskFile?.(state.floor, kind) ?? null;
    const def = kindDef(kind);
    if (info?.existingUrl) {
      state.loading[key] = true;
      state.refreshToolbar?.();
      try {
        const draft = isPaintLayerEmpty(layer) ? null : seedFromGrid(layer, { over: true });
        const fromFile = await readMaskFileToGrid(info.existingUrl, layer.spec, def?.absentValue ?? 0);
        layer.data.set(fromFile);
        if (draft) applyOp(layer, draft);
        state.ops[key] = draft
          ? [fileSeed(info.existingUrl, layer.spec), draft]
          : [fileSeed(info.existingUrl, layer.spec)];
        if (!draft) state.fileBacked[key] = true;
      } catch (err) {
        state.seeded[key] = false; // let a later visit try again
        notify(
          `Map Shine: couldn't open the existing ${def?.suffixes?.[0] ?? kind} file (${err?.message || err}) — painting on top of nothing. Don't save over it.`,
          'warn'
        );
        state.ops[key] = isPaintLayerEmpty(layer) ? [] : [seedFromGrid(layer)];
      } finally {
        state.loading[key] = false;
        markFull(key);
        state.refreshToolbar?.();
      }
      return;
    }
    if (!isPaintLayerEmpty(layer)) {
      state.ops[key] = [seedFromGrid(layer)];
      return;
    }
    if (kind === 'outdoors') {
      layer.data.fill(255);
      state.ops[key] = [{ t: 'fill', v: 255 }];
      markFull(key);
      return;
    }
    state.ops[key] = [];
  }

  // ---- the committed snapshot -------------------------------------------
  /**
   * A DEEP copy of a layer set: every `Uint8Array` is `.slice()`d so the copy
   * and the original can never alias (a plain `{...layers}` would share the
   * one buffer the brush writes into, which is the whole point of the
   * snapshot — it would track the edits it exists to remember NOT tracking).
   * `spec` is a frozen-in-practice grid descriptor, never mutated, so it is
   * shared by reference rather than cloned per layer.
   * @param {Record<string, import('../scene/mask-derive.js').MaskGrid>} layers
   */
  function cloneLayers(layers) {
    const out = {};
    for (const [key, layer] of Object.entries(layers ?? {})) {
      if (!layer?.data) continue;
      out[key] = { spec: layer.spec, data: layer.data.slice() };
    }
    return out;
  }

  /** `layers` is now the scene's own truth — remember it as the discard target. */
  function snapshotCommitted() {
    state.committedLayers = cloneLayers(state.layers);
  }

  /**
   * Drop the offscreen preview canvas of every layer that is about to stop
   * existing (a discard or a scene load can retire keys wholesale). Without
   * this, a later layer re-created under the same key could be drawn from the
   * retired one's pixels.
   * @param {Record<string, unknown>} keep - the layer set that is replacing the current one.
   */
  function pruneGridCaches(keep) {
    for (const key of Object.keys(state.gridCanvases)) {
      if (keep[key]) continue;
      delete state.gridCanvases[key];
      delete state.gridImageData[key];
    }
  }

  /**
   * Throw away every edit since the last commit and go back to what the scene
   * actually holds. Returns false ONLY when there is no committed snapshot to
   * go back to (a painter that has never hydrated or saved) — the caller then
   * falls back to the pre-2026-08-31 behaviour of just closing.
   */
  function discardEdits() {
    // A DEFERRED scene load outranks the snapshot: the snapshot is the OLD
    // scene's committed state, the scene's own flag is this one's. Discarding
    // is exactly the moment to finally let that load through — and to tell the
    // render about it, since the caller's own post-reset re-ingest ran (on an
    // empty set, see `getLayers`) long before this.
    if (state.pendingHydrate && applyHydrate(undefined, { announce: true })) return true;
    if (!state.committedLayers) return false;
    const restored = cloneLayers(state.committedLayers);
    pruneGridCaches(restored);
    state.layers = restored;
    state.undo = {};
    state.previewRect = {};
    state.dirtySinceSave = false;
    for (const key of Object.keys(state.layers)) markFull(key);
    state.refreshToolbar?.();
    return true;
  }

  // ---- the extracted halves, bound to this painter's state ----------------
  // Order matters: the toolbar's callbacks include `markFull` (from the canvas
  // factory) and `confirmModal` (from widgets), so both must exist first. The
  // painter's own actions (setTool/save/undo/…) are function DECLARATIONS
  // below, hoisted, so naming them here is safe.
  const confirmModal = createConfirmModal(state);
  // markCells stays internal to the canvas module — only markWorldDisc/
  // markWorldRect (both there) ever call it; the painter itself never does.
  const { markFull, markWorldDisc, markWorldRect, loop } = createPaintCanvas(state, { activeKey });
  const buildToolbar = createToolbar(state, {
    setTool,
    changeFloor,
    save,
    undo,
    clearActive,
    requestExit,
    layerFor,
    markFull,
    activeKey,
    confirmModal,
    paintableKinds: PAINTABLE_KINDS,
    ensureSeeded,
    startFromWalls,
    startAllOutdoors,
    setCleanViewOn,
    saveToMapFile,
    downloadFile,
    importFile,
    fileSupportFor,
  });

  // Flip the unsaved flag on the first edit of a save-cycle (and refresh the
  // toolbar once on that transition — cheap, not per-stamp).
  function markEdited() {
    delete state.fileBacked[activeKey()]; // an edit makes this layer a draft again
    if (state.dirtySinceSave) return;
    state.dirtySinceSave = true;
    state.refreshToolbar?.();
  }

  // Masks are per-floor: keying by `state.floor` means paint on floor N only
  // ever touches the floor-N mask, and each floor's masks persist + travel
  // independently (Shapes-and-Regions.md / Authoring-and-Distribution.md).
  //
  // This ALSO drives the live 3D view to floor N (author ask: the stepper must
  // actually swap floors, not just retarget painting) via `onRequestFloorSwitch`
  // — boot.js's `switchToPreparedFloor`, the SAME prepare-then-commit sequence
  // (progress bar, GPU pipeline warm-up, `reapplyAll`, `syncInterfaceSeam`,
  // adjacent-floor prewarm) Foundry's own native floor navigation gets
  // (boot.js's canvasReady handler) — genuinely the same path now, not just a
  // comment claiming parity (2026-08-24: before this, this stepper called
  // `setVtPanViewerFloor` directly and skipped prepare/reapply/interface-seam
  // entirely — see `feedback_direct_floor_switch_caller_skips_context_sync`).
  // That call is best-effort: mask editing is authoritative regardless of
  // whether the live view can follow (feedback_safety_slide_outranks_doctrine
  // — painting must not depend on the renderer being up), so a failed/absent
  // viewer still lets you paint floor N's mask, just without the live picture.
  // A `{ok:false}` result (prepare superseded/cancelled, e.g. by a fast native
  // Foundry floor change racing this stepper) is treated the SAME way — not
  // an error, just proceed, matching the authoritative-painting posture. One
  // switch in flight at a time — rapid clicking floors is a KNOWN trigger for
  // a still-open residency bug (keyhole-device-loss-large-map.md); this is
  // ALSO what keeps `onRequestFloorSwitch`'s own internal generation counter
  // from ever seeing two overlapping requests from this specific caller.
  //
  // ⚠️ `onRequestFloorSwitch` MOVES `activeFloorContext` TOO (internally, via
  // the same `syncActiveFloorContext` `onFloorChanged` used to call
  // separately) — so `onFloorChanged` below is now a REDUNDANT, defensive
  // second call for the common case, and the ONLY sync that happens at all
  // on the fallback (no-`onRequestFloorSwitch`) path.
  async function changeFloor(delta) {
    if (state.floorSwitching) return;
    const max = Math.max(0, (state.ctx?.floorCount ?? 21) - 1);
    const next = Math.max(0, Math.min(max, state.floor + delta));
    if (next === state.floor) return;
    cancelDraft(); // an in-progress shape belonged to the old floor
    endCells();
    state.floorSwitching = true;
    state.refreshToolbar?.();
    try {
      if (onRequestFloorSwitch) {
        // A `{ok:false}` result (superseded/cancelled prepare) is not an
        // error — `switchToPreparedFloor` already logs it on the boot.js
        // side. Nothing further to do here; fall through to the same
        // authoritative-painting bookkeeping as a successful switch.
        await onRequestFloorSwitch(next);
      } else {
        await setVtPanViewerFloor(next);
      }
    } catch (err) {
      notify(
        `Map Shine: live view couldn't follow to floor ${next} (${err?.message || err}) — painting it anyway.`,
        'warn'
      );
    } finally {
      state.floorSwitching = false;
    }
    state.floor = next;
    onFloorChanged?.(next);
    layerFor(state.kind); // ensure the new floor's layer exists
    markFull(activeKey());
    state.refreshToolbar?.();
    ensureSeeded(state.kind);
  }

  // ---- painting ----------------------------------------------------------
  // UNDO IS SCOPED PER `${kind}::${floor}` (2026-08-31). It used to be ONE flat
  // stack shared by every layer, so Ctrl+Z popped the most recent push
  // ANYWHERE — paint on floor 1, step to floor 2, Ctrl+Z, and floor 1's stroke
  // silently vanished while the screen (showing floor 2) did not move. A stack
  // per key means Ctrl+Z can only ever affect the layer you are looking at.
  // UNDO_LIMIT is per key, not global: the cap exists because each snapshot is
  // ~16MB at PAINT_GRID_MAX_DIM=4096, and that cost is per layer too.
  function pushUndo() {
    const key = activeKey();
    const layer = state.layers[key];
    if (!layer) return;
    const stack = (state.undo[key] ??= []);
    // The history length rides with the pixels, so an undo rolls BOTH back —
    // the grid and the record a full-size export replays can never disagree.
    stack.push({ key, data: layer.data.slice(), opsLen: opsFor(key).length });
    if (stack.length > UNDO_LIMIT) stack.shift();
  }

  function undo() {
    const key = activeKey();
    const stack = state.undo[key];
    const snap = stack?.pop();
    if (!snap || !state.layers[key]) return;
    state.layers[key].data.set(snap.data);
    if (Number.isInteger(snap.opsLen) && state.ops[key])
      state.ops[key].length = Math.min(state.ops[key].length, snap.opsLen);
    markFull(key); // undo can change anywhere -> the whole grid re-packs
    markEdited();
  }

  function stampWorld(wx, wy) {
    stampBrushWorld(layerFor(state.kind), wx, wy, state.brush.radius, {
      value: state.brush.strength,
      hardness: state.brush.hardness,
      mode: state.brush.mode,
    });
    markWorldDisc(activeKey(), wx, wy, state.brush.radius);
    markEdited();
  }

  // Interpolate along the stroke so fast drags don't leave gaps (a real brush,
  // not a series of disconnected dabs). The raw point is also appended to the
  // stroke's recorded op — `scene/mask-ops.js#stampStroke` replays the SAME
  // interpolation, so the record and the grid stay one picture.
  function paintTo(wx, wy) {
    state.stroke?.pts.push(wx, wy);
    if (state.lastWorld) {
      const dx = wx - state.lastWorld.x;
      const dy = wy - state.lastWorld.y;
      const dist = Math.hypot(dx, dy);
      const spacing = Math.max(1, state.brush.radius * 0.25);
      const steps = Math.max(1, Math.ceil(dist / spacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        stampWorld(state.lastWorld.x + dx * t, state.lastWorld.y + dy * t);
      }
    } else {
      stampWorld(wx, wy);
    }
    state.lastWorld = { x: wx, y: wy };
  }

  function clearActive() {
    const layer = state.layers[activeKey()];
    if (!layer) return;
    pushUndo();
    layer.data.fill(0);
    recordOp({ t: 'fill', v: 0 });
    markFull(activeKey());
    markEdited();
  }

  /** Apply one op to the active layer as an undoable edit. */
  function commitOp(op, bbox = null, { undoable = true } = {}) {
    const layer = layerFor(state.kind);
    if (undoable) pushUndo();
    applyOp(layer, op);
    recordOp(op);
    if (bbox) markWorldRect(activeKey(), ...bbox);
    else markFull(activeKey());
    markEdited();
  }

  const brushValue = () => ({ v: state.brush.strength, m: state.brush.mode });

  // ---- MSA Ready: the outdoors starts --------------------------------------
  /** "All outdoors": the whole floor white; the GM then paints the buildings. */
  function startAllOutdoors() {
    if (state.kind !== 'outdoors') return;
    commitOp({ t: 'fill', v: 255 });
  }

  /**
   * "Start from walls": every room Foundry's walls CLOSE becomes indoors
   * (black), everything else outdoors — a first guess the GM then corrects.
   */
  function startFromWalls() {
    if (state.kind !== 'outdoors') return;
    const res = roomCoverFromWalls({
      walls: readFloorWalls(state.floor),
      sceneRect: state.ctx.sceneRect,
      gridSize: state.ctx.gridSize,
    });
    if (!res.op) {
      notify(`Map Shine: Start from walls found nothing to fill — ${res.reason}.`, 'warn');
      return;
    }
    const layer = layerFor(state.kind);
    pushUndo();
    const fill = { t: 'fill', v: 255 };
    const cover = { ...res.op, v: 255, m: 'erase' };
    applyOp(layer, fill);
    applyOp(layer, cover);
    recordOp(fill);
    recordOp(cover);
    markFull(activeKey());
    markEdited();
    notify(
      `Map Shine: ${res.rooms} closed room(s) painted as indoors. Fix anything the walls got wrong, then Save next to map.`
    );
  }

  /** "Fill room": the one room the click is in. */
  function fillRoomAt(p) {
    const res = roomCoverFromWalls({
      walls: readFloorWalls(state.floor),
      sceneRect: state.ctx.sceneRect,
      gridSize: state.ctx.gridSize,
      at: p,
    });
    if (!res.op) {
      notify(`Map Shine: Fill room — ${res.reason}.`, 'warn');
      return;
    }
    commitOp({ ...res.op, ...brushValue() });
  }

  /** One grid cell (square or hex) under a world point, once per drag. */
  function paintCellAt(p) {
    const pts = state.ctx.cellPolygonAt(p.x, p.y);
    if (!pts) {
      notify('Map Shine: this scene has no grid — use the Rectangle tool instead.', 'warn');
      endCells();
      return;
    }
    const id = pts.map((v) => Math.round(v)).join(',');
    if (state.cellsDone?.has(id)) return;
    state.cellsDone?.add(id);
    const xs = pts.filter((_, i) => i % 2 === 0);
    const ys = pts.filter((_, i) => i % 2 === 1);
    commitOp(
      { t: 'poly', pts, ...brushValue() },
      [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      {
        undoable: false,
      }
    );
  }
  function endCells() {
    if (!state.cellsDone) return false;
    state.cellsDone = null;
    return true;
  }

  // ---- MSA Ready: Clean view + full-size files ------------------------------
  function setCleanViewOn(on) {
    const next = on === true;
    if (next === state.cleanView) return;
    state.cleanView = next;
    try {
      setCleanView?.(next);
    } catch (err) {
      state.cleanView = false;
      notify(`Map Shine: Clean view could not switch — ${err?.message || err}.`, 'warn');
    }
    state.refreshToolbar?.();
  }

  /** What Save / Download / Import can do for the active layer. */
  function fileSupportFor() {
    const info = getMaskFile?.(state.floor, state.kind) ?? null;
    return { info, loading: !!state.loading[activeKey()] };
  }

  async function runFileAction(label, fn) {
    if (state.busy) return null;
    state.busy = label;
    state.refreshToolbar?.();
    try {
      return await fn((p) => {
        state.busy = `${label} ${Math.round((p.done / Math.max(1, p.total)) * 100)}%`;
        state.refreshToolbar?.();
      });
    } finally {
      state.busy = null;
      state.refreshToolbar?.();
    }
  }

  /** After a file landed beside the map: this layer IS that file now. */
  async function adoptWrittenFile(key, path) {
    state.fileBacked[key] = true;
    state.ops[key] = [fileSeed(path, state.layers[key].spec)];
    // Drop this layer's draft from the scene flag (the file is the truth now),
    // saving any other drafts along the way, then let boot find the new file.
    await save({ force: true });
    // The scene redraws next; Clean view is a live switch on the OLD canvas, so
    // hand the map back first rather than leave the new one half-switched.
    setCleanViewOn(false);
    onMaskFileWritten?.({ floorIndex: state.floor, kindId: state.kind, path });
  }

  async function saveToMapFile() {
    const key = activeKey();
    if (state.loading[key]) return;
    const info = getMaskFile?.(state.floor, state.kind) ?? null;
    const res = await runFileAction('Saving…', (onProgress) =>
      saveMaskFileFlow({ info, kindId: state.kind, ops: opsFor(key), notify, onProgress })
    );
    if (res?.ok && res.path) await adoptWrittenFile(key, res.path);
  }

  async function downloadFile() {
    const key = activeKey();
    if (state.loading[key]) return;
    const info = getMaskFile?.(state.floor, state.kind) ?? null;
    await runFileAction('Drawing…', (onProgress) =>
      downloadMaskFlow({ info, kindId: state.kind, ops: opsFor(key), notify, onProgress })
    );
  }

  async function importFile() {
    const key = activeKey();
    const info = getMaskFile?.(state.floor, state.kind) ?? null;
    const res = await runFileAction('Importing…', () => importMaskFlow({ info, kindId: state.kind, notify }));
    if (!res?.ok || !res.path) return;
    // Show the imported picture now (the scene reload that follows re-reads it too).
    const layer = layerFor(state.kind);
    try {
      layer.data.set(
        await readMaskFileToGrid(res.path, layer.spec, kindDef(state.kind)?.absentValue ?? 0, { fresh: true })
      );
      state.undo[key] = [];
      markFull(key);
    } catch (err) {
      notify(`Map Shine: imported, but the painter couldn't show it yet (${err?.message || err}).`, 'warn');
    }
    await adoptWrittenFile(key, res.path);
  }

  // ---- vector tools (point / line / polygon) -----------------------------
  // All rasterize into the SAME MaskGrid the brush writes (Shapes-and-Regions.md):
  // a drawn shape and a painted region are one mask. Shapes are NOT retained as
  // editable vector objects yet (that + a Select tool are the next tier) — they
  // commit straight to pixels, undoable as a whole, exactly like a brush stroke.
  function setTool(t) {
    cancelDraft();
    state.tool = t;
    state.refreshToolbar?.();
  }

  function cancelDraft() {
    state.draft = null;
  }

  function commitDraft() {
    const d = state.draft;
    state.draft = null;
    if (!d) return;
    const layer = layerFor(state.kind);
    const opts = { value: state.brush.strength, mode: state.brush.mode };
    const xs = d.vertices.map((v) => v.x);
    const ys = d.vertices.map((v) => v.y);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const flat = d.vertices.flatMap((v) => [v.x, v.y]);
    if (d.type === 'polygon' && d.vertices.length >= 3) {
      pushUndo();
      rasterizePolygon(layer, d.vertices, opts);
      recordOp({ t: 'poly', pts: flat, v: opts.value, m: opts.mode });
      markWorldRect(activeKey(), ...bbox);
      markEdited();
    } else if (d.type === 'line' && d.vertices.length >= 2) {
      pushUndo();
      rasterizeStrokedLine(layer, d.vertices, state.brush.radius * 2, { ...opts, hardness: state.brush.hardness });
      recordOp({
        t: 'line',
        pts: flat,
        w: state.brush.radius * 2,
        v: opts.value,
        h: state.brush.hardness,
        m: opts.mode,
      });
      markWorldRect(activeKey(), ...bbox, state.brush.radius);
      markEdited();
    } else if (d.type === 'rect' && d.vertices.length === 2) {
      const pts = rectPoints(d.vertices[0], d.vertices[1]);
      if (pts[2] - pts[0] < 1 || pts[5] - pts[1] < 1) return; // a click, not a drag
      commitOp({ t: 'poly', pts, v: opts.value, m: opts.mode }, [pts[0], pts[1], pts[4], pts[5]]);
    }
  }

  function nearFirstVertex(e) {
    if (!state.draft || !state.draft.vertices.length) return false;
    const p0 = state.ctx.worldToClient(state.draft.vertices[0].x, state.draft.vertices[0].y);
    return Math.hypot(e.clientX - p0.x, e.clientY - p0.y) <= 10;
  }

  // ---- input (window, capture phase — see the file header) ---------------
  /**
   * END THE CURRENT BRUSH STROKE, from wherever the news arrives — a real
   * pointerup, a `pointercancel`, a move that turns out to have no button
   * held, a modal opening on top, or the painter closing.
   *
   * Mirrors `ui/anchor-mode.js#startDrag`'s capture pattern (the sibling
   * authoring tool in this directory, which already got this right): the
   * board element captures the pointer on down and releases it here, so a
   * drag that leaves the window still reports its up, and so a dialog opened
   * mid-stroke is not stolen from by a captured pointer.
   * @returns {boolean} true if a stroke was actually running.
   */
  /** Let go of a pointer the board captured for a rect/cells drag. */
  function releaseCapture() {
    const pid = state.pointerId;
    state.pointerId = null;
    if (pid === null) return;
    try {
      state.ctx?.boardElement?.releasePointerCapture?.(pid);
    } catch (err) {
      // The pointer is already gone (released outside, element re-created) — nothing to release.
      if (err?.name !== 'NotFoundError') notify(`Map Shine: pointer release failed (${err?.message || err}).`, 'warn');
    }
  }

  function endStroke() {
    if (!state.painting) return false;
    state.painting = false;
    state.lastWorld = null;
    state.stroke = null;
    const pid = state.pointerId;
    state.pointerId = null;
    if (pid !== null) {
      // Throws NotFoundError when the pointer id is already gone (the pointer
      // was released outside, the element was re-created) — never a reason to
      // leave the stroke half-ended.
      try {
        state.ctx?.boardElement?.releasePointerCapture?.(pid);
      } catch {
        /* the capture is gone either way */
      }
    }
    return true;
  }

  function installHandlers() {
    const suppress = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const worldAt = (e) => snapPoint(state.ctx.screenToWorld(e.clientX, e.clientY));
    const capture = (e) => {
      state.pointerId = e.pointerId ?? null;
      try {
        state.ctx.boardElement?.setPointerCapture?.(e.pointerId);
      } catch {
        state.pointerId = null; // capture refused — the buttons guard in onMove still covers us
      }
    };
    const onDown = (e) => {
      if (state.modalOpen) return; // a confirm dialog is up
      if (e.button !== 0) return; // left button only; right/middle fall through to Foundry (pan)
      if (e.target !== state.ctx.boardElement) return; // not the map -> let the UI (ours or Foundry's) have it
      if (state.loading[activeKey()] || state.busy) {
        // The layer is still being read from its file, or a save is running:
        // a stroke now would be painted over (or written without it).
        suppress(e);
        return;
      }
      if (state.tool === 'rect') {
        const p = worldAt(e);
        state.draft = { type: 'rect', vertices: [p, p] };
        capture(e);
        suppress(e);
        return;
      }
      if (state.tool === 'cells') {
        pushUndo();
        state.cellsDone = new Set();
        capture(e);
        paintCellAt(state.ctx.screenToWorld(e.clientX, e.clientY));
        suppress(e);
        return;
      }
      if (state.tool === 'room') {
        fillRoomAt(state.ctx.screenToWorld(e.clientX, e.clientY));
        suppress(e);
        return;
      }
      if (state.tool === 'brush') {
        state.painting = true;
        state.lastWorld = null;
        // Capture on the board (the element this press is already proven to
        // be on, two lines up) so the stroke keeps receiving moves — and,
        // crucially, its UP — even when the drag leaves the window entirely.
        state.pointerId = e.pointerId ?? null;
        try {
          state.ctx.boardElement?.setPointerCapture?.(e.pointerId);
        } catch {
          state.pointerId = null; // capture refused — the buttons guard in onMove still covers us
        }
        pushUndo();
        const raw = state.ctx.screenToWorld(e.clientX, e.clientY); // the brush ignores snap (smooth strokes)
        state.stroke = {
          t: 'stroke',
          pts: [],
          r: state.brush.radius,
          v: state.brush.strength,
          h: state.brush.hardness,
          m: state.brush.mode,
        };
        recordOp(state.stroke);
        paintTo(raw.x, raw.y);
        suppress(e);
        return;
      }
      const p = worldAt(e);
      if (state.tool === 'point') {
        pushUndo();
        recordOp({
          t: 'stroke',
          pts: [p.x, p.y],
          r: state.brush.radius,
          v: state.brush.strength,
          h: state.brush.hardness,
          m: state.brush.mode,
        });
        stampWorld(p.x, p.y);
      } else if (state.tool === 'line' || state.tool === 'polygon') {
        // A click near the first vertex closes a polygon; otherwise add a vertex.
        if (state.tool === 'polygon' && state.draft && state.draft.vertices.length >= 3 && nearFirstVertex(e)) {
          commitDraft();
        } else {
          if (!state.draft) state.draft = { type: state.tool, vertices: [] };
          state.draft.vertices.push(p);
        }
      }
      suppress(e);
    };
    const onMove = (e) => {
      state.mouseClient = { x: e.clientX, y: e.clientY };
      state.hoverOnBoard = e.target === state.ctx.boardElement;
      const raw = state.ctx.screenToWorld(e.clientX, e.clientY);
      state.cursorWorld = snapPoint(raw);
      if (state.draft?.type === 'rect') {
        if (!(e.buttons & 1)) {
          commitDraft(); // released outside the window
          return;
        }
        state.draft.vertices[1] = state.cursorWorld;
        suppress(e);
        return;
      }
      if (state.cellsDone) {
        if (state.modalOpen || !(e.buttons & 1)) {
          endCells();
          return;
        }
        paintCellAt(raw);
        suppress(e);
        return;
      }
      // Once a brush stroke is underway, painting continues even if the drag
      // crosses a panel (ordinary paint-tool behaviour); vector tools are
      // click-based, so a move only updates the rubber-band cursor.
      if (state.tool === 'brush' && state.painting) {
        // TWO WAYS A "LIVE" STROKE IS ALREADY OVER, both of which used to
        // paint anyway (2026-08-31):
        //   - no primary button held. Drag off the browser window, release
        //     there, come back over the map: the up was never delivered, so
        //     `painting` stayed true and the return trip got interpolated
        //     into one long unwanted stroke. `buttons` is the browser's own
        //     answer to "is it still held", and it is authoritative on every
        //     move — including the first one after a release we never saw.
        //   - a modal went up. Holding the brush and pressing Escape opens
        //     the unsaved-changes dialog, and this handler kept painting
        //     underneath it — right across the map and into the dialog's own
        //     "Save & close" button, which then saved the accident.
        // Ending the stroke (rather than merely skipping the stamp) is what
        // releases the pointer capture, so the dialog is fully clickable.
        if (state.modalOpen || !(e.buttons & 1)) {
          endStroke();
          return;
        }
        paintTo(raw.x, raw.y);
        suppress(e);
      }
    };
    // Not gated on `state.tool`: a tool switch mid-stroke (the keyboard
    // shortcuts do not stop one) must still be able to end it.
    const onUp = (e) => {
      if (state.draft?.type === 'rect') {
        commitDraft();
        releaseCapture();
        suppress(e);
        return;
      }
      if (endCells()) {
        releaseCapture();
        suppress(e);
        return;
      }
      if (endStroke()) suppress(e);
    };
    // The browser gave up on this pointer (touch cancelled, capture stolen,
    // the element removed). Same handling as an up — but never suppressed:
    // it is the browser's own notification, not an input to intercept.
    const onCancel = () => {
      endStroke();
    };
    const onDbl = (e) => {
      if (state.draft) {
        commitDraft(); // double-click finishes a line/polygon
        suppress(e);
      }
    };
    const onKey = (e) => {
      if (state.modalOpen) return; // the dialog owns the keyboard
      if (e.key === 'Escape') {
        if (state.draft) {
          cancelDraft(); // Esc cancels the in-progress shape first; a second Esc closes
          e.preventDefault();
          return;
        }
        return requestExit();
      }
      if (e.key === 'Enter') {
        if (state.draft) {
          commitDraft();
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Backspace' && state.draft) {
        state.draft.vertices.pop();
        if (!state.draft.vertices.length) state.draft = null;
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        undo();
        e.preventDefault();
        return;
      }
      if (e.key === '[') state.brush.radius = Math.max(5, state.brush.radius - 10);
      else if (e.key === ']') state.brush.radius = Math.min(400, state.brush.radius + 10);
      else if (e.key.toLowerCase() === 'e') state.brush.mode = state.brush.mode === 'erase' ? 'add' : 'erase';
      else if (e.key.toLowerCase() === 'b') setTool('brush');
      else if (e.key.toLowerCase() === 'p') setTool('point');
      else if (e.key.toLowerCase() === 'l') setTool('line');
      else if (e.key.toLowerCase() === 'g') setTool('polygon');
      else if (e.key.toLowerCase() === 'r') setTool('rect');
      else if (e.key.toLowerCase() === 'c') setTool('cells');
      else if (e.key.toLowerCase() === 'f') setTool('room');
      else if (e.key.toLowerCase() === 'v') setCleanViewOn(!state.cleanView);
      else if (e.key.toLowerCase() === 's')
        state.snapMode = state.snapMode === 'off' ? 'grid' : state.snapMode === 'grid' ? 'quarter' : 'off';
      else return;
      state.refreshToolbar?.();
    };
    // Capture phase so a left-button event is intercepted BEFORE it descends to
    // Foundry's canvas listeners; right-button/wheel are never touched, so they
    // reach Foundry and pan/zoom natively.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('dblclick', onDbl, true);
    window.addEventListener('keydown', onKey, true);
    state.handlers = { onDown, onMove, onUp, onCancel, onDbl, onKey };
  }

  function removeHandlers() {
    const h = state.handlers;
    if (!h) return;
    window.removeEventListener('pointerdown', h.onDown, true);
    window.removeEventListener('pointermove', h.onMove, true);
    window.removeEventListener('pointerup', h.onUp, true);
    window.removeEventListener('pointercancel', h.onCancel, true);
    window.removeEventListener('dblclick', h.onDbl, true);
    window.removeEventListener('keydown', h.onKey, true);
    state.handlers = null;
  }

  // ---- lifecycle ---------------------------------------------------------
  /**
   * @param {object} [opts]
   * @param {string} [opts.kind] - preselect a MASK_KINDS id, so an effect card's
   *   ＋ button opens the brush already loaded with THAT effect's mask. Control-
   *   Panel.md §5.2 step 2 verbatim: "No mask-picker detour; the button already
   *   knew the mask." An unknown or non-paintable id is ignored rather than
   *   throwing — the brush still opens, on whatever kind was last selected,
   *   because a dead ＋ button is worse than a slightly wrong one.
   */
  function enter(opts = {}) {
    if (state.active) return;
    const ctx = readPaintContext();
    if (!ctx.ready) {
      notify('Map Shine: load a scene before painting.', 'warn');
      return;
    }
    if (opts.kind && PAINTABLE_KINDS.some((k) => k.id === opts.kind)) state.kind = opts.kind;
    state.ctx = ctx;
    // Open on whatever floor Foundry is ALREADY showing, not always floor 0 —
    // the auto-follow this project deferred earlier, unlocked for free once
    // the context carries the live viewed-floor index.
    state.floor = Math.max(0, Math.min(Math.max(0, ctx.floorCount - 1), ctx.viewedFloorIndex ?? 0));
    // The Remote's readiness card opens on a NAMED floor's `_Outdoors` — a
    // shape tool and whole-grid snap are where a GM starts on one of those.
    if (opts.kind === 'outdoors' && opts.guided) {
      state.tool = 'rect';
      state.snapMode = ctx.gridless ? 'off' : 'grid';
      state.brush.mode = 'erase';
      state.brush.strength = 255;
    }
    layerFor(state.kind);
    buildOverlay();
    installHandlers();
    state.active = true;
    for (const key of Object.keys(state.layers)) markFull(key);
    loop();
    ensureSeeded(state.kind);
    if (Number.isInteger(opts.floorIndex) && opts.floorIndex !== state.floor)
      changeFloor(opts.floorIndex - state.floor);
  }

  function exit() {
    if (!state.active) return;
    setCleanViewOn(false); // never leave the map in Clean view behind a closed painter
    state.active = false;
    endStroke(); // releases the pointer capture too — `painting = false` alone never did
    endCells();
    state.draft = null;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    removeHandlers();
    state.overlay?.remove();
    state.toolbar?.remove();
    state.overlay = state.toolbar = state.canvas = null;
  }

  // Exit, but guard unsaved work first (the data-loss point — masks live in
  // memory + the scene flag, so closing without saving loses the in-memory edits).
  async function requestExit() {
    endStroke(); // Escape can arrive with the brush still down — never leave a captured pointer behind a dialog
    if (!state.dirtySinceSave) return exit();
    const choice = await confirmModal(
      'Unsaved painting',
      'You have unsaved changes. Save them to the scene before closing?',
      [
        { action: 'save', label: '💾 Save & close', accent: '167,255,196' },
        { action: 'discard', label: 'Discard & close', accent: '255,120,120' },
        { action: 'cancel', label: 'Keep editing', accent: '143,214,255' },
      ]
    );
    if (choice === 'save') {
      await save();
      exit();
    } else if (choice === 'discard') {
      // DISCARD ACTUALLY DISCARDS (2026-08-31). This used to be a bare
      // `exit()`, which only tore down the DOM — the rejected edit (a Clear,
      // say) stayed in `state.layers`, survived the close, and was swept into
      // whatever unrelated Save happened later in the session. Now it rolls
      // back to the last committed snapshot; `discardEdits()` returning false
      // means there is no snapshot to roll back TO, in which case closing is
      // still the honest thing to do (the pre-fix behaviour, kept as the
      // fallback rather than throwing).
      discardEdits();
      exit();
    }
    // cancel / dismissed -> stay in Author Mode
  }

  // ---- overlay + toolbar -------------------------------------------------
  function buildOverlay() {
    const overlay = document.createElement('div');
    // ABOVE the map, BELOW every panel (MSA Ready, 2026-11-01): Foundry's board
    // is z 0 and its token HUD z 1, its UI columns z 30, the Remote z 101. At 100
    // the overlay tinted the Remote and Foundry's sidebars too — invisible with a
    // small `_Fire` stroke, a pink wall over the UI once `_Outdoors` paints whole
    // buildings. The toolbar (its own element, z 101) still sits on top.
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '2', pointerEvents: 'none' });
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    overlay.appendChild(canvas);
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.canvas = canvas;
    state.toolbar = buildToolbar();
    document.body.appendChild(state.toolbar);
  }

  /**
   * @param {{force?: boolean}} [opts] - `force` writes even with nothing
   *   unsaved: a file just written beside the map must leave the flag (MSA Ready).
   */
  async function save({ force = false } = {}) {
    // Nothing to write. The Save button is `disabled` in this state (see
    // paint-mode-toolbar.js#refreshToolbar), so this is defence in depth for
    // any OTHER caller — a programmatic save, a macro — not the UI path: a
    // no-op save would still cost a scene-flag round trip and re-fire the
    // brush→render bridge for content nothing has changed.
    if (!state.dirtySinceSave && !force) return;
    // A layer that IS its mask file keeps no draft: the file is the truth, and
    // a stale draft would keep overriding it after the GM edits that file in
    // another program (MSA Ready).
    const drafts = Object.fromEntries(Object.entries(state.layers).filter(([key]) => !state.fileBacked[key]));
    const payload = serializePaintedMasks(drafts);
    // The world-space history rides beside each grid, compacted when it grows
    // past its own budget (scene/mask-ops.js#compactOps — the picture is kept,
    // only older edits' full-size sharpness is given up).
    for (const key of Object.keys(payload)) {
      const { ops } = compactOps(opsFor(key), state.layers[key]);
      state.ops[key] = ops;
      payload[key] = { ...payload[key], ops };
    }
    // PAINT_EMBED_BYTE_BUDGET existed but was never actually checked anywhere
    // live — an "unwired museum" piece. The resolution bump (512 -> 2048) makes
    // it meaningfully more likely a detailed mask actually crosses it, so this
    // is the moment to surface the signal instead of leaving it unused.
    const heavy = Object.entries(payload)
      .map(([key, enc]) => ({ key, bytes: encodedByteEstimate(enc) }))
      .filter((x) => x.bytes > PAINT_EMBED_BYTE_BUDGET);
    const r = await savePaintedMasks(payload);
    const n = Object.keys(payload).length;
    if (!r.ok) {
      notify(`Map Shine: save failed — ${r.reason}`, 'error');
      return;
    }
    let msg = `Map Shine: saved ${n} painted mask(s) to the scene.`;
    if (heavy.length) {
      const names = heavy.map((h) => h.key.split('::')[0]).join(', ');
      msg += ` ⚠ ${names} ${heavy.length === 1 ? 'is' : 'are'} getting detailed (${heavy
        .map((h) => Math.round(h.bytes / 1024))
        .join('/')} KB) — saved fine, but a detailed mask belongs in a file: use ⬆ Save next to map.`;
    }
    state.dirtySinceSave = false;
    // WHAT IS ON THE SCENE IS NOW WHAT IS IN MEMORY — so this is one of the
    // exactly two moments the discard target is re-taken. It also resolves a
    // deferred scene load: these layers have just been written to the CURRENT
    // scene, so they are its authoritative content and `getLayers()` may hand
    // them to the render bridge again.
    snapshotCommitted();
    state.pendingHydrate = false;
    state.refreshToolbar?.();
    // A forced save with no drafts left is housekeeping after a file write —
    // "saved 0 painted masks" there only confuses (found live, MSA Ready).
    if (!(force && n === 0)) notify(msg, heavy.length ? 'warn' : 'info');
    // THE BRUSH→RENDER BRIDGE — see this module's own header. Every
    // in-memory layer, not just `payload`'s own non-empty subset: a layer
    // the author just cleared to fully-empty must still reach
    // ingestPaintedMask so it can stop overriding the render (self-alpha
    // makes an all-zero layer a no-op there, automatically — see that
    // function's own doc).
    onLayersChanged?.(renderLayers());
  }

  /** The layer set the render should see: a file-backed layer contributes
   * nothing of its own (null = forget), since its file is already discovered. */
  function renderLayers() {
    const out = {};
    for (const [key, layer] of Object.entries(state.layers)) out[key] = state.fileBacked[key] ? null : layer;
    return out;
  }

  // ---- scene load --------------------------------------------------------
  /**
   * Replace the in-memory layers with whatever THIS scene holds — the second
   * of the two moments `state.layers` becomes the scene's own truth, so the
   * committed snapshot is re-taken here too.
   *
   * ⚠️ A FRESH CONTEXT ON EVERY LOAD (2026-08-31). `state.ctx` used to be
   * captured exactly once, in `enter()`. Foundry rebuilds `canvas.app`/
   * `canvas.stage` on a scene draw, so a painter left open across one held a
   * `boardElement` that no longer existed — and because a stroke starts ONLY
   * when `e.target === state.ctx.boardElement` (the positive check this
   * module's header explains), that gate could never match again: painting
   * stopped dead, no error, not even a brush ring, until the painter was
   * closed and re-opened. Re-resolving here covers the non-dirty path too — a
   * fresh scene always needs a fresh context, whatever the answer to the
   * unsaved-work question below.
   *
   * @param {object} [ctx] - a fresh paint context; read here when omitted.
   * @param {object} [opts]
   * @param {boolean} [opts.announce=false] - fire `onLayersChanged`. FALSE for
   *   the normal `canvasReady` path (see `hydrateFromScene`'s own doc for the
   *   `maskAuthority.reset()` ordering hazard that makes it unsafe there);
   *   TRUE only for a LATE hydrate resolved by the author after that hook has
   *   long finished, where the caller's own post-reset re-ingest has already
   *   been and gone and nothing else will feed the render.
   * @returns {{loaded:boolean, mismatched?:string[]}|null} null = no ready
   *   scene to load from, in which case nothing was touched.
   */
  function applyHydrate(ctx = readPaintContext(), { announce = false } = {}) {
    if (!ctx.ready) return null;
    state.ctx = ctx;
    const payload = loadPaintedMasks();
    const hydrated = payload ? hydratePaintedMasks(payload, ctx.sceneRect) : { layers: {} };
    pruneGridCaches(hydrated.layers);
    state.layers = hydrated.layers;
    // Each layer's history, where one was saved (older flags have none —
    // `ensureSeeded` then makes the layer's picture its history).
    state.ops = {};
    for (const key of Object.keys(hydrated.layers)) {
      const ops = payload?.[key]?.ops;
      if (isValidOpList(ops)) state.ops[key] = ops;
    }
    state.seeded = {};
    state.fileBacked = {};
    state.loading = {};
    state.undo = {};
    state.previewRect = {};
    state.dirtySinceSave = false; // freshly loaded from the scene = clean
    state.pendingHydrate = false;
    snapshotCommitted(); // what the scene holds IS the committed truth
    for (const key of Object.keys(state.layers)) markFull(key);
    state.refreshToolbar?.();
    if (announce) onLayersChanged?.(renderLayers());
    // NOT `ensureSeeded` here: a hydrate runs at the top of `canvasReady`, BEFORE
    // that load's mask discovery — seeding now would miss a file written a moment
    // ago and start `_Outdoors` all white over it (found live, MSA Ready). Boot
    // calls `onMasksDiscovered` once discovery has run.
    return { loaded: Object.keys(state.layers).length > 0, mismatched: hydrated.mismatched };
  }

  /**
   * The deferred load, handed to the author as an actual choice rather than a
   * notification they can only read. NOT awaited by `hydrateFromScene` — that
   * has to stay synchronous (boot.js's `canvasReady` handler calls it without
   * `await` and reads `getLayers()` later in the same hook, so an async
   * version would move the layer population to after that read).
   *
   * Deliberately NO "Save" button, unlike the close and effect-switch guards:
   * `savePaintedMasks` writes to whatever scene is active NOW, so a Save
   * offered from here would silently write the PREVIOUS scene's painted masks
   * into this one. Save stays on the toolbar, where the author chooses it
   * with a scene in front of them.
   */
  function offerPendingHydrateResolution() {
    if (state.modalOpen) return; // a dialog is already up; the notification carries the news
    confirmModal(
      'Unsaved painting kept',
      "This scene's saved masks were NOT loaded — you have unsaved painting open, and loading would have " +
        'overwritten it. Discard your unsaved work and load this scene, or keep it and resolve it yourself ' +
        '(Save writes to the scene you are on now).',
      [
        { action: 'discard', label: 'Discard mine & load the scene', accent: '255,120,120' },
        { action: 'keep', label: 'Keep mine for now', accent: '143,214,255' },
      ]
    ).then((choice) => {
      if (choice !== 'discard') return;
      if (!state.pendingHydrate) return; // already resolved meanwhile (saved, exited, another load)
      applyHydrate(undefined, { announce: true });
    });
  }

  // ---- preview loop ------------------------------------------------------
  // At PAINT_GRID_MAX_DIM=4096 a full re-pack is ~16M texels — too slow per
  // frame while painting. So the offscreen ImageData is allocated ONCE and
  // reused, packed as one 32-bit RGBA per texel, and — the load-bearing part —
  // only the DIRTY RECTANGLE is re-packed and uploaded (`putImageData` with a
  // sub-rect). Per-frame cost is O(changed area), independent of grid size.

  MapShine.debug?.registerAction(
    'paint',
    '🖌️ Paint masks',
    () => {
      enter();
      return { report: 'paint', entered: state.active, kind: state.kind };
    },
    { primary: true }
  );

  return {
    /** Open the brush, optionally on a named mask kind — the door every effect
     * card's ＋ button goes through. Private until 2026-07-27; a card that wants
     * to send you straight to painting ITS mask needs to be able to say so. */
    enter,
    /**
     * Called from boot's canvasReady: pull any painted masks saved on this
     * scene. ⚠️ Does NOT itself call `onLayersChanged` — `canvasReady`'s own
     * handler calls `maskAuthority.reset()` (via `startRealSceneViewer`)
     * AFTER this, several hundred lines later in the same hook, and a
     * `reset()` wipes `paintedIngests` wholesale for the new scene. Firing
     * the bridge here would feed the OLD scene's (soon-to-be-discarded)
     * authority state and be silently lost the moment `reset()` ran. The
     * caller reads `getLayers()` (below) and calls the bridge itself, AFTER
     * its own `reset()` — see boot.js's own canvasReady handler.
     *
     * ⚠️ NEVER OVERWRITES UNSAVED WORK (2026-08-31). This is called on EVERY
     * `canvasReady` — every scene change, every re-draw — and it used to
     * replace `state.layers` wholesale and set `dirtySinceSave = false`
     * unconditionally. A GM with unsaved painting open who switched scenes
     * lost every stroke instantly, with the toolbar flipping to "💾 Saved" as
     * if nothing had happened. When the painter is open AND dirty the load is
     * now DEFERRED instead: the in-memory work survives, the dirty flag stays
     * up, and the author is told (notification + a dialog offering to discard
     * and load).
     *
     * DESIGN NOTE — why deferral rather than a blocking Save/Discard dialog
     * at this call site: this function MUST stay synchronous. boot.js calls
     * it without `await` at the top of its `canvasReady` handler and reads
     * `getLayers()` much later in that same hook; an `async` version would
     * move the layer population to after that read. A Save option here would
     * also be actively wrong — `savePaintedMasks` targets whatever scene is
     * active NOW, so it could write the previous scene's masks into this one.
     *
     * @returns {{loaded:boolean, mismatched?:string[], deferredForUnsavedChanges?:boolean}}
     */
    hydrateFromScene() {
      const ctx = readPaintContext();
      if (!ctx.ready) return { loaded: false };
      if (state.active && state.dirtySinceSave) {
        state.ctx = ctx; // a fresh scene still needs a fresh board element — see applyHydrate's own doc
        state.pendingHydrate = true;
        state.refreshToolbar?.();
        notify(
          "Map Shine: this scene's saved masks were NOT loaded — you have unsaved painting open. " +
            'Save it, or discard it, to resolve.',
          'error'
        );
        offerPendingHydrateResolution();
        return { loaded: false, deferredForUnsavedChanges: true };
      }
      return applyHydrate(ctx) ?? { loaded: false };
    },
    /** The CURRENT in-memory layer set — read-only, for a caller that needs
     * to re-feed it to `onLayersChanged`'s own consumer at a moment this
     * file cannot safely call that callback itself (see `hydrateFromScene`'s
     * own doc for the one caller that needs this, and why).
     *
     * ⚠️ EMPTY WHILE A LOAD IS DEFERRED. The one caller feeds this straight
     * into `maskAuthority.ingestPaintedMask` for the scene that just loaded —
     * and while `pendingHydrate` is set, these layers belong to a DIFFERENT
     * (previous) scene, with that scene's world rect baked into every layer's
     * `spec`. Handing them over would paint one map's masks onto another's
     * geometry. An empty set means the new scene simply renders without
     * painted masks until the author resolves the deferral, which is the
     * conservative half of that choice. */
    getLayers() {
      if (state.pendingHydrate) return {};
      return renderLayers();
    },
    /** Is the painter open? */
    isActive: () => state.active,
    /** Boot: this scene's mask discovery has run — an open painter may now
     * decide where its layer starts (from a file, if one was just found). */
    onMasksDiscovered() {
      if (!state.active || state.pendingHydrate) return;
      ensureSeeded(state.kind);
      state.refreshToolbar?.();
    },
    /** POOL HEALTH — see gridCachePoolStats' own declaration for the exact
     * hit/miss doctrine. */
    getGridCachePoolStats() {
      return { ...state.gridCachePoolStats };
    },
  };
}
