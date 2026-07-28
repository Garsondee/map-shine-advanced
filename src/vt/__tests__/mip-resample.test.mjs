/**
 * Node verification for vt/mip-resample.js — the Lanczos-2 mip reducer that
 * replaced the OffscreenCanvas `drawImage` resize, and the premultiplied +
 * dilated alpha handling that goes with it.
 *
 * The alpha cases here are REGRESSION tests for a specific author-reported
 * defect (2026-07-28: "the edges of tiles, where the alpha might be less than
 * 100% are very degraded when I zoom out"). They deliberately feed the exact
 * pixels the old canvas round trip produced — transparent texels carrying RGB 0,
 * because `getImageData` un-premultiplies and divides by zero — and assert that
 * no black survives to be averaged into a visible edge.
 */
import { lanczos, buildHalveTaps, halvedSize, halveRGBA, dilateTransparentRGB, LANCZOS_A } from '../mip-resample.js';

/** Build a width×height straight-alpha RGBA image from fn(x,y) → [r,g,b,a]. */
function makeImage(width, height, fn) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return rgba;
}

/** A band reader over a whole-image buffer, plus a log of the y0s it saw. */
function bandReaderOver(img, width) {
  const seen = [];
  const read = (y0, count) => {
    seen.push(y0);
    return img.subarray(y0 * width * 4, (y0 + count) * width * 4);
  };
  return { read, seen };
}

/** Reference 2×2 box halve, for the "is Lanczos actually sharper" comparison. */
function boxHalve(img, w, h) {
  const dw = w >> 1;
  const dh = h >> 1;
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      for (let c = 0; c < 4; c++) {
        const s =
          img[(2 * y * w + 2 * x) * 4 + c] +
          img[(2 * y * w + 2 * x + 1) * 4 + c] +
          img[((2 * y + 1) * w + 2 * x) * 4 + c] +
          img[((2 * y + 1) * w + 2 * x + 1) * 4 + c];
        out[(y * dw + x) * 4 + c] = Math.round(s / 4);
      }
    }
  }
  return out;
}

export async function run(t) {
  const ok = (n, c) => t.ok(n, c);

  // ── the kernel itself ────────────────────────────────────────────────────
  {
    ok('lanczos(0) === 1', lanczos(0) === 1);
    ok('lanczos vanishes at/outside the window', lanczos(LANCZOS_A) === 0 && lanczos(3) === 0);

    const { offsets, weights } = buildHalveTaps();
    ok('halve kernel has 8 taps at a=2', offsets.length === 8 && weights.length === 8);
    const sum = weights.reduce((s, v) => s + v, 0);
    ok('halve weights sum to 1 (no brightness drift)', Math.abs(sum - 1) < 1e-12);

    // THE POINT OF LANCZOS: real negative lobes. A kernel with none is a blur,
    // and this whole module exists because the previous filter behaved like one.
    ok(
      'halve kernel has negative lobes (it sharpens, unlike a box)',
      Array.from(weights).some((w) => w < 0)
    );
    // Symmetric about the output texel centre, or the image shifts sideways
    // half a texel per level — a Y-flip-class bug (memory: y_flip_recurring_risk).
    let symmetric = true;
    for (let k = 0; k < weights.length; k++) {
      if (Math.abs(weights[k] - weights[weights.length - 1 - k]) > 1e-12) symmetric = false;
    }
    ok('halve kernel is symmetric (no half-texel drift per level)', symmetric);
    ok('halve offsets straddle the centre', offsets[0] === -3 && offsets[offsets.length - 1] === 4);
  }

  // ── dimensions match what a GPU allocates ────────────────────────────────
  {
    ok('halvedSize(6750,6750)', halvedSize(6750, 6750).width === 3375 && halvedSize(6750, 6750).height === 3375);
    ok('halvedSize floors like base>>1', halvedSize(375, 187).width === 187 && halvedSize(375, 187).height === 93);
    ok('halvedSize never reaches 0', halvedSize(1, 1).width === 1 && halvedSize(1, 1).height === 1);
    t.throws('halveRGBA rejects a degenerate size', () => halveRGBA(() => new Uint8Array(0), 0, 4), 'bad source size');
  }

  // ── a flat image must survive exactly (no drift, no ringing) ─────────────
  {
    const W = 16;
    const H = 16;
    const img = makeImage(W, H, () => [200, 100, 50, 255]);
    const { read } = bandReaderOver(img, W);
    const { data, width, height } = halveRGBA(read, W, H, { bandRows: 4 });
    ok('flat halve size', width === 8 && height === 8);
    let exact = true;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 200 || data[i + 1] !== 100 || data[i + 2] !== 50 || data[i + 3] !== 255) exact = false;
    }
    ok('flat opaque image survives halving exactly', exact);
  }

  // ── the band reader contract: forward-only ───────────────────────────────
  {
    const W = 32;
    const H = 64;
    const img = makeImage(W, H, (x, y) => [x * 4, y * 2, 0, 255]);
    const { read, seen } = bandReaderOver(img, W);
    halveRGBA(read, W, H, { bandRows: 8 });
    let nonDecreasing = true;
    for (let i = 1; i < seen.length; i++) if (seen[i] < seen[i - 1]) nonDecreasing = false;
    ok('band reader is only ever asked for non-decreasing y0 (streamable)', nonDecreasing);
    ok('band reader was actually exercised across bands', seen.length > 1);
  }

  // ── sharper than a box, which is the reason this module exists ───────────
  {
    const W = 32;
    const H = 4;
    // A hard vertical step: black left, white right.
    const img = makeImage(W, H, (x) => (x < W / 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const { read } = bandReaderOver(img, W);
    const { data, width } = halveRGBA(read, W, H, { bandRows: 4 });
    const box = boxHalve(img, W, H);
    // Lanczos' negative lobes overshoot on the dark side of a step: somewhere
    // near the edge it must go BELOW what a pure box average can ever produce.
    // (The box, being a non-negative average, cannot leave [0,255] input range
    // and produces a perfectly clean 0|255 step here.)
    let sawOvershoot = false;
    const row = 0;
    for (let x = 1; x < width - 1; x++) {
      const l = data[(row * width + x) * 4];
      const b = box[(row * width + x) * 4];
      if (b === 0 && l === 0) continue;
      if (l > b + 1 || l < b - 1) sawOvershoot = true;
    }
    ok('Lanczos halve differs from a box on a step edge (negative lobes active)', sawOvershoot);
  }

  // ══ THE ALPHA-EDGE REGRESSION (author, 2026-07-28) ══════════════════════
  // Input is exactly what the old canvas round trip handed the encoder: opaque
  // colour on one side, and transparent texels whose RGB was flattened to 0
  // because getImageData un-premultiplies and divides by zero.
  {
    const W = 8;
    const H = 4;
    const img = makeImage(W, H, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const { read } = bandReaderOver(img, W);
    const { data, width } = halveRGBA(read, W, H, { bandRows: 4 });

    const at = (x, y) => {
      const i = (y * width + x) * 4;
      return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
    };

    // 1. Fully-covered texels keep their colour and full coverage.
    const solid = at(0, 0);
    ok('opaque interior stays opaque', solid.a === 255);
    ok('opaque interior keeps its hue', solid.r > 250 && solid.g < 5 && solid.b < 5);

    // 2. THE BUG: a partially-covered edge texel must recover the SOURCE colour,
    //    not a colour dragged toward black by its transparent neighbours. Under
    //    straight-alpha filtering this used to come back roughly half-dark.
    let worstEdgeR = 255;
    let sawPartial = false;
    for (let x = 0; x < width; x++) {
      const p = at(x, 0);
      if (p.a > 0 && p.a < 255) {
        sawPartial = true;
        if (p.r < worstEdgeR) worstEdgeR = p.r;
        ok(`partial-alpha texel x=${x} keeps red, not blackened`, p.r > 240 && p.g < 12 && p.b < 12);
      }
    }
    ok('the fixture actually produced a partial-alpha edge', sawPartial);
    ok('no partial-alpha texel was darkened', worstEdgeR > 240);

    // 3. Fully transparent texels must have been DILATED — carrying the edge
    //    colour rather than black — so the GPU's own unweighted bilinear has
    //    nothing dark to pull into the visible edge at runtime.
    let checkedTransparent = false;
    for (let x = 0; x < width; x++) {
      const p = at(x, 0);
      if (p.a === 0) {
        checkedTransparent = true;
        ok(`transparent texel x=${x} carries dilated colour, not black`, p.r > 0);
      }
    }
    ok('the fixture actually produced a fully transparent texel', checkedTransparent);
  }

  // ── dilation in isolation ────────────────────────────────────────────────
  {
    // One opaque red texel in a 5×5 field of transparent black.
    const W = 5;
    const H = 5;
    const img = makeImage(W, H, (x, y) => (x === 2 && y === 2 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const before = img.slice();
    const filledCount = dilateTransparentRGB(img, W, H, 2);
    ok('dilation reports how many texels it coloured', filledCount > 0);

    let alphaUntouched = true;
    for (let i = 3; i < img.length; i += 4) if (img[i] !== before[i]) alphaUntouched = false;
    ok('dilation never changes alpha (coverage is untouched)', alphaUntouched);

    const at = (x, y) => img[(y * W + x) * 4];
    ok('dilation reaches the 4-neighbours', at(1, 2) > 0 && at(3, 2) > 0 && at(2, 1) > 0 && at(2, 3) > 0);
    ok('dilation reaches diagonals', at(1, 1) > 0);
    ok('two passes reach two texels out', at(0, 2) > 0);
    ok('the opaque source texel is unchanged', at(2, 2) === 255);
  }

  // ── a fully opaque image must be a no-op (the BC1 floor case) ────────────
  {
    const W = 8;
    const H = 8;
    const img = makeImage(W, H, (x, y) => [x * 8, y * 8, 0, 255]);
    const before = img.slice();
    const filled = dilateTransparentRGB(img, W, H, 4);
    ok('dilation is a no-op on a fully opaque image', filled === 0);
    let unchanged = true;
    for (let i = 0; i < img.length; i++) if (img[i] !== before[i]) unchanged = false;
    ok('dilation left an opaque image byte-identical', unchanged);
  }

  // ── an entirely transparent image must not hang or invent colour ─────────
  {
    const W = 4;
    const H = 4;
    const img = makeImage(W, H, () => [0, 0, 0, 0]);
    const filled = dilateTransparentRGB(img, W, H, 4);
    ok('dilation terminates on a fully transparent image', filled === 0);
  }
}
