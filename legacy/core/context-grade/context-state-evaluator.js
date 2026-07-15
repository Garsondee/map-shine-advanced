/**
 * @fileoverview Multi-dimension hysteresis for contextual scene grade probes.
 * @module core/context-grade/context-state-evaluator
 */

import { finiteOr, classifyBuildingShadowLit, resolveBuildingShadowThresholds } from './context-grade-spec.js';
import { createEmptyDimensionSnapshot } from './context-dimensions.js';

/**
 * @typedef {'outdoor'|'indoor'|'unknown'} IndoorOutdoorState
 */

/**
 * @param {number} sample
 * @param {IndoorOutdoorState} previous
 * @param {{ outdoorHigh?: number, indoorLow?: number }} [opts]
 * @returns {IndoorOutdoorState}
 */
export function classifyIndoorOutdoorSample(sample, previous = 'unknown', opts = {}) {
  const high = Number.isFinite(Number(opts.outdoorHigh)) ? Number(opts.outdoorHigh) : 0.82;
  const low = Number.isFinite(Number(opts.indoorLow)) ? Number(opts.indoorLow) : 0.18;
  const s = Number(sample);
  if (!Number.isFinite(s)) return previous;

  if (s >= high) return 'outdoor';
  if (s <= low) return 'indoor';
  return previous === 'unknown' ? (s >= 0.5 ? 'outdoor' : 'indoor') : previous;
}

/**
 * @param {number} litSample - 0 shadow, 1 sunlit
 * @param {'sunlit'|'shadowed'|'unknown'} previous
 * @param {{ shadowLow?: number, sunlitHigh?: number }} [opts]
 */
export function classifyCloudShadowSample(litSample, previous = 'unknown', opts = {}) {
  const shadowLow = finiteOr(opts.shadowLow, 0.42);
  const sunlitHigh = finiteOr(opts.sunlitHigh, 0.62);
  const s = Number(litSample);
  if (!Number.isFinite(s)) return previous;
  if (s <= shadowLow) return 'shadowed';
  if (s >= sunlitHigh) return 'sunlit';
  return previous === 'unknown' ? (s >= 0.5 ? 'sunlit' : 'shadowed') : previous;
}

/**
 * @param {number} skyReach - 1 open sky, 0 canopy
 * @param {'open'|'shaded'|'unknown'} previous
 * @param {{ shadedLow?: number, openHigh?: number }} [opts]
 */
export function classifyCanopySample(skyReach, previous = 'unknown', opts = {}) {
  const shadedLow = finiteOr(opts.shadedLow, 0.38);
  const openHigh = finiteOr(opts.openHigh, 0.58);
  const s = Number(skyReach);
  if (!Number.isFinite(s)) return previous;
  if (s <= shadedLow) return 'shaded';
  if (s >= openHigh) return 'open';
  return previous === 'unknown' ? (s >= 0.5 ? 'open' : 'shaded') : previous;
}

/**
 * @param {boolean} windowLit
 * @param {'deep'|'windowLit'|'unknown'} previous
 */
export function classifyInteriorLight(windowLit, previous = 'unknown') {
  if (windowLit) return 'windowLit';
  if (previous === 'windowLit') return 'deep';
  return 'deep';
}

/**
 * @param {'clear'|'overcast'|'storm'} envSky
 * @param {'clear'|'overcast'|'storm'|'unknown'} previous
 */
export function classifyOutdoorSky(envSky, previous = 'unknown') {
  if (envSky === 'storm' || envSky === 'overcast' || envSky === 'clear') return envSky;
  return previous;
}

/**
 * @param {{ buildingLit?: number|null, paintedLit?: number|null, treeLit?: number|null, skyReachSample?: number|null, dayWeight?: number|null, indoorOutdoor?: string }} probe
 * @param {'sunlit'|'buildingShadow'|'paintedShadow'|'treeDapple'|'unknown'} previous
 * @param {Record<string, *>} params
 */
export function classifyCoverShadow(probe, previous = 'unknown', params = {}) {
  const io = probe?.indoorOutdoor;
  if (io === 'indoor') return 'sunlit';
  if (io !== 'outdoor') return previous === 'unknown' ? 'unknown' : 'sunlit';

  const treeLow = finiteOr(params?.treeShadowLitLow, 0.93);
  const treeHigh = finiteOr(params?.treeShadowLitHigh, 0.98);
  const buildingThresholds = resolveBuildingShadowThresholds(params);
  const paintLow = finiteOr(params?.paintedShadowLitLow, 0.85);
  const paintHigh = finiteOr(params?.paintedShadowLitHigh, 0.94);
  const dayThr = finiteOr(params?.treeDappleDayThreshold, 0.35);
  const canopyShadedThr = finiteOr(params?.canopyShadedThreshold, 0.38);

  const treeLit = Number(probe?.treeLit);
  const buildingLit = Number(probe?.buildingLit);
  const paintedLit = Number(probe?.paintedLit);
  const skyReach = Number(probe?.skyReachSample);
  const dayWeight = Number(probe?.dayWeight);

  const inBand = (lit, low, high, wasActive) => {
    if (!Number.isFinite(lit)) return false;
    if (lit <= low) return true;
    if (lit >= high) return false;
    return wasActive;
  };

  const wasTree = previous === 'treeDapple';
  const wasBuilding = previous === 'buildingShadow';
  const wasPainted = previous === 'paintedShadow';
  const isDay = Number.isFinite(dayWeight) && dayWeight >= dayThr;
  const canopyShaded = Number.isFinite(skyReach) && skyReach <= canopyShadedThr;
  const treeDarkerThanBuilding = Number.isFinite(treeLit) && Number.isFinite(buildingLit)
    && treeLit < buildingLit - 0.04;
  const treeInShadow = inBand(treeLit, treeLow, treeHigh, wasTree)
    || treeDarkerThanBuilding
    || (canopyShaded
      && Number.isFinite(buildingLit)
      && buildingLit >= buildingThresholds.buildHigh
      && (!Number.isFinite(treeLit) || treeLit < treeHigh));

  const buildingInShadow = classifyBuildingShadowLit(buildingLit, buildingThresholds, wasBuilding);
  const paintedInShadow = inBand(paintedLit, paintLow, paintHigh, wasPainted);

  if (treeInShadow && isDay && !buildingInShadow && !paintedInShadow) return 'treeDapple';

  if (paintedInShadow && !buildingInShadow) return 'paintedShadow';
  if (buildingInShadow) return 'buildingShadow';
  if (paintedInShadow) return 'paintedShadow';

  return 'sunlit';
}

export class ContextStateEvaluator {
  constructor() {
    /** @type {IndoorOutdoorState} */
    this.indoorOutdoor = 'unknown';
    /** @type {number|null} */
    this.lastOutdoorsSample = null;

    /** @type {import('./context-dimensions.js').ContextDimensionSnapshot} */
    this.dimensions = createEmptyDimensionSnapshot();

    /** @type {number|null} */
    this.lastCloudShadowSample = null;
    /** @type {number|null} */
    this.lastSkyReachSample = null;
    /** @type {boolean} */
    this.lastWindowLit = false;
    /** @type {number|null} */
    this.lastBuildingShadowLit = null;
    /** @type {number|null} */
    this.lastPaintedShadowLit = null;
    /** @type {number|null} */
    this.lastTreeShadowLit = null;
  }

  /**
   * @param {number|null} outdoorsSample
   * @param {{ outdoorHigh?: number, indoorLow?: number }} [opts]
   * @returns {IndoorOutdoorState}
   */
  updateIndoorOutdoor(outdoorsSample, opts = {}) {
    if (outdoorsSample == null || !Number.isFinite(Number(outdoorsSample))) {
      return this.indoorOutdoor;
    }
    this.lastOutdoorsSample = Number(outdoorsSample);
    this.indoorOutdoor = classifyIndoorOutdoorSample(
      this.lastOutdoorsSample,
      this.indoorOutdoor,
      opts,
    );
    this.dimensions.indoorOutdoor = this.indoorOutdoor;
    return this.indoorOutdoor;
  }

  /**
   * @param {{ cloudShadowSample?: number|null, skyReachSample?: number|null, windowLit?: boolean, envSky?: string, buildingShadowLit?: number|null, paintedShadowLit?: number|null, treeShadowLit?: number|null, dayWeight?: number|null }} probe
   * @param {Record<string, *>} params
   */
  updateTokenDimensions(probe = {}, params = {}) {
    if (probe.cloudShadowSample != null && Number.isFinite(Number(probe.cloudShadowSample))) {
      this.lastCloudShadowSample = Number(probe.cloudShadowSample);
      this.dimensions.cloudShadow = classifyCloudShadowSample(
        this.lastCloudShadowSample,
        this.dimensions.cloudShadow,
        {
          shadowLow: finiteOr(params?.cloudShadowThresholdLow, 0.42),
          sunlitHigh: finiteOr(params?.cloudShadowThresholdHigh, 0.62),
        },
      );
    }

    if (probe.skyReachSample != null && Number.isFinite(Number(probe.skyReachSample))) {
      this.lastSkyReachSample = Number(probe.skyReachSample);
      this.dimensions.canopy = classifyCanopySample(
        this.lastSkyReachSample,
        this.dimensions.canopy,
        {
          shadedLow: finiteOr(params?.canopyShadedThreshold, 0.38),
          openHigh: finiteOr(params?.canopyOpenThreshold, 0.58),
        },
      );
    }

    if (typeof probe.windowLit === 'boolean') {
      this.lastWindowLit = probe.windowLit;
      this.dimensions.interiorLight = classifyInteriorLight(
        probe.windowLit,
        this.dimensions.interiorLight,
      );
    }

    if (probe.envSky) {
      this.dimensions.outdoorSky = classifyOutdoorSky(probe.envSky, this.dimensions.outdoorSky);
    }

    if (this.dimensions.indoorOutdoor === 'outdoor') {
      if (probe.buildingShadowLit != null && Number.isFinite(Number(probe.buildingShadowLit))) {
        this.lastBuildingShadowLit = Number(probe.buildingShadowLit);
      }
      if (probe.paintedShadowLit != null && Number.isFinite(Number(probe.paintedShadowLit))) {
        this.lastPaintedShadowLit = Number(probe.paintedShadowLit);
      }
      if (probe.treeShadowLit != null && Number.isFinite(Number(probe.treeShadowLit))) {
        this.lastTreeShadowLit = Number(probe.treeShadowLit);
      }
      this.dimensions.coverShadow = classifyCoverShadow(
        {
          buildingLit: this.lastBuildingShadowLit,
          paintedLit: this.lastPaintedShadowLit,
          treeLit: this.lastTreeShadowLit,
          skyReachSample: this.lastSkyReachSample,
          dayWeight: probe.dayWeight,
          indoorOutdoor: this.dimensions.indoorOutdoor,
        },
        this.dimensions.coverShadow,
        params,
      );
    } else {
      this.dimensions.coverShadow = 'sunlit';
    }
  }

  reset() {
    this.indoorOutdoor = 'unknown';
    this.lastOutdoorsSample = null;
    this.dimensions = createEmptyDimensionSnapshot();
    this.lastCloudShadowSample = null;
    this.lastSkyReachSample = null;
    this.lastWindowLit = false;
    this.lastBuildingShadowLit = null;
    this.lastPaintedShadowLit = null;
    this.lastTreeShadowLit = null;
  }
}
