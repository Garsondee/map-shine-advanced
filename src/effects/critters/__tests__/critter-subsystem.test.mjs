/**
 * The subsystem is the part of the critters that decides things on the CPU: when to rebuild a
 * zone, how many agents each engine gets, how much of the population the sky lets out. It is
 * tested here against STUB engines and allocators (they are injected for exactly this reason), so
 * what is proven is the lifecycle — not the GPU, which the shader lab checks.
 */
import { createCritterSubsystem, critterUniformValues, flyShadowFromSky } from '../critter-subsystem.js';
import { getLogLevel, setLogLevel } from '../../../core/log.js';
import { SMELLY_FLIES_PARAMS } from '../smelly-flies.js';
import { MAGGOTS_PARAMS } from '../maggots.js';
import { FIREFLIES_PARAMS } from '../fireflies.js';
import { CRITTER_CAPACITY, FLY_LOOKS, FIREFLY_FLASH_STYLES, critterTierPlan } from '../critter-species.js';

const defaultsOf = (schema) => Object.fromEntries(Object.entries(schema).map(([id, def]) => [id, def.default]));

/** A MaskGrid with one painted disc. */
function discGrid({ w = 64, h = 48, texel = 10, cx = 32, cy = 24, r = 10 } = {}) {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) data[y * w + x] = 255;
  return { spec: { x: 0, y: 0, width: w * texel, height: h * texel, w, h, texelW: texel, texelH: texel }, data };
}

/** A MaskGrid with two painted discs of different sizes, far apart: two zones, a small one on the left. */
function twoDiscGrid({ w = 64, h = 48, texel = 10 } = {}) {
  const data = new Uint8Array(w * h);
  const discs = [
    [15, 24, 6],
    [48, 24, 12],
  ];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (discs.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r)) data[y * w + x] = 255;
  return { spec: { x: 0, y: 0, width: w * texel, height: h * texel, w, h, texelW: texel, texelH: texel }, data };
}

class FakeScene {
  constructor() {
    this.children = [];
    this.visible = true;
  }
  add(c) {
    this.children.push(c);
  }
  remove(c) {
    this.children = this.children.filter((x) => x !== c);
  }
}

/** Everything a subsystem needs, plus the spies. Each call builds a fresh fake THREE (so the shared pool is fresh too). */
function harness(group, { params, state = {}, THREE = { Scene: FakeScene } } = {}) {
  const spy = { engines: [], allocs: [], zoneBuffers: [] };
  const createEngine = (args) => {
    const e = {
      args,
      kind: args.kind,
      scene: { tag: `scene:${args.kind}` },
      setZoneCalls: [],
      active: 0,
      paramCalls: [],
      steps: [],
      zoneValid: false,
      disposed: false,
      setZone(z) {
        this.setZoneCalls.push(z);
        this.zoneValid = !!z.field && z.population > 0;
      },
      setActive(n) {
        this.active = n;
      },
      setParams(p) {
        this.paramCalls.push(p);
      },
      step(renderer, o) {
        this.steps.push(o);
      },
      get hasContent() {
        return this.zoneValid && this.active > 0.001;
      },
      debugState() {
        return { kind: this.kind };
      },
      resumeToken() {
        return { seeded: true, signature: 42, colony: 0.25 };
      },
      dispose() {
        this.disposed = true;
      },
    };
    spy.engines.push(e);
    return e;
  };
  const allocateBuffers = (T, capacity) => {
    spy.allocs.push(capacity);
    return { capacity, tag: `mem${spy.allocs.length}` };
  };
  const createZoneBuffer = ({ maxCells, homeCapacities }) => {
    const offsets = [];
    let cursor = maxCells;
    for (const c of homeCapacities) {
      offsets.push(cursor);
      cursor += c;
    }
    const buf = {
      node: {},
      sectionOffsets: offsets,
      writes: [],
      write(field, sections) {
        this.writes.push({ field, sections });
        return { cellsWritten: field ? field.cols * field.rows : 0, truncated: false };
      },
    };
    spy.zoneBuffers.push(buf);
    return buf;
  };
  const schema = { smellyFlies: SMELLY_FLIES_PARAMS, maggots: MAGGOTS_PARAMS, fireflies: FIREFLIES_PARAMS }[group];
  const renderState = {
    enabled: true,
    params: { ...defaultsOf(schema), ...params },
    perfTier: 2,
    floorIndex: 0,
    elevation: 0,
    gridPx: 100,
    maskGrid: discGrid(),
    maskVersion: 1,
    ...state,
  };
  const sub = createCritterSubsystem({
    THREE,
    group,
    getRenderState: () => renderState,
    createEngine,
    allocateBuffers,
    createZoneBuffer,
    resolveExpectedDepth: (e) => e + 1,
  });
  return { sub, spy, renderState, THREE };
}

const DAY = {
  sun: { elevationDeg: 50, azimuthDeg: 180, dayFactor01: 1, rising: false },
  weather: { precip01: 0, cloudCover01: 0 },
  wind: { speed01: 0 },
};
const NIGHT = {
  sun: { elevationDeg: -40, azimuthDeg: 0, dayFactor01: 0, rising: false },
  weather: { precip01: 0, cloudCover01: 0 },
  wind: { speed01: 0 },
};
const DUSK = {
  sun: { elevationDeg: -8, azimuthDeg: 270, dayFactor01: 0.05, rising: false },
  weather: { precip01: 0, cloudCover01: 0 },
  wind: { speed01: 0 },
};
const RAINY_DUSK = { ...DUSK, weather: { precip01: 1, cloudCover01: 1 } };
const RENDERER = {};
/** An engine's setParams calls, split into the two kinds the subsystem makes: the author's values and the weather drive. */
const valueCalls = (e) => e.paramCalls.filter((c) => 'expectedDepth' in c);
const driveCalls = (e) => e.paramCalls.filter((c) => 'windPush' in c);
const RECT = { minX: 0, minY: 0, maxX: 640, maxY: 480 };

export function run(t) {
  // ---- construction fails loudly ---------------------------------------------------------------
  const base = { THREE: { Scene: FakeScene }, createEngine() {}, allocateBuffers() {}, createZoneBuffer() {} };
  t.throws(
    'an unknown group throws',
    () => createCritterSubsystem({ ...base, group: 'bees', getRenderState: () => ({}) }),
    'unknown group'
  );
  t.throws(
    'a missing render-state seam throws (never defaulted)',
    () => createCritterSubsystem({ ...base, group: 'fireflies' }),
    'getRenderState'
  );
  t.throws(
    'a missing GPU allocator throws (they are injected)',
    () => createCritterSubsystem({ ...base, group: 'fireflies', getRenderState: () => ({}), createZoneBuffer: null }),
    'createZoneBuffer'
  );

  // ---- uniform conversion ----------------------------------------------------------------------
  const fly = critterUniformValues(
    'fly',
    { ...defaultsOf(SMELLY_FLIES_PARAMS), tint: '#ff8000', species: 'bluebottle' },
    { shadowShift: [0.1, 0.2], shadowSoft: 5, shadowAmount: 0.3 }
  );
  t.ok(
    'a fly tint hex becomes an sRGB triple',
    fly.tint[0] === 1 && Math.abs(fly.tint[1] - 128 / 255) < 1e-9 && fly.tint[2] === 0
  );
  t.ok(
    'the species name becomes its shader index',
    fly.lookIndex === FLY_LOOKS.indexOf('bluebottle') && fly.lookIndex === 2
  );
  t.ok('plain numbers are passed through by their own names', fly.buzz === 1500 && fly.size === 18);
  t.ok('the sky-resolved shadow rides along', fly.shadowAmount === 0.3 && fly.shadowShift[1] === 0.2);
  t.ok(
    'an unknown species falls back to "mixed" (0), never a negative index',
    critterUniformValues('fly', { species: 'wasp' }).lookIndex === 0
  );
  t.ok('maggots carry their own colour', critterUniformValues('maggot', { color: '#ffffff' }).color.join() === '1,1,1');
  const ff = critterUniformValues('firefly', {
    ...defaultsOf(FIREFLIES_PARAMS),
    flashStyle: 'double',
    color: '#00ff00',
  });
  t.ok('a firefly flash style becomes its index', ff.flashStyleIndex === FIREFLY_FLASH_STYLES.indexOf('double'));
  t.ok('a firefly glow colour is a triple', ff.color.join() === '0,1,0');
  t.ok(
    'a maggot gets no fly shadow',
    !('shadowAmount' in critterUniformValues('maggot', {}, { shadowShift: [0, 0], shadowSoft: 1, shadowAmount: 1 }))
  );

  // ---- the fly's shadow comes from the shared sky ---------------------------------------------
  const noon = flyShadowFromSky(DAY, { flyHeight: 80, shadowStrength: 0.45 });
  const dusk = flyShadowFromSky(
    { ...DAY, sun: { elevationDeg: 8, azimuthDeg: 180, dayFactor01: 0.7 } },
    { flyHeight: 80, shadowStrength: 0.45 }
  );
  const night = flyShadowFromSky(NIGHT, { flyHeight: 80, shadowStrength: 0.45 });
  const len = (s) => Math.hypot(s.shadowShift[0], s.shadowShift[1]);
  t.ok("a low sun throws a fly's shadow farther than a high one", len(dusk) > len(noon));
  t.ok('night fades the shadow', night.shadowAmount < noon.shadowAmount * 0.5);
  t.ok('the shadow strength is the author’s own at noon', Math.abs(noon.shadowAmount - 0.45) < 0.05);
  t.ok('shift is per px of height (so the shader multiplies it by the live height)', len(noon) < 2.5);
  t.ok('a null sky still yields a finite shadow', Number.isFinite(flyShadowFromSky(null, {}).shadowSoft));

  // ---- the lifecycle: disabled, empty, painted ------------------------------------------------
  {
    const { sub, spy, renderState } = harness('smellyFlies');
    renderState.enabled = false;
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    t.ok(
      'disabled: no engine is ever built',
      spy.engines.length === 0 && spy.allocs.length === 0 && spy.zoneBuffers.length === 0
    );
    t.ok('disabled: nothing to draw', sub.hasContent === false && sub.scene.visible === false);
    renderState.enabled = true;
    renderState.maskGrid = null;
    sub.sync(RENDERER, 1100, 0.016, RECT, DAY);
    t.ok('enabled but nothing painted: still no engine', spy.engines.length === 0);
    renderState.maskGrid = discGrid();
    renderState.params = { ...renderState.params, fliesPerZone: 0 };
    sub.sync(RENDERER, 1200, 0.016, RECT, DAY);
    t.ok('painted but zero flies: still no engine', spy.engines.length === 0);
  }
  {
    const { sub, spy } = harness('smellyFlies');
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    t.ok('painted: exactly the fly engine is built', spy.engines.length === 1 && spy.engines[0].kind === 'fly');
    const e = spy.engines[0];
    t.ok(
      'the fly arena is allocated once at the kind’s capacity',
      spy.allocs.length === 1 && spy.allocs[0] === CRITTER_CAPACITY.fly
    );
    t.ok('one zone buffer for the effect', spy.zoneBuffers.length === 1);
    const zb = spy.zoneBuffers[0];
    t.ok(
      'the zone buffer is written once with the field and the effect’s one homes section',
      zb.writes.length === 1 && zb.writes[0].sections.length === 1 && zb.writes[0].sections[0]?.length > 0
    );
    const z = e.setZoneCalls.at(-1);
    t.ok(
      'the engine is pointed at the field with its section offset',
      z.field && z.homesOffset === zb.sectionOffsets[0] && z.population > 0
    );
    t.ok('the population is the allocator’s total, capped by capacity', z.population <= CRITTER_CAPACITY.fly);
    t.ok('in daylight the whole population shows', e.active === z.population);
    t.ok(
      'the engine is stepped with the REAL dt, the clock and the view rect',
      e.steps.length === 1 && e.steps[0].dtSec === 0.016 && e.steps[0].tMs === 1000 && e.steps[0].worldRect === RECT
    );
    const pushed = valueCalls(e).at(-1);
    t.ok(
      'params are pushed once with the converted values',
      valueCalls(e).length === 1 && pushed.buzz === 1500 && Array.isArray(pushed.tint)
    );
    t.ok(
      'the weather drive is pushed with them, calm on a calm day',
      driveCalls(e).length === 1 &&
        driveCalls(e)[0].agitation === 1 &&
        driveCalls(e)[0].tempo === 1 &&
        driveCalls(e)[0].shelter === 0
    );
    t.ok('the occlusion gate’s expected depth is resolved from the floor elevation', pushed.expectedDepth === 1);
    t.ok('it has something to draw', sub.hasContent === true && sub.scene.visible === true);
    t.ok('the engine’s scene is attached to the subsystem’s', sub.scene.children.includes(e.scene));

    // a second frame changes nothing structural and does not re-push unchanged params
    sub.sync(RENDERER, 1016, 0.016, RECT, DAY);
    t.ok('frame 2: no rebuild, no second zone write', spy.engines.length === 1 && zb.writes.length === 1);
    t.ok('frame 2: unchanged params and an unchanged sky are not pushed again', e.paramCalls.length === 2);
    t.ok('frame 2: but the kernel steps every frame', e.steps.length === 2);
    t.ok(
      'status reports the zone and the engines',
      sub.getStatus().zones === 1 && sub.getStatus().engines[0].kind === 'fly'
    );
  }

  // ---- maggots are their own effect: their own mask, engine and sky rules --------------------------
  {
    const { sub, spy, renderState } = harness('maggots');
    sub.sync(RENDERER, 1000, 0.016, RECT, NIGHT);
    const e = spy.engines[0];
    t.ok(
      'the maggots effect builds exactly one engine, of the maggot kind',
      spy.engines.length === 1 && e.kind === 'maggot'
    );
    t.ok(
      'it has its own arena at the maggot capacity and its own zone buffer',
      spy.allocs.length === 1 && spy.allocs[0] === CRITTER_CAPACITY.maggot && spy.zoneBuffers.length === 1
    );
    const pop = e.setZoneCalls.at(-1).population;
    t.ok('maggots are always out — night does not send them anywhere', e.active === pop);
    t.ok(
      'maggots follow the fly ladder (the sprite look is the same class)',
      e.args.plan === critterTierPlan('fly', 2)
    );
    t.ok('the maggot colour reached the shader as an sRGB triple', Array.isArray(valueCalls(e).at(-1).color));
    // rain drives them under, a little (default rainResponse 0.25), but a gale does not touch them
    for (let i = 0; i < 30; i++) sub.sync(RENDERER, 2000 + i * 500, 0.5, RECT, { ...NIGHT, weather: { precip01: 1 } });
    t.ok('heavy rain thins the maggots only a little', e.active > pop * 0.6 && e.active < pop * 0.95);
    for (let i = 0; i < 30; i++) sub.sync(RENDERER, 20000 + i * 500, 0.5, RECT, { ...NIGHT, wind: { speed01: 1 } });
    t.ok('a gale does not (maggots do not fly)', e.active > pop * 0.99);
    // turning them off keeps the engine but empties it
    renderState.params = { ...renderState.params, countPerZone: 0 };
    sub.sync(RENDERER, 40000, 0.016, RECT, DAY);
    t.ok('set back to 0 maggots: nothing is showing', sub.hasContent === false && e.active === 0);
  }

  // ---- the sky decides how many flies are out --------------------------------------------------
  {
    const { sub, spy } = harness('smellyFlies', { params: { nightActivity: 0.1 } });
    sub.sync(RENDERER, 1000, 0.016, RECT, NIGHT);
    const e = spy.engines[0];
    const pop = e.setZoneCalls.at(-1).population;
    t.ok(
      `a scene that opens at night starts at its target (${e.active.toFixed(1)} of ${pop}), not fading in from nothing`,
      Math.abs(e.active - pop * 0.1) < 1e-6
    );
    // dawn: the target jumps to 1 but the swarm EASES toward it
    sub.sync(RENDERER, 1016, 0.5, RECT, DAY);
    t.ok(
      'noon after night: the swarm swells gradually, not in one frame',
      e.active > pop * 0.1 && e.active < pop * 0.9
    );
    for (let i = 0; i < 40; i++) sub.sync(RENDERER, 1500 + i * 500, 0.5, RECT, DAY);
    t.ok('…and gets there', e.active > pop * 0.99);
  }

  // ---- weather: the head-count thins by cause, and the survivors are pushed around -------------------
  {
    const GALE = { ...DAY, wind: { speed01: 1, gustiness01: 0, directionDeg: 90 } };
    const settle = (sub, env, from = 5000) => {
      for (let i = 0; i < 40; i++) sub.sync(RENDERER, from + i * 500, 0.5, RECT, env);
    };
    const { sub, spy } = harness('smellyFlies');
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    const e = spy.engines[0];
    const pop = e.setZoneCalls.at(-1).population;
    t.ok('on a calm day the whole swarm is out', e.active === pop);
    settle(sub, GALE);
    t.ok('a gale sends most of them in (windResponse 0.8)', e.active < pop * 0.3 && e.active > pop * 0.1);
    const gale = driveCalls(e).at(-1);
    t.ok(
      'the survivors are carried downwind: the push is pointed along the wind, and as strong as windDrift',
      Math.hypot(gale.windPush[0], gale.windPush[1]) > 100 && gale.agitation > 1.5
    );
    settle(sub, { ...DAY, weather: { precip01: 0.7, precipKind: 'snow' } }, 40000);
    t.ok('snow thins the swarm too, with its own response', e.active < pop * 0.1 + 0.01);
    t.ok('…and drives the survivors to ground (shelter)', driveCalls(e).at(-1).shelter > 0.4);
    settle(sub, { ...DAY, weather: { precip01: 0, temperature01: 0 } }, 80000);
    t.ok('a hard freeze stills what is left, and stops them dead (coldBelow/coldResponse)', e.active <= pop * 0.11);
    t.ok('…and slows the ones that remain', driveCalls(e).at(-1).tempo < 0.5);
    settle(sub, DAY, 120000);
    t.ok('the sky clearing brings the whole swarm back', e.active > pop * 0.99 && driveCalls(e).at(-1).shelter < 0.01);
  }
  {
    const { sub, spy } = harness('smellyFlies', {
      params: {
        rainResponse: 0,
        snowResponse: 0,
        windResponse: 0,
        coldResponse: 0,
        windDrift: 0,
        windAgitation: 0,
        rainShelter: 0,
        coldSlowdown: 0,
      },
    });
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    const e = spy.engines[0];
    const pop = e.setZoneCalls.at(-1).population;
    const storm = {
      ...DAY,
      weather: { precip01: 1, temperature01: 0 },
      wind: { speed01: 1, gustiness01: 1, directionDeg: 0 },
    };
    for (let i = 0; i < 40; i++) sub.sync(RENDERER, 2000 + i * 500, 0.5, RECT, storm);
    t.ok('with every response at 0 the swarm ignores a full storm', e.active > pop * 0.999);
    const d = driveCalls(e).at(-1);
    t.ok(
      '…and is not pushed, shaken, sheltered or slowed either',
      Math.hypot(d.windPush[0], d.windPush[1]) < 1e-6 && d.agitation === 1 && d.shelter === 0 && d.tempo === 1
    );
  }

  // ---- fireflies: a window in sun elevation ---------------------------------------------------
  {
    const { sub, spy } = harness('fireflies');
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    const e = spy.engines[0];
    t.ok('fireflies: an engine of the firefly family', e.kind === 'firefly' && e.args.plan.trail !== undefined);
    t.ok('at noon none are out (but the engine exists and is idle)', e.active === 0 && sub.hasContent === false);
    sub.sync(RENDERER, 1016, 0.016, RECT, DUSK);
    const pop = e.setZoneCalls.at(-1).population;
    t.ok('at dusk the colony hatches toward full (it eases, it does not pop)', e.active > 0 && e.active < pop);
    for (let i = 0; i < 40; i++) sub.sync(RENDERER, 1500 + i * 500, 0.5, RECT, DUSK);
    t.ok('…and fills the population', e.active > pop * 0.98 && sub.hasContent === true);
    for (let i = 0; i < 40; i++) sub.sync(RENDERER, 30000 + i * 500, 0.5, RECT, RAINY_DUSK);
    t.ok('rain clears the whole colony', e.active < pop * 0.02);
  }
  {
    const { sub, spy } = harness('fireflies', { params: { alwaysActive: true } });
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    t.ok('"ignore time of day" shows them at noon', spy.engines[0].active > 0);
  }

  // ---- zone rebuild: gated, debounced, floor-aware ---------------------------------------------
  {
    const { sub, spy, renderState } = harness('smellyFlies');
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    const builds = () => sub.getStatus().fieldBuilds;
    t.ok('the field is built once', builds() === 1);
    renderState.maskVersion = 2;
    sub.sync(RENDERER, 1050, 0.016, RECT, DAY);
    t.ok('a version bump inside the debounce window costs nothing', builds() === 1);
    sub.sync(RENDERER, 1400, 0.016, RECT, DAY);
    t.ok(
      'after the window, the SAME content is recognised and skipped (hash, not rebuild)',
      builds() === 1 && sub.getStatus().fieldSkips >= 1
    );
    const writesBefore = spy.zoneBuffers[0].writes.length;
    renderState.maskGrid = discGrid({ cx: 20, cy: 20, r: 6 });
    renderState.maskVersion = 3;
    sub.sync(RENDERER, 2000, 0.016, RECT, DAY);
    t.ok('different content rebuilds the field', builds() === 2);
    t.ok(
      '…and rewrites the zone buffer in place',
      spy.zoneBuffers[0].writes.length === writesBefore + 1 && spy.zoneBuffers.length === 1
    );
    // 10 ms after the last rebuild — well inside the debounce window — but on ANOTHER FLOOR, with other paint
    renderState.floorIndex = 1;
    renderState.maskGrid = discGrid({ cx: 40, cy: 30, r: 5 });
    renderState.maskVersion = 4;
    sub.sync(RENDERER, 2010, 0.016, RECT, DAY);
    t.ok(
      'a floor change rebuilds immediately, ignoring the debounce',
      sub.getStatus().fieldBuilds === 3 && spy.engines[0].setZoneCalls.length >= 3
    );
  }
  {
    const { sub, spy, renderState } = harness('smellyFlies');
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    renderState.params = { ...renderState.params, maskSensitivity: 0.4 };
    sub.sync(RENDERER, 1020, 0.016, RECT, DAY);
    // the sensitivity key changed, but the debounce holds the old field for a quarter second
    t.ok('a sensitivity change inside the window does not rebuild yet', sub.getStatus().fieldBuilds === 1);
    sub.sync(RENDERER, 1400, 0.016, RECT, DAY);
    t.ok('…and does after it (the threshold is part of the field’s identity)', sub.getStatus().fieldBuilds === 2);
    void spy;
  }
  {
    const { sub, spy, renderState } = harness('smellyFlies');
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    const e = spy.engines[0];
    renderState.maskGrid = null;
    renderState.maskVersion = 9;
    sub.sync(RENDERER, 2000, 0.016, RECT, DAY);
    t.ok('erasing the paint hides the swarm', sub.hasContent === false && e.active === 0);
    renderState.maskGrid = discGrid();
    renderState.maskVersion = 10;
    sub.sync(RENDERER, 3000, 0.016, RECT, DAY);
    t.ok(
      'painting it back brings the swarm back, in the same engine',
      spy.engines.length === 1 && sub.hasContent === true && e.setZoneCalls.at(-1).field
    );
  }

  // ---- the tier rebuilds the engine, not the memory --------------------------------------------
  {
    const { sub, spy, renderState } = harness('smellyFlies');
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    const first = spy.engines[0];
    const popAtTier2 = first.setZoneCalls.at(-1).population;
    renderState.perfTier = 0;
    sub.sync(RENDERER, 1016, 0.016, RECT, DAY);
    t.ok('a tier change builds a new engine', spy.engines.length === 2 && spy.engines[1].args.plan.legs === false);
    t.ok(
      'the old engine’s scene is removed and the new one added',
      !sub.scene.children.includes(first.scene) && sub.scene.children.includes(spy.engines[1].scene)
    );
    t.ok(
      'the arena is REUSED (a storage buffer cannot be freed)',
      spy.allocs.length === 1 && spy.engines[1].args.memory === first.args.memory
    );
    t.ok(
      'the lower rung thins the population (countScale 0.5)',
      spy.engines[1].setZoneCalls.at(-1).population < popAtTier2
    );
    t.ok(
      'the new engine is told where the zone is and what its params are',
      spy.engines[1].setZoneCalls.length >= 1 &&
        valueCalls(spy.engines[1]).length === 1 &&
        driveCalls(spy.engines[1]).length === 1
    );
    t.ok('the old engine is disposed: its geometry, materials and pipelines go back to the renderer', first.disposed);
    t.ok('…and the new one is not', spy.engines[1].disposed === false);
    t.ok(
      'the successor is handed the old engine’s resume token, so the swarm carries on rather than reseeding',
      spy.engines[1].args.resume?.seeded === true &&
        spy.engines[1].args.resume.signature === 42 &&
        spy.engines[1].args.resume.colony === 0.25
    );
    t.ok('the very first engine has nothing to resume from', first.args.resume === null);
    renderState.perfTier = 2;
    sub.sync(RENDERER, 1032, 0.016, RECT, DAY);
    t.ok(
      'tier changes can go back and forth; each hands on to the next',
      spy.engines.length === 3 && spy.engines[1].disposed && spy.engines[2].args.resume?.seeded === true
    );
  }

  // ---- a re-dealt head-count tells the slots whose zone changed ----------------------------------
  {
    const { sub, spy, renderState } = harness('smellyFlies', {
      params: { fliesPerZone: 6, areaScaling: 1 },
      state: { maskGrid: twoDiscGrid() },
    });
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    const zb = spy.zoneBuffers[0];
    const fresh = zb.writes.at(-1).sections[0];
    const stride = 4;
    t.ok(
      'a first deal stamps every home (a stamp of 0 would read as "never dealt")',
      Array.from({ length: fresh.length / stride }, (_, k) => fresh[k * stride + 2]).every((v) => v > 0 && v < 1)
    );
    renderState.params = { ...renderState.params, fliesPerZone: 10 }; // the author drags the slider
    sub.sync(RENDERER, 1016, 0.016, RECT, DAY);
    const dealt = zb.writes.at(-1).sections[0];
    t.ok('the head-count grew and the buffer was rewritten', dealt.length > fresh.length && zb.writes.length === 2);
    t.ok('a population-only change keeps the same engine (a slider drag must not rebuild)', spy.engines.length === 1);
    const leftOf = (hs, k) => hs[k * stride] < 320; // the small disc is the left one
    let moved = 0;
    let right = true;
    for (let k = 0; k < fresh.length / stride; k++) {
      const hopped = leftOf(fresh, k) !== leftOf(dealt, k);
      const restamped = dealt[k * stride + 2] !== fresh[k * stride + 2];
      if (hopped) moved++;
      if (hopped !== restamped) right = false;
    }
    t.ok(
      `${moved} slots changed blob when the head-count grew, and exactly those were re-stamped`,
      moved >= 1 && right
    );
    t.ok(
      'slots that are new in the larger deal are stamped',
      Array.from(
        { length: (dealt.length - fresh.length) / stride },
        (_, k) => dealt[fresh.length + k * stride + 2]
      ).every((v) => v > 0)
    );
    // dealing the same numbers again changes nothing — a stamp is a change counter, not a clock
    renderState.params = { ...renderState.params, fliesPerZone: 10, tether: 30 };
    sub.sync(RENDERER, 1032, 0.016, RECT, DAY);
    t.ok('an unrelated param change does not re-deal the homes', zb.writes.length === 2);
  }

  // ---- allocations outlive a subsystem ---------------------------------------------------------
  {
    const THREE = { Scene: FakeScene };
    const a = harness('smellyFlies', { THREE });
    a.sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    const built = a.spy.engines[0];
    a.sub.dispose();
    t.ok('dispose detaches the engines', a.sub.scene.children.length === 0 && a.sub.hasContent === false);
    t.ok('…and hands each one back to the renderer', built.disposed === true);
    // a second viewer on the SAME three reuses the buffers: build it with the first's allocators
    const b = harness('smellyFlies', { THREE });
    b.sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    t.ok(
      'each harness has its own spies, but a shared THREE shares the pool (the second never allocates)',
      b.spy.allocs.length === 0 && b.spy.zoneBuffers.length === 0
    );
  }

  // ---- a swarm never takes the frame down --------------------------------------------------------
  {
    const { sub, spy } = harness('smellyFlies');
    sub.sync(RENDERER, 1000, 0.016, RECT, DAY);
    const e = spy.engines[0];
    let boom = true;
    const realStep = e.step.bind(e);
    e.step = (...a) => {
      if (boom) throw new Error('compute exploded');
      return realStep(...a);
    };
    let threw = false;
    // the subsystem logs the fault at error level, which is the point; keep it out of the test run's output
    const level = getLogLevel();
    setLogLevel(Infinity);
    try {
      sub.sync(RENDERER, 1016, 0.016, RECT, DAY);
    } catch {
      threw = true;
    } finally {
      setLogLevel(level);
    }
    t.ok('a throw inside the sync does not escape to the frame loop', threw === false);
    t.ok(
      '…the swarm hides, and the status says what happened (loudly, not silently)',
      sub.hasContent === false && sub.scene.visible === false && sub.getStatus().fault?.message === 'compute exploded'
    );
    const stepsAfterFault = e.steps.length;
    sub.sync(RENDERER, 1500, 0.016, RECT, DAY);
    t.ok(
      'the subsystem stands down for a few seconds instead of throwing every frame',
      e.steps.length === stepsAfterFault
    );
    boom = false;
    sub.sync(RENDERER, 7000, 0.016, RECT, DAY);
    t.ok(
      'then it tries again, and a healthy frame brings the swarm back',
      e.steps.length === stepsAfterFault + 1 && sub.hasContent === true
    );
    t.ok(
      'the fault stays on record (count) so a flaky swarm is not mistaken for a healthy one',
      sub.getStatus().fault.count === 1
    );
  }

  // ---- the plain-sight failure modes -----------------------------------------------------------
  {
    const { sub, spy, renderState } = harness('fireflies');
    renderState.params = { ...renderState.params, countPerZone: 0 };
    sub.sync(RENDERER, 1000, 0.016, RECT, DUSK);
    t.ok('zero fireflies per colony builds nothing', spy.engines.length === 0);
    renderState.params = { ...renderState.params, countPerZone: 10 };
    sub.sync(RENDERER, 1100, 0.016, null, NIGHT);
    t.ok('a missing view rect does not throw (it is optional)', spy.engines.length === 1);
    sub.sync(null, 1200, 0.016, RECT, DAY);
    t.ok('no renderer: hides instead of throwing', sub.hasContent === false);
  }
}
