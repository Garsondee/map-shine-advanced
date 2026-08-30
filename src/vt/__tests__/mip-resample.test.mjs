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
import {
  lanczos,
  buildHalveTaps,
  halvedSize,
  halveRGBA,
  dilateTransparentRGB,
  LANCZOS_A,
  srgbToLinear,
  linearToSrgb,
  rmsContrastFromSums,
  computeRmsLuminanceContrast,
  contrastPreservingCorrect,
} from '../mip-resample.js';

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

  // ══ LINEARIZATION (2026-08-30) ═══════════════════════════════════════════

  // ── sRGB <-> linear round trip ────────────────────────────────────────────
  {
    ok('srgbToLinear(0) === 0', srgbToLinear(0) === 0);
    ok('srgbToLinear(255) === 1', Math.abs(srgbToLinear(255) - 1) < 1e-9);
    ok('linearToSrgb(0) === 0', linearToSrgb(0) === 0);
    ok('linearToSrgb(1) === 1', Math.abs(linearToSrgb(1) - 1) < 1e-9);

    let monotonic = true;
    let prev = -1;
    for (let i = 0; i <= 255; i++) {
      const v = srgbToLinear(i);
      if (v < prev) monotonic = false;
      prev = v;
    }
    ok('srgbToLinear is monotonically non-decreasing over every byte', monotonic);

    let maxRoundTripError = 0;
    for (let i = 0; i <= 255; i++) {
      const back = Math.round(linearToSrgb(srgbToLinear(i)) * 255);
      maxRoundTripError = Math.max(maxRoundTripError, Math.abs(back - i));
    }
    ok('decode->encode round trip recovers every byte exactly', maxRoundTripError === 0);
  }

  // ── a flat image survives linearized halving exactly (no round-trip drift) ─
  {
    const W = 16;
    const H = 16;
    const img = makeImage(W, H, () => [37, 201, 8, 255]);
    const { read } = bandReaderOver(img, W);
    const { data } = halveRGBA(read, W, H, { bandRows: 4 }); // linearize defaults true
    let exact = true;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 37 || data[i + 1] !== 201 || data[i + 2] !== 8 || data[i + 3] !== 255) exact = false;
    }
    ok('a flat image survives LINEARIZED halving exactly, same as the legacy path', exact);
  }

  // ── linearize:false reproduces the ORIGINAL gamma-space-averaging path ────
  {
    const W = 4;
    const H = 4;
    // A genuine mid-tone edge, not flat — flat images can't distinguish the
    // two filtering spaces (decode/encode round-trips to a no-op on a
    // constant input either way).
    const img = makeImage(W, H, (x) => (x < 2 ? [220, 220, 220, 255] : [30, 30, 30, 255]));
    const { read: readLin } = bandReaderOver(img, W);
    const { data: linData } = halveRGBA(readLin, W, H, { bandRows: 2, linearize: true });
    const { read: readGamma } = bandReaderOver(img, W);
    const { data: gammaData } = halveRGBA(readGamma, W, H, { bandRows: 2, linearize: false });
    let differs = false;
    for (let i = 0; i < linData.length; i += 4) if (linData[i] !== gammaData[i]) differs = true;
    ok('linearize:true and linearize:false produce genuinely different output on a real edge', differs);
  }

  // ── RMS luminance contrast ────────────────────────────────────────────────
  {
    const W = 8;
    const H = 8;
    const flat = makeImage(W, H, () => [128, 128, 128, 255]);
    ok('a flat image has zero RMS contrast', computeRmsLuminanceContrast(flat, W, H) === 0);

    // Pure black/white 50/50: mean luma 127.5, stddev 127.5 -> ratio exactly 1.
    const checker = makeImage(W, H, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    ok(
      'a pure black/white checkerboard has RMS contrast exactly 1',
      Math.abs(computeRmsLuminanceContrast(checker, W, H) - 1) < 1e-9
    );

    const transparent = makeImage(W, H, () => [200, 50, 50, 0]);
    ok('a fully transparent image reports 0, not NaN', computeRmsLuminanceContrast(transparent, W, H) === 0);

    ok('rmsContrastFromSums(0,0,0) is 0 (no divide by zero)', rmsContrastFromSums(0, 0, 0) === 0);
    ok('rmsContrastFromSums with zero mean is 0', rmsContrastFromSums(0, 0, 5) === 0);
  }

  // ── contrast-preserving mip correction ────────────────────────────────────
  {
    const W = 8;
    const H = 8;
    const checker = makeImage(W, H, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const refFromSelf = computeRmsLuminanceContrast(checker, W, H);

    // A level already matching the reference gets gain 1 and is untouched.
    const before = checker.slice();
    const gainNoop = contrastPreservingCorrect(checker, W, H, refFromSelf);
    ok('a level already matching the reference gets gain 1 (no-op)', gainNoop === 1);
    let unchangedNoop = true;
    for (let i = 0; i < checker.length; i++) if (checker[i] !== before[i]) unchangedNoop = false;
    ok('no-op correction leaves the buffer byte-identical', unchangedNoop);

    // A softer (lower-contrast) level restores toward the reference, upward.
    const soft = makeImage(W, H, (x, y) => {
      const v = (x + y) % 2 === 0 ? 180 : 75; // same mean as checker (127.5), less contrast
      return [v, v, v, 255];
    });
    const softBefore = computeRmsLuminanceContrast(soft, W, H);
    const gain = contrastPreservingCorrect(soft, W, H, refFromSelf);
    ok('gain restores contrast: applied gain > 1', gain > 1);
    const softAfter = computeRmsLuminanceContrast(soft, W, H);
    ok('corrected contrast moved toward the reference, not away from it', softAfter > softBefore);
    let inRange = true;
    for (let i = 0; i < soft.length; i++) if (soft[i] < 0 || soft[i] > 255) inRange = false;
    ok('every corrected byte stays in [0,255]', inRange);

    // A near-flat level against a much higher reference forces the ceiling.
    const nearFlat = makeImage(W, H, (x, y) => {
      const v = (x + y) % 2 === 0 ? 129 : 127; // ratio ~0.0078
      return [v, v, v, 255];
    });
    const cappedGain = contrastPreservingCorrect(nearFlat, W, H, 1.0, { gMax: 3.0 });
    ok('a huge contrast deficit is capped at gMax, not applied uncapped', Math.abs(cappedGain - 3.0) < 1e-9);

    // Transparent texels are never touched.
    const withHole = makeImage(W, H, (x, y) => {
      if (x === 0 && y === 0) return [10, 10, 10, 0];
      return (x + y) % 2 === 0 ? [180, 180, 180, 255] : [75, 75, 75, 255];
    });
    const holeBefore = [withHole[0], withHole[1], withHole[2]];
    contrastPreservingCorrect(withHole, W, H, refFromSelf);
    ok(
      'a transparent texel is never touched by the correction',
      withHole[0] === holeBefore[0] && withHole[1] === holeBefore[1] && withHole[2] === holeBefore[2]
    );
  }

  // ── REGRESSION: a real mip level loses contrast relative to its source;
  //    the correction moves it back toward that source (2026-08-30) ─────────
  {
    const W = 16;
    const H = 4;
    // A thin dark line on light paper — the exact case this whole repair
    // chain (linearization + contrast preservation) exists for.
    const img = makeImage(W, H, (x) => (x === W / 2 ? [10, 10, 10, 255] : [230, 230, 230, 255]));
    const sourceContrast = computeRmsLuminanceContrast(img, W, H);

    const { read } = bandReaderOver(img, W);
    const { data, width, height } = halveRGBA(read, W, H, { bandRows: 4 });
    const reducedContrastBefore = computeRmsLuminanceContrast(data, width, height);
    ok(
      'a real reduced mip level measurably loses contrast relative to its source',
      reducedContrastBefore < sourceContrast
    );

    const corrected = data.slice();
    contrastPreservingCorrect(corrected, width, height, sourceContrast);
    const reducedContrastAfter = computeRmsLuminanceContrast(corrected, width, height);
    ok(
      'the correction moves the reduced level CLOSER to the source contrast than the uncorrected reduction',
      Math.abs(reducedContrastAfter - sourceContrast) < Math.abs(reducedContrastBefore - sourceContrast)
    );
  }
}
