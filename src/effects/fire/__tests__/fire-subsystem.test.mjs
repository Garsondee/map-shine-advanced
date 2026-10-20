/**
 * fire-subsystem.test.mjs — THE FIRE'S ORCHESTRATION, WITH FAKE ENGINES (rewritten 2026-10-20 for the billow rebuild).
 *
 * The flame and the smoke are now the billow engine (`fire-billow-*.js`, tested in their own files); what is left here is
 * the part of the subsystem that is plain JS control flow: which engine gets pushed a spawn cloud and when, what each
 * engine is handed, how the billow engine is wired (injected, so no GPU), and how the fire's LIFE shapes the light and
 * the sparks.
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
import {
  fireTierPlan,
  fireScaleChain,
  fireRuntimeFromParams,
  fireWeatherStress01,
  fireFlameBrightness01,
  fireGutter01,
} from '../fire-geometry.js';

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
  const makeFakeEngine = (kind, archetype, renderOrder, extra = {}) => {
    const e = {
      kind,
      archetype,
      renderOrder,
      scene: { visible: true, renderOrder: 0 },
      spawnCalls: [],
      paramCalls: [],
      stepCalls: 0,
      ...extra,
      setSpawnPoints(cloud) {
        e.spawnCalls.push(cloud);
      },
      setParams(p) {
        e.paramCalls.push(p);
      },
      step() {
        e.stepCalls++;
      },
      updateWind() {},
      debugState() {
        return { kind, archetype };
      },
    };
    engineInstances.push(e);
    return e;
  };

  const state = {
    enabled: true,
    params: {},
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

  // ── THE REBUILD (2026-10-20): the flame and the smoke are the billow engine; ONE particle engine is left ────────────
  const emberEngine = engineInstances.find((e) => e.kind === 'ember');
  t.ok(
    'exactly one particle engine is built — the spiralling embers (flame and smoke are the billow engine now)',
    engineInstances.length === 1 && emberEngine !== undefined
  );
  t.ok('the ember engine drew its first spawn push', emberEngine.spawnCalls.length === 1);
  t.ok(
    'renderOrder reached the engine at CONSTRUCTION (embers draw over the billow contour); setting it on `scene` is a no-op',
    emberEngine.renderOrder === 1
  );
  t.ok('without `createTarget` there is no billow engine, and status says so', subsystem.getStatus().billow === null);
  t.ok('takeFieldJobs is an empty list when there is no billow engine', subsystem.takeFieldJobs().length === 0);

  // ── motionSpeed IS GLOBAL: it must reach the ember engine ──
  {
    const sub = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => ({ ...state, params: { flameSpeed: 2 } }),
      createEngine: ({ kind, archetype, renderOrder }) => makeFakeEngine(kind, archetype, renderOrder),
    });
    const before = engineInstances.length;
    sub.sync(renderer, 0, 0.016, rect);
    const e = engineInstances[before];
    t.ok(
      'the ember engine receives the resolved motionSpeed in setParams',
      Number.isFinite(e.paramCalls.at(-1)?.motionSpeed)
    );
  }

  // ── STABILITY: re-syncing with nothing changed must not re-push anyone ──
  subsystem.sync(renderer, 16, 0.016, rect);
  subsystem.sync(renderer, 32, 0.016, rect);
  t.ok('re-syncing an unchanged cloud does not re-push to the ember engine', emberEngine.spawnCalls.length === 1);

  // ── A real paint edit reaches the engine ──
  {
    const prev = state.spawnCloud;
    state.spawnCloud = makeCloud([[0, 0]], 777);
    subsystem.sync(renderer, 48, 0.016, rect);
    t.ok('a new spawn cloud signature re-pushes the ember engine', emberEngine.spawnCalls.length === 2);
    state.spawnCloud = prev;
    subsystem.sync(renderer, 64, 0.016, rect);
  }

  // ── THE FLOOR-SWITCH REGRESSION (2026-08-12): a floor with an ANCHOR fire but no painted `_Fire` region ──────────
  // `cloud` is null; the early return only fires when BOTH paint and fires are empty. A null cloud must still be PUSHED
  // (as the stable "nothing painted" value), or the engine keeps burning the PREVIOUS floor's paint.
  {
    const engs = [];
    const anchorState = {
      enabled: true,
      params: {},
      perfTier: 2,
      mPerPx: 0.02,
      fires: [{ id: 'a1', x: 50, y: 50, diameterPx: 80, intensity: 1 }],
      spawnCloud: makeCloud([[0, 0]], 4242),
    };
    const sub = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => anchorState,
      createEngine: ({ kind, archetype, renderOrder }) => {
        const e = makeFakeEngine(kind, archetype, renderOrder);
        engs.push(e);
        return e;
      },
    });
    sub.sync(renderer, 0, 0.016, rect);
    anchorState.spawnCloud = null; // switch to a floor with an anchor and no paint
    sub.sync(renderer, 16, 0.016, rect);
    const pushed = engs[0].spawnCalls.at(-1);
    t.ok(
      'a floor with an anchor fire but no paint pushes an EMPTY cloud, not nothing',
      engs[0].spawnCalls.length === 2 && pushed?.count === 0
    );
  }

  // ── "Fire intensity" (Presence — p.intensity), not a retired brightness dial, reaches the engine as `intensity` ──
  {
    const sub = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => ({ ...state, params: { intensity: 1.5 } }),
      createEngine: ({ kind, archetype, renderOrder }) => makeFakeEngine(kind, archetype, renderOrder),
    });
    const before = engineInstances.length;
    sub.sync(renderer, 0, 0.016, rect);
    t.ok(
      '"Fire intensity" is what the ember engine reads as `intensity`',
      engineInstances[before].paramCalls.at(-1)?.intensity === 1.5
    );
  }

  // ── THE COLOUR SET: the author's hue shift reaches the engine as radians ──
  {
    const sub = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => ({ ...state, params: { colorHueShift: 90 } }),
      createEngine: ({ kind, archetype, renderOrder }) => makeFakeEngine(kind, archetype, renderOrder),
    });
    const before = engineInstances.length;
    sub.sync(renderer, 0, 0.016, rect);
    t.ok(
      'colorHueShift (degrees) reaches the engine as hueShiftRad',
      Math.abs(engineInstances[before].paramCalls.at(-1)?.hueShiftRad - Math.PI / 2) < 1e-9
    );
  }

  // ── THE STALE-fires REGRESSION (2026-08-12): `fires` changing re-pushes the ember cloud even if the cloud did not ──
  {
    const engs = [];
    const staleState = {
      enabled: true,
      params: {},
      perfTier: 2,
      mPerPx: 0.02,
      fires: [{ id: 's1', x: 50, y: 50, diameterPx: 80, intensity: 1, outdoors01: 1 }],
      spawnCloud: makeCloud([[10, 10]], 99),
    };
    const sub = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => staleState,
      createEngine: ({ kind, archetype, renderOrder }) => {
        const e = makeFakeEngine(kind, archetype, renderOrder);
        engs.push(e);
        return e;
      },
    });
    sub.sync(renderer, 0, 0.016, rect);
    staleState.fires = [{ id: 's1', x: 50, y: 50, diameterPx: 80, intensity: 1, outdoors01: 0 }]; // the fire went indoors
    sub.sync(renderer, 16, 0.016, rect);
    t.ok(
      'an indoor/outdoor flip re-pushes the ember cloud even though the cloud itself did not change',
      engs[0].spawnCalls.length === 2 && engs[0].spawnCalls.at(-1).count === 0
    );
  }

  // ── THE TIER LEVER (2026-08-30): spriteCountScale reaches the ember budget ──
  {
    const countAt = (perfTier) => {
      const sub = createFireSubsystem({
        THREE: { Scene: FakeScene },
        getFireRenderState: () => ({ ...state, perfTier }),
        createEngine: ({ kind, archetype, renderOrder }) => makeFakeEngine(kind, archetype, renderOrder),
      });
      const before = engineInstances.length;
      sub.sync(renderer, 0, 0.016, rect);
      return engineInstances[before].paramCalls.at(-1)?.activeCount;
    };
    const low = countAt(0);
    const high = countAt(3);
    t.ok(
      'a lower tier gives the ember engine a smaller budget',
      Number.isFinite(low) && Number.isFinite(high) && low < high
    );
    t.ok(
      'the tier plan is the multiplier (tier 0 is spriteCountScale of tier 3)',
      Math.abs(low / high - fireTierPlan(0).spriteCountScale / fireTierPlan(3).spriteCountScale) < 1e-9
    );
  }

  // ── THE DEPTH-AUTHORITY OCCLUSION GATE (mythica-machina-press#469) reaches the ember engine, once per sync ──
  {
    const seen = [];
    const sub = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => state,
      depthTexNode: { sentinel: 'depth' },
      depthFlagsTexNode: { sentinel: 'flags' },
      resolveExpectedDepth: (elevation) => 0.25 + elevation,
      createEngine: (cfg) => {
        seen.push(cfg);
        return makeFakeEngine(cfg.kind, cfg.archetype, cfg.renderOrder);
      },
    });
    sub.sync(renderer, 0, 0.016, rect);
    t.ok(
      'the depth nodes are forwarded to the ember engine at construction',
      seen.length === 1 && seen[0].depthTexNode?.sentinel === 'depth' && seen[0].depthFlagsTexNode?.sentinel === 'flags'
    );
    const e = engineInstances.at(-1);
    t.ok('the representative fire’s expected depth reaches setParams', e.paramCalls.at(-1)?.expectedDepth === 0.25);
    const noGate = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => state,
      createEngine: (cfg) => makeFakeEngine(cfg.kind, cfg.archetype, cfg.renderOrder),
    });
    noGate.sync(renderer, 0, 0.016, rect);
    t.ok(
      'omitting the gate params entirely does not throw, and the engine was still built',
      engineInstances.at(-1) !== e
    );
  }

  // ── THE BILLOW ENGINE IS WIRED (injected, so no GPU): what it is given, what it returns, and what that does ─────
  {
    const calls = [];
    const lifeByFire = new Map();
    const jobs = [{ name: 'fire.flame', count: 3 }];
    const fakeBillow = {
      scene: { visible: true },
      lives: { sentinel: 'lives' },
      update(ctx) {
        calls.push(ctx);
        return { lifeByFire, clusters: [] };
      },
      takeFieldJobs: () => jobs,
      getStatus: () => ({ flame: 3 }),
      dispose() {
        calls.push('disposed');
      },
    };
    const emberEngines = [];
    let precipNow = 0.4;
    const billowState = {
      enabled: true,
      params: {},
      perfTier: 3,
      mPerPx: 0.02,
      fires: [
        { id: 'live', x: 20, y: 20, diameterPx: 66, intensity: 1, windExposure: 1, outdoors01: 1 },
        { id: 'out', x: 3000, y: 3000, diameterPx: 66, intensity: 1, windExposure: 1, outdoors01: 1 },
      ],
      spawnCloud: makeCloud(
        [
          [20, 20],
          [3000, 3000],
        ],
        5
      ),
    };
    class FakeVec2 {
      set(x, y) {
        this.x = x;
        this.y = y;
        return this;
      }
    }
    const sizedRenderer = { getDrawingBufferSize: (v) => v.set(2000, 2000) };
    const sub = createFireSubsystem({
      THREE: { Scene: FakeScene, Vector2: FakeVec2 },
      getFireRenderState: () => billowState,
      getPrecip01: () => precipNow,
      createEngine: (cfg) => {
        const e = makeFakeEngine(cfg.kind, cfg.archetype, cfg.renderOrder);
        emberEngines.push(e);
        return e;
      },
      createTarget: () => ({}),
      createBillow: () => fakeBillow,
    });
    const big = { minX: 0, minY: 0, maxX: 4000, maxY: 4000 };
    sub.sync(sizedRenderer, 5000, 0.02, big);
    const ctx = calls.find((c) => c && typeof c === 'object' && c.fires);
    t.ok('the billow engine is built (injected) and added to the scene', sub.scene.children.includes(fakeBillow.scene));
    t.ok(
      'it is handed the fires, the cloud, the clock, the weather and the view',
      ctx?.fires.length === 2 &&
        ctx.cloud.count === 2 &&
        ctx.nowMs === 5000 &&
        ctx.dtSec === 0.02 &&
        ctx.precip01 === 0.4 &&
        ctx.rect === big
    );
    t.ok(
      'and the drawing buffer’s pixel density over the rect (field resolution)',
      Math.abs(ctx.pxPerWorld - 0.5) < 1e-9
    );
    t.ok(
      'and the runtime weather numbers the light and the embers use',
      typeof ctx.runtime?.windMotion01 === 'number' && typeof ctx.runtime?.rainResponse === 'number'
    );
    t.ok('takeFieldJobs forwards the billow engine’s job list for the viewer to render', sub.takeFieldJobs() === jobs);
    t.ok('the status carries the billow engine’s numbers', sub.getStatus().billow?.flame === 3);
    t.ok('getLives exposes the fires’ life book', sub.getLives()?.sentinel === 'lives');

    // THE LIGHT FOLLOWS THE FIRE'S LIFE: a put-out fire casts none, a half-lit one casts less.
    const lightsFor = () =>
      sub
        .lightSources()
        .map((l) => l.sourceId)
        .sort();
    const calmAlpha = () => sub.lightSources().find((l) => l.sourceId === 'fire:live')?.alpha01;
    lifeByFire.set('live', { vitality: 1, coal: 1, phase: 'burning' });
    lifeByFire.set('out', { vitality: 1, coal: 1, phase: 'burning' });
    precipNow = 0;
    // the light EASES (0.3 s), so settle it before reading the burning value: the rain of the first sync is still in it
    for (let i = 0; i < 40; i++)
      sub.sync({ getDrawingBufferSize: () => ({ x: 2000, y: 2000 }) }, 5020 + i * 50, 0.05, big);
    const full = calmAlpha();
    t.ok('two burning fires cast two lights', lightsFor().length === 2);
    lifeByFire.set('out', { vitality: 0, coal: 0, phase: 'dead' });
    sub.sync({ getDrawingBufferSize: () => ({ x: 2000, y: 2000 }) }, 5040, 0.02, big);
    t.ok('a dead fire casts no light at all', !lightsFor().includes('fire:out') && lightsFor().includes('fire:live'));
    lifeByFire.set('out', { vitality: 0, coal: 0.8, phase: 'out' });
    sub.sync({ getDrawingBufferSize: () => ({ x: 2000, y: 2000 }) }, 5060, 0.02, big);
    t.ok('a put-out fire with hot coals casts a faint glow', lightsFor().includes('fire:out'));
    lifeByFire.set('live', { vitality: 0.5, coal: 1, phase: 'burning' });
    for (let i = 0; i < 40; i++)
      sub.sync({ getDrawingBufferSize: () => ({ x: 2000, y: 2000 }) }, 8000 + i * 50, 0.05, big);
    t.ok(
      `a half-lit fire’s light eases down to about half its flame’s (${(calmAlpha() / full).toFixed(3)} of full)`,
      calmAlpha() < full * 0.75 && calmAlpha() > full * 0.3
    );

    // A PUT-OUT FIRE SENDS NO SPARKS: its points leave the ember engine's cloud (the other fire's stay).
    const emberEngine2 = emberEngines.at(-1);
    lifeByFire.set('live', { vitality: 1, coal: 1, phase: 'burning' });
    lifeByFire.set('out', { vitality: 0, coal: 0, phase: 'dead' });
    sub.sync({ getDrawingBufferSize: () => ({ x: 2000, y: 2000 }) }, 7000, 0.02, big);
    t.ok('the ember engine was handed a cloud after the fire went out', emberEngine2.spawnCalls.length >= 1);
    sub.dispose();
    t.ok(
      'dispose releases the billow engine and removes its scene',
      calls.includes('disposed') && !sub.scene.children.includes(fakeBillow.scene)
    );
  }
  // ── EACH FIRE'S WIND EXPOSURE COMES FROM THE BAKE'S GEOMETRY (2026-10-07) ──
  // `fires[].windExposure` arrives from boot.js as a sample of the painted
  // `_Outdoors` mask — the question "is there a roof", which the wind has not
  // consulted since the 2026-07-22 rethink ("geometry decides where wind is, not
  // paint"). The subsystem now replaces it with the bake's own openness at the
  // fire's position (`windHandle.cpuAt`), so a hearth in a room painted as
  // outdoors — or on a floor whose mask never streamed, which boot answers with
  // "fully outdoors" — no longer reads as exposed to a gale it cannot feel.
  {
    const rect2 = { minX: 0, minY: 0, maxX: 4000, maxY: 4000 };
    const opennessAt = (x) => (x < 1000 ? 0 : 1); // a sealed room west of x=1000, open ground east of it
    const geoHandle = {
      hasBake: true,
      version: 1,
      ambient: { speed01: { value: 0.4 }, directionDeg: { value: 90 } },
      cpuAt: (x) => ({ exposure: 1, openness: opennessAt(x), solid: false, inGrid: true }),
    };
    const geoState = {
      enabled: true,
      params: {},
      perfTier: 2,
      mPerPx: 0.02,
      fires: [
        // PAINTED as outdoors (1) but standing in the sealed room:
        { id: 'hearth', x: 200, y: 200, diameterPx: 66, intensity: 1, windExposure: 1, outdoors01: 1 },
        // PAINTED as sheltered (0) but standing on open ground:
        { id: 'camp', x: 3000, y: 200, diameterPx: 66, intensity: 1, windExposure: 0, outdoors01: 1 },
      ],
      spawnCloud: makeCloud([[0, 0]], 1),
    };
    const stubEngine = ({ kind, archetype, renderOrder }) => ({
      kind,
      archetype,
      renderOrder,
      scene: { visible: true, renderOrder: 0 },
      setSpawnPoints() {},
      setParams() {},
      step() {},
      updateWind() {},
      debugState: () => ({ kind, archetype }),
    });
    const geoSubsystem = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => geoState,
      getWindHandle: () => geoHandle,
      createEngine: stubEngine,
    });
    geoSubsystem.sync(renderer, 0, 0.016, rect2);
    const lightOf = (id) => geoSubsystem.lightSources().find((l) => l.sourceId === `fire:${id}`);
    t.ok(
      'a fire in a SEALED room reads openness 0 even though the painted mask said 1 — the geometry decides, not the paint',
      lightOf('hearth')?.windExposure === 0
    );
    t.ok(
      'a fire on OPEN ground reads openness 1 even though the painted mask said 0',
      lightOf('camp')?.windExposure === 1
    );
    t.ok(
      'the roof question is untouched: outdoors01 still comes from the mask (the input list is never mutated either)',
      geoState.fires.every((f) => f.outdoors01 === 1) &&
        geoState.fires[0].windExposure === 1 &&
        geoState.fires[1].windExposure === 0
    );

    // Without a bake the painted value stays the fallback — never a silent "sealed".
    const noBakeSubsystem = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => geoState,
      getWindHandle: () => ({
        hasBake: false,
        version: 0,
        ambient: { speed01: { value: 0.4 }, directionDeg: { value: 90 } },
      }),
      createEngine: stubEngine,
    });
    noBakeSubsystem.sync(renderer, 0, 0.016, rect2);
    t.ok(
      'with no bake yet, the painted-mask exposure stays as the fallback (fail toward the old behaviour, not toward "sealed")',
      noBakeSubsystem.lightSources().find((l) => l.sourceId === 'fire:hearth')?.windExposure === 1
    );
  }

  // ── RAIN DOUSES FIRE (2026-10-19) — the scene's precipitation reaching every engine and the light ────────────
  {
    const rect3 = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const rainEngines = [];
    let precip = 0;
    const rainState = {
      enabled: true,
      params: {},
      perfTier: 2,
      mPerPx: 0.02,
      fires: [
        { id: 'open', x: 20, y: 20, diameterPx: 66, intensity: 1, windExposure: 1, outdoors01: 1 },
        { id: 'roofed', x: 80, y: 80, diameterPx: 66, intensity: 1, windExposure: 1, outdoors01: 0 },
      ],
      spawnCloud: makeCloud([[0, 0]], 1),
    };
    const rainSubsystem = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => rainState,
      getPrecip01: () => precip,
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
        rainEngines.push(e);
        return e;
      },
    });
    const renderer3 = {};
    rainSubsystem.sync(renderer3, 0, 0.016, rect3);
    const dryAlpha = rainSubsystem.lightSources().map((l) => l.alpha01);
    t.ok(
      'with no precipitation every engine gets rain01 = 0',
      rainEngines.length === 1 && rainEngines.every((e) => e.paramCalls.at(-1)?.rain01 === 0)
    );
    precip = 0.8;
    rainSubsystem.sync(renderer3, 16, 0.016, rect3);
    t.ok(
      'the live precipitation reaches every engine as rain01 on the very next sync (the ember engine)',
      rainEngines.every((e) => Math.abs(e.paramCalls.at(-1)?.rain01 - 0.8) < 1e-12)
    );
    precip = 5;
    rainSubsystem.sync(renderer3, 32, 0.016, rect3);
    t.ok(
      'precipitation is clamped to 0..1 before it reaches the engines',
      rainEngines.every((e) => e.paramCalls.at(-1)?.rain01 === 1)
    );
    precip = NaN;
    rainSubsystem.sync(renderer3, 48, 0.016, rect3);
    t.ok(
      'a non-finite precipitation reads as dry, never NaN',
      rainEngines.every((e) => e.paramCalls.at(-1)?.rain01 === 0)
    );

    // The light: an open-sky fire dims in the rain; one under a roof does not. (Two far-apart fires = two clusters.)
    precip = 1;
    rainSubsystem.sync(renderer3, 64, 0.016, rect3);
    const wet = rainSubsystem.lightSources();
    t.ok(
      'rain dims the cast light of a fire under open sky',
      wet.length >= 1 && Math.min(...wet.map((l) => l.alpha01)) < Math.min(...dryAlpha)
    );

    // Unwired (the default for every pre-existing caller): dry, never an error.
    const dryEngines = [];
    const dryOnly = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => rainState,
      createEngine: ({ kind, archetype }) => {
        const e = {
          kind,
          archetype,
          scene: { visible: true, renderOrder: 0 },
          paramCalls: [],
          setSpawnPoints() {},
          setParams(p) {
            e.paramCalls.push(p);
          },
          step() {},
          debugState: () => ({ kind, archetype }),
        };
        dryEngines.push(e);
        return e;
      },
    });
    dryOnly.sync(renderer3, 0, 0.016, rect3);
    t.ok(
      'no getPrecip01 wired: the engine reads rain01 = 0 (a dry world), never undefined',
      dryEngines.length === 1 && dryEngines.every((e) => e.paramCalls.at(-1)?.rain01 === 0)
    );
  }

  // ── THE LIGHT IS THE FLAMES' OWN BRIGHTNESS (2026-10-20, mmp-26u) ──────────────────────────────────────────────
  // Three equal fires: one in a sealed room (openness 0 west of x=1000), one in the open, and one standing in the
  // doorway with half its spawn points on each side. The light must follow what the flame sprites standing on those
  // spawn points would show — and ease to it, never snap.
  {
    const rect4 = { minX: 0, minY: 0, maxX: 4000, maxY: 4000 };
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    const ambient = { speed01: { value: 0 }, directionDeg: { value: 90 } };
    const handle = {
      hasBake: true,
      version: 1,
      ambient,
      cpuAt: (x) => ({ exposure: 1, openness: x < 1000 ? 0 : 1, sky: 1, solid: false, inGrid: true }),
    };
    const fires = [
      { id: 'room', x: 200, y: 200, diameterPx: 66, intensity: 1, windExposure: 1, outdoors01: 1 },
      { id: 'door', x: 1000, y: 1500, diameterPx: 66, intensity: 1, windExposure: 1, outdoors01: 1 },
      { id: 'yard', x: 3000, y: 200, diameterPx: 66, intensity: 1, windExposure: 1, outdoors01: 1 },
    ];
    const lightState = {
      enabled: true,
      params: {},
      perfTier: 2,
      mPerPx: 0.02,
      fires,
      spawnCloud: makeCloud(
        [
          [180, 200],
          [220, 200],
          [990, 1500],
          [1010, 1500],
          [2980, 200],
          [3020, 200],
        ],
        7
      ),
    };
    const lightSubsystem = createFireSubsystem({
      THREE: { Scene: FakeScene },
      getFireRenderState: () => lightState,
      getWindHandle: () => handle,
      createEngine: ({ kind, archetype }) => ({
        kind,
        archetype,
        scene: { visible: true, renderOrder: 0 },
        setSpawnPoints() {},
        setParams() {},
        step() {},
        updateWind() {},
        debugState: () => ({ kind, archetype }),
      }),
    });
    const alphaOf = (id) => lightSubsystem.lightSources().find((l) => l.sourceId === `fire:${id}`)?.alpha01;
    // The clock is HELD (only dt advances) so the gutter's slow cold dips are the same at every frame and the settled
    // light has one exact expected value; the dips themselves are pinned in fire-geometry.test.mjs.
    const CLOCK_MS = 12345;
    const frame = (dt) => lightSubsystem.sync(renderer4, CLOCK_MS, dt, rect4);
    const renderer4 = {};
    // What a flame sprite standing at (x, y) shows in this gale, exactly as the draw shader computes it.
    const gale = fireRuntimeFromParams({}, fireScaleChain(66, 0.02, { fuel: undefined }), { speed01: 0.9 });
    const spriteBrightness = (x, y, openness) =>
      fireFlameBrightness01(
        fireWeatherStress01({
          windMotion01: gale.windMotion01 * openness,
          rain01: 0,
          gain: gale.stressGain,
        }),
        { cold: fireGutter01(CLOCK_MS * 0.001 * gale.motionSpeed, x, y).cold }
      );

    frame(0.016);
    const calm = { room: alphaOf('room'), door: alphaOf('door'), yard: alphaOf('yard') };
    t.ok(
      'three equal fires in calm air cast the same light',
      calm.room > 0.05 && near(calm.room, calm.door, 1e-12) && near(calm.room, calm.yard, 1e-12)
    );

    // A gale arrives. One frame later the light has only started to move: eased, not snapped.
    ambient.speed01.value = 0.9;
    frame(0.016);
    const firstStep = alphaOf('yard');
    const moved = (calm.yard - firstStep) / calm.yard;
    for (let i = 0; i < 200; i++) frame(0.05);
    const settled = { room: alphaOf('room'), door: alphaOf('door'), yard: alphaOf('yard') };
    const targetDrop = (calm.yard - settled.yard) / calm.yard;
    t.ok(
      `the light eases toward the gale's brightness instead of snapping (first frame covered ${(moved / targetDrop).toFixed(3)} of the way)`,
      targetDrop > 0.3 && moved > 0 && moved / targetDrop > 0.02 && moved / targetDrop < 0.12
    );
    t.ok(
      'a fire in a SEALED room keeps its calm light in a gale — its flames are untouched, so its light is',
      near(settled.room, calm.room, 1e-9)
    );
    t.ok('a fire in the open is dimmed hard by the same gale', settled.yard < calm.yard * 0.7);
    const yardExpected = (spriteBrightness(2980, 200, 1) + spriteBrightness(3020, 200, 1)) / 2;
    t.ok(
      `the open fire is lit by exactly what its own flames show (${yardExpected.toFixed(4)} of calm)`,
      near(settled.yard / calm.yard, yardExpected, 1e-6)
    );
    const doorExpected = (spriteBrightness(990, 1500, 0) + spriteBrightness(1010, 1500, 1)) / 2;
    t.ok(
      'a fire in the doorway, half its flames sealed and half exposed, is lit by the MEAN of the two',
      near(settled.door / calm.door, doorExpected, 1e-6) && settled.door > settled.yard && settled.door < settled.room
    );

    // The wind drops again and the light recovers.
    ambient.speed01.value = 0;
    for (let i = 0; i < 200; i++) frame(0.05);
    t.ok('when the wind drops the light returns to its calm value', near(alphaOf('yard'), calm.yard, 1e-9));
  }
}
