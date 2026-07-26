/**
 * mask-discovery.test.mjs — the pure matching/candidate logic plus the full
 * discovery flow with injected IO. The load-bearing claims: listing beats
 * probing, aliases resolve to canonical kinds, every degraded path is
 * RECORDED (method + failures + probe count), and one run never repeats a
 * network question.
 */
import { splitArtUrl, matchMaskFiles, candidateUrls, isAbsoluteUrl, discoverAuthoredMasks } from '../mask-discovery.js';
import { maskKindById } from '../../scene/index.js';

export async function run(t) {
  // --- splitArtUrl ---------------------------------------------------------
  const split = splitArtUrl('worlds/my%20world/floors/ground.webp?v=3');
  t.ok(
    'splitArtUrl separates dir/base/ext and drops the query',
    split.dir === 'worlds/my%20world/floors' && split.base === 'ground' && split.ext === 'webp'
  );
  t.ok(
    'splitArtUrl handles bare filenames',
    splitArtUrl('map.png').dir === '' && splitArtUrl('map.png').base === 'map'
  );
  t.ok('splitArtUrl rejects extensionless paths', splitArtUrl('worlds/thing') === null);
  t.ok(
    'isAbsoluteUrl distinguishes hosted art',
    isAbsoluteUrl('https://assets.forge-vtt.com/x/map.webp') && !isAbsoluteUrl('worlds/map.webp')
  );

  // --- matchMaskFiles ------------------------------------------------------
  const listed = [
    'floors/ground_Outdoors.webp',
    'floors/ground_Shadow.png',
    'floors/Ground_Fire.WEBP', // wrong case — servers serve it anyway
    'floors/ground_Windows.png', // V2 alias for the window kind
    'floors/ground_Specular.png',
    'floors/ground_Specular.webp', // duplicate kind, two extensions
    'floors/groundling_Outdoors.webp', // different base — must NOT match
    'floors/ground_Outdoors.txt', // not an image extension
    'floors/notes.txt',
  ];
  const match = matchMaskFiles(listed, 'ground', 'webp');
  t.ok('canonical suffixes match', match.found.get('outdoors') === 'floors/ground_Outdoors.webp');
  t.ok('case differences do not manufacture missing masks', match.found.get('fire') === 'floors/Ground_Fire.WEBP');
  t.ok('V2 alias files resolve to the canonical kind', match.found.get('window') === 'floors/ground_Windows.png');
  t.ok(
    'alias use is recorded for the report',
    match.aliasesUsed.some((a) => a.startsWith('window←_Windows'))
  );
  t.ok('art extension wins a duplicate-kind tie', match.found.get('specular') === 'floors/ground_Specular.webp');
  t.ok(
    'longer base names never leak into shorter ones',
    ![...match.found.values()].includes('floors/groundling_Outdoors.webp')
  );
  t.ok('non-image extensions are ignored', match.found.get('outdoors') !== 'floors/ground_Outdoors.txt');
  t.ok('absent kinds are simply absent', !match.found.has('tree') && !match.found.has('water'));

  // ART-VARIANT FALLBACK (2026-07-25) — the author's own bridge map: the ground
  // floor's art is a `_WaterHard` VARIANT while its masks are named for the
  // shorter base. Strict matching reported the REQUIRED outdoors mask missing
  // and silently disabled every sun shadow on the scene, for a file sitting
  // right beside the art.
  {
    const bridgeFiles = [
      'a/Tower_Bridge_Underground_Outdoors.webp',
      'a/Tower_Bridge_Middle_Outdoors.webp',
      'a/Tower_Bridge_Middle_Overhead_Outdoors.webp',
    ];
    const variant = matchMaskFiles(bridgeFiles, 'Tower_Bridge_Underground_WaterHard', 'webp');
    t.ok(
      'an art VARIANT still finds the mask named for its shorter base',
      variant.found.get('outdoors') === 'a/Tower_Bridge_Underground_Outdoors.webp'
    );
    t.ok(
      'and the looser match is REPORTED, never silently identical to a strict one',
      variant.baseFallbacksUsed.some((s) => s.startsWith('outdoors←base:'))
    );

    // The load-bearing safety property: an EXACT match must always win, or
    // `Tower_Bridge_Middle_Overhead` would wrongly adopt the deck's own mask.
    const exact = matchMaskFiles(bridgeFiles, 'Tower_Bridge_Middle_Overhead', 'webp');
    t.ok(
      'an exact-base match still wins over any shortened one',
      exact.found.get('outdoors') === 'a/Tower_Bridge_Middle_Overhead_Outdoors.webp'
    );
    t.ok('and reports no fallback when it matched exactly', exact.baseFallbacksUsed.length === 0);

    // Never shorten to a single token — `Tower` must not adopt `Tower_Outdoors`.
    const tooShort = matchMaskFiles(['a/Tower_Outdoors.webp'], 'Tower_Bridge_Underground', 'webp');
    t.ok('shortening stops before a bare first token', !tooShort.found.has('outdoors'));
  }

  const encoded = matchMaskFiles(['floors/old%20mill_Outdoors.webp'], 'old mill', 'webp');
  t.ok(
    'URL-encoded listings match decoded art base names',
    encoded.found.get('outdoors') === 'floors/old%20mill_Outdoors.webp'
  );

  // --- candidateUrls -------------------------------------------------------
  const art = { dir: 'maps', base: 'castle', ext: 'png' };
  const outdoorsCandidates = candidateUrls(art, maskKindById('outdoors'));
  t.ok(
    'probe candidates try the art extension first',
    outdoorsCandidates[0] === 'maps/castle_Outdoors.png' && outdoorsCandidates[1] === 'maps/castle_Outdoors.webp'
  );
  const windowCandidates = candidateUrls(art, maskKindById('window'));
  t.ok(
    'probe candidates cover every alias suffix',
    windowCandidates.some((u) => u.includes('_Windows.')) && windowCandidates.some((u) => u.includes('_Structural.'))
  );

  // --- discoverAuthoredMasks: listing path ---------------------------------
  const listingCalls = [];
  const resultListing = await discoverAuthoredMasks({
    floors: [
      { index: 0, id: 'L0', url: 'maps/base.webp' },
      { index: 1, id: 'L1', url: 'maps/upper.webp' }, // same directory — ONE browse
    ],
    listDirectory: async (dir) => {
      listingCalls.push(dir);
      return ['maps/base_Outdoors.webp', 'maps/base_Shadow.webp', 'maps/base_Fire.webp', 'maps/upper_Outdoors.webp'];
    },
    probeUrl: async () => {
      throw new Error('probe must not run when listing works');
    },
  });
  t.ok(
    'listing discovery finds per-floor kinds',
    resultListing.byTargetId.get('L0')?.size === 3 && resultListing.byTargetId.get('L1')?.size === 1
  );
  t.ok('one directory = one browse, however many floors share it', listingCalls.length === 1);
  t.ok(
    'listing runs report method=listing, zero probes',
    resultListing.method === 'listing' && resultListing.probesAttempted === 0
  );

  // --- discoverAuthoredMasks: probe fallback (absolute URL) ----------------
  const probed = [];
  const resultProbe = await discoverAuthoredMasks({
    floors: [{ index: 0, id: 'L0', url: 'https://cdn.example/x/castle.webp' }],
    listDirectory: async () => {
      throw new Error('listing must not run for absolute URLs');
    },
    probeUrl: async (url) => {
      probed.push(url);
      return url.endsWith('castle_Outdoors.webp');
    },
  });
  t.ok('absolute-URL floors go straight to probing', resultProbe.method === 'probe');
  t.ok(
    'probing finds what exists',
    resultProbe.byTargetId.get('L0')?.get('outdoors') === 'https://cdn.example/x/castle_Outdoors.webp'
  );
  t.ok('probe count is reported truthfully', resultProbe.probesAttempted === probed.length && probed.length > 0);
  t.ok('a found kind stops probing its remaining candidates', !probed.some((u) => u.endsWith('castle_Outdoors.png')));

  // --- discoverAuthoredMasks: listing DENIED → fallback, recorded ----------
  const resultDenied = await discoverAuthoredMasks({
    floors: [{ index: 0, id: 'L0', url: 'maps/base.webp' }],
    listDirectory: async () => null, // browse unavailable/denied
    probeUrl: async (url) => url.endsWith('base_Shadow.webp'),
  });
  t.ok(
    'denied listing is a RECORDED failure, not a silent probe',
    resultDenied.failures.some((f) => f.stage === 'listing')
  );
  t.ok(
    'denied listing still discovers via probes',
    resultDenied.byTargetId.get('L0')?.get('shadow') === 'maps/base_Shadow.webp'
  );

  // --- discoverAuthoredMasks: listing THROWS → failure + fallback ----------
  const resultThrew = await discoverAuthoredMasks({
    floors: [{ index: 0, id: 'L0', url: 'maps/base.webp' }],
    listDirectory: async () => {
      throw new Error('EPERM synthetic');
    },
    probeUrl: async () => false,
  });
  t.ok(
    'a throwing lister is recorded with its actual error',
    resultThrew.failures.some((f) => f.stage === 'listing' && f.detail.includes('EPERM synthetic'))
  );
  t.ok('a floor with nothing found is an EMPTY result, not an entry of nulls', !resultThrew.byTargetId.has('L0'));

  // --- unparseable art URLs ------------------------------------------------
  const resultBad = await discoverAuthoredMasks({
    floors: [{ index: 0, id: 'L0', url: 'no-extension' }],
    listDirectory: async () => [],
    probeUrl: async () => true,
  });
  t.ok(
    'unparseable art is a parse failure with method none',
    resultBad.failures.some((f) => f.stage === 'parse') && resultBad.perFloor[0].method === 'none'
  );

  // --- mixed-method runs ---------------------------------------------------
  const resultMixed = await discoverAuthoredMasks({
    floors: [
      { index: 0, id: 'L0', url: 'maps/base.webp' },
      { index: 1, id: 'L1', url: 'https://cdn.example/upper.webp' },
    ],
    listDirectory: async () => ['maps/base_Outdoors.webp'],
    probeUrl: async (url) => url.endsWith('upper_Outdoors.webp'),
  });
  t.ok('mixed listing+probe runs say so', resultMixed.method === 'mixed');

  // --- onProgress: the loading-screen seam (LOAD_PHASES.MASKS) -------------
  {
    const ticks = [];
    await discoverAuthoredMasks({
      floors: [
        { index: 0, id: 'L0', name: 'Ground Floor', url: 'maps/base.webp' },
        { index: 1, id: 'L1', name: 'Middle Floor', url: 'maps/upper.webp' },
      ],
      listDirectory: async () => ['maps/base_Outdoors.webp'],
      probeUrl: async () => false,
      onProgress: (p) => ticks.push(p),
    });
    t.ok('onProgress fires once PER FLOOR, not per directory/candidate', ticks.length === 2);
    t.ok('done counts up monotonically to total', ticks[0].done === 1 && ticks[1].done === 2);
    t.ok('total is the floor count, stable across ticks', ticks[0].total === 2 && ticks[1].total === 2);
    t.ok(
      'detail prefers the floor NAME over its raw id',
      ticks[0].detail === 'Ground Floor' && ticks[1].detail === 'Middle Floor'
    );
  }
  {
    // The early-continue (unparseable URL) branch is a real floor too — a
    // caller counting "3 of 5" must not stall at "2 of 5" forever because one
    // floor took the exceptional path.
    const ticks = [];
    await discoverAuthoredMasks({
      floors: [
        { index: 0, id: 'L0', url: 'no-extension' },
        { index: 1, id: 'L1', name: 'Roof', url: 'maps/roof.webp' },
      ],
      listDirectory: async () => [],
      probeUrl: async () => false,
      onProgress: (p) => ticks.push(p),
    });
    t.ok('the parse-failure branch still advances progress', ticks.length === 2);
    t.ok('detail falls back to the levelId when no name was given', ticks[0].detail === 'L0');
  }
  {
    // onProgress is optional — omitting it must never throw.
    const result = await discoverAuthoredMasks({
      floors: [{ index: 0, id: 'L0', url: 'maps/base.webp' }],
      listDirectory: async () => [],
      probeUrl: async () => false,
    });
    t.ok('onProgress is optional; its absence does not break discovery', result.perFloor.length === 1);
  }
}
