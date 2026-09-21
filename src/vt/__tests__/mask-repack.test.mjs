/**
 * mask-repack.test.mjs — mythica-machina-press#591.
 *
 * `repackMaskPixels` now runs in TWO places: inside `mask-decode.worker.js`,
 * and on the main thread when that worker is unavailable. They must produce
 * byte-identical output forever — a mask that packs differently depending on
 * whether a worker happened to start is correct on one machine and subtly
 * wrong on another, and invisible until an effect's silhouette is off.
 *
 * One function, two callers, and these tests pin its exact behaviour.
 */
import { repackMaskPixels, DEFAULT_MASK_CONTENT_EMPTY_BYTE } from '../mask-repack.js';

/** width*height RGBA, filled by a per-texel callback. */
function mk(width, height, fn) {
  const a = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, al] = fn(x, y) ?? [0, 0, 0, 255];
      const s = (y * width + x) * 4;
      a[s] = r;
      a[s + 1] = g;
      a[s + 2] = b;
      a[s + 3] = al;
    }
  }
  return a;
}

export function run(t) {
  const { ok } = t;

  // --- SINGLE-CHANNEL (water): one byte per texel, R only -----------------
  {
    const rgba = mk(4, 2, (x) => [x * 10, 200, 200, 255]);
    const { data } = repackMaskPixels(rgba, 4, 2, { rgbMode: false });
    ok('single-channel output is one byte per texel', data.length === 8);
    ok('single-channel copies R, not G or B', data[0] === 0 && data[1] === 10 && data[3] === 30);
  }

  // --- RGB (specular): four bytes, all preserved --------------------------
  {
    const rgba = mk(2, 1, () => [11, 22, 33, 44]);
    const { data } = repackMaskPixels(rgba, 2, 1, { rgbMode: true });
    ok('rgb output is four bytes per texel', data.length === 8);
    ok(
      'rgb preserves every channel including alpha',
      data[0] === 11 && data[1] === 22 && data[2] === 33 && data[3] === 44
    );
  }

  // --- BOUNDS: measured by MAX of RGB, never by red alone -----------------
  // A mask painted pure blue has r = 0. Measuring bounds by red would crop a
  // blue-steel object out of the geometry entirely.
  {
    const blueOnly = mk(8, 8, (x, y) => (x === 5 && y === 6 ? [0, 0, 255, 255] : [0, 0, 0, 255]));
    const rgb = repackMaskPixels(blueOnly, 8, 8, { rgbMode: true });
    ok('a pure-BLUE texel is found by rgb bounds', rgb.contentBounds !== null);
    ok(
      '...and bounds cover the full extent of that texel (+1 on the max side)',
      rgb.contentBounds.minU === 5 / 8 && rgb.contentBounds.maxU === 6 / 8
    );
    ok('...on both axes', rgb.contentBounds.minV === 6 / 8 && rgb.contentBounds.maxV === 7 / 8);
    // The same pixels in single-channel mode legitimately find nothing: R is 0
    // there, and R is the whole signal for that kind.
    const single = repackMaskPixels(blueOnly, 8, 8, { rgbMode: false });
    ok('the same blue texel is correctly ABSENT in single-channel mode', single.contentBounds === null);
  }

  // --- AN EMPTY MASK REPORTS null, NEVER A ZERO-SIZED BOX -----------------
  {
    const empty = mk(4, 4, () => [0, 0, 0, 255]);
    ok('nothing painted -> contentBounds is null', repackMaskPixels(empty, 4, 4, {}).contentBounds === null);
    ok(
      'nothing painted in rgb mode -> also null',
      repackMaskPixels(empty, 4, 4, { rgbMode: true }).contentBounds === null
    );
  }

  // --- THE EMPTY-BYTE THRESHOLD ------------------------------------------
  // A lossy encode leaves a scatter of 1s across regions painted pure black. A
  // single stray texel in a far corner would otherwise inflate the AABB to the
  // whole map, silently undoing the crop this exists to provide.
  {
    const noise = mk(8, 8, (x, y) => (x === 7 && y === 7 ? [1, 0, 0, 255] : [0, 0, 0, 255]));
    ok(
      'a lone byte-1 texel is treated as encoder noise, not content',
      repackMaskPixels(noise, 8, 8, {}).contentBounds === null
    );
    const real = mk(8, 8, (x, y) => (x === 7 && y === 7 ? [2, 0, 0, 255] : [0, 0, 0, 255]));
    ok('a byte-2 texel IS content', repackMaskPixels(real, 8, 8, {}).contentBounds !== null);
    ok('the default threshold is the documented 1', DEFAULT_MASK_CONTENT_EMPTY_BYTE === 1);
    // ...and it is overridable, so the worker and caller can agree explicitly.
    ok(
      'a caller-supplied threshold is honoured',
      repackMaskPixels(real, 8, 8, { emptyByte: 5 }).contentBounds === null
    );
  }

  // --- FULL-COVERAGE MASK SPANS THE WHOLE UV RANGE ------------------------
  {
    const full = mk(4, 4, () => [255, 255, 255, 255]);
    const b = repackMaskPixels(full, 4, 4, {}).contentBounds;
    ok('a fully painted mask spans 0..1 exactly', b.minU === 0 && b.minV === 0 && b.maxU === 1 && b.maxV === 1);
  }

  // --- NON-SQUARE: u and v must not be transposed -------------------------
  {
    // 10 wide, 2 tall; paint one texel at x=9,y=0.
    const wide = mk(10, 2, (x, y) => (x === 9 && y === 0 ? [255, 0, 0, 255] : [0, 0, 0, 255]));
    const b = repackMaskPixels(wide, 10, 2, {}).contentBounds;
    ok('u uses width and v uses height, not swapped', b.minU === 0.9 && b.maxU === 1 && b.minV === 0 && b.maxV === 0.5);
  }
}
