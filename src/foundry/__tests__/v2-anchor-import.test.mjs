/**
 * v2-anchor-import.test.mjs — the V2 → V3 import, with the COORDINATE FLIP
 * pinned in both directions (the project's oldest bug class). Current-namespace
 * data is Y-up and MUST flip; legacy v1.x data is already Foundry Y-down and
 * MUST NOT. Getting either backwards is a silent vertical mirror.
 */
import { importV2Anchors, detectV2MapPoints, V2_IMPORT_SENTINEL } from '../v2-anchor-import.js';
import { computeSceneDimensions } from '../scene-geometry.js';

/** Boot injects this from scene/anchor-catalog.js; the importer stays leaf. */
const resolveKind = (target) => {
  if (target === 'candleFlame') return { id: 'candleFlame' };
  if (target === 'lightning') return { id: 'lightning', importStrategy: 'linkedEndpoints' };
  return null;
};

function makeScene({ current = null, initialized = false, legacy = null, sentinel = false, throwLegacy = false } = {}) {
  return {
    width: 1000,
    height: 800,
    padding: 0,
    grid: { size: 100 },
    shiftX: 0,
    shiftY: 0,
    flags: legacy ? { 'map-shine': { mapPointGroups: legacy } } : {},
    getFlag(ns, key) {
      if (ns === 'map-shine-advanced') {
        if (key === 'mapPointGroups') return current;
        if (key === 'mapPointGroupsInitialized') return initialized;
        if (key === V2_IMPORT_SENTINEL) return sentinel;
      }
      if (ns === 'map-shine' && key === 'mapPointGroups') {
        if (throwLegacy) throw new Error('module map-shine not registered');
        return legacy;
      }
      return null;
    },
  };
}

export function run(t) {
  // ======================================================================
  // CURRENT namespace (V2 Y-up) → FLIP
  // ======================================================================
  {
    const scene = makeScene({
      initialized: true,
      current: {
        g1: {
          effectTarget: 'candleFlame',
          isEffectSource: true,
          points: [{ x: 100, y: 200 }],
          emission: { intensity: 0.5 },
          metadata: { levelBinding: { mode: 'all-levels' } },
        },
      },
    });
    const { height } = computeSceneDimensions(scene);
    const res = importV2Anchors(scene, { resolveKind });

    t.ok('current namespace is detected present', res.present === true);
    t.ok('current namespace is NOT flagged legacy', res.fromLegacy === false);
    t.ok('current namespace coordinates are flipped', res.coordsFlipped === true);
    t.ok('one candle anchor produced', res.anchors.length === 1);

    const a = res.anchors[0];
    t.ok('anchor id encodes the group + point index', a.id === 'v2:g1:0');
    t.ok('anchor kind is candleFlame', a.kind === 'candleFlame');
    t.ok('X is unchanged', a.x === 100);
    t.ok('Y is flipped to V3 world (h - y)', a.y === height - 200);
    t.ok('emission.intensity became the anchor param', a.params.intensity === 0.5);
    t.ok('provenance marks it imported', a.provenance === 'importedFromV2');
    t.ok('the level binding is carried through', a.floorBinding?.mode === 'all-levels');
  }

  // ======================================================================
  // LEGACY namespace (v1.x, Foundry Y-down) → NO FLIP
  // ======================================================================
  {
    const scene = makeScene({
      legacy: {
        g2: {
          effectTarget: 'candleFlame',
          isEffectSource: true,
          points: [{ x: 50, y: 100 }],
          emission: { intensity: 1 },
        },
      },
    });
    const res = importV2Anchors(scene, { resolveKind });
    t.ok('legacy namespace is flagged legacy', res.fromLegacy === true);
    t.ok('legacy coordinates are NOT flipped', res.coordsFlipped === false);
    t.ok('legacy Y is left as raw Foundry Y', res.anchors[0].y === 100);
    t.ok('legacy X is unchanged', res.anchors[0].x === 50);
  }

  // legacy via the flags fallback when getFlag throws (unregistered module)
  {
    const scene = makeScene({
      legacy: { g3: { effectTarget: 'candleFlame', isEffectSource: true, points: [{ x: 1, y: 2 }] } },
      throwLegacy: true,
    });
    const res = importV2Anchors(scene, { resolveKind });
    t.ok(
      'a throwing legacy getFlag falls back to the flags object',
      res.fromLegacy === true && res.anchors.length === 1
    );
  }

  // ======================================================================
  // Region effects are SKIPPED (fire → paint, not an anchor), not guessed
  // ======================================================================
  {
    const scene = makeScene({
      initialized: true,
      current: {
        fireGrp: { effectTarget: 'fire', isEffectSource: true, points: [{ x: 1, y: 1 }] },
        candleGrp: { effectTarget: 'candleFlame', isEffectSource: true, points: [{ x: 2, y: 2 }] },
      },
    });
    const res = importV2Anchors(scene, { resolveKind });
    t.ok('only the candle group becomes anchors', res.anchors.length === 1 && res.anchors[0].kind === 'candleFlame');
    t.ok(
      'the fire group is reported skipped (wants painting)',
      res.skipped.some((s) => s.groupId === 'fireGrp')
    );
    t.ok(
      'the skip reason is honest, not a guess',
      res.skipped.some((s) => String(s.reason).includes('no V3 anchor kind'))
    );
  }

  // ======================================================================
  // Non-source groups ignored; multiple + non-finite points handled
  // ======================================================================
  {
    const notSource = makeScene({
      initialized: true,
      current: { g: { effectTarget: 'candleFlame', isEffectSource: false, points: [{ x: 1, y: 1 }] } },
    });
    t.ok('a non-source candle group is ignored', importV2Anchors(notSource, { resolveKind }).anchors.length === 0);

    const multi = makeScene({
      initialized: true,
      current: {
        g: {
          effectTarget: 'candleFlame',
          isEffectSource: true,
          points: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
            { x: 'bad', y: 5 },
          ],
        },
      },
    });
    const res = importV2Anchors(multi, { resolveKind });
    t.ok('two finite points become two anchors; the non-finite one is dropped', res.anchors.length === 2);
    t.ok('point indices are stable in the id', res.anchors[1].id === 'v2:g:1');
  }

  // ======================================================================
  // detectV2MapPoints — the cheap per-scene check + the sentinel
  // ======================================================================
  {
    const empty = makeScene({});
    const det = detectV2MapPoints(empty);
    t.ok('an empty scene is not present', det.present === false && det.groupCount === 0);
    t.ok(
      'an empty scene import is present:false with no anchors',
      importV2Anchors(empty, { resolveKind }).anchors.length === 0
    );

    const withData = makeScene({
      initialized: true,
      current: { g: { effectTarget: 'candleFlame', isEffectSource: true, points: [{ x: 1, y: 1 }] } },
    });
    t.ok('a scene with a group is detected present', detectV2MapPoints(withData).present === true);
    t.ok('groupCount counts the groups', detectV2MapPoints(withData).groupCount === 1);
    t.ok('an un-cleaned scene reports alreadyImported:false', detectV2MapPoints(withData).alreadyImported === false);

    const cleaned = makeScene({ sentinel: true });
    t.ok(
      'the import sentinel is read back (for the future cleanup step)',
      detectV2MapPoints(cleaned).alreadyImported === true
    );
  }

  // ======================================================================
  // LINKED-ENDPOINTS KINDS (lightning) — a group is NOT flattened; its
  // first/last finite point become one linked start/end pair, interior
  // points import as inert waypoints on the same linkId.
  // ======================================================================
  {
    // A 2-point V2 lightning group → exactly one linked start/end pair.
    const scene = makeScene({
      initialized: true,
      current: {
        bolt1: {
          effectTarget: 'lightning',
          isEffectSource: true,
          points: [
            { x: 100, y: 200 },
            { x: 500, y: 600 },
          ],
          emission: { intensity: 0.75 },
        },
      },
    });
    const { height } = computeSceneDimensions(scene);
    const res = importV2Anchors(scene, { resolveKind });
    t.ok('a 2-point linkedEndpoints group produces exactly 2 anchors', res.anchors.length === 2);
    const start = res.anchors.find((a) => a.params.role === 'start');
    const end = res.anchors.find((a) => a.params.role === 'end');
    t.ok('a start anchor exists', !!start);
    t.ok('an end anchor exists', !!end);
    t.ok('no waypoint anchors for a 2-point group', !res.anchors.some((a) => a.params.role === 'waypoint'));
    t.ok('start/end share one linkId', start.params.linkId === end.params.linkId);
    t.ok('the linkId is derived from the group id', start.params.linkId === 'v2:bolt1');
    t.ok('start coordinates match the first point (Y-flipped)', start.x === 100 && start.y === height - 200);
    t.ok('end coordinates match the last point (Y-flipped)', end.x === 500 && end.y === height - 600);
    t.ok(
      'emission.intensity became each anchor’s own param',
      start.params.intensity === 0.75 && end.params.intensity === 0.75
    );
    t.ok('ids stay stable and index-anchored', start.id === 'v2:bolt1:0' && end.id === 'v2:bolt1:1');

    // A 3+-point V2 "wandering" lightning group → start + end + waypoint(s),
    // all sharing the SAME linkId — preserved, not acted on by v1.
    const wanderingScene = makeScene({
      initialized: true,
      current: {
        bolt2: {
          effectTarget: 'lightning',
          isEffectSource: true,
          points: [
            { x: 0, y: 0 },
            { x: 50, y: 50 },
            { x: 100, y: 0 },
          ],
        },
      },
    });
    const wRes = importV2Anchors(wanderingScene, { resolveKind });
    t.ok('a 3-point group produces exactly 3 anchors (start+end+1 waypoint)', wRes.anchors.length === 3);
    const roles = wRes.anchors.map((a) => a.params.role).sort();
    t.ok('roles are exactly start/end/waypoint', roles.join(',') === 'end,start,waypoint');
    const linkIds = new Set(wRes.anchors.map((a) => a.params.linkId));
    t.ok('all 3 anchors share ONE linkId', linkIds.size === 1);

    // Fewer than 2 finite points → skipped, not a crash or a 1-anchor guess.
    const tooFew = makeScene({
      initialized: true,
      current: { bolt3: { effectTarget: 'lightning', isEffectSource: true, points: [{ x: 1, y: 1 }] } },
    });
    const fewRes = importV2Anchors(tooFew, { resolveKind });
    t.ok('a linkedEndpoints group with <2 finite points produces no anchors', fewRes.anchors.length === 0);
    t.ok(
      'it is reported skipped with an honest reason',
      fewRes.skipped.some((s) => s.groupId === 'bolt3' && String(s.reason).includes('linkedEndpoints'))
    );

    // Legacy namespace (Y-down, no flip) still applies correctly under the
    // linkedEndpoints strategy — the coordinate rule is orthogonal to it.
    const legacyBolt = makeScene({
      legacy: {
        bolt4: {
          effectTarget: 'lightning',
          isEffectSource: true,
          points: [
            { x: 10, y: 20 },
            { x: 30, y: 40 },
          ],
        },
      },
    });
    const legacyRes = importV2Anchors(legacyBolt, { resolveKind });
    t.ok('legacy-namespace linkedEndpoints anchors are NOT Y-flipped', legacyRes.coordsFlipped === false);
    t.ok(
      'legacy Y values are left as raw Foundry Y',
      legacyRes.anchors.find((a) => a.params.role === 'start').y === 20 &&
        legacyRes.anchors.find((a) => a.params.role === 'end').y === 40
    );
  }
}
