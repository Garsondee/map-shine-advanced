/**
 * @fileoverview Dynamic bounds faders — same chunky vertical visuals as Manual mode,
 * with min/max handles, live state tick (draggable), and dashed preview while dragging bounds.
 * @module ui/control-panel/widgets/split-bounds-fader-board
 */

import { FADER_META } from './fader-board.js';
import { GUSTINESS_LABELS } from './astrolabe-dial.js';

/** @type {ReadonlyArray<{ metaId: string, label: string, minKey: string, maxKey: string, min: number, max: number, step: number }>} */
export const BOUND_FADER_GROUPS = Object.freeze([
  { metaId: 'precipitation', label: 'Rain', minKey: 'precipitationMin', maxKey: 'precipitationMax', min: 0, max: 1, step: 0.01 },
  { metaId: 'cloudCover', label: 'Clouds', minKey: 'cloudCoverMin', maxKey: 'cloudCoverMax', min: 0, max: 1, step: 0.01 },
  { metaId: 'freezeLevel', label: 'Cold (snow)', minKey: 'freezeLevelMin', maxKey: 'freezeLevelMax', min: 0, max: 1, step: 0.01 },
  { metaId: 'fogDensity', label: 'Fog', minKey: 'fogDensityMin', maxKey: 'fogDensityMax', min: 0, max: 1, step: 0.01 },
  { metaId: 'lightning', label: 'Lightning', minKey: 'lightningMin', maxKey: 'lightningMax', min: 0, max: 1, step: 0.01 },
  { metaId: 'ashIntensity', label: 'Ash', minKey: 'ashIntensityMin', maxKey: 'ashIntensityMax', min: 0, max: 1, step: 0.01 },
  { metaId: 'gustiness', label: 'Gust', minKey: 'gustinessMin', maxKey: 'gustinessMax', min: 0, max: GUSTINESS_LABELS.length - 1, step: 1 },
]);

const HANDLE_HALF_PX = 2.5;
const COLLAPSE_EPS = 0.008;
const LIVE_HIT_PX = 10;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clampRange(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {number} step
 */
function snapRange(value, min, max, step) {
  let v = clampRange(value, min, max);
  if (step > 0) v = Math.round(v / step) * step;
  return clampRange(v, min, max);
}

/**
 * @param {number} value
 * @param {{ min: number, max: number }} group
 */
function valueToPct(value, group) {
  const span = group.max - group.min;
  if (span <= 0) return 0;
  return clampRange((value - group.min) / span, 0, 1);
}

/**
 * @param {HTMLElement} el
 * @param {number} loPct
 * @param {number} hiPct
 */
function positionBandFill(el, loPct, hiPct) {
  const lo = Math.max(0, Math.min(1, loPct));
  const hi = Math.max(0, Math.min(1, hiPct));
  const bottom = Math.min(lo, hi);
  const top = Math.max(lo, hi);
  el.style.bottom = `${bottom * 100}%`;
  el.style.height = `${Math.max(0, top - bottom) * 100}%`;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   readBound: (key: string) => number,
 *   writeBound: (key: string, value: number) => void,
 *   onBoundsChange: () => void,
 *   onLiveValueInput?: (metaId: string, value: number) => void,
 *   onLiveValueCommit?: (metaId: string, value: number) => void,
 *   setContextHint?: (lines: string[]) => void,
 *   clearContextHint?: () => void,
 *   disabled?: boolean,
 * }} hooks
 */
export function createSplitBoundsFaderBoard(container, hooks) {
  const root = document.createElement('div');
  root.className = 'msa-cp-fader-board msa-cp-bounds-fader-board';
  root.style.setProperty('--fader-count', String(BOUND_FADER_GROUPS.length));

  const tracksRow = document.createElement('div');
  tracksRow.className = 'msa-cp-fader-board__tracks';

  const iconsRow = document.createElement('div');
  iconsRow.className = 'msa-cp-fader-board__icons';

  const liveDragEnabled = typeof hooks.onLiveValueInput === 'function';

  /** @type {Record<string, { sync: () => void, setLiveValue: (v: number|null) => void }>} */
  const groups = {};

  const readPair = (group) => {
    const min = snapRange(hooks.readBound(group.minKey), group.min, group.max, group.step);
    const max = snapRange(hooks.readBound(group.maxKey), group.min, group.max, group.step);
    return { min, max };
  };

  const clampLiveToBounds = (group, value) => {
    const pair = readPair(group);
    const lo = Math.min(pair.min, pair.max);
    const hi = Math.max(pair.min, pair.max);
    return snapRange(value, lo, hi, group.step);
  };

  const writePair = (group, min, max, notify = true) => {
    let lo = snapRange(min, group.min, group.max, group.step);
    let hi = snapRange(max, group.min, group.max, group.step);
    if (lo > hi) {
      const t = lo;
      lo = hi;
      hi = t;
    }
    hooks.writeBound(group.minKey, lo);
    hooks.writeBound(group.maxKey, hi);
    if (notify) hooks.onBoundsChange();
    return { min: lo, max: hi };
  };

  for (const group of BOUND_FADER_GROUPS) {
    const meta = FADER_META[group.metaId] || { icon: '◆', tint: 'neutral', fill: 'rgba(90, 200, 250, 0.9)' };

    const faderEl = document.createElement('div');
    faderEl.className = `msa-cp-fader msa-cp-fader--${meta.tint} msa-cp-fader--chunky msa-cp-fader--bounds`;
    faderEl.dataset.param = group.metaId;
    faderEl.style.setProperty('--fader-fill-color', meta.fill);

    const trackWrap = document.createElement('div');
    trackWrap.className = 'msa-cp-fader__track-wrap';

    const previewFill = document.createElement('div');
    previewFill.className = 'msa-cp-fader__preview-fill msa-cp-fader__bounds-preview';
    previewFill.hidden = true;

    const boundsFill = document.createElement('div');
    boundsFill.className = 'msa-cp-fader__bounds-fill';

    const liveMarker = document.createElement('div');
    liveMarker.className = 'msa-cp-fader__bounds-live';
    liveMarker.setAttribute('role', 'slider');
    liveMarker.setAttribute('aria-label', `${group.label} current value`);
    liveMarker.tabIndex = (hooks.disabled || !liveDragEnabled) ? -1 : 0;

    const minHandle = document.createElement('div');
    minHandle.className = 'msa-cp-fader__bounds-handle msa-cp-fader__bounds-handle--min';
    minHandle.setAttribute('role', 'slider');
    minHandle.setAttribute('aria-label', `${group.label} minimum`);
    minHandle.tabIndex = hooks.disabled ? -1 : 0;

    const maxHandle = document.createElement('div');
    maxHandle.className = 'msa-cp-fader__bounds-handle msa-cp-fader__bounds-handle--max';
    maxHandle.setAttribute('role', 'slider');
    maxHandle.setAttribute('aria-label', `${group.label} maximum`);
    maxHandle.tabIndex = hooks.disabled ? -1 : 0;

    if (hooks.disabled) {
      minHandle.setAttribute('aria-disabled', 'true');
      maxHandle.setAttribute('aria-disabled', 'true');
      liveMarker.setAttribute('aria-disabled', 'true');
    }

    trackWrap.appendChild(previewFill);
    trackWrap.appendChild(boundsFill);
    trackWrap.appendChild(liveMarker);
    trackWrap.appendChild(minHandle);
    trackWrap.appendChild(maxHandle);
    faderEl.appendChild(trackWrap);
    tracksRow.appendChild(faderEl);

    const icon = document.createElement('span');
    icon.className = 'msa-cp-fader__icon';
    icon.textContent = meta.icon;
    icon.setAttribute('aria-hidden', 'true');
    iconsRow.appendChild(icon);

    /** @type {'min'|'max'|'live'|null} */
    let dragRole = null;
    /** @type {{ min: number, max: number }|null} */
    let previewPair = null;
    /** @type {{ min: number, max: number }|null} */
    let committedPair = null;
    let liveValue = 0;
    let livePreview = null;

    const displayLiveValue = () => (
      livePreview !== null && Number.isFinite(livePreview) ? livePreview : liveValue
    );

    const formatPct = (value) => {
      if (group.metaId === 'gustiness') {
        const key = GUSTINESS_LABELS[Math.round(value)] || 'moderate';
        return key.charAt(0).toUpperCase() + key.slice(1);
      }
      const pct = Math.round(valueToPct(value, group) * 100);
      return `${pct}%`;
    };

    const syncVisuals = () => {
      const committed = committedPair || readPair(group);
      const display = previewPair || committed;
      const lo = Math.min(display.min, display.max);
      const hi = Math.max(display.min, display.max);
      const committedLo = Math.min(committed.min, committed.max);
      const committedHi = Math.max(committed.min, committed.max);
      const collapsed = Math.abs(hi - lo) <= COLLAPSE_EPS;
      const span = group.max - group.min || 1;
      const collapseNorm = COLLAPSE_EPS * span;

      positionBandFill(boundsFill, valueToPct(committedLo, group), valueToPct(committedHi, group));

      if (previewPair) {
        positionBandFill(previewFill, valueToPct(lo, group), valueToPct(hi, group));
        previewFill.hidden = false;
        faderEl.classList.add('has-preview');
      } else {
        previewFill.hidden = true;
        faderEl.classList.remove('has-preview');
      }

      const loPct = valueToPct(lo, group);
      const hiPct = valueToPct(hi, group);
      minHandle.style.bottom = `calc(${loPct * 100}% - ${HANDLE_HALF_PX}px)`;
      maxHandle.style.bottom = `calc(${hiPct * 100}% - ${HANDLE_HALF_PX}px)`;
      minHandle.setAttribute('aria-valuemin', String(group.min));
      minHandle.setAttribute('aria-valuemax', String(group.max));
      maxHandle.setAttribute('aria-valuemin', String(group.min));
      maxHandle.setAttribute('aria-valuemax', String(group.max));
      minHandle.setAttribute('aria-valuenow', String(display.min));
      maxHandle.setAttribute('aria-valuenow', String(display.max));

      const atBottom = collapsed && lo <= group.min + collapseNorm;
      const atTop = collapsed && hi >= group.max - collapseNorm;
      minHandle.classList.toggle('is-hidden', atBottom);
      maxHandle.classList.toggle('is-hidden', atTop);
      minHandle.classList.toggle('is-collapsed', collapsed && !atBottom);
      maxHandle.classList.toggle('is-collapsed', collapsed && !atTop);

      const liveVal = displayLiveValue();
      let livePct = valueToPct(liveVal, group);
      const committedLoPct = valueToPct(committedLo, group);
      const committedHiPct = valueToPct(committedHi, group);
      if (Math.abs(livePct - committedLoPct) < 0.035) {
        livePct = Math.min(1, committedLoPct + 0.035);
      } else if (Math.abs(livePct - committedHiPct) < 0.02) {
        livePct = Math.max(0, committedHiPct - 0.02);
      }
      liveMarker.style.bottom = `calc(${livePct * 100}% - 1.5px)`;
      liveMarker.hidden = false;
      liveMarker.setAttribute('aria-valuemin', String(committedLo));
      liveMarker.setAttribute('aria-valuemax', String(committedHi));
      liveMarker.setAttribute('aria-valuenow', String(liveVal));
      faderEl.classList.toggle('is-live-dragging', dragRole === 'live');
    };

    const setBoundsHint = (pair) => {
      const lo = Math.min(pair.min, pair.max);
      const hi = Math.max(pair.min, pair.max);
      hooks.setContextHint?.([
        `${group.label} range — ${formatPct(lo)} to ${formatPct(hi)}`,
        previewPair ? 'Release to apply · dashed band is preview' : 'Drag lower handle for minimum, upper for maximum',
        'Lit band is the allowed evolution range',
      ]);
    };

    const setLiveHint = (value) => {
      hooks.setContextHint?.([
        `${group.label} — ${formatPct(value)} now`,
        'Drag the white tick to set current weather within the lit band',
        'Min/max handles set evolution limits',
      ]);
    };

    const valueFromClientY = (clientY) => {
      const rect = trackWrap.getBoundingClientRect();
      if (rect.height <= 0) return group.min;
      const pct = 1 - (clientY - rect.top) / rect.height;
      return snapRange(group.min + pct * (group.max - group.min), group.min, group.max, group.step);
    };

    const liveYForValue = (value) => {
      const rect = trackWrap.getBoundingClientRect();
      return rect.top + rect.height * (1 - valueToPct(value, group));
    };

    const pickRole = (clientY) => {
      const liveVal = displayLiveValue();
      if (Math.abs(clientY - liveYForValue(liveVal)) <= LIVE_HIT_PX) return 'live';

      const cur = previewPair || readPair(group);
      const lo = Math.min(cur.min, cur.max);
      const hi = Math.max(cur.min, cur.max);
      const val = valueFromClientY(clientY);
      const rect = trackWrap.getBoundingClientRect();
      const channelSpan = group.max - group.min || 1;

      if (Math.abs(hi - lo) <= COLLAPSE_EPS * channelSpan) {
        if (lo <= group.min + COLLAPSE_EPS * channelSpan) return 'max';
        if (hi >= group.max - COLLAPSE_EPS * channelSpan) return 'min';
        return val >= lo ? 'max' : 'min';
      }

      const loY = rect.top + rect.height * (1 - valueToPct(lo, group));
      const hiY = rect.top + rect.height * (1 - valueToPct(hi, group));
      return Math.abs(clientY - loY) <= Math.abs(clientY - hiY) ? 'min' : 'max';
    };

    const beginBoundsDrag = (role, clientY) => {
      dragRole = role;
      committedPair = readPair(group);
      previewPair = { ...committedPair };
      faderEl.classList.add('is-dragging');
      applyBoundsDrag(clientY);
    };

    const applyBoundsDrag = (clientY) => {
      if (!dragRole || dragRole === 'live' || !previewPair || !committedPair) return;
      const val = valueFromClientY(clientY);
      if (dragRole === 'min') previewPair = { min: val, max: previewPair.max };
      else previewPair = { min: previewPair.min, max: val };
      syncVisuals();
      setBoundsHint(previewPair);
    };

    const beginLiveDrag = (clientY) => {
      dragRole = 'live';
      livePreview = clampLiveToBounds(group, displayLiveValue());
      faderEl.classList.add('is-dragging');
      applyLiveDrag(clientY);
    };

    const applyLiveDrag = (clientY) => {
      if (dragRole !== 'live') return;
      const val = clampLiveToBounds(group, valueFromClientY(clientY));
      livePreview = val;
      syncVisuals();
      setLiveHint(val);
      hooks.onLiveValueInput?.(group.metaId, val);
    };

    const cancelDrag = () => {
      const wasLive = dragRole === 'live';
      dragRole = null;
      previewPair = null;
      committedPair = null;
      livePreview = null;
      faderEl.classList.remove('is-dragging');
      faderEl.classList.remove('is-live-dragging');
      syncVisuals();
      if (wasLive) hooks.clearContextHint?.();
    };

    const endDrag = () => {
      if (dragRole === 'live') {
        if (livePreview !== null && Number.isFinite(livePreview)) {
          liveValue = livePreview;
          hooks.onLiveValueCommit?.(group.metaId, livePreview);
        }
        cancelDrag();
        return;
      }
      if (!dragRole || !previewPair) {
        cancelDrag();
        return;
      }
      writePair(group, previewPair.min, previewPair.max, true);
      cancelDrag();
    };

    trackWrap.addEventListener('pointerdown', (e) => {
      if (hooks.disabled) return;
      e.preventDefault();
      const role = pickRole(e.clientY);
      trackWrap.setPointerCapture(e.pointerId);
      if (role === 'live' && liveDragEnabled) beginLiveDrag(e.clientY);
      else beginBoundsDrag(role === 'live' ? 'max' : role, e.clientY);
    });

    trackWrap.addEventListener('pointermove', (e) => {
      if (!dragRole) return;
      if (dragRole === 'live') applyLiveDrag(e.clientY);
      else applyBoundsDrag(e.clientY);
    });

    trackWrap.addEventListener('pointerup', (e) => {
      if (!dragRole) return;
      try { trackWrap.releasePointerCapture(e.pointerId); } catch (_) {}
      endDrag();
    });

    trackWrap.addEventListener('pointercancel', () => cancelDrag());

    liveMarker.addEventListener('pointerdown', (e) => {
      if (hooks.disabled || !liveDragEnabled) return;
      e.preventDefault();
      e.stopPropagation();
      trackWrap.setPointerCapture(e.pointerId);
      beginLiveDrag(e.clientY);
    });

    for (const handle of [minHandle, maxHandle]) {
      handle.addEventListener('pointerdown', (e) => {
        if (hooks.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        const role = handle.classList.contains('msa-cp-fader__bounds-handle--min') ? 'min' : 'max';
        trackWrap.setPointerCapture(e.pointerId);
        beginBoundsDrag(role, e.clientY);
      });
    }

    trackWrap.addEventListener('pointerenter', () => setBoundsHint(readPair(group)));
    trackWrap.addEventListener('pointerleave', () => {
      if (!dragRole) hooks.clearContextHint?.();
    });

    liveMarker.addEventListener('pointerenter', () => setLiveHint(displayLiveValue()));
    liveMarker.addEventListener('pointerleave', () => {
      if (!dragRole) hooks.clearContextHint?.();
    });

    icon.addEventListener('pointerenter', () => setBoundsHint(readPair(group)));
    icon.addEventListener('pointerleave', () => hooks.clearContextHint?.());

    groups[group.metaId] = {
      sync: () => {
        if (dragRole) return;
        syncVisuals();
      },
      setLiveValue: (v) => {
        if (dragRole === 'live') return;
        liveValue = Number.isFinite(Number(v)) ? Number(v) : 0;
        syncVisuals();
      },
    };
    syncVisuals();
  }

  root.appendChild(tracksRow);
  root.appendChild(iconsRow);
  container.appendChild(root);

  function mirrorAllBounds() {
    for (const g of Object.values(groups)) g.sync();
  }

  /**
   * @param {Record<string, number>} bounds
   */
  function applyBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return;
    for (const group of BOUND_FADER_GROUPS) {
      const min = bounds[group.minKey];
      const max = bounds[group.maxKey];
      if (Number.isFinite(Number(min))) hooks.writeBound(group.minKey, Number(min));
      if (Number.isFinite(Number(max))) hooks.writeBound(group.maxKey, Number(max));
    }
    mirrorAllBounds();
  }

  /**
   * @param {Record<string, number|null|undefined>} values
   */
  function setLiveValues(values) {
    if (!values || typeof values !== 'object') return;
    for (const group of BOUND_FADER_GROUPS) {
      const v = values[group.metaId];
      groups[group.metaId]?.setLiveValue?.(
        v === null || v === undefined || !Number.isFinite(Number(v)) ? 0 : Number(v),
      );
    }
  }

  mirrorAllBounds();

  return { root, mirrorAllBounds, applyBounds, setLiveValues };
}
