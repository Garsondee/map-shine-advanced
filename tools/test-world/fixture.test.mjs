// Node tests for tools/test-world/fixture.mjs (mmp-f0k.4). Run by tools/run-tests.mjs.
import { TEST_USERS, blankScene, lightMatrix, MSA_PORTED_ANIMATIONS, FLAT_GREY_SRC } from './fixture.mjs';

export function run(t) {
  const { ok } = t;
  const types = ['torch', 'pulse', 'reactivepulse'];
  const m = lightMatrix(types);
  ok('matrix: one light per static variant + animation', m.lights.length === 6 + types.length);
  ok('matrix: one label per light', m.labels.length === m.lights.length);
  ok(
    'matrix: every light carries a unique fixture id',
    new Set(m.lights.map((l) => l.flags['map-shine-advanced'].testFixtureId)).size === m.lights.length
  );
  ok(
    'matrix: unported animation is labelled',
    m.labels.some((l) => l.text === 'reactivepulse (unported)')
  );
  ok(
    'matrix: ported animation is not labelled unported',
    m.labels.some((l) => l.text === 'torch')
  );
  const inside = m.lights.every((l) => l.x > 0 && l.y > 0 && l.x < m.scene.width && l.y < m.scene.height);
  ok('matrix: every light inside the scene', inside);
  const pitchOk = m.lights.every((a, i) =>
    m.lights.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) >= 800 - 1e-6)
  );
  ok('matrix: lights at least one pitch apart', pitchOk);
  ok('matrix: MSA enabled on the scene', m.scene.flags['map-shine-advanced'].enabled === true);
  ok(
    'blank: MSA enabled, flat grey art',
    blankScene().flags['map-shine-advanced'].enabled === true && blankScene().background.src === FLAT_GREY_SRC
  );
  ok('users: two players, distinct names', TEST_USERS.length === 2 && TEST_USERS[0].name !== TEST_USERS[1].name);
  ok('ported list matches the registry count (22)', MSA_PORTED_ANIMATIONS.length === 22);
}
