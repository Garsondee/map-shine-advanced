/**
 * @fileoverview Auto-scheduler for Camera Path timeline clips (sweeps + significant locations).
 *
 * @module foundry/camera-path-timeline
 */
import {
  asCameraNumber,
  computeTimelineVisibleMotionMs,
  lerpCameraView,
  normalizeSignificantLocations,
  normalizeSigLocPlacement,
  resolveSceneMapDimensions,
  shouldUseSigLocFadeCut,
  SIG_LOC_FADE_CUT_MS,
  timelineClipColorClass,
} from './camera-path-types.js';

/** Minimum total sweep duration (ms) to allow a mid-sweep split (4s per half). */
const MIN_SPLITTABLE_SWEEP_MS = 8000;

/**
 * @param {unknown} pt
 * @returns {boolean}
 */
function isValidPoint(pt) {
  return pt
    && typeof pt === 'object'
    && pt.x !== undefined
    && pt.x !== null
    && pt.x !== '';
}

/**
 * @typedef {Object} InternalSweepNode
 * @property {string} sweepPair
 * @property {string} label
 * @property {import('./camera-path-types.js').CameraView} from
 * @property {import('./camera-path-types.js').CameraView} to
 * @property {number} durationMs
 * @property {boolean} splittable
 */

/**
 * @param {import('./camera-path-types.js').CameraView} view
 * @returns {import('./camera-path-types.js').CameraView}
 */
function cloneView(view) {
  return { x: view.x, y: view.y, scale: view.scale };
}

/**
 * @param {import('./camera-path-types.js').SignificantLocation} loc
 * @param {number} scaleMul
 * @returns {import('./camera-path-types.js').CameraView}
 */
function sigLocToView(loc, scaleMul) {
  return {
    x: asCameraNumber(loc.x, 0),
    y: asCameraNumber(loc.y, 0),
    scale: asCameraNumber(loc.scale, 1) * scaleMul,
  };
}

/**
 * @param {import('./camera-path-service.js').CameraPathData} data
 * @param {number} scaleMul
 * @returns {InternalSweepNode[]}
 */
export function buildBaseSweepNodes(data, scaleMul) {
  const points = data.points || {};
  const settings = data.settings || {};
  let totalSweeps = 1;
  if (isValidPoint(points.C) && isValidPoint(points.D)) totalSweeps = 2;
  if (isValidPoint(points.E) && isValidPoint(points.F)) totalSweeps = 3;
  if (isValidPoint(points.G) && isValidPoint(points.H)) totalSweeps = 4;

  const totalDurationSec = Math.max(1, asCameraNumber(settings.duration, 15));
  const durationPerSweepMs = (totalDurationSec / totalSweeps) * 1000;

  /** @type {Array<[string, string]>} */
  const pairs = [['A', 'B']];
  if (totalSweeps >= 2) pairs.push(['C', 'D']);
  if (totalSweeps >= 3) pairs.push(['E', 'F']);
  if (totalSweeps >= 4) pairs.push(['G', 'H']);

  return pairs.map(([fromKey, toKey]) => {
    const from = points[fromKey];
    const to = points[toKey];
    const sweepPair = `${fromKey}-${toKey}`;
    return {
      sweepPair,
      label: `${fromKey} → ${toKey}`,
      from: {
        x: asCameraNumber(from.x, 0),
        y: asCameraNumber(from.y, 0),
        scale: asCameraNumber(from.scale, 1) * scaleMul,
      },
      to: {
        x: asCameraNumber(to.x, 0),
        y: asCameraNumber(to.y, 0),
        scale: asCameraNumber(to.scale, 1) * scaleMul,
      },
      durationMs: durationPerSweepMs,
      splittable: durationPerSweepMs >= MIN_SPLITTABLE_SWEEP_MS,
    };
  });
}

/**
 * @param {import('./camera-path-service.js').CameraPathData} data
 * @param {{ scaleMul?: number }} [options]
 * @returns {{ interstitial: Array<{ value: string, label: string }>, split: Array<{ value: string, label: string }> }}
 */
export function getCameraPathPlacementOptions(data, options = {}) {
  const scaleMul = asCameraNumber(options.scaleMul, 1);
  const sweeps = buildBaseSweepNodes(data, scaleMul);

  return {
    interstitial: sweeps.slice(0, -1).map((sweep) => ({
      value: sweep.sweepPair,
      label: `After ${sweep.label}`,
    })),
    split: sweeps.filter((s) => s.splittable).map((sweep) => ({
      value: sweep.sweepPair,
      label: `Split ${sweep.label}`,
    })),
  };
}

/**
 * @param {string} label
 * @param {number} durationMs
 * @param {import('./camera-path-types.js').CameraView} from
 * @param {import('./camera-path-types.js').CameraView} to
 * @param {string} sweepPair
 * @param {number} [sweepPart]
 * @returns {import('./camera-path-types.js').CameraTimelineClip}
 */
function makeSweepClip(label, durationMs, from, to, sweepPair, sweepPart = undefined) {
  return {
    type: 'sweep',
    label,
    durationMs,
    from: cloneView(from),
    to: cloneView(to),
    sweepPair,
    sweepPart,
  };
}

/**
 * @param {import('./camera-path-types.js').CameraView} from
 * @param {import('./camera-path-types.js').CameraView} to
 * @param {number} durationMs
 * @param {string} [label='Pan']
 * @param {import('./camera-path-types.js').SceneMapDimensions} [mapDims]
 * @param {number} [fadeCutMs=SIG_LOC_FADE_CUT_MS]
 * @returns {import('./camera-path-types.js').CameraTimelineClip}
 */
function makeTransitionClip(from, to, durationMs, label = 'Pan', mapDims = null, fadeCutMs = SIG_LOC_FADE_CUT_MS) {
  const clip = {
    type: 'transition',
    label,
    from: cloneView(from),
    to: cloneView(to),
    transitionStyle: /** @type {'pan'} */ ('pan'),
    durationMs,
  };

  if (mapDims && shouldUseSigLocFadeCut(from, to, mapDims)) {
    const cutMs = Math.max(250, fadeCutMs);
    clip.transitionStyle = 'fade';
    clip.durationMs = cutMs * 2;
    if (label.startsWith('→ ')) clip.label = `Fade → ${label.slice(2)}`;
    else if (label.startsWith('← ')) clip.label = `Fade ← ${label.slice(2)}`;
    else clip.label = `Fade ${label}`;
  }

  return clip;
}

/**
 * @param {import('./camera-path-types.js').SignificantLocation} loc
 * @param {import('./camera-path-types.js').CameraView} view
 * @param {number} holdMs
 * @returns {import('./camera-path-types.js').CameraTimelineClip}
 */
function makeSigHoldClip(loc, view, holdMs) {
  return {
    type: 'sigHold',
    label: loc.name,
    durationMs: holdMs,
    view: cloneView(view),
    sigLocId: loc.id,
  };
}

/**
 * @param {InternalSweepNode} node
 * @param {import('./camera-path-types.js').SignificantLocation} loc
 * @param {import('./camera-path-types.js').CameraView} sigView
 * @param {number} transitionMs
 * @param {number} holdMs
 * @param {import('./camera-path-types.js').SceneMapDimensions} mapDims
 * @param {number} fadeCutMs
 * @returns {import('./camera-path-types.js').CameraTimelineClip[]}
 */
function splitSweepWithSigLoc(node, loc, sigView, transitionMs, holdMs, mapDims, fadeCutMs) {
  const midpoint = lerpCameraView(0.5, node.from, node.to);
  const halfMs = node.durationMs / 2;

  return [
    makeSweepClip(`${node.label} (1/2)`, halfMs, node.from, midpoint, node.sweepPair, 1),
    makeTransitionClip(midpoint, sigView, transitionMs, `→ ${loc.name}`, mapDims, fadeCutMs),
    makeSigHoldClip(loc, sigView, holdMs),
    makeTransitionClip(sigView, midpoint, transitionMs, `← ${loc.name}`, mapDims, fadeCutMs),
    makeSweepClip(`${node.label} (2/2)`, halfMs, midpoint, node.to, node.sweepPair, 2),
  ];
}

/**
 * @param {InternalSweepNode} before
 * @param {InternalSweepNode} after
 * @param {import('./camera-path-types.js').SignificantLocation} loc
 * @param {import('./camera-path-types.js').CameraView} sigView
 * @param {number} transitionMs
 * @param {number} holdMs
 * @returns {import('./camera-path-types.js').CameraTimelineClip[]}
 */
function interstitialClips(before, after, loc, sigView, transitionMs, holdMs, mapDims, fadeCutMs) {
  return [
    makeTransitionClip(before.to, sigView, transitionMs, `→ ${loc.name}`, mapDims, fadeCutMs),
    makeSigHoldClip(loc, sigView, holdMs),
    makeTransitionClip(sigView, after.from, transitionMs, `→ ${after.label}`, mapDims, fadeCutMs),
  ];
}

/**
 * @param {import('./camera-path-types.js').CameraTimelineClip[]} clips
 * @param {string[]} unplacedSigLocIds
 * @returns {import('./camera-path-types.js').CameraTimelineBuildResult}
 */
function finalizeTimeline(clips, unplacedSigLocIds = []) {
  const safeClips = Array.isArray(clips) ? clips : [];
  const visibleMotionMs = computeTimelineVisibleMotionMs(safeClips);
  let cursor = 0;
  const summary = safeClips.map((clip, index) => {
    const startMs = cursor;
    cursor += Math.max(0, clip.durationMs || 0);
    return {
      id: `${clip.type}-${index}`,
      type: clip.type,
      label: clip.label,
      durationMs: clip.durationMs,
      startMs,
      colorClass: timelineClipColorClass(clip.type, clip),
      sigLocId: clip.sigLocId,
    };
  });

  return {
    clips: safeClips,
    summary,
    visibleMotionMs,
    totalMs: visibleMotionMs,
    unplacedSigLocIds,
  };
}

/**
 * @param {import('./camera-path-types.js').CameraTimelineClip[]} clips
 * @param {import('./camera-path-types.js').SignificantLocation} loc
 * @param {number} defaultHoldSec
 * @param {number} scaleMul
 * @param {number} transitionMs
 * @param {import('./camera-path-types.js').SceneMapDimensions} mapDims
 * @param {number} fadeCutMs
 * @returns {boolean}
 */
function splitClipForLoc(clips, loc, defaultHoldSec, scaleMul, transitionMs, mapDims, fadeCutMs) {
  /** @type {{ index: number, durationMs: number }} */
  let best = { index: -1, durationMs: -1 };

  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    if (clip.type !== 'sweep' || clip.sweepPart) continue;
    if (clip.durationMs < MIN_SPLITTABLE_SWEEP_MS) continue;
    if (clip.durationMs > best.durationMs) {
      best = { index: i, durationMs: clip.durationMs };
    }
  }

  if (best.index < 0) return false;

  const target = clips[best.index];
  const holdMs = Math.max(500, (loc.holdSec ?? defaultHoldSec) * 1000);
  const sigView = sigLocToView(loc, scaleMul);
  const node = {
    sweepPair: target.sweepPair || '',
    label: target.label.replace(/ \(\d\/2\)$/, ''),
    from: target.from || { x: 0, y: 0, scale: 1 },
    to: target.to || { x: 0, y: 0, scale: 1 },
    durationMs: target.durationMs,
    splittable: true,
  };

  const replacement = splitSweepWithSigLoc(
    node, loc, sigView, transitionMs, holdMs, mapDims, fadeCutMs,
  );
  clips.splice(best.index, 1, ...replacement);
  return true;
}

/**
 * @param {import('./camera-path-types.js').CameraTimelineClip[]} clips
 * @param {import('./camera-path-types.js').SignificantLocation} loc
 * @param {string} sweepPair
 * @param {number} defaultHoldSec
 * @param {number} scaleMul
 * @param {number} transitionMs
 * @param {import('./camera-path-types.js').SceneMapDimensions} mapDims
 * @param {number} fadeCutMs
 * @returns {boolean}
 */
function splitClipForLocTarget(clips, loc, sweepPair, defaultHoldSec, scaleMul, transitionMs, mapDims, fadeCutMs) {
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    if (clip.type !== 'sweep' || clip.sweepPart) continue;
    if (clip.sweepPair !== sweepPair) continue;
    if (clip.durationMs < MIN_SPLITTABLE_SWEEP_MS) return false;

    const holdMs = Math.max(500, (loc.holdSec ?? defaultHoldSec) * 1000);
    const sigView = sigLocToView(loc, scaleMul);
    const node = {
      sweepPair: clip.sweepPair || '',
      label: clip.label.replace(/ \(\d\/2\)$/, ''),
      from: clip.from || { x: 0, y: 0, scale: 1 },
      to: clip.to || { x: 0, y: 0, scale: 1 },
      durationMs: clip.durationMs,
      splittable: true,
    };

    const replacement = splitSweepWithSigLoc(
      node, loc, sigView, transitionMs, holdMs, mapDims, fadeCutMs,
    );
    clips.splice(i, 1, ...replacement);
    return true;
  }
  return false;
}

/**
 * @param {import('./camera-path-service.js').CameraPathData} data
 * @param {{ scaleMul?: number }} [options]
 * @returns {import('./camera-path-types.js').CameraTimelineBuildResult}
 */
export function buildCameraTimeline(data, options = {}) {
  const scaleMul = asCameraNumber(options.scaleMul, 1);
  const settings = data?.settings || {};
  const defaultHoldSec = Math.max(0.5, asCameraNumber(settings.defaultSigHoldSec, 8));
  const transitionSec = Math.max(0, asCameraNumber(settings.sigTransitionSec, 2));
  const defaultHoldMs = defaultHoldSec * 1000;
  const transitionMs = transitionSec * 1000;
  const mapDims = resolveSceneMapDimensions(options);
  const fadeCutMs = Math.max(250, asCameraNumber(options.sigLocFadeCutMs, SIG_LOC_FADE_CUT_MS));

  const sweeps = buildBaseSweepNodes(data, scaleMul);
  const placementOptions = getCameraPathPlacementOptions(data, options);
  const rawLocs = normalizeSignificantLocations(data?.significantLocations);
  const sigLocs = rawLocs.map((loc) => normalizeSigLocPlacement(loc, {
    interstitialPairs: placementOptions.interstitial.map((o) => o.value),
    splitPairs: placementOptions.split.map((o) => o.value),
  }));

  if (!sweeps.length) {
    return finalizeTimeline([], sigLocs.map((l) => l.id));
  }

  /** @type {import('./camera-path-types.js').SignificantLocation[]} */
  const autoQueue = [];
  /** @type {import('./camera-path-types.js').SignificantLocation[]} */
  const pinnedSplits = [];
  /** @type {(import('./camera-path-types.js').SignificantLocation|null)[]} */
  const interstitialAssignments = Array(Math.max(0, sweeps.length - 1)).fill(null);
  /** @type {Set<number>} */
  const filledInterstitialSlots = new Set();

  for (const loc of sigLocs) {
    const mode = loc.placementMode || 'auto';
    if (mode === 'interstitial' && loc.placementTarget) {
      const slot = sweeps.findIndex((s, idx) => (
        idx < sweeps.length - 1 && s.sweepPair === loc.placementTarget
      ));
      if (slot >= 0 && !filledInterstitialSlots.has(slot)) {
        interstitialAssignments[slot] = loc;
        filledInterstitialSlots.add(slot);
        continue;
      }
      autoQueue.push(loc);
    } else if (mode === 'split' && loc.placementTarget) {
      pinnedSplits.push(loc);
    } else {
      autoQueue.push(loc);
    }
  }

  for (let slot = 0; slot < interstitialAssignments.length && autoQueue.length > 0; slot += 1) {
    if (interstitialAssignments[slot]) continue;
    interstitialAssignments[slot] = autoQueue.shift() || null;
  }

  /** @type {import('./camera-path-types.js').CameraTimelineClip[]} */
  const clips = [];

  for (let i = 0; i < sweeps.length; i += 1) {
    const sweep = sweeps[i];
    clips.push(makeSweepClip(sweep.label, sweep.durationMs, sweep.from, sweep.to, sweep.sweepPair));

    const assigned = interstitialAssignments[i];
    if (assigned && i < sweeps.length - 1) {
      const nextSweep = sweeps[i + 1];
      const holdMs = Math.max(500, (assigned.holdSec ?? defaultHoldSec) * 1000);
      const sigView = sigLocToView(assigned, scaleMul);
      clips.push(...interstitialClips(
        sweep, nextSweep, assigned, sigView, transitionMs, holdMs, mapDims, fadeCutMs,
      ));
    }
  }

  /** @type {string[]} */
  const unplaced = [];

  for (const loc of pinnedSplits) {
    const target = loc.placementTarget || '';
    const ok = splitClipForLocTarget(
      clips, loc, target, defaultHoldSec, scaleMul, transitionMs, mapDims, fadeCutMs,
    );
    if (!ok) autoQueue.push(loc);
  }

  while (autoQueue.length > 0) {
    const loc = autoQueue.shift();
    if (!loc) break;
    const ok = splitClipForLoc(
      clips, loc, defaultHoldSec, scaleMul, transitionMs, mapDims, fadeCutMs,
    );
    if (!ok) {
      unplaced.push(loc.id);
    }
  }

  /** Guard: sigHold must not be first or last clip. */
  while (clips.length > 1) {
    const first = clips[0];
    const last = clips[clips.length - 1];
    if (first.type === 'sigHold') {
      if (first.sigLocId) unplaced.push(first.sigLocId);
      clips.shift();
      continue;
    }
    if (last.type === 'sigHold') {
      if (last.sigLocId) unplaced.push(last.sigLocId);
      clips.pop();
      continue;
    }
    break;
  }

  return finalizeTimeline(clips, [...new Set(unplaced)]);
}

export { computeTimelineVisibleMotionMs };
