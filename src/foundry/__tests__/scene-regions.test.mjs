/**
 * Node verification for foundry/scene-regions.js. Only `deriveRegionDarknessAdjuster`
 * (and the always-a-stub `readSuppressWeatherStub`) are testable here — the
 * live `canvas.scene.regions` read is browser-only, same split as every
 * other reader in this zone.
 */
import { deriveRegionDarknessAdjuster, readSuppressWeatherStub } from '../scene-regions.js';

const SHAPES = [{ type: 'circle', x: 0, y: 0, radius: 100 }];

export function run(t) {
  const { ok } = t;

  {
    const raw = {
      regionId: 'Region.abc123',
      hidden: false,
      shapes: SHAPES,
      elevationBottom: 0,
      elevationTop: 10,
      behaviors: [{ type: 'adjustDarknessLevel', disabled: false, mode: 2, modifier: 0.4 }],
    };
    const adj = deriveRegionDarknessAdjuster(raw);
    ok('a valid region with an active behavior is not rejected', adj !== null);
    ok('regionId passes through', adj.regionId === 'Region.abc123');
    ok('mode passes through', adj.mode === 2);
    ok('modifier passes through', adj.modifier === 0.4);
    ok('shapes passes through by reference', adj.shapes === SHAPES);
    ok('elevationBottom passes through', adj.elevationBottom === 0);
    ok('elevationTop passes through', adj.elevationTop === 10);
  }

  // ---- elevation.{bottom,top} — 2026-07-19, the multi-floor darkness fix --
  {
    const adj = deriveRegionDarknessAdjuster({
      regionId: 'a',
      hidden: false,
      shapes: SHAPES,
      behaviors: [{ type: 'adjustDarknessLevel', disabled: false, mode: 0, modifier: 1 }],
    });
    ok(
      'missing elevationBottom/elevationTop reads as null (Foundry\'s own "unrestricted" convention), never 0',
      adj.elevationBottom === null && adj.elevationTop === null
    );
  }
  ok(
    'a negative elevationBottom (a basement) passes through, never clamped',
    deriveRegionDarknessAdjuster({
      regionId: 'a',
      hidden: false,
      shapes: SHAPES,
      elevationBottom: -50,
      behaviors: [{ type: 'adjustDarknessLevel', disabled: false, mode: 0, modifier: 1 }],
    }).elevationBottom === -50
  );
  {
    const adj = deriveRegionDarknessAdjuster({
      regionId: 'a',
      hidden: false,
      shapes: SHAPES,
      elevationBottom: NaN,
      elevationTop: 'nope',
      behaviors: [{ type: 'adjustDarknessLevel', disabled: false, mode: 0, modifier: 1 }],
    });
    ok(
      'a non-finite elevation value reads as null (unrestricted), never NaN or propagated as-is',
      adj.elevationBottom === null && adj.elevationTop === null
    );
  }

  ok(
    'a hidden region contributes nothing',
    deriveRegionDarknessAdjuster({ regionId: 'a', hidden: true, shapes: SHAPES, behaviors: [] }) === null
  );
  ok('missing raw reads as null, never throws', deriveRegionDarknessAdjuster(null) === null);
  ok(
    'missing regionId contributes nothing (no stable key to pool a mesh against)',
    deriveRegionDarknessAdjuster({ hidden: false, shapes: SHAPES, behaviors: [] }) === null
  );
  ok(
    'empty-string regionId contributes nothing',
    deriveRegionDarknessAdjuster({ regionId: '', hidden: false, shapes: SHAPES, behaviors: [] }) === null
  );
  ok(
    'non-string regionId contributes nothing',
    deriveRegionDarknessAdjuster({ regionId: 42, hidden: false, shapes: SHAPES, behaviors: [] }) === null
  );
  ok(
    'no shapes contributes nothing',
    deriveRegionDarknessAdjuster({ regionId: 'a', hidden: false, shapes: [], behaviors: [] }) === null
  );
  ok(
    'missing shapes array contributes nothing',
    deriveRegionDarknessAdjuster({ regionId: 'a', hidden: false, behaviors: [] }) === null
  );
  ok(
    'no adjustDarknessLevel behavior at all contributes nothing',
    deriveRegionDarknessAdjuster({
      regionId: 'a',
      hidden: false,
      shapes: SHAPES,
      behaviors: [{ type: 'teleportToken', disabled: false }],
    }) === null
  );
  ok(
    'a DISABLED adjustDarknessLevel behavior contributes nothing',
    deriveRegionDarknessAdjuster({
      regionId: 'a',
      hidden: false,
      shapes: SHAPES,
      behaviors: [{ type: 'adjustDarknessLevel', disabled: true, mode: 0, modifier: 0.5 }],
    }) === null
  );
  {
    // Two behaviors, only the second is an active adjustDarknessLevel —
    // the reader should find it regardless of position.
    const adj = deriveRegionDarknessAdjuster({
      regionId: 'a',
      hidden: false,
      shapes: SHAPES,
      behaviors: [
        { type: 'teleportToken', disabled: false },
        { type: 'adjustDarknessLevel', disabled: false, mode: 1, modifier: 0.25 },
      ],
    });
    ok('finds the active adjustDarknessLevel behavior among others', adj !== null && adj.mode === 1);
  }
  {
    const adj = deriveRegionDarknessAdjuster({
      regionId: 'a',
      hidden: false,
      shapes: SHAPES,
      behaviors: [{ type: 'adjustDarknessLevel', disabled: false }],
    });
    ok("missing mode reads as OVERRIDE (0), matching the schema's own default", adj.mode === 0);
    ok('missing modifier reads as 0', adj.modifier === 0);
  }
  ok(
    'non-array behaviors reads as no match, never throws',
    deriveRegionDarknessAdjuster({ regionId: 'a', hidden: false, shapes: SHAPES, behaviors: null }) === null
  );

  // ---- the deliberate stub -------------------------------------------------
  {
    const stub = readSuppressWeatherStub();
    ok('the weather-suppression stub always reads as nothing-suppressed', stub.suppressed === false);
    ok(
      'the stub is honestly labelled notBuilt, not silently indistinguishable from a real check',
      stub.notBuilt === true
    );
  }
}
