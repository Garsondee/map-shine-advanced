/**
 * Node verification for effects/lighting/point-light-pool.js.
 *
 * `resolveLightElevationRank` (a Foundry document's own `.elevation`) and its
 * sibling `resolveAnchorElevationRank` (an anchor's `floorBinding`, 2026-08-03
 * — candle/lightning share the SAME height gate) are tested here — the FLOOR-
 * RESOLUTION half of the height/elevation gate; the GATE ARITHMETIC itself is
 * `point-light-illumination.test.mjs#computeHeightGate`'s job.
 * `createLightEntry`/`update()` build/orchestrate real THREE meshes and
 * scenes and are not unit-tested anywhere in this file today (matching this
 * module's own general shape — a viewer-adjacent orchestrator, verified live
 * rather than in Node, same posture `vt-pan-viewer.js` has always had).
 */
import { resolveLightElevationRank, resolveAnchorElevationRank } from '../point-light-pool.js';
import { LIGHT_ELEVATION_UNCONFIGURED_SENTINEL, elevationRank } from '../point-light-illumination.js';

const FLOORS = [
  { index: 0, id: 'basement', elevationBottom: -10, elevationTop: 0 },
  { index: 1, id: 'ground', elevationBottom: 0, elevationTop: 10 },
  { index: 2, id: 'middle', elevationBottom: 10, elevationTop: 20 },
  { index: 3, id: 'roof', elevationBottom: 20, elevationTop: 30 },
];

export function run(t) {
  const { ok } = t;

  ok(
    'an untouched light (elevation 0, Foundry´s own schema default) reads as the unconfigured sentinel',
    resolveLightElevationRank({ elevation: 0 }, FLOORS) === LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );
  ok(
    'a missing elevation field (candle/lightning lights, which carry none) reads the same as 0',
    resolveLightElevationRank({}, FLOORS) === LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );
  ok(
    'a light object that is itself null/undefined never throws, reads as the sentinel',
    resolveLightElevationRank(null, FLOORS) === LIGHT_ELEVATION_UNCONFIGURED_SENTINEL &&
      resolveLightElevationRank(undefined, FLOORS) === LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );
  ok(
    'a NaN elevation reads the same as 0 — the sentinel, never NaN propagating downstream',
    resolveLightElevationRank({ elevation: NaN }, FLOORS) === LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );

  ok(
    'a light explicitly placed at elevation 5 on the ground floor [0,10) carries BOTH that floor´s own ' +
      'index and its 5-above-the-ground height',
    resolveLightElevationRank({ elevation: 5 }, FLOORS) === elevationRank(1, 5)
  );
  ok(
    'a light on the MIDDLE floor resolves relative to THAT floor´s own bottom (10), not world zero',
    resolveLightElevationRank({ elevation: 15 }, FLOORS) === elevationRank(2, 5)
  );
  ok(
    'a light on the ROOF floor resolves relative to ITS OWN bottom (20) too',
    resolveLightElevationRank({ elevation: 25 }, FLOORS) === elevationRank(3, 5)
  );
  ok(
    // The exact edge case that motivated checking the SENTINEL on raw
    // elevation, never on the derived "above floor" value: elevation 10 is
    // NOT Foundry's schema default, but "above floor bottom" happens to
    // compute to 0 anyway (10 - 10 = 0) — a genuine, distinct height, not
    // "never configured".
    'a light DELIBERATELY placed exactly at a non-ground floor´s own bottom (10) resolves to a REAL ' +
      'rank on THAT floor, not the unconfigured sentinel',
    resolveLightElevationRank({ elevation: 10 }, FLOORS) === elevationRank(2, 0) &&
      resolveLightElevationRank({ elevation: 10 }, FLOORS) !== LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );
  ok(
    'a light on an UNDERGROUND floor resolves relative to ITS OWN (negative) bottom, not world zero — ' +
      'the exact shape of the author´s own multi-floor map (an underground floor below a middle one)',
    resolveLightElevationRank({ elevation: -8 }, FLOORS) === elevationRank(0, 2)
  );

  // ⚠️ THE REGRESSION THIS WHOLE RANK EXISTS FOR (live, 2026-08-03). Two
  // lights on DIFFERENT floors, each sitting exactly on its own floor's
  // ground, used to return the SAME number (0) — which is how a -20ft
  // basement light came to light a +5ft upper storey. They must now be
  // strictly ordered by floor.
  ok(
    'two lights at their OWN floors´ grounds are no longer indistinguishable — the basement´s rank is ' +
      'strictly below the ground floor´s, which is strictly below the middle´s',
    resolveLightElevationRank({ elevation: -10 }, FLOORS) < resolveLightElevationRank({ elevation: 0.001 }, FLOORS) &&
      resolveLightElevationRank({ elevation: 0.001 }, FLOORS) < resolveLightElevationRank({ elevation: 10 }, FLOORS)
  );
  ok(
    // ⚠️ Every height here must stay INSIDE the basement's own [-10,0) band.
    // A first draft swept up to +99, which resolves onto the ROOF floor and
    // correctly outranks the middle — the test's own premise ("a light high
    // inside a LOWER floor") had quietly stopped holding, not the code.
    'a light anywhere inside the basement band still ranks below one on the middle floor´s ground — ' +
      'the floor index dominates the height, at every height within the floor',
    [0, 1, 5, 9, 9.9].every(
      (h) =>
        resolveLightElevationRank({ elevation: -10 + h }, FLOORS) < resolveLightElevationRank({ elevation: 10 }, FLOORS)
    )
  );

  ok(
    'no floors resolvable (empty array) reads as the unconfigured sentinel, never throws',
    resolveLightElevationRank({ elevation: 15 }, []) === LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );
  ok(
    'a non-array floors argument reads as the sentinel too, never throws',
    resolveLightElevationRank({ elevation: 15 }, null) === LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );
  ok(
    'an elevation past every floor´s own band still resolves (falls to the topmost floor, ' +
      'resolveElevationFloorIndex´s own painter´s-algorithm fallback) rather than reading as unconfigured',
    resolveLightElevationRank({ elevation: 999 }, FLOORS) === elevationRank(3, 999 - 20)
  );

  // ======================================================================
  // resolveAnchorElevationRank — the candle/lightning sibling. Height within
  // its own floor defaults to 0 (lightning still authors no z-height) but a
  // caller may pass its own real value (candles, since 2026-08-05) — most
  // assertions below are still really about FLOOR resolution and the
  // sentinel, since that part is unaffected by the height argument.
  // ======================================================================
  ok(
    'a LOCKED binding with no third arg resolves to its own floor, height 0 — the honest default for a ' +
      'caller (lightning) that authors no z-height',
    resolveAnchorElevationRank({ mode: 'locked', bottom: 10, top: 20 }, FLOORS) === elevationRank(2, 0)
  );
  ok(
    'a LOCKED binding with an authored height passes it straight through to elevationRank',
    resolveAnchorElevationRank({ mode: 'locked', bottom: 10, top: 20 }, FLOORS, 6) === elevationRank(2, 6)
  );
  ok(
    'a non-finite third arg falls back to height 0, never NaN propagating downstream',
    resolveAnchorElevationRank({ mode: 'locked', bottom: 10, top: 20 }, FLOORS, NaN) === elevationRank(2, 0) &&
      resolveAnchorElevationRank({ mode: 'locked', bottom: 10, top: 20 }, FLOORS, undefined) === elevationRank(2, 0)
  );
  ok(
    'a height that stays within the anchor´s own floor band keeps that floor´s index (no crossing)',
    resolveAnchorElevationRank({ mode: 'locked', bottom: 0, top: 10 }, FLOORS, 5) === elevationRank(1, 5)
  );
  ok(
    'a height tall enough to clear the anchor´s own floor´s top re-attributes it to the floor ABOVE — the ' +
      '2026-08-05 fix: the flame´s own gate can now cross floors the same way its cast light already can ' +
      '(depth-authority.js#rankOfElevation), instead of only nudging a fraction capped well under one floor',
    resolveAnchorElevationRank({ mode: 'locked', bottom: 0, top: 10 }, FLOORS, 15) === elevationRank(2, 5)
  );
  ok(
    'a height tall enough to clear TWO floors´ worth re-attributes past both',
    resolveAnchorElevationRank({ mode: 'locked', bottom: 0, top: 10 }, FLOORS, 25) === elevationRank(3, 5)
  );
  ok(
    'an ALL-LEVELS binding (the author´s own "show everywhere" choice, or a kind´s default) reads as the ' +
      'sentinel, never floor 0 — gating it would silently narrow a deliberately widened feature',
    resolveAnchorElevationRank({ mode: 'all-levels', bottom: null, top: null }, FLOORS) ===
      LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );
  ok(
    'a missing/null binding reads as the sentinel too, never throws',
    resolveAnchorElevationRank(null, FLOORS) === LIGHT_ELEVATION_UNCONFIGURED_SENTINEL &&
      resolveAnchorElevationRank(undefined, FLOORS) === LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );
  ok(
    'a locked binding with a non-finite bottom reads as the sentinel, never NaN propagating downstream',
    resolveAnchorElevationRank({ mode: 'locked', bottom: NaN, top: 20 }, FLOORS) ===
      LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );
  ok(
    'no floors resolvable reads as the sentinel, never throws',
    resolveAnchorElevationRank({ mode: 'locked', bottom: 10, top: 20 }, []) === LIGHT_ELEVATION_UNCONFIGURED_SENTINEL &&
      resolveAnchorElevationRank({ mode: 'locked', bottom: 10, top: 20 }, null) ===
        LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
  );
  ok(
    'a locked binding on the UNDERGROUND floor resolves to THAT floor´s own rank, not the ground´s — the ' +
      'exact cross-floor case candle/lightning share with a Foundry light',
    resolveAnchorElevationRank({ mode: 'locked', bottom: -10, top: 0 }, FLOORS) === elevationRank(0, 0) &&
      resolveAnchorElevationRank({ mode: 'locked', bottom: -10, top: 0 }, FLOORS) <
        resolveAnchorElevationRank({ mode: 'locked', bottom: 0, top: 10 }, FLOORS)
  );
}
