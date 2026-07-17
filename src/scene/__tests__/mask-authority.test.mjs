/**
 * mask-authority.test.mjs — the hub's contract: serving carries provenance,
 * ingest filters to the coarsest mip, derivation is lazy-but-always-fresh,
 * and every degraded state is REPORTED (instruments must not lie).
 *
 * Browser bits (bitmap pixel access) are injected, so the whole lifecycle —
 * reset → discovery → ingest → derive → sample → report — runs under Node.
 */
import { createMaskAuthority } from '../mask-authority.js';
import { PACKED_TRIO_LAYER_NAME } from '../mask-catalog.js';

/** Synthetic "bitmap": already ImageData-shaped; the injected reader is identity. */
function syntheticPage(size, { r = 0, g = 0, b = 0, a = 255 } = {}) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { width: size, height: size, data };
}

const fullWindow = (size) => ({ dx: 0, dy: 0, dw: size, dh: size });

export async function run(t) {
  const logged = { errors: [] };
  const log = { info: () => {}, warn: () => {}, error: (...a) => logged.errors.push(a.join(' ')) };

  const placements = {
    'level:L0:background': { x: 50, y: 50, width: 100, height: 100 }, // full rect
    'level:L1:background': { x: 25, y: 50, width: 50, height: 100 }, // left half
    'tile:T1': { x: 75, y: 25, width: 50, height: 50 }, // top-right quadrant
  };

  const authority = createMaskAuthority({ readPageImageData: (bitmap) => bitmap, log });
  const items = [
    { id: 'level:L0:background', kind: 'levelBackground', levelId: 'L0', hidden: false, key: { elevation: 0 } },
    { id: 'level:L1:background', kind: 'levelBackground', levelId: 'L1', hidden: false, key: { elevation: 10 } },
    { id: 'tile:T1', kind: 'tile', levelId: '', hidden: false, key: { elevation: 10 } },
    { id: 'token:X', kind: 'token', levelId: '', hidden: false, key: { elevation: 5 } }, // must be ignored
  ];
  authority.reset({
    sceneKey: 'test-scene',
    dimensions: { width: 200, height: 200, sceneRect: { x: 0, y: 0, width: 100, height: 100 } },
    floors: [
      { index: 0, id: 'L0', name: 'Ground', ceilingElevation: 10 },
      { index: 1, id: 'L1', name: 'Upstairs', ceilingElevation: 20 },
    ],
    items,
    resolvePlacement: (item) => placements[item.id],
  });

  // --- serving before discovery: defaults, honestly labelled ---------------
  t.ok('no discovery → no extra layers for anything', authority.layersForItem(items[0]).length === 0);
  const preStatus = authority.authoredStatus('L0', 'outdoors');
  t.ok('absent outdoors serves default(1) with provenance', preStatus.source === 'default' && preStatus.value === 1);
  t.throws(
    'unknown authored kind throws toward the catalog',
    () => authority.authoredStatus('L0', 'nonsense'),
    'mask-catalog'
  );
  t.throws('unknown derived kind throws toward the catalog', () => authority.getDerived('nonsense', 0), 'mask-catalog');

  // --- discovery → assembled descriptors through the ONE catalog policy ----
  authority.setDiscovery({
    byLevelId: new Map([
      [
        'L0',
        new Map([
          ['shadow', 'art/base_Shadow.png'],
          ['outdoors', 'art/base_Outdoors.png'],
          ['fire', 'art/base_Fire.png'],
          ['specular', 'art/base_Specular.png'],
        ]),
      ],
    ]),
    method: 'listing',
    failures: [],
    probesAttempted: 0,
  });
  const l0Layers = authority.layersForItem(items[0]);
  t.ok(
    'full trio + specular → packed layer + one single',
    l0Layers.length === 2 &&
      l0Layers.some((d) => d.name === PACKED_TRIO_LAYER_NAME) &&
      l0Layers.some((d) => d.name === 'specular')
  );
  t.ok('floors without discovery results stream albedo alone', authority.layersForItem(items[1]).length === 0);
  t.ok('non-levelBackground items never get mask layers', authority.layersForItem(items[2]).length === 0);
  const postStatus = authority.authoredStatus('L0', 'outdoors');
  t.ok(
    'authored outdoors serves its URL with provenance',
    postStatus.source === 'authored' && postStatus.url === 'art/base_Outdoors.png'
  );

  // --- derivation before any ingest: soft, complete-ly reported ------------
  const empty = authority.getDerived('coverAbove', 0);
  t.ok('pre-ingest coverAbove exists and is empty', empty && empty.grid.data.every((v) => v === 0));
  t.ok(
    'pre-ingest completeness lists the pending inputs',
    empty.completeness.missingItemIds.includes('level:L1:background') &&
      empty.completeness.missingItemIds.includes('tile:T1')
  );

  // --- ingest: mip filter, unknown owners, token immunity ------------------
  const table = { worldWidthPx: 100, worldHeightPx: 100, maxMip: 3 };
  authority.ingestDecodedPage({
    ownerId: 'level:L1:background',
    layerName: 'albedo',
    table,
    page: { mip: 1, px: 0, py: 0 }, // NOT the coarsest — must be ignored
    contentWindow: fullWindow(8),
    bitmap: syntheticPage(8),
  });
  t.ok(
    'non-coarsest pages are ignored',
    authority.getReport().ingest.pagesIngested === 0 && authority.getReport().ingest.pagesIgnored === 1
  );

  authority.ingestDecodedPage({
    ownerId: 'token:X',
    layerName: 'albedo',
    table,
    page: { mip: 3, px: 0, py: 0 },
    contentWindow: fullWindow(8),
    bitmap: syntheticPage(8),
  });
  t.ok('untracked owners (tokens) are ignored', authority.getReport().ingest.pagesIngested === 0);

  authority.ingestDecodedPage({
    ownerId: 'level:L1:background',
    layerName: 'albedo',
    table,
    page: { mip: 3, px: 0, py: 0 },
    contentWindow: fullWindow(8),
    bitmap: syntheticPage(8, { a: 255 }),
  });
  t.ok('coarsest albedo page ingests', authority.getReport().ingest.pagesIngested === 1);

  // --- derivation from real ingest: the left half is covered ---------------
  const cover0 = authority.getDerived('coverAbove', 0);
  const gridW = cover0.grid.spec.w;
  t.ok(
    'upstairs floor art covers the ground floor’s left half',
    cover0.grid.data[Math.floor(cover0.grid.spec.h / 2) * gridW + 1] === 255
  );
  t.ok(
    '…and not the right half',
    cover0.grid.data[Math.floor(cover0.grid.spec.h / 2) * gridW + Math.floor(gridW * 0.75)] === 0
  );
  t.ok(
    'ingested item left the missing list',
    !cover0.completeness.missingItemIds.includes('level:L1:background') &&
      cover0.completeness.missingItemIds.includes('tile:T1')
  );
  t.ok(
    'upstairs has nothing above it',
    authority.getDerived('coverAbove', 1).grid.data.every((v) => v === 0)
  );

  // --- sampleWorld: 0..1 with absence semantics ----------------------------
  t.ok('sampleWorld reads cover 1.0 under the upstairs floor', authority.sampleWorld('coverAbove', 0, 25, 50) === 1);
  t.ok('sampleWorld reads sky 0.0 under the upstairs floor', authority.sampleWorld('skyReach', 0, 25, 50) === 0);
  t.ok('sampleWorld reads open sky on the uncovered side', authority.sampleWorld('skyReach', 0, 75, 50) === 1);
  t.ok(
    'outside the scene rect the catalog absent value answers',
    authority.sampleWorld('skyReach', 0, -50, 50) === 1 && authority.sampleWorld('coverAbove', 0, -50, 50) === 0
  );
  t.ok('an unknown floor serves the absent value, never throws', authority.sampleWorld('skyReach', 99, 10, 10) === 1);

  // --- authored outdoors via the packed trio's G channel -------------------
  authority.ingestDecodedPage({
    ownerId: 'level:L0:background',
    layerName: PACKED_TRIO_LAYER_NAME,
    table,
    page: { mip: 3, px: 0, py: 0 },
    contentWindow: fullWindow(8),
    bitmap: syntheticPage(8, { g: 0 }), // painted fully INDOORS
  });
  t.ok('authored indoors kills skyReach even where nothing covers', authority.sampleWorld('skyReach', 0, 75, 50) === 0);
  const report = authority.getReport();
  t.ok('report shows outdoors as authored on L0', report.floors[0].derived.completeness.outdoorsSource === 'authored');
  t.ok(
    'report shows the derived percentages',
    typeof report.floors[0].derived.skyReachPct === 'number' && report.floors[0].derived.skyReachPct === 0
  );
  t.ok('report labels absent kinds default(<value>)', report.floors[0].authored.tree === 'default(0)');
  t.ok('report labels authored kinds by URL', String(report.floors[0].authored.specular).includes('base_Specular.png'));

  // --- versioning: reads are always fresh ----------------------------------
  const v1 = authority.getDerived('coverAbove', 0).version;
  authority.ingestDecodedPage({
    ownerId: 'tile:T1',
    layerName: 'albedo',
    table,
    page: { mip: 3, px: 0, py: 0 },
    contentWindow: fullWindow(8),
    bitmap: syntheticPage(8),
  });
  const after = authority.getDerived('coverAbove', 0);
  t.ok('a new ingest produces a new product version', after.version > v1);
  t.ok('tile alpha now covers the top-right quadrant', after.grid.data[1 * gridW + Math.floor(gridW * 0.75)] === 255);

  // --- setItems: removed items drop their ingested content -----------------
  authority.setItems(items.filter((i) => i.id !== 'tile:T1'));
  t.ok('removing an item drops its ingest', authority.getReport().ingestedContentGrids === 2);
  t.ok(
    'cover recomputes without the removed item',
    authority.getDerived('coverAbove', 0).grid.data[1 * gridW + Math.floor(gridW * 0.75)] === 0
  );

  // --- extraction failure: loud, bounded, never fatal ----------------------
  const failing = createMaskAuthority({
    readPageImageData: () => {
      throw new Error('synthetic pixel failure');
    },
    log,
  });
  failing.reset({
    sceneKey: 'f',
    dimensions: { width: 10, height: 10 },
    floors: [{ index: 0, id: 'L0', name: 'x', ceilingElevation: 5 }],
    items: [
      { id: 'level:L0:background', kind: 'levelBackground', levelId: 'L0', hidden: false, key: { elevation: 0 } },
    ],
    resolvePlacement: () => ({ x: 5, y: 5, width: 10, height: 10 }),
  });
  failing.ingestDecodedPage({
    ownerId: 'level:L0:background',
    layerName: 'albedo',
    table,
    page: { mip: 3, px: 0, py: 0 },
    contentWindow: fullWindow(8),
    bitmap: syntheticPage(8),
  });
  const failReport = failing.getReport();
  t.ok(
    'extract failures are counted AND carried in the report',
    failReport.ingest.extractErrorCount === 1 &&
      failReport.ingest.extractErrors[0].error.includes('synthetic pixel failure')
  );
  t.ok(
    'extract failures reach the log door',
    logged.errors.some((e) => e.includes('synthetic pixel failure'))
  );
  t.ok('a failing ingest still leaves the authority serving', failing.sampleWorld('skyReach', 0, 5, 5) === 1);
}
