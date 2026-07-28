/**
 * mask-catalog.test.mjs — the catalog is DATA with an executable contract
 * (the passes.js discipline): malformed declarations fail HERE, at build
 * time, never as a runtime surprise. Also pins the assembly policy both the
 * torture fixture and real-scene discovery share.
 */
import {
  MASK_KINDS,
  DERIVED_KINDS,
  PACKED_TRIO_LAYER_NAME,
  validateMaskCatalog,
  maskKindById,
  packedTrioKinds,
  assembleLayerDescriptors,
  extractionPlanForLayer,
  rasterizedKinds,
  wantedContentIds,
} from '../mask-catalog.js';

export async function run(t) {
  // --- the shipped catalog is valid ---------------------------------------
  const real = validateMaskCatalog();
  t.ok('shipped catalog validates clean', real.ok && real.errors.length === 0);

  // --- the author-confirmed taxonomy is pinned (a regression here means the
  // packing decision changed without anyone noticing) ----------------------
  const trio = packedTrioKinds();
  t.ok(
    'packed trio is shadow/outdoors/fire on r/g/b',
    trio && trio.r.id === 'shadow' && trio.g.id === 'outdoors' && trio.b.id === 'fire'
  );
  t.ok(
    'window kind carries the V2 aliases',
    maskKindById('window').suffixes.includes('_Windows') && maskKindById('window').suffixes.includes('_Structural')
  );
  t.ok('outdoors defaults to fully-outdoors when absent', maskKindById('outdoors').absentValue === 1);
  t.ok('shadow defaults to fully-lit when absent', maskKindById('shadow').absentValue === 1);
  t.ok(
    'outdoors is REQUIRED (2026-07-21 author directive) — absence throws rather than silently serving absentValue',
    maskKindById('outdoors').required === true
  );
  t.ok(
    'no OTHER kind is required — outdoors is a deliberately narrow exception, not a blanket policy',
    MASK_KINDS.filter((k) => k.id !== 'outdoors').every((k) => !k.required)
  );

  const badRequired = validateMaskCatalog(
    [
      {
        id: 'alpha',
        suffixes: ['_A'],
        channels: 'gray',
        packChannel: null,
        absentValue: 0,
        required: 'yes', // must be a boolean
        meaning: 'x'.repeat(20),
      },
    ],
    []
  );
  t.ok(
    'a non-boolean required flag is rejected',
    !badRequired.ok && badRequired.errors.some((e) => e.includes('required must be a boolean'))
  );

  // --- `rasterize`: the authority serves this AUTHORED kind's own grid -----
  // (2026-07-25, Water.md Phase 2a. Before this flag the extraction set was
  // "whatever a DERIVED kind names", so `outdoors` rode along only because
  // `skyReach` consumes it — and `water`, whose only consumer is a GPU bake,
  // was never extracted at all.)
  // `fluid` joined 2026-07-26 (Fluid.md Phase 1): its consumer is the CPU
  // tube-net extractor, which is the same "some CONSUMER needs this authored
  // grid directly" case — a GPU bake and a CPU extractor are both consumers,
  // and neither is named by any DerivedKind.
  // `specular` joined 2026-07-26 (Specular.md §7): a THIRD flavour of the same
  // "some CONSUMER needs this authored grid directly" case, and the one that
  // shows the flag is about consumers rather than about data. It needs the
  // grid's SPEC (the world rect the authored file covers, which is what maps
  // positionWorld to a mask UV), not the grid's contents — and its contents
  // are in fact NOT usable as presence, since extraction serves R only and a
  // blue-painted steel object has r = 0. See the kind's own comment.
  // `window` joined 2026-07-27 (Windows.md §7.4), for the IDENTICAL reason as
  // specular: the surface subsystem needs the grid's SPEC only, to crop a
  // bounded quad to the mask's world rect — the COLOUR (what makes this a
  // light cookie at all) comes from the authored file, not from this grid.
  t.ok(
    'outdoors, specular, window, water and fluid are the rasterized kinds',
    rasterizedKinds()
      .map((k) => k.id)
      .join(',') === 'outdoors,specular,window,water,fluid'
  );
  t.ok(
    'water is NOT required — an unpainted _Water mask is a harmless default, unlike _Outdoors',
    maskKindById('water').rasterize === true && !maskKindById('water').required
  );
  t.ok(
    'a rasterized kind is extracted even though NO derived kind names it as an input',
    !DERIVED_KINDS.some((d) => d.inputs.includes('water')) && wantedContentIds().has('water')
  );
  t.ok(
    'extractionPlanForLayer now yields a plan for the water layer (it yielded none before the flag)',
    extractionPlanForLayer('water').length === 1 && extractionPlanForLayer('water')[0].contentId === 'water'
  );
  t.ok(
    'water extracts its R channel — depth AND presence ride there (see the kind`s own meaning)',
    extractionPlanForLayer('water')[0].channel === 'r'
  );
  t.ok(
    'a kind that is neither rasterized nor a derivation input is still not extracted',
    !maskKindById('bush').rasterize && extractionPlanForLayer('bush').length === 0
  );

  const badRasterize = validateMaskCatalog(
    [
      {
        id: 'alpha',
        suffixes: ['_A'],
        channels: 'gray',
        packChannel: null,
        absentValue: 0,
        rasterize: 'yes', // must be a boolean
        meaning: 'x'.repeat(20),
      },
    ],
    []
  );
  t.ok(
    'a non-boolean rasterize flag is rejected',
    !badRasterize.ok && badRasterize.errors.some((e) => e.includes('rasterize must be a boolean'))
  );

  // --- validation actually bites ------------------------------------------
  const dupSuffix = validateMaskCatalog(
    [
      {
        id: 'alpha',
        suffixes: ['_Same'],
        channels: 'gray',
        packChannel: null,
        absentValue: 0,
        meaning: 'x'.repeat(20),
      },
      { id: 'beta', suffixes: ['_Same'], channels: 'gray', packChannel: null, absentValue: 0, meaning: 'x'.repeat(20) },
    ],
    []
  );
  t.ok('duplicate suffix rejected', !dupSuffix.ok && dupSuffix.errors.some((e) => e.includes("'_Same'")));

  const partialTrio = validateMaskCatalog(
    [
      { id: 'alpha', suffixes: ['_A'], channels: 'gray', packChannel: 'r', absentValue: 0, meaning: 'x'.repeat(20) },
      { id: 'beta', suffixes: ['_B'], channels: 'gray', packChannel: 'g', absentValue: 0, meaning: 'x'.repeat(20) },
    ],
    []
  );
  t.ok(
    'incomplete pack trio rejected',
    !partialTrio.ok && partialTrio.errors.some((e) => e.includes('trio incomplete'))
  );

  const colorPacked = validateMaskCatalog(
    [{ id: 'alpha', suffixes: ['_A'], channels: 'color', packChannel: 'r', absentValue: 0, meaning: 'x'.repeat(20) }],
    []
  );
  t.ok(
    'non-gray kind cannot channel-pack',
    !colorPacked.ok && colorPacked.errors.some((e) => e.includes('may channel-pack'))
  );

  const badDerived = validateMaskCatalog(MASK_KINDS, [
    { id: 'mystery', inputs: ['nonexistent'], absentValue: 0, meaning: 'x'.repeat(20) },
  ]);
  t.ok(
    'derived kind with unknown input rejected',
    !badDerived.ok && badDerived.errors.some((e) => e.includes("'nonexistent'"))
  );

  const reversed = validateMaskCatalog(MASK_KINDS, [...DERIVED_KINDS].reverse());
  t.ok('derived declaration order IS evaluation order (skyReach cannot precede coverAbove)', !reversed.ok);

  const badAbsent = validateMaskCatalog(
    [{ id: 'alpha', suffixes: ['_A'], channels: 'gray', packChannel: null, absentValue: 2, meaning: 'x'.repeat(20) }],
    []
  );
  t.ok('absentValue outside 0..1 rejected', !badAbsent.ok);

  // --- assembly policy: pack IFF all three exist --------------------------
  const full = assembleLayerDescriptors(
    new Map([
      ['shadow', 'u/S.png'],
      ['outdoors', 'u/O.png'],
      ['fire', 'u/F.png'],
      ['specular', 'u/Sp.png'],
      ['water', 'u/W.png'],
    ])
  );
  const packed = full.find((d) => d.channelUrls);
  t.ok('full trio packs into one layer', packed && packed.name === PACKED_TRIO_LAYER_NAME);
  t.ok(
    'packed channels map r=shadow g=outdoors b=fire',
    packed.channelUrls.r === 'u/S.png' && packed.channelUrls.g === 'u/O.png' && packed.channelUrls.b === 'u/F.png'
  );
  t.ok('trio members never ALSO ship as singles', !full.some((d) => ['shadow', 'outdoors', 'fire'].includes(d.name)));
  t.ok('non-trio kinds ship unpacked', full.some((d) => d.name === 'specular') && full.some((d) => d.name === 'water'));

  const partial = assembleLayerDescriptors({ outdoors: 'u/O.png', tree: 'u/T.png' });
  t.ok(
    'partial trio ships found members as ordinary singles',
    partial.some((d) => d.name === 'outdoors' && d.url === 'u/O.png')
  );
  t.ok('partial trio produces NO packed layer', !partial.some((d) => d.channelUrls));
  t.ok('absent kinds produce no descriptor at all', !partial.some((d) => d.name === 'specular'));

  // --- extraction plans follow the derived kinds' declared inputs ---------
  t.ok(
    'albedo extraction = its alpha',
    JSON.stringify(extractionPlanForLayer('albedo')) === JSON.stringify([{ contentId: 'albedo', channel: 'a' }])
  );
  const trioPlan = extractionPlanForLayer(PACKED_TRIO_LAYER_NAME);
  t.ok(
    'trio extraction takes ONLY what derivations read (outdoors from g)',
    trioPlan.length === 1 && trioPlan[0].contentId === 'outdoors' && trioPlan[0].channel === 'g'
  );
  const singleOutdoors = extractionPlanForLayer('outdoors');
  t.ok('unpacked outdoors extracts its r channel', singleOutdoors.length === 1 && singleOutdoors[0].channel === 'r');
  // `tree`/`bush` are the remaining kinds nothing consumes on the CPU: no
  // DerivedKind names them and neither is `rasterize`. (This assertion used
  // `specular` until 2026-07-26 and `window` until 2026-07-27 — each in turn
  // became a rasterized kind. The claim being tested is about the EXTRACTION
  // RULE, not about any one kind, so it keeps moving to whichever kind still
  // exercises the zero case.)
  t.ok('layers no derivation reads extract nothing', extractionPlanForLayer('tree').length === 0);
  t.ok(
    'a rasterized COLOUR kind does get extracted (specular, added with its own consumer)',
    extractionPlanForLayer('specular').length === 1 && extractionPlanForLayer('specular')[0].channel === 'r'
  );
  t.ok(
    'window is the SAME shape as specular: rasterized for its SPEC, extracted anyway (R, unused)',
    extractionPlanForLayer('window').length === 1 && extractionPlanForLayer('window')[0].channel === 'r'
  );
  t.ok('unknown layers extract nothing', extractionPlanForLayer('albedoX').length === 0);
}
