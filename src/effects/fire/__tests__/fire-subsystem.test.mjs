/**
 * fire-subsystem.test.mjs — THE SPAWN-CLOUD PUSH LOGIC, WITH FAKE ENGINES.
 *
 * `createFireSubsystem` takes `THREE` and `createEngine` as injected
 * dependencies specifically so its orchestration — WHICH engine gets pushed a
 * new spawn cloud, and WHEN — can be tested without a GPU. Everything under
 * test here is plain JS control flow; the engines are stubs that just record
 * what they were called with.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE OF A REAL BUG, 2026-08-09. Flame is FOUR engines
 * (one per archetype) all reporting `kind: 'flame'`. The first cut of the
 * cohesion feature tracked "did this need a fresh spawn cloud" in a map keyed
 * by `kind`, so the first flame engine the loop reached updated the shared
 * flag and the other three read "already up to date" — permanently. Three
 * quarters of the flame population never received a cohesion push after the
 * first slider move. Author: *"Cohesion makes them appear far away from each
 * other at both ends of the slider... they just spawn apart."* The fix keys
 * the staleness tracker by the ENGINE, not the kind string; this test drives
 * exactly the shape that broke — several engines sharing one kind — and would
 * have failed against the old code.
 *
 * Also carries the downstream half of the `animationSpeed`/`motionSpeed`
 * fix (2026-08-09): `fireRuntimeFromParams` used to compute a `puffHz` field
 * nothing ever read — `sync()`'s `engine.setParams({...})` call never
 * mentioned it, so the "Speed" slider passed `params/no-dead-controls` (the
 * param key IS read) while changing nothing (the value it produced was
 * consumed by nobody). `motionSpeed` replaces it; the check below is the
 * proof this file's own fake engines exist to give — that the resolved value
 * actually reaches every engine's `setParams`, ember and smoke included, not
 * just that the source param is textually referenced somewhere.
 */
import { createFireSubsystem } from '../fire-subsystem.js';

const SPAWN_POINT_STRIDE = 4; // x, y, brightness, jitterRadiusPx — mirrors fire-spawn-points.js

function makeCloud(pointsXY, signature) {
  const points = new Float32Array(pointsXY.length * SPAWN_POINT_STRIDE);
  pointsXY.forEach(([x, y], i) => {
    points[i * SPAWN_POINT_STRIDE] = x;
    points[i * SPAWN_POINT_STRIDE + 1] = y;
    points[i * SPAWN_POINT_STRIDE + 2] = 1;
    points[i * SPAWN_POINT_STRIDE + 3] = 5;
  });
  return { points, count: pointsXY.length, paintedTexels: pointsXY.length, signature };
}

class FakeScene {
  constructor() {
    this.children = [];
    this.visible = true;
    this.renderOrder = 0;
  }
  add(child) {
    this.children.push(child);
  }
  remove(child) {
    this.children = this.children.filter((c) => c !== child);
  }
}

export function run(t) {
  const engineInstances = [];
  const makeFakeEngine = (kind, archetype) => {
    const e = {
      kind,
      archetype,
      scene: { visible: true, renderOrder: 0 },
      spawnCalls: [],
      paramCalls: [],
      stepCalls: 0,
      setSpawnPoints(cloud) {
        e.spawnCalls.push(cloud);
      },
      setParams(p) {
        e.paramCalls.push(p);
      },
      step() {
        e.stepCalls++;
      },
      debugState() {
        return { kind, archetype };
      },
    };
    engineInstances.push(e);
    return e;
  };

  const state = {
    enabled: true,
    params: { flameCohesion: 0 },
    perfTier: 2,
    mPerPx: 0.02,
    fires: [{ id: 'f1', x: 50, y: 50, diameterPx: 80, intensity: 1 }],
    spawnCloud: makeCloud(
      [
        [0, 0],
        [100, 0],
        [0, 100],
        [100, 100],
      ],
      12345
    ),
  };

  const subsystem = createFireSubsystem({
    THREE: { Scene: FakeScene },
    getFireRenderState: () => state,
    createEngine: ({ kind, archetype }) => makeFakeEngine(kind, archetype),
  });

  const renderer = {}; // only needs to be truthy — no real compute happens
  const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  subsystem.sync(renderer, 0, 0.016, rect);

  const flameEngines = engineInstances.filter((e) => e.kind === 'flame');
  const emberEngine = engineInstances.find((e) => e.kind === 'ember');
  const smokeEngine = engineInstances.find((e) => e.kind === 'smoke');

  t.ok('four flame engines were built, one per archetype', flameEngines.length === 4);
  t.ok(
    'every flame engine received its first spawn push',
    flameEngines.every((e) => e.spawnCalls.length === 1)
  );

  // ── motionSpeed IS GLOBAL: it must reach EVERY engine, not just flame's ──
  // Unlike cohesion (a per-KIND tune living in runtime.perKind), `motionSpeed`
  // is attached once in fire-subsystem.js's setParams call, the same way
  // `intensity`/`cameraHeight` are — so ember and smoke must see it too.
  t.ok(
    'the default Speed (animationSpeed=1) reaches every engine as motionSpeed=1',
    engineInstances.every((e) => e.paramCalls[0]?.motionSpeed === 1)
  );
  state.params = { ...state.params, animationSpeed: 2.2 };
  subsystem.sync(renderer, 8, 0.016, rect);
  t.ok(
    'moving Speed reaches every engine on the next sync, ember and smoke included',
    engineInstances.every((e) => e.paramCalls.at(-1)?.motionSpeed === 2.2)
  );

  // ── THE REGRESSION: a cohesion-only change must reach EVERY flame engine ──
  state.params = { ...state.params, flameCohesion: 1.5 };
  subsystem.sync(renderer, 16, 0.016, rect);
  t.ok(
    `a cohesion change pushes to ALL FOUR flame engines, not just the first (got ${flameEngines.map((e) => e.spawnCalls.length).join(',')})`,
    flameEngines.every((e) => e.spawnCalls.length === 2)
  );

  for (const e of flameEngines) {
    // `.at(-1)` rather than indexing by expected count — if the push above was
    // silently dropped for this engine, this still reads its LAST real push
    // (possibly the stale one from construction) instead of crashing the
    // whole suite on `undefined`, so the failure above is what gets reported.
    const pushed = e.spawnCalls.at(-1);
    t.ok('the cohesion push is a NEW cloud object, not the original', pushed !== state.spawnCloud);
    t.ok(
      'a point actually moved toward the fire centre rather than staying at its raw spawn position',
      Math.abs((pushed?.points?.[0] ?? 0) - 0) > 1e-6 || Math.abs((pushed?.points?.[1] ?? 0) - 0) > 1e-6
    );
  }

  // Ember and smoke never had their OWN cohesion touched — must not be re-pushed.
  t.ok("ember is not re-pushed when only flame's cohesion changes", emberEngine.spawnCalls.length === 1);
  t.ok("smoke is not re-pushed when only flame's cohesion changes", smokeEngine.spawnCalls.length === 1);

  // ── STABILITY: re-syncing with nothing changed must not re-push anyone ──
  subsystem.sync(renderer, 32, 0.016, rect);
  t.ok(
    'an unchanged cohesion and unchanged paint push nobody again',
    flameEngines.every((e) => e.spawnCalls.length === 2) &&
      emberEngine.spawnCalls.length === 1 &&
      smokeEngine.spawnCalls.length === 1
  );

  // ── A real paint edit reaches every engine regardless of cohesion staleness ──
  state.spawnCloud = makeCloud(
    [
      [10, 10],
      [90, 90],
    ],
    99999
  );
  subsystem.sync(renderer, 48, 0.016, rect);
  t.ok(
    'a genuine paint change re-pushes every engine, flame included',
    flameEngines.every((e) => e.spawnCalls.length === 3) &&
      emberEngine.spawnCalls.length === 2 &&
      smokeEngine.spawnCalls.length === 2
  );

  // ── THE FLOOR-SWITCH REGRESSION (2026-08-12): a floor with an ANCHOR fire
  // but no painted `_Fire` region (`spawnCloud` goes null) MUST still push an
  // EMPTY cloud to every engine — the live bug report this test exists for
  // was every engine spawning from the PREVIOUS floor's real paint forever,
  // because the whole push used to be skipped outright whenever `cloud` was
  // null (`if (cloud) {...}` around the entire block). `fires` staying
  // non-empty (the anchor) is what keeps `sync()` past its early-return; the
  // spawn cloud itself going null is the exact shape a floor switch away from
  // paint produces. ──
  state.fires = [{ id: 'anchor1', x: 20, y: 20, diameterPx: 60, intensity: 1 }];
  state.spawnCloud = null;
  subsystem.sync(renderer, 64, 0.016, rect);
  t.ok(
    'a floor with no paint (anchor fire only) still pushes EVERY engine, not just the ones already pending',
    flameEngines.every((e) => e.spawnCalls.length === 4) &&
      emberEngine.spawnCalls.length === 3 &&
      smokeEngine.spawnCalls.length === 3
  );
  t.ok(
    "the pushed cloud is genuinely EMPTY (count 0), not the stale previous floor's real points",
    [...flameEngines, emberEngine, smokeEngine].every((e) => e.spawnCalls.at(-1)?.count === 0)
  );

  // Paint returning after an anchor-only floor must push again too — proves
  // the empty state was actually TRACKED (lastSpawnSignature moved to 0),
  // not merely "skipped, so anything looks different next time".
  state.spawnCloud = makeCloud(
    [
      [30, 30],
      [70, 70],
    ],
    55555
  );
  subsystem.sync(renderer, 80, 0.016, rect);
  t.ok(
    'paint returning after an anchor-only floor pushes the real cloud again, to every engine',
    flameEngines.every((e) => e.spawnCalls.length === 5) &&
      emberEngine.spawnCalls.length === 4 &&
      smokeEngine.spawnCalls.length === 4
  );
  t.ok(
    'every engine received the real 2-point cloud, not another empty one',
    [...flameEngines, emberEngine, smokeEngine].every((e) => e.spawnCalls.at(-1)?.count === 2)
  );
}
