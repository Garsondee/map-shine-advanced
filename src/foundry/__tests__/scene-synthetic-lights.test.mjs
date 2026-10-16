/**
 * Node verification for foundry/scene-synthetic-lights.js. Same split as
 * scene-occlusion-sources.test.mjs: only the pure logic is tested here — the
 * live `canvas.effects.lightSources`/`CONFIG.Canvas.lightSourceClass` calls
 * inside `createSceneSyntheticLights`'s `sync`/`dispose` are browser-only.
 */
import {
  buildVisionLightData,
  buildDaylitDoorDescriptors,
  diffVisionLightState,
  DETECTION_RADIUS_MULTIPLIER,
  DOOR_DAYLIGHT_DARKNESS_MAX,
  DOOR_DAYLIGHT_RADIUS_PX,
  DOOR_DAYLIGHT_PROBE_PX,
} from '../scene-synthetic-lights.js';
import { GLOBAL_LIGHT_DAYLIGHT_MAX } from '../scene-environment.js';

export function run(t) {
  const { ok } = t;

  // ---- buildVisionLightData --------------------------------------------
  {
    ok('rejects null', buildVisionLightData(null) === null);
    ok('rejects undefined', buildVisionLightData(undefined) === null);
    ok('rejects a missing sourceId', buildVisionLightData({ x: 1, y: 1, radius: 10 }) === null);
    ok('rejects an empty sourceId', buildVisionLightData({ sourceId: '', x: 1, y: 1, radius: 10 }) === null);
    ok('rejects a non-string sourceId', buildVisionLightData({ sourceId: 7, x: 1, y: 1, radius: 10 }) === null);
    ok('rejects NaN x', buildVisionLightData({ sourceId: 'a', x: NaN, y: 1, radius: 10 }) === null);
    ok('rejects NaN y', buildVisionLightData({ sourceId: 'a', x: 1, y: NaN, radius: 10 }) === null);
    ok(
      'rejects a zero radius (an authored "no light" candle)',
      buildVisionLightData({ sourceId: 'a', x: 1, y: 1, radius: 0 }) === null
    );
    ok('rejects a negative radius', buildVisionLightData({ sourceId: 'a', x: 1, y: 1, radius: -5 }) === null);
    ok('rejects a non-finite radius', buildVisionLightData({ sourceId: 'a', x: 1, y: 1, radius: NaN }) === null);
  }
  {
    const d = buildVisionLightData({ sourceId: 'candle:abc', x: 100, y: 200, elevation: 5, radius: 50 });
    ok('a valid descriptor is built', d !== null);
    ok('sourceId is namespaced, never collides with the real id', d.sourceId === 'msa-vision:candle:abc');
    ok('the namespace prefix is NOT the raw source id (would be a real collision risk)', d.sourceId !== 'candle:abc');
    ok('x passes through', d.x === 100);
    ok('y passes through', d.y === 200);
    ok('elevation passes through', d.elevation === 5);
    ok('bright = the visual radius, unchanged', d.bright === 50);
    ok('dim = DETECTION_RADIUS_MULTIPLIER x the visual radius', d.dim === 50 * DETECTION_RADIUS_MULTIPLIER);
    ok('the detection reach really is 2x, the authors own explicit ask', d.dim === 100);
  }
  ok(
    'a missing elevation defaults to 0, never NaN/undefined',
    buildVisionLightData({ sourceId: 'a', x: 1, y: 1, radius: 10 }).elevation === 0
  );
  ok(
    'a non-finite elevation also defaults to 0',
    buildVisionLightData({ sourceId: 'a', x: 1, y: 1, radius: 10, elevation: NaN }).elevation === 0
  );
  ok(
    'a fire descriptor (same shape) builds identically to a candle one',
    buildVisionLightData({ sourceId: 'fire:xyz', x: 3, y: 4, radius: 20 }).sourceId === 'msa-vision:fire:xyz'
  );

  // ---- diffVisionLightState ---------------------------------------------
  {
    const r = diffVisionLightState([], new Map());
    ok('nothing in, nothing to apply', r.toApply.length === 0);
    ok('nothing in, nothing to remove', r.toRemoveIds.length === 0);
    ok('nothing changed', r.changed === false);
  }
  {
    const fresh = { sourceId: 'msa-vision:candle:a', x: 1, y: 2, elevation: 0, dim: 20, bright: 10 };
    const r = diffVisionLightState([fresh], new Map());
    ok('a brand-new source is queued to apply', r.toApply.length === 1 && r.toApply[0] === fresh);
    ok('nothing to remove yet', r.toRemoveIds.length === 0);
    ok('changed is true for a new source', r.changed === true);
  }
  {
    const same = { sourceId: 'msa-vision:candle:a', x: 1, y: 2, elevation: 0, dim: 20, bright: 10 };
    const applied = new Map([[same.sourceId, { x: 1, y: 2, elevation: 0, dim: 20, bright: 10 }]]);
    const r = diffVisionLightState([same], applied);
    ok('a byte-identical source is NOT re-applied (avoids a needless perception.update)', r.toApply.length === 0);
    ok('nothing to remove', r.toRemoveIds.length === 0);
    ok('changed is false when nothing actually moved', r.changed === false);
  }
  const FIELDS = ['x', 'y', 'elevation', 'dim', 'bright'];
  for (const field of FIELDS) {
    const base = { sourceId: 'msa-vision:candle:a', x: 1, y: 2, elevation: 0, dim: 20, bright: 10 };
    const moved = { ...base, [field]: base[field] + 1 };
    const applied = new Map([
      [base.sourceId, { x: base.x, y: base.y, elevation: base.elevation, dim: base.dim, bright: base.bright }],
    ]);
    const r = diffVisionLightState([moved], applied);
    ok(`a changed "${field}" alone is enough to re-apply`, r.toApply.length === 1 && r.changed === true);
  }
  {
    const applied = new Map([['msa-vision:candle:gone', { x: 0, y: 0, elevation: 0, dim: 10, bright: 5 }]]);
    const r = diffVisionLightState([], applied);
    ok(
      'a source no longer present is queued for removal',
      r.toRemoveIds.length === 1 && r.toRemoveIds[0] === 'msa-vision:candle:gone'
    );
    ok('changed is true for a pure removal', r.changed === true);
  }
  {
    // A realistic mixed frame: one unchanged, one moved, one new, one extinguished.
    const unchanged = { sourceId: 'msa-vision:candle:1', x: 0, y: 0, elevation: 0, dim: 10, bright: 5 };
    const moved = { sourceId: 'msa-vision:candle:2', x: 99, y: 0, elevation: 0, dim: 10, bright: 5 };
    const fresh = { sourceId: 'msa-vision:fire:3', x: 5, y: 5, elevation: 0, dim: 40, bright: 20 };
    const applied = new Map([
      [unchanged.sourceId, { x: 0, y: 0, elevation: 0, dim: 10, bright: 5 }],
      [moved.sourceId, { x: 0, y: 0, elevation: 0, dim: 10, bright: 5 }],
      ['msa-vision:candle:extinguished', { x: 1, y: 1, elevation: 0, dim: 10, bright: 5 }],
    ]);
    const r = diffVisionLightState([unchanged, moved, fresh], applied);
    ok('exactly the moved + fresh sources are queued to apply, not the unchanged one', r.toApply.length === 2);
    ok(
      'the moved source is in toApply',
      r.toApply.some((d) => d.sourceId === moved.sourceId)
    );
    ok(
      'the fresh source is in toApply',
      r.toApply.some((d) => d.sourceId === fresh.sourceId)
    );
    ok('the unchanged source is NOT in toApply', !r.toApply.some((d) => d.sourceId === unchanged.sourceId));
    ok(
      'the extinguished source is queued for removal',
      r.toRemoveIds.length === 1 && r.toRemoveIds[0] === 'msa-vision:candle:extinguished'
    );
  }
  {
    const dup1 = { sourceId: 'msa-vision:candle:dup', x: 1, y: 1, elevation: 0, dim: 10, bright: 5 };
    const dup2 = { sourceId: 'msa-vision:candle:dup', x: 2, y: 2, elevation: 0, dim: 10, bright: 5 };
    const r = diffVisionLightState([dup1, dup2], new Map());
    ok('a duplicate sourceId in the same frame never crashes', r.toApply.length === 1);
    ok('the FIRST occurrence wins on a duplicate id', r.toApply[0] === dup1);
  }
  {
    // appliedById as a plain object (not a Map) must work identically — the
    // factory's own internal `applied` is a Map, but the pure function's
    // contract promises both.
    const same = { sourceId: 'msa-vision:candle:a', x: 1, y: 2, elevation: 0, dim: 20, bright: 10 };
    const r = diffVisionLightState([same], {
      'msa-vision:candle:a': { x: 1, y: 2, elevation: 0, dim: 20, bright: 10 },
    });
    ok('a plain object appliedById works the same as a Map', r.changed === false && r.toApply.length === 0);
  }
  {
    const r = diffVisionLightState(null, new Map());
    ok(
      'a non-array currentDescriptors is treated as empty, never throws',
      r.toApply.length === 0 && r.toRemoveIds.length === 0
    );
  }

  // ---- daylit doors (2026-10-16) -----------------------------------------
  // "An exterior door during the day is bright enough to see ... the icon
  // should appear" - daylight is not a lightSources entry, so the doorway is
  // marked lit directly.
  ok(
    'door daylight ends exactly where the global-light daylight window ends (one idea of "day")',
    DOOR_DAYLIGHT_DARKNESS_MAX === GLOBAL_LIGHT_DAYLIGHT_MAX
  );
  {
    // A vertical exterior door at x=1000: outdoors for x > 1000 only.
    const door = { id: 'w1', x1: 1000, y1: 900, x2: 1000, y2: 1000 };
    const outdoorsEast = (x) => (x > 1000 ? 1 : 0);
    const day = buildDaylitDoorDescriptors({ doors: [door], sampleOutdoors: outdoorsEast, darkness01: 0 });
    ok('a door with open sky on ONE side is daylit at noon', day.length === 1);
    ok('its centre is the door midpoint', day[0].x === 1000 && day[0].y === 950);
    ok('the id is namespaced per wall', day[0].sourceId === 'doorDaylight:w1');
    const built = buildVisionLightData(day[0]);
    ok(
      'it builds as an exact marker: dim === bright === the doorway radius',
      built.dim === DOOR_DAYLIGHT_RADIUS_PX && built.bright === DOOR_DAYLIGHT_RADIUS_PX
    );
    ok(
      'no 2x detection multiplier on a doorway marker',
      built.dim !== DOOR_DAYLIGHT_RADIUS_PX * DETECTION_RADIUS_MULTIPLIER
    );
    ok('it ignores walls and is a "magical" (priority) source', built.walls === false && built.priority > 0);
    ok('it covers the +/-3 px icon probes with room to spare', DOOR_DAYLIGHT_RADIUS_PX > 3);
    ok(
      'an ordinary light still tests walls at priority 0',
      buildVisionLightData({ sourceId: 'a', x: 1, y: 1, radius: 10 }).walls === true
    );
    ok(
      'the probe is the same from either side (door drawn backwards)',
      buildDaylitDoorDescriptors({
        doors: [{ ...door, y1: 1000, y2: 900 }],
        sampleOutdoors: outdoorsEast,
        darkness01: 0,
      }).length === 1
    );
    ok(
      'at dusk (past the daylight ceiling) nothing is daylit',
      buildDaylitDoorDescriptors({
        doors: [door],
        sampleOutdoors: outdoorsEast,
        darkness01: DOOR_DAYLIGHT_DARKNESS_MAX + 0.01,
      }).length === 0
    );
    ok(
      'exactly at the ceiling still counts as day',
      buildDaylitDoorDescriptors({
        doors: [door],
        sampleOutdoors: outdoorsEast,
        darkness01: DOOR_DAYLIGHT_DARKNESS_MAX,
      }).length === 1
    );
    ok(
      'a fully indoor door (mask 0 everywhere) is NOT daylit',
      buildDaylitDoorDescriptors({ doors: [door], sampleOutdoors: () => 0, darkness01: 0 }).length === 0
    );
    ok(
      'a door whose sky is beyond the probe reach is not daylit',
      buildDaylitDoorDescriptors({
        doors: [door],
        sampleOutdoors: (x) => (x > 1000 + DOOR_DAYLIGHT_PROBE_PX + 1 ? 1 : 0),
        darkness01: 0,
      }).length === 0
    );
    ok(
      'secret doors are skipped',
      buildDaylitDoorDescriptors({ doors: [{ ...door, secret: true }], sampleOutdoors: () => 1, darkness01: 0 })
        .length === 0
    );
    ok(
      'a non-finite darkness reads as "not day", never as day',
      buildDaylitDoorDescriptors({ doors: [door], sampleOutdoors: () => 1, darkness01: NaN }).length === 0
    );
    ok(
      'a NaN mask sample reads as indoors',
      buildDaylitDoorDescriptors({ doors: [door], sampleOutdoors: () => NaN, darkness01: 0 }).length === 0
    );
    ok(
      'a zero-length wall and a missing id are skipped, never NaN-poisoned',
      buildDaylitDoorDescriptors({
        doors: [{ id: 'z', x1: 5, y1: 5, x2: 5, y2: 5 }, { x1: 0, y1: 0, x2: 10, y2: 0 }, null],
        sampleOutdoors: () => 1,
        darkness01: 0,
      }).length === 0
    );
    ok(
      'no doors / no sampler is an empty list',
      buildDaylitDoorDescriptors().length === 0 &&
        buildDaylitDoorDescriptors({ doors: [door], darkness01: 0 }).length === 0
    );
    // Dawn -> dusk toggling diffs as add then remove (no leak of stale markers).
    const a = buildDaylitDoorDescriptors({ doors: [door], sampleOutdoors: outdoorsEast, darkness01: 0 }).map(
      buildVisionLightData
    );
    const applied = new Map(
      a.map((d) => [
        d.sourceId,
        { x: d.x, y: d.y, elevation: d.elevation, dim: d.dim, bright: d.bright, walls: d.walls, priority: d.priority },
      ])
    );
    ok('an unchanged daylit door diffs as unchanged', diffVisionLightState(a, applied).changed === false);
    const dusk = diffVisionLightState([], applied);
    ok(
      'when day ends the marker is queued for removal',
      dusk.toRemoveIds.length === 1 && dusk.toRemoveIds[0] === 'msa-vision:doorDaylight:w1'
    );
  }
}
