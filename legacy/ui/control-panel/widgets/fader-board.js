/**
 * @fileoverview Chunky vertical fader board for Manual Weather mixing deck.
 * @module ui/control-panel/widgets/fader-board
 */

import { GUSTINESS_LABELS, GUSTINESS_DISPLAY } from './astrolabe-dial.js';
import { WIND_TIER_LABELS, windTierFrom01 } from '../../../core/wind-profile.js';

/** @type {Record<string, { icon: string, tint: string, fill: string }>} */
export const FADER_META = Object.freeze({
  precipitation: { icon: '🌧', tint: 'blue', fill: 'rgba(80, 175, 255, 0.92)' },
  cloudCover: { icon: '☁', tint: 'gray', fill: 'rgba(160, 175, 195, 0.85)' },
  freezeLevel: { icon: '❄', tint: 'cyan', fill: 'rgba(100, 220, 255, 0.88)' },
  manualFogDensity: { icon: '🌫', tint: 'slate', fill: 'rgba(140, 160, 190, 0.82)' },
  fogDensity: { icon: '🌫', tint: 'slate', fill: 'rgba(140, 160, 190, 0.82)' },
  lightning: { icon: '⚡', tint: 'amber', fill: 'rgba(255, 200, 80, 0.9)' },
  windSpeed: { icon: '💨', tint: 'teal', fill: 'rgba(80, 200, 180, 0.85)' },
  wind01: { icon: '💨', tint: 'teal', fill: 'rgba(80, 200, 180, 0.85)' },
  gustiness: { icon: '🌪', tint: 'teal', fill: 'rgba(100, 210, 190, 0.88)' },
  ashIntensity: { icon: '🌋', tint: 'orange', fill: 'rgba(255, 140, 60, 0.88)' },
  replicaOcclusionRadiusScale: { icon: '⭕', tint: 'slate', fill: 'rgba(140, 160, 190, 0.82)' },
  replicaOcclusionEdgeSoftness: { icon: '◐', tint: 'gray', fill: 'rgba(160, 175, 195, 0.85)' },
});

/** @type {Record<string, string>} */
const FADER_HINTS = Object.freeze({
  precipitation: 'Rain and snow intensity',
  cloudCover: 'Sky cloud coverage',
  freezeLevel: 'Temperature — snow vs rain threshold',
  manualFogDensity: 'Ground fog density (manual override)',
  fogDensity: 'Ground fog density',
  lightning: 'Ambient lightning activity (not manual strikes below)',
  windSpeed: 'Wind speed in m/s',
  wind01: 'Scene wind — calm leaf flutter to hurricane force',
  gustiness: 'How much wind speed varies over time',
  ashIntensity: 'Volcanic ash density',
  replicaOcclusionRadiusScale: 'Player light occlusion radius',
  replicaOcclusionEdgeSoftness: 'Occlusion edge softness',
});

/**
 * @param {HTMLElement} container
 * @param {Array<{ id: string, label: string, min: number, max: number, step: number, metaId?: string, variant?: 'min'|'max' }>} specs
 * @param {{ wireRow: (paramId: string, range: HTMLInputElement, readout: HTMLElement) => void, setContextHint?: (text: string) => void, clearContextHint?: () => void, rootClassName?: string }} hooks
 */
export function createFaderBoard(container, specs, hooks) {
  const root = document.createElement('div');
  root.className = ['msa-cp-fader-board', hooks.rootClassName].filter(Boolean).join(' ');
  root.style.setProperty('--fader-count', String(Math.max(1, specs.length)));

  const tracksRow = document.createElement('div');
  tracksRow.className = 'msa-cp-fader-board__tracks';

  const iconsRow = document.createElement('div');
  iconsRow.className = 'msa-cp-fader-board__icons';

  const hoverLabel = document.createElement('div');
  hoverLabel.className = 'msa-cp-fader-board__hover-label';
  hoverLabel.hidden = !!(hooks.setContextHint && hooks.clearContextHint);

  const useExternalHint = !!(hooks.setContextHint && hooks.clearContextHint);
  const defaultHint = [
    'Hover a control for help',
    'Sliders: drag track up/down to adjust',
    'Dial: ring = time · sock = wind direction · Wind fader = strength',
  ];

  /** @type {Record<string, { range: HTMLInputElement, readout: HTMLElement, faderEl: HTMLElement, iconEl: HTMLElement, fillBar?: HTMLElement }>} */
  const rows = {};

  const setHoverLabel = (spec, value) => {
    const pct = toPercentLabel(spec, value);
    const metaKey = spec.metaId || spec.id;
    const detail = FADER_HINTS[metaKey];
    const boundTag = spec.variant === 'min' ? 'floor' : (spec.variant === 'max' ? 'ceiling' : null);
    let text;
    if (spec.id === 'wind01' || metaKey === 'wind01') {
      const w = Math.max(0, Math.min(1, Number(value) || 0));
      const tier = WIND_TIER_LABELS[windTierFrom01(w)] || 'Calm';
      text = [
        `Wind — ${Math.round(w * 100)}% · ${tier}`,
        detail || 'Calm leaf flutter to hurricane force',
        'Drag up = stronger wind · down = calm',
      ];
    } else if (spec.id === 'gustiness' || metaKey === 'gustiness') {
      const key = GUSTINESS_LABELS[Math.round(Number(value))] || 'moderate';
      const name = GUSTINESS_DISPLAY[key] || key;
      text = [
        `Gustiness — ${name}`,
        detail || 'How much wind speed varies over time',
        'Drag up = stronger gusts · down = steadier wind',
      ];
    } else {
      const boundLine = boundTag ? `Dynamic ${boundTag} clamp for evolution` : 'Drag track up/down to adjust';
      text = [
        `${spec.label} — ${pct}`,
        detail || boundLine,
        boundTag ? 'Preset picker also sets these bounds' : 'Changes apply live while dragging',
      ];
    }
    if (useExternalHint) {
      hooks.setContextHint?.(text);
    } else {
      hoverLabel.textContent = text.filter(Boolean).join(' · ');
    }
  };

  const clearHover = () => {
    if (useExternalHint) {
      hooks.clearContextHint?.();
    } else {
      hoverLabel.textContent = defaultHint.join(' · ');
    }
    for (const row of Object.values(rows)) {
      row.faderEl.classList.remove('is-hovered');
      row.iconEl.classList.remove('is-hovered');
    }
  };

  for (const spec of specs) {
    const metaKey = spec.metaId || spec.id;
    const meta = FADER_META[metaKey] || { icon: '◆', tint: 'neutral', fill: 'rgba(90, 200, 250, 0.9)' };
    const faderEl = document.createElement('div');
    const variantClass = spec.variant === 'min'
      ? 'msa-cp-fader--bound-min'
      : (spec.variant === 'max' ? 'msa-cp-fader--bound-max' : '');
    faderEl.className = `msa-cp-fader msa-cp-fader--${meta.tint} msa-cp-fader--chunky ${variantClass}`.trim();
    faderEl.dataset.param = spec.id;
    faderEl.style.setProperty('--fader-fill-color', meta.fill);

    const trackWrap = document.createElement('div');
    trackWrap.className = 'msa-cp-fader__track-wrap';

    const fillBar = document.createElement('div');
    fillBar.className = 'msa-cp-fader__fill';

    const previewFill = document.createElement('div');
    previewFill.className = 'msa-cp-fader__preview-fill';
    previewFill.hidden = true;

    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'msa-cp-fader__range chunky-fader';
    range.min = String(spec.min);
    range.max = String(spec.max);
    range.step = String(spec.step);
    range.setAttribute('aria-label', spec.label);

    const readout = document.createElement('span');
    readout.className = 'msa-cp-fader__readout';
    readout.textContent = '0%';
    readout.hidden = true;

    const icon = document.createElement('span');
    icon.className = 'msa-cp-fader__icon';
    icon.textContent = meta.icon;
    icon.setAttribute('aria-hidden', 'true');

    const activateHover = () => {
      clearHover();
      faderEl.classList.add('is-hovered');
      icon.classList.add('is-hovered');
      setHoverLabel(spec, range.valueAsNumber);
    };

    const syncUi = () => {
      const text = formatReadout(spec.id, range.valueAsNumber);
      readout.textContent = text;
      const liveVal = rowLiveValue != null && Number.isFinite(rowLiveValue)
        ? rowLiveValue
        : range.valueAsNumber;
      updateFill(faderEl, range, fillBar, liveVal);
      if (Number.isFinite(rowPreviewValue)) {
        updateFill(faderEl, range, previewFill, rowPreviewValue);
        previewFill.hidden = false;
        faderEl.classList.add('has-preview');
      } else {
        previewFill.hidden = true;
        faderEl.classList.remove('has-preview');
      }
      if (faderEl.classList.contains('is-hovered') || icon.classList.contains('is-hovered')) {
        setHoverLabel(spec, range.valueAsNumber);
      }
    };

    let rowLiveValue = null;
    let rowPreviewValue = null;

    const emitInput = () => {
      range.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const emitChange = () => {
      range.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const setValueFromClientY = (clientY) => {
      const rect = trackWrap.getBoundingClientRect();
      if (rect.height <= 0) return;
      const pct = 1 - (clientY - rect.top) / rect.height;
      const clamped = Math.max(0, Math.min(1, pct));
      const min = Number(range.min) || 0;
      const max = Number(range.max) || 1;
      const step = Number(range.step) || 0.01;
      let val = min + clamped * (max - min);
      if (step > 0) {
        val = Math.round(val / step) * step;
      }
      val = Math.max(min, Math.min(max, val));
      range.value = String(val);
      syncUi();
    };

    let dragging = false;

    trackWrap.addEventListener('pointerenter', activateHover);
    icon.addEventListener('pointerenter', activateHover);
    faderEl.addEventListener('pointerenter', activateHover);

    trackWrap.addEventListener('pointerdown', (e) => {
      dragging = true;
      trackWrap.setPointerCapture(e.pointerId);
      activateHover();
      setValueFromClientY(e.clientY);
      emitInput();
      e.preventDefault();
      e.stopPropagation();
    });

    trackWrap.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setValueFromClientY(e.clientY);
      emitInput();
    });

    const finishDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      faderEl.classList.remove('is-dragging');
      try { trackWrap.releasePointerCapture(e.pointerId); } catch (_) {}
      setValueFromClientY(e.clientY);
      emitChange();
    };

    trackWrap.addEventListener('pointerup', finishDrag);
    trackWrap.addEventListener('pointercancel', (e) => {
      dragging = false;
      faderEl.classList.remove('is-dragging');
      try { trackWrap.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    trackWrap.addEventListener('pointerdown', () => {
      faderEl.classList.add('is-dragging');
    });

    range.addEventListener('input', syncUi);
    range.addEventListener('change', syncUi);

    trackWrap.appendChild(previewFill);
    trackWrap.appendChild(fillBar);
    trackWrap.appendChild(range);
    faderEl.appendChild(trackWrap);
    tracksRow.appendChild(faderEl);
    iconsRow.appendChild(icon);

    rows[spec.id] = {
      range,
      readout,
      faderEl,
      iconEl: icon,
      fillBar,
      previewFill,
      spec,
      setLiveValue: (v) => {
        rowLiveValue = (v === null || v === undefined || !Number.isFinite(Number(v)))
          ? null
          : Number(v);
        syncUi();
      },
      setPreviewValue: (v) => {
        rowPreviewValue = Number.isFinite(Number(v)) ? Number(v) : null;
        syncUi();
      },
      clearPreview: () => {
        rowPreviewValue = null;
        syncUi();
      },
    };
    hooks.wireRow(spec.id, range, readout);
    syncUi();
  }

  root.addEventListener('pointerleave', clearHover);

  root.appendChild(tracksRow);
  root.appendChild(iconsRow);
  if (!useExternalHint) {
    hoverLabel.textContent = defaultHint;
    root.appendChild(hoverLabel);
  }
  container.appendChild(root);

  return { root, rows, hoverLabel };
}

/**
 * @param {{ min: number, max: number }} spec
 * @param {number} value
 */
function toPercentLabel(spec, value) {
  if (!Number.isFinite(value)) return '—';
  if (spec.id === 'wind01') {
    const w = Math.max(0, Math.min(1, Number(value) || 0));
    return `${Math.round(w * 100)}% ${WIND_TIER_LABELS[windTierFrom01(w)] || 'Calm'}`;
  }
  if (spec.id === 'gustiness') {
    const key = GUSTINESS_LABELS[Math.round(Number(value))] || 'moderate';
    return GUSTINESS_DISPLAY[key] || key;
  }
  const min = Number(spec.min) || 0;
  const max = Number(spec.max) || 1;
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return `${Math.round(pct)}%`;
}

/**
 * @param {string} paramId
 * @param {number} value
 */
function formatReadout(paramId, value) {
  if (!Number.isFinite(value)) return '—';
  if (paramId === 'wind01') {
    const w = Math.max(0, Math.min(1, Number(value) || 0));
    return `${Math.round(w * 100)}% ${WIND_TIER_LABELS[windTierFrom01(w)] || 'Calm'}`;
  }
  if (paramId === 'gustiness') {
    const key = GUSTINESS_LABELS[Math.round(Number(value))] || 'moderate';
    return GUSTINESS_DISPLAY[key] || key;
  }
  if (paramId === 'windDirection') return `${Math.round(value)}°`;
  const min = 0;
  const max = paramId.includes('Occlusion') || paramId === 'replicaOcclusionRadiusScale' ? 100 : 1;
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return `${Math.round(pct)}%`;
}

/**
 * @param {HTMLElement} faderEl
 * @param {HTMLInputElement} range
 * @param {HTMLElement} [fillBar]
 */
function updateFill(faderEl, range, fillBar, valueOverride) {
  const min = Number(range.min) || 0;
  const max = Number(range.max) || 1;
  const v = Number.isFinite(Number(valueOverride))
    ? Number(valueOverride)
    : Number(range.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  const clamped = Math.max(0, Math.min(100, pct));
  faderEl.style.setProperty('--slider-fill', `${clamped}%`);
  if (fillBar) {
    fillBar.style.height = `${clamped}%`;
    fillBar.style.opacity = clamped > 0.5 ? '1' : '0.85';
  }
}

/**
 * @param {Record<string, { setPreviewValue?: (v: number) => void, clearPreview?: () => void, setLiveValue?: (v: number) => void }>} rows
 */
export function clearAllFaderPreviews(rows) {
  if (!rows) return;
  for (const row of Object.values(rows)) {
    row.clearPreview?.();
    row.setLiveValue?.(null);
  }
}

/**
 * @param {Record<string, { setPreviewValue?: (v: number) => void }>} rows
 * @param {string} paramId
 * @param {number} value
 */
export function setFaderPreview(rows, paramId, value) {
  rows?.[paramId]?.setPreviewValue?.(value);
}

/**
 * @param {Record<string, { setLiveValue?: (v: number) => void }>} rows
 * @param {string} paramId
 * @param {number} value
 */
export function setFaderLiveValue(rows, paramId, value) {
  rows?.[paramId]?.setLiveValue?.(value);
}

/**
 * @param {Record<string, { range: HTMLInputElement, readout: HTMLElement, faderEl: HTMLElement, iconEl?: HTMLElement, fillBar?: HTMLElement }>} rows
 * @param {string} paramId
 * @param {number} value
 */
export function mirrorFaderRow(rows, paramId, value) {
  const row = rows?.[paramId];
  if (!row || !Number.isFinite(value)) return;
  row.range.value = String(value);
  const min = Number(row.range.min) || 0;
  const max = Number(row.range.max) || 1;
  const label = (paramId === 'gustiness' || paramId === 'wind01')
    ? formatReadout(paramId, value)
    : `${Math.round(max > min ? ((value - min) / (max - min)) * 100 : 0)}%`;
  row.readout.textContent = label;
  updateFill(row.faderEl, row.range, row.fillBar);
  if (row.previewFill) updateFill(row.faderEl, row.range, row.previewFill, row.range.valueAsNumber);
}
