/**
 * Node verification for Leaf Shed — the declaration (effects/leaf-shed.js), the birth record
 * (leaf-shed-birth.js), the canopy emitters and birth plan (leaf-shed-sources.js) and the
 * subsystem's decisions (leaf-shed-subsystem.js, with a stub engine). The kernel and the leaf
 * material are GPU code, judged in tools/shader-lab/leaf-shed-lab.html over the author's art.
 */
import { LEAF_SHED, LEAF_SHED_PARAMS, leafShedCapacity, resolveLeafShedParams } from '../leaf-shed.js';
import {
  BIRTH_FLOATS_PER_SLOT,
  STAMP_WRAP,
  createBirthRing,
  packBirthTag,
  unpackBirthTag,
  writeBirth,
} from '../leaf-shed-birth.js';
import {
  DEFAULT_TWIG_SRGB,
  SHED_KIND,
  buildCanopyEmitters,
  emitterProposalRate,
  placeEmitters,
  planShedBirths,
  rampBetween,
} from '../leaf-shed-sources.js';
import { createLeafShedSubsystem } from '../leaf-shed-subsystem.js';
import { readFileSync } from 'node:fs';
import { validateEffectManifest } from '../effect-manifest.js';
import { validateParamsSchema } from '../../core/params-schema.js';
import { speed01ForMetresPerSecond } from '../../world/index.js';

/** A seeded RNG, so a plan is the same plan twice. */
function rng(seed = 1) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A synthetic canopy file, w×h: blobs of fill colour with a dark outline ring (the art's ink at
 * 0.3× the fill) and, optionally, a brown branch patch in the middle.
 */
function raster(w, h, blobs) {
  const rgba = new Uint8Array(w * h * 4);
  for (const b of blobs) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - b.cx, y + 0.5 - b.cy);
        if (d > b.r) continue;
        const i = (y * w + x) * 4;
        const ink = d > b.r - 1.2;
        const branch = b.branch && d < b.r * 0.25;
        const c = branch ? [106, 84, 78] : ink ? b.fill.map((v) => Math.round(v * 0.3)) : b.fill;
        rgba[i] = c[0];
        rgba[i + 1] = c[1];
        rgba[i + 2] = c[2];
        rgba[i + 3] = 255;
      }
  }
  return { spec: { x: 0, y: 0, w, h, texelW: 10, texelH: 10 }, rgba };
}

const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

export function run(t) {
  const { ok } = t;

  // ── the declaration ────────────────────────────────────────────────────
  {
    const r = validateEffectManifest(LEAF_SHED);
    ok(`leaf shed: manifest validates (${r.errors.join('; ')})`, r.ok === true);
  }
  ok('leaf shed: params schema validates', validateParamsSchema(LEAF_SHED_PARAMS).ok === true);
  ok('leaf shed: on from the low profile (a calm costs nothing)', LEAF_SHED.enabledFromProfile === 'low');
  ok(
    '⭐ "high velocity winds" — nothing sheds below a strong breeze by default',
    LEAF_SHED_PARAMS.startsAboveMps.default >= 10
  );
  {
    const order = ['low', 'performance', 'standard', 'quality', 'extreme'];
    const caps = order.map(leafShedCapacity);
    ok(
      'leaf shed: capacity never falls as the profile rises',
      caps.every((n, i) => i === 0 || n >= caps[i - 1])
    );
    ok('leaf shed: an unknown profile reads as standard', leafShedCapacity('bogus') === leafShedCapacity('standard'));
  }
  {
    const p = resolveLeafShedParams({ amount: 'x', startsAboveMps: 30, fullAtMps: 12, leafSize: 99 });
    ok('resolve: garbage falls back to the default', p.amount === LEAF_SHED_PARAMS.amount.default);
    ok('resolve: out-of-range clamps to the schema', p.leafSize === LEAF_SHED_PARAMS.leafSize.max);
    ok('resolve: "full" is never below "starts"', p.fullAtMps > p.startsAboveMps);
  }

  // ── the 2026-10-31 polish: the brush outline, turbulence, ground friction, the outdoors mask ──────────
  {
    const d = LEAF_SHED_PARAMS.turbulence;
    ok('turbulence: a motion dial exists, on by default, and can be turned off', d && d.default >= 1 && d.min === 0);
    ok('resolve: turbulence clamps to the schema', resolveLeafShedParams({ turbulence: 99 }).turbulence === d.max);
    const here = new URL('.', import.meta.url);
    const shape = readFileSync(new URL('../leaf-shed-shape.js', here), 'utf8');
    const runtime = readFileSync(new URL('../particles/leaf-shed-runtime.js', here), 'utf8');
    // The author, looking at her rock-and-vegetation art: "a noisy high contrast black outline".
    const ink = /const black = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)/.exec(shape);
    ok('⭐ outline: the ink is black (every channel under 0.05), not the fill darkened', !!ink && ink.slice(1).every((x) => Number(x) < 0.05));
    ok('⭐ outline: the edge is wobbled by the brush noise on both of its boundaries', /d0\.add\(outerWobble\)/.test(shape) && /d0\.add\(innerWobble\)/.test(shape));
    ok('shape: every body takes the leaf dice (no two leaves alike)', /leafDistance\(TSL, u\.mul\(1\.1\), v\.mul\(1\.1\), rnd\)/.test(shape) && /clumpDistance\(TSL, u, v, rnd\)/.test(shape));
    ok('⭐ twigs: outlined in dark brown, not black (the tree line is brown)', /const brown = vec3/.test(shape) && /select\(isTwig, brown, black\)/.test(shape));
    // The author, 2026-10-31: twigs "need about four more designs … more than one design".
    ok('⭐ twigs: at least five designs, picked by the leaf dice', /TWIG_DESIGNS = (\d+)/.test(shape) && Number(/TWIG_DESIGNS = (\d+)/.exec(shape)[1]) >= 5 && /design = floor\(reroll/.test(shape));
    const tbl = (name) => {
      const m = new RegExp(String.raw`const ${name} = \[([^\]]+)\]`).exec(runtime);
      return m ? m[1].split(',').map(Number) : null;
    };
    const keep = tbl('KIND_GROUND_KEEP');
    const tau = tbl('KIND_GROUND_TAU_SEC');
    const mob = tbl('KIND_GROUND_MOBILITY');
    const stick = tbl('KIND_GROUND_STICK_MPS');
    ok('⭐ ground: a twig is grippier than a clump, a clump than a leaf (keeps less, stops sooner, moves less, needs a harder gust)',
      !!(keep && tau && mob && stick) &&
        keep[2] < keep[1] && keep[1] < keep[0] && tau[2] < tau[1] && tau[1] < tau[0] &&
        mob[2] < mob[1] && mob[1] < mob[0] && stick[2] > stick[1] && stick[1] > stick[0]);
    ok('⭐ ground: a twig stops at the moment it lands (keeps under 5% of its flight speed)', !!keep && keep[2] < 0.05);
    ok('outdoors: the kernel steers round the mask and the draw hides what is inside it',
      /wallSense\(pos, headingRaw/.test(runtime) && /outdoorsGate/.test(runtime) && /outdoorsAt\(pos\)\.greaterThan\(0\.5\)/.test(runtime));
  }

  // ── the birth record ───────────────────────────────────────────────────
  {
    let exact = true;
    for (const kind of [0, 1, 2])
      for (const ramp of [0, 1 / 63, 0.5, 1])
        for (const size of [1, 33, 4095]) {
          const u = unpackBirthTag(packBirthTag(kind, ramp, size));
          if (u.kind !== kind || Math.abs(u.ramp01 - Math.round(ramp * 63) / 63) > 1e-9 || u.sizePx !== size)
            exact = false;
        }
    ok('birth tag: kind/ramp/size round-trip exactly', exact);
    ok('birth tag: the largest tag is an exact float', packBirthTag(2, 1, 4095) < 2 ** 24);
    const u = unpackBirthTag(packBirthTag(7, 3, 99999));
    ok('birth tag: out-of-range inputs clamp', u.kind === 2 && u.ramp01 === 1 && u.sizePx === 4095);
  }
  {
    const backing = new Float32Array(4 * BIRTH_FLOATS_PER_SLOT);
    writeBirth(backing, 2, 77, { x: 10, y: 20, kind: 1, ramp: 1, sizePx: 30, rgb: [255, 0, 51], heightPx: 400 });
    const o = 2 * BIRTH_FLOATS_PER_SLOT;
    ok(
      'birth write: lands in its own slot, colour as 0..1',
      backing[o] === 10 &&
        backing[o + 2] === 77 &&
        backing[o + 4] === 1 &&
        Math.abs(backing[o + 6] - 0.2) < 1e-6 &&
        backing[o + 7] === 400
    );
    ok(
      'birth write: the neighbouring slot is untouched',
      backing.slice(0, o).every((v) => v === 0)
    );
  }
  {
    const ring = createBirthRing(5);
    const a = ring.claim(3);
    const b = ring.claim(4);
    ok('ring: slots run on and wrap', a.slots.join() === '0,1,2' && b.slots.join() === '3,4,0,1');
    ok(
      'ring: a wrapping claim uploads as two runs',
      JSON.stringify(b.runs) ===
        JSON.stringify([
          [3, 2],
          [0, 2],
        ])
    );
    ok('ring: stamps start at 1 (a zeroed buffer births nothing)', a.stamps[0] === 1);
    ok('ring: a reused slot gets a new stamp', b.stamps[2] !== a.stamps[0]);
    ok('ring: a claim larger than the ring is capped', ring.claim(99).slots.length === 5);
    ok('ring: stamps wrap well inside exact floats', STAMP_WRAP < 2 ** 24);
  }

  // ── the canopies ───────────────────────────────────────────────────────
  const green = [82, 112, 62];
  const teal = [55, 83, 71];
  const r1 = raster(40, 20, [
    { cx: 10, cy: 10, r: 8, fill: green, branch: true },
    { cx: 30, cy: 10, r: 6, fill: teal },
  ]);
  const em = buildCanopyEmitters(r1, 'tree');
  ok('canopies: one emitter per painted blob', em.length === 2);
  const [a, b] = em[0].cx < em[1].cx ? em : [em[1], em[0]];
  ok('canopies: centroid in world px (texel 10 px)', Math.abs(a.cx - 100) < 10 && Math.abs(b.cx - 300) < 10);
  ok(
    "⭐ colour match: a blob's fill is its own paint, not the outline-darkened average",
    Math.abs(a.fill[0] - green[0]) <= 2 && Math.abs(a.fill[1] - green[1]) <= 2 && Math.abs(b.fill[1] - teal[1]) <= 2
  );
  {
    // No pool point may come out darker than the fill: the outline is drawn by the shader, as painted.
    let darkest = Infinity;
    for (let p = 0; p < a.poolCount; p++)
      darkest = Math.min(darkest, lum([a.pool[p * 5 + 2], a.pool[p * 5 + 3], a.pool[p * 5 + 4]]));
    ok('colour match: outline texels are lifted to the fill (no black leaves)', darkest >= lum(a.fill) - 1);
  }
  ok(
    'twigs: a tree with brown branches sheds twigs in ITS brown',
    a.twig.every((c, i) => Math.abs(c - DEFAULT_TWIG_SRGB[i]) < 2)
  );
  ok('twigs: a blob with no branches falls back to the measured default', b.twig.join() === DEFAULT_TWIG_SRGB.join());
  ok(
    'canopies: an empty raster is no emitters',
    buildCanopyEmitters({ spec: r1.spec, rgba: new Uint8Array(r1.rgba.length) }, 'tree').length === 0
  );

  {
    // A UV-space emitter placed on a quad rotated 90° and moved: TL→(1000,0), TR→(1000,200), BL→(800,0).
    const uv = buildCanopyEmitters(
      { spec: { x: 0, y: 0, w: 40, h: 20, texelW: 1 / 40, texelH: 1 / 20 }, rgba: r1.rgba },
      'tree'
    );
    const placed = placeEmitters(uv, [
      { x: 1000, y: 0 },
      { x: 1000, y: 200 },
      { x: 800, y: 200 },
      { x: 800, y: 0 },
    ]);
    const left = placed.find((e) => e.cy < 100);
    ok(
      'place: u runs along TL→TR, v along TL→BL (rotation exact)',
      left && Math.abs(left.cx - 900) < 12 && Math.abs(left.cy - 50) < 12
    );
    ok('place: area scales with the quad', Math.abs(left.areaPx2 / uv.find((e) => e.cx < 0.5).areaPx2 - 200 * 200) < 1);
  }

  // ── the plan ───────────────────────────────────────────────────────────
  const P = resolveLeafShedParams({});
  ok('rate: zero below the threshold', emitterProposalRate(a, P.startsAboveMps - 0.5, P, 100) === 0);
  ok('rate: more wind, more leaves', emitterProposalRate(a, 20, P, 100) > emitterProposalRate(a, 14, P, 100));
  ok(
    'rate: bushes follow their own dial',
    emitterProposalRate({ ...a, kind: 'bush' }, 20, { ...P, bushShare: 0 }, 100) === 0
  );
  ok('ramp: 0 at the start, 1 at full', rampBetween(10, 20, 10) === 0 && rampBetween(10, 20, 20) === 1);
  {
    const carry = new Float64Array(em.length);
    let total = 0;
    let twigs = 0;
    let inside = true;
    const random = rng(3);
    for (let f = 0; f < 600; f++) {
      const births = planShedBirths({
        emitters: em,
        carry,
        windMpsAt: () => 30,
        dtSec: 1 / 60,
        params: { ...P, twigShare: 0.3 },
        gridPx: 100,
        viewRect: null,
        maxBirths: 100,
        heightPx: { tree: 750, bush: 60 },
        random,
      });
      total += births.length;
      for (const x of births) {
        if (x.kind === SHED_KIND.twig) twigs++;
        const e = Math.abs(x.x - a.cx) < Math.abs(x.x - b.cx) ? a : b;
        if (x.x < e.minX - 10 || x.x > e.maxX + 10 || x.y < e.minY - 10 || x.y > e.maxY + 10) inside = false;
        if (!(x.heightPx > 0 && x.heightPx < 750)) inside = false;
      }
    }
    ok(`plan: a gale sheds (${total} in 10 s)`, total > 20);
    ok('⭐ "from below the main tree graphic" — every birth is under its canopy, below its crown', inside);
    ok('plan: a tree sheds some twigs', twigs > 0);
  }
  {
    const births = planShedBirths({
      emitters: buildCanopyEmitters(r1, 'bush'),
      carry: new Float64Array(2),
      windMpsAt: () => 40,
      dtSec: 5,
      params: { ...P, twigShare: 0.6, bushShare: 2 },
      gridPx: 100,
      viewRect: null,
      maxBirths: 500,
      heightPx: { tree: 750, bush: 60 },
      random: rng(5),
    });
    ok(
      'plan: bushes shed leaves only, never twigs',
      births.length > 0 && births.every((x) => x.kind === SHED_KIND.leaf)
    );
  }
  {
    const births = planShedBirths({
      emitters: em,
      carry: new Float64Array(2),
      windMpsAt: () => 40,
      dtSec: 5,
      params: P,
      gridPx: 100,
      viewRect: { minX: 50000, minY: 50000, maxX: 51000, maxY: 51000 },
      maxBirths: 500,
      heightPx: { tree: 750, bush: 60 },
      random: rng(6),
    });
    ok('plan: a canopy far off screen sheds nothing', births.length === 0);
    const capped = planShedBirths({
      emitters: em,
      carry: new Float64Array(2),
      windMpsAt: () => 40,
      dtSec: 5,
      params: P,
      gridPx: 100,
      viewRect: null,
      maxBirths: 7,
      heightPx: { tree: 750, bush: 60 },
      random: rng(6),
    });
    ok('plan: never more births than the frame budget', capped.length === 7);
  }

  // ── the subsystem (stub engine) ────────────────────────────────────────
  {
    let windMps = 3;
    let enabled = true;
    let requests = 0;
    const engines = [];
    const sub = createLeafShedSubsystem({
      THREE: {},
      createEngine: (args) => {
        const e = {
          capacity: args.capacity,
          scene: { stub: true },
          births: 0,
          steps: 0,
          setSceneRect() {},
          setLook() {},
          setView() {},
          writeBirths(list) {
            e.births += list.length;
          },
          step() {
            e.steps++;
          },
          updateWind() {},
          debugState: () => ({}),
        };
        engines.push(e);
        return e;
      },
      getRenderState: () => ({ enabled, params: {}, profile: 'low', gridPx: 100, pxPerFt: 20, treeHeightFt: 25 }),
      listCanopies: () => [
        {
          key: 'bg/tree',
          url: 'tree.webp',
          kind: 'tree',
          visible: true,
          corners: [
            { x: 0, y: 0 },
            { x: 400, y: 0 },
            { x: 400, y: 200 },
            { x: 0, y: 200 },
          ],
        },
      ],
      requestColourGrid: () => {
        requests++;
        return { gridW: 40, gridH: 20, rgba: r1.rgba };
      },
      getWindHandle: () => null,
      getWindSpeed01: () => speed01ForMetresPerSecond(windMps),
      random: rng(9),
    });
    const frame = { dtSec: 1 / 60, tMs: 0, viewRect: null, sceneRect: { minX: 0, minY: 0, maxX: 400, maxY: 200 } };
    for (let i = 0; i < 60; i++) sub.sync({}, frame);
    ok(
      'subsystem: a calm decodes nothing and builds no engine',
      requests === 0 && engines.length === 0 && !sub.hasContent
    );
    windMps = 30;
    for (let i = 0; i < 120; i++) sub.sync({}, frame);
    ok('subsystem: a gale asks for the canopy colours once', requests === 1);
    ok(
      'subsystem: a gale builds the engine at the profile capacity',
      engines.length === 1 && engines[0].capacity === leafShedCapacity('low')
    );
    ok('subsystem: and leaves are born and flown', engines[0].births > 0 && engines[0].steps > 0 && sub.hasContent);
    windMps = 0;
    const stepsAtCalm = engines[0].steps;
    for (let i = 0; i < 60; i++) sub.sync({}, frame);
    ok('subsystem: leaves in the air keep flying after the wind drops', engines[0].steps > stepsAtCalm);
    enabled = false;
    sub.sync({}, frame);
    ok('subsystem: disabled draws nothing', !sub.hasContent);
    ok('subsystem: status reports the canopy file ready', sub.getStatus().canopyFiles.ready === 1);
  }
  {
    let threw = false;
    try {
      createLeafShedSubsystem({ THREE: {} });
    } catch {
      threw = true;
    }
    ok('subsystem: an unwired seam fails loudly', threw);
  }
}
