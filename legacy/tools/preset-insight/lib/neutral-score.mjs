import { neutralTargetEntries } from './neutral-target.mjs';

/**
 * @param {Map<string, { value: unknown, kind: string }>} flat
 * @param {Map<string, import('./schema-registry.mjs').ParamSpec>} registry
 */
export function computeNeutralScore(flat, registry) {
  let considered = 0;
  let weightedError = 0;
  /** @type {Array<{ path: string, value: unknown, target: unknown, normalizedError: number }>} */
  const details = [];

  for (const [path, target] of neutralTargetEntries()) {
    const current = flat.get(path)?.value;
    if (current === undefined) continue;
    considered++;

    let err = 0;
    if (typeof target === 'boolean') {
      err = current === target ? 0 : 1;
    } else if (typeof target === 'number' && typeof current === 'number') {
      const spec = registry.get(path);
      const span = spec?.min != null && spec?.max != null ? Math.max(1e-6, spec.max - spec.min) : Math.max(1, Math.abs(target));
      err = Math.min(3, Math.abs(current - target) / span);
    } else {
      err = current === target ? 0 : 1;
    }
    weightedError += err;
    details.push({ path, value: current, target, normalizedError: err });
  }

  const score = considered ? Math.max(0, 100 - (weightedError / considered) * 100) : null;
  details.sort((a, b) => b.normalizedError - a.normalizedError);

  return {
    score,
    considered,
    weightedError,
    topDeviations: details.slice(0, 15),
  };
}

/**
 * @param {object|null} calibrationReport
 */
export function summarizeCalibrationReport(calibrationReport) {
  if (!calibrationReport) return null;
  const patches = Array.isArray(calibrationReport.patches) ? calibrationReport.patches : [];
  const bus = patches.map((p) => p?.taps?.busAlbedo?.deltaLen).filter((n) => Number.isFinite(n));
  const final = patches.map((p) => p?.taps?.final?.deltaLen).filter((n) => Number.isFinite(n));
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  return {
    source: calibrationReport.meta?.generatedAt ?? 'unknown',
    patchCount: patches.length,
    busMeanDelta: mean(bus),
    finalMeanDelta: mean(final),
    nudges: calibrationReport.nudges ?? [],
  };
}
