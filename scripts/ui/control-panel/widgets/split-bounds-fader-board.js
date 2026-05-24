/**
 * @fileoverview Vertical range faders (single track, min/max handles) for Dynamic bounds.
 * @module ui/control-panel/widgets/split-bounds-fader-board
 */

import { FADER_META } from './fader-board.js';

/** @type {ReadonlyArray<{ metaId: string, label: string, minKey: string, maxKey: string }>} */
export const BOUND_FADER_GROUPS = Object.freeze([
  { metaId: 'precipitation', label: 'Rain', minKey: 'precipitationMin', maxKey: 'precipitationMax' },
  { metaId: 'cloudCover', label: 'Clouds', minKey: 'cloudCoverMin', maxKey: 'cloudCoverMax' },
  { metaId: 'windSpeed', label: 'Wind', minKey: 'windSpeedMin', maxKey: 'windSpeedMax' },
  { metaId: 'fogDensity', label: 'Fog', minKey: 'fogDensityMin', maxKey: 'fogDensityMax' },
  { metaId: 'freezeLevel', label: 'Cold', minKey: 'freezeLevelMin', maxKey: 'freezeLevelMax' },
]);

const HANDLE_HALF_PX = 3;
const COLLAPSE_EPS = 0.008;

/**
 * @param {HTMLElement} container
 * @param {{
 *   readBound: (key: string) => number,
 *   writeBound: (key: string, value: number) => void,
 *   onBoundsChange: () => void,
 *   setContextHint?: (lines: string[]) => void,
 *   clearContextHint?: () => void,
 *   disabled?: boolean,
 * }} hooks
 */
export function createSplitBoundsFaderBoard(container, hooks) {
  const root = document.createElement('div');
  root.className = 'msa-cp-range-bounds-board';

  /** @type {Record<string, { sync: () => void }>} */
  const groups = {};

  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

  const readPair = (group) => ({
    min: clamp01(hooks.readBound(group.minKey)),
    max: clamp01(hooks.readBound(group.maxKey)),
  });

  const writePair = (group, min, max) => {
    let lo = clamp01(min);
    let hi = clamp01(max);
    if (lo > hi) {
      const t = lo;
      lo = hi;
      hi = t;
    }
    hooks.writeBound(group.minKey, lo);
    hooks.writeBound(group.maxKey, hi);
    hooks.onBoundsChange();
    return { min: lo, max: hi };
  };

  for (const group of BOUND_FADER_GROUPS) {
    const meta = FADER_META[group.metaId] || { icon: '◆', fill: 'rgba(90, 200, 250, 0.85)' };
    const groupEl = document.createElement('div');
    groupEl.className = 'msa-cp-range-bounds-board__group';

    const track = document.createElement('div');
    track.className = 'msa-cp-range-bounds-board__track';
    track.style.setProperty('--range-fill-color', meta.fill || 'rgba(90, 200, 250, 0.85)');

    const fill = document.createElement('div');
    fill.className = 'msa-cp-range-bounds-board__fill';

    const minHandle = document.createElement('div');
    minHandle.className = 'msa-cp-range-bounds-board__handle msa-cp-range-bounds-board__handle--min';
    minHandle.setAttribute('role', 'slider');
    minHandle.setAttribute('aria-label', `${group.label} minimum`);
    minHandle.setAttribute('aria-valuemin', '0');
    minHandle.setAttribute('aria-valuemax', '100');
    minHandle.tabIndex = hooks.disabled ? -1 : 0;

    const maxHandle = document.createElement('div');
    maxHandle.className = 'msa-cp-range-bounds-board__handle msa-cp-range-bounds-board__handle--max';
    maxHandle.setAttribute('role', 'slider');
    maxHandle.setAttribute('aria-label', `${group.label} maximum`);
    maxHandle.setAttribute('aria-valuemin', '0');
    maxHandle.setAttribute('aria-valuemax', '100');
    maxHandle.tabIndex = hooks.disabled ? -1 : 0;

    if (hooks.disabled) {
      minHandle.setAttribute('aria-disabled', 'true');
      maxHandle.setAttribute('aria-disabled', 'true');
    }

    track.appendChild(fill);
    track.appendChild(minHandle);
    track.appendChild(maxHandle);
    groupEl.appendChild(track);

    const icon = document.createElement('span');
    icon.className = 'msa-cp-range-bounds-board__icon';
    icon.textContent = meta.icon;
    icon.setAttribute('aria-hidden', 'true');
    groupEl.appendChild(icon);

    root.appendChild(groupEl);

    /** @type {'min'|'max'|null} */
    let dragRole = null;

    const syncVisuals = () => {
      const { min, max } = readPair(group);
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      const collapsed = Math.abs(hi - lo) <= COLLAPSE_EPS;

      fill.style.bottom = `${lo * 100}%`;
      fill.style.height = `${Math.max(0, hi - lo) * 100}%`;

      minHandle.style.bottom = `calc(${lo * 100}% - ${HANDLE_HALF_PX}px)`;
      maxHandle.style.bottom = `calc(${hi * 100}% - ${HANDLE_HALF_PX}px)`;
      minHandle.setAttribute('aria-valuenow', String(Math.round(lo * 100)));
      maxHandle.setAttribute('aria-valuenow', String(Math.round(hi * 100)));

      const atBottom = collapsed && lo <= COLLAPSE_EPS;
      const atTop = collapsed && hi >= 1 - COLLAPSE_EPS;

      minHandle.classList.toggle('is-hidden', atBottom);
      maxHandle.classList.toggle('is-hidden', atTop);
      minHandle.classList.toggle('is-collapsed', collapsed && !atBottom);
      maxHandle.classList.toggle('is-collapsed', collapsed && !atTop);
      track.classList.toggle('is-collapsed', collapsed);
    };

    const valueFromClientY = (clientY) => {
      const rect = track.getBoundingClientRect();
      if (rect.height <= 0) return 0;
      const pct = 1 - (clientY - rect.top) / rect.height;
      return clamp01(pct);
    };

    const pickRole = (clientY) => {
      const { min, max } = readPair(group);
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      const val = valueFromClientY(clientY);
      const rect = track.getBoundingClientRect();

      if (Math.abs(hi - lo) <= COLLAPSE_EPS) {
        if (lo <= COLLAPSE_EPS) return 'max';
        if (hi >= 1 - COLLAPSE_EPS) return 'min';
        return val >= lo ? 'max' : 'min';
      }

      const loY = rect.top + rect.height * (1 - lo);
      const hiY = rect.top + rect.height * (1 - hi);
      const distLo = Math.abs(clientY - loY);
      const distHi = Math.abs(clientY - hiY);
      return distLo <= distHi ? 'min' : 'max';
    };

    const setHint = () => {
      const { min, max } = readPair(group);
      hooks.setContextHint?.([
        `${group.label} range — ${Math.round(min * 100)}% to ${Math.round(max * 100)}%`,
        'Drag the lower handle for minimum, upper for maximum',
        'Lit band is the allowed evolution range',
      ]);
    };

    const beginDrag = (role, clientY) => {
      dragRole = role;
      track.classList.add('is-dragging');
      applyDrag(clientY);
    };

    const applyDrag = (clientY) => {
      if (!dragRole) return;
      const val = valueFromClientY(clientY);
      const cur = readPair(group);
      if (dragRole === 'min') writePair(group, val, cur.max);
      else writePair(group, cur.min, val);
      syncVisuals();
      setHint();
    };

    const endDrag = () => {
      dragRole = null;
      track.classList.remove('is-dragging');
    };

    track.addEventListener('pointerdown', (e) => {
      if (hooks.disabled) return;
      e.preventDefault();
      const role = pickRole(e.clientY);
      track.setPointerCapture(e.pointerId);
      beginDrag(role, e.clientY);
    });

    track.addEventListener('pointermove', (e) => {
      if (!dragRole) return;
      applyDrag(e.clientY);
    });

    track.addEventListener('pointerup', (e) => {
      if (!dragRole) return;
      try { track.releasePointerCapture(e.pointerId); } catch (_) {}
      endDrag();
    });

    track.addEventListener('pointercancel', () => endDrag());

    for (const handle of [minHandle, maxHandle]) {
      handle.addEventListener('pointerdown', (e) => {
        if (hooks.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        const role = handle.classList.contains('msa-cp-range-bounds-board__handle--min') ? 'min' : 'max';
        track.setPointerCapture(e.pointerId);
        beginDrag(role, e.clientY);
      });
    }

    track.addEventListener('pointerenter', setHint);
    track.addEventListener('pointerleave', () => hooks.clearContextHint?.());

    groups[group.metaId] = { sync: syncVisuals };
    syncVisuals();
  }

  function mirrorAllBounds() {
    for (const g of Object.values(groups)) g.sync();
  }

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

  container.appendChild(root);
  mirrorAllBounds();

  return { root, mirrorAllBounds, applyBounds };
}
