/**
 * Node verification for vt/baked-format.js — the pre-baked-texture sidecar
 * codec (mythica-machina-press#439). Round-trips real BC1/BC7 output through
 * `encodeSidecar`/`decodeSidecar` and checks the result is byte-identical to
 * what was fed in, both compressed and uncompressed, for one and many mip
 * levels, with and without an alpha-min grid — the same "encode then decode
 * with this module's own machinery" discipline block-compress.test.mjs uses,
 * one layer up.
 */
import { encodeSidecar, decodeSidecar } from '../baked-format.js';
import { encodeBC1, encodeBC7, computeMipChainDims } from '../block-compress.js';

function makeImage(width, height, fn) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a ?? 255;
    }
  }
  return rgba;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * `t.throws` (run-tests.mjs) calls `fn()` synchronously and checks for a
 * thrown exception — it has no notion of a rejected Promise. `encodeSidecar`/
 * `decodeSidecar` are `async`, so a validation error inside them never throws
 * synchronously to the caller; it always surfaces as a rejection instead. This
 * local helper is the async equivalent, built on `t.ok` (the harness's actual
 * primitive) rather than on `t.throws` itself, so it needs no change to the
 * shared runner.
 */
async function rejects(t, name, asyncFn, matchSubstr) {
  try {
    await asyncFn();
    t.ok(name, false);
  } catch (e) {
    const msg = String((e && e.message) || e);
    t.ok(name, !matchSubstr || msg.includes(matchSubstr));
  }
}

/** Build a real, multi-level BC1 or BC7 chain the way bc-compress.worker.js
 * does (padded level 0, halved-and-clamped levels above it) — simplified
 * here to a flat-color halve since pixel content doesn't matter for this
 * file's own round-trip contract, only that the bytes it's handed come back
 * unchanged. */
function buildChain(format, w, h) {
  const encode = format === 'bc7' ? encodeBC7 : encodeBC1;
  const rgba = makeImage(w, h, (x, y) => [
    x & 0xff,
    y & 0xff,
    (x + y) & 0xff,
    format === 'bc7' ? (x * 7 + y) % 256 : 255,
  ]);
  const padW0 = Math.ceil(w / 4) * 4;
  const padH0 = Math.ceil(h / 4) * 4;
  const dims = computeMipChainDims(padW0, padH0);
  // Only level 0 needs REAL padded-content parity for this file's own tests
  // (it never re-derives pixels) — the rest just need a buffer of the RIGHT
  // byte length, so a solid fill is enough.
  const levels = [{ width: dims[0].width, height: dims[0].height, blocks: encode(rgba, w, h) }];
  for (let i = 1; i < dims.length; i++) {
    const fill = makeImage(dims[i].width, dims[i].height, () => [10, 20, 30, format === 'bc7' ? 40 : 255]);
    levels.push({ width: dims[i].width, height: dims[i].height, blocks: encode(fill, dims[i].width, dims[i].height) });
  }
  return { rgba, levels };
}

export async function run(t) {
  const { ok } = t;

  // --- BC1, single level, compressed --------------------------------------
  {
    const w = 16,
      h = 12;
    const { levels } = buildChain('bc1', w, h);
    const alphaStats = { min: 255, max: 255, mean: 255 };
    const sidecar = await encodeSidecar({ format: 'bc1', width: w, height: h, levels, alphaStats, compress: true });
    const decoded = await decodeSidecar(sidecar);
    ok('BC1: format round-trips', decoded.format === 'bc1');
    ok('BC1: logical width/height round-trip', decoded.width === w && decoded.height === h);
    ok('BC1: level count round-trips', decoded.levels.length === levels.length);
    ok(
      'BC1: level 0 bytes are byte-identical after compress→decompress',
      bytesEqual(new Uint8Array(decoded.levels[0].blocks), levels[0].blocks)
    );
    ok(
      'BC1: every level in the chain round-trips byte-identical',
      levels.every((lvl, i) => bytesEqual(new Uint8Array(decoded.levels[i].blocks), lvl.blocks))
    );
    ok(
      'BC1: alphaStats round-trips',
      decoded.alphaStats.min === 255 && decoded.alphaStats.max === 255 && decoded.alphaStats.mean === 255
    );
    ok('BC1: no alphaMinGrid ⇒ null, not a bogus 0x0 grid', decoded.alphaMinGrid === null);
  }

  // --- compression actually shrinks realistic (non-noise) content ---------
  // A tiny, high-entropy fixture (as above) can legitimately come back LARGER
  // compressed than raw — deflate's own header/footer outweighs a few dozen
  // bytes of "savings" on something this small and this random. Real map
  // layers are mostly uniform regions (#439's own measurements: 137 MB of
  // BC7 blocks on a 3.3%-painted layer deflated to 2.35 MB) — a flat-color
  // fill is the honest analogue of that at unit-test scale.
  {
    const w = 256,
      h = 256;
    const flatRgba = new Uint8Array(w * h * 4).fill(180);
    const blocks = encodeBC1(flatRgba, w, h);
    const sidecar = await encodeSidecar({
      format: 'bc1',
      width: w,
      height: h,
      levels: [{ width: w, height: h, blocks }],
      alphaStats: { min: 255, max: 255, mean: 255 },
      compress: true,
    });
    ok('a uniform-content sidecar compresses well below its raw block size', sidecar.length < blocks.length / 4);
    const decoded = await decodeSidecar(sidecar);
    ok('...and still round-trips byte-identical', bytesEqual(new Uint8Array(decoded.levels[0].blocks), blocks));
  }

  // --- BC7, multi-level, WITH an alphaMinGrid, uncompressed ---------------
  {
    const w = 37,
      h = 21; // deliberately not a multiple of 4 — exercises block padding
    const { levels } = buildChain('bc7', w, h);
    const gridW = 5,
      gridH = 3;
    const gridData = new Uint8Array(gridW * gridH);
    for (let i = 0; i < gridData.length; i++) gridData[i] = (i * 17) % 256;
    const alphaStats = { min: 0, max: 254, mean: 118.42 };
    const sidecar = await encodeSidecar({
      format: 'bc7',
      width: w,
      height: h,
      levels,
      alphaStats,
      alphaMinGrid: { w: gridW, h: gridH, data: gridData },
      compress: false,
    });
    const decoded = await decodeSidecar(sidecar);
    ok('BC7: format round-trips', decoded.format === 'bc7');
    ok('BC7: odd logical size round-trips exactly', decoded.width === w && decoded.height === h);
    ok(
      'BC7: every level round-trips byte-identical (uncompressed path)',
      levels.every((lvl, i) => bytesEqual(new Uint8Array(decoded.levels[i].blocks), lvl.blocks))
    );
    ok(
      'BC7: alphaMinGrid dims + data round-trip',
      decoded.alphaMinGrid.w === gridW &&
        decoded.alphaMinGrid.h === gridH &&
        bytesEqual(decoded.alphaMinGrid.data, gridData)
    );
    ok('BC7: alphaStats.mean survives a non-integer value', decoded.alphaStats.mean === 118.42);
  }

  // --- each decoded level's ArrayBuffer is independently transferable -----
  {
    const w = 20,
      h = 20;
    const { levels } = buildChain('bc1', w, h);
    const sidecar = await encodeSidecar({
      format: 'bc1',
      width: w,
      height: h,
      levels,
      alphaStats: { min: 255, max: 255, mean: 255 },
    });
    const decoded = await decodeSidecar(sidecar);
    const buffers = decoded.levels.map((lvl) => lvl.blocks);
    ok('decoded levels do not alias the same backing buffer', new Set(buffers).size === buffers.length);
    // A structured-clone-style transfer list must accept every entry once.
    // `MessageChannel` is available in Node and gives a real transfer check
    // rather than trusting object identity alone.
    let transferOk = true;
    try {
      const { port1 } = new MessageChannel();
      port1.postMessage({ buffers }, buffers);
    } catch (_) {
      transferOk = false;
    }
    ok('decoded level buffers survive a REAL postMessage transfer list', transferOk);
  }

  // --- null/absent mean survives as null, not NaN or -1 -------------------
  {
    const w = 8,
      h = 8;
    const { levels } = buildChain('bc1', w, h);
    const sidecar = await encodeSidecar({
      format: 'bc1',
      width: w,
      height: h,
      levels,
      alphaStats: { min: 255, max: 255, mean: null },
    });
    const decoded = await decodeSidecar(sidecar);
    ok('a null mean round-trips as null, not -1 or NaN', decoded.alphaStats.mean === null);
  }

  // --- fails loud on bad input, per this codebase's own doctrine ----------
  {
    const w = 8,
      h = 8;
    const { levels } = buildChain('bc1', w, h);
    await rejects(t, 'rejects an unrecognized format', () =>
      encodeSidecar({ format: 'bc9', width: w, height: h, levels, alphaStats: {} })
    );
    await rejects(t, 'rejects a non-block-padded level size', () =>
      encodeSidecar({
        format: 'bc1',
        width: w,
        height: h,
        levels: [{ width: 7, height: 8, blocks: new Uint8Array(16) }],
        alphaStats: {},
      })
    );
    await rejects(t, 'rejects a level whose blocks length disagrees with its declared size', () =>
      encodeSidecar({
        format: 'bc1',
        width: w,
        height: h,
        levels: [{ width: 8, height: 8, blocks: new Uint8Array(4) }],
        alphaStats: {},
      })
    );
    const sidecar = await encodeSidecar({
      format: 'bc1',
      width: w,
      height: h,
      levels,
      alphaStats: { min: 255, max: 255, mean: 255 },
    });
    await rejects(t, 'rejects bad magic', () => decodeSidecar(new Uint8Array(64)));
    await rejects(t, 'rejects a buffer truncated inside the payload', () =>
      decodeSidecar(sidecar.slice(0, sidecar.length - 4))
    );
  }
}
