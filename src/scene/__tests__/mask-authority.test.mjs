/**
 * mask-authority.test.mjs — the hub's contract: serving carries provenance,
 * ingest filters to the coarsest mip, derivation is lazy-but-always-fresh,
 * and every degraded state is REPORTED (instruments must not lie).
 *
 * Browser bits (bitmap pixel access) are injected, so the whole lifecycle —
 * reset → discovery → ingest → derive → sample → report — runs under Node.
 */
import { createMaskAuthority, RequiredMaskMissingError } from '../mask-authority.js';
import { PACKED_TRIO_LAYER_NAME, CASTER_HEIGHT_SCALE_PX } from '../mask-catalog.js';

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
    byTargetId: new Map([
      // Keyed by the BACKGROUND ITEM's own id, not the raw level id 'L0' —
      // discovery is now uniform across all three item kinds (2026-07-26,
      // keyhole-mask-any-item-decision); `authoredStatus('L0', ...)` resolves
      // this same key internally by finding the level's background item.
      [
        'level:L0:background',
        new Map([
          ['shadow', 'art/base_Shadow.png'],
          ['outdoors', 'art/base_Outdoors.png'],
          ['fire', 'art/base_Fire.png'],
          ['specular', 'art/base_Specular.png'],
        ]),
      ],
      // A Tile's OWN discovered masks ride the SAME result, keyed by its own
      // item id — this is what boot.js's real discovery run already produces
      // once a Tile is included as a discovery target.
      ['tile:T1', new Map([['specular', 'art/tile_Specular.png']])],
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
  t.ok(
    'a Tile with its own discovered mask streams it too now (2026-07-26, keyhole-mask-any-item-decision) — ' +
      'layersForItem is no longer background-only',
    authority.layersForItem(items[2]).some((d) => d.name === 'specular' && d.url === 'art/tile_Specular.png')
  );
  t.ok('a token, never a discovery target, still streams albedo alone', authority.layersForItem(items[3]).length === 0);
  const postStatus = authority.authoredStatus('L0', 'outdoors');
  t.ok(
    'authored outdoors serves its URL with provenance',
    postStatus.source === 'authored' && postStatus.url === 'art/base_Outdoors.png'
  );

  // --- authoredStatusForItem: the ITEM-keyed discovery-URL door ------------
  // (docs/planning/Specular.md §9 / keyhole-mask-any-item-decision — a Tile
  // can carry its own mask file beside its own art, discovered the same way
  // as a floor's. This block tests ONLY the discovery-URL query itself —
  // "which file, if any, did discovery find beside THIS item's art". The
  // composited GRID (getDerived/sampleWorld) is a separate question, tested
  // in the "ANY ITEM IS A MASK HOST" block below: that grid DOES merge every
  // host's paint together now, but this query never did and still doesn't —
  // it just answers for one specific item at a time.)
  const tileSpecular = authority.authoredStatusForItem('tile:T1', 'specular');
  t.ok(
    "a Tile with its own discovered mask serves its OWN url, independent of any floor's",
    tileSpecular.source === 'authored' && tileSpecular.url === 'art/tile_Specular.png'
  );
  t.ok(
    "the floor's own specular mask is queried independently and returns its own url",
    authority.authoredStatus('L0', 'specular').url === 'art/base_Specular.png'
  );
  t.ok(
    'a kind never discovered for that item serves the default, same shape as the floor door',
    authority.authoredStatusForItem('tile:T1', 'water').source === 'default'
  );
  t.ok(
    'an item with no discovery entry at all serves the default too, never throws',
    authority.authoredStatusForItem('tile:unknown', 'specular').source === 'default'
  );
  t.throws(
    'unknown authored kind throws toward the catalog, same as authoredStatus',
    () => authority.authoredStatusForItem('tile:T1', 'nonsense'),
    'mask-catalog'
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

  // --- sampleWorld also serves the RAW authored 'outdoors' value (2026-07-21):
  // an AUTHORED kind id, not a DERIVED one — this is new; it used to throw. --
  t.ok(
    'sampleWorld now accepts an AUTHORED kind id (outdoors), not just derived ones',
    authority.sampleWorld('outdoors', 0, 25, 50) === 1 // no outdoors mask ingested yet -> absent value (1)
  );
  t.throws(
    'a truly unknown id (neither authored nor derived) still throws toward the catalog',
    () => authority.sampleWorld('nonsense', 0, 10, 10),
    'mask-catalog'
  );
  t.throws(
    'getDerived also still throws on a truly unknown id',
    () => authority.getDerived('nonsense', 0),
    'mask-catalog'
  );

  // ------------------------------------------------------------------
  // REQUIRED MASK, GENUINELY NEVER DISCOVERED (2026-07-21, author directive:
  // "the outdoors mask is a requirement not an option... if no outdoors mask
  // is discovered then you need to just fail"). L1 was NEVER given a
  // discovery entry for anything (setDiscovery above only covers L0) — this
  // is the "no file was ever found" case, deliberately distinct from L0's own
  // "found, not yet ingested" state exercised just above (which correctly
  // does NOT throw — see the assertions right below this block).
  // ------------------------------------------------------------------
  {
    let thrown = null;
    try {
      authority.sampleWorld('outdoors', 1, 25, 50);
    } catch (err) {
      thrown = err;
    }
    t.ok(
      'sampleWorld THROWS for a required mask never discovered on a REAL floor',
      thrown instanceof RequiredMaskMissingError
    );
    t.ok('the thrown error names the missing kind', thrown?.kindId === 'outdoors');
    t.ok('the thrown error names the level', thrown?.levelId === 'L1');

    t.throws(
      'skyReach (DERIVED from outdoors) ALSO throws — the missing requirement propagates to what depends on it',
      () => authority.sampleWorld('skyReach', 1, 25, 50),
      'REQUIRED MASK MISSING'
    );
    t.ok(
      'coverAbove (does NOT depend on outdoors) is UNAFFECTED — the check is scoped to the real dependency, not blanket',
      authority.sampleWorld('coverAbove', 1, 25, 50) === 0
    );
    t.throws(
      'getDerived throws too, not just sampleWorld (both go through the same check)',
      () => authority.getDerived('outdoors', 1),
      'REQUIRED MASK MISSING'
    );

    // THE NARROW, NAMED OPT-OUT (2026-07-25) — a whole-field consumer that has
    // acknowledged the gap and reports it may still read the grids. Before
    // this, a scene with no interiors (and so no outdoors mask ever painted)
    // got NO sun shadows at all — not even the sky-reach shadow a bridge casts
    // on the river below it, which has nothing to do with indoor/outdoor.
    t.ok(
      'acknowledgeMissingRequired serves the product instead of throwing',
      !!authority.getDerived('outdoors', 1, { acknowledgeMissingRequired: true })?.grid
    );
    t.ok(
      'and it is genuinely opt-IN — the default call still throws, so nothing degrades by accident',
      (() => {
        try {
          authority.getDerived('outdoors', 1);
          return false;
        } catch (e) {
          return e instanceof RequiredMaskMissingError;
        }
      })()
    );

    // ⚠️ THE REGRESSION THIS PINS (found 2026-07-30, live): `casterHeight`'s
    // bytes are meaningless without `scalePx` to turn them back into world px.
    // The degraded caller (`boot.js#getCasterHeightField`'s catch branch, a
    // floor with no authored `_Outdoors`) has to call `getDerived` DIRECTLY —
    // bypassing `scene/sky-reach-access.js#heightField`, which is the wrapper
    // that used to be the ONLY place attaching `scalePx` (from its own
    // closure). That left `scalePx` `undefined` on every degraded floor's
    // caster-height read, which silently zeroed EVERY occluder's height on the
    // way out — `(maxByte/255) * (undefined ?? 0)` is always 0 — while the
    // coverage/count channels stayed healthy throughout (a floor could report
    // real overhead items with real heights in its completeness AND bake a
    // shadow field with `maxCasterHeightPx: 0`, indistinguishable from "no
    // casters at all"). `scalePx` now rides on the SAME object `channels`
    // does, so a caller that bypasses the wrapper for the required-mask
    // opt-out still gets the number its bytes depend on.
    t.ok(
      'a degraded (required-mask-acknowledged) casterHeight read still carries its real scalePx',
      authority.getDerived('casterHeight', 1, { acknowledgeMissingRequired: true })?.scalePx === CASTER_HEIGHT_SCALE_PX
    );
    t.ok(
      'scalePx is NOT attached to a kind it has no meaning for (outdoors) — it is casterHeight-specific, not a blanket field',
      authority.getDerived('outdoors', 1, { acknowledgeMissingRequired: true })?.scalePx == null
    );
  }
  // (an UNRESOLVABLE floor index, e.g. 99, still serves the absent value and
  // never throws — see the assertion above, line ~170; a bogus floorIndex is
  // a different question than "this real floor has no painted mask", and
  // that existing behaviour is deliberately unchanged by this fix.)

  // --- authored outdoors via the packed trio's G channel -------------------
  authority.ingestDecodedPage({
    ownerId: 'level:L0:background',
    layerName: PACKED_TRIO_LAYER_NAME,
    table,
    page: { mip: 3, px: 0, py: 0 },
    contentWindow: fullWindow(8),
    bitmap: syntheticPage(8, { g: 0 }), // painted fully INDOORS
  });

  // --- getIngestStatus — the THIRD provenance state (2026-07-22) ------------
  // "discovered" (a URL was found) and "ingested" (the file's actual pixels
  // were decoded) are two separate pipeline stages; a live report showed a
  // real gap between them that authoredStatus alone couldn't surface.
  {
    const l0Status = authority.getIngestStatus(0);
    t.ok('L0 (just ingested above) reports outdoorsIngested:true', l0Status.floorFound && l0Status.outdoorsIngested);
    t.ok('L0 reports the actual background item id', l0Status.backgroundItemId === 'level:L0:background');

    const l1Status = authority.getIngestStatus(1);
    t.ok(
      'L1 (never discovered, never ingested) reports outdoorsIngested:false, even though its floor DOES exist',
      l1Status.floorFound && l1Status.backgroundItemId === 'level:L1:background' && l1Status.outdoorsIngested === false
    );

    const unknownStatus = authority.getIngestStatus(99);
    t.ok(
      'an unresolvable floor index reports floorFound:false cleanly, never throws',
      unknownStatus.floorFound === false && unknownStatus.backgroundItemId === null
    );
  }

  t.ok('authored indoors kills skyReach even where nothing covers', authority.sampleWorld('skyReach', 0, 75, 50) === 0);
  t.ok(
    'the RAW outdoors value reads indoors (0) too — this is what a general wind/shelter consumer should sample, not skyReach',
    authority.sampleWorld('outdoors', 0, 75, 50) === 0
  );
  const report = authority.getReport();
  t.ok('report shows outdoors as authored on L0', report.floors[0].derived.completeness.outdoorsSource === 'authored');
  t.ok(
    'report shows the derived percentages',
    typeof report.floors[0].derived.skyReachPct === 'number' && report.floors[0].derived.skyReachPct === 0
  );
  t.ok(
    'report ALSO shows the raw outdoors percentage, separate from skyReach',
    typeof report.floors[0].derived.outdoorsPct === 'number' && report.floors[0].derived.outdoorsPct === 0
  );
  t.ok('report labels absent kinds default(<value>)', report.floors[0].authored.tree === 'default(0)');
  t.ok('report labels authored kinds by URL', String(report.floors[0].authored.specular).includes('base_Specular.png'));
  t.ok(
    'L0 (mask discovered + authored) reports NO required masks missing',
    Array.isArray(report.floors[0].requiredMasksMissing) && report.floors[0].requiredMasksMissing.length === 0
  );
  t.ok(
    "L1 (never discovered) reports 'outdoors' as required-and-missing, explicitly, not just implied",
    report.floors[1].requiredMasksMissing.includes('outdoors')
  );
  t.ok(
    "L1's authored.outdoors string says THROWS, not a stale default(1) that would misdescribe the new behaviour",
    report.floors[1].authored.outdoors.includes('THROWS')
  );

  // ------------------------------------------------------------------
  // WATER — a `rasterize: true` kind whose ONLY consumer is a GPU bake
  // (2026-07-25, Water.md Phase 2a). The whole point of this block is that
  // nothing in DERIVED_KINDS mentions water, so before the flag existed the
  // extraction plan was empty and this ingest would have been counted as
  // IGNORED. Everything below is the body pack's actual input path.
  // ------------------------------------------------------------------
  {
    const beforeWater = authority.getReport().ingest.pagesIngested;
    t.ok(
      'no floor has authored water before any water page arrives',
      authority.floorsWithAuthored('water').length === 0
    );
    // getDerived still SERVES a water grid before any ingest — absent-filled,
    // provenance 'default'. A consumer must read provenance, not emptiness.
    const preWater = authority.getDerived('water', 0);
    t.ok(
      'water serves an absent-filled grid before ingest, never null/undefined',
      !!preWater?.grid && preWater.grid.data.every((v) => v === 0)
    );

    authority.setDiscovery({
      byTargetId: new Map([
        [
          'level:L0:background',
          new Map([
            ['shadow', 'art/base_Shadow.png'],
            ['outdoors', 'art/base_Outdoors.png'],
            ['fire', 'art/base_Fire.png'],
            ['specular', 'art/base_Specular.png'],
            ['water', 'art/base_Water.png'],
          ]),
        ],
      ]),
      method: 'listing',
      failures: [],
      probesAttempted: 0,
    });
    t.ok(
      'a discovered water mask ships as its own unpacked layer (rgba kinds never channel-pack)',
      authority.layersForItem(items[0]).some((d) => d.name === 'water' && d.url === 'art/base_Water.png')
    );

    // Re-ingest outdoors: setDiscovery() touched the authority, and the packed
    // trio page above was ingested against the PREVIOUS descriptor set.
    authority.ingestDecodedPage({
      ownerId: 'level:L0:background',
      layerName: PACKED_TRIO_LAYER_NAME,
      table,
      page: { mip: 3, px: 0, py: 0 },
      contentWindow: fullWindow(8),
      bitmap: syntheticPage(8, { g: 0 }),
    });
    // R = 128: mid-depth water over L0's whole rect. R carries depth AND
    // presence — see the `water` kind's own `meaning`.
    authority.ingestDecodedPage({
      ownerId: 'level:L0:background',
      layerName: 'water',
      table,
      page: { mip: 3, px: 0, py: 0 },
      contentWindow: fullWindow(8),
      bitmap: syntheticPage(8, { r: 128 }),
    });
    t.ok(
      'the water page INGESTS (it was silently ignored before `rasterize`)',
      authority.getReport().ingest.pagesIngested === beforeWater + 2
    );

    const water0 = authority.getDerived('water', 0);
    t.ok(
      'water grid carries the mask`s R channel as depth',
      water0.grid.data.some((v) => v === 128)
    );
    t.ok(
      'sampleWorld serves water as 0..1 depth',
      Math.abs(authority.sampleWorld('water', 0, 75, 50) - 128 / 255) < 0.01
    );
    t.ok(
      'a floor with no water mask serves the absent value (0 = no water), and does NOT throw — water is not required',
      authority.sampleWorld('water', 1, 25, 50) === 0
    );

    // THE CROSS-FLOOR RULE'S INPUT (effects/water/water-floor.js). L1 has no
    // water authoring at all, so it is absent from this list and will borrow.
    t.ok(
      'floorsWithAuthored reports only the floor whose water mask actually arrived',
      authority.floorsWithAuthored('water').join(',') === '0'
    );
    t.ok(
      'floorsWithAuthored also answers for outdoors, through its own provenance field',
      authority.floorsWithAuthored('outdoors').join(',') === '0'
    );
    t.ok(
      'floorsWithAuthored for a kind nothing rasterizes is empty rather than an error',
      authority.floorsWithAuthored('bush').length === 0
    );

    // A kind that is legal in the catalog but NOT rasterized has no per-floor
    // product to serve — null, not `{grid: undefined}` (an instrument that
    // says "I have nothing" beats one that hands back a broken object).
    t.ok('a legal but unrasterized kind serves null from getDerived', authority.getDerived('bush', 0) === null);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ANY ITEM IS A MASK HOST, COMPOSITED IN DRAW ORDER (2026-07-26,
  // `keyhole-mask-any-item-decision`, LOCKED) — a Tile's own mask now
  // composites into the SAME floor grid as the background's, in draw order,
  // OVERWRITING within its own footprint (never a MAX — a later item must be
  // able to paint something DARKER too). A Level's own foreground is a host
  // too, symmetric with its background. A floor with NO background or
  // foreground at all gets full support entirely from its own tiles.
  //
  // A fresh, independent authority + fixture — the shared `authority`/`items`
  // above stay untouched so this doesn't perturb any assertion above or
  // below it.
  // ══════════════════════════════════════════════════════════════════════
  {
    const compAuthority = createMaskAuthority({ readPageImageData: (bitmap) => bitmap, log });
    const compPlacements = {
      'level:C0:background': { x: 50, y: 50, width: 100, height: 100 }, // whole floor
      'tile:hole': { x: 25, y: 50, width: 50, height: 100 }, // left half — punches a hole
      'level:C1:foreground': { x: 50, y: 50, width: 100, height: 100 },
      'tile:onlyTile': { x: 50, y: 50, width: 100, height: 100 }, // C2's ENTIRE mask
    };
    const compItems = [
      {
        id: 'level:C0:background',
        kind: 'levelBackground',
        levelId: 'C0',
        hidden: false,
        key: { elevation: 0, sortLayer: 0, sort: 0, zIndex: 0 },
      },
      // Higher elevation than the background — draws AFTER it, so it must
      // WIN wherever its own footprint reaches.
      {
        id: 'tile:hole',
        kind: 'tile',
        levelId: '',
        hidden: false,
        visibleOnLevelIds: ['C0'],
        key: { elevation: 5, sortLayer: 500, sort: 0, zIndex: 0 },
      },
      {
        id: 'level:C1:foreground',
        kind: 'levelForeground',
        levelId: 'C1',
        hidden: false,
        key: { elevation: 10, sortLayer: 0, sort: 0, zIndex: 1 },
      },
      // C2 has NO background/foreground item at all — a tiles-only floor.
      {
        id: 'tile:onlyTile',
        kind: 'tile',
        levelId: '',
        hidden: false,
        visibleOnLevelIds: ['C2'],
        key: { elevation: 0, sortLayer: 500, sort: 0, zIndex: 0 },
      },
    ];
    compAuthority.reset({
      sceneKey: 'composite-test',
      dimensions: { width: 100, height: 100, sceneRect: { x: 0, y: 0, width: 100, height: 100 } },
      floors: [
        { index: 0, id: 'C0', name: 'Ground', ceilingElevation: 10 },
        { index: 1, id: 'C1', name: 'Roofed', ceilingElevation: 20 },
        { index: 2, id: 'C2', name: 'TilesOnly', ceilingElevation: 10 },
      ],
      items: compItems,
      resolvePlacement: (item) => compPlacements[item.id],
    });
    compAuthority.setDiscovery({
      byTargetId: new Map([
        ['level:C0:background', new Map([['outdoors', 'art/c0_Outdoors.webp']])],
        ['tile:hole', new Map([['outdoors', 'art/hole_Outdoors.webp']])],
        ['level:C1:foreground', new Map([['outdoors', 'art/c1fg_Outdoors.webp']])],
        ['tile:onlyTile', new Map([['outdoors', 'art/only_Outdoors.webp']])],
      ]),
      method: 'listing',
      failures: [],
      probesAttempted: 0,
    });
    const ctable = { worldWidthPx: 100, worldHeightPx: 100, maxMip: 3 };
    compAuthority.ingestDecodedPage({
      ownerId: 'level:C0:background',
      layerName: 'outdoors',
      table: ctable,
      page: { mip: 3, px: 0, py: 0 },
      contentWindow: fullWindow(8),
      bitmap: syntheticPage(8, { r: 255 }), // fully OUTDOORS
    });
    compAuthority.ingestDecodedPage({
      ownerId: 'tile:hole',
      layerName: 'outdoors',
      table: ctable,
      page: { mip: 3, px: 0, py: 0 },
      contentWindow: fullWindow(8),
      bitmap: syntheticPage(8, { r: 0 }), // fully INDOORS — punches the hole
    });

    t.ok(
      "a Tile's own mask OVERWRITES the background's within its own footprint (left half now INDOORS)",
      compAuthority.sampleWorld('outdoors', 0, 25, 50) === 0
    );
    t.ok(
      "outside the Tile's own footprint, the background's own paint survives (right half stays OUTDOORS)",
      compAuthority.sampleWorld('outdoors', 0, 75, 50) === 1
    );
    t.ok(
      'the floor no longer reports outdoors as required-and-missing — the background alone already authors it',
      !compAuthority.getReport().floors[0].requiredMasksMissing.includes('outdoors')
    );

    compAuthority.ingestDecodedPage({
      ownerId: 'level:C1:foreground',
      layerName: 'outdoors',
      table: ctable,
      page: { mip: 3, px: 0, py: 0 },
      contentWindow: fullWindow(8),
      bitmap: syntheticPage(8, { r: 255 }),
    });
    t.ok(
      "a Level's own FOREGROUND is a mask host too, symmetric with its background",
      compAuthority.sampleWorld('outdoors', 1, 50, 50) === 1
    );

    // A tiles-only floor (C2): no background, no foreground — its ENTIRE
    // outdoors comes from its one Tile.
    compAuthority.ingestDecodedPage({
      ownerId: 'tile:onlyTile',
      layerName: 'outdoors',
      table: ctable,
      page: { mip: 3, px: 0, py: 0 },
      contentWindow: fullWindow(8),
      bitmap: syntheticPage(8, { r: 255 }),
    });
    t.ok(
      'a tiles-only floor gets its outdoors mask entirely from its own tile',
      compAuthority.sampleWorld('outdoors', 2, 50, 50) === 1
    );
    t.ok(
      'and is correctly NOT flagged as missing its required mask, despite having no background at all',
      !compAuthority.getReport().floors[2].requiredMasksMissing.includes('outdoors')
    );
  }

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

  // --- getProductsVersion — the wind-rebake poll's own cheap seam ----------
  // (2026-07-21: vt-pan-viewer.js#pollMaskAuthorityForWindRebake polls this
  // every ~500ms to detect "mask data changed" and re-bake — see that
  // function's own header for the staleness bug this closes.)
  {
    const beforeIngest = authority.getProductsVersion();
    authority.ingestDecodedPage({
      ownerId: 'tile:T1',
      layerName: 'albedo',
      table,
      page: { mip: 3, px: 0, py: 0 },
      contentWindow: fullWindow(8),
      bitmap: syntheticPage(8, { a: 128 }), // a different value, so this is a REAL content change
    });
    const afterIngest = authority.getProductsVersion();
    t.ok('getProductsVersion bumps after a real ingest', afterIngest > beforeIngest);
    t.ok(
      'getProductsVersion is stable when called twice with nothing in between (no spurious bumps)',
      authority.getProductsVersion() === afterIngest
    );
    t.ok(
      'getProductsVersion NEVER throws, even for a floor with a required-and-missing mask (L1) — ' +
        'a per-frame poll must stay safe regardless of what sampleWorld would do for that same floor',
      (() => {
        try {
          authority.getProductsVersion();
          return true;
        } catch {
          return false;
        }
      })()
    );
  }

  // --- setItems: removed items drop their ingested content -----------------
  // Counted RELATIVE to the pre-removal total, not against a literal: this
  // assertion was `=== 2` and broke the moment the water ingest above added a
  // third content grid, which is a fixture change, not a regression in the
  // behaviour under test (that behaviour is "tile:T1's one grid goes away").
  const gridsBeforeRemoval = authority.getReport().ingestedContentGrids;
  authority.setItems(items.filter((i) => i.id !== 'tile:T1'));
  t.ok(
    'removing an item drops its ingest (exactly one grid, tile:T1`s albedo)',
    authority.getReport().ingestedContentGrids === gridsBeforeRemoval - 1
  );
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
  // coverAbove, not skyReach — this authority never called setDiscovery() at
  // all, so 'outdoors' is required-and-missing here too (see the assertion
  // right below); coverAbove doesn't depend on outdoors, so it's the right
  // probe for THIS test's actual point (extraction failures don't kill the
  // authority), uncoupled from the separate required-mask policy.
  t.ok('a failing ingest still leaves the authority serving', failing.sampleWorld('coverAbove', 0, 5, 5) === 0);
  t.throws(
    "an authority that never ran discovery at all ALSO refuses to serve 'outdoors' — no discovery is " +
      'indistinguishable from "definitely no file", so this is correctly a REQUIRED MASK MISSING, not a silent 1',
    () => failing.sampleWorld('outdoors', 0, 5, 5),
    'REQUIRED MASK MISSING'
  );

  // --- getBakeStats() — perf-instrumentation-audit-2026-08-12 --------------
  // The bake-gate hit/miss counters underneath recomputeIfDirty(). Asserted
  // as DELTAS across a controlled call sequence, not absolute counts — the
  // exact number of internal recomputeIfDirty() calls reset()/setDiscovery()
  // themselves trigger is an implementation detail this test does not pin.
  {
    const gate = createMaskAuthority({ readPageImageData: (bitmap) => bitmap, log });
    gate.reset({
      sceneKey: 'bake-gate-test',
      dimensions: { width: 10, height: 10 },
      floors: [{ index: 0, id: 'L0', name: 'x', ceilingElevation: 5 }],
      items: [
        { id: 'level:L0:background', kind: 'levelBackground', levelId: 'L0', hidden: false, key: { elevation: 0 } },
      ],
      resolvePlacement: () => ({ x: 5, y: 5, width: 10, height: 10 }),
    });
    const beforeVersion = gate.getBakeStats();
    // First read after reset() — content is genuinely dirty (a real scene
    // just loaded), so this MUST cost at least one real recompute.
    gate.getProductsVersion();
    const afterFirstRead = gate.getBakeStats();
    t.ok(
      'a version read right after reset() causes at least one real bake (bakeRuns increases)',
      afterFirstRead.bakeRuns > beforeVersion.bakeRuns
    );
    // Second read, nothing changed in between — must be a skip, not a
    // second recompute of identical products.
    gate.getProductsVersion();
    const afterSecondRead = gate.getBakeStats();
    t.ok(
      'a second, redundant version read with nothing changed in between is a SKIP, not another bake',
      afterSecondRead.bakeRuns === afterFirstRead.bakeRuns && afterSecondRead.bakeSkips > afterFirstRead.bakeSkips
    );
    // A real content change (another reset()) must make the NEXT read cost a
    // real bake again — the gate is not stuck permanently skipping.
    gate.reset({
      sceneKey: 'bake-gate-test-2',
      dimensions: { width: 10, height: 10 },
      floors: [{ index: 0, id: 'L0', name: 'x', ceilingElevation: 5 }],
      items: [
        { id: 'level:L0:background', kind: 'levelBackground', levelId: 'L0', hidden: false, key: { elevation: 0 } },
      ],
      resolvePlacement: () => ({ x: 5, y: 5, width: 10, height: 10 }),
    });
    gate.getProductsVersion();
    const afterRealChange = gate.getBakeStats();
    t.ok(
      'a genuine content change (a second reset()) causes another real bake, not a permanent skip state',
      afterRealChange.bakeRuns > afterSecondRead.bakeRuns
    );
  }

  // --- getDiscoveryStats() — cache-completeness pass, 2026-08-12 -----------
  // A ONE-SHOT summary of scene.discovery, not an ongoing hit/miss pair —
  // see this method's own doc.
  {
    const disco = createMaskAuthority({ readPageImageData: (bitmap) => bitmap, log });
    disco.reset({
      sceneKey: 'discovery-stats-test',
      dimensions: { width: 10, height: 10 },
      floors: [{ index: 0, id: 'L0', name: 'x', ceilingElevation: 5 }],
      items: [
        { id: 'level:L0:background', kind: 'levelBackground', levelId: 'L0', hidden: false, key: { elevation: 0 } },
      ],
      resolvePlacement: () => ({ x: 5, y: 5, width: 10, height: 10 }),
    });
    t.ok(
      'before any setDiscovery call, getDiscoveryStats() is null, not a fabricated zero',
      disco.getDiscoveryStats() === null
    );

    disco.setDiscovery({
      byTargetId: new Map(),
      method: 'mixed',
      probesAttempted: 7,
      perFloor: [
        { targetId: 'level:L0:background', method: 'listing', found: 2, aliasesUsed: [] },
        { targetId: 'level:L1:background', method: 'probe', found: 0, aliasesUsed: [] },
      ],
      failures: [{ targetId: 'level:L1:background', stage: 'listing', detail: 'denied' }],
    });
    const full = disco.getDiscoveryStats();
    t.ok('method is read straight through', full.method === 'mixed');
    t.ok('probesAttempted is read straight through', full.probesAttempted === 7);
    t.ok('floorsDiscovered is perFloor.length (2)', full.floorsDiscovered === 2);
    t.ok('floorsWithMasks counts only entries with found > 0 (1, not 2)', full.floorsWithMasks === 1);
    t.ok('failures is failures.length (1)', full.failures === 1);

    // A partial payload (perFloor/failures absent) is a REAL shape other
    // tests in this file already construct (setDiscovery only needs
    // byTargetId/method for THEIR assertions) — must produce an honest
    // null, never throw on `.length`/`.filter` of an absent array.
    disco.setDiscovery({ byTargetId: new Map(), method: 'listing', probesAttempted: 0 });
    const partial = disco.getDiscoveryStats();
    t.ok('a partial payload does not throw', partial !== undefined);
    t.ok(
      'floorsDiscovered is null, not a crash or a fabricated 0, when perFloor is absent',
      partial.floorsDiscovered === null
    );
    t.ok('floorsWithMasks is null for the same reason', partial.floorsWithMasks === null);
    t.ok('failures is null when the field itself is absent', partial.failures === null);
  }
}
