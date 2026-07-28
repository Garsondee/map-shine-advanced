/**
 * Node tests for vram-inventory.js.
 *
 * The load-bearing one is that an UNSIZED target is excluded from the total AND
 * counted, rather than contributing 0. A consumer whose size we cannot compute
 * silently adding nothing is the same class of lie as three's own
 * `isCompressedTexture -> return 1` — which is the whole reason this module
 * exists rather than just forwarding `renderer.info.memory`.
 */
import { FORMAT_CHANNELS, TYPE_BYTES, buildVramInventory, bytesPerPixel, sizeRenderTarget } from '../vram-inventory.js';

export function run(t) {
  const { ok } = t;

  // ---- bytes per pixel -----------------------------------------------------
  {
    ok('rgba half-float is 8 bytes/px', bytesPerPixel('halfFloat', 'rgba') === 8);
    ok('rgba byte is 4 bytes/px', bytesPerPixel('unsignedByte', 'rgba') === 4);
    ok('r float is 4 bytes/px', bytesPerPixel('float', 'r') === 4);
    ok('an unknown type is null, not 0', bytesPerPixel('quantum', 'rgba') === null);
    ok('an unknown format is null, not 0', bytesPerPixel('halfFloat', 'cmyk') === null);
    ok('TYPE_BYTES is frozen', Object.isFrozen(TYPE_BYTES));
    ok('FORMAT_CHANNELS is frozen', Object.isFrozen(FORMAT_CHANNELS));
  }

  // ---- sizing one target ---------------------------------------------------
  {
    const rt = sizeRenderTarget({
      name: 'v3:scene.color',
      width: 2560,
      height: 1392,
      attachments: 2,
      typeKey: 'halfFloat',
      formatKey: 'rgba',
    });
    // 2560*1392*8*2 = 57,016,320 bytes = 54.38 MB
    ok('a MRT target counts every attachment', Math.abs(rt.mb - 54.38) < 0.05);
    ok('a sized target is not flagged unsized', rt.unsized === false);
    ok('the per-pixel figure is shown so the arithmetic is checkable', rt.bytesPerPixel === 8);

    const single = sizeRenderTarget({ name: 'x', width: 100, height: 100, typeKey: 'unsignedByte', formatKey: 'rgba' });
    ok('attachments defaults to 1', single.attachments === 1);

    const unknown = sizeRenderTarget({ name: 'mystery', width: 100, height: 100, typeKey: '???', formatKey: 'rgba' });
    ok('an unsizable target reports mb null, not 0', unknown.mb === null);
    ok('...and is flagged unsized', unknown.unsized === true);

    const noDims = sizeRenderTarget({ name: 'nodims', typeKey: 'halfFloat', formatKey: 'rgba' });
    ok('a target with no dimensions is unsized, not 0 MB', noDims.mb === null && noDims.unsized === true);
  }

  // ---- the inventory -------------------------------------------------------
  {
    const inv = buildVramInventory({
      targets: [
        { name: 'v3:scene.color', width: 2560, height: 1392, attachments: 2, typeKey: 'halfFloat', formatKey: 'rgba' },
        { name: 'v3:bloom.mip0', width: 1280, height: 696, typeKey: 'halfFloat', formatKey: 'rgba' },
        { name: 'v3:mystery', width: 64, height: 64, typeKey: 'unknown', formatKey: 'rgba' },
      ],
      rendererInfo: {
        memory: { textures: 214, texturesSize: 41.2 * 1024 * 1024, renderTargets: 13, total: 58.9 * 1024 * 1024 },
      },
      vtEstimate: { estTextureVramMB: 512.3 },
      ceilingMb: 2500,
    });

    ok('targets are sorted heaviest first', inv.renderTargets.items[0].name === 'v3:scene.color');
    ok('the unsized target is counted', inv.renderTargets.unsizedCount === 1);
    ok('...and named as unmeasured, not free', inv.renderTargets.unsizedNote.includes('not free'));
    ok('...and excluded from namedMb', inv.renderTargets.namedMb < 70);

    ok("three's number is reported", inv.threeInfoMemory.texturesSizeMb === 41.2);
    ok('...with the compressed-texture caveat attached inline', inv.threeInfoMemory.caveat.includes('ONE BYTE'));
    ok('...and the caveat points at the honest alternative', inv.threeInfoMemory.caveat.includes('vtEstimateMb'));

    ok('the VT atlas estimate dominates the total, as it should', inv.vtEstimateMb === 512.3);
    ok('the total combines named targets and the atlas', inv.estimatedTotalMb > 512);
    ok('headroom is computed against the measured ceiling', inv.headroomFraction > 0.7);
    ok("plenty of headroom verdicts 'ok'", inv.verdict === 'ok');
    ok('the note admits it is an estimate against a measured wall', inv.note.includes('ESTIMATE'));
  }

  // ---- verdict bands and honest absences -----------------------------------
  {
    const tight = buildVramInventory({ vtEstimate: { estTextureVramMB: 1900 }, ceilingMb: 2500 });
    ok("75% used verdicts 'tight'", tight.verdict === 'tight');

    const critical = buildVramInventory({ vtEstimate: { estTextureVramMB: 2300 }, ceilingMb: 2500 });
    ok("92% used verdicts 'critical'", critical.verdict === 'critical');

    const noCeiling = buildVramInventory({ vtEstimate: { estTextureVramMB: 512 } });
    ok("no known ceiling verdicts 'unknown', never 'ok'", noCeiling.verdict === 'unknown');
    ok('no known ceiling gives null headroom, not 0', noCeiling.headroomFraction === null);

    const empty = buildVramInventory({});
    ok('an empty inventory has null totals, not 0', empty.estimatedTotalMb === null);
    ok('an empty inventory has null namedMb, not 0', empty.renderTargets.namedMb === null);
    ok('no renderer info gives null, not an empty object of zeros', empty.threeInfoMemory === null);
    ok('a missing VT estimate is called out as a missing consumer', empty.vtEstimateNote.includes('missing'));
    ok('an empty inventory still has zero targets rather than throwing', empty.renderTargets.count === 0);
    ok('no unsized note when nothing is unsized', empty.renderTargets.unsizedNote === null);
  }
}
