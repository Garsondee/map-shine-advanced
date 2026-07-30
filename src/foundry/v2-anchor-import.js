/**
 * V2 → V3 ANCHOR IMPORT — read a scene's legacy Map Point groups and produce
 * V3 anchor candidates, per scene, non-destructively.
 *
 * ============================================================================
 * WHAT THIS DOES, AND WHERE IT SITS
 * ============================================================================
 *
 * V2 stored "map point groups" — placed `{x,y}` points that spawn effects — in
 * `scene.flags['map-shine-advanced'].mapPointGroups` (and a v1.x ancestor in the
 * `map-shine` namespace). This module READS that flag data and normalises the
 * DISCRETE, anchor-eligible groups (a candle, a lightning point) into plain V3
 * anchor candidates the anchor authority can serve. Region groups (fire, water)
 * are NOT anchors — they belong to the paint pipeline (Authoring-and-
 * Distribution.md §2) — so they are reported as skipped, never guessed at.
 *
 * `foundry/` is a LEAF (foundry/index.js header): it may not import `scene/` or
 * `effects/`. So this module knows NOTHING about anchor kinds — boot injects a
 * `resolveKind(v2EffectTarget)` closure (scene/anchor-catalog.js#anchorKind
 * ByV2EffectTarget) and hands the produced candidates to the authority. The
 * V2→kind mapping lives in the catalog, in one place; this file only reads flags
 * and fixes coordinates. Dependency inversion, exactly as the mask authority
 * receives its `resolvePlacement`/`readPageImageData` closures.
 *
 * ============================================================================
 * THE COORDINATE TRAP — read this before touching the Y math
 * ============================================================================
 *
 * This is the project's oldest recurring bug (memory: feedback_y_flip_recurring_
 * risk; the structural wall gpu/no-handrolled-fullscreen-quad exists for it).
 * The correct mapping is COUNTERINTUITIVE, so it is derived here, not guessed:
 *
 *   - V3 world space = Foundry canvas space, +Y DOWN (foundry/scene-geometry.js
 *     §"World space IS Foundry's canvas space"). A V3 world Y is a raw Foundry Y.
 *   - V2's CURRENT namespace (`map-shine-advanced`) stored points Y-UP: V2's
 *     `Coordinates.toWorld(x,y)` returned `{ x, y: h - foundryY }` (legacy/utils/
 *     coordinates.js:18). So a stored value is `h - foundryY`.
 *       → to recover V3 world Y (= foundryY): `v3y = h - stored`.  **FLIP.**
 *   - V2's LEGACY namespace (`map-shine`, raw v1.x) stored raw Foundry coords
 *     (Y-down) — V2's own migration comment says so (map-points-manager.js:583).
 *       → that value IS already a V3 world Y.  **NO FLIP.**
 *
 * So the CURRENT (common) data flips and the LEGACY data does not — the reverse
 * of the naive assumption. X is unchanged in both (toWorld left x alone). `h` is
 * the PADDED canvas height (computeSceneDimensions().height = V2's
 * `canvas.dimensions.height`). Verify live against a known candle before trusting
 * the eye on a symmetric map (feedback_y_flip_recurring_risk).
 *
 * @module foundry/v2-anchor-import
 */

import { computeSceneDimensions } from './scene-geometry.js';

/** Current MSA flag namespace (V2 wrote here after its own v1→v2 migration). */
const MODULE_ID = 'map-shine-advanced';
/** v1.x Map Shine namespace — raw Foundry-coord points, only if never V2-migrated. */
const LEGACY_MODULE_ID = 'map-shine';

/**
 * Reserved scene-flag key marking that this scene's V2 map points have been
 * ASSIMILATED and their old flags removed (the reversible cleanup step, not
 * built in Tier 0). Read by detection so the future per-scene "assimilate?"
 * prompt does not re-offer an already-cleaned scene; NOT written here, because
 * Tier-0 import is non-destructive and re-runnable (the authority replaces
 * wholesale, so a re-import is idempotent, not a duplicate).
 */
export const V2_IMPORT_SENTINEL = 'anchorsImportedFromV2';

/**
 * Read the scene's map-point group blob, preferring the current namespace and
 * falling back to the legacy one — mirrors V2's own loadFromScene namespace
 * logic (map-points-manager.js:511-543), including the `mapPointGroupsInitialized`
 * sentinel that distinguishes "V2 wrote empty" from "never V2".
 *
 * @param {object} scene - a Foundry Scene document.
 * @returns {{groupsData: object|null, fromLegacy: boolean}}
 */
function readGroupsData(scene) {
  let v2Initialized = false;
  try {
    v2Initialized = Boolean(scene?.getFlag?.(MODULE_ID, 'mapPointGroupsInitialized'));
  } catch {
    v2Initialized = false;
  }

  let groupsData = null;
  try {
    groupsData = scene?.getFlag?.(MODULE_ID, 'mapPointGroups') ?? null;
  } catch {
    groupsData = null;
  }
  if (groupsData && typeof groupsData === 'object') return { groupsData, fromLegacy: false };
  if (v2Initialized) return { groupsData: {}, fromLegacy: false }; // V2 present but empty — not legacy

  // Never V2: the raw v1.x namespace. getFlag can throw if `map-shine` isn't a
  // registered module here, so read the flags object directly (V2 did the same).
  let legacy = null;
  try {
    legacy = scene?.getFlag?.(LEGACY_MODULE_ID, 'mapPointGroups') ?? null;
  } catch {
    legacy = null;
  }
  legacy ??= scene?.flags?.[LEGACY_MODULE_ID]?.mapPointGroups ?? null;
  if (legacy && typeof legacy === 'object') return { groupsData: legacy, fromLegacy: true };

  return { groupsData: null, fromLegacy: false };
}

/**
 * Cheap detection for boot's per-scene "does this old map have V2 candles?"
 * check on canvasReady. Reads flags only; no writes, no conversion.
 *
 * @param {object} scene - a Foundry Scene document.
 * @returns {{present: boolean, fromLegacy: boolean, alreadyImported: boolean, groupCount: number}}
 */
export function detectV2MapPoints(scene) {
  const { groupsData, fromLegacy } = readGroupsData(scene);
  const groupCount = groupsData ? Object.keys(groupsData).length : 0;
  let alreadyImported = false;
  try {
    alreadyImported = Boolean(scene?.getFlag?.(MODULE_ID, V2_IMPORT_SENTINEL));
  } catch {
    alreadyImported = false;
  }
  return { present: groupCount > 0, fromLegacy, alreadyImported, groupCount };
}

/**
 * Whether a group is an active effect source, mirroring V2's own derivation
 * (map-points-manager.js:686): explicit `isEffectSource === false` wins;
 * otherwise a non-empty `effectTarget` makes it a source.
 * @param {object} group
 * @returns {boolean}
 */
function isEffectSource(group) {
  if (group?.isEffectSource === false) return false;
  return String(group?.effectTarget ?? '').trim().length > 0;
}

/**
 * Import a scene's V2 map points into V3 anchor candidates. Non-destructive:
 * reads flags, returns plain data, never writes the scene. Boot hands the
 * result to the anchor authority (`authority.reset`).
 *
 * @param {object} scene - a Foundry Scene document.
 * @param {object} deps
 * @param {(v2EffectTarget: string) => ({id: string}|null)} deps.resolveKind -
 *   maps a V2 `effectTarget` string to its V3 anchor kind (or null if it is a
 *   region/unported effect). Injected by boot from scene/anchor-catalog.js.
 * @returns {{
 *   present: boolean, fromLegacy: boolean, alreadyImported: boolean,
 *   coordsFlipped: boolean, groupsTotal: number,
 *   anchors: Array<object>, skipped: Array<object>, report: object
 * }}
 */
export function importV2Anchors(scene, { resolveKind }) {
  const { groupsData, fromLegacy } = readGroupsData(scene);
  const detected = detectV2MapPoints(scene);
  const anchors = [];
  const skipped = [];

  if (!groupsData || typeof groupsData !== 'object') {
    return {
      present: false,
      fromLegacy,
      alreadyImported: detected.alreadyImported,
      coordsFlipped: false,
      groupsTotal: 0,
      anchors,
      skipped,
      report: emptyReport(),
    };
  }

  const { height } = computeSceneDimensions(scene);
  // See the header's coordinate derivation. CURRENT namespace flips (was Y-up);
  // LEGACY is already Foundry Y-down (= V3 world) and does not.
  const toV3Y = fromLegacy ? (y) => y : (y) => height - y;
  const coordsFlipped = !fromLegacy;

  const entries = Object.entries(groupsData);
  for (const [groupId, group] of entries) {
    if (!group || typeof group !== 'object') continue;
    const effectTarget = String(group.effectTarget ?? '').trim();
    if (!isEffectSource(group) || effectTarget.length === 0) continue;

    const kind = resolveKind(effectTarget);
    const points = Array.isArray(group.points) ? group.points : [];
    if (!kind) {
      // A real effect source we cannot map to an anchor kind — a region effect
      // (fire/water → paint) or an unported one. Reported, never guessed.
      skipped.push({
        groupId,
        effectTarget,
        pointCount: points.length,
        reason: 'no V3 anchor kind (region effect → paint, or unported)',
      });
      continue;
    }

    const floorBinding = group.metadata?.levelBinding ?? null;
    const intensity = Number(group.emission?.intensity);
    const commonParams = Number.isFinite(intensity) ? { intensity } : {};

    // LINKED-ENDPOINTS KINDS (scene/anchor-catalog.js's own field, e.g.
    // `lightning`) — a group is not flattened into N independent anchors;
    // its FIRST and LAST finite point become one linked start/end pair
    // (a V2 2-point group's only pair, or a 3+-point "wandering" group's
    // outer two), and any INTERIOR points import as inert `role:'waypoint'`
    // anchors on the same linkId — preserved data, not acted on by v1's
    // runtime (effects/lightning.js's own `wandering-source` deferred rung).
    if (kind.importStrategy === 'linkedEndpoints') {
      const finite = [];
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const x = Number(p?.x);
        const y = Number(p?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) finite.push({ i, x, y: toV3Y(y) });
      }
      if (finite.length < 2) {
        skipped.push({
          groupId,
          effectTarget,
          pointCount: points.length,
          reason: 'a linkedEndpoints kind needs at least 2 finite points',
        });
        continue;
      }
      const linkId = `v2:${groupId}`;
      const first = finite[0];
      const last = finite[finite.length - 1];
      anchors.push({
        id: `v2:${groupId}:${first.i}`,
        kind: kind.id,
        x: first.x,
        y: first.y,
        floorBinding,
        enabled: true,
        params: { ...commonParams, role: 'start', linkId },
        provenance: 'importedFromV2',
      });
      anchors.push({
        id: `v2:${groupId}:${last.i}`,
        kind: kind.id,
        x: last.x,
        y: last.y,
        floorBinding,
        enabled: true,
        params: { ...commonParams, role: 'end', linkId },
        provenance: 'importedFromV2',
      });
      for (let w = 1; w < finite.length - 1; w++) {
        anchors.push({
          id: `v2:${groupId}:${finite[w].i}`,
          kind: kind.id,
          x: finite[w].x,
          y: finite[w].y,
          floorBinding,
          enabled: true,
          params: { ...commonParams, role: 'waypoint', linkId },
          provenance: 'importedFromV2',
        });
      }
      continue;
    }

    let placed = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const x = Number(p?.x);
      const y = Number(p?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      anchors.push({
        id: `v2:${groupId}:${i}`,
        kind: kind.id,
        x,
        y: toV3Y(y),
        floorBinding,
        enabled: true,
        // V2's per-group emission.intensity → per-anchor param. If the value is
        // absent/invalid the authority's hydrateParams supplies the catalog
        // default (validate-at-write); we only forward a finite reading.
        params: commonParams,
        provenance: 'importedFromV2',
      });
      placed++;
    }
    if (placed === 0) {
      skipped.push({ groupId, effectTarget, pointCount: points.length, reason: 'no finite points to place' });
    }
  }

  const byKind = {};
  for (const a of anchors) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;

  return {
    present: detected.present,
    fromLegacy,
    alreadyImported: detected.alreadyImported,
    coordsFlipped,
    groupsTotal: entries.length,
    anchors,
    skipped,
    report: {
      present: detected.present,
      source: fromLegacy
        ? `legacy '${LEGACY_MODULE_ID}' (v1.x, Foundry Y-down — no flip)`
        : `'${MODULE_ID}' (V2 Y-up — flipped to V3)`,
      coordsFlipped,
      sceneHeightPx: height,
      groupsTotal: entries.length,
      anchorsProduced: anchors.length,
      byKind,
      skipped,
      // First few placements, for eyeballing "did the candles land where the old
      // ones were" against the map before pixels exist.
      sample: anchors.slice(0, 8).map((a) => ({ id: a.id, x: Math.round(a.x), y: Math.round(a.y) })),
    },
  };
}

function emptyReport() {
  return {
    present: false,
    source: 'no V2 map point groups on this scene',
    coordsFlipped: false,
    groupsTotal: 0,
    anchorsProduced: 0,
    byKind: {},
    skipped: [],
    sample: [],
  };
}
