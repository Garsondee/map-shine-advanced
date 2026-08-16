/**
 * SHADER LAB — DOES CAS SHARPENING AMPLIFY BC1 QUANTIZATION NOISE?
 *
 * ============================================================================
 * UPDATE, SAME SESSION: THE FLAT-NOISE HYPOTHESIS BELOW WAS REJECTED —
 * THE REAL MECHANISM IS CHROMATIC FRINGING, CONFIRMED (see scenario
 * 'chromatic-fringing-on-a-coloured-edge' below)
 * ============================================================================
 * The BC1-flat-region-noise hypothesis this bench was originally built to
 * check measured out negligible (amplification factor ~1.01-1.03x, real
 * device, real encoder — see `does-sharpening-amplify-bc1-noise` below,
 * still kept as a real, useful negative result). Looking at the REAL bench
 * Mansion afterward (msa-look harness, `tests/playwright-artifacts/look/
 * run-albedo-clarity-look-test.mjs`) found the actual artefact instead:
 * rainbow/chromatic fringing at edges, dramatic at sharpness 0.4, present
 * more subtly at the shipped 0.22 default. Root cause, confirmed with real
 * numbers (`chromatic-fringing-on-a-coloured-edge`): `buildAlbedoClarityNode`
 * computes its ringing-guard `amp` and weight `w` as `vec3` — PER CHANNEL —
 * so R/G/B each get an independently-computed sharpen weight from their own
 * local min/max. A grayscale edge (R=G=B always) can never reveal this,
 * which is exactly why the original hypothesis's edge fixture missed it. See
 * `vt/albedo-clarity.js`'s own inline comment (right above the `mn`/`mx`/
 * `amp` block) for the full account, including two attempted luma-locked
 * fixes that did NOT cleanly resolve it in testing and were NOT shipped.
 *
 * ============================================================================
 * THE ORIGINAL HYPOTHESIS THIS BENCH WAS BUILT TO CHECK, BEFORE TOUCHING
 * SHADER CODE (kept verbatim — the negative result is still real and useful)
 * ============================================================================
 * Author report (2026-08-15): the zoom-out sharpening (`buildAlbedoClarityNode`,
 * `vt/albedo-clarity.js` — AMD FidelityFX CAS) looks too harsh / ringing,
 * worse at some zoom levels than others.
 *
 * CAS's own ringing guard (`amp`, the min/max-of-neighbours term) is tuned to
 * protect near-black/near-white extremes — exactly right for a clean ink line
 * on paper, which is the case its own design doc measures against. It does
 * NOT guard against small, uniform local variation in a MID-TONE region — and
 * BC1 block compression is a well-known source of exactly that: each 4×4
 * texel block quantizes to 2 endpoint colours + a 2-bit index per texel, so a
 * smooth analog gradient gets stair-stepped into 4 discrete levels per block.
 * CAS cannot tell that apart from "real detail to restore" and would amplify
 * it the same way it amplifies a genuine edge — the plausible mechanism
 * behind "ringing, worse at some zoom levels" (the band where the gate has
 * ramped to full strength but the far roll-off hasn't started backing off,
 * `gateHi=1.8` to `farLo=6.0`).
 *
 * This is a HYPOTHESIS (memory: feedback_plausible_diagnosis_rots,
 * feedback_defensive_fix_needs_same_proof_as_bug) — checked here with real
 * numbers before any shader line changes, not assumed.
 *
 * ============================================================================
 * WHAT IS REAL HERE
 * ============================================================================
 * REAL, imported unmodified: `encodeBC1` (`vt/block-compress.js` — the exact
 * production encoder every real map texture goes through) and
 * `buildAlbedoClarityNode`/`buildFlatAlbedoNode` (`vt/albedo-clarity.js` —
 * the exact production shader-building functions, extracted into their own
 * module specifically so this bench could import them directly rather than
 * transcribe them — see that module's own header).
 *
 * Two fixtures, both real BC1-encoded then rendered through a real GPU:
 *   - `edgeFixture` — a clean hard edge. Sharpening MUST still restore
 *     contrast here, or a "fix" for ringing would have broken the feature.
 *   - `flatFixture` — a smooth, slow diagonal gradient. To the eye this reads
 *     as flat painted shading, not "detail" — but BC1's 4-level-per-block
 *     quantization of a smooth ramp is a genuine, real compression artifact
 *     (confirmed non-vacuously below, not assumed). The question this fixture
 *     answers: does CAS read that artifact as detail and amplify it?
 *
 * ============================================================================
 * WHAT IS DELIBERATELY NOT TESTED HERE, AND WHY THAT'S AN HONEST LIMIT
 * ============================================================================
 * Production uploads a REAL PRE-BAKED MIP CHAIN (`LinearMipmapLinearFilter`,
 * `bc-compress.worker.js` encodes each level independently) and lets the GPU
 * blend across it. This bench uploads ONE mip level only (`generateMipmaps:
 * false`, plain `LinearFilter`) and forces minification purely by drawing a
 * DIM×DIM texture onto a smaller render target — so `texelsPerPixel` (what
 * `buildAlbedoClarityNode` reads off screen-space derivatives, driving its
 * gate) is real and correct, but every sample is unambiguously mip-0 BC1
 * noise, never mip-chain-blurred. That is deliberate: it isolates the
 * mechanism under test (does CAS amplify raw block-quantization noise) from a
 * second, separate variable (how much a real trilinear mip chain would
 * already soften it at a given zoom). A positive result here is real evidence
 * the mechanism exists; it does not by itself measure how much of production's
 * real on-screen look it explains at every zoom level — that needs the real
 * harness, on real map art (see the plan this bench was built for, Part 1
 * step 3).
 *
 * @module tools/shader-lab/bench-albedo-clarity
 */
import { registerBench, evaluate, saveArtifact } from './contract.js';
import { encodeBC1 } from '../../src/vt/block-compress.js';
import { buildAlbedoClarityNode, buildFlatAlbedoNode, setAlbedoClarity } from '../../src/vt/albedo-clarity.js';

/** Source fixture edge, in texels — a multiple of 4 (the BC1 block grid),
 * matching bench-block-compress.js's own scale. */
const DIM = 64;
/** Render target edge. DIM/OUT_DIM = 4 source texels per output pixel —
 * comfortably past gateHi (1.8, full CAS strength) and well short of farLo
 * (6.0, where the far roll-off would start easing strength back down) — the
 * "always full strength" band the ringing complaint points at. */
const OUT_DIM = 16;
const TEXELS_PER_PIXEL = DIM / OUT_DIM;

/** Build a DIM×DIM RGBA8 image from a per-texel fn(x,y) → [r,g,b,a]. Same
 * helper as bench-block-compress.js. */
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

/** Hard vertical edge — dark ink (left) against light paper (right), the
 * exact case buildAlbedoClarityNode's own doc measures its ring guard
 * against. Sharpening restoring THIS is the positive control. */
function edgeFixture() {
  return makeImage(DIM, DIM, (x) => {
    const v = x >= DIM / 2 ? 235 : 20;
    return [v, v, v, 255];
  });
}

/** A COLOURED hard edge — warm tan/wood [180,140,80] against a muted wine-red
 * [90,30,30], a palette deliberately close to real painted map art. Unlike
 * `edgeFixture` (grayscale, R=G=B always) this can actually SHOW chromatic
 * fringing: `buildAlbedoClarityNode`'s ringing guard is computed per-channel
 * (vec3 `amp`/`w`), so a grayscale edge can never exercise the bug — every
 * channel would coincidentally get the identical weight regardless of
 * whether the computation is shared or per-channel. */
function colouredEdgeFixture() {
  return makeImage(DIM, DIM, (x) => {
    const [r, g, b] = x < DIM / 2 ? [180, 140, 80] : [90, 30, 30];
    return [r, g, b, 255];
  });
}

/** Smooth diagonal gradient, narrow band (90..130) — reads as flat painted
 * shading to the eye (no edges, no fine detail), but BC1 must quantize the
 * analog ramp into 4 discrete levels per 4×4 block. This is the fixture the
 * amplification hypothesis is checked against. */
function flatFixture() {
  return makeImage(DIM, DIM, (x, y) => {
    const t = (x + y) / (2 * DIM);
    const v = Math.round(90 + t * 40);
    return [v, v, v, 255];
  });
}

/** Sample mean/stddev/range over an RGBA8 buffer's red channel (fixtures are
 * greyscale, so R alone carries the signal) within [x0,y0,x1,y1). */
function stats(buf, dim, x0, y0, x1, y1) {
  let n = 0;
  let sum = 0;
  let min = 255;
  let max = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = buf[(y * dim + x) * 4];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      n++;
    }
  }
  const mean = sum / n;
  let sqDiff = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = buf[(y * dim + x) * 4];
      sqDiff += (v - mean) ** 2;
    }
  }
  return { n, mean, min, max, range: max - min, stddev: Math.sqrt(sqDiff / n) };
}

export function createAlbedoClarityBench({ THREE, log }) {
  let renderer = null;
  let camera = null;
  let outRt = null;
  let bcSupported = null;

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    // NoToneMapping: nothing between the shader's own output and the
    // readback should distort the numbers under comparison.
    renderer.toneMapping = THREE.NoToneMapping;
    camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.01, 10);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    outRt = new THREE.RenderTarget(OUT_DIM, OUT_DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      // ⚠️ SRGBColorSpace HERE, on the TARGET's own texture — not
      // `renderer.outputColorSpace`, which this bench first tried and which
      // measurably does NOTHING for an offscreen RenderTarget (verified:
      // identical readback bytes with it set to SRGBColorSpace vs left
      // unset). This is the real lever, and getting it right matters: the
      // input texture is `SRGBColorSpace` (matching production — art bytes
      // ARE sRGB, sampling decodes to linear) and
      // `buildAlbedoClarityNode`/`buildFlatAlbedoNode` correctly work and
      // return LINEAR values, same as production. Reading THAT back with
      // the target left `NoColorSpace` compares raw linear bytes against
      // the ORIGINAL sRGB-encoded source bytes directly — apples to
      // oranges. A source byte of 20 decodes to linear ≈0.006 ⇒ written
      // raw ⇒ reads back ≈1; 235 ⇒ linear≈0.83 ⇒ byte ≈220 — both LOWER
      // than the source, which briefly looked exactly like ringing/
      // overshoot and was pure colour-space confusion, not a shader
      // finding (`bench-composite.js`'s own recorded lesson: "judge
      // perceptual differences in DISPLAY space... convert through the
      // OETF first" — the exact fix, applied here). `SRGBColorSpace` on
      // the target re-applies that OETF on the way out, so a readback byte
      // is directly comparable to the ORIGINAL sRGB source byte.
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: false,
    });
    const device = renderer.backend?.device ?? null;
    bcSupported = device ? device.features?.has?.('texture-compression-bc') === true : null;
    log?.(`ALBEDO-CLARITY: backend ${renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL'}, bc=${bcSupported}`);
  }

  /**
   * Upload `image` as a real, single-level BC1 CompressedTexture — same
   * colour handling production uses (`vt-pan-viewer.js`'s own compressed-art
   * upload: `flipY=false`, `colorSpace=SRGBColorSpace`) minus the real mip
   * chain (see this module's header for why that's an honest, named limit).
   * @returns {*} the CompressedTexture
   */
  function uploadBC1(image) {
    const blocks = encodeBC1(image, DIM, DIM);
    const tex = new THREE.CompressedTexture([{ data: blocks, width: DIM, height: DIM }], DIM, DIM, THREE.RGBA_S3TC_DXT1_Format);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace; // matches production art upload exactly
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter; // single level — see header, "deliberately not tested"
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Draw `tex` (DIM×DIM) onto a plane sized to fill the OUT_DIM×OUT_DIM
   * target exactly — the real minification this bench needs — through
   * `nodeBuilder(THREE, tex, uv, texSize)`, and read the RGBA8 result back.
   */
  async function renderThrough(tex, nodeBuilder) {
    await ensureRenderer();
    const { uv, vec2, vec4 } = THREE.TSL;
    const material = new THREE.NodeMaterial();
    const uvS = uv();
    const uTexSize = vec2(DIM, DIM);
    const clear = nodeBuilder(THREE, tex, uvS, uTexSize);
    material.colorNode = vec4(clear.rgb, clear.a);
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

    renderer.setRenderTarget(outRt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(null);
    const buf = await renderer.readRenderTargetPixelsAsync(outRt, 0, 0, OUT_DIM, OUT_DIM);

    geo.dispose();
    material.dispose?.();
    return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
  }

  /** Persist a side-by-side sharpened/flat comparison PNG (AGENTS.md rule 4 —
   * look at the picture, don't only read numbers). */
  async function saveComparison(runId, name, sharpened, flat) {
    const canvas = document.createElement('canvas');
    canvas.width = OUT_DIM * 2;
    canvas.height = OUT_DIM;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(OUT_DIM * 2, OUT_DIM);
    for (let y = 0; y < OUT_DIM; y++) {
      for (let x = 0; x < OUT_DIM; x++) {
        const src = (y * OUT_DIM + x) * 4;
        const dstS = (y * OUT_DIM * 2 + x) * 4;
        const dstF = (y * OUT_DIM * 2 + OUT_DIM + x) * 4;
        for (let k = 0; k < 4; k++) {
          img.data[dstS + k] = sharpened[src + k];
          img.data[dstF + k] = flat[src + k];
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) return null;
    const file = `${name}-sharpened-vs-flat.png`;
    const res = await saveArtifact(runId, file, blob);
    return res?.ok ? file : null;
  }

  const scenarios = new Map();

  scenarios.set('edge-restoration-still-works', {
    name: 'edge-restoration-still-works',
    summary:
      'Positive control: sharpening measurably restores contrast across a real BC1-encoded hard edge — ' +
      'and measures OVERSHOOT beyond the source\'s own [20,235] range, the classic ringing/halo signature. ' +
      'Params: { sharpness } (default 0.22, the shipped value).',
    async run(ctx) {
      await ensureRenderer();
      if (bcSupported === false) {
        return {
          checks: [
            evaluate('device-supports-texture-compression-bc', () => {
              throw new Error('device lacks texture-compression-bc; nothing can be measured here');
            }),
          ],
          calibration: 'OK',
        };
      }
      const sharpness = Number.isFinite(ctx?.params?.sharpness) ? ctx.params.sharpness : 0.22;
      setAlbedoClarity({ sharpness, gateLo: 1.0, gateHi: 1.8, farLo: 6.0, farHi: 16.0, farFloor: 0.35, enabled: true });
      const SOURCE_LO = 20;
      const SOURCE_HI = 235;
      const tex = uploadBC1(edgeFixture());
      const sharpened = await renderThrough(tex, buildAlbedoClarityNode);
      const flat = await renderThrough(tex, buildFlatAlbedoNode);
      tex.dispose();

      // A window either side of the output-space edge boundary (OUT_DIM/2).
      const half = OUT_DIM / 2;
      const win = Math.max(2, Math.round(OUT_DIM * 0.25));
      const rSharp = stats(sharpened, OUT_DIM, half - win, 0, half + win, OUT_DIM);
      const rFlat = stats(flat, OUT_DIM, half - win, 0, half + win, OUT_DIM);
      // OVERSHOOT: how far the sharpened output goes BEYOND the source's own
      // darkest/lightest byte values — real ringing, not just "more contrast".
      // A sharpen that restores exactly [20,235] and no further has zero
      // overshoot; one that pushes past pure source extremes is haloing.
      const overshootLow = Math.max(0, SOURCE_LO - rSharp.min);
      const overshootHigh = Math.max(0, rSharp.max - SOURCE_HI);

      const artifact = await saveComparison(ctx.runId, 'edge', sharpened, flat);
      return {
        checks: [
          evaluate('something-was-actually-drawn', () => ({
            ok: rFlat.range > 10,
            measured: rFlat.range,
            expected: '> 10 (a real edge is present in the unsharpened baseline)',
            note: 'non-vacuity: if the flat render has no edge either, the comparison below proves nothing',
          })),
          evaluate('sharpening-increases-edge-contrast', () => ({
            ok: rSharp.range >= rFlat.range,
            measured: { sharpenedRange: rSharp.range, flatRange: rFlat.range },
            expected: 'sharpened range >= flat range',
            note: 'the feature this whole system exists for must survive the extraction unchanged',
          })),
          evaluate('overshoot-beyond-source-extremes', () => ({
            ok: overshootLow === 0 && overshootHigh === 0,
            measured: { overshootLow, overshootHigh, sharpenedMin: rSharp.min, sharpenedMax: rSharp.max },
            expected: `both 0 — source bytes never left [${SOURCE_LO},${SOURCE_HI}]`,
            note:
              'HONEST AMBIGUITY, unlike the chromatic-fringing scenario\'s clean-cut finding: this fixture\'s ' +
              'source sits near the byte ceiling (235), so a fail here could be genuine restoration clipping ' +
              'at 255 rather than true overshoot — a MID-TONE coloured edge (see ' +
              '`chromatic-fringing-on-a-coloured-edge`) is what actually separated "restoration" from ' +
              '"artifact" for this effect. Kept as a real, honestly-labelled measurement, not a verdict.',
          })),
        ],
        calibration: 'OK',
        artifacts: artifact ? [artifact] : [],
        inputs: { texelsPerPixel: TEXELS_PER_PIXEL, sharpness, sourceRange: [SOURCE_LO, SOURCE_HI] },
        stats: { sharpened: rSharp, flat: rFlat, overshootLow, overshootHigh },
      };
    },
  });

  scenarios.set('chromatic-fringing-on-a-coloured-edge', {
    name: 'chromatic-fringing-on-a-coloured-edge',
    summary:
      'THE CONFIRMED FINDING (2026-08-15). A real-palette COLOURED edge, sharpened at the shipped default — ' +
      'do R/G/B shift by wildly different proportions at the boundary texel (a HUE shift, i.e. rainbow ' +
      'fringing), not just a brightness one? A grayscale edge could never show this either way.',
    async run(ctx) {
      await ensureRenderer();
      if (bcSupported === false) {
        return {
          checks: [
            evaluate('device-supports-texture-compression-bc', () => {
              throw new Error('device lacks texture-compression-bc; nothing can be measured here');
            }),
          ],
          calibration: 'OK',
        };
      }
      setAlbedoClarity({ sharpness: 0.22, gateLo: 1.0, gateHi: 1.8, farLo: 6.0, farHi: 16.0, farFloor: 0.35, enabled: true });
      const SOURCE_RIGHT = [90, 30, 30]; // the darker side — where the divergence was measured
      const tex = uploadBC1(colouredEdgeFixture());
      const sharpened = await renderThrough(tex, buildAlbedoClarityNode);
      const flat = await renderThrough(tex, buildFlatAlbedoNode);
      tex.dispose();

      // The boundary texel on the right (darker) side — OUT_DIM/2, the first
      // column fully past the edge. Same window logic as edge-restoration's
      // own half/win, narrowed to the single boundary texel since that is
      // where the divergence concentrates.
      const half = OUT_DIM / 2;
      const bx = half; // first texel of the right side
      const by = Math.floor(OUT_DIM / 2);
      const px = (y, x, buf) => [0, 1, 2].map((k) => buf[(y * OUT_DIM + x) * 4 + k]);
      const boundarySharp = px(by, bx, sharpened);
      const boundaryFlat = px(by, bx, flat);

      // Per-channel proportional change from the UNSHARPENED baseline (not
      // the raw source — the baseline already carries BC1's own encode, so
      // this isolates what SHARPENING specifically did, same discipline as
      // edge-restoration's own overshoot metric).
      const pctChange = [0, 1, 2].map((k) => (boundaryFlat[k] > 0 ? (boundarySharp[k] - boundaryFlat[k]) / boundaryFlat[k] : null));
      const finitePct = pctChange.filter((v) => v !== null);
      const spread = finitePct.length > 0 ? Math.max(...finitePct) - Math.min(...finitePct) : null;

      const artifact = await saveComparison(ctx.runId, 'chromatic-edge', sharpened, flat);
      return {
        checks: [
          evaluate('boundary-texel-is-real-and-non-vacuous', () => ({
            ok: boundaryFlat.some((v) => v > 0),
            measured: boundaryFlat,
            expected: 'at least one non-zero channel — otherwise there is nothing to measure a divergence against',
          })),
          // ⚠️ THIS SCENARIO IS SUPPOSED TO FAIL, TODAY — same convention
          // bench-floor-lighting.js's own `real-map-reproduces-the-live-bug`
          // established: `ok` means "healthy" (hue preserved, no fringing),
          // so a live, uncorrected bug reads as `fail`, not `pass`. If a
          // future session sees this scenario suddenly report `ok:true`,
          // that means a real luma-locked fix landed — celebrate, then
          // update this comment (it says "MUST FAIL, TODAY" for a reason)
          // rather than being alarmed.
          evaluate('hue-is-preserved-no-chromatic-fringing', () => {
            // A pure brightness (luma-only, hue-preserving) change would move
            // every channel by close to the SAME proportion. A wide spread
            // between the channels' own % change is a HUE shift — measured
            // here, not inferred. Threshold (0.15 = 15 percentage points
            // apart) is generous; the actual measured spread at the shipped
            // default was far past it (R -43%, G -83%, B -53% — a 40-point
            // spread between R and G alone).
            const healthy = spread !== null && spread <= 0.15;
            return {
              ok: healthy,
              measured: { rgbPctChange: pctChange, spread, boundarySharp, boundaryFlat, source: SOURCE_RIGHT },
              expected: 'spread <= 0.15 (channels move together — no hue shift)',
              note: healthy
                ? 'hue preserved — if this is unexpectedly healthy, a fix may have landed; update vt/albedo-clarity.js\'s inline comment'
                : "CONFIRMED chromatic fringing, MUST FAIL TODAY — see vt/albedo-clarity.js's inline comment above the mn/mx/amp block for the full account and why a fix was not shipped this session",
            };
          }),
        ],
        calibration: 'OK',
        artifacts: artifact ? [artifact] : [],
        inputs: { texelsPerPixel: TEXELS_PER_PIXEL, sharpness: 0.22, sourceLeft: [180, 140, 80], sourceRight: SOURCE_RIGHT },
        stats: { boundarySharp, boundaryFlat, pctChange, spread },
      };
    },
  });

  scenarios.set('does-sharpening-amplify-bc1-noise', {
    name: 'does-sharpening-amplify-bc1-noise',
    summary:
      'THE HYPOTHESIS CHECK. A smooth gradient, real BC1-encoded, sharpened vs. not — does CAS read the ' +
      'block-quantization stairsteps as detail and amplify them?',
    async run(ctx) {
      await ensureRenderer();
      if (bcSupported === false) {
        return {
          checks: [
            evaluate('device-supports-texture-compression-bc', () => {
              throw new Error('device lacks texture-compression-bc; nothing can be measured here');
            }),
          ],
          calibration: 'OK',
        };
      }
      setAlbedoClarity({ sharpness: 0.22, gateLo: 1.0, gateHi: 1.8, farLo: 6.0, farHi: 16.0, farFloor: 0.35, enabled: true });
      const rawImage = flatFixture();
      const tex = uploadBC1(rawImage);
      const sharpened = await renderThrough(tex, buildAlbedoClarityNode);
      const flat = await renderThrough(tex, buildFlatAlbedoNode);
      tex.dispose();

      const rSharp = stats(sharpened, OUT_DIM, 0, 0, OUT_DIM, OUT_DIM);
      const rFlat = stats(flat, OUT_DIM, 0, 0, OUT_DIM, OUT_DIM);
      // The RAW pre-compression source's own stddev, computed directly on the
      // CPU array — the floor: real BC1 quantization noise is whatever
      // stddev the flat (unsharpened) BC1 render has ABOVE this number, since
      // a perfectly lossless round-trip would reproduce the smooth ramp
      // exactly (stddev close to the raw source's own, which is non-zero
      // because it's a real gradient, not a constant).
      const rawStats = stats(rawImage, DIM, 0, 0, DIM, DIM);

      const amplification = rFlat.stddev > 0.01 ? rSharp.stddev / rFlat.stddev : null;
      const artifact = await saveComparison(ctx.runId, 'flat', sharpened, flat);

      return {
        checks: [
          evaluate('bc1-encoding-introduced-real-quantization-noise', () => ({
            ok: rFlat.stddev > rawStats.stddev * 1.1,
            measured: { unsharpenedBc1Stddev: rFlat.stddev, rawSourceStddev: rawStats.stddev },
            expected: 'BC1 stddev measurably above the raw smooth source — otherwise there is no real noise here to amplify',
            note: 'non-vacuity: this is what makes the amplification check below meaningful rather than trivially true',
          })),
          evaluate('sharpening-does-not-substantially-amplify-flat-region-noise', () => ({
            ok: amplification !== null && amplification <= 1.5,
            measured: { amplificationFactor: amplification, sharpenedStddev: rSharp.stddev, unsharpenedStddev: rFlat.stddev },
            expected: 'amplification factor <= 1.5x — a fail here is the hypothesis CONFIRMING, not a broken bench',
            note: 'THE finding this bench exists to produce. Report the real ratio either way.',
          })),
        ],
        calibration: 'OK',
        artifacts: artifact ? [artifact] : [],
        inputs: { texelsPerPixel: TEXELS_PER_PIXEL, sharpness: 0.22, fixture: 'smooth diagonal gradient, band 90..130' },
        stats: { sharpened: rSharp, flat: rFlat, rawSource: rawStats, amplification },
      };
    },
  });

  const bench = {
    name: 'albedo-clarity',
    title: 'Albedo Clarity (CAS sharpen) — ringing/fringing diagnosis',
    rung: 1,
    summary:
      'Encodes real fixtures with the real vt/block-compress.js BC1 encoder, renders them through the real ' +
      'buildAlbedoClarityNode/buildFlatAlbedoNode, and checks: edge restoration still works; sharpening does ' +
      'NOT substantially amplify BC1 quantization noise in flat regions (rejected hypothesis, kept as a real ' +
      "negative result); and — the CONFIRMED finding — a coloured edge's R/G/B channels diverge by very " +
      'different proportions at the shipped default, i.e. chromatic/rainbow fringing.',
    scenarios,
    checkIds: [
      'device-supports-texture-compression-bc',
      'something-was-actually-drawn',
      'sharpening-increases-edge-contrast',
      'overshoot-beyond-source-extremes',
      'boundary-texel-is-real-and-non-vacuous',
      'hue-is-preserved-no-chromatic-fringing',
      'bc1-encoding-introduced-real-quantization-noise',
      'sharpening-does-not-substantially-amplify-flat-region-noise',
    ],
    ready: () => true,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },
  };

  registerBench(bench);
  return bench;
}
