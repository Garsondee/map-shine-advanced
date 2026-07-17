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
  t.ok('layers no derivation reads extract nothing', extractionPlanForLayer('specular').length === 0);
  t.ok('unknown layers extract nothing', extractionPlanForLayer('albedoX').length === 0);
}
