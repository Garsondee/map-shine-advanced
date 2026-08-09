/**
 * SHADER LAB — DOES REAL HARDWARE DECODE OUR BC BLOCKS THE WAY WE THINK IT DOES?
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS — THE ONE BUG THE NODE TESTS STRUCTURALLY CANNOT CATCH
 * ============================================================================
 * `vt/block-compress.js` ships an encoder AND its own reference decoder, and
 * `__tests__/block-compress.test.mjs` proves quality by round-tripping one
 * through the other. That is a real test of the encoder's CHOICES — which
 * endpoints, which mode, how much error — and it caught genuine bugs.
 *
 * It cannot catch a wrong BIT LAYOUT. Encoder and decoder share an author and a
 * reading of the spec, so a field written at the wrong offset, a p-bit expanded
 * the wrong way, or a mistranscribed partition table is used IDENTICALLY by
 * both: the round trip agrees with itself perfectly, every quality bar passes,
 * and a real GPU — which uses the REAL fixed-function decoder — renders noise.
 * That is `feedback_smooth_output_hides_ported_bugs` exactly, and the risk grew
 * sharply on 2026-08-06 when the encoder went from one mode (6) to three
 * (5, 6, 7), the last of which carries 1088 values of spec lookup table and a
 * two-anchor index field where one misread bit shifts every bit after it.
 *
 * THE ONLY INDEPENDENT ORACLE FOR A TEXTURE FORMAT IS THE HARDWARE THAT
 * IMPLEMENTS IT. So: encode with the real encoder, upload as a real
 * `CompressedTexture`, render it 1:1, read it back, and demand the GPU's pixels
 * equal our own decoder's pixels EXACTLY. Zero tolerance — BC decode is
 * fixed-function integer arithmetic, so "close" would itself be a finding.
 *
 * ============================================================================
 * WHAT IS REAL HERE
 * ============================================================================
 * REAL, imported from `src/`, never transcribed: `encodeBC1`, `decodeBC1`,
 * `encodeBC7`, `decodeBC7`, `bc7ModeHistogram` — the production encoder and its
 * production reference decoder, unmodified. This bench adds no compression code
 * of its own; it only supplies pixels and compares two decodes of them.
 *
 * DELIBERATELY SYNTHETIC: the fixtures. Each is shaped to FORCE a particular
 * mode to win the encoder's scoring, because a test that never exercises mode 7
 * proves nothing about mode 7. Every scenario therefore asserts its own
 * non-vacuity first (`…-blocks-present`) — a fixture that stopped producing the
 * mode it exists to test would otherwise pass silently while testing nothing.
 *
 * ============================================================================
 * TWO THINGS THAT WOULD MAKE THIS BENCH LIE, AND WHAT IS DONE ABOUT THEM
 * ============================================================================
 * 1. COLOUR MANAGEMENT. The production art path uses `SRGBColorSpace`, so the
 *    GPU picks a `bc7-rgba-unorm-SRGB` format and decodes to linear on sample —
 *    correct there, fatal here, because the readback would differ from our
 *    integer decoder by the whole sRGB transfer function and every check would
 *    fail for a reason that is not a bug. Everything here is `NoColorSpace`
 *    with tone mapping off, so bytes in are bytes out and the ONLY thing under
 *    test is the block decode.
 *
 * 2. ORIENTATION. A Y-flip between the readback and our decoder's row order
 *    would look exactly like a decode mismatch (`feedback_y_flip_recurring_risk`
 *    — bitten five times). This bench does not assume: it scores BOTH
 *    orientations and reports which one matched. If exactly one matches, that
 *    is the orientation and the decode is proven. If NEITHER matches, the
 *    decode is genuinely wrong — and the check says so with both numbers, so a
 *    real failure can never be explained away as a flip.
 *
 * @module tools/shader-lab/bench-block-compress
 */
import { registerBench, evaluate, saveArtifact } from './contract.js';
import {
  encodeBC1,
  decodeBC1,
  encodeBC7,
  decodeBC7,
  bc7ModeHistogram,
} from '../../src/vt/block-compress.js';

/** Fixture edge, in texels. A multiple of 4 (the BC block grid) and small
 * enough that a full readback comparison is instant. */
const DIM = 64;

/** Build a DIM×DIM RGBA8 image from a per-texel fn(x,y) → [r,g,b,a]. */
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

// ── FIXTURES. Each names the mode it is built to provoke. ───────────────────

/** Colour and alpha varying INDEPENDENTLY — one line through RGBA cannot hold
 * two unrelated gradients, so mode 5's separate index tracks win. */
function mode5Fixture() {
  return makeImage(DIM, DIM, (x, y) => {
    const v = 30 + ((y * 7) % 200);
    return [v, 255 - v, 90 + ((x * 3) % 120), (x * 4) % 256];
  });
}

/**
 * Three clusters per block — ink, interior, hole — which no single line can
 * represent, so mode 7's two subsets win.
 *
 * ⚠️ DELIBERATELY OFF-CENTRE IN Y. The obvious version of this fixture is a
 * disc centred in the block, and that version is Y-SYMMETRIC — so a readback
 * matches our decoder under BOTH row orders, the orientation check cannot
 * resolve which one is real, and a genuine Y-flip would be invisible here
 * forever (`feedback_y_flip_recurring_risk`; `bench-floor-lighting.js` records
 * being bitten by exactly this, its footprint centred in Y so every orientation
 * probe was invariant while passing). Measured: with the centred disc this
 * scenario reported `mismatchesSameOrder: 0, mismatchesFlipped: 0`. Shifting
 * the centre makes the two answers distinguishable, which is the whole point of
 * the check.
 */
function mode7Fixture() {
  return makeImage(DIM, DIM, (x, y) => {
    const d = Math.hypot(x - DIM / 2 + 0.5, y - DIM * 0.38 + 0.5);
    const r = DIM * 0.3;
    const cov = Math.max(0, Math.min(1, r + 1.5 - d));
    const inkT = Math.max(0, Math.min(1, 2.5 - Math.abs(d - r)));
    const c = [190, 150, 90].map((q) => Math.round(q * (1 - inkT) + 12 * inkT));
    return [c[0], c[1], c[2], Math.round(cov * 255)];
  });
}

/** Smooth, coupled colour+alpha — mode 6's 16 index levels beat the 2-bit
 * modes here, so this is the regression guard for the mode that already
 * shipped and must not have been disturbed. */
function mode6Fixture() {
  return makeImage(DIM, DIM, (x, y) => {
    const t = (x + y) / (2 * DIM);
    const v = Math.round(20 + t * 210);
    return [v, v, v, Math.round(20 + t * 210)];
  });
}

/** Fully opaque painted linework — BC1's own domain. */
function bc1Fixture() {
  return makeImage(DIM, DIM, (x, y) => {
    if (x % 7 === 0 || y % 9 === 0 || (x + y) % 11 === 0) return [10, 10, 10, 255];
    const v = 200 + ((x * 3 + y * 5) % 40);
    return [v, v - 8, v - 24, 255];
  });
}

/** Everything at once — the realistic mixture a real asset produces. */
function mixedFixture() {
  return makeImage(DIM, DIM, (x, y) => {
    const half = x < DIM / 2;
    if (half) {
      const d = Math.hypot(x - DIM / 4 + 0.5, y - DIM / 2 + 0.5);
      return d < 10 ? [200, 140, 60, 255] : d < 14 ? [10, 10, 10, 255] : [0, 0, 0, 0];
    }
    const v = 30 + ((y * 7) % 200);
    return [v, 255 - v, 90 + ((x * 3) % 120), (x * 4) % 256];
  });
}

export function createBlockCompressBench({ THREE, log }) {
  let renderer = null;
  let camera = null;
  let colorRt = null;
  let bcSupported = null;

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    // Tone mapping OFF and NoColorSpace throughout: this bench compares integers,
    // and any transfer function between the texture and the readback would make
    // every check fail for a reason that is not a bug (see header, point 1).
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.NoColorSpace;
    // A unit quad drawn dead-on, one texel per pixel — no filtering, no scaling,
    // so a mismatch can only come from the block decode itself.
    camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.01, 10);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    colorRt = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
    });
    const device = renderer.backend?.device ?? null;
    bcSupported = device ? device.features?.has?.('texture-compression-bc') === true : null;
    log?.(
      `BLOCK-COMPRESS: backend ${renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL'}, ` +
        `texture-compression-bc=${bcSupported}`
    );
  }

  /**
   * Upload `blocks` as a real CompressedTexture, draw it 1:1, and read the
   * pixels back. Returns the raw RGBA8 buffer the GPU produced.
   *
   * `NoColorSpace` + `NearestFilter` + no mipmaps is the whole point: the
   * sampler must do nothing at all, so the bytes coming back are the hardware's
   * decode of our blocks and nothing else.
   */
  async function renderCompressed(blocks, format) {
    const tex = new THREE.CompressedTexture([{ data: blocks, width: DIM, height: DIM }], DIM, DIM, format);
    tex.flipY = false; // matches the production upload path (vt-pan-viewer.js)
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;

    const material = new THREE.NodeMaterial();
    const { texture, uv, vec4 } = THREE.TSL;
    const s = texture(tex, uv());
    material.colorNode = vec4(s.rgb, s.a);
    // NoBlending, not opacity: the readback must be src, verbatim, alpha
    // included. `transparent:true` alone would blend against the clear colour;
    // `transparent:false` makes the written alpha meaningless (a trap
    // bench-floor-lighting.js records hitting).
    material.transparent = true;
    material.blending = THREE.NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;

    const geo = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(0.5, 0.5, 0);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(colorRt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(prevTarget);
    const buf = await renderer.readRenderTargetPixelsAsync(colorRt, 0, 0, DIM, DIM);

    geo.dispose();
    material.dispose?.();
    tex.dispose();
    return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
  }

  /**
   * Compare a GPU readback against our own decoder under BOTH row orders, and
   * report the mismatch count for each.
   *
   * Returning both numbers rather than a boolean is deliberate: it is what lets
   * the checks distinguish "the image is upside down" (one count is 0, the other
   * is huge) from "the decode is wrong" (both are huge). A bench that silently
   * picked whichever orientation looked better could report a genuinely broken
   * decoder as a pass on the day the two happened to be symmetric.
   */
  function compareBothOrientations(gpu, cpu) {
    let sameOrder = 0;
    let flipped = 0;
    for (let y = 0; y < DIM; y++) {
      for (let x = 0; x < DIM; x++) {
        const g = (y * DIM + x) * 4;
        const cSame = (y * DIM + x) * 4;
        const cFlip = ((DIM - 1 - y) * DIM + x) * 4;
        for (let k = 0; k < 4; k++) {
          if (gpu[g + k] !== cpu[cSame + k]) sameOrder++;
          if (gpu[g + k] !== cpu[cFlip + k]) flipped++;
        }
      }
    }
    return { sameOrder, flipped, total: DIM * DIM * 4 };
  }

  /**
   * Is one row order DECISIVELY better than the other?
   *
   * Not "is one of them zero": BC1's interpolants legitimately differ from our
   * decoder by a quantum (see `BC1_INTERPOLANT_TOLERANCE`), so the correct
   * orientation there has a small non-zero count and a zero test would report
   * the orientation as undetermined when it is perfectly clear. A wide MARGIN
   * says the same thing without that false negative — measured, the real
   * separation is 149 vs 7841.
   *
   * Both counts near zero means the fixture is symmetric under the flip and the
   * orientation genuinely cannot be resolved from it — which is a fixture bug
   * worth failing on (`feedback_y_flip_recurring_risk`), not something to wave
   * through.
   */
  function orientationIsDecisive(cmp) {
    const lo = Math.min(cmp.sameOrder, cmp.flipped);
    const hi = Math.max(cmp.sameOrder, cmp.flipped);
    if (hi === 0) return false; // both matched perfectly — fixture is symmetric
    return lo * 10 < hi;
  }

  /** Was anything drawn at all? An all-zero readback would make a mismatch
   * count of 0 meaningless if our decoder also produced zeros. */
  function nonZeroFraction(buf) {
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) n++;
    return n / buf.length;
  }

  // ==========================================================================
  // BC1 IS NOT HELD TO BYTE-EXACTNESS, AND THAT IS NOT A RELAXED BAR
  // ==========================================================================
  // BC7's decode is exactly specified — every interpolation is stated integer
  // arithmetic — so "0 mismatched bytes" is the correct and achievable bar, and
  // it is what all four BC7 scenarios measure.
  //
  // BC1 (S3TC/DXT1) is NOT exactly specified. The two ENDPOINT palette entries
  // are: they are the stored 565 values expanded by bit replication, and every
  // implementation must produce them exactly. The two INTERPOLATED entries,
  // `(2·c0 + c1)/3` and `(c0 + 2·c1)/3`, have implementation-defined low bits —
  // real hardware differs on whether the thirds are computed in 565 space or
  // after expansion to 8 bits, and both are conformant.
  //
  // MEASURED HERE (2026-08-06, this machine's GPU, 4096 texels of real encoder
  // output), which is what turns that from a claim into a bound:
  //   endpoint texels (index 0/1)      3905 of 3905 EXACT, max diff 0
  //   interpolated texels (index 2/3)  191 total: 60 exact, 129 differ by 1,
  //                                    2 differ by 5
  // The 5s land on GREEN, the 6-bit channel, whose 565 quantum is 255/63 ≈ 4.05
  // — i.e. exactly one quantum, the signature of this GPU interpolating in 565
  // space while `decodeBC1` interpolates in 8-bit space.
  //
  // So this bench asserts the two things separately: endpoints EXACT (spec
  // guarantees it, and a failure there would mean a real layout bug), and
  // interpolants within ONE 565 quantum of the widest channel (5-bit, 255/31 ≈
  // 8.2 → 9). Collapsing both into one loose tolerance would throw away the
  // strong half of the check; demanding byte-exactness of both would false-fail
  // on conformant hardware that simply rounds the other way.
  //
  // ⚠️ DO NOT "FIX" `decodeBC1` TO MATCH THIS GPU. There is no single right
  // answer to match — another vendor's part would then mismatch instead.

  /** One 565 quantum of the coarsest (5-bit) channel, rounded up. */
  const BC1_INTERPOLANT_TOLERANCE = 9;

  /** Per-texel BC1 palette index, so a comparison can tell a spec-exact
   * endpoint texel apart from an implementation-defined interpolated one. */
  function bc1PaletteIndices(blocks) {
    const idx = new Uint8Array(DIM * DIM);
    const bpr = DIM / 4;
    for (let by = 0; by < bpr; by++) {
      for (let bx = 0; bx < bpr; bx++) {
        const o = (by * bpr + bx) * 8;
        const bits = (blocks[o + 4] | (blocks[o + 5] << 8) | (blocks[o + 6] << 16) | (blocks[o + 7] << 24)) >>> 0;
        for (let t = 0; t < 16; t++) {
          const y = by * 4 + ((t / 4) | 0);
          const x = bx * 4 + (t % 4);
          idx[y * DIM + x] = (bits >>> (t * 2)) & 3;
        }
      }
    }
    return idx;
  }

  /**
   * Compare GPU against CPU with BC1's two texel classes scored separately.
   * `flip` says which row order matched (established by the orientation check).
   */
  function compareBC1ByClass(gpu, cpu, paletteIdx, flip) {
    const endpoint = { n: 0, exact: 0, maxDiff: 0 };
    const interp = { n: 0, exact: 0, maxDiff: 0 };
    for (let y = 0; y < DIM; y++) {
      for (let x = 0; x < DIM; x++) {
        const g = (y * DIM + x) * 4;
        const cy = flip ? DIM - 1 - y : y;
        const c = (cy * DIM + x) * 4;
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(gpu[g + k] - cpu[c + k]));
        const bucket = paletteIdx[cy * DIM + x] < 2 ? endpoint : interp;
        bucket.n++;
        if (d === 0) bucket.exact++;
        if (d > bucket.maxDiff) bucket.maxDiff = d;
      }
    }
    return { endpoint, interp };
  }

  /** Persist the GPU readback and our decode side by side, so a failure can be
   * LOOKED at rather than only read as a count. */
  async function saveComparison(runId, name, gpu, cpu) {
    const canvas = document.createElement('canvas');
    canvas.width = DIM * 2;
    canvas.height = DIM;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(DIM * 2, DIM);
    for (let y = 0; y < DIM; y++) {
      for (let x = 0; x < DIM; x++) {
        const src = (y * DIM + x) * 4;
        const dstG = (y * DIM * 2 + x) * 4;
        const dstC = (y * DIM * 2 + DIM + x) * 4;
        for (let k = 0; k < 4; k++) {
          img.data[dstG + k] = gpu[src + k];
          img.data[dstC + k] = cpu[src + k];
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) return null;
    const file = `${name}-gpu-vs-cpu.png`;
    const res = await saveArtifact(runId, file, blob);
    return res?.ok ? file : null;
  }

  /**
   * The shared body of every scenario: encode, render on the GPU, decode on the
   * CPU, and demand they agree exactly.
   *
   * @param {object} a
   * @param {Uint8Array} a.image source RGBA8
   * @param {'bc1'|'bc7'} a.format
   * @param {number|null} a.expectMode the mode this fixture exists to exercise
   */
  async function runComparison({ image, format, expectMode, name, ctx }) {
    await ensureRenderer();
    const checks = [];

    if (bcSupported === false) {
      // Not a failure — this device genuinely cannot answer the question.
      checks.push(
        evaluate('device-supports-texture-compression-bc', () => {
          throw new Error('device lacks texture-compression-bc; nothing can be measured here');
        })
      );
      return { checks, calibration: 'OK', inputs: { format, name }, stats: {} };
    }

    const blocks = format === 'bc7' ? encodeBC7(image, DIM, DIM) : encodeBC1(image, DIM, DIM);
    const cpu = format === 'bc7' ? decodeBC7(blocks, DIM, DIM) : decodeBC1(blocks, DIM, DIM);
    const hist = format === 'bc7' ? bc7ModeHistogram(blocks) : null;
    const threeFormat = format === 'bc7' ? THREE.RGBA_BPTC_Format : THREE.RGBA_S3TC_DXT1_Format;
    const gpu = await renderCompressed(blocks, threeFormat);

    const cmp = compareBothOrientations(gpu, cpu);
    const drawn = nonZeroFraction(gpu);

    // NON-VACUITY FIRST. A fixture that stopped producing the mode it exists to
    // test would sail through the equality check below while proving nothing
    // about that mode at all.
    if (expectMode !== null) {
      checks.push(
        evaluate(`mode-${expectMode}-blocks-present`, () => ({
          ok: hist[expectMode] > 0,
          measured: hist ? [...hist].map((n, m) => (n ? `mode${m}:${n}` : null)).filter(Boolean) : null,
          expected: `at least one mode-${expectMode} block`,
          note: 'if this fails the scenario is vacuous, whatever the equality check says',
        }))
      );
    }

    checks.push(
      evaluate('something-was-actually-drawn', () => ({
        ok: drawn > 0.1,
        measured: `${(drawn * 100).toFixed(1)}% non-zero bytes`,
        expected: '> 10%',
        note: 'an all-zero readback would make an exact match meaningless',
      }))
    );

    // ORIENTATION IS DETERMINED, NOT ASSUMED.
    checks.push(
      evaluate('orientation-is-unambiguous', () => {
        const decisive = orientationIsDecisive(cmp);
        const both0 = cmp.sameOrder === 0 && cmp.flipped === 0;
        return {
          ok: decisive,
          measured: { mismatchesSameOrder: cmp.sameOrder, mismatchesFlipped: cmp.flipped },
          expected: 'one row order decisively better (>10x fewer mismatches)',
          note: both0
            ? 'BOTH orders matched — this fixture is Y-symmetric and cannot calibrate a flip'
            : decisive
              ? 'one order is clearly the real one'
              : 'neither order is decisive — the decode itself is suspect',
        };
      })
    );

    if (format === 'bc7') {
      // THE HEADLINE for BC7. Its decode is exactly specified, so the tolerance
      // is zero and "close" would itself be a finding.
      checks.push(
        evaluate('gpu-decode-equals-our-decoder-exactly', () => ({
          ok: cmp.sameOrder === 0 || cmp.flipped === 0,
          measured: { mismatchedBytes: Math.min(cmp.sameOrder, cmp.flipped), of: cmp.total },
          expected: '0 mismatched bytes',
          note: 'BC7 decode is exactly specified integer arithmetic — any mismatch is a real layout bug',
        }))
      );
    } else {
      // BC1 splits into a spec-exact half and an implementation-defined half —
      // see the long note above `BC1_INTERPOLANT_TOLERANCE` for the measurements
      // and for why matching this GPU exactly would be the WRONG fix.
      const flip = cmp.flipped <= cmp.sameOrder;
      const byClass = compareBC1ByClass(gpu, cpu, bc1PaletteIndices(blocks), flip);
      checks.push(
        evaluate('bc1-endpoint-texels-are-exact', () => ({
          ok: byClass.endpoint.maxDiff === 0,
          measured: { exact: byClass.endpoint.exact, of: byClass.endpoint.n, maxDiff: byClass.endpoint.maxDiff },
          expected: 'every endpoint texel exact',
          note: 'endpoints are spec-mandated bit replication — a miss here IS a layout bug',
        }))
      );
      checks.push(
        evaluate('bc1-interpolated-texels-within-one-565-quantum', () => ({
          ok: byClass.interp.maxDiff <= BC1_INTERPOLANT_TOLERANCE,
          measured: { exact: byClass.interp.exact, of: byClass.interp.n, maxDiff: byClass.interp.maxDiff },
          expected: `maxDiff <= ${BC1_INTERPOLANT_TOLERANCE}`,
          note: "S3TC leaves interpolant low bits implementation-defined; this GPU interpolates in 565 space, decodeBC1 in 8-bit",
        }))
      );
    }

    const artifact = await saveComparison(ctx.runId, name, gpu, cpu);

    return {
      checks,
      calibration: 'OK',
      artifacts: artifact ? [artifact] : [],
      inputs: { format, dim: DIM, fixture: name },
      stats: {
        modeHistogram: hist ? [...hist].map((n, m) => (n ? `mode${m}:${n}` : null)).filter(Boolean) : null,
        mismatchesSameOrder: cmp.sameOrder,
        mismatchesFlipped: cmp.flipped,
        blockBytes: blocks.length,
      },
    };
  }

  const scenarios = new Map();

  scenarios.set('mode5-matches-hardware', {
    name: 'mode5-matches-hardware',
    summary: 'BC7 mode 5 (separate colour/alpha index tracks) decodes on real hardware as we decode it',
    run: (ctx) => runComparison({ image: mode5Fixture(), format: 'bc7', expectMode: 5, name: 'mode5', ctx }),
  });

  scenarios.set('mode6-matches-hardware', {
    name: 'mode6-matches-hardware',
    summary: 'BC7 mode 6 — the mode that already shipped — is undisturbed by the multi-mode change',
    run: (ctx) => runComparison({ image: mode6Fixture(), format: 'bc7', expectMode: 6, name: 'mode6', ctx }),
  });

  scenarios.set('mode7-matches-hardware', {
    name: 'mode7-matches-hardware',
    summary: 'BC7 mode 7 (2 subsets, 64-entry partition table, TWO anchors) decodes as we decode it',
    run: (ctx) => runComparison({ image: mode7Fixture(), format: 'bc7', expectMode: 7, name: 'mode7', ctx }),
  });

  scenarios.set('all-modes-mixed', {
    name: 'all-modes-mixed',
    summary: 'A realistic mixture producing all three modes in one texture',
    run: (ctx) => runComparison({ image: mixedFixture(), format: 'bc7', expectMode: null, name: 'mixed', ctx }),
  });

  scenarios.set('bc1-matches-hardware', {
    name: 'bc1-matches-hardware',
    summary: 'BC1 (opaque path, PCA + least-squares endpoints) decodes as we decode it',
    run: (ctx) => runComparison({ image: bc1Fixture(), format: 'bc1', expectMode: null, name: 'bc1', ctx }),
  });

  const bench = {
    name: 'block-compress',
    title: 'BC1/BC7 encoder — real-hardware decode parity',
    rung: 1,
    summary:
      'Encodes with the real vt/block-compress.js, uploads as a real CompressedTexture, and demands the ' +
      "GPU's fixed-function decode equal our reference decoder byte for byte. The only oracle that is " +
      'independent of our own reading of the BC7 spec.',
    scenarios,
    checkIds: [
      'device-supports-texture-compression-bc',
      'mode-5-blocks-present',
      'mode-6-blocks-present',
      'mode-7-blocks-present',
      'something-was-actually-drawn',
      'orientation-is-unambiguous',
      'gpu-decode-equals-our-decoder-exactly',
    ],
    ready: () => true,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },
  };

  registerBench(bench);
  return bench;
}
