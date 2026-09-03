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
import { fireTintMul, fireTierPlan } from '../fire-geometry.js';

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
  const makeFakeEngine = (kind, archetype, renderOrder) => {
    const e = {
      kind,
      archetype,
      renderOrder,
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
    createEngine: ({ kind, archetype, renderOrder }) => makeFakeEngine(kind, archetype, renderOrder),
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

  // ── renderOrder MUST be a construction-time arg, not set on `engine.scene`
  // after the fact — THREE reads it off the renderable MESH, never off an
  // ancestor container, so the old `engine.scene.renderOrder = ...` line was
  // a silent no-op. This asserts `createEngine` actually receives it. ──
  t.ok(
    'flame and ember get renderOrder 0/1, smoke gets 2, passed to createEngine',
    flameEngines.every((e) => e.renderOrder === 0) && emberEngine.renderOrder === 1 && smokeEngine.renderOrder === 2
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

  // ── "Fire intensity" (Presence category — p.intensity), not "Flame
  // brightness" (Look category — p.brightness), must reach every engine's
  // setParams as `intensity`. fireRuntimeFromParams returns BOTH: `intensity`
  // (from p.brightness, a volumetric-material uniform that only ever reached
  // the orphaned fire-render.js) and `fireIntensity` (from p.intensity, the
  // control an author actually reaches for — "How hard everything burns").
  // The live particle engine's own `intensity` param feeds its real emission
  // uniform, so the subsystem must forward `runtime.fireIntensity` to it, not
  // `runtime.intensity` — moving "Fire intensity" used to do nothing at all. ──
  state.params = { ...state.params, intensity: 1.8, brightness: 0.2 };
  subsystem.sync(renderer, 96, 0.016, rect);
  t.ok(
    '"Fire intensity" reaches every engine\'s setParams.intensity, not "Flame brightness"',
    engineInstances.every((e) => e.paramCalls.at(-1)?.intensity === 1.8)
  );

  // ── THE COLOUR CC SET (2026-08-30) — hueShiftRad/posterizeAmount/bandCount/
  // tintMul are the other four `fireRuntimeFromParams` fields nothing ever
  // read (fire.js's "Look" category header has the full account). GLOBAL like
  // motionSpeed/intensity above — every engine must receive them, ember and
  // smoke included, not just flame's four archetype engines. ──
  state.params = { ...state.params, colorHueShift: 45, posterize: 0.6, bandCount: 5, color: '#ff0000' };
  subsystem.sync(renderer, 112, 0.016, rect);
  const expectedTintMul = fireTintMul('#ff0000');
  t.ok(
    'colorHueShift (45°, no fuel contribution) reaches every engine as hueShiftRad = π/4',
    engineInstances.every((e) => Math.abs(e.paramCalls.at(-1)?.hueShiftRad - Math.PI / 4) < 1e-6)
  );
  t.ok(
    'posterize reaches every engine as posterizeAmount',
    engineInstances.every((e) => e.paramCalls.at(-1)?.posterizeAmount === 0.6)
  );
  t.ok(
    'bandCount reaches every engine unchanged',
    engineInstances.every((e) => e.paramCalls.at(-1)?.bandCount === 5)
  );
  t.ok(
    "the Flame tint swatch reaches every engine as tintMul, fireTintMul's own output",
    engineInstances.every((e) =>
      (e.paramCalls.at(-1)?.tintMul ?? []).every((c, i) => Math.abs(c - expectedTintMul[i]) < 1e-9)
    )
  );

  // ── THE STALE-fires REGRESSION (2026-08-12): `fires` (cohesion's own pull
  // TARGETS, from extractFiresFromMask) is a DIFFERENT extraction than
  // `spawnCloud` (from extractFireSpawnPoints) over the same grid, and can
  // settle at a different moment. The cache used to watch only `cloud`'s own
  // signature + the cohesion value — a fire moving (or a fire appearing that
  // was missing when cohesion last ran) with the SAME spawnCloud object must
  // still force a fresh push, or a stale `fires` list bakes into
  // `applyCohesion`'s result and is never asked to recompute again until the
  // paint itself changes or the slider moves — even though the correct list
  // was available the whole time. Cohesion (1.5) is still active from the
  // earlier step; only `fires` moves here, `state.spawnCloud`'s object
  // reference is untouched. ──
  const cloudBeforeFiresMove = state.spawnCloud;
  state.fires = [{ id: 'anchor1', x: 90, y: 90, diameterPx: 60, intensity: 1 }]; // moved from (20,20)
  subsystem.sync(renderer, 112, 0.016, rect);
  t.ok(
    'state.spawnCloud is still the SAME object — this is testing fires alone, not a paint edit',
    state.spawnCloud === cloudBeforeFiresMove
  );
  t.ok(
    'a fires-list change alone (spawnCloud object untouched) still pushes every engine',
    flameEngines.every((e) => e.spawnCalls.length === 6) &&
      emberEngine.spawnCalls.length === 5 &&
      smokeEngine.spawnCalls.length === 5
  );
  t.ok(
    "the re-pull actually reflects the fire's NEW position, not a no-op re-push of the same result",
    flameEngines.every((e) => {
      const before = e.spawnCalls.at(-2)?.points;
      const after = e.spawnCalls.at(-1)?.points;
      return before && after && (after[0] !== before[0] || after[1] !== before[1]);
    })
  );

  // ── THE 3RD LEVER (2026-08-30) — spriteCountScale, LIVE ──────────────────
  // `state.perfTier` has sat at its fixture value (2) since construction;
  // every block above exercised a DIFFERENT param without ever moving it.
  // This is the first assertion in this file that a live PROFILE change
  // (not a look param) reaches `activeCount` at all — before this lever
  // existed, `activeCount` had no tier dependency whatsoever, so this same
  // test written against yesterday's code would have found the ratios
  // below all equal to 1.
  const flame0 = flameEngines[0];
  const atTier2 = flame0.paramCalls.at(-1)?.activeCount;
  t.ok('a resolved activeCount exists at the fixture`s own tier (2)', Number.isFinite(atTier2) && atTier2 > 0);

  state.perfTier = 0;
  subsystem.sync(renderer, 128, 0.016, rect);
  const atTier0 = flame0.paramCalls.at(-1)?.activeCount;
  t.ok(
    `tier 0 genuinely shrinks activeCount versus tier 2 (${atTier0} vs ${atTier2})`,
    Number.isFinite(atTier0) && atTier0 < atTier2
  );
  t.ok(
    'the shrink matches fireTierPlan(0).spriteCountScale exactly, not an approximation',
    Math.abs(atTier0 / atTier2 - fireTierPlan(0).spriteCountScale / fireTierPlan(2).spriteCountScale) < 1e-9
  );

  state.perfTier = 5;
  subsystem.sync(renderer, 144, 0.016, rect);
  const atTier5 = flame0.paramCalls.at(-1)?.activeCount;
  t.ok(
    `tier 5 (the ceiling) is genuinely richer than tier 0 (${atTier5} vs ${atTier0})`,
    Number.isFinite(atTier5) && atTier5 > atTier0
  );

  state.perfTier = 3;
  subsystem.sync(renderer, 160, 0.016, rect);
  const atTier3 = flame0.paramCalls.at(-1)?.activeCount;
  t.ok(
    'tier 3 (standard, the DEFAULT profile) and tier 5 (extreme) draw the identical sprite count — the ' +
      'ceiling this lever was designed never to exceed, matching this session`s own "standard+ byte-identical" ' +
      'discipline for every other effect',
    atTier3 === atTier5
  );
  t.ok(
    'ember and smoke engines received the SAME tier-scaled treatment as flame, not just the archetype tested above',
    Math.abs((emberEngine.paramCalls.at(-1)?.activeCount ?? -1) / atTier3 - 10 / 12) < 1e-9 &&
      Math.abs((smokeEngine.paramCalls.at(-1)?.activeCount ?? -1) / atTier3 - 24 / 12) < 1e-9
  );

  // ── THE DEPTH-AUTHORITY OCCLUSION GATE (mythica-machina-press#469) — fire
  // previously had zero awareness of what was drawn above it, unlike candle/
  // lightning which already gate on this. Two SEPARATE subsystem instances
  // below (their own engines, their own state) so neither disturbs the long
  // call-count sequence built up against the first subsystem above. ──
  {
    const withGateEngines = [];
    const withGateSubsystem = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => ({
        enabled: true,
        params: {},
        perfTier: 2,
        mPerPx: 0.02,
        // fires[0] is the REPRESENTATIVE fire syncUnguarded already reads for
        // sprite scale — a SECOND fire at a wildly different elevation proves
        // the resolver reads fires[0] specifically, not some other one.
        fires: [
          { id: 'f1', x: 50, y: 50, diameterPx: 80, intensity: 1, elevation: 42 },
          { id: 'f2', x: 10, y: 10, diameterPx: 40, intensity: 1, elevation: 999 },
        ],
        spawnCloud: makeCloud([[0, 0]], 1),
      }),
      createEngine: ({ kind, archetype, renderOrder, depthTexNode, depthFlagsTexNode }) => {
        const e = {
          kind,
          archetype,
          renderOrder,
          depthTexNode,
          depthFlagsTexNode,
          scene: { visible: true, renderOrder: 0 },
          paramCalls: [],
          setSpawnPoints() {},
          setParams(p) {
            e.paramCalls.push(p);
          },
          step() {},
          debugState: () => ({ kind, archetype }),
        };
        withGateEngines.push(e);
        return e;
      },
      depthTexNode: { id: 'depthTex' },
      depthFlagsTexNode: { id: 'depthFlagsTex' },
      resolveExpectedDepth: (elevation) => elevation * 10,
    });
    withGateSubsystem.sync(renderer, 0, 0.016, rect);

    t.ok('depth-authority engines were built', withGateEngines.length > 0);
    t.ok(
      "resolveExpectedDepth's result — from fires[0]'s elevation specifically, not fires[1]'s — reaches every " +
        'engine as setParams.expectedDepth',
      withGateEngines.every((e) => e.paramCalls.at(-1)?.expectedDepth === 420)
    );
    t.ok(
      'depthTexNode/depthFlagsTexNode reach every engine unchanged, via createEngine',
      withGateEngines.every((e) => e.depthTexNode?.id === 'depthTex' && e.depthFlagsTexNode?.id === 'depthFlagsTex')
    );
  }

  {
    const noGateEngines = [];
    const noGateSubsystem = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => ({
        enabled: true,
        params: {},
        perfTier: 2,
        mPerPx: 0.02,
        fires: [{ id: 'f1', x: 50, y: 50, diameterPx: 80, intensity: 1, elevation: 42 }],
        spawnCloud: makeCloud([[0, 0]], 1),
      }),
      createEngine: ({ kind, archetype, renderOrder, depthTexNode, depthFlagsTexNode }) => {
        const e = {
          kind,
          archetype,
          renderOrder,
          depthTexNode,
          depthFlagsTexNode,
          scene: { visible: true, renderOrder: 0 },
          paramCalls: [],
          setSpawnPoints() {},
          setParams(p) {
            e.paramCalls.push(p);
          },
          step() {},
          debugState: () => ({ kind, archetype }),
        };
        noGateEngines.push(e);
        return e;
      },
      // depthTexNode/depthFlagsTexNode/resolveExpectedDepth all omitted —
      // must not throw, must default every engine's expectedDepth to 0, the
      // same "omit for byte-identical no-gate behaviour" contract candle and
      // lightning already ship.
    });
    noGateSubsystem.sync(renderer, 0, 0.016, rect);

    t.ok('omitting the gate params entirely does not throw, and engines were still built', noGateEngines.length > 0);
    t.ok(
      'expectedDepth defaults to 0 and depthTexNode/depthFlagsTexNode default to null when omitted',
      noGateEngines.every(
        (e) => e.paramCalls.at(-1)?.expectedDepth === 0 && e.depthTexNode === null && e.depthFlagsTexNode === null
      )
    );
  }

  // ── WIND (2026-09-03, mythica-machina-press#475 follow-up) — windMotion01
  // reaching every engine, and reading the LIVE wind handle fresh each sync,
  // not just once at construction. Own subsystem instance, same reason the
  // depth-gate blocks above use their own — this must not disturb the long
  // call-count sequence built up against the first subsystem. ──
  {
    const windEngines = [];
    // Shape matches what fire-particle-runtime.js's real engines bind to
    // (`windHandle.ambient.speed01`/`directionDeg`) — a plain mutable `.value`
    // stands in for the live TSL uniform node fire-subsystem.js reads via
    // `windHandle?.ambient?.speed01?.value`.
    const fakeWindHandle = { ambient: { speed01: { value: 0 }, directionDeg: { value: 90 } } };
    const windState = {
      enabled: true,
      params: {},
      perfTier: 2,
      mPerPx: 0.02,
      fires: [{ id: 'f1', x: 50, y: 50, diameterPx: 66, intensity: 1 }],
      spawnCloud: makeCloud([[0, 0]], 1),
    };
    const windSubsystem = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => windState,
      getWindHandle: () => fakeWindHandle,
      createEngine: ({ kind, archetype, renderOrder }) => {
        const e = {
          kind,
          archetype,
          renderOrder,
          scene: { visible: true, renderOrder: 0 },
          paramCalls: [],
          setSpawnPoints() {},
          setParams(p) {
            e.paramCalls.push(p);
          },
          step() {},
          debugState: () => ({ kind, archetype }),
        };
        windEngines.push(e);
        return e;
      },
    });

    windSubsystem.sync(renderer, 0, 0.016, rect);
    t.ok(
      'a calm wind handle (speed01=0) reaches every engine as windMotion01=0',
      windEngines.every((e) => e.paramCalls.at(-1)?.windMotion01 === 0)
    );

    // The handle is read FRESH each sync (fire-subsystem.js calls
    // getWindHandle?.() inside syncUnguarded, not once at ensureEngines time)
    // — mutating the SAME object's `.value` and re-syncing must move it.
    fakeWindHandle.ambient.speed01.value = 1;
    windSubsystem.sync(renderer, 16, 0.016, rect);
    t.ok(
      'a live wind-speed change reaches every engine as windMotion01 on the very next sync, ember and smoke included',
      windEngines.every(
        (e) => Number.isFinite(e.paramCalls.at(-1)?.windMotion01) && e.paramCalls.at(-1).windMotion01 > 0
      )
    );
    t.ok(
      'flame lifeScale/activeCount actually moved from the calm sync — the wiring reaches the tuning, not just a passthrough field',
      windEngines
        .filter((e) => e.kind === 'flame')
        .every((e) => e.paramCalls.at(-1)?.lifeScale !== e.paramCalls.at(-2)?.lifeScale)
    );

    // A sealed room (windExposure=0 on the representative fire) must stay
    // wind-immune through the REAL fires[0].windExposure wiring, not just in
    // fireWindMotion01's own isolated unit test.
    windState.fires = [{ id: 'f1', x: 50, y: 50, diameterPx: 66, intensity: 1, windExposure: 0 }];
    windSubsystem.sync(renderer, 32, 0.016, rect);
    t.ok(
      'a sealed fire (fires[0].windExposure=0) reads windMotion01=0 even at full scene wind speed',
      windEngines.every((e) => e.paramCalls.at(-1)?.windMotion01 === 0)
    );
  }
}
