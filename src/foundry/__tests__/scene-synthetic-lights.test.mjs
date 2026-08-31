/**
 * Node verification for foundry/scene-synthetic-lights.js. Same split as
 * scene-occlusion-sources.test.mjs: only the pure logic is tested here — the
 * live `canvas.effects.lightSources`/`CONFIG.Canvas.lightSourceClass` calls
 * inside `createSceneSyntheticLights`'s `sync`/`dispose` are browser-only.
 */
import { buildVisionLightData, diffVisionLightState, DETECTION_RADIUS_MULTIPLIER } from '../scene-synthetic-lights.js';

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
}
