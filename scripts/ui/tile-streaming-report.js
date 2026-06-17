/**
 * @fileoverview Tile streaming diagnostic report for Quick Actions / console debugging.
 * @module ui/tile-streaming-report
 */

import { createLogger } from '../core/log.js';
import { getTileStreamingManager } from '../streaming/tile-streaming-manager.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { estimateSceneMegapixels } from '../streaming/texture-budget-policy.js';
import { selectLodFromZoom, resolveStreamingPixelRatio, resolveStreamingZoom } from '../streaming/streaming-grid.js';
import { getTileDecodePoolStats, getPyramidBakeProgress } from '../streaming/texture-pyramid-builder.js';
import {
  getSceneRectMeta,
  resolveStreamingViewRect,
} from '../streaming/view-projection-service.js';

const log = createLogger('TileStreamingReport');

/**
 * Resolve the live FloorRenderBus from MapShine globals (V2 paths vary by load phase).
 * @returns {import('../compositor-v2/FloorRenderBus.js').FloorRenderBus|null}
 */
export function resolveFloorRenderBus() {
  try {
    const ms = window.MapShine ?? {};
    return ms.floorCompositorV2?._renderBus
      ?? ms.effectComposer?._floorCompositorV2?._renderBus
      ?? ms.floorCompositor?._renderBus
      ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Populate / compositor state for crash reports and streaming diagnostics.
 * @returns {object}
 */
export function buildCompositorPopulateSnapshot() {
  try {
    const ms = window.MapShine ?? {};
    const fc = ms.floorCompositorV2
      ?? ms.effectComposer?._floorCompositorV2
      ?? ms.floorCompositor
      ?? null;
    const bus = resolveFloorRenderBus();
    return {
      coordinatorState: ms.loadCoordinator?.state ?? null,
      sceneLoading: ms.__msaSceneLoading === true,
      populateComplete: fc?._populateComplete === true,
      populateInFlight: !!fc?._populatePromise && fc?._populateComplete !== true,
      busPopulated: fc?._busPopulated === true,
      busTileCount: bus?._tiles?.size ?? 0,
      pendingBackgroundJobs: bus?._pendingBackgroundJobs?.size ?? 0,
    };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/**
 * @param {import('three').Object3D|null|undefined} mesh
 * @returns {{ w: number, h: number, hasMap: boolean }}
 */
function _texInfo(mesh) {
  const img = mesh?.material?.map?.image;
  const w = Number(img?.width) || 0;
  const h = Number(img?.height) || 0;
  return { w, h, hasMap: !!(mesh?.material?.map && (w > 0 || h > 0)) };
}

/**
 * @param {import('../streaming/streamed-background-grid.js').StreamedBackgroundGrid} grid
 * @param {string} kind
 * @returns {object}
 */
function _summarizeBackgroundGrid(grid, kind) {
  const cells = [];
  for (const [key, entry] of grid._cells?.entries?.() ?? []) {
    const tex = _texInfo(entry?.mesh);
    cells.push({
      key,
      lod: entry?.lod ?? '?',
      state: grid._cellStates?.get?.(key) ?? '?',
      visible: !!entry?.mesh?.visible,
      inflight: grid._inflight?.has?.(key) ?? false,
      texW: tex.w,
      texH: tex.h,
      hasMap: tex.hasMap,
    });
  }

  const fallbackCells = (grid._fallbackCellMeshes ?? []).map((mesh, i) => {
    const tex = _texInfo(mesh);
    return {
      index: i,
      visible: !!mesh?.visible,
      texW: tex.w,
      texH: tex.h,
      hasMap: tex.hasMap,
      tileId: mesh?.userData?.tileId ?? null,
    };
  });

  return {
    kind,
    key: grid._key ?? null,
    floorIndex: grid._floorIndex ?? null,
    mounted: grid.isMounted?.() ?? false,
    servedLodRaw: grid._servedLod ?? null,
    effectiveServedLod: Math.min(
      Math.max(0, Math.floor(Number(grid._servedLod) || 0)),
      Number(grid._maxLod) || 4,
    ),
    cellSize: grid._cellSize ?? null,
    maxConcurrent: grid._maxConcurrent ?? null,
    inflightCount: grid._inflight?.size ?? 0,
    coarseBaseReady: grid._coarseBaseReady === true,
    manifest: grid._manifest
      ? {
        sourceWidth: grid._manifest.sourceWidth,
        sourceHeight: grid._manifest.sourceHeight,
        cols: grid._manifest.cols,
        rows: grid._manifest.rows,
        cellSize: grid._manifest.cellSize,
      }
      : null,
    fallbackMesh: grid._fallbackMesh
      ? {
        visible: !!grid._fallbackMesh.visible,
        ..._texInfo(grid._fallbackMesh),
      }
      : null,
    fallbackCellCount: fallbackCells.length,
    fallbackCells: fallbackCells.slice(0, 12),
    cells,
    cellSummary: {
      total: cells.length,
      visible: cells.filter((c) => c.visible).length,
      withTexture: cells.filter((c) => c.hasMap).length,
      loading: cells.filter((c) => c.state === 'loading' || c.inflight).length,
      residentHi: cells.filter((c) => c.state === 'resident-hi').length,
      residentLo: cells.filter((c) => c.state === 'resident-lo').length,
      culled: cells.filter((c) => c.state === 'culled').length,
      lod0: cells.filter((c) => Number(c.lod) === 0 && c.hasMap).length,
      lod1: cells.filter((c) => Number(c.lod) === 1 && c.hasMap).length,
    },
  };
}

/**
 * @param {import('../streaming/streamed-background-grid.js').StreamedRegionGrid} grid
 * @returns {object}
 */
function _summarizeRegionGrid(grid) {
  const cells = [];
  for (const [key, entry] of grid._cells?.entries?.() ?? []) {
    const tex = _texInfo(entry?.mesh);
    cells.push({
      key,
      lod: entry?.lod ?? '?',
      state: grid._cellStates?.get?.(key) ?? '?',
      visible: !!entry?.mesh?.visible,
      inflight: grid._inflight?.has?.(key) ?? false,
      texW: tex.w,
      texH: tex.h,
      hasMap: tex.hasMap,
    });
  }

  return {
    kind: 'region',
    key: grid._key ?? null,
    floorIndex: grid._floorIndex ?? null,
    servedLod: grid._servedLod ?? null,
    cellSize: grid._cellSize ?? null,
    inflightCount: grid._inflight?.size ?? 0,
    region: grid._region ?? null,
    z: grid._z ?? null,
    manifest: grid._manifest
      ? {
        sourceWidth: grid._manifest.sourceWidth,
        sourceHeight: grid._manifest.sourceHeight,
        cols: grid._manifest.cols,
        rows: grid._manifest.rows,
      }
      : null,
    fallbackMesh: grid._fallbackMesh
      ? { visible: !!grid._fallbackMesh.visible, ..._texInfo(grid._fallbackMesh) }
      : null,
    cells,
    cellSummary: {
      total: cells.length,
      visible: cells.filter((c) => c.visible).length,
      withTexture: cells.filter((c) => c.hasMap).length,
      loading: cells.filter((c) => c.state === 'loading' || c.inflight).length,
    },
  };
}

/**
 * @returns {string[]}
 */
function _deriveWarnings(report) {
  /** @type {string[]} */
  const warnings = [];

  if (!report.streaming.managerEnabled) {
    warnings.push('Tile streaming manager exists but _enabled is false.');
  }

  if (report.scene.sceneMp >= 90 && report.streaming.backgroundGridCount === 0) {
    warnings.push('Large scene but no background streaming grid registered — may show grey solid plane only.');
  }

  for (const g of report.streaming.backgroundGrids) {
    if (!g.mounted) warnings.push(`Background grid [${g.key}] not mounted (manifest/fallback missing).`);
    const visWithTex = g.cells.filter((c) => c.visible && c.hasMap).length;
    if (g.cellSummary.total > 0 && visWithTex === 0) {
      warnings.push(`Background [${g.key}]: ${g.cellSummary.total} cells but none visible with a texture (grey risk).`);
    }
    if (!g.fallbackMesh && g.fallbackCellCount === 0 && visWithTex === 0) {
      warnings.push(`Background [${g.key}]: no fallback and no textured cells — likely grey.`);
    }
    if (Number.isFinite(g.floorIndex) && g.floorIndex > report.bus.visibleMaxFloorIndex) {
      warnings.push(`Background [${g.key}] on floor ${g.floorIndex} is above visible max floor ${report.bus.visibleMaxFloorIndex}.`);
    }
  }

  for (const g of report.streaming.regionGrids) {
    const visWithTex = g.cells.filter((c) => c.visible && c.hasMap).length;
    if (g.cellSummary.total > 0 && visWithTex === 0) {
      warnings.push(`Region grid [${g.key}] floor ${g.floorIndex}: cells exist but none visible with texture.`);
    }
    if (Number.isFinite(g.floorIndex) && g.floorIndex > report.bus.visibleMaxFloorIndex && g.cells.some((c) => c.visible)) {
      warnings.push(`Region [${g.key}] floor ${g.floorIndex} has visible cells but is above visible max floor — floor leak.`);
    }
  }

  if (report.budget.overBudget) {
    warnings.push(`VRAM over budget (${report.budget.usedPct}%) — LOD may be coarse or cells evicted.`);
  }

  if (report.streaming.backgroundGridCount > 0 && report.streaming.regionGridCount > 0) {
    const hiddenRegionTex = report.streaming.regionGrids.reduce((n, g) => {
      if (Number(g.floorIndex) > report.bus.visibleMaxFloorIndex) return n + g.cellSummary.withTexture;
      return n;
    }, 0);
    if (hiddenRegionTex > 0) {
      warnings.push(`${hiddenRegionTex} region-grid textures resident on non-visible floors — should evict on next sync.`);
    }
  }

  if (report.view.visibleCellsInFrustum === 0 && report.streaming.backgroundGridCount > 0) {
    warnings.push('No background cells cover the current view frustum.');
  }

  return warnings;
}

/**
 * Build a structured tile streaming diagnostic snapshot.
 * @returns {object}
 */
export function buildTileStreamingReport() {
  const manager = getTileStreamingManager();
  const budget = getTextureBudgetTracker();
  const budgetState = budget.getBudgetState?.() ?? {};
  const bus = resolveFloorRenderBus();
  const zoom = Number(window.MapShine?.sceneComposer?.currentZoom) || 1;
  const mp = estimateSceneMegapixels();
  const meta = getSceneRectMeta();
  const viewRect = resolveStreamingViewRect();
  const zoomLod = selectLodFromZoom(zoom, budget.getMaxLodLevel(), mp);

  /** @type {object[]} */
  const backgroundGrids = [];
  for (const grid of manager.getGrids?.()?.values?.() ?? []) {
    backgroundGrids.push(_summarizeBackgroundGrid(grid, 'background'));
  }

  /** @type {object[]} */
  const regionGrids = [];
  for (const grid of manager.getRegionGrids?.()?.values?.() ?? []) {
    regionGrids.push(_summarizeRegionGrid(grid));
  }

  /** @type {object[]} */
  const busStreamingTiles = [];
  for (const [id, entry] of bus?._tiles?.entries?.() ?? []) {
    if (!entry?.mesh?.userData?.mapShineStreaming && !entry?.mapShineStreamedRegion) continue;
    const tex = _texInfo(entry.root || entry.mesh);
    busStreamingTiles.push({
      id,
      floorIndex: entry.floorIndex,
      visible: (entry.root || entry.mesh)?.visible !== false,
      streamedRegion: !!entry.mapShineStreamedRegion,
      isFallback: !!entry.mesh?.userData?.mapShineStreamingFallback,
      ...tex,
    });
  }

  let visibleCellsInFrustum = 0;
  for (const g of backgroundGrids) {
    visibleCellsInFrustum += g.cells.filter((c) => c.visible && c.hasMap).length;
  }

  const decodePool = getTileDecodePoolStats();
  /** @type {Record<string, { done: number, total: number, fraction: number }>} */
  const bakeProgress = {};
  for (const grid of manager.getGrids?.()?.values?.() ?? []) {
    const sk = grid._manifest?.sourceKey;
    if (!sk) continue;
    const p = getPyramidBakeProgress(sk);
    if (p) bakeProgress[grid._key ?? sk] = p;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scene: {
      id: canvas?.scene?.id ?? null,
      name: canvas?.scene?.name ?? null,
      sceneMp: mp,
      scenePx: meta ? { w: meta.width, h: meta.height } : null,
      zoom,
      streamingZoom: resolveStreamingZoom(zoom),
      pixelRatio: resolveStreamingPixelRatio(),
      zoomLod,
    },
    view: {
      rect: viewRect,
      padding: manager._viewPaddingForScene?.() ?? null,
      visibleCellsInFrustum,
    },
    budget: {
      usedMB: Number((budgetState.usedBytes / 1024 / 1024).toFixed(1)),
      budgetMB: Number((budgetState.budgetBytes / 1024 / 1024).toFixed(0)),
      usedPct: Number((budgetState.usedFraction * 100).toFixed(1)),
      overBudget: !!budgetState.overBudget,
      entryCount: budgetState.entryCount ?? 0,
      cellSize: budget.cellSize,
      maxLod: budget.maxLod,
      backgroundMaxSize: budget.backgroundMaxSize,
      tileAlbedoMaxSize: budget.getTileAlbedoMaxSize?.(),
      downscale: budget.getDownscaleFactor?.(),
    },
    bus: {
      visibleMaxFloorIndex: bus?._visibleMaxFloorIndex ?? null,
      tileCount: bus?._tiles?.size ?? 0,
      bgSolidVisible: bus?._tiles?.get?.('__bg_solid__')?.mesh?.visible ?? null,
      streamingTileEntries: busStreamingTiles.length,
    },
    streaming: {
      managerEnabled: manager._enabled !== false,
      focalLod: manager.getFocalLod?.() ?? zoomLod,
      detailTier: manager.getDetailTier?.() ?? 'medium',
      isPanning: manager.isPanning?.() === true,
      backgroundGridCount: backgroundGrids.length,
      regionGridCount: regionGrids.length,
      heldZoomLod: manager._heldZoomLod ?? null,
      decodePool,
      bakeProgress,
      backgroundGrids,
      regionGrids,
      busStreamingTiles,
    },
    warnings: [],
  };

  report.warnings = _deriveWarnings(report);
  return report;
}

/**
 * @param {object[]} cells
 * @param {number} maxCells
 * @returns {object[]}
 */
function _prioritizeCellsForCrashSnapshot(cells, maxCells) {
  const priority = (c) => {
    let score = 0;
    if (c.inflight || c.state === 'loading') score += 100;
    if (c.visible && !c.hasMap) score += 80;
    if (c.visible) score += 40;
    if (c.state === 'culled') score -= 20;
    return score;
  };
  return [...cells]
    .sort((a, b) => priority(b) - priority(a))
    .slice(0, maxCells)
    .map(({ key, lod, state, visible, inflight, texW, texH, hasMap }) => ({
      key,
      lod,
      state,
      visible,
      inflight,
      texW,
      texH,
      hasMap,
    }));
}

/**
 * @param {object} g
 * @param {string} kind
 * @param {number} maxCells
 * @returns {object}
 */
function _compactGridForCrashSnapshot(g, kind, maxCells) {
  const cells = _prioritizeCellsForCrashSnapshot(g.cells ?? [], maxCells);
  return {
    kind: g.kind ?? kind,
    key: g.key ?? null,
    floorIndex: g.floorIndex ?? null,
    mounted: g.mounted ?? null,
    servedLod: g.effectiveServedLod ?? g.servedLod ?? null,
    cellSize: g.cellSize ?? null,
    maxConcurrent: g.maxConcurrent ?? null,
    inflightCount: g.inflightCount ?? 0,
    manifest: g.manifest ?? null,
    fallbackMesh: g.fallbackMesh ?? null,
    fallbackCellCount: g.fallbackCellCount ?? 0,
    cellSummary: g.cellSummary ?? null,
    cells,
    cellsOmitted: Math.max(0, (g.cells?.length ?? 0) - cells.length),
  };
}

/**
 * Compact tile streaming snapshot for WebGL crash reports (JSON-safe, size-capped).
 * @param {{ maxCellsPerGrid?: number }} [options]
 * @returns {object}
 */
export function buildTileStreamingCrashSnapshot(options = {}) {
  const maxCells = Math.max(4, Number(options.maxCellsPerGrid) || 20);
  try {
    const manager = getTileStreamingManager();
    const full = buildTileStreamingReport();

    const totalInflight = (full.streaming.backgroundGrids ?? []).reduce(
      (n, g) => n + (g.inflightCount ?? 0),
      0,
    ) + (full.streaming.regionGrids ?? []).reduce(
      (n, g) => n + (g.inflightCount ?? 0),
      0,
    );

    const totalResidentCells = (full.streaming.backgroundGrids ?? []).reduce(
      (n, g) => n + (g.cellSummary?.total ?? 0),
      0,
    ) + (full.streaming.regionGrids ?? []).reduce(
      (n, g) => n + (g.cellSummary?.total ?? 0),
      0,
    );

    return {
      sceneMp: full.scene.sceneMp,
      zoom: full.scene.zoom,
      zoomLod: full.scene.zoomLod,
      populate: buildCompositorPopulateSnapshot(),
      view: {
        rect: full.view.rect,
        padding: full.view.padding,
        visibleCellsInFrustum: full.view.visibleCellsInFrustum,
        projectionValid: full.view.rect != null,
      },
      budget: full.budget,
      bus: full.bus,
      manager: {
        enabled: full.streaming.managerEnabled,
        backgroundGridCount: full.streaming.backgroundGridCount,
        regionGridCount: full.streaming.regionGridCount,
        heldZoomLod: full.streaming.heldZoomLod,
        viewSnapKey: manager._viewSnapKey ?? null,
        lastStreamLod: manager._lastStreamLod ?? null,
      },
      totals: {
        inflight: totalInflight,
        residentCells: totalResidentCells,
        busStreamingTileEntries: full.streaming.busStreamingTiles?.length ?? 0,
      },
      backgroundGrids: (full.streaming.backgroundGrids ?? []).map(
        (g) => _compactGridForCrashSnapshot(g, 'background', maxCells),
      ),
      regionGrids: (full.streaming.regionGrids ?? []).map(
        (g) => _compactGridForCrashSnapshot(g, 'region', maxCells),
      ),
      warnings: full.warnings ?? [],
    };
  } catch (e) {
    return {
      error: String(e?.message ?? e),
      managerPresent: !!window.MapShine?.tileStreamingManager,
    };
  }
}

/**
 * Format report as plain text (for clipboard / Discord).
 * @param {object} report
 * @returns {string}
 */
export function formatTileStreamingReportText(report) {
  const lines = [];
  lines.push('=== Map Shine Tile Streaming Report ===');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Scene: ${report.scene.name ?? '?'} (${report.scene.scenePx?.w ?? '?'}×${report.scene.scenePx?.h ?? '?'}) ${report.scene.sceneMp.toFixed(1)} MP`);
  lines.push(`Zoom: ${report.scene.zoom.toFixed(3)} × ${report.scene.pixelRatio?.toFixed(2) ?? '?'} DPR = ${report.scene.streamingZoom?.toFixed(3) ?? '?'} → LOD ${report.scene.zoomLod} (held ${report.streaming.heldZoomLod})`);
  lines.push(`VRAM: ${report.budget.usedMB}/${report.budget.budgetMB} MB (${report.budget.usedPct}%)${report.budget.overBudget ? ' OVER' : ''}`);
  lines.push(`Bus visible floors: 0–${report.bus.visibleMaxFloorIndex}`);
  lines.push(`Grids: ${report.streaming.backgroundGridCount} background, ${report.streaming.regionGridCount} region`);
  lines.push(`View textured cells: ${report.view.visibleCellsInFrustum}`);

  if (report.warnings.length) {
    lines.push('');
    lines.push('WARNINGS:');
    for (const w of report.warnings) lines.push(`  • ${w}`);
  }

  for (const g of report.streaming.backgroundGrids) {
    lines.push('');
    lines.push(`Background [${g.key}] floor ${g.floorIndex} effLod=${g.effectiveServedLod} cells=${g.cellSummary.total} vis=${g.cellSummary.visible} tex=${g.cellSummary.withTexture} lod0=${g.cellSummary.lod0 ?? 0} lod1=${g.cellSummary.lod1 ?? 0} inflight=${g.inflightCount ?? 0}`);
    if (g.fallbackMesh) {
      lines.push(`  fallback: vis=${g.fallbackMesh.visible} ${g.fallbackMesh.w}×${g.fallbackMesh.h}`);
    }
    if (g.fallbackCellCount) lines.push(`  coarse fallback cells: ${g.fallbackCellCount}`);
    for (const c of g.cells.slice(0, 16)) {
      lines.push(`  cell ${c.key} lod${c.lod} ${c.state} vis=${c.visible} tex=${c.texW}×${c.texH}${c.inflight ? ' (inflight)' : ''}`);
    }
    if (g.cells.length > 16) lines.push(`  … +${g.cells.length - 16} more cells`);
  }

  for (const g of report.streaming.regionGrids) {
    lines.push('');
    lines.push(`Region [${g.key}] floor ${g.floorIndex} z=${g.z} cells=${g.cellSummary.total} vis=${g.cellSummary.visible} tex=${g.cellSummary.withTexture}`);
    for (const c of g.cells.slice(0, 8)) {
      lines.push(`  cell ${c.key} lod${c.lod} vis=${c.visible} tex=${c.texW}×${c.texH}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build report, format plain text, and store on MapShine globals (no console dump).
 * @returns {{ report: object, text: string }}
 */
export function buildTileStreamingReportSnapshot() {
  const report = buildTileStreamingReport();
  const text = formatTileStreamingReportText(report);
  try {
    window.MapShine = window.MapShine || {};
    window.MapShine.lastTileStreamingReport = report;
    window.MapShine.lastTileStreamingReportText = text;
  } catch (_) {}
  return { report, text };
}

/**
 * Build report and copy plain text to the clipboard.
 * @returns {Promise<{ report: object, text: string, copied: boolean }>}
 */
export async function copyTileStreamingReportToClipboard() {
  const { report, text } = buildTileStreamingReportSnapshot();
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      log.warn('Tile streaming report clipboard copy failed', err);
    }
  }
  return { report, text, copied };
}

/**
 * Log report to console (collapsed group + tables). Stores last report on MapShine.
 * @returns {object} report
 */
export function logTileStreamingReport() {
  const { report, text } = buildTileStreamingReportSnapshot();
  const warnBadge = report.warnings.length ? ` ⚠ ${report.warnings.length} warning(s)` : '';
  console.groupCollapsed(
    `%cMap Shine Tile Streaming Report${warnBadge}`,
    report.warnings.length ? 'color:#f59e0b;font-weight:bold' : 'color:#22c55e;font-weight:bold',
  );
  console.log('Summary:', {
    scene: report.scene.name,
    mp: report.scene.sceneMp,
    zoom: report.scene.zoom,
    lod: report.scene.zoomLod,
    vram: `${report.budget.usedMB}/${report.budget.budgetMB} MB`,
    visibleMaxFloor: report.bus.visibleMaxFloorIndex,
    backgroundGrids: report.streaming.backgroundGridCount,
    viewTexturedCells: report.view.visibleCellsInFrustum,
  });
  if (report.warnings.length) {
    console.warn('Warnings:', report.warnings);
  }
  console.log('Budget:', report.budget);
  console.log('View:', report.view);
  for (const g of report.streaming.backgroundGrids) {
    console.groupCollapsed(`Background grid: ${g.key} (floor ${g.floorIndex})`);
    console.log('Grid:', {
      mounted: g.mounted,
      servedLod: g.servedLod,
      manifest: g.manifest,
      fallback: g.fallbackMesh,
      fallbackCells: g.fallbackCellCount,
      summary: g.cellSummary,
    });
    if (g.cells.length) console.table(g.cells);
    console.groupEnd();
  }
  for (const g of report.streaming.regionGrids) {
    console.groupCollapsed(`Region grid: ${g.key} (floor ${g.floorIndex})`);
    console.log('Grid:', { region: g.region, summary: g.cellSummary, fallback: g.fallbackMesh });
    if (g.cells.length) console.table(g.cells);
    console.groupEnd();
  }
  if (report.streaming.busStreamingTiles.length) {
    console.groupCollapsed('Bus streaming tile entries');
    console.table(report.streaming.busStreamingTiles);
    console.groupEnd();
  }
  console.log('Full report object → MapShine.lastTileStreamingReport');
  console.log('Plain text copy → MapShine.lastTileStreamingReportText');
  console.groupEnd();

  log.info('Tile streaming report generated', { warnings: report.warnings.length });
  return report;
}
