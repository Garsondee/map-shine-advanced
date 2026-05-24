/**
 * @fileoverview Shared Time-of-Day anchor metadata (matches Color Correction CC timeline).
 * @module core/tod-anchor-spec
 */

/** Default hour per anchor index (tod0..tod7). */
export const DEFAULT_TOD_ANCHOR_HOURS = Object.freeze([0, 3, 6, 9, 12, 15, 18, 21]);

/**
 * UI order and labels: noon → afternoon → dusk → night → midnight → pre-dawn → dawn → morning.
 * `index` is the persisted tod{N} slot.
 */
export const TOD_ANCHOR_META = Object.freeze([
  { index: 4, label: 'Noon', clockHint: '12:00' },
  { index: 5, label: 'Afternoon', clockHint: '15:00' },
  { index: 6, label: 'Dusk', clockHint: '18:00' },
  { index: 7, label: 'Night', clockHint: '21:00' },
  { index: 0, label: 'Midnight', clockHint: '00:00' },
  { index: 1, label: 'Pre-dawn', clockHint: '03:00' },
  { index: 2, label: 'Dawn', clockHint: '06:00' },
  { index: 3, label: 'Morning', clockHint: '09:00' },
]);

/**
 * @param {number} hour
 * @returns {number}
 */
export function normalizeTodHour24(hour) {
  const n = Number(hour);
  if (!Number.isFinite(n)) return 0;
  return ((n % 24) + 24) % 24;
}

/**
 * Orbit button angle (deg) matching the control-panel clock (noon at top).
 * @param {number} hour
 * @returns {number}
 */
export function todHourToOrbitAngleDeg(hour) {
  const shifted = ((normalizeTodHour24(hour) - 12) % 24 + 24) % 24;
  return shifted * 15 - 90;
}

/**
 * Resolve quick-pick anchors from CC params when available.
 * @param {Record<string, *>|null|undefined} ccParams
 * @returns {Array<{ label: string, hour: number, clockHint: string }>}
 */
export function resolveTodQuickPickAnchors(ccParams) {
  return TOD_ANCHOR_META.map((meta) => {
    const key = `tod${meta.index}Hour`;
    let hour = DEFAULT_TOD_ANCHOR_HOURS[meta.index] ?? 0;
    if (ccParams && Number.isFinite(Number(ccParams[key]))) {
      hour = Number(ccParams[key]);
    }
    return {
      label: meta.label,
      hour: normalizeTodHour24(hour),
      clockHint: meta.clockHint,
    };
  });
}

/**
 * Read CC effect params from the live Tweakpane stack when registered.
 * @returns {Record<string, *>|null}
 */
export function readColorCorrectionParamsFromUi() {
  try {
    const folders = window.MapShine?.uiManager?.effectFolders;
    return folders?.colorCorrection?.params
      ?? folders?.['color-correction']?.params
      ?? null;
  } catch (_) {
    return null;
  }
}
