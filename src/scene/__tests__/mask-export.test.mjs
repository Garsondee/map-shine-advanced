/**
 * mask-export.js — where a full-size mask goes, what it is called, how big it
 * is, and the band plan that draws it.
 */
import {
  planMaskFile,
  kindFileSupport,
  exportDimensions,
  planBands,
  greyToRgba,
  checkImportSize,
  isExternalUrl,
  splitPath,
  WORLD_MASK_FOLDER,
} from '../mask-export.js';
import { suffixOf } from '../scene-readiness.js';
import { replayOps } from '../mask-ops.js';
import { createMaskGrid } from '../mask-derive.js';

export function run(t) {
  const OUT = suffixOf('outdoors');

  {
    const p = planMaskFile({ artUrl: 'worlds/w1/maps/Town%20Square.webp', kindId: 'outdoors' });
    t.ok('beside the map by default', p.route === 'beside' && p.dir === 'worlds/w1/maps');
    t.ok('decoded base + suffix + png', p.fileName === `Town Square${OUT}.png`);
  }
  {
    const p = planMaskFile({
      artUrl: 'worlds/w1/maps/town.webp',
      kindId: 'outdoors',
      existingUrl: `worlds/w1/maps/town${OUT}.webp`,
    });
    t.ok(
      'an existing file is replaced in place (keeps its extension)',
      p.route === 'beside' && p.fileName === `town${OUT}.webp`
    );
  }
  {
    const p = planMaskFile({ artUrl: 'modules/adv-pack/maps/keep.webp', kindId: 'fire', worldId: 'w1', sceneId: 'S1' });
    t.ok('module art goes to the world folder', p.route === 'world' && p.dir === `worlds/w1/${WORLD_MASK_FOLDER}/S1`);
    const q = planMaskFile({
      artUrl: 'modules/adv-pack/maps/keep.webp',
      kindId: 'fire',
      worldId: 'w1',
      sceneId: 'S1',
      maskFolder: 'worlds/w1/mine',
    });
    t.ok('a remembered folder wins', q.dir === 'worlds/w1/mine');
    const r = planMaskFile({ artUrl: 'systems/pf2e/maps/keep.webp', kindId: 'fire', worldId: null });
    t.ok('no world: download only', r.route === 'download');
    const ex = planMaskFile({
      artUrl: 'modules/adv-pack/maps/keep.webp',
      kindId: 'fire',
      existingUrl: `worlds/w1/${WORLD_MASK_FOLDER}/S1/keep${suffixOf('fire')}.png`,
    });
    t.ok('an existing world-folder file stays a world route', ex.route === 'world');
  }
  {
    const p = planMaskFile({ artUrl: 'https://assets.forge-vtt.com/x/maps/a.webp', kindId: 'outdoors' });
    t.ok('CDN art: download only, says why', p.route === 'download' && /another server/.test(p.why));
    t.ok('isExternalUrl', isExternalUrl('https://a/b.png') && !isExternalUrl('worlds/a.png'));
    t.ok('splitPath', splitPath('a/b/c.d.webp').base === 'c.d' && splitPath('noext') === null);
  }
  {
    t.ok('gray kinds write', kindFileSupport('outdoors', { fileExists: true }).canWrite);
    t.ok('colour kind with a file: import only', !kindFileSupport('specular', { fileExists: true }).canWrite);
    t.ok('colour kind without a file: write', kindFileSupport('specular', { fileExists: false }).canWrite);
    t.ok(
      'rgba art: import only',
      !kindFileSupport('tree', { fileExists: false }).canWrite &&
        kindFileSupport('tree', { fileExists: false }).canImport
    );
    t.ok('derived kind: nothing', !kindFileSupport('skyReach', { fileExists: false }).canImport);
  }
  {
    t.ok('normal size kept', exportDimensions(8000, 6000).scaled === false);
    const big = exportDimensions(20000, 10000);
    t.ok('over the side cap: scaled to 16384', big.scaled && big.w === 16384 && big.h === 8192);
    const area = exportDimensions(16000, 16000, { maxPixels: 100e6 });
    t.ok('over the pixel cap: scaled under it', area.scaled && area.w * area.h <= 100e6);
  }
  {
    const rect = { x: 100, y: 50, width: 1000, height: 700 };
    const bands = planBands(rect, 1000, 700, 64 * 1000);
    t.ok(
      'bands cover every row once',
      bands[0].row0 === 0 && bands.at(-1).row1 === 700 && bands.every((b, i) => i === 0 || b.row0 === bands[i - 1].row1)
    );
    t.ok(
      'band world rects stack to the whole rect',
      Math.abs(bands.at(-1).spec.y + bands.at(-1).spec.height - 750) < 1e-6
    );
    // A replay through bands lands where a whole replay does.
    const ops = [{ t: 'poly', pts: [100, 50, 1100, 750, 100, 750], v: 255, m: 'paint' }];
    let total = 0;
    for (const b of bands) total += replayOps(createMaskGrid(b.spec), ops).data.reduce((s, v) => s + (v ? 1 : 0), 0);
    t.ok('banded replay covers half the picture', Math.abs(total / (1000 * 700) - 0.5) < 0.005);
  }
  {
    const rgba = greyToRgba(Uint8Array.from([0, 128, 255]), new Uint8ClampedArray(12));
    t.ok('grey to opaque rgba', rgba.join() === '0,0,0,255,128,128,128,255,255,255,255,255');
  }
  {
    t.ok('same size import ok', checkImportSize(4000, 3000, 4000, 3000).sameSize);
    t.ok('same shape, other resolution ok', checkImportSize(2000, 1500, 4000, 3000).ok);
    t.ok('other shape refused', !checkImportSize(3000, 3000, 4000, 3000).ok);
  }
}
