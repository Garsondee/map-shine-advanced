/**
 * off-floor-light.test.mjs — lights of a level MSA is not showing yet (frame-rate round, 2026-11-02).
 *
 * For a few hundred ms of every level switch Foundry has drawn the new level's lights while MSA still shows the old
 * floor. Testing those lights against the OLD floor's windows pushed 26 of Big Bank's Underground lights off their
 * batch buckets and built 24 private material pairs in one frame (a 690 ms freeze), for entries that were never drawn
 * again once the floor committed. Checked here: the predicate, the reader tagging each light with its level, and the
 * pool wiring (the pool builds real three meshes, so it is not constructed in Node).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isLightOffShownFloor } from '../point-light-pool.js';
import { readActiveLightSources } from '../../../foundry/scene-lights.js';

export function run(t) {
  const { ok } = t;

  ok('a light of another level is off the shown floor', isLightOffShownFloor({ levelId: 'B' }, 'A') === true);
  ok('a light of the shown level is on it', isLightOffShownFloor({ levelId: 'A' }, 'A') === false);
  ok('a light with no level is treated as on the shown floor', isLightOffShownFloor({}, 'A') === false);
  ok('a light with a null level is treated as on the shown floor', isLightOffShownFloor({ levelId: null }, 'A') === false);
  ok('no identified floor means every light is on it', isLightOffShownFloor({ levelId: 'B' }, null) === false);
  ok('a missing light does not throw', isLightOffShownFloor(undefined, 'A') === false);

  // The reader tags each snapshot with its source's level id, and leaves it off when the source has none.
  const source = (id, level) => ({
    sourceId: id,
    active: true,
    x: 100,
    y: 100,
    radius: 200,
    ratio: 0.5,
    level,
    data: { attenuation: 0.5, luminosity: 0.5, alpha: 0.5 },
    colorRGB: null,
    animation: {},
    shape: { points: [0, 0, 200, 0, 200, 200, 0, 200] },
    object: { document: { hidden: false, elevation: 0, config: { darkness: { min: 0, max: 1 } } } },
  });
  const saved = globalThis.canvas;
  try {
    globalThis.canvas = { effects: { lightSources: [source('AmbientLight.a', { id: 'LVL1' }), source('AmbientLight.b', undefined)] } };
    const { lights } = readActiveLightSources(0.5);
    const a = lights.find((l) => l.sourceId === 'AmbientLight.a');
    const b = lights.find((l) => l.sourceId === 'AmbientLight.b');
    ok('the reader returned both test lights', !!a && !!b);
    ok("a source's level id rides on its snapshot", a?.levelId === 'LVL1');
    ok('a source with no level gets no levelId', b !== undefined && !('levelId' in b));
  } finally {
    globalThis.canvas = saved;
  }

  const src = readFileSync(fileURLToPath(new URL('../point-light-pool.js', import.meta.url)), 'utf8');
  ok('an off-floor light is tested against no aperture walls', /offShownFloor \? NO_SEGMENTS : apertureWallSegments/.test(src));
  ok('an off-floor light gets no window reach', /if \(!offShownFloor && windowReachOn/.test(src));
  ok('the guard compares against the floor the pool already resolved this frame', /const offShownFloor = OFF_FLOOR_GUARD && isLightOffShownFloor\(light, currentFloorId\);/.test(src));
  ok("the kill switch is localStorage 'msa.offFloorLightGuard' = '0'", /getItem\('msa\.offFloorLightGuard'\) !== '0'/.test(src));
  ok('the batching admission still reads the (now guarded) counts', /canBatchLight\(\{ apertureCount, windowReachCount, falloffModel/.test(src));
}
