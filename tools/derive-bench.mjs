#!/usr/bin/env node
/**
 * derive-bench.mjs — what does a scene LOAD cost the mask authority's derive?
 *
 * Drives the REAL `createMaskAuthority` over a synthetic multi-floor scene the way
 * a live load drives it — an ingest (`touch()`), then the next frame's first read
 * (`getProductsVersion()`, which is where a stale derive actually runs) — and times
 * every one of those reads. Each read is a frame that was frozen for that long.
 *
 * WHY IT EXISTS (2026-10-14). An 80 s DevTools profile of a real scene load showed
 * 56% of main-thread time in `deriveFloorProducts`, re-run in full (~4.5 s) inside
 * `renderFrame` once per batch of streamed art/masks. Nothing in the repo could
 * reproduce that without a Foundry, a GPU and a minute of waiting; this does, in
 * seconds, on synthetic data, and prints the one number that matters: how long was
 * each frame stuck. It is also the A/B harness for the next change to this path:
 * run it with `--scene-dir` pointing at a `git show <rev>:src/scene/...` export of
 * the old modules and compare `fingerprint`s (byte-identical products) and freezes.
 *
 * USAGE
 *   node tools/derive-bench.mjs [--floors 4] [--tiles 30] [--dim 2048] [--seed 1]
 *                               [--scene-dir <dir holding mask-authority.js>]
 *                               [--json out.json] [--fingerprint]
 *
 *   --floors/--tiles  scene size (tiles per floor; every floor also has a
 *                     full-map background and foreground).
 *   --dim             the caster grid's longest side — the sun-shadow tier's
 *                     `layerGridDim` (1024 = Standard, 2048 = Extreme).
 *   --fingerprint     also hash every product byte + completeness record: equal
 *                     fingerprints = identical products (the exactness oracle).
 *
 * Reference points (this repo's dev machine, 2026-10-14; ingest order is shuffled
 * and seeded, so runs are comparable; `--scene-dir` at the pre-fix modules, rev
 * af00e11a, gives the "before" column with the SAME fingerprint 2daeb52d):
 *   --floors 3 --tiles 20 --dim 1024   before: 120 reads, 227 s frozen, p50 2.1 s,
 *                                              worst 3.0 s, a no-op touch 2.9 s
 *                                      after:  120 reads, 1.1 s frozen, p50 5 ms,
 *                                              p90 15 ms, worst 87 ms, no-op 0.7 ms
 *   --floors 4 --tiles 30 --dim 2048   after:  192 reads, 3.8 s frozen, p50 13 ms,
 *                                      p90 31 ms, worst 200 ms (the full-map level
 *                                      art/mask arrivals; "before" would take ~30 min)
 *
 * This is a measurement tool, not a test: nothing asserts on its numbers (they are
 * machine-dependent). The exactness proof is `src/scene/__tests__/mask-derive-
 * equivalence.test.mjs`.
 */
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const FLOORS = Number(opt('floors', 4));
const TILES_PER_FLOOR = Number(opt('tiles', 30));
const CASTER_DIM = Number(opt('dim', 2048));
const SEED = Number(opt('seed', 1));
const JSON_OUT = opt('json', null);
const WANT_FINGERPRINT = argv.includes('--fingerprint');
const sceneDir = resolve(opt('scene-dir', resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scene')));

const load = (file) => import(pathToFileURL(resolve(sceneDir, file)).href);
const { createMaskAuthority } = await load('mask-authority.js');
const { PACKED_TRIO_LAYER_NAME, DERIVED_KINDS, MASK_KINDS } = await load('mask-catalog.js');

// ---- deterministic randomness --------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const between = (lo, hi) => lo + (hi - lo) * rnd();

// ---- the synthetic scene -----------------------------------------------------------------------------------------------
const RECT = { x: 1500, y: 1500, width: 10350, height: 10350 };
const DIMENSIONS = { width: 13350, height: 13350, sceneRect: RECT };
const FULL = { x: RECT.x + RECT.width / 2, y: RECT.y + RECT.height / 2, width: RECT.width, height: RECT.height };
let tiebreak = 0;
const layerKey = (elevation, zIndex = 0) => ({ elevation, sortLayer: 0, sort: 0, zIndex, tiebreak: tiebreak++ });

const floors = Array.from({ length: FLOORS }, (_, i) => ({
  index: i,
  id: `L${i}`,
  name: `Floor ${i}`,
  ceilingElevation: (i + 1) * 10,
  bottomElevation: i * 10,
}));
const items = [];
const placements = {};
for (const floor of floors) {
  const background = {
    id: `level:${floor.id}:background`,
    kind: 'levelBackground',
    levelId: floor.id,
    hidden: false,
    key: layerKey(floor.bottomElevation),
  };
  const foreground = {
    id: `level:${floor.id}:foreground`,
    kind: 'levelForeground',
    levelId: floor.id,
    hidden: false,
    key: layerKey(floor.ceilingElevation, 1),
  };
  items.push(background, foreground);
  placements[background.id] = { ...FULL };
  placements[foreground.id] = { ...FULL };
  for (let t = 0; t < TILES_PER_FLOOR; t++) {
    const raised = rnd() < 0.35; // the overhead band
    const tile = {
      id: `tile:${floor.id}:${t}`,
      kind: 'tile',
      levelId: '',
      hidden: rnd() < 0.04,
      key: layerKey(floor.bottomElevation + (raised ? 1 + Math.floor(rnd() * 8) : 0), 2),
      visibleOnLevelIds: [floor.id],
      levelsRestricted: rnd() < 0.7,
    };
    items.push(tile);
    const w = between(250, 2600);
    const h = between(250, 2600);
    placements[tile.id] = {
      x: RECT.x + between(w / 2, RECT.width - w / 2),
      y: RECT.y + between(h / 2, RECT.height - h / 2),
      width: w,
      height: h,
      rotation: rnd() < 0.3 ? between(-45, 45) : 0,
    };
  }
}

/** A coarse-mip-sized blob field as an RGBA page: structured enough that bilinear taps vary, partly transparent. */
function blobPage(size, { invert = false } = {}) {
  const data = new Uint8ClampedArray(size * size * 4);
  const blobs = Array.from({ length: 4 }, () => ({ cx: rnd() * size, cy: rnd() * size, r: size * between(0.15, 0.5) }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const b of blobs) v = Math.max(v, Math.max(0, 1 - Math.hypot(x - b.cx, y - b.cy) / b.r));
      const byte = Math.round(255 * Math.min(1, v * 1.6));
      const o = (y * size + x) * 4;
      const c = invert ? 255 - byte : byte;
      data[o] = c;
      data[o + 1] = c;
      data[o + 2] = c;
      data[o + 3] = rnd() < 0.5 ? 255 : Math.min(255, byte + 40);
    }
  }
  return { width: size, height: size, data };
}

const authority = createMaskAuthority({
  readPageImageData: (bitmap) => bitmap,
  log: { info() {}, warn() {}, error: (...a) => console.error('mask authority error:', ...a) },
});
authority.reset({
  sceneKey: 'derive-bench',
  dimensions: DIMENSIONS,
  floors,
  items,
  resolvePlacement: (item) => ({ ...placements[item.id] }),
});
authority.setCasterHeightSpec({
  distancePixels: 5,
  buildingHeightPx: 300,
  include: { building: true, overhead: true, skyReach: true },
  gridMaxDim: CASTER_DIM,
});

// Discovery: every background carries a full trio + the single-file kinds; ~30% of tiles carry masks of their own.
const trioKinds = ['shadow', 'outdoors', 'fire'];
const singleKinds = ['specular', 'window', 'water', 'drip'];
const byTargetId = new Map();
for (const item of items) {
  if (item.kind === 'levelBackground') {
    const kinds = new Map(trioKinds.map((k) => [k, `u/${item.id}_${k}.png`]));
    for (const k of singleKinds) kinds.set(k, `u/${item.id}_${k}.png`);
    byTargetId.set(item.id, kinds);
  } else if (item.kind === 'tile' && rnd() < 0.3) {
    const kinds = new Map(trioKinds.map((k) => [k, `u/${item.id}_${k}.png`]));
    if (rnd() < 0.5) kinds.set('water', `u/${item.id}_water.png`);
    byTargetId.set(item.id, kinds);
  }
}
authority.setDiscovery({ byTargetId, method: 'listing', failures: [], probesAttempted: 0 });

// ---- the ingest sequence: shuffled, because streamed art does not arrive in floor order -------------------------------------
const jobs = items.map((item) => ({ type: 'alpha', item }));
for (const [id, kinds] of byTargetId) {
  const item = items.find((x) => x.id === id);
  if (trioKinds.every((k) => kinds.has(k))) jobs.push({ type: 'page', item, layerName: PACKED_TRIO_LAYER_NAME });
  for (const k of kinds.keys()) if (!trioKinds.includes(k)) jobs.push({ type: 'page', item, layerName: k });
}
for (let i = jobs.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
}

const PAGE_TABLE = { worldWidthPx: 1000, worldHeightPx: 1000, maxMip: 3 };
function ingest(job) {
  const size = 64 + Math.floor(rnd() * 120);
  if (job.type === 'alpha') {
    const page = blobPage(size);
    const data = new Uint8Array(size * size);
    for (let i = 0; i < data.length; i++) data[i] = job.item.kind === 'tile' ? page.data[i * 4 + 3] : 255;
    authority.ingestItemAlpha({
      ownerId: job.item.id,
      grid: { w: size, h: size, data },
      imageWidth: 4000,
      imageHeight: 4000,
    });
  } else {
    authority.ingestDecodedPage({
      ownerId: job.item.id,
      layerName: job.layerName,
      table: PAGE_TABLE,
      page: { mip: 3, px: 0, py: 0 },
      contentWindow: { dx: 0, dy: 0, dw: size, dh: size },
      bitmap: blobPage(size, { invert: job.layerName === PACKED_TRIO_LAYER_NAME }),
    });
  }
}

// ---- measure -----------------------------------------------------------------------------------------------------------------------
const report = {
  floors: FLOORS,
  tilesPerFloor: TILES_PER_FLOOR,
  items: items.length,
  casterDim: CASTER_DIM,
  ingests: jobs.length,
  sceneDir,
};

let t0 = performance.now();
authority.getProductsVersion(); // the first derive, nothing ingested yet
report.emptyDeriveMs = +(performance.now() - t0).toFixed(1);

const freezes = [];
const byType = {};
for (const job of jobs) {
  ingest(job);
  t0 = performance.now();
  authority.getProductsVersion(); // the next frame's first read: this is the freeze
  const ms = performance.now() - t0;
  freezes.push(ms);
  const label =
    job.type === 'alpha'
      ? `alpha:${job.item.kind === 'tile' ? 'tile' : 'level'}`
      : `page:${job.layerName}:${job.item.kind === 'tile' ? 'tile' : 'level'}`;
  (byType[label] ??= []).push(ms);
}
const sorted = [...freezes].sort((a, b) => a - b);
const pct = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
const sum = freezes.reduce((a, b) => a + b, 0);
report.freeze = {
  reads: freezes.length,
  totalMs: Math.round(sum),
  worstMs: pct(1),
  p50Ms: pct(0.5),
  p90Ms: pct(0.9),
  over16ms: freezes.filter((x) => x > 16).length,
  over50ms: freezes.filter((x) => x > 50).length,
};
report.byIngestType = Object.fromEntries(
  Object.entries(byType).map(([k, a]) => [
    k,
    { n: a.length, meanMs: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1), worstMs: +Math.max(...a).toFixed(1) },
  ])
);

// A Tile/Level document hook touching nothing: the identical item list, freshly collected.
const versionBefore = authority.getProductsVersion();
authority.setItems(items.map((x) => ({ ...x, key: { ...x.key } })));
t0 = performance.now();
const versionAfter = authority.getProductsVersion();
report.noopTouch = { ms: +(performance.now() - t0).toFixed(1), versionBumped: versionAfter !== versionBefore };
report.bakeStats = authority.getBakeStats?.() ?? null;

if (WANT_FINGERPRINT) {
  // FNV-1a over every product byte, spec and completeness record, per floor per product.
  const fnv = (h, bytes) => {
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
    return h;
  };
  const text = (s) => new TextEncoder().encode(s);
  const ids = [...DERIVED_KINDS.map((d) => d.id), ...MASK_KINDS.filter((k) => k.rasterize).map((k) => k.id)];
  let whole = 2166136261;
  for (const floor of floors) {
    for (const id of ids) {
      let product = null;
      try {
        product = authority.getDerived(id, floor.index, { acknowledgeMissingRequired: true });
      } catch {
        product = null;
      }
      if (!product) continue;
      let h = fnv(2166136261, product.grid.data);
      h = fnv(h, text(JSON.stringify(product.grid.spec)));
      if (product.channels) for (const k of Object.keys(product.channels).sort()) h = fnv(h, product.channels[k].data);
      h = fnv(h, text(JSON.stringify(product.completeness)));
      h = fnv(h, text(JSON.stringify(product.outdoorsLedger)));
      whole = fnv(whole, text(`${floor.index}/${id}:${h}`));
    }
  }
  report.fingerprint = whole.toString(16);
}

console.log(JSON.stringify(report, null, 2));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
