/**
 * v2-anchor-import.test.mjs — the V2 → V3 import, with the COORDINATE FLIP
 * pinned in both directions (the project's oldest bug class). Current-namespace
 * data is Y-up and MUST flip; legacy v1.x data is already Foundry Y-down and
 * MUST NOT. Getting either backwards is a silent vertical mirror.
 */
import { importV2Anchors, detectV2MapPoints, V2_IMPORT_SENTINEL } from '../v2-anchor-import.js';
import { computeSceneDimensions } from '../scene-geometry.js';

/** Boot injects this from scene/anchor-catalog.js; the importer stays leaf. */
const resolveKind = (target) => (target === 'candleFlame' ? { id: 'candleFlame' } : null);

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
}
