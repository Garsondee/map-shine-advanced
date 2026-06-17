/**
 * @fileoverview Level / elevation display helpers for Map Point Groups UI.
 * @module ui/map-point-level-binding-ui
 */

import { readV14SceneLevels } from '../foundry/levels-scene-flags.js';

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

  const palette = {
    ok: { bg: 'rgba(60, 120, 80, 0.35)', border: '#4a8a5a', text: '#b8e0c8' },
    global: { bg: 'rgba(120, 100, 40, 0.35)', border: '#9a8040', text: '#e8dcb0' },
    hidden: { bg: 'rgba(120, 60, 60, 0.35)', border: '#9a5050', text: '#e8c0c0' },
    unknown: { bg: 'rgba(120, 80, 40, 0.35)', border: '#a07030', text: '#ecd0a8' },
  };
  const p = palette[info.status] ?? palette.ok;
  const modeShort = info.mode === 'locked' ? escapeMapPointHtml(info.levelLabel) : 'All floors';
  const band = escapeMapPointHtml(info.bandText);
  const viewTag = info.mode === 'locked'
    ? (info.visibleOnActiveView ? ' · visible here' : ' · hidden here')
    : '';

  return `
    <span class="msa-mp-level-badge" title="${escapeMapPointHtml(info.hint || '')}" style="
      display: inline-block;
      margin-top: 3px;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 9px;
      line-height: 1.35;
      background: ${p.bg};
      border: 1px solid ${p.border};
      color: ${p.text};
      max-width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    ">${modeShort} (${band})${escapeMapPointHtml(viewTag)}</span>
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
      <div class="msa-mp-draw-level-stamp" style="
        background: #1a1a2e;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 4px;
        padding: 10px;
        margin-top: 8px;
        font-size: 10px;
        color: #aaa;
        line-height: 1.5;
      ">
        <div style="font-weight: bold; color: #ccc; margin-bottom: 4px;">
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
    <div class="msa-mp-draw-level-stamp" style="
      background: #142018;
      border: 1px solid rgba(90, 160, 110, 0.35);
      border-radius: 4px;
      padding: 10px;
      margin-top: 8px;
      font-size: 10px;
      color: #b8d0c0;
      line-height: 1.55;
    ">
      <div style="font-weight: bold; color: #d0ecd8; margin-bottom: 4px;">
        <i class="fas fa-layer-group"></i> New group will lock to this floor
      </div>
      <strong>${escapeMapPointHtml(stamp.label)}</strong>
      <span style="color: #8ab89a;">(elev ${escapeMapPointHtml(stamp.bandText)})</span>${escapeMapPointHtml(clipTxt)}
      <div style="margin-top: 6px; color: #8aa892;">
        Switch the scene level <em>before</em> drawing if you need points on another floor.
        Points store x/y only — floor ownership is saved on the group.
      </div>
    </div>
  `;
}

/**
 * Level binding editor block for the group edit dialog.
 * @param {import('../scene/map-points-manager.js').MapPointGroup} group
 * @param {ReturnType<typeof describeMapPointGroupLevelBinding>} info
 * @param {MapPointLevelOption[]} levelOptions
 * @returns {string}
 */
export function renderMapPointLevelBindingEditor(group, info, levelOptions) {
  const binding = group?.metadata?.levelBinding ?? {};
  const isLocked = info.mode === 'locked';
  const selectedLevelId = info.floorKey
    ?? info.matchedLevel?.levelId
    ?? '';

  const statusColors = {
    ok: '#8ecaa0',
    global: '#dcc890',
    hidden: '#d0a0a0',
    unknown: '#dcb080',
  };
  const statusColor = statusColors[info.status] ?? '#aaa';

  const levelRows = levelOptions.map((lvl) => {
    const band = formatMapPointElevationRange(lvl.bottom, lvl.top);
    const id = escapeMapPointHtml(lvl.levelId ?? '');
    const selected = (selectedLevelId && lvl.levelId === selectedLevelId) ? 'selected' : '';
    return `<option value="${id}" data-floor-index="${lvl.index}" ${selected}>${escapeMapPointHtml(lvl.label)} (elev ${escapeMapPointHtml(band)})</option>`;
  }).join('');

  return `
    <hr style="margin: 12px 0; border: none; border-top: 1px solid #444;">
    <div class="msa-mp-level-panel" style="background: #1a1a2e; padding: 10px; border-radius: 4px;">
      <div style="font-size: 11px; font-weight: bold; color: #ccc; margin-bottom: 8px;">
        <i class="fas fa-layer-group"></i> Floor / elevation binding
      </div>
      <p style="margin: 0 0 8px 0; font-size: 10px; color: #888; line-height: 1.45;">
        Map points only store <strong>x/y</strong>. This group’s floor assignment controls which level shows the effect and which walls block glow.
      </p>
      <div class="form-group" style="margin-bottom: 8px;">
        <label style="font-size: 11px;">Visibility</label>
        <select name="levelBindingMode" style="width: 100%;">
          <option value="all-levels" ${!isLocked ? 'selected' : ''}>All levels (global — legacy)</option>
          <option value="locked" ${isLocked ? 'selected' : ''}>Locked to one floor</option>
        </select>
      </div>
      <div class="form-group msa-mp-level-floor-row" style="margin-bottom: 8px; ${isLocked ? '' : 'display: none;'}">
        <label style="font-size: 11px;">Assigned floor</label>
        <select name="levelBindingFloor" style="width: 100%;">
          ${levelRows || '<option value="">No levels detected on this scene</option>'}
        </select>
        <button type="button" class="msa-mp-use-viewed-floor-btn" style="
          margin-top: 6px;
          padding: 4px 8px;
          font-size: 10px;
          background: #3a5a4a;
          border: none;
          border-radius: 3px;
          color: #ddd;
          cursor: pointer;
        ">
          <i class="fas fa-eye"></i> Use currently viewed floor
        </button>
      </div>
      <div class="msa-mp-level-summary" style="
        font-size: 10px;
        color: ${statusColor};
        line-height: 1.5;
        padding: 8px;
        border-radius: 3px;
        background: rgba(0,0,0,0.22);
      ">
        <div><strong>Band:</strong> ${escapeMapPointHtml(info.bandText)}</div>
        <div><strong>Wall-clip test elev:</strong> ${escapeMapPointHtml(info.clipElevationText)}</div>
        <div><strong>On current view:</strong> ${info.visibleOnActiveView ? 'Visible' : 'Hidden'}</div>
        ${info.hint ? `<div style="margin-top: 4px; color: #aaa;">${escapeMapPointHtml(info.hint)}</div>` : ''}
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
