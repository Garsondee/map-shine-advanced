/**
 * mask-derive-equivalence.test.mjs — THE DERIVE REWRITE (2026-10-14) IS BYTE-
 * IDENTICAL TO WHAT IT REPLACED, AND THE CACHE NEVER SERVES A STALE FLOOR.
 *
 * Why this suite exists: a live scene load froze the main thread 4.5 s at a time
 * because `deriveFloorProducts` re-rasterized every kind on every floor from
 * scratch on every ingest. The fix is a different algorithm — separable bilinear
 * sampling, per-item footprint stamps, a per-floor/per-stage memo with an
 * "append" path that merges only newly-arrived items — and every one of those is
 * a place a 1/255 error could hide, in a product whose consumers are shadows,
 * wind shelter, fire placement and water. "It looks the same" is not a proof.
 *
 * So the pre-change functions live on, verbatim, in `mask-derive-oracle.mjs`
 * (extracted from the revision before the rewrite), and this file runs BOTH on
 * thousands of random inputs and requires exact equality:
 *
 *   1. PRIMITIVES — `compositeItemMax` / `compositeItemHeightMax` /
 *      `compositeItemOverwrite` against their per-texel originals: random
 *      placements (axis-aligned, 90°, arbitrary rotation, odd anchors, partially or
 *      wholly off-grid), content sizes, alpha present/absent/mismatched, the
 *      minifying box filter, value scales.
 *   2. THE WHOLE DERIVE — `deriveFloorProducts` against the oracle on random
 *      worlds: floors, ceilings, hidden items, owner/visibility classification,
 *      caster grid on/off, per-kind grid overrides, building/overhead/sky-reach
 *      toggles.
 *   3. THE CACHE — a persistent cache driven through long random sequences of the
 *      mutations a real load produces (art arrives, a mask replaces itself, an item
 *      is hidden or moved, a source appears/disappears), compared against a FRESH
 *      oracle derive after every single step. This is the test that catches a
 *      stale stage: an `append` that should have been a `rebuild`, a key that
 *      forgot an input.
 *   4. THE CACHE'S OWN CLAIMS — identity-stable products when nothing changed,
 *      the right stage rebuilt for the right change, and nothing else.
 *
 * Deterministic (seeded) so a failure is reproducible: the failing seed is in the
 * assertion name.
 */
import {
  computeMaskGridSpec,
  createDeriveCache,
  createMaskGrid,
  deriveFloorProducts,
  compositeItemMax,
  compositeItemHeightMax,
  compositeItemOverwrite,
  worldIndexMap,
  sampleMaskGridWorld,
} from '../mask-derive.js';
import {
  oracleCompositeItemMax,
  oracleCompositeItemOverwrite,
  oracleCompositeItemHeightMax,
  oracleDeriveFloorProducts,
} from './mask-derive-oracle.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RECT = { x: 120, y: 80, width: 1400, height: 900 };

function randomContent(rng, maxSide = 36) {
  const w = 1 + Math.floor(rng() * maxSide);
  const h = 1 + Math.floor(rng() * maxSide);
  const data = new Uint8Array(w * h);
  const mode = rng();
  for (let i = 0; i < data.length; i++) {
    // Mostly structured (ramps, plateaus, zeros) so thresholds and rounding edges
    // are actually exercised, with noise so nothing is accidentally symmetric.
    data[i] =
      mode < 0.25
        ? Math.floor(rng() * 256)
        : mode < 0.5
          ? rng() < 0.5
            ? 0
            : 255
          : mode < 0.75
            ? // PLATEAUS AT THE HEIGHT-COVERAGE THRESHOLD (8) AND ITS NEIGHBOURS, so `raw === 8`
              // and `round(raw) === 8 while raw < 8` actually occur — the two places `pass` and
              // `value` can disagree, and where a < / <= slip would hide.
              [0, 7, 8, 8, 9, 255][Math.floor(i / 3) % 6]
            : Math.floor(rng() * 12) * 21;
  }
  return { w, h, data };
}

function randomPlacement(rng, rect = RECT) {
  const r = rng();
  const rotation = r < 0.45 ? 0 : r < 0.55 ? 90 : r < 0.6 ? 360 : r < 0.65 ? -45 : rng() * 360 - 180;
  const p = {
    x: rect.x + (rng() * 1.3 - 0.15) * rect.width,
    y: rect.y + (rng() * 1.3 - 0.15) * rect.height,
    width: 8 + rng() * rect.width * (rng() < 0.2 ? 1.6 : 0.5),
    height: 8 + rng() * rect.height * (rng() < 0.2 ? 1.6 : 0.5),
  };
  if (rng() < 0.7) p.rotation = rotation;
  if (rng() < 0.5) p.anchorX = rng() < 0.5 ? 0 : rng() * 1.4 - 0.2;
  if (rng() < 0.5) p.anchorY = rng() < 0.5 ? 0 : rng() * 1.4 - 0.2;
  return p;
}

const sameBytes = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

function randomGrid(rng, spec) {
  const g = createMaskGrid(spec);
  const mode = rng();
  for (let i = 0; i < g.data.length; i++) g.data[i] = mode < 0.5 ? 0 : Math.floor(rng() * 256);
  return g;
}

/** First difference between two product lists, or null. */
function diffProducts(a, b, { aliasing = true } = {}) {
  if (a.length !== b.length) return `product count ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (p.index !== q.index) return `floor ${i}: index ${p.index} vs ${q.index}`;
    const grids = (prod) => ({
      coverAbove: prod.coverAbove,
      skyReach: prod.skyReach,
      outdoors: prod.outdoors,
      casterHeight: prod.casterHeight,
      ...Object.fromEntries(Object.entries(prod.authored).map(([k, g]) => [`authored.${k}`, g])),
      ...Object.fromEntries(Object.entries(prod.casterChannels).map(([k, g]) => [`channels.${k}`, g])),
    });
    const ga = grids(p);
    const gb = grids(q);
    const keys = new Set([...Object.keys(ga), ...Object.keys(gb)]);
    for (const k of keys) {
      if (!ga[k] || !gb[k]) return `floor ${i}: grid ${k} present in one only`;
      if (JSON.stringify(ga[k].spec) !== JSON.stringify(gb[k].spec)) return `floor ${i}: ${k} spec differs`;
      if (!sameBytes(ga[k].data, gb[k].data)) {
        let at = -1;
        for (let j = 0; j < ga[k].data.length; j++) {
          if (ga[k].data[j] !== gb[k].data[j]) {
            at = j;
            break;
          }
        }
        return `floor ${i}: ${k} bytes differ at ${at} (${ga[k].data[at]} vs ${gb[k].data[at]})`;
      }
    }
    // The aliasing contract: `coverAbove` IS `casterChannels.coverAbove` when no caster resolution was asked for.
    if (aliasing && (p.coverAbove === p.casterChannels.coverAbove) !== (q.coverAbove === q.casterChannels.coverAbove)) {
      return `floor ${i}: coverAbove/coverCaster aliasing differs`;
    }
    if (aliasing && (p.outdoors === p.casterChannels.outdoors) !== (q.outdoors === q.casterChannels.outdoors)) {
      return `floor ${i}: outdoors/outdoorsCaster aliasing differs`;
    }
    if (JSON.stringify(p.completeness) !== JSON.stringify(q.completeness)) {
      return `floor ${i}: completeness differs: ${JSON.stringify(p.completeness).slice(0, 200)} vs ${JSON.stringify(q.completeness).slice(0, 200)}`;
    }
    if (JSON.stringify(p.outdoorsLedger) !== JSON.stringify(q.outdoorsLedger))
      return `floor ${i}: outdoorsLedger differs`;
  }
  return null;
}

/** A deep copy of a product list's bytes, so a later derive can be checked for mutating them. */
function snapshotProducts(products) {
  const copyGrid = (g) => ({ spec: g.spec, data: g.data.slice() });
  return products.map((p) => ({
    index: p.index,
    coverAbove: copyGrid(p.coverAbove),
    skyReach: copyGrid(p.skyReach),
    outdoors: copyGrid(p.outdoors),
    casterHeight: copyGrid(p.casterHeight),
    authored: Object.fromEntries(Object.entries(p.authored).map(([k, g]) => [k, copyGrid(g)])),
    casterChannels: Object.fromEntries(Object.entries(p.casterChannels).map(([k, g]) => [k, copyGrid(g)])),
    completeness: JSON.parse(JSON.stringify(p.completeness)),
    outdoorsLedger: JSON.parse(JSON.stringify(p.outdoorsLedger)),
  }));
}

// ---- random worlds -------------------------------------------------------------------------------------------------

function randomSource(rng, ownerId, rect = RECT) {
  const content = randomContent(rng, 30);
  const r = rng();
  // alpha: absent, same geometry (the real case), or a DIFFERENT geometry (must still match the oracle).
  const alpha =
    r < 0.25 ? null : r < 0.85 ? { w: content.w, h: content.h, data: sameShape(rng, content) } : randomContent(rng, 30);
  const source = { content, placement: randomPlacement(rng, rect), ownerId };
  if (alpha) source.alpha = alpha;
  if (rng() < 0.1) source.areaAverage = true;
  return source;
}

function sameShape(rng, content) {
  const d = new Uint8Array(content.w * content.h);
  for (let i = 0; i < d.length; i++) d[i] = rng() < 0.6 ? 255 : Math.floor(rng() * 256);
  return d;
}

function randomWorld(rng) {
  const rect = { ...RECT };
  const dim = 12 + Math.floor(rng() * 40);
  const gridSpec = computeMaskGridSpec(rect, dim);
  const casterGridSpec = rng() < 0.6 ? computeMaskGridSpec(rect, 12 + Math.floor(rng() * 70)) : null;
  const authoredGridSpecs = rng() < 0.5 ? { water: computeMaskGridSpec(rect, 16 + Math.floor(rng() * 60)) } : {};
  const floorCount = 1 + Math.floor(rng() * 4);
  const floors = [];
  for (let i = 0; i < floorCount; i++) {
    const nSrc = Math.floor(rng() * 3);
    const nFire = Math.floor(rng() * 3);
    const nWater = Math.floor(rng() * 3);
    floors.push({
      index: i,
      ceilingElevation: i === floorCount - 1 && rng() < 0.3 ? Infinity : (i + 1) * 10,
      bottomElevation: rng() < 0.1 ? NaN : i * 10,
      outdoors: Array.from({ length: nSrc }, (_, k) => randomSource(rng, `o${i}.${k}`, rect)),
      authored: {
        fire: {
          sources: Array.from({ length: nFire }, (_, k) => randomSource(rng, `f${i}.${k}`, rect)),
          absentValue: 0,
        },
        water: {
          sources: Array.from({ length: nWater }, (_, k) => randomSource(rng, `w${i}.${k}`, rect)),
          absentValue: 0,
        },
      },
    });
  }
  const items = [];
  const nItems = Math.floor(rng() * 13);
  for (let k = 0; k < nItems; k++) items.push(randomItem(rng, k, floorCount, rect));
  const casterHeights =
    rng() < 0.85
      ? {
          scalePx: 1000,
          distancePixels: rng() < 0.9 ? 5 : 0,
          buildingHeightPx: rng() < 0.7 ? 100 + Math.floor(rng() * 800) : 0,
          include: { building: rng() < 0.85, overhead: rng() < 0.85, skyReach: rng() < 0.85 },
        }
      : null;
  return { gridSpec, casterGridSpec, authoredGridSpecs, items, floors, outdoorsAbsentValue: 1, casterHeights };
}

function randomItem(rng, k, floorCount, rect) {
  const owned = rng() < 0.3;
  return {
    id: `item${k}`,
    elevation: Math.floor(rng() * (floorCount * 10 + 6)),
    hidden: rng() < 0.1,
    placement: randomPlacement(rng, rect),
    alpha: rng() < 0.85 ? randomContent(rng, 30) : null,
    ownerFloorIndex: owned ? Math.floor(rng() * floorCount) : null,
    visibleFloorIndices: !owned && rng() < 0.4 ? [Math.floor(rng() * floorCount)] : null,
  };
}

/** What the authority hands `deriveFloorProducts`: fresh wrapper objects every call, SAME content/placement refs. */
function freshArgs(world) {
  return {
    gridSpec: world.gridSpec,
    casterGridSpec: world.casterGridSpec ? { ...world.casterGridSpec } : null,
    authoredGridSpecs: Object.fromEntries(Object.entries(world.authoredGridSpecs).map(([k, v]) => [k, { ...v }])),
    outdoorsAbsentValue: world.outdoorsAbsentValue,
    casterHeights: world.casterHeights ? { ...world.casterHeights, include: { ...world.casterHeights.include } } : null,
    items: world.items.map((it) => ({ ...it })),
    floors: world.floors.map((f) => ({
      ...f,
      outdoors: f.outdoors.map((s) => ({ ...s })),
      authored: Object.fromEntries(
        Object.entries(f.authored).map(([k, v]) => [k, { ...v, sources: v.sources.map((s) => ({ ...s })) }])
      ),
    })),
  };
}

function mutate(rng, world) {
  const w = { ...world, items: [...world.items], floors: world.floors.map((f) => ({ ...f })) };
  const floorCount = w.floors.length;
  const pick = (arr) => Math.floor(rng() * arr.length);
  switch (Math.floor(rng() * 15)) {
    case 10: {
      // the caster-height spec moves (a slider, the effect toggled): flags, building height, scale of distance
      const ch = w.casterHeights ?? { scalePx: 1000, distancePixels: 5, buildingHeightPx: 0, include: {} };
      w.casterHeights = {
        ...ch,
        distancePixels: rng() < 0.2 ? 0 : 1 + Math.floor(rng() * 8),
        buildingHeightPx: rng() < 0.3 ? 0 : 50 + Math.floor(rng() * 900),
        include: { building: rng() < 0.7, overhead: rng() < 0.7, skyReach: rng() < 0.7 },
      };
      if (rng() < 0.1) w.casterHeights = null;
      break;
    }
    case 11:
      // a performance tier switch: the caster grid is a different resolution (or gone)
      w.casterGridSpec = rng() < 0.3 ? null : computeMaskGridSpec(RECT, 12 + Math.floor(rng() * 70));
      break;
    case 12: {
      // an item's PLACEMENT changes while its art object stays (defensive: a placement is keyed by value)
      if (w.items.length) {
        const idx = pick(w.items);
        w.items[idx] = { ...w.items[idx], placement: randomPlacement(rng) };
      }
      break;
    }
    case 13: {
      // a source keeps its content but moves
      const f = w.floors[pick(w.floors)];
      if (f.outdoors.length) {
        const outdoors = [...f.outdoors];
        const i = pick(outdoors);
        outdoors[i] = { ...outdoors[i], placement: randomPlacement(rng) };
        f.outdoors = outdoors;
      }
      break;
    }
    case 0: {
      // art arrives for an item that had none
      const idx = w.items.findIndex((it) => !it.alpha);
      if (idx >= 0) w.items[idx] = { ...w.items[idx], alpha: randomContent(rng, 30) };
      break;
    }
    case 1: {
      // an item's art is RE-INGESTED (new object, new bytes)
      if (w.items.length) {
        const idx = pick(w.items);
        w.items[idx] = { ...w.items[idx], alpha: randomContent(rng, 30) };
      }
      break;
    }
    case 2:
      if (w.items.length) {
        const idx = pick(w.items);
        w.items[idx] = { ...w.items[idx], hidden: !w.items[idx].hidden };
      }
      break;
    case 3:
      if (w.items.length) {
        const idx = pick(w.items);
        w.items[idx] = { ...w.items[idx], elevation: Math.floor(rng() * (floorCount * 10 + 6)) };
      }
      break;
    case 4:
      // a new item (a tile created)
      w.items.splice(
        Math.floor(rng() * (w.items.length + 1)),
        0,
        randomItem(rng, 100 + w.items.length, floorCount, RECT)
      );
      break;
    case 5:
      if (w.items.length) w.items.splice(pick(w.items), 1);
      break;
    case 6: {
      // an outdoors mask arrives (a source inserted at a random draw-order position)
      const f = w.floors[pick(w.floors)];
      const outdoors = [...f.outdoors];
      outdoors.splice(
        Math.floor(rng() * (outdoors.length + 1)),
        0,
        randomSource(rng, `o${f.index}.n${Math.floor(rng() * 1e6)}`)
      );
      f.outdoors = outdoors;
      break;
    }
    case 7: {
      // an authored kind's source arrives or is replaced
      const f = w.floors[pick(w.floors)];
      const kind = rng() < 0.5 ? 'fire' : 'water';
      const sources = [...f.authored[kind].sources];
      if (sources.length && rng() < 0.5) sources[pick(sources)] = randomSource(rng, `r${Math.floor(rng() * 1e6)}`);
      else
        sources.splice(Math.floor(rng() * (sources.length + 1)), 0, randomSource(rng, `n${Math.floor(rng() * 1e6)}`));
      f.authored = { ...f.authored, [kind]: { ...f.authored[kind], sources } };
      break;
    }
    case 8: {
      // a source disappears
      const f = w.floors[pick(w.floors)];
      if (f.outdoors.length) f.outdoors = f.outdoors.filter((_, i) => i !== pick(f.outdoors));
      break;
    }
    default:
      // no-op: the same inputs re-sent (a Tile document hook touching nothing)
      break;
  }
  return w;
}

// ---- the suite ----------------------------------------------------------------------------------------------------

export function run(t) {
  // ── 1. PRIMITIVES ────────────────────────────────────────────────────────────────────────────────────────────
  {
    let bad = null;
    let trials = 0;
    for (let seed = 1; seed <= 400 && !bad; seed++) {
      const rng = mulberry32(seed);
      const spec = computeMaskGridSpec(RECT, 8 + Math.floor(rng() * 90));
      const content = randomContent(rng, rng() < 0.2 ? 120 : 36);
      const placement = randomPlacement(rng);
      const scale = [1, 1, 1, 0.5, 2, 0, NaN][Math.floor(rng() * 7)];
      const a = randomGrid(rng, spec);
      const b = { spec, data: a.data.slice() };
      oracleCompositeItemMax(a, content, placement, scale);
      compositeItemMax(b, content, placement, scale);
      if (!sameBytes(a.data, b.data)) bad = `compositeItemMax seed ${seed}`;

      const hb = [0, 1, 40, 128, 255, 300, -5, 3.6][Math.floor(rng() * 8)];
      const c = randomGrid(rng, spec);
      const d = { spec, data: c.data.slice() };
      oracleCompositeItemHeightMax(c, content, placement, hb);
      compositeItemHeightMax(d, content, placement, hb);
      if (!bad && !sameBytes(c.data, d.data)) bad = `compositeItemHeightMax seed ${seed}`;

      const e = randomGrid(rng, spec);
      const f = { spec, data: e.data.slice() };
      const r = rng();
      const alpha =
        r < 0.3
          ? null
          : r < 0.75
            ? { w: content.w, h: content.h, data: sameShape(rng, content) }
            : randomContent(rng, 40);
      const opts = { areaAverage: rng() < 0.25 };
      oracleCompositeItemOverwrite(e, content, placement, alpha, opts);
      compositeItemOverwrite(f, content, placement, alpha, opts);
      if (!bad && !sameBytes(e.data, f.data)) bad = `compositeItemOverwrite seed ${seed}`;
      trials++;
    }
    t.ok(
      `primitives: 3 composites × ${trials} random cases are byte-identical to the per-texel originals${bad ? ` — FIRST FAIL: ${bad}` : ''}`,
      !bad
    );
  }

  // ── 2. THE WHOLE DERIVE ───────────────────────────────────────────────────────────────────────────────────────
  {
    let bad = null;
    let worlds = 0;
    for (let seed = 1; seed <= 250 && !bad; seed++) {
      const world = randomWorld(mulberry32(seed * 7919));
      const expected = oracleDeriveFloorProducts(freshArgs(world));
      const actual = deriveFloorProducts(freshArgs(world));
      const d = diffProducts(actual, expected);
      if (d) bad = `seed ${seed}: ${d}`;
      worlds++;
    }
    t.ok(
      `derive: ${worlds} random worlds produce byte-identical products and completeness${bad ? ` — FIRST FAIL: ${bad}` : ''}`,
      !bad
    );
  }

  // ── 3. THE CACHE, THROUGH RANDOM INGEST SEQUENCES ───────────────────────────────────────────────────────────────────
  {
    let bad = null;
    let steps = 0;
    const seen = { hit: 0, append: 0, rebuild: 0 };
    for (let seed = 1; seed <= 90 && !bad; seed++) {
      const rng = mulberry32(seed * 104729);
      let world = randomWorld(rng);
      const cache = createDeriveCache();
      let previous = null;
      for (let step = 0; step < 14 && !bad; step++) {
        const actual = deriveFloorProducts({ ...freshArgs(world), cache });
        const expected = oracleDeriveFloorProducts(freshArgs(world));
        const d = diffProducts(actual, expected);
        if (d) bad = `seed ${seed} step ${step}: ${d}`;
        // A derive must never mutate products it ALREADY returned: consumers (the sun-shadow
        // pack, the water bake, the fire extractor) hold those grids across frames.
        if (!bad && previous) {
          const e = diffProducts(previous.products, previous.snapshot, { aliasing: false });
          if (e) bad = `seed ${seed} step ${step}: a previously returned product was mutated: ${e}`;
        }
        previous = { products: actual, snapshot: snapshotProducts(actual) };
        steps++;
        world = mutate(rng, world);
      }
      for (const k of Object.keys(seen)) seen[k] += cache.stats.composites[k];
    }
    t.ok(
      `cache: ${steps} derive steps through random ingest sequences match a fresh oracle derive every time${bad ? ` — FIRST FAIL: ${bad}` : ''}`,
      !bad
    );
    t.ok(
      'cache: the sequences actually exercised all three composite paths (hit / append / rebuild)',
      seen.hit > 20 && seen.append > 20 && seen.rebuild > 20
    );
  }

  // ── 4. THE CACHE'S OWN CLAIMS ───────────────────────────────────────────────────────────────────────────────────
  {
    // A tiny, fully-specified 2-floor scene.
    const rect = { x: 0, y: 0, width: 1000, height: 1000 };
    const gridSpec = computeMaskGridSpec(rect, 32);
    const casterGridSpec = computeMaskGridSpec(rect, 64);
    const solid = (n, v) => ({ w: n, h: n, data: new Uint8Array(n * n).fill(v) });
    const full = { x: 500, y: 500, width: 1000, height: 1000 };
    const base = () => ({
      gridSpec,
      casterGridSpec,
      authoredGridSpecs: {},
      outdoorsAbsentValue: 1,
      casterHeights: { scalePx: 1000, distancePixels: 5, buildingHeightPx: 300, include: {} },
      floors: [
        {
          index: 0,
          ceilingElevation: 10,
          bottomElevation: 0,
          outdoors: [],
          authored: { fire: { sources: [], absentValue: 0 } },
        },
        {
          index: 1,
          ceilingElevation: 20,
          bottomElevation: 10,
          outdoors: [],
          authored: { fire: { sources: [], absentValue: 0 } },
        },
      ],
      items: [
        {
          id: 'bg1',
          elevation: 10,
          hidden: false,
          placement: full,
          alpha: solid(4, 255),
          ownerFloorIndex: 1,
          visibleFloorIndices: null,
        },
      ],
    });
    const cache = createDeriveCache();
    const world = base();
    const first = deriveFloorProducts({ ...world, cache });
    const s0 = JSON.stringify(cache.stats);
    const again = deriveFloorProducts({ ...world, cache, items: world.items.map((i) => ({ ...i })) });
    t.ok(
      'claims: re-deriving identical inputs returns the SAME product objects (identity is how the authority detects "nothing changed")',
      again.length === first.length && again.every((p, i) => p === first[i])
    );
    t.ok(
      'claims: …and samples no texel and rebuilds no stage to do it',
      cache.stats.stampsComputed === JSON.parse(s0).stampsComputed &&
        cache.stats.composites.hit >= 2 &&
        cache.stats.outdoors.hit >= 2 &&
        cache.stats.gate.hit >= 2
    );

    // An ingest the floors did not have before: floor 0 sees a NEW op (append), floor 1 is untouched (hit, same product).
    const grown = {
      ...world,
      items: [
        ...world.items,
        {
          id: 'bg2',
          elevation: 20,
          hidden: false,
          placement: full,
          alpha: solid(4, 200),
          ownerFloorIndex: 1,
          visibleFloorIndices: null,
        },
      ],
    };
    const before = { ...cache.stats.composites };
    const afterGrow = deriveFloorProducts({ ...grown, cache });
    t.ok(
      'claims: an item gaining art merges only its own stamp into a copy (append), it does not rebuild the floor',
      cache.stats.composites.append - before.append >= 1 && cache.stats.composites.rebuild === before.rebuild
    );
    t.ok(
      'claims: …a floor that item does not reach keeps every grid object (only its item table, which lists every item, changed)',
      afterGrow[1].coverAbove === first[1].coverAbove &&
        afterGrow[1].skyReach === first[1].skyReach &&
        afterGrow[1].casterHeight === first[1].casterHeight &&
        afterGrow[1].casterChannels.coverSkyReach === first[1].casterChannels.coverSkyReach
    );
    t.ok(
      'claims: …and the append is byte-identical to a from-scratch derive',
      diffProducts(afterGrow, oracleDeriveFloorProducts(freshArgs({ ...grown }))) === null
    );

    // Re-ingesting an item's art REPLACES it: not a superset of last time, so it must rebuild (MAX cannot be un-merged).
    const reingested = {
      ...grown,
      items: grown.items.map((i) => (i.id === 'bg1' ? { ...i, alpha: solid(4, 90) } : i)),
    };
    const beforeRebuild = cache.stats.composites.rebuild;
    const afterReingest = deriveFloorProducts({ ...reingested, cache });
    t.ok(
      "claims: replacing an item's art REBUILDS the floors it reaches",
      cache.stats.composites.rebuild > beforeRebuild
    );
    t.ok(
      'claims: …and the rebuild is byte-identical (the old, brighter art is gone, not max-merged under the new)',
      diffProducts(afterReingest, oracleDeriveFloorProducts(freshArgs(reingested))) === null
    );

    // A mask arriving touches that kind on that floor and nothing else.
    const w0 = base();
    const withFire = {
      ...w0,
      floors: [
        w0.floors[0],
        {
          ...w0.floors[1],
          authored: { fire: { sources: [{ content: solid(6, 200), placement: full, ownerId: 'f' }], absentValue: 0 } },
        },
      ],
    };
    const c2 = createDeriveCache();
    deriveFloorProducts({ ...w0, cache: c2 });
    const stats2 = JSON.parse(JSON.stringify(c2.stats));
    deriveFloorProducts({ ...withFire, cache: c2 });
    t.ok(
      'claims: a fire mask on floor 1 rebuilds exactly one authored grid and no composite/outdoors stage',
      c2.stats.authored.miss - stats2.authored.miss === 1 &&
        c2.stats.composites.hit - stats2.composites.hit === 2 &&
        c2.stats.outdoors.hit - stats2.outdoors.hit === 2
    );
  }

  // ── 5. worldIndexMap IS sampleMaskGridWorld, hoisted ─────────────────────────────────────────────────────────────
  {
    let bad = null;
    for (let seed = 1; seed <= 120 && !bad; seed++) {
      const rng = mulberry32(seed * 31);
      const dst = computeMaskGridSpec(RECT, 6 + Math.floor(rng() * 80));
      // Source grids over the same rect, a shifted rect (partial overlap) and a disjoint one.
      const shift = [0, 0, 300, -700, 5000][Math.floor(rng() * 5)];
      const src = computeMaskGridSpec({ ...RECT, x: RECT.x + shift }, 6 + Math.floor(rng() * 80));
      const grid = randomGrid(rng, src);
      const map = worldIndexMap(dst, src);
      for (let gy = 0; gy < dst.h && !bad; gy++) {
        for (let gx = 0; gx < dst.w; gx++) {
          const wx = dst.x + (gx + 0.5) * dst.texelW;
          const wy = dst.y + (gy + 0.5) * dst.texelH;
          const want = sampleMaskGridWorld(grid, wx, wy);
          const c = map.col[gx];
          const r = map.row[gy];
          const got = r < 0 || c < 0 ? null : grid.data[r + c];
          if (want !== got) {
            bad = `seed ${seed} (${gx},${gy}): ${want} vs ${got}`;
            break;
          }
        }
      }
    }
    t.ok(
      `worldIndexMap: every texel agrees with sampleMaskGridWorld across resolutions and offsets${bad ? ` — ${bad}` : ''}`,
      !bad
    );
  }
}
