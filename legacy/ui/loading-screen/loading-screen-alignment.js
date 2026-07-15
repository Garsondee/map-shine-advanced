/**
 * @fileoverview Snap targets, smart guides, and batch align/distribute for the Loading Screen Composer.
 * @module ui/loading-screen/loading-screen-alignment
 */

export const SNAP_STRENGTH = {
  tight: 0.2,
  normal: 0.35,
  loose: 0.55,
};

export const ALIGNMENT_PREFS_KEY = 'ms-lsd-alignment-prefs';

/**
 * @returns {{ snapEnabled: boolean, axesEnabled: boolean, snapStrength: string }}
 */
export function loadAlignmentPrefs() {
  try {
    const raw = sessionStorage.getItem(ALIGNMENT_PREFS_KEY);
    if (!raw) return { snapEnabled: true, axesEnabled: false, snapStrength: 'normal' };
    const parsed = JSON.parse(raw);
    return {
      snapEnabled: parsed?.snapEnabled !== false,
      axesEnabled: !!parsed?.axesEnabled,
      snapStrength: SNAP_STRENGTH[parsed?.snapStrength] ? String(parsed.snapStrength) : 'normal',
    };
  } catch (_) {
    return { snapEnabled: true, axesEnabled: false, snapStrength: 'normal' };
  }
}

/**
 * @param {{ snapEnabled?: boolean, axesEnabled?: boolean, snapStrength?: string }} prefs
 */
export function saveAlignmentPrefs(prefs) {
  try {
    sessionStorage.setItem(ALIGNMENT_PREFS_KEY, JSON.stringify({
      snapEnabled: prefs?.snapEnabled !== false,
      axesEnabled: !!prefs?.axesEnabled,
      snapStrength: SNAP_STRENGTH[prefs?.snapStrength] ? String(prefs.snapStrength) : 'normal',
    }));
  } catch (_) {
    /* sessionStorage unavailable */
  }
}

/**
 * @param {string} strength
 * @returns {number}
 */
export function snapThresholdForStrength(strength) {
  return SNAP_STRENGTH[String(strength || 'normal')] ?? SNAP_STRENGTH.normal;
}

/**
 * @param {object} options
 * @param {object} options.layout
 * @param {string|null} [options.draggingId]
 * @param {boolean} [options.includePanel=true]
 * @returns {{ x: number[], y: number[] }}
 */
export function buildSnapTargets({ layout, draggingId = null, includePanel = true }) {
  const xTargets = new Set([50]);
  const yTargets = new Set([50]);

  if (includePanel && layout?.panel) {
    xTargets.add(clampPct(num(layout.panel.x, 50)));
    yTargets.add(clampPct(num(layout.panel.y, 50)));
  }

  const elements = Array.isArray(layout?.elements) ? layout.elements : [];
  for (const el of elements) {
    if (!el?.id || el.visible === false) continue;
    if (draggingId && String(el.id) === String(draggingId)) continue;
    xTargets.add(clampPct(num(el.position?.x, 50)));
    yTargets.add(clampPct(num(el.position?.y, 50)));
  }

  return {
    x: [...xTargets].sort((a, b) => a - b),
    y: [...yTargets].sort((a, b) => a - b),
  };
}

/**
 * @param {number} value
 * @param {number[]} targets
 * @param {number} thresholdPct
 * @returns {{ value: number, snapped: boolean, target: number|null }}
 */
export function resolveSnap(value, targets, thresholdPct) {
  const v = Number(value);
  const threshold = Math.max(0, Number(thresholdPct) || 0);
  if (!Number.isFinite(v) || threshold <= 0) return { value: v, snapped: false, target: null };

  let best = null;
  let bestDist = Infinity;
  for (const target of targets || []) {
    const t = Number(target);
    if (!Number.isFinite(t)) continue;
    const dist = Math.abs(v - t);
    if (dist <= threshold && dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  }

  if (best == null) return { value: v, snapped: false, target: null };
  return { value: best, snapped: true, target: best };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {{ x: number[], y: number[] }} targets
 * @param {number} thresholdPct
 * @returns {{ x: number, y: number, guides: { vertical?: number, horizontal?: number } }}
 */
export function resolveAxisSnap(x, y, targets, thresholdPct) {
  const snapX = resolveSnap(x, targets?.x || [], thresholdPct);
  const snapY = resolveSnap(y, targets?.y || [], thresholdPct);
  const guides = {};
  if (snapX.snapped) guides.vertical = snapX.value;
  if (snapY.snapped) guides.horizontal = snapY.value;
  return {
    x: snapX.value,
    y: snapY.value,
    guides,
  };
}

/**
 * @param {number} pct
 * @param {number} axisLength
 * @returns {number}
 */
export function pctToPx(pct, axisLength) {
  return (Number(pct) / 100) * Math.max(1, Number(axisLength) || 1);
}

/**
 * @param {number} px
 * @param {number} axisLength
 * @returns {number}
 */
export function pxToPct(px, axisLength) {
  return (Number(px) / Math.max(1, Number(axisLength) || 1)) * 100;
}

/**
 * @param {DOMRect} rect
 * @param {DOMRect} layerRect
 * @returns {{ left: number, top: number, right: number, bottom: number, width: number, height: number, centerX: number, centerY: number }}
 */
export function rectRelativeToLayer(rect, layerRect) {
  const left = rect.left - layerRect.left;
  const top = rect.top - layerRect.top;
  const width = rect.width;
  const height = rect.height;
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    centerX: left + width / 2,
    centerY: top + height / 2,
  };
}

/**
 * @param {object} position
 * @param {number} dxPct
 * @param {number} dyPct
 */
export function applyPositionDeltaPct(position, dxPct, dyPct) {
  if (!position) return;
  position.x = clampPct(num(position.x, 50) + Number(dxPct || 0));
  position.y = clampPct(num(position.y, 50) + Number(dyPct || 0));
}

/**
 * @param {Array<{ element: object, rect: ReturnType<typeof rectRelativeToLayer> }>} entries
 * @param {number} layerWidth
 * @param {number} layerHeight
 * @param {'left'|'center'|'right'|'top'|'middle'|'bottom'} mode
 */
export function alignEntries(entries, layerWidth, layerHeight, mode) {
  if (!entries?.length || entries.length < 2) return;

  const getEdge = (entry, edge) => {
    const r = entry.rect;
    if (edge === 'left') return r.left;
    if (edge === 'right') return r.right;
    if (edge === 'top') return r.top;
    if (edge === 'bottom') return r.bottom;
    if (edge === 'centerX') return r.centerX;
    return r.centerY;
  };

  let target;
  if (mode === 'left') target = Math.min(...entries.map((e) => getEdge(e, 'left')));
  else if (mode === 'right') target = Math.max(...entries.map((e) => getEdge(e, 'right')));
  else if (mode === 'center') target = entries.reduce((s, e) => s + e.rect.centerX, 0) / entries.length;
  else if (mode === 'top') target = Math.min(...entries.map((e) => getEdge(e, 'top')));
  else if (mode === 'bottom') target = Math.max(...entries.map((e) => getEdge(e, 'bottom')));
  else if (mode === 'middle') target = entries.reduce((s, e) => s + e.rect.centerY, 0) / entries.length;
  else return;

  for (const entry of entries) {
    let dxPx = 0;
    let dyPx = 0;
    if (mode === 'left') dxPx = target - entry.rect.left;
    else if (mode === 'right') dxPx = target - entry.rect.right;
    else if (mode === 'center') dxPx = target - entry.rect.centerX;
    else if (mode === 'top') dyPx = target - entry.rect.top;
    else if (mode === 'bottom') dyPx = target - entry.rect.bottom;
    else if (mode === 'middle') dyPx = target - entry.rect.centerY;

    applyPositionDeltaPct(
      entry.element.position,
      pxToPct(dxPx, layerWidth),
      pxToPct(dyPx, layerHeight),
    );
  }
}

/**
 * @param {Array<{ element: object, rect: ReturnType<typeof rectRelativeToLayer> }>} entries
 * @param {number} layerWidth
 * @param {number} layerHeight
 * @param {'horizontal'|'vertical'} axis
 */
export function distributeEntries(entries, layerWidth, layerHeight, axis) {
  if (!entries?.length || entries.length < 2) return;

  const sorted = [...entries].sort((a, b) => (
    axis === 'horizontal' ? a.rect.left - b.rect.left : a.rect.top - b.rect.top
  ));

  if (sorted.length === 2) {
    const first = sorted[0];
    const second = sorted[1];
    if (axis === 'horizontal') {
      const bboxLeft = Math.min(first.rect.left, second.rect.left);
      const bboxRight = Math.max(first.rect.right, second.rect.right);
      const totalWidth = first.rect.width + second.rect.width;
      const gap = Math.max(0, bboxRight - bboxLeft - totalWidth);
      const targetFirstLeft = bboxLeft;
      const targetSecondLeft = bboxLeft + first.rect.width + gap;
      applyPositionDeltaPct(first.element.position, pxToPct(targetFirstLeft - first.rect.left, layerWidth), 0);
      applyPositionDeltaPct(second.element.position, pxToPct(targetSecondLeft - second.rect.left, layerWidth), 0);
    } else {
      const bboxTop = Math.min(first.rect.top, second.rect.top);
      const bboxBottom = Math.max(first.rect.bottom, second.rect.bottom);
      const totalHeight = first.rect.height + second.rect.height;
      const gap = Math.max(0, bboxBottom - bboxTop - totalHeight);
      const targetFirstTop = bboxTop;
      const targetSecondTop = bboxTop + first.rect.height + gap;
      applyPositionDeltaPct(first.element.position, 0, pxToPct(targetFirstTop - first.rect.top, layerHeight));
      applyPositionDeltaPct(second.element.position, 0, pxToPct(targetSecondTop - second.rect.top, layerHeight));
    }
    return;
  }

  if (axis === 'horizontal') {
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const span = last.rect.right - first.rect.left;
    const totalWidth = sorted.reduce((s, e) => s + e.rect.width, 0);
    const gap = (span - totalWidth) / (sorted.length - 1);
    let cursor = first.rect.left + first.rect.width + gap;
    for (let i = 1; i < sorted.length - 1; i++) {
      const entry = sorted[i];
      const dxPx = cursor - entry.rect.left;
      applyPositionDeltaPct(entry.element.position, pxToPct(dxPx, layerWidth), 0);
      cursor += entry.rect.width + gap;
    }
  } else {
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const span = last.rect.bottom - first.rect.top;
    const totalHeight = sorted.reduce((s, e) => s + e.rect.height, 0);
    const gap = (span - totalHeight) / (sorted.length - 1);
    let cursor = first.rect.top + first.rect.height + gap;
    for (let i = 1; i < sorted.length - 1; i++) {
      const entry = sorted[i];
      const dyPx = cursor - entry.rect.top;
      applyPositionDeltaPct(entry.element.position, 0, pxToPct(dyPx, layerHeight));
      cursor += entry.rect.height + gap;
    }
  }
}

/**
 * @param {Array<{ element: object, rect: ReturnType<typeof rectRelativeToLayer> }>} entries
 * @param {number} layerWidth
 * @param {number} layerHeight
 * @param {{ x: number, y: number }} targetCenterPct
 */
export function centerEntriesOn(entries, layerWidth, layerHeight, targetCenterPct) {
  if (!entries?.length) return;

  const minLeft = Math.min(...entries.map((e) => e.rect.left));
  const maxRight = Math.max(...entries.map((e) => e.rect.right));
  const minTop = Math.min(...entries.map((e) => e.rect.top));
  const maxBottom = Math.max(...entries.map((e) => e.rect.bottom));

  const currentCenterXPx = (minLeft + maxRight) / 2;
  const currentCenterYPx = (minTop + maxBottom) / 2;
  const targetCenterXPx = pctToPx(targetCenterPct.x, layerWidth);
  const targetCenterYPx = pctToPx(targetCenterPct.y, layerHeight);

  const dxPct = pxToPct(targetCenterXPx - currentCenterXPx, layerWidth);
  const dyPct = pxToPct(targetCenterYPx - currentCenterYPx, layerHeight);

  for (const entry of entries) {
    applyPositionDeltaPct(entry.element.position, dxPct, dyPct);
  }
}

function num(v, fallback) {
  return Number.isFinite(v) ? Number(v) : fallback;
}

function clampPct(v) {
  return Math.max(0, Math.min(100, Number(v)));
}
