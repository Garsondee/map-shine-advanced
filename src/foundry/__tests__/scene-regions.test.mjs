/**
 * Node verification for foundry/scene-regions.js. `deriveRegionDarknessAdjusters`
 * (and the always-a-stub `readSuppressWeatherStub`) are pure; the live readers
 * (`readActiveDarknessRegions`, `readRegionViewedLevelId`) are driven here with a
 * stand-in `canvas` global holding plain objects shaped like v14's documents
 * (`region.levels` a Set, behaviours with ids), restored afterwards.
 *
 * The module is imported as a namespace so this file still RUNS against an older
 * scene-regions.js (the proof that the 2026-11-09 tests fail on the old reader):
 * a missing export reads as a failed check, not a crashed suite.
 */
import * as SR from '../scene-regions.js';

const SHAPES = [{ type: 'circle', x: 0, y: 0, radius: 100 }];
const dark = (mode, modifier, extra = {}) => ({
  type: 'adjustDarknessLevel',
  disabled: false,
  mode,
  modifier,
  ...extra,
});

/** A live-shaped Region for the stand-in canvas. */
function liveRegion({ id, levels = [], elevation = { bottom: null, top: null }, behaviors, hidden = false }) {
  return {
    id,
    hidden,
    shapes: SHAPES,
    elevation,
    levels: new Set(levels),
    behaviors: behaviors.map((b, i) => ({
      id: b.id ?? `B${i}`,
      type: b.type ?? 'adjustDarknessLevel',
      disabled: b.disabled === true,
      system: { mode: b.mode, modifier: b.modifier },
    })),
  };
}

/** Run `fn` with `globalThis.canvas` set to `value`, then put the old one back. */
function withCanvas(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'canvas');
  const old = globalThis.canvas;
  globalThis.canvas = value;
  try {
    return fn();
  } finally {
    if (had) globalThis.canvas = old;
    else delete globalThis.canvas;
  }
}

export function run(t) {
  const { ok } = t;
  const derive = SR.deriveRegionDarknessAdjusters;
  ok('deriveRegionDarknessAdjusters is exported (one adjuster per darkness behaviour)', typeof derive === 'function');

  if (typeof derive === 'function') {
    {
      const raw = {
        regionId: 'Region.abc123',
        hidden: false,
        shapes: SHAPES,
        elevationBottom: 0,
        elevationTop: 10,
        levels: ['LevelGround'],
        behaviors: [dark(2, 0.4, { id: 'beh1' })],
      };
      const list = derive(raw);
      ok('a valid region with one active behaviour gives exactly one adjuster', list.length === 1);
      const adj = list[0] ?? {};
      ok('regionId passes through', adj.regionId === 'Region.abc123');
      ok('the key names the region and the behaviour', adj.key === 'Region.abc123#beh1');
      ok('behaviorId passes through', adj.behaviorId === 'beh1');
      ok('mode passes through', adj.mode === 2);
      ok('modifier passes through', adj.modifier === 0.4);
      ok('shapes passes through by reference', adj.shapes === SHAPES);
      ok('elevationBottom passes through', adj.elevationBottom === 0);
      ok('elevationTop passes through', adj.elevationTop === 10);
      ok(
        'levels pass through',
        Array.isArray(adj.levels) && adj.levels.length === 1 && adj.levels[0] === 'LevelGround'
      );
    }

    // ---- every behaviour, not the first (2026-11-09, mmp-78u.22 / lab IR-26) --
    {
      const list = derive({
        regionId: 'r',
        hidden: false,
        shapes: SHAPES,
        behaviors: [dark(0, 0.9, { id: 'a' }), { type: 'suppressWeather', disabled: false }, dark(0, 0.4, { id: 'b' })],
      });
      ok('two darkness behaviours on one region give two adjusters', list.length === 2);
      ok(
        'each keeps its own mode and modifier, in authored order',
        list[0]?.modifier === 0.9 && list[1]?.modifier === 0.4 && list[0]?.mode === 0 && list[1]?.mode === 0
      );
      ok('their keys differ, so their meshes never share a pool slot', list[0]?.key !== list[1]?.key);
      ok('both carry the same regionId', list[0]?.regionId === 'r' && list[1]?.regionId === 'r');
    }
    {
      const list = derive({
        regionId: 'r',
        hidden: false,
        shapes: SHAPES,
        behaviors: [dark(0, 0.9), dark(2, 0.5, { disabled: true }), dark(1, 0.25)],
      });
      ok('a disabled behaviour between two active ones is skipped', list.length === 2 && list[1]?.mode === 1);
      ok('a behaviour without an id falls back to its position for the key', list[1]?.key === 'r#2');
    }

    // ---- elevation.{bottom,top} — 2026-07-19, the multi-floor darkness fix --
    {
      const [adj] = derive({ regionId: 'a', hidden: false, shapes: SHAPES, behaviors: [dark(0, 1)] });
      ok(
        'missing elevationBottom/elevationTop reads as null (Foundry\'s own "unrestricted" convention), never 0',
        adj.elevationBottom === null && adj.elevationTop === null
      );
      ok(
        'missing levels reads as [] (every Level, Foundry includedInLevel)',
        Array.isArray(adj.levels) && !adj.levels.length
      );
    }
    ok(
      'a negative elevationBottom (a basement) passes through, never clamped',
      derive({ regionId: 'a', hidden: false, shapes: SHAPES, elevationBottom: -50, behaviors: [dark(0, 1)] })[0]
        .elevationBottom === -50
    );
    {
      const [adj] = derive({
        regionId: 'a',
        hidden: false,
        shapes: SHAPES,
        elevationBottom: NaN,
        elevationTop: 'nope',
        levels: ['L1', '', 7, null],
        behaviors: [dark(0, 1)],
      });
      ok(
        'a non-finite elevation value reads as null (unrestricted), never NaN or propagated as-is',
        adj.elevationBottom === null && adj.elevationTop === null
      );
      ok('non-string or empty level ids are dropped', adj.levels.length === 1 && adj.levels[0] === 'L1');
    }

    const none = (raw) => Array.isArray(derive(raw)) && derive(raw).length === 0;
    ok(
      'a hidden region contributes nothing',
      none({ regionId: 'a', hidden: true, shapes: SHAPES, behaviors: [dark(0, 1)] })
    );
    ok('missing raw reads as [], never throws', none(null));
    ok(
      'missing regionId contributes nothing (no stable key to pool a mesh against)',
      none({ hidden: false, shapes: SHAPES, behaviors: [dark(0, 1)] })
    );
    ok(
      'empty-string regionId contributes nothing',
      none({ regionId: '', hidden: false, shapes: SHAPES, behaviors: [dark(0, 1)] })
    );
    ok(
      'non-string regionId contributes nothing',
      none({ regionId: 42, hidden: false, shapes: SHAPES, behaviors: [dark(0, 1)] })
    );
    ok('no shapes contributes nothing', none({ regionId: 'a', hidden: false, shapes: [], behaviors: [dark(0, 1)] }));
    ok('missing shapes array contributes nothing', none({ regionId: 'a', hidden: false, behaviors: [dark(0, 1)] }));
    ok(
      'no adjustDarknessLevel behavior at all contributes nothing',
      none({ regionId: 'a', hidden: false, shapes: SHAPES, behaviors: [{ type: 'teleportToken', disabled: false }] })
    );
    ok(
      'a DISABLED adjustDarknessLevel behavior contributes nothing',
      none({ regionId: 'a', hidden: false, shapes: SHAPES, behaviors: [dark(0, 0.5, { disabled: true })] })
    );
    {
      const list = derive({
        regionId: 'a',
        hidden: false,
        shapes: SHAPES,
        behaviors: [{ type: 'teleportToken', disabled: false }, dark(1, 0.25)],
      });
      ok('finds the active adjustDarknessLevel behavior among others', list.length === 1 && list[0].mode === 1);
    }
    {
      const [adj] = derive({
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
      none({ regionId: 'a', hidden: false, shapes: SHAPES, behaviors: null })
    );
  }

  // ---- the LIVE reader (exists in the old code too: the proof runs these) ---
  {
    const dual = liveRegion({
      id: 'dual',
      behaviors: [
        { mode: 0, modifier: 0.9 },
        { mode: 0, modifier: 0.4 },
      ],
    });
    const scoped = liveRegion({ id: 'scoped', levels: ['LG'], behaviors: [{ mode: 0, modifier: 0.5 }] });
    const out = withCanvas({ scene: { regions: [dual, scoped] } }, () => SR.readActiveDarknessRegions());
    const ofDual = out.regions.filter((r) => r.regionId === 'dual');
    ok(
      'live: a Region with two darkness behaviours reads as two entries (Foundry: one mesh each)',
      ofDual.length === 2
    );
    ok(
      'live: they keep both values, so the minimum (0.4) can win whatever the order',
      ofDual.some((r) => r.modifier === 0.4) && ofDual.some((r) => r.modifier === 0.9)
    );
    const ofScoped = out.regions.find((r) => r.regionId === 'scoped');
    ok(
      "live: a Region's Levels Set is read as an id array",
      Array.isArray(ofScoped?.levels) && ofScoped.levels.length === 1 && ofScoped.levels[0] === 'LG'
    );
    ok('live: source is scene, no reason', out.source === 'scene' && out.reason === null);
  }
  {
    const out = withCanvas(undefined, () => SR.readActiveDarknessRegions());
    ok('live: no canvas reads as zero regions with a reason, never throws', out.regions.length === 0 && !!out.reason);
  }

  // ---- the viewed Level for the Levels gate ---------------------------------
  {
    const read = SR.readRegionViewedLevelId;
    ok('readRegionViewedLevelId is exported', typeof read === 'function');
    if (typeof read === 'function') {
      const levels = new Map([
        ['LB', {}],
        ['LG', {}],
      ]);
      const cv = { scene: { levels }, level: { id: 'LG' } };
      ok("MSA's own floor wins when it is a real Level", withCanvas(cv, () => read('LB')) === 'LB');
      ok("the 'legacy' floor falls back to canvas.level", withCanvas(cv, () => read('legacy')) === 'LG');
      ok('no floor id falls back to canvas.level', withCanvas(cv, () => read(null)) === 'LG');
      ok(
        'nothing resolvable reads as null (the caller fails open)',
        withCanvas({ scene: { levels } }, () => read('x')) === null
      );
      ok('no canvas at all reads as null, never throws', withCanvas(undefined, () => read('LB')) === null);
    }
  }

  // ---- the deliberate stub -------------------------------------------------
  {
    const stub = SR.readSuppressWeatherStub();
    ok('the weather-suppression stub always reads as nothing-suppressed', stub.suppressed === false);
    ok(
      'the stub is honestly labelled notBuilt, not silently indistinguishable from a real check',
      stub.notBuilt === true
    );
  }
}
