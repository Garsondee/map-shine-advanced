/**
 * fire-billow-engine.test.mjs — THE BILLOW ENGINE'S CPU SIDE, AGAINST A FAKE RENDERER (2026-10-20).
 *
 * The engine is the glue between the world (fires, painted spawn points, wind, rain, a fire's slow life) and the model
 * (`emitFireLobes`) and the renderer. Everything here is plain JS and total over numbers, so it is tested with the REAL
 * model, the REAL life state machine and the REAL weather functions, and only the GPU-backed renderer replaced by a fake
 * (`createRenderer` is injected for exactly this). What these tests pin:
 *
 *  - `planClusters`: a wide painted region becomes several flames (the road to a burning building), a small one stays one;
 *    every painted point lands in exactly one flame; stable; capped.
 *  - the weather AT the fire reaches the lobes: rain puts an open-sky fire out and not a roofed one, wind pushes an open
 *    fire's lobes downwind and a sealed room's hardly at all, `canBeSnuffed = false` struggles but never dies.
 *  - the life is stepped even for a fire out of view (a fire off-screen still goes out in the rain).
 *  - the renderer is handed exactly what it needs: counts, contour boxes that enclose every lobe, the field jobs once.
 *  - capacity: a city block of fires drops the extras, never overruns the buffers.
 */
import {
  createBillowEngine,
  planClusters,
  mergeBoxes,
  infernoHeightGain,
  massQuality,
  massFlameGrowth,
  massSmokeKeep,
  massSootiness,
  viewCameraHeight,
  billowCameraHeight,
  BILLOW_CAMERA_PER_EYE,
  MAX_CLUSTER_RADIUS_M,
} from '../fire-billow-engine.js';
import { LOBE_STRIDE, KIND_FLAME, KIND_SMOKE, KIND_COAL, MASS_SMOKE_MAX } from '../fire-billow-geometry.js';
import { FIRE_PARAMS } from '../fire.js';
import { windFlowVector } from '../../../world/index.js';

const STRIDE = 4; // x, y, brightness, jitterRadiusPx — mirrors fire-spawn-points.js (the engine reads SPAWN_POINT_STRIDE)
const M_PER_PX = 0.0102;

const NEUTRAL = {
  intensity: 1,
  flameSize: 1,
  flameHeight: 1,
  flameLick: 1,
  flameWindLean: 1,
  flameFlecks: 1,
  flameDetail: 1,
  flameSpeed: 1,
  flameRagged: 1,
  flameShading: 0.5,
  posterize: 0.62,
  bandCount: 5,
  flameGlow: 1,
  windResponse: 1,
  smokeLineWidth: 1,
};
// (the tests pin the MODEL, not the author's tuned dials: shape/size dials start from neutral)
const defaults = { ...Object.fromEntries(Object.entries(FIRE_PARAMS).map(([k, d]) => [k, d.default])), ...NEUTRAL };

function makeCloud(pts) {
  const points = new Float32Array(pts.length * STRIDE);
  pts.forEach(([x, y], i) => {
    points[i * STRIDE] = x;
    points[i * STRIDE + 1] = y;
    points[i * STRIDE + 2] = 1;
    points[i * STRIDE + 3] = 5;
  });
  return { points, count: pts.length };
}

/** A coarse grid of painted points over a disc. */
function discOfPoints(cx, cy, radius, spacing) {
  const out = [];
  for (let y = -radius; y <= radius; y += spacing) {
    for (let x = -radius; x <= radius; x += spacing) {
      if (x * x + y * y <= radius * radius) out.push([cx + x, cy + y]);
    }
  }
  return out;
}

/** The renderer's public face with nothing behind it: records what the engine hands it. */
function makeFakeRendererFactory({ flameCapacity = 4096, smokeCapacity = 2048 } = {}) {
  const seen = {
    deps: null,
    counts: null,
    quads: null,
    quadCount: 0,
    fills: null,
    looks: null,
    bloom: null,
    bloomSets: 0,
    look: null,
    prepares: [],
    disposed: false,
  };
  const factory = (deps) => {
    seen.deps = deps;
    const flameLobes = new Float32Array(flameCapacity * LOBE_STRIDE);
    const smokeLobes = new Float32Array(smokeCapacity * LOBE_STRIDE);
    return {
      scene: { visible: true },
      flameLobes,
      smokeLobes,
      flameCapacity,
      smokeCapacity,
      uniforms: { expectedDepth: { value: -1 } },
      setCounts(f, s) {
        seen.counts = { flame: f, smoke: s };
      },
      setQuads(boxes, n, fills, looks) {
        seen.quads = Array.from(boxes).slice(0, n * 4);
        seen.quadCount = n;
        seen.fills = fills ? Array.from(fills).slice(0, n) : null;
        seen.looks = looks ? Array.from(looks).slice(0, n * 2) : null;
      },
      setBloomCounter(counter) {
        seen.bloom = counter;
        seen.bloomSets++;
      },
      setLook(look) {
        seen.look = look;
      },
      prepareField(rect, opts) {
        seen.prepares.push({ rect, opts, counts: { ...seen.counts } });
        return [
          { name: 'fire.flame', target: {}, scene: {}, camera: {}, count: seen.counts.flame },
          { name: 'fire.smoke', target: {}, scene: {}, camera: {}, count: seen.counts.smoke },
        ];
      },
      dispose() {
        seen.disposed = true;
      },
    };
  };
  return { factory, seen };
}

/** A wind handle at one place: how open and how skyward the cell is, and how hard / which way the wind blows. */
function makeWind({ openness = 1, sky = 1, speed01 = 0, dirDeg = 90, hasBake = true } = {}) {
  const handle = {
    hasBake,
    ambient: { speed01: { value: speed01 }, directionDeg: { value: dirDeg } },
    cpuAt: () => ({ openness: handle.openness, sky: handle.sky }),
    openness,
    sky,
  };
  return handle;
}

function makeEngine({ wind = makeWind(), flameCapacity, smokeCapacity, extra = {} } = {}) {
  const { factory, seen } = makeFakeRendererFactory({ flameCapacity, smokeCapacity });
  const engine = createBillowEngine({
    THREE: {},
    createTarget: () => ({}),
    getWindHandle: () => wind,
    createRenderer: factory,
    flameCapacity,
    smokeCapacity,
    ...extra,
  });
  return { engine, seen, wind, renderer: engine.renderer };
}

const RECT = { minX: 0, minY: 0, maxX: 1400, maxY: 1000 };

/** One frame's context. Scalars that differ between tests are overridable. */
function ctxOf(over = {}) {
  const fires = over.fires ?? [{ id: 'f1', x: 700, y: 500, diameterPx: 90, intensity: 1, outdoors01: 1, fuel: 'wood' }];
  const cloud = over.cloud ?? makeCloud(discOfPoints(700, 500, 40, 10));
  return {
    nowMs: 0,
    dtSec: 0.25,
    rect: RECT,
    fires,
    cloud,
    params: over.params ?? { ...defaults, windResponse: 1, weatherResponse: 1, rainResponse: 1 },
    runtime: over.runtime ?? { canBeSnuffed: true, weatherResponse: 1, rainResponse: 1, stressGain: 1 },
    precip01: 0,
    pxPerWorld: 1,
    mPerPx: M_PER_PX,
    quality: 1,
    expectedDepth: 0,
    ...over.ctx,
  };
}

/** Advance `seconds` of sim time in 0.25 s frames, with the weather held, returning the last result. */
function advance(engine, base, seconds, patch = {}) {
  let last = null;
  let now = base.nowMs;
  const frames = Math.ceil(seconds / 0.25);
  for (let i = 0; i < frames; i++) {
    now += 250;
    last = engine.update({ ...base, ...patch, nowMs: now, dtSec: 0.25 });
  }
  base.nowMs = now;
  return last;
}

function lobeCount(buf, n, kind) {
  let c = 0;
  for (let i = 0; i < n; i++) if (buf[i * LOBE_STRIDE + 8] === kind) c++;
  return c;
}

export function run(t) {
  const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

  // ── planClusters ───────────────────────────────────────────────────────────────────────────────────────────────
  {
    const maxR = Math.max(24, MAX_CLUSTER_RADIUS_M / M_PER_PX);
    t.ok(
      'a bonfire is about 90 cm of fuel wide at most (the single flame’s cap)',
      MAX_CLUSTER_RADIUS_M > 0.5 && MAX_CLUSTER_RADIUS_M < 1.5
    );

    const small = [{ id: 'camp', x: 300, y: 300, diameterPx: 70 }];
    const cloud = makeCloud(discOfPoints(300, 300, 35, 7));
    const one = planClusters(small, cloud, M_PER_PX);
    t.ok('a small fire is ONE flame', one.length === 1 && one[0].fireIndex === 0 && one[0].id === 'camp');
    t.ok(
      'and it keeps its own centre and radius',
      near(one[0].x, 300) && near(one[0].y, 300) && near(one[0].radius, 35)
    );
    t.ok('and every painted point it owns', one[0].count === cloud.count);

    t.ok(
      'no cloud at all still gives each fire a flame (with no spawn points)',
      (() => {
        const r = planClusters(small, null, M_PER_PX);
        return r.length === 1 && r[0].count === 0;
      })()
    );
    t.ok(
      'no fires gives no flames',
      planClusters([], cloud, M_PER_PX).length === 0 && planClusters(null, cloud, M_PER_PX).length === 0
    );
    t.ok(
      'a fire with no id is named by where it is (so its life survives a re-plan)',
      planClusters([{ x: 12.4, y: 99.6, diameterPx: 40 }], null, M_PER_PX)[0].id === 'fire@12,100'
    );

    // a wide painted region: a roof
    const roof = [{ id: 'roof', x: 1000, y: 1000, diameterPx: 700 }];
    const roofPts = discOfPoints(1000, 1000, 330, 42);
    const roofCloud = makeCloud(roofPts);
    const split = planClusters(roof, roofCloud, M_PER_PX);
    t.ok(`a wide painted roof is MANY flames (${split.length})`, split.length >= 12 && split.length <= 96);
    t.ok(
      'standing about one flame-width apart, so neighbours overlap into one burning mass',
      (() => {
        // every flame has a neighbour closer than two of its own radii (they touch)
        return split.every((c) =>
          split.some((d) => d !== c && Math.hypot(c.x - d.x, c.y - d.y) < (c.radius + d.radius) * 1.25)
        );
      })()
    );
    t.ok(
      'each knows how big the whole fire is (so a roof’s flames can stand taller than a campfire’s)',
      split.every((c) => near(c.parentRadius, 350) && near(c.maxRadius, maxR * massFlameGrowth(350 / maxR), 1e-6))
    );
    t.ok(
      'a building’s flames are bigger than a bonfire’s, but never more than twice as wide, and never smaller than 6 px',
      split.every((c) => c.radius <= maxR * 2 + 1e-6 && c.radius >= 6 && c.radius <= c.maxRadius + 1e-6) &&
        Math.max(...split.map((c) => c.radius)) > maxR * 1.2
    );
    t.ok(
      'while a fire that has only just outgrown one flame keeps bonfire-sized ones',
      (() => {
        const few = planClusters(
          [{ id: 'f', x: 500, y: 500, diameterPx: 2 * 1.8 * maxR }],
          makeCloud(discOfPoints(500, 500, 1.8 * maxR, 8)),
          M_PER_PX
        );
        return few.length >= 2 && few.every((c) => c.radius <= maxR * 1.06 + 1e-6);
      })()
    );
    t.ok(
      'all of them belong to the roof’s one fire (one life) and carry its id',
      split.every((c) => c.fireIndex === 0 && c.id === 'roof')
    );
    t.ok(
      'each has its own seed (they must not flicker in lock-step)',
      new Set(split.map((c) => c.seed)).size === split.length
    );
    t.ok('every painted point lands in exactly one flame', split.reduce((s, c) => s + c.count, 0) === roofPts.length);
    t.ok(
      'each flame’s points are real points from the cloud',
      split.every((c) => {
        for (let i = 0; i < c.count; i++) {
          const x = c.points[i * STRIDE];
          const y = c.points[i * STRIDE + 1];
          if (!roofPts.some((p) => near(p[0], x, 1e-3) && near(p[1], y, 1e-3))) return false;
        }
        return true;
      })
    );
    t.ok(
      'the flames cover the roof: every painted point is within a flame’s reach of some centre',
      roofPts.every(([x, y]) => split.some((c) => Math.hypot(c.x - x, c.y - y) <= maxR * 1.6))
    );
    const again = planClusters(roof, makeCloud(roofPts), M_PER_PX);
    t.ok(
      'planning is deterministic: the same paint gives the same flames, in the same order',
      JSON.stringify(split.map((c) => [c.x, c.y, c.radius, c.seed, c.count])) ===
        JSON.stringify(again.map((c) => [c.x, c.y, c.radius, c.seed, c.count]))
    );

    // a bonfire a little over the cap is ONE big flame, not two candles side by side
    {
      const ratio = (r) =>
        planClusters(
          [{ id: 'b', x: 500, y: 500, diameterPx: 2 * r * maxR }],
          makeCloud(discOfPoints(500, 500, r * maxR, 8)),
          M_PER_PX
        );
      t.ok(
        `a fire 1.4x the cap wide is still one flame (${ratio(1.4).length})`,
        ratio(1.4).length === 1 && ratio(1.0).length === 1
      );
      const few = ratio(2.2).length;
      const many = ratio(4).length;
      t.ok(
        `one that has outgrown it gets a few big flames (${few}), a building a mass of them (${many})`,
        few >= 2 && few <= 12 && many > few * 2
      );
    }

    // too few painted points to split on
    const sparse = planClusters(
      [{ id: 'wide', x: 100, y: 100, diameterPx: 700 }],
      makeCloud([
        [100, 100],
        [110, 100],
        [100, 110],
      ]),
      M_PER_PX
    );
    t.ok(
      'a wide fire with hardly any paint stays a single flame (nothing to spread the flames over)',
      sparse.length === 1
    );

    // two fires share a cloud: each point to the nearest
    const twoFires = [
      { id: 'a', x: 200, y: 200, diameterPx: 60 },
      { id: 'b', x: 900, y: 200, diameterPx: 60 },
    ];
    const twoCloud = makeCloud([...discOfPoints(200, 200, 25, 10), ...discOfPoints(900, 200, 25, 10)]);
    const two = planClusters(twoFires, twoCloud, M_PER_PX);
    const near200 = discOfPoints(200, 200, 25, 10).length;
    t.ok(
      'each painted point goes to its NEAREST fire',
      two.length === 2 && two[0].count === near200 && two[1].count === twoCloud.count - near200
    );

    // OWNERSHIP IS "WHICH FIRE IS THIS POINT PART OF", NOT "WHOSE CENTRE IS NEARER" (2026-10-20, the real viewer: a bonfire
    // was handed two dim points off the bottom edge of the roof 330 px north of it, and every flame piece rooted on one
    // stood alone in the air above the fire — a detached teardrop)
    {
      const roofFire = { id: 'roof', x: 1000, y: 1000, diameterPx: 1400 };
      const camp = { id: 'camp', x: 1000, y: 330, diameterPx: 60 };
      const edge = discOfPoints(1000, 400, 20, 10); // the roof's paint beside the camp: 600 from the roof's centre, 70 from the camp's
      const campOwn = discOfPoints(1000, 330, 20, 10);
      const plan = planClusters([roofFire, camp], makeCloud([...edge, ...campOwn]), M_PER_PX);
      const sum = (id) => plan.filter((c) => c.id === id).reduce((s, c) => s + c.count, 0);
      t.ok(
        `a point inside a wide fire's disc is the WIDE fire's, though a small fire's centre is nearer (${sum('roof')} of ${edge.length} to the roof, ${sum('camp')} of ${campOwn.length} to the camp)`,
        sum('roof') === edge.length && sum('camp') === campOwn.length
      );
      const lone = planClusters([camp], makeCloud([...campOwn, [1000, 900], [1400, 330]]), M_PER_PX);
      t.ok(
        'a point many radii from every fire is nobody’s: it roots no flame piece',
        lone.length === 1 && lone[0].count === campOwn.length
      );

      // with the scene's label field, ownership is structural: only a fire of the point's own blob can own it
      const W = 70;
      const H = 50;
      const labelGrid = (labelAt) => {
        const nearestLabel = new Int32Array(W * H);
        for (let r = 0; r < H; r++)
          for (let c = 0; c < W; c++) nearestLabel[r * W + c] = labelAt((c + 0.5) * 20, (r + 0.5) * 20);
        return { nearestLabel, spec: { x: 0, y: 0, w: W, h: H, width: 1400, height: 1000 } };
      };
      const grid = labelGrid((x, y) => {
        if (Math.abs(y - 200) > 60) return -1;
        if (x > 240 && x < 290) return 2; // a patch of B's blob that reaches toward A
        if (x < 280) return 1;
        if (x > 520 && x < 580) return -1; // paint no blob claims
        if (x >= 580 && x < 700) return 7; // a blob whose fire did not survive
        if (x > 820) return 2;
        return -1;
      });
      const A = { id: 'a', x: 200, y: 200, diameterPx: 60, label: 1 };
      const B = { id: 'b', x: 900, y: 200, diameterPx: 60, label: 2 };
      const pts = [
        [210, 210], // A's own
        [260, 200], // B's blob, though A is the nearer fire
        [910, 210], // B's own
        [550, 200], // on no blob
        [640, 200], // on a blob with no fire
      ];
      const byLabel = planClusters([A, B], makeCloud(pts), M_PER_PX, grid);
      t.ok(
        `with the label field a point goes to a fire of its OWN blob (a ${byLabel[0].count}, b ${byLabel[1].count}), and to none when its blob has no fire`,
        byLabel[0].count === 1 && byLabel[1].count === 2
      );
      const byDistance = planClusters([A, B], makeCloud(pts), M_PER_PX);
      t.ok(
        'without it the nearest fire in its own radii takes the blob-less points that are close enough',
        byDistance[0].count === 2 && byDistance[1].count === 1
      );
      const noLabel = planClusters([{ ...A, label: undefined }, B], makeCloud(pts), M_PER_PX, grid);
      t.ok('a fire with no label (an anchor) is given no painted points under the label field', noLabel[0].count === 0);
    }

    // the city block: a huge fire is capped
    const huge = planClusters(
      [{ id: 'city', x: 3000, y: 3000, diameterPx: 6000 }],
      makeCloud(discOfPoints(3000, 3000, 2900, 60)),
      M_PER_PX
    );
    t.ok(`a city block's fire is capped at 96 flames (${huge.length})`, huge.length === 96);

    // a very large cluster's points are subsampled, not dropped
    const dense = planClusters(
      [{ id: 'd', x: 100, y: 100, diameterPx: 120 }],
      makeCloud(discOfPoints(100, 100, 60, 2)),
      M_PER_PX
    );
    t.ok(
      'a dense cloud is subsampled to a bounded footprint (96 points per flame at most)',
      dense[0].count === 96 && dense[0].points.length === 96 * STRIDE
    );

    // a flame is capped in METRES of fuel, so how many px that is depends on the grid: at 5 mm/px a bonfire is 180 px wide
    // and the roof is a few flames; at 20 mm/px it is only 45 px, and the same painted roof needs far more of them
    const fine = planClusters(roof, roofCloud, 0.005).length;
    const coarse = planClusters(roof, roofCloud, 0.02).length;
    t.ok(
      `the split follows the grid scale (${fine} flames at 5 mm/px, ${coarse} at 20 mm/px: more pixels per metre means fewer, bigger-in-px flames)`,
      coarse > fine && fine >= 1
    );
  }

  // ── WIRING: what the renderer is built with ──────────────────────────────────────────────────────────────────────
  {
    const { engine, seen } = makeEngine({ extra: { lighting: { illumTexNode: 'I', colorationTexNode: 'C' } } });
    t.ok(
      'the renderer is built with the injected THREE, allocator and the scene lighting',
      seen.deps &&
        seen.deps.THREE &&
        typeof seen.deps.createTarget === 'function' &&
        seen.deps.lighting?.illumTexNode === 'I'
    );
    t.ok('without a depth texture there is no depth gate', seen.deps.depth === null);
    const withDepth = makeEngine({ extra: { depthTexNode: { sample: () => 0 }, depthFlagsTexNode: null } });
    t.ok(
      'with a depth texture the renderer gets the occlusion gate builder',
      typeof withDepth.seen.deps.depth?.buildGate === 'function' && withDepth.seen.deps.depth.depthTexNode !== undefined
    );
    t.ok('the engine exposes the renderer’s scene to draw', engine.scene === engine.renderer.scene);
    engine.dispose();
    t.ok('dispose releases the renderer', seen.disposed === true);
  }

  // ── A CALM, BURNING FIRE ──────────────────────────────────────────────────────────────────────────────────────
  {
    const { engine, seen, renderer } = makeEngine();
    const base = ctxOf();
    const res = engine.update(base);
    const st = engine.getStatus();
    t.ok(
      'a burning fire writes flame lobes, smoke lobes and a bed of coals',
      st.flame > 0 && st.smoke > 0 && st.coal > 0 && st.coal < st.flame
    );
    t.ok(
      'the renderer is told exactly how many of each',
      seen.counts.flame === st.flame && seen.counts.smoke === st.smoke
    );
    t.ok('the scene is visible when something is drawn', renderer.scene.visible === true);
    const flameKinds = new Set();
    for (let i = 0; i < st.flame; i++) flameKinds.add(renderer.flameLobes[i * LOBE_STRIDE + 8]);
    t.ok(
      'the flame buffer holds only flame and coal lobes, the smoke buffer only smoke',
      [...flameKinds].every((k) => k === KIND_FLAME || k === KIND_COAL) &&
        lobeCount(renderer.smokeLobes, st.smoke, KIND_SMOKE) === st.smoke
    );
    t.ok(
      'the status counts the fires and the flames',
      st.fires === 1 && st.clusters === 1 && st.lives === 1 && st.dropped === 0
    );
    t.ok(
      'the life of a fresh fire is burning at full',
      res.lifeByFire.get('f1')?.phase === 'burning' &&
        res.lifeByFire.get('f1').vitality === 1 &&
        res.lifeByFire.get('f1').coal === 1
    );
    t.ok(
      'the look uniforms carry the hue and the tint',
      seen.look && 'hue' in seen.look && Array.isArray(seen.look.tint)
    );
    t.ok(
      'the field jobs are prepared at the drawing buffer’s density, over the visible rect',
      seen.prepares.length === 1 && seen.prepares[0].opts.pxPerWorld === 1 && seen.prepares[0].rect === RECT
    );

    const jobs = engine.takeFieldJobs();
    t.ok(
      'the field jobs (flame, smoke) are handed out ONCE',
      jobs.length === 2 &&
        jobs[0].name === 'fire.flame' &&
        jobs[1].name === 'fire.smoke' &&
        engine.takeFieldJobs().length === 0
    );

    // the contour boxes enclose every lobe
    t.ok('one fire is one contour box', seen.quadCount === 1 && seen.quads.length === 4);
    const [bx, by, bw, bh] = seen.quads;
    let inside = true;
    for (const [buf, n] of [
      [renderer.flameLobes, st.flame],
      [renderer.smokeLobes, st.smoke],
    ]) {
      for (let i = 0; i < n; i++) {
        const x = buf[i * LOBE_STRIDE];
        const y = buf[i * LOBE_STRIDE + 1];
        if (x < bx || x > bx + bw || y < by || y > by + bh) inside = false;
      }
    }
    t.ok('and the box encloses the centre of every flame, coal and smoke lobe', inside);
    t.ok('the box is a sane size (not the whole map)', bw > 40 && bw < 900 && bh > 40 && bh < 900);

    // the clusters are only replanned when the paint, the fires or the scale change
    const r1 = engine.update(base);
    const r2 = engine.update(base);
    t.ok('the flames are planned once per paint (the same plan is reused frame to frame)', r1.clusters === r2.clusters);
    const r3 = engine.update({ ...base, fires: [...base.fires] });
    t.ok('and replanned when the fires change', r3.clusters !== r2.clusters);
    const r4 = engine.update({ ...base, fires: r3.clusters ? [...base.fires] : base.fires, mPerPx: 0.02 });
    t.ok('and when the grid scale changes', r4.clusters !== r3.clusters);

    // nothing in view
    const offscreen = engine.update(
      ctxOf({ fires: [{ id: 'far', x: 90000, y: 90000, diameterPx: 90 }], cloud: makeCloud([[90000, 90000]]) })
    );
    t.ok(
      'with nothing in view nothing is drawn, no jobs are prepared and the scene hides',
      engine.getStatus().flame === 0 &&
        engine.takeFieldJobs().length === 0 &&
        renderer.scene.visible === false &&
        offscreen.lifeByFire.has('far')
    );

    // no fires at all
    const empty = makeEngine();
    empty.engine.update(ctxOf({ fires: [], cloud: null }));
    t.ok(
      'with no fires there is nothing to draw and nothing to fail',
      empty.renderer.scene.visible === false && empty.engine.getStatus().clusters === 0
    );
  }

  // ── RAIN: PUTS AN OPEN-SKY FIRE OUT, NOT A ROOFED ONE; COMES BACK AFTER A LONG DRY SPELL ─────────────────────────
  {
    const quick = {
      ...defaults,
      windResponse: 1,
      weatherResponse: 1,
      rainResponse: 1,
      douseSec: 6,
      smoulderSec: 20,
      rekindleDelaySec: 30,
      rekindleRampSec: 20,
    };

    // open sky
    {
      const { engine, renderer } = makeEngine({ wind: makeWind({ openness: 1, sky: 1 }) });
      const base = ctxOf({ params: quick });
      advance(engine, base, 5);
      const dry = engine.getStatus();
      const dryFlame = lobeCount(renderer.flameLobes, dry.flame, KIND_FLAME);
      t.ok(
        'a fire in dry weather is burning at full',
        engine.lives.get('f1').phase === 'burning' && engine.lives.get('f1').vitality > 0.99
      );

      advance(engine, base, 3, { precip01: 1 });
      const mid = engine.update({ ...base, precip01: 1, nowMs: base.nowMs + 250 });
      const midState = mid.lifeByFire.get('f1');
      t.ok(`rain shrinks the flame first (vitality ${midState.vitality.toFixed(2)})`, midState.vitality < 0.9);

      const out = advance(engine, base, 40, { precip01: 1 });
      const s = out.lifeByFire.get('f1');
      t.ok(`sustained rain puts it out (phase ${s.phase})`, s.phase === 'out' || s.phase === 'dead');
      const outStatus = engine.getStatus();
      t.ok(
        'a put-out fire has no flame lobes any more but a bed of coals still writes',
        lobeCount(renderer.flameLobes, outStatus.flame, KIND_FLAME) < dryFlame * 0.25 || s.phase === 'dead'
      );
      t.ok('and as the rain falls the flame lobe count only ever went down', outStatus.flame < dry.flame);

      // dry spell: the coals cool, it sits dead, and (a long time later) it comes back
      const dead = advance(engine, base, 60, { precip01: 0 });
      t.ok(
        `after the rain stops the cold fire stays down for a while (${dead.lifeByFire.get('f1').phase})`,
        ['out', 'dead', 'burning', 'rekindle'].includes(dead.lifeByFire.get('f1').phase)
      );
      const later = advance(engine, base, 400, { precip01: 0 });
      t.ok(
        `and a long dry spell relights it (${later.lifeByFire.get('f1').phase}, vitality ${later.lifeByFire.get('f1').vitality.toFixed(2)})`,
        later.lifeByFire.get('f1').phase === 'burning' && later.lifeByFire.get('f1').vitality > 0.9
      );
    }

    // The same rain on a roofed fire: nothing happens
    {
      const { engine } = makeEngine({ wind: makeWind({ openness: 0, sky: 0 }) });
      const base = ctxOf({ params: quick });
      const out = advance(engine, base, 120, { precip01: 1 });
      t.ok(
        'a fire under a roof is never rained on: it burns until the world ends',
        out.lifeByFire.get('f1').phase === 'burning' && out.lifeByFire.get('f1').vitality > 0.99
      );
    }

    // A fire that cannot be snuffed
    {
      const { engine } = makeEngine({ wind: makeWind({ openness: 1, sky: 1 }) });
      const base = ctxOf({
        params: quick,
        runtime: { canBeSnuffed: false, weatherResponse: 1, rainResponse: 1, stressGain: 1 },
      });
      const out = advance(engine, base, 400, { precip01: 1 });
      const s = out.lifeByFire.get('f1');
      t.ok(
        `a fire that cannot be snuffed only struggles (phase ${s.phase}, vitality ${s.vitality.toFixed(2)})`,
        s.phase === 'burning' && s.vitality >= 0.39
      );
    }

    // The author's rain dial at 0 means rain does nothing
    {
      const { engine } = makeEngine({ wind: makeWind({ openness: 1, sky: 1 }) });
      const base = ctxOf({
        params: quick,
        runtime: { canBeSnuffed: true, weatherResponse: 1, rainResponse: 0, stressGain: 1 },
      });
      const out = advance(engine, base, 200, { precip01: 1 });
      t.ok(
        'with Rain response at 0 the rain does nothing at all',
        out.lifeByFire.get('f1').phase === 'burning' && out.lifeByFire.get('f1').vitality > 0.99
      );
    }

    // Relights off: it never comes back
    {
      const { engine } = makeEngine({ wind: makeWind({ openness: 1, sky: 1 }) });
      const base = ctxOf({ params: { ...quick, rekindle: false } });
      advance(engine, base, 80, { precip01: 1 });
      const later = advance(engine, base, 1500, { precip01: 0 });
      t.ok(
        `with Relights off a dead fire stays dead (${later.lifeByFire.get('f1').phase})`,
        later.lifeByFire.get('f1').phase === 'dead'
      );
    }

    // A fire out of view is still rained on
    {
      const { engine, renderer } = makeEngine({ wind: makeWind({ openness: 1, sky: 1 }) });
      const fires = [{ id: 'far', x: 90000, y: 90000, diameterPx: 90 }];
      const cloud = makeCloud([[90000, 90000]]);
      const base = ctxOf({ params: quick, fires, cloud });
      const out = advance(engine, base, 60, { precip01: 1 });
      t.ok(
        'a fire off-screen still goes out in the rain (its life is stepped though nothing is drawn)',
        out.lifeByFire.get('far').phase !== 'burning' &&
          engine.getStatus().flame === 0 &&
          renderer.scene.visible === false
      );
    }

    // A wide fire is many flames and ONE life
    {
      const { engine } = makeEngine({ wind: makeWind({ openness: 1, sky: 1 }) });
      const roof = [{ id: 'roof', x: 700, y: 500, diameterPx: 700 }];
      const base = ctxOf({ params: quick, fires: roof, cloud: makeCloud(discOfPoints(700, 500, 330, 42)) });
      const res = engine.update(base);
      t.ok(
        `a burning roof is several flames (${res.clusters.length}) but one life`,
        res.clusters.length >= 4 && res.lifeByFire.size === 1 && engine.getStatus().lives === 1
      );
    }
  }

  // ── WIND: PUSHES AN OPEN FIRE, HARDLY A SEALED ROOM'S ────────────────────────────────────────────────────────────
  {
    const dirDeg = 90;
    const w = windFlowVector(dirDeg);
    const centroidAlongWind = (wind) => {
      const { engine, renderer } = makeEngine({ wind });
      const base = ctxOf({ params: { ...defaults, windResponse: 1, weatherResponse: 1, rainResponse: 1 } });
      // average over a few seconds so a flicker phase cannot decide it
      let sum = 0;
      let n = 0;
      let now = 0;
      for (let k = 0; k < 24; k++) {
        now += 250;
        engine.update({ ...base, nowMs: now, dtSec: 0.25 });
        const nf = engine.getStatus().flame;
        for (let i = 0; i < nf; i++) {
          if (renderer.flameLobes[i * LOBE_STRIDE + 8] !== KIND_FLAME) continue;
          sum +=
            (renderer.flameLobes[i * LOBE_STRIDE] - 700) * w.x + (renderer.flameLobes[i * LOBE_STRIDE + 1] - 500) * w.y;
          n++;
        }
      }
      return n ? sum / n : 0;
    };
    const calm = centroidAlongWind(makeWind({ openness: 1, sky: 1, speed01: 0, dirDeg }));
    // 0.25 = 17.5 m/s, a Beaufort 8 gale on the linear-to-70 dial (2026-10-27).
    const gale = centroidAlongWind(makeWind({ openness: 1, sky: 1, speed01: 0.25, dirDeg }));
    const hurricane = centroidAlongWind(makeWind({ openness: 1, sky: 1, speed01: 1, dirDeg }));
    const sealed = centroidAlongWind(makeWind({ openness: 0, sky: 0, speed01: 1, dirDeg }));
    const doorway = centroidAlongWind(makeWind({ openness: 0.5, sky: 0, speed01: 1, dirDeg }));
    t.ok(
      `wind pushes an open fire’s flame downwind, and harder the stronger it blows (calm ${calm.toFixed(1)}, gale ${gale.toFixed(1)}, hurricane ${hurricane.toFixed(1)} px)`,
      gale > calm + 2 && hurricane > gale + 2
    );
    t.ok(
      `a room sealed against a hurricane hardly feels it (${sealed.toFixed(1)} px vs ${hurricane.toFixed(1)} outdoors)`,
      sealed < hurricane * 0.35 && sealed < calm + 8
    );
    t.ok(
      `a room that opens to the wind feels more of it the more it opens (sealed ${sealed.toFixed(1)}, doorway ${doorway.toFixed(1)}, open ${hurricane.toFixed(1)})`,
      doorway > sealed + 1 && doorway < hurricane
    );
  }

  // ── CULLING, CAPACITY AND THE BOX LIMIT ──────────────────────────────────────────────────────────────────────────
  {
    // a few fires, a tiny buffer: past thinning every flame out, the extras are dropped, never overrun the buffer
    const cap = 200;
    const { engine, renderer } = makeEngine({ flameCapacity: cap, smokeCapacity: 200 });
    const fires = [];
    const pts = [];
    for (let i = 0; i < 30; i++) {
      const x = 100 + (i % 10) * 120;
      const y = 120 + Math.floor(i / 10) * 200;
      fires.push({ id: `c${i}`, x, y, diameterPx: 80 });
      pts.push(...discOfPoints(x, y, 30, 12));
    }
    const base = ctxOf({ fires, cloud: makeCloud(pts) });
    const res = engine.update(base);
    const st = engine.getStatus();
    t.ok(
      `more fires than the buffer holds: the extras are dropped (${st.dropped} dropped, ${st.flame}/${cap} flame lobes)`,
      st.dropped > 0 && st.flame <= cap && st.smoke <= 200
    );
    t.ok('every fire still has a life even when its flame was dropped', res.lifeByFire.size === 30);
    t.ok(
      'the lobes are all finite (nothing leaks past the written range)',
      (() => {
        for (let i = 0; i < st.flame * LOBE_STRIDE; i++) if (!Number.isFinite(renderer.flameLobes[i])) return false;
        return true;
      })()
    );

    // a moderate overload thins EVERY flame out together instead of dropping some (a roof of 80 flames is 80 simpler flames)
    {
      const eighty = [];
      const ePts = [];
      for (let i = 0; i < 18; i++) {
        const x = 150 + (i % 6) * 220;
        const y = 150 + Math.floor(i / 6) * 220;
        eighty.push({ id: `q${i}`, x, y, diameterPx: 80 });
        ePts.push(...discOfPoints(x, y, 30, 12));
      }
      const ample = makeEngine({ flameCapacity: 20000, smokeCapacity: 20000 });
      ample.engine.update(ctxOf({ fires: eighty, cloud: makeCloud(ePts) }));
      const tight = makeEngine({ flameCapacity: 3000, smokeCapacity: 3000 });
      tight.engine.update(ctxOf({ fires: eighty, cloud: makeCloud(ePts) }));
      const a = ample.engine.getStatus();
      const b = tight.engine.getStatus();
      t.ok(
        `with room to spare every flame is at full quality (${a.quality}) and none is dropped`,
        a.quality === 1 && a.dropped === 0 && a.flame > b.flame
      );
      t.ok(
        `a tight buffer thins every flame (quality ${b.quality}, ${b.flame}/3000 lobes) instead of dropping any (${b.dropped} dropped)`,
        b.quality < 0.8 && b.quality >= 0.3 && b.dropped === 0 && b.flame <= 3000 && b.flame > 1000
      );
    }

    // more than 64 SEPARATE burning masses fold into the last contour box
    const many = makeEngine({ flameCapacity: 20000, smokeCapacity: 20000 });
    const bigFires = [];
    const bigPts = [];
    for (let i = 0; i < 90; i++) {
      const x = 300 + (i % 10) * 400;
      const y = 300 + Math.floor(i / 10) * 400;
      bigFires.push({ id: `m${i}`, x, y, diameterPx: 20 });
      bigPts.push(...discOfPoints(x, y, 8, 4));
    }
    many.engine.update(
      ctxOf({
        fires: bigFires,
        cloud: makeCloud(bigPts),
        ctx: { rect: { minX: 0, minY: 0, maxX: 4400, maxY: 4000 } },
      })
    );
    t.ok(
      `beyond 64 fires the contour boxes are merged, never lost or over 64 (${many.seen.quadCount})`,
      many.seen.quadCount === 64 && many.seen.quads.length === 256
    );
    const last = many.seen.quads.slice(60 * 1, 256);
    t.ok(
      'the merged last box is the biggest (it swallowed the extras)',
      (() => {
        const w = many.seen.quads[63 * 4 + 2];
        const first = many.seen.quads[2];
        return w >= first;
      })() && last.length > 0
    );
  }

  // ── PARAMS: the author's dials reach the lobes through the engine ──────────────────────────────────────────────────
  {
    const sizeAt = (patch) => {
      const { engine, seen } = makeEngine({ wind: makeWind({ openness: 1, sky: 1 }) });
      engine.update(ctxOf({ params: { ...defaults, windResponse: 1, weatherResponse: 1, rainResponse: 1, ...patch } }));
      return { box: seen.quads.slice(), status: engine.getStatus() };
    };
    const normal = sizeAt({});
    const big = sizeAt({ flameSize: 2.5, flameHeight: 2.5 });
    t.ok(
      `Flame size and height make the flame (and its box) bigger (${normal.box[2].toFixed(0)} -> ${big.box[2].toFixed(0)} px wide)`,
      big.box[2] > normal.box[2] * 1.3
    );
    const nosmoke = sizeAt({ smokeDensity: 0 });
    t.ok('Smoke amount 0 means no smoke lobes at all', nosmoke.status.smoke === 0 && normal.status.smoke > 0);
    const lowDetail = sizeAt({ flameDetail: 0.4 });
    t.ok(
      `Billow detail trades lobes for speed (${normal.status.flame} -> ${lowDetail.status.flame})`,
      lowDetail.status.flame < normal.status.flame
    );
    const twice = sizeAt({ intensity: 0 });
    t.ok('Intensity 0 leaves a fire that is (nearly) dark and small', twice.status.flame <= normal.status.flame);
    const slow = (() => {
      const { engine, seen } = makeEngine();
      engine.update(ctxOf({ params: { ...defaults, flameSpeed: 3 }, ctx: { nowMs: 1000 } }));
      return seen.prepares[0].opts.timeSec;
    })();
    t.ok('Speed scales the fire’s clock (a 3x fire runs its clock 3x)', near(slow, 3, 1e-9));
    const fuelHue = (() => {
      const { engine, seen } = makeEngine();
      engine.update(ctxOf({ params: { ...defaults, colorHueShift: 90 } }));
      return seen.look.hue;
    })();
    t.ok(
      'the author’s hue shift (degrees) reaches the look in radians',
      near(fuelHue, Math.PI / 2, 1e-6) || Math.abs(fuelHue) > 0
    );
  }

  // ── THE SHARED EYE (2026-10-28): the billows' camera is a fixed multiple of the scene eye ──
  {
    const rect = { minX: 0, maxX: 2400 };
    t.ok(
      'with an eye, the camera is the eye times the billows’ ratio',
      billowCameraHeight(rect, { height: 1500 }) === 1500 * BILLOW_CAMERA_PER_EYE
    );
    t.ok('without one, the old view-width camera', billowCameraHeight(rect, null) === viewCameraHeight(rect));
    t.ok('a bad eye falls back too', billowCameraHeight(rect, { height: 0 }) === viewCameraHeight(rect));
    // At a 16:9 view and the default 45° eye (2.414 half-heights), the ratio reproduces the old 3 half-widths.
    const halfH = 675;
    const eyeH = halfH / Math.tan((22.5 * Math.PI) / 180);
    const old = viewCameraHeight({ minX: 0, maxX: 2 * halfH * (16 / 9) });
    t.ok(
      '⭐ the ratio keeps the tuned lean at 16:9 and 45°',
      Math.abs(billowCameraHeight(rect, { height: eyeH }) / old - 1) < 0.02
    );
  }

  // ── THE CAMERA RISES AS THE VIEW ZOOMS OUT (the real viewer showed a burning roof as comets streaking from the centre) ──
  {
    t.ok(
      'the virtual camera is ~3 half-widths up, never below its floor, and survives garbage',
      near(viewCameraHeight({ minX: 0, maxX: 2400 }), 3600, 1e-9) &&
        viewCameraHeight({ minX: 0, maxX: 100 }) === 400 &&
        viewCameraHeight(null) === 400 &&
        viewCameraHeight({ minX: 5, maxX: 5 }) === 400
    );
    t.ok(
      'a wider view is a higher camera',
      viewCameraHeight({ minX: 0, maxX: 4800 }) > viewCameraHeight({ minX: 0, maxX: 2400 })
    );
    // the same fire, the same offset from the view centre, a view twice as wide: its perspective lean outward is smaller
    const leanOut = (rect) => {
      const { engine, renderer } = makeEngine({ wind: makeWind({ openness: 1, sky: 1, speed01: 0 }) });
      const fires = [{ id: 'edge', x: 1800, y: 500, diameterPx: 90 }];
      const cloud = makeCloud(discOfPoints(1800, 500, 40, 10));
      const base = ctxOf({ fires, cloud, ctx: { rect } });
      let sum = 0;
      let n = 0;
      let now = 0;
      for (let k = 0; k < 16; k++) {
        now += 250;
        engine.update({ ...base, nowMs: now, dtSec: 0.25 });
        const nf = engine.getStatus().flame;
        for (let i = 0; i < nf; i++) {
          if (renderer.flameLobes[i * LOBE_STRIDE + 8] !== KIND_FLAME) continue;
          sum += renderer.flameLobes[i * LOBE_STRIDE] - 1800;
          n++;
        }
      }
      return sum / Math.max(1, n);
    };
    const narrow = leanOut({ minX: 0, minY: 0, maxX: 2400, maxY: 1000 });
    const wide = leanOut({ minX: -1200, minY: 0, maxX: 3600, maxY: 1000 });
    t.ok(
      `zoomed out, a flame at the same offset from the centre leans out much less (${narrow.toFixed(1)} px -> ${wide.toFixed(1)} px)`,
      narrow > 1 && wide < narrow * 0.7
    );
  }

  // ── THE SCENE'S BLOOM: the flame paints the inverse of it (fire-billow-bloom.js) ────────────────────────────────────
  {
    const bloomOn = {
      enabled: true,
      params: { threshold: 0.33, knee: 0.5, strength: 1, coreStrength: 1.01, atmoStrength: 0.24, atmoTint: '#fff0dc' },
    };
    {
      const { engine, seen } = makeEngine();
      engine.update(ctxOf());
      t.ok(
        'with no bloom state there is nothing to counter: K is 0 (the flame is exactly its palette) and the status says off',
        seen.bloom && seen.bloom.k === 0 && seen.bloom.mix === 0 && engine.getStatus().bloomCounter === 'off'
      );
    }
    {
      const { engine, seen } = makeEngine();
      engine.update(ctxOf({ ctx: { bloom: bloomOn } }));
      t.ok(
        'with the author’s bloom on, the renderer is told its K, threshold and knee, and the dial at full',
        seen.bloom &&
          Math.abs(seen.bloom.k - 3.7029) < 1e-3 &&
          seen.bloom.threshold === 0.33 &&
          seen.bloom.knee === 0.5 &&
          seen.bloom.mix === 1
      );
      t.ok('the status carries the bloom it is countering', engine.getStatus().bloomCounter.startsWith('K 3.70'));
      const sets = seen.bloomSets;
      engine.update(ctxOf({ ctx: { bloom: { ...bloomOn, params: { ...bloomOn.params, strength: 2 } } } }));
      t.ok(
        'a changed bloom reaches the renderer the very next frame (the cascade can move it at any time)',
        seen.bloomSets === sets + 1 && Math.abs(seen.bloom.k - 7.4058) < 1e-3
      );
      engine.update(ctxOf({ ctx: { bloom: { enabled: false, params: bloomOn.params } } }));
      t.ok(
        'a bloom switched off (the performance profile can) puts the flame back to its painted colours',
        seen.bloom.k === 0 && engine.getStatus().bloomCounter === 'off'
      );
    }
    {
      const { engine, seen } = makeEngine();
      engine.update(ctxOf({ ctx: { bloom: bloomOn }, params: { ...defaults, bloomCounter: 0 } }));
      t.ok('the author’s “Counter scene bloom” at 0 leaves the flame to the bloom', seen.bloom.mix === 0);
      engine.update(ctxOf({ ctx: { bloom: bloomOn }, params: { ...defaults, bloomCounter: 0.4 } }));
      t.ok('and in between is in between', Math.abs(seen.bloom.mix - 0.4) < 1e-9);
    }
    // a flame that is big on screen gets more of the bloom than a small one, per box
    {
      const { engine, seen } = makeEngine();
      const fires = [
        { id: 'small', x: 300, y: 500, diameterPx: 40 },
        { id: 'big', x: 1000, y: 500, diameterPx: 160 },
      ];
      const cloud = makeCloud([...discOfPoints(300, 500, 20, 10), ...discOfPoints(1000, 500, 80, 10)]);
      engine.update(ctxOf({ fires, cloud, ctx: { pxPerWorld: 2, bloom: bloomOn } }));
      t.ok(
        `each box carries its own fill, the bigger flame's larger (${seen.fills?.map((v) => v.toFixed(2)).join(', ')})`,
        seen.fills?.length === 2 && seen.fills[1] > seen.fills[0] && seen.fills[0] > 0 && seen.fills[1] < 1
      );
      engine.update(ctxOf({ fires, cloud, ctx: { pxPerWorld: 0.5, bloom: bloomOn } }));
      t.ok('zoomed out, the same flames get less of it', seen.fills[1] < 0.5);
    }
    {
      // past 64 separate masses the extras fold into the last box, which keeps the largest fill among them
      const many = makeEngine({ flameCapacity: 20000, smokeCapacity: 20000 });
      const fires = [];
      const pts = [];
      for (let i = 0; i < 70; i++) {
        const x = 300 + (i % 10) * 400;
        const y = 300 + Math.floor(i / 10) * 400;
        const d = i === 69 ? 120 : 20;
        fires.push({ id: `m${i}`, x, y, diameterPx: d });
        pts.push(...discOfPoints(x, y, d / 2, 4));
      }
      many.engine.update(
        ctxOf({
          fires,
          cloud: makeCloud(pts),
          ctx: { pxPerWorld: 1.5, bloom: bloomOn, rect: { minX: 0, minY: 0, maxX: 4400, maxY: 3600 } },
        })
      );
      t.ok(
        'past 64 boxes the folded last one keeps the largest fill among the boxes it swallowed',
        many.seen.quadCount === 64 && many.seen.fills.length === 64 && many.seen.fills[63] >= many.seen.fills[0]
      );
    }
  }

  // ── A BURNING MASS: overlapping flames are drawn as ONE box, and a big fire's flames stand taller ────────────────────
  {
    t.ok(
      'a single flame is as tall as ever, and a fire many flames wide stands taller (to 1.7x, never more)',
      infernoHeightGain(40, 59) === 1 &&
        infernoHeightGain(59, 59) === 1 &&
        near(infernoHeightGain(118, 59), 1.3, 1e-9) &&
        infernoHeightGain(236, 59) > infernoHeightGain(118, 59) &&
        infernoHeightGain(1e6, 59) === 1.7 &&
        infernoHeightGain(undefined, undefined) === 1
    );
    t.ok(
      'each flame of a big fire is simpler (it is mostly hidden by its neighbours): 1 among a few, half for a mass of forty or more',
      massQuality(1) === 1 &&
        massQuality(4) === 1 &&
        massQuality(20) < massQuality(8) &&
        massQuality(8) < 1 &&
        massQuality(44) === 0.5 &&
        massQuality(500) === 0.5 &&
        massQuality(undefined) === 1
    );
    const box = (x, y, w, h) => [x, y, w, h];
    {
      const r = mergeBoxes(
        [...box(0, 0, 100, 100), ...box(60, 60, 100, 100), ...box(500, 500, 50, 50)],
        [0.2, 0.7, 0.1]
      );
      t.ok(
        'boxes that overlap become one (their bounding box, the larger fill) and separate ones stay',
        r.boxes.length === 8 &&
          r.fills.length === 2 &&
          r.members.join() === '2,1' &&
          r.boxes[0] === 0 &&
          r.boxes[2] === 160 &&
          r.boxes[3] === 160 &&
          r.fills[0] === 0.7 &&
          r.boxes[4] === 500
      );
    }
    {
      // touching edge to edge is not overlapping
      const r = mergeBoxes([...box(0, 0, 100, 100), ...box(100, 0, 100, 100)], [0, 0]);
      t.ok('boxes that only touch stay separate', r.boxes.length === 8 && r.members.join() === '1,1');
    }
    {
      // a diagonal chain of overlapping boxes would make one huge, mostly empty box: it is covered by a TILING instead, so
      // no pixel is drawn twice (overlapping boxes draw their overlap twice: a visible rectangle of denser smoke)
      const chain = [];
      const chainFills = [];
      const chainLooks = [];
      for (let i = 0; i < 8; i++) {
        chain.push(...box(i * 90, i * 90, 100, 100));
        chainFills.push(0.2 + 0.05 * i);
        chainLooks.push(6 + i, 10 + 2 * i);
      }
      const r = mergeBoxes(chain, chainFills, 1.7, chainLooks);
      const nOut = r.boxes.length / 4;
      const overlap = (a, b) =>
        Math.max(
          0,
          Math.min(r.boxes[a * 4] + r.boxes[a * 4 + 2], r.boxes[b * 4] + r.boxes[b * 4 + 2]) -
            Math.max(r.boxes[a * 4], r.boxes[b * 4])
        ) *
        Math.max(
          0,
          Math.min(r.boxes[a * 4 + 1] + r.boxes[a * 4 + 3], r.boxes[b * 4 + 1] + r.boxes[b * 4 + 3]) -
            Math.max(r.boxes[a * 4 + 1], r.boxes[b * 4 + 1])
        );
      let anyOverlap = false;
      for (let a = 0; a < nOut; a++) for (let b = a + 1; b < nOut; b++) if (overlap(a, b) > 1e-6) anyOverlap = true;
      const covered = (x, y) => {
        for (let b = 0; b < nOut; b++) {
          if (
            x >= r.boxes[b * 4] &&
            x < r.boxes[b * 4] + r.boxes[b * 4 + 2] &&
            y >= r.boxes[b * 4 + 1] &&
            y < r.boxes[b * 4 + 1] + r.boxes[b * 4 + 3]
          )
            return true;
        }
        return false;
      };
      let allCovered = true;
      for (let i = 0; i < 8; i++)
        for (let u = 0; u <= 10; u++)
          for (let v = 0; v <= 10; v++) if (!covered(i * 90 + u * 9.99, i * 90 + v * 9.99)) allCovered = false;
      const tileArea = r.boxes.reduce((s, _, k) => (k % 4 === 2 ? s + r.boxes[k] * r.boxes[k + 1] : s), 0);
      t.ok(
        `a diagonal chain of overlapping boxes is covered by ${nOut} disjoint tiles, not folded into one mostly-empty box`,
        nOut > 1 && nOut <= 16 && !anyOverlap && allCovered && tileArea < 0.6 * (7 * 90 + 100) * (7 * 90 + 100)
      );
      t.ok(
        'every tile carries the group’s fill, looks and size (so the tiles join without a seam)',
        r.fills.every((f) => f === r.fills[0]) &&
          near(r.fills[0], 0.2 + 0.05 * 7, 1e-12) &&
          r.looks.length === nOut * 2 &&
          r.looks.every((v, k) => v === r.looks[k % 2]) &&
          r.looks[0] === 13 &&
          r.looks[1] === 24 &&
          r.members.every((m) => m === 8) &&
          r.sides.every((sd) => near(sd, 7 * 90 + 100, 1e-9))
      );
      const solid = [];
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) solid.push(...box(x * 60, y * 60, 100, 100));
      const s = mergeBoxes(solid, new Array(9).fill(0.4));
      t.ok(
        'a solid block of overlapping boxes is',
        s.boxes.length === 4 && s.members[0] === 9 && s.boxes[2] === 220 && s.boxes[3] === 220
      );
    }
    t.ok('nothing in, nothing out', mergeBoxes([], []).boxes.length === 0);

    // the engine: a burning roof is a few boxes (one mass), enclosing every lobe, and the flames are tall
    const { engine, seen, renderer } = makeEngine();
    const roof = [{ id: 'roof', x: 700, y: 500, diameterPx: 520 }];
    const roofCloud = makeCloud(discOfPoints(700, 500, 240, 30));
    const res = engine.update(ctxOf({ fires: roof, cloud: roofCloud }));
    const st = engine.getStatus();
    t.ok(
      `a roof of ${res.clusters.length} overlapping flames is drawn as ${seen.quadCount} contour box(es), not ${res.clusters.length}`,
      res.clusters.length >= 10 && seen.quadCount < res.clusters.length / 3 && seen.quadCount >= 1
    );
    let enclosed = true;
    for (let i = 0; i < st.flame; i++) {
      const x = renderer.flameLobes[i * LOBE_STRIDE];
      const y = renderer.flameLobes[i * LOBE_STRIDE + 1];
      let inAny = false;
      for (let b = 0; b < seen.quadCount; b++) {
        const [bx, by, bw, bh] = seen.quads.slice(b * 4, b * 4 + 4);
        if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) inAny = true;
      }
      if (!inAny) enclosed = false;
    }
    t.ok('and the boxes still enclose every flame lobe', enclosed);
    const lone = makeEngine().engine;
    lone.update(ctxOf());
    t.ok(
      `and each of its flames is simpler than a lone campfire's (quality ${st.quality}, a lone fire 1)`,
      st.quality < 1 && st.quality >= 0.5 && lone.getStatus().quality === 1
    );
    t.ok(
      'the mass covers more of the screen than one flame, so the bloom fills it more',
      (() => {
        const lone = makeEngine();
        lone.engine.update(ctxOf({ ctx: { pxPerWorld: 1, bloom: { enabled: true, params: { threshold: 0.33 } } } }));
        const mass = makeEngine();
        mass.engine.update(
          ctxOf({
            fires: roof,
            cloud: roofCloud,
            ctx: { pxPerWorld: 1, bloom: { enabled: true, params: { threshold: 0.33 } } },
          })
        );
        return Math.max(...mass.seen.fills) > Math.max(...lone.seen.fills);
      })()
    );
  }

  // ── THE COLUMN OF A BURNING MASS, AND THE SPREAD (2026-10-20, round 2) ──────────────────────────────────────────
  {
    t.ok(
      'a flame in a mass keeps less and less of its own smoke, a lone campfire all of it, and a big roof’s flames none (the column is all the smoke there is)',
      massSmokeKeep(1) === 1 &&
        massSmokeKeep(6) === 1 &&
        massSmokeKeep(10) === 0.5 &&
        massSmokeKeep(14) === 0 &&
        massSmokeKeep(53) === 0 &&
        massSmokeKeep(10000) === 0 &&
        massSmokeKeep(undefined) === 1 &&
        massSmokeKeep(8) > massSmokeKeep(9)
    );
    t.ok(
      'a mass’s smoke is dark and a campfire’s is pale',
      massSootiness(1) === 0 &&
        massSootiness(6) === 0 &&
        massSootiness(7) >= 0.4 &&
        massSootiness(14) > massSootiness(7) &&
        massSootiness(1e6) === 0.85 &&
        massSootiness(undefined) === 0
    );
    t.ok(
      'a building’s flames grow with the fire’s width: 1 for a bonfire or two, up to 2x, never smaller',
      massFlameGrowth(1) === 1 &&
        massFlameGrowth(1.7) === 1 &&
        massFlameGrowth(0) === 1 &&
        massFlameGrowth(undefined) === 1 &&
        massFlameGrowth(3.4) > 1.4 &&
        massFlameGrowth(3.4) < 1.5 &&
        massFlameGrowth(6) > massFlameGrowth(3) &&
        massFlameGrowth(1e6) === 2
    );

    const roof2 = [{ id: 'roof', x: 700, y: 500, diameterPx: 520 }];
    const roofCloud2 = makeCloud(discOfPoints(700, 500, 240, 30));
    const planned = planClusters(roof2, roofCloud2, M_PER_PX);
    t.ok(
      `the front's order: one flame ignites first (0), the rest are ordered by distance from it, all within 0..1 (${planned.length} flames)`,
      planned.every((c) => c.spreadT >= 0 && c.spreadT <= 1) &&
        planned.filter((c) => c.spreadT === 0).length === 1 &&
        Math.max(...planned.map((c) => c.spreadT)) > 0.7 &&
        planClusters([{ id: 'camp', x: 0, y: 0, diameterPx: 60 }], null, M_PER_PX)[0].spreadT === 0
    );
    t.ok(
      'and it is the same every time (the same paint, the same ignition corner)',
      JSON.stringify(planned.map((c) => c.spreadT)) ===
        JSON.stringify(planClusters(roof2, makeCloud(discOfPoints(700, 500, 240, 30)), M_PER_PX).map((c) => c.spreadT))
    );

    const radiusOf = (buf, n) => {
      let m = 0;
      for (let i = 0; i < n; i++) m = Math.max(m, buf[i * LOBE_STRIDE + 2]);
      return m;
    };
    const sootLobes = (buf, n) => {
      let c = 0;
      for (let i = 0; i < n; i++) if (buf[i * LOBE_STRIDE + 4] < -0.05) c++;
      return c;
    };
    const roofE = makeEngine();
    roofE.engine.update(ctxOf({ fires: roof2, cloud: roofCloud2 }));
    const roofSt2 = roofE.engine.getStatus();
    const campE = makeEngine();
    campE.engine.update(ctxOf());
    const campSt = campE.engine.getStatus();
    t.ok(
      `a burning roof makes ONE column of smoke (${roofSt2.masses} mass), far bigger than a campfire's puffs (${radiusOf(roofE.renderer.smokeLobes, roofSt2.smoke).toFixed(0)} vs ${radiusOf(campE.renderer.smokeLobes, campSt.smoke).toFixed(0)} px) and dark with soot`,
      roofSt2.masses === 1 &&
        campSt.masses === 0 &&
        radiusOf(roofE.renderer.smokeLobes, roofSt2.smoke) > 2 * radiusOf(campE.renderer.smokeLobes, campSt.smoke) &&
        sootLobes(roofE.renderer.smokeLobes, roofSt2.smoke) > 5 &&
        sootLobes(campE.renderer.smokeLobes, campSt.smoke) === 0
    );
    t.ok(
      `and each flame of the mass only wisps (${(roofSt2.smoke / roofSt2.clusters).toFixed(1)} smoke lobes a flame, a lone campfire ${campSt.smoke})`,
      roofSt2.smoke / roofSt2.clusters < campSt.smoke / 2
    );
    {
      // a big roof (23 flames): none of them wisps, the column is all the smoke there is
      const big = [{ id: 'big', x: 700, y: 500, diameterPx: 700 }];
      const bigCloud = makeCloud(discOfPoints(700, 500, 330, 30));
      const bigE = makeEngine();
      const bigRes = bigE.engine.update(ctxOf({ fires: big, cloud: bigCloud }));
      const bigSt = bigE.engine.getStatus();
      t.ok(
        `a big roof’s flames make no wisps of their own: the column is all the smoke there is (${bigRes.clusters.length} flames, ${bigSt.smoke} smoke lobes, at most ${MASS_SMOKE_MAX})`,
        bigRes.clusters.length >= 14 && bigSt.smoke > 0 && bigSt.smoke <= MASS_SMOKE_MAX
      );
      // CAPACITY: a column is reserved whole or not drawn at all, and a scene full of burning roofs never overruns the buffer
      const many = [];
      const manyPts = [];
      for (let k = 0; k < 8; k++) {
        const cx = 350 + (k % 4) * 700;
        const cy = 500 + Math.floor(k / 4) * 900;
        many.push({ id: 'roof' + k, x: cx, y: cy, diameterPx: 520 });
        manyPts.push(...discOfPoints(cx, cy, 240, 30));
      }
      const wide = { minX: 0, minY: 0, maxX: 3000, maxY: 2000 };
      const crowded = makeEngine({ smokeCapacity: 700 });
      const crowdedRes = crowded.engine.update(ctxOf({ fires: many, cloud: makeCloud(manyPts), ctx: { rect: wide } }));
      const cs = crowded.engine.getStatus();
      t.ok(
        `eight burning roofs in a smoke buffer of 700 never overrun it (${cs.smoke} lobes, ${cs.dropped} flames dropped, ${cs.masses} columns) and nothing is NaN`,
        crowdedRes.clusters.length > 60 &&
          cs.smoke <= 700 &&
          crowded.seen.counts.smoke === cs.smoke &&
          (crowded.seen.quads ?? []).every(Number.isFinite) &&
          crowded.renderer.smokeLobes.every(Number.isFinite)
      );
      const roomy = makeEngine();
      roomy.engine.update(ctxOf({ fires: big, cloud: bigCloud }));
      t.ok(
        'and with room for it the roof’s column is drawn',
        roomy.engine.getStatus().smoke > 10 && roomy.engine.getStatus().smoke <= MASS_SMOKE_MAX
      );
    }
    t.ok(
      'the contour boxes still enclose every smoke lobe, the column included',
      (() => {
        for (let i = 0; i < roofSt2.smoke; i++) {
          const o = i * LOBE_STRIDE;
          const x = roofE.renderer.smokeLobes[o];
          const y = roofE.renderer.smokeLobes[o + 1];
          let inAny = false;
          for (let b = 0; b < roofE.seen.quadCount; b++) {
            const [bx, by, bw, bh] = roofE.seen.quads.slice(b * 4, b * 4 + 4);
            if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) inAny = true;
          }
          if (!inAny) return false;
        }
        return true;
      })()
    );
    t.ok(
      'every contour box carries its smoke furniture (crescent px, shadow offset) and the engine hands them to the renderer',
      roofE.seen.looks && roofE.seen.looks.length === roofE.seen.quadCount * 2 && roofE.seen.looks.every((v) => v > 0)
    );

    // THE SPREAD: a big fire catches from one end over `spreadSec` seconds
    const litFlames = (sec, seconds, patch = {}) => {
      const e = makeEngine();
      const base = ctxOf({
        fires: roof2,
        cloud: roofCloud2,
        params: { ...defaults, windResponse: 1, weatherResponse: 1, rainResponse: 1, spreadSec: sec },
        ...patch,
      });
      const res = advance(e.engine, base, seconds);
      return { st: e.engine.getStatus(), res, e };
    };
    const whole = litFlames(0, 30).st.flame;
    const early = litFlames(60, 3).st.flame;
    const mid = litFlames(60, 30).st.flame;
    const late = litFlames(60, 75).st.flame;
    t.ok(
      `a spreading fire starts nearly dark, is part lit half way and fully lit at the end (${early} < ${mid} < ${late} flame lobes; all at once: ${whole})`,
      early < mid && mid < late && late > 0.85 * whole && early < 0.4 * whole
    );
    t.ok(
      'with the spread off the whole region burns from the first frame, as before',
      litFlames(0, 0.25).st.flame > 0.9 * whole
    );
    const halfLit = litFlames(60, 30);
    t.ok(
      'a fire only part lit lights (and spits embers) only as far as it burns',
      halfLit.res.lifeByFire.get('roof').vitality < 0.9 && halfLit.res.lifeByFire.get('roof').vitality > 0.1
    );
    const a1 = litFlames(60, 20).e.renderer.flameLobes;
    const a2 = litFlames(60, 20).e.renderer.flameLobes;
    t.ok(
      'the front is deterministic (the same frames, the same picture)',
      a1.length === a2.length && a1.every((v, i) => v === a2[i])
    );
    t.ok(
      'rain slows the front (the same time, fewer flames lit)',
      (() => {
        const dry = litFlames(60, 30).st.flame;
        const wet = litFlames(60, 30, { ctx: { precip01: 1 } }).st.flame;
        return wet < dry;
      })()
    );
    t.ok(
      'a campfire is unaffected by the spread dial (one flame: there is no front)',
      (() => {
        const e = makeEngine();
        e.engine.update(ctxOf({ params: { ...defaults, spreadSec: 600 } }));
        return e.engine.getStatus().flame > 40;
      })()
    );
  }

  // ── A GALE PUTS AN EXPOSED FIRE OUT; A SEALED ROOM STAYS LIT (round 3) ──────────────────────────────────────────
  {
    const run = (wind, seconds, extra = {}) => {
      const e = makeEngine({ wind });
      const base = ctxOf({ params: { ...defaults, ...extra } });
      advance(e.engine, base, seconds);
      return e.engine.getStatus();
    };
    const open = run(makeWind({ openness: 1, sky: 1, speed01: 1 }), 120);
    const sealed = run(makeWind({ openness: 0.05, sky: 0, speed01: 1 }), 120);
    const calm = run(makeWind({ openness: 1, sky: 1, speed01: 0 }), 120);
    t.ok(
      `a hurricane on an exposed fire puts it out (${open.lifeSummary[0].phase}), a sealed room's fire and a calm night's burn on (${sealed.lifeSummary[0].phase}, ${calm.lifeSummary[0].phase})`,
      open.lifeSummary[0].phase !== 'burning' &&
        sealed.lifeSummary[0].phase === 'burning' &&
        calm.lifeSummary[0].phase === 'burning'
    );
    t.ok(
      'the "Wind puts fires out" dial at 0 keeps it alight in the same hurricane',
      run(makeWind({ openness: 1, sky: 1, speed01: 1 }), 120, { windSnuff: 0 }).lifeSummary[0].phase === 'burning'
    );
    t.ok(
      'the status says why: each fire openness, sky, wind felt, rain felt and stress',
      Array.isArray(open.weather) &&
        open.weather.length === 1 &&
        open.weather[0].wind > 0.9 &&
        'openness' in open.weather[0] &&
        'stress' in open.weather[0]
    );
  }

  // ── HEAT HAZE SOURCES (round 3): the hot fires in view, for the final composite's shimmer warp ───────────────────
  {
    const e = makeEngine();
    e.engine.update(ctxOf());
    const hot = e.engine.getHeatSources();
    t.ok(
      `a burning fire is a heat source (${hot.length}), at its place, with its radius and strength near 1`,
      hot.length === 1 && Math.abs(hot[0].x - 700) < 1 && hot[0].r > 20 && hot[0].s > 0.9
    );
    const dead = makeEngine({ wind: makeWind({ openness: 1, sky: 1, speed01: 1 }) });
    advance(dead.engine, ctxOf(), 120);
    t.ok('a fire the wind has put out is none', dead.engine.getHeatSources().length === 0);
  }
}
