/**
 * @fileoverview Level / elevation display helpers for Map Point Groups UI.
 * @module ui/map-point-level-binding-ui
 */

import { readV14SceneLevels } from '../foundry/levels-scene-flags.js';
import {
  MAP_POINT_RENDER_LAYER_ABOVE,
  MAP_POINT_RENDER_LAYER_BELOW,
} from '../scene/map-points-manager.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function escapeMapPointHtml(value) {
  try {
    return globalThis.foundry?.utils?.escapeHTML?.(String(value ?? '')) ?? String(value ?? '');
  } catch (_) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

/**
 * @typedef {{
 *   levelId: string|null,
 *   index: number,
 *   label: string,
 *   bottom: number,
 *   top: number,
 *   center: number,
 * }} MapPointLevelOption
 */

/**
 * Ordered scene level bands for floor pickers (V14 native → camera follower → floor stack).
 * @returns {MapPointLevelOption[]}
 */
export function getMapPointLevelOptions() {
  const scene = globalThis.canvas?.scene ?? null;
  const native = readV14SceneLevels(scene);
  if (native.length > 0) {
    return native.map((lvl, index) => ({
      levelId: lvl.levelId ?? null,
      index: Number.isFinite(Number(lvl.index)) ? Number(lvl.index) : index,
      label: String(lvl.label || `Level ${index + 1}`),
      bottom: Number(lvl.bottom),
      top: Number(lvl.top),
      center: Number(lvl.center),
    }));
  }

  const fromFollower = window.MapShine?.cameraFollower?.getAvailableLevels?.();
  if (Array.isArray(fromFollower) && fromFollower.length > 0) {
    return fromFollower.map((lvl, index) => ({
      levelId: lvl.levelId ?? null,
      index: Number.isFinite(Number(lvl.index)) ? Number(lvl.index) : index,
      label: String(lvl.label || `Level ${index + 1}`),
      bottom: Number(lvl.bottom),
      top: Number(lvl.top),
      center: Number(lvl.center),
    }));
  }

  const fromGlobal = window.MapShine?.availableLevels;
  if (Array.isArray(fromGlobal) && fromGlobal.length > 0) {
    return fromGlobal.map((lvl, index) => ({
      levelId: lvl.levelId ?? null,
      index: Number.isFinite(Number(lvl.index)) ? Number(lvl.index) : index,
      label: String(lvl.label || `Level ${index + 1}`),
      bottom: Number(lvl.bottom),
      top: Number(lvl.top),
      center: Number(lvl.center),
    }));
  }

  const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
  if (floors.length > 0) {
    return floors.map((f, index) => {
      const bottom = Number(f?.elevationMin);
      const top = Number(f?.elevationMax);
      const finiteBottom = Number.isFinite(bottom) ? bottom : 0;
      const finiteTop = Number.isFinite(top) ? top : finiteBottom;
      return {
        levelId: (typeof f?.levelId === 'string' && f.levelId) ? f.levelId : null,
        index: Number.isFinite(Number(f?.index)) ? Number(f.index) : index,
        label: `Floor ${index + 1}`,
        bottom: finiteBottom,
        top: Number.isFinite(top) ? top : Infinity,
        center: (finiteBottom + finiteTop) * 0.5,
      };
    });
  }

  return [];
}

/**
 * @param {number|null|undefined} bottom
 * @param {number|null|undefined} top
 * @returns {string}
 */
export function formatMapPointElevationRange(bottom, top) {
  const b = Number(bottom);
  const bTxt = Number.isFinite(b) ? String(b) : '−∞';
  if (top === Infinity || top === null || top === undefined) return `${bTxt} – ∞`;
  const t = Number(top);
  const tTxt = Number.isFinite(t) ? String(t) : '∞';
  return `${bTxt} – ${tTxt}`;
}

/**
 * Approximate wall-clip test height inside a half-open [bottom, top) band.
 * @param {number|null|undefined} bottom
 * @param {number|null|undefined} top
 * @returns {number|null}
 */
export function estimateMapPointClipElevation(bottom, top) {
  const lo = Number(bottom);
  if (!Number.isFinite(lo)) return null;
  if (top === Infinity || top === null || top === undefined) return lo + 1;
  const hi = Number(top);
  if (!Number.isFinite(hi) || !(hi > lo)) return lo + 0.5;
  return lo + Math.min(Math.max((hi - lo) * 0.5, 0.5), hi - lo - 0.01);
}

/**
 * @param {import('../scene/map-points-manager.js').MapPointGroup|null|undefined} group
 * @param {any|null} [activeContext]
 * @param {MapPointLevelOption[]} [levelOptions]
 * @returns {{
 *   mode: 'all-levels'|'locked',
 *   levelLabel: string,
 *   bandText: string,
 *   clipElevationText: string,
 *   floorKey: string|null,
 *   matchedLevel: MapPointLevelOption|null,
 *   visibleOnActiveView: boolean,
 *   isMultiFloorScene: boolean,
 *   status: 'global'|'ok'|'hidden'|'unknown',
 *   hint: string|null,
 * }}
 */
export function describeMapPointGroupLevelBinding(
  group,
  activeContext = null,
  levelOptions = getMapPointLevelOptions(),
) {
  const ctx = activeContext ?? window.MapShine?.activeLevelContext ?? null;
  const isMultiFloorScene = (ctx?.count ?? 0) > 1 || levelOptions.length > 1;
  const binding = group?.metadata?.levelBinding ?? null;
  const mode = binding?.mode === 'locked' ? 'locked' : 'all-levels';

  if (mode !== 'locked') {
    return {
      mode: 'all-levels',
      levelLabel: 'All levels',
      bandText: 'Every floor',
      clipElevationText: 'Uses viewed floor',
      floorKey: null,
      matchedLevel: null,
      visibleOnActiveView: true,
      isMultiFloorScene,
      status: isMultiFloorScene ? 'global' : 'ok',
      hint: isMultiFloorScene
        ? 'Visible on every floor. Effects and wall clipping follow whichever level you are currently viewing.'
        : null,
    };
  }

  const bottom = Number(binding?.bottom);
  const topRaw = binding?.top;
  const top = Number.isFinite(Number(topRaw)) ? Number(topRaw) : Infinity;
  const floorKey = (typeof binding?.floorKey === 'string' && binding.floorKey.length > 0)
    ? binding.floorKey
    : null;

  let matchedLevel = null;
  if (floorKey) {
    matchedLevel = levelOptions.find((l) => l.levelId === floorKey) ?? null;
  }
  if (!matchedLevel && Number.isFinite(bottom)) {
    matchedLevel = levelOptions.find((l) => {
      const lo = Math.min(Number(l.bottom), Number.isFinite(Number(l.top)) ? Number(l.top) : Number(l.bottom));
      const hi = Number.isFinite(Number(l.top)) ? Math.max(Number(l.bottom), Number(l.top)) : Infinity;
      const bindLo = Math.min(bottom, Number.isFinite(top) ? top : bottom);
      const bindHi = Number.isFinite(top) ? Math.max(bottom, top) : Infinity;
      return !(bindHi < lo || bindLo > hi);
    }) ?? null;
  }

  const levelLabel = matchedLevel?.label
    ?? (Number.isFinite(bottom) ? `Elev ${formatMapPointElevationRange(bottom, topRaw ?? top)}` : 'Locked (unknown band)');

  const clipElev = estimateMapPointClipElevation(bottom, topRaw ?? top);
  const clipElevationText = Number.isFinite(Number(clipElev)) ? `≈ ${Number(clipElev).toFixed(1)}` : '—';

  let visibleOnActiveView = true;
  if (isMultiFloorScene && typeof group === 'object') {
    visibleOnActiveView = _groupOverlapsContext(binding, ctx);
  }

  let status = 'ok';
  let hint = null;
  if (!matchedLevel && isMultiFloorScene) {
    status = 'unknown';
    hint = 'Elevation band does not match a known scene level. Re-assign a floor below.';
  } else if (!visibleOnActiveView) {
    status = 'hidden';
    const viewLabel = ctx?.label ?? 'the current level';
    hint = `Hidden while viewing “${viewLabel}”. Switch levels in the scene bar to see or edit these points.`;
  } else if (isMultiFloorScene) {
    hint = 'Only visible (and wall-clipped) on the assigned floor unless you change level binding.';
  }

  return {
    mode: 'locked',
    levelLabel,
    bandText: formatMapPointElevationRange(bottom, topRaw ?? top),
    clipElevationText,
    floorKey,
    matchedLevel,
    visibleOnActiveView,
    isMultiFloorScene,
    status,
    hint,
  };
}

/**
 * @param {{mode?:string,bottom?:number|null,top?:number|null,floorKey?:string|null}} binding
 * @param {any|null} ctx
 * @returns {boolean}
 */
function _groupOverlapsContext(binding, ctx) {
  if (!ctx || (ctx.count ?? 0) <= 1) return true;
  if (!binding || binding.mode !== 'locked') return true;

  const ctxLevelId = (typeof ctx?.levelId === 'string' && ctx.levelId.length > 0) ? ctx.levelId : null;
  if (binding.floorKey && ctxLevelId) return binding.floorKey === ctxLevelId;

  const b0 = Number(binding.bottom);
  const t0 = Number(binding.top ?? binding.bottom);
  const b1 = Number(ctx?.bottom);
  const t1 = Number(ctx?.top);
  if (Number.isFinite(b0) && Number.isFinite(t0) && Number.isFinite(b1) && Number.isFinite(t1)) {
    const min0 = Math.min(b0, t0);
    const max0 = Math.max(b0, t0);
    const min1 = Math.min(b1, t1);
    const max1 = Math.max(b1, t1);
    return !(max0 < min1 || min0 > max1);
  }
  return true;
}

/**
 * @param {any|null} [activeContext]
 * @returns {{ label: string, bandText: string, levelId: string|null, isMultiFloor: boolean }}
 */
export function describeActiveMapPointLevelStamp(activeContext = null) {
  const ctx = activeContext ?? window.MapShine?.activeLevelContext ?? null;
  const levels = getMapPointLevelOptions();
  const isMultiFloor = (ctx?.count ?? 0) > 1 || levels.length > 1;

  if (!ctx || !isMultiFloor) {
    return {
      label: 'Single-level scene',
      bandText: Number.isFinite(Number(ctx?.bottom))
        ? formatMapPointElevationRange(ctx.bottom, ctx?.top)
        : 'Ground',
      levelId: ctx?.levelId ?? null,
      isMultiFloor: false,
    };
  }

  const label = String(ctx.label || `Level ${(Number(ctx.index) || 0) + 1}`);
  const bandText = formatMapPointElevationRange(ctx.bottom, ctx?.top);
  return {
    label,
    bandText,
    levelId: ctx.levelId ?? null,
    isMultiFloor: true,
  };
}

/**
 * Compact HTML badge for list rows.
 * @param {ReturnType<typeof describeMapPointGroupLevelBinding>} info
 * @returns {string}
 */
export function renderMapPointLevelListBadge(info) {
  if (!info?.isMultiFloorScene) return '';

  const statusClass = {
    ok: 'msa-mp-level-badge--ok',
    global: 'msa-mp-level-badge--global',
    hidden: 'msa-mp-level-badge--hidden',
    unknown: 'msa-mp-level-badge--unknown',
  }[info.status] ?? 'msa-mp-level-badge--ok';

  const modeShort = info.mode === 'locked' ? escapeMapPointHtml(info.levelLabel) : 'All floors';
  const band = escapeMapPointHtml(info.bandText);
  const viewTag = info.mode === 'locked'
    ? (info.visibleOnActiveView ? ' · visible here' : ' · hidden here')
    : '';

  return `
    <span class="msa-mp-level-badge ${statusClass}" title="${escapeMapPointHtml(info.hint || '')}">
      ${modeShort} (${band})${escapeMapPointHtml(viewTag)}
    </span>
  `;
}

/**
 * Stamp shown when drawing new groups.
 * @param {any|null} [activeContext]
 * @returns {string}
 */
export function renderMapPointDrawLevelStamp(activeContext = null) {
  const stamp = describeActiveMapPointLevelStamp(activeContext);
  if (!stamp.isMultiFloor) {
    return `
      <div class="msa-mp-draw-level-stamp">
        <div class="msa-mp-draw-level-stamp__title">
          <i class="fas fa-layer-group"></i> Floor / elevation
        </div>
        Single-level scene — new groups are not floor-locked.
      </div>
    `;
  }

  const clip = estimateMapPointClipElevation(
    Number(window.MapShine?.activeLevelContext?.bottom),
    window.MapShine?.activeLevelContext?.top,
  );
  const clipTxt = Number.isFinite(Number(clip)) ? ` Wall-clip test height ≈ ${Number(clip).toFixed(1)}.` : '';

  return `
    <div class="msa-mp-draw-level-stamp msa-mp-draw-level-stamp--multi">
      <div class="msa-mp-draw-level-stamp__title">
        <i class="fas fa-layer-group"></i> New group will lock to this floor
      </div>
      <strong>${escapeMapPointHtml(stamp.label)}</strong>
      <span class="msa-mp-draw-level-stamp__band">(elev ${escapeMapPointHtml(stamp.bandText)})</span>${escapeMapPointHtml(clipTxt)}
      <div class="msa-mp-draw-level-stamp__note">
        Switch the scene level <em>before</em> drawing if you need points on another floor.
        Points store x/y only — floor ownership is saved on the group.
      </div>
    </div>
  `;
}

/**
 * Whether a map-point effect supports overhead render-layer placement.
 * @param {string|null|undefined} effectTarget
 * @returns {boolean}
 */
export function mapPointEffectSupportsRenderLayer(effectTarget) {
  return effectTarget === 'candleFlame' || effectTarget === 'fire';
}

/**
 * Render-layer picker for candle / fire groups (below vs on overhead art).
 * @param {import('../scene/map-points-manager.js').MapPointGroup|string|null|undefined} groupOrEffectTarget
 * @param {'below-overhead'|'above-overhead'|null|undefined} [currentRenderLayer]
 * @returns {string}
 */
export function renderMapPointRenderLayerEditor(groupOrEffectTarget, currentRenderLayer = undefined) {
  const effectTarget = (typeof groupOrEffectTarget === 'object' && groupOrEffectTarget !== null)
    ? groupOrEffectTarget.effectTarget
    : groupOrEffectTarget;
  if (!mapPointEffectSupportsRenderLayer(effectTarget)) return '';

  const fromGroup = (typeof groupOrEffectTarget === 'object' && groupOrEffectTarget !== null)
    ? groupOrEffectTarget?.metadata?.renderLayer
    : undefined;
  const resolved = currentRenderLayer ?? fromGroup;
  const current = resolved === MAP_POINT_RENDER_LAYER_ABOVE
    ? MAP_POINT_RENDER_LAYER_ABOVE
    : MAP_POINT_RENDER_LAYER_BELOW;

  const belowHelp = 'Glow stays under ceiling / overhead art. Best for candles on tables and ground-level fire.';
  const aboveHelp = 'Glow reaches ground and overhead tiles. Best for hanging candelabra and chandeliers.';

  return `
    <div class="msa-mp-panel msa-mp-panel--muted msa-mp-render-layer-panel-inner">
      <h4 class="msa-mp-section__title"><i class="fas fa-layer-group"></i> Layer vs overhead</h4>
      <div class="form-group msa-mp-render-layer-row">
        <label title="Controls flame draw order and roof / overhead glow blocking">Draw band</label>
        <select name="renderLayer" title="${escapeMapPointHtml(belowHelp)} / ${escapeMapPointHtml(aboveHelp)}">
          <option value="${MAP_POINT_RENDER_LAYER_BELOW}" title="${escapeMapPointHtml(belowHelp)}" ${current === MAP_POINT_RENDER_LAYER_BELOW ? 'selected' : ''}>
            Below overhead
          </option>
          <option value="${MAP_POINT_RENDER_LAYER_ABOVE}" title="${escapeMapPointHtml(aboveHelp)}" ${current === MAP_POINT_RENDER_LAYER_ABOVE ? 'selected' : ''}>
            On overhead layer
          </option>
        </select>
        <p class="msa-mp-hint msa-mp-render-layer-hint">
          <strong>Below overhead:</strong> glow does not brighten ceiling art.
          <strong>On overhead layer:</strong> glow reaches hanging fixtures and overhead stamps.
        </p>
      </div>
    </div>
  `;
}

/**
 * @param {JQuery} html
 * @param {string|null|undefined} [effectTarget]
 * @returns {'below-overhead'|'above-overhead'|undefined}
 */
export function readMapPointRenderLayerFromForm(html, effectTarget = null) {
  if (!mapPointEffectSupportsRenderLayer(effectTarget)) return undefined;
  const raw = String(html.find('[name="renderLayer"]').val() ?? MAP_POINT_RENDER_LAYER_BELOW);
  return raw === MAP_POINT_RENDER_LAYER_ABOVE
    ? MAP_POINT_RENDER_LAYER_ABOVE
    : MAP_POINT_RENDER_LAYER_BELOW;
}

/**
 * Level binding editor block for the group edit dialog.
 * @param {import('../scene/map-points-manager.js').MapPointGroup} group
 * @param {ReturnType<typeof describeMapPointGroupLevelBinding>} info
 * @param {MapPointLevelOption[]} levelOptions
 * @returns {string}
 */
export function renderMapPointLevelBindingEditor(group, info, levelOptions) {
  const isLocked = info.mode === 'locked';
  const selectedLevelId = info.floorKey
    ?? info.matchedLevel?.levelId
    ?? '';

  const statusClass = {
    ok: 'msa-mp-level-summary--ok',
    global: 'msa-mp-level-summary--global',
    hidden: 'msa-mp-level-summary--hidden',
    unknown: 'msa-mp-level-summary--unknown',
  }[info.status] ?? 'msa-mp-level-summary--ok';

  const levelRows = levelOptions.map((lvl) => {
    const band = formatMapPointElevationRange(lvl.bottom, lvl.top);
    const id = escapeMapPointHtml(lvl.levelId ?? '');
    const selected = (selectedLevelId && lvl.levelId === selectedLevelId) ? 'selected' : '';
    const title = escapeMapPointHtml(`${lvl.label} — elevation ${band}`);
    return `<option value="${id}" data-floor-index="${lvl.index}" title="${title}" ${selected}>${escapeMapPointHtml(lvl.label)}</option>`;
  }).join('');

  return `
    <div class="msa-mp-panel msa-mp-panel--muted msa-mp-level-panel">
      <h4 class="msa-mp-section__title"><i class="fas fa-layer-group"></i> Floor / elevation</h4>
      <p class="msa-mp-hint">
        Points store <strong>x/y</strong> only. Floor binding controls visibility and wall clipping.
      </p>
      <div class="form-group">
        <label title="Whether this group appears on every floor or one assigned floor">Visibility</label>
        <select name="levelBindingMode">
          <option value="all-levels" title="Visible on every floor; wall clip follows viewed level" ${!isLocked ? 'selected' : ''}>All levels (global)</option>
          <option value="locked" title="Only visible on the assigned floor" ${isLocked ? 'selected' : ''}>Locked to one floor</option>
        </select>
      </div>
      <div class="form-group msa-mp-level-floor-row" style="${isLocked ? '' : 'display: none;'}">
        <label title="Scene floor band used for visibility and wall clipping">Assigned floor</label>
        <select name="levelBindingFloor" title="Elevation band shown in tooltip on each option">
          ${levelRows || '<option value="">No levels detected on this scene</option>'}
        </select>
        <button type="button" class="msa-mp-btn msa-mp-btn--primary msa-mp-use-viewed-floor-btn" title="Lock this group to the floor you are currently viewing">
          <i class="fas fa-eye"></i> Use viewed floor
        </button>
      </div>
      <div class="msa-mp-level-summary ${statusClass}">
        <div><strong>Band:</strong> ${escapeMapPointHtml(info.bandText)}</div>
        <div><strong>Wall-clip test elev:</strong> ${escapeMapPointHtml(info.clipElevationText)}</div>
        <div><strong>On current view:</strong> ${info.visibleOnActiveView ? 'Visible' : 'Hidden'}</div>
        ${info.hint ? `<div class="msa-mp-level-summary__hint">${escapeMapPointHtml(info.hint)}</div>` : ''}
      </div>
    </div>
  `;
}

/**
 * Parse level-binding fields from an edit dialog form.
 * @param {JQuery} html
 * @returns {{ mode: 'all-levels'|'locked', levelId: string|null }}
 */
export function readMapPointLevelBindingFromForm(html) {
  const modeRaw = String(html.find('[name="levelBindingMode"]').val() ?? 'all-levels');
  const mode = modeRaw === 'locked' ? 'locked' : 'all-levels';
  if (mode !== 'locked') {
    return { mode: 'all-levels', levelId: null };
  }
  const levelId = String(html.find('[name="levelBindingFloor"]').val() ?? '').trim();
  return { mode: 'locked', levelId: levelId || null };
}
