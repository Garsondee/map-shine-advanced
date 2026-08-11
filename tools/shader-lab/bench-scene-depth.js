/**
 * SHADER LAB — THE DEPTH AUTHORITY'S GPU HALF (docs/planning/Depth-Buffer.md,
 * stage 1). Proves, on a real WebGPU device, the mechanism `vt/scene-depth.js`
 * is about to be built on TOP of — BEFORE any production code commits to it.
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS, AND WHY IT COMES BEFORE PRODUCTION CODE
 * ============================================================================
 * The design doc's own risk list (§11) names this directly: "Sampling a
 * `depth32float` render-target texture in TSL… must be proven in Shader Lab
 * before stage 1 commits." Nothing in the vendored three.js source read so
 * far RULES OUT any of the mechanics this bench checks, but reading source
 * proves capability, not behaviour — this project's own most expensive
 * lesson, repeated across fifteen rounds of a DIFFERENT investigation
 * (`docs/planning/Light-Elevation-Occlusion-Failure.md`), is that a shader
 * that compiles and a shader that does the right thing are different claims.
 *
 * THE ONE THING THIS MECHANISM MUST DELIVER THAT THE OLD ONE COULDN'T: a real
 * depth test is ORDER-INDEPENDENT. `vt/scene-attr.js`'s alpha-blended write
 * makes "what's on top" a function of DRAW ORDER (last-writer-wins, alpha
 * permitting) — which is exactly the mechanism the Light-Elevation-Occlusion
 * failure report's own §"THE POLARITY IS THE WHOLE POINT" section had to
 * fight with margins and thresholds. `scenario('order-independence')` is the
 * one check that actually proves the NEW mechanism doesn't have that problem
 * at all, rather than arguing it shouldn't.
 *
 * ============================================================================
 * WHAT IS REAL HERE AND WHAT IS NOT
 * ============================================================================
 * REAL, imported from `src/`, never transcribed:
 *   - `createDepthAuthority` (`scene/index.js`) — the SAME CPU rank authority
 *     `vt-pan-viewer.js` now calls every residency pass (stage 1's CPU half,
 *     already live). This bench feeds it real items and reads real ranks —
 *     it does not reimplement ranking.
 *   - `collectLevelTextures` + `fixtures/tower-bridge.js` — the real map,
 *     the SAME producer `bench-floor-lighting.js`'s own stage-0 scenario
 *     uses (`docs/planning/Depth-Buffer.md` §9a already found and fixed four
 *     bugs in getting this real-art pipeline right; this bench inherits
 *     those fixes rather than re-discovering them).
 *   - `computeQuadCorners`/`buildQuadPositions`/`QUAD_UVS`/`QUAD_INDICES` —
 *     the real world-quad geometry convention.
 *
 * DELIBERATELY SYNTHETIC, and named so: scenarios 1-3 and 5 use small
 * hand-built quads at KNOWN ranks, no real art at all — fast to iterate, and
 * precise enough to isolate ONE mechanical question per scenario
 * (order-independence, rank round-trip, discard, GPU-side query) before the
 * real map's own complexity (five real layers, real alpha, real holes) is
 * layered on in scenario 4.
 *
 * ============================================================================
 * THE MATERIAL, IN ONE SENTENCE
 * ============================================================================
 * `depthTest:true, depthWrite:true, depthFunc:THREE.LessDepth`,
 * `mesh.position.z = (rank+1)/(maxRank+1)` (never `fragDepth` — a shader that
 * writes fragDepth disables early-Z on every GPU), a fragment that
 * `.discard()`s below the item's own `alphaThreshold` and otherwise writes
 * the payload. No blending anywhere — the depth TEST is the composition;
 * `packFloorAttr`'s whole "alpha as a blend factor" problem class does not
 * exist here because nothing blends.
 *
 * ⚠️ `LessDepth`, NOT the initially-chosen `GreaterDepth` — found empirically
 * by this bench's own first run of `order-independence`, not reasoned out in
 * advance (exactly the discipline this file's own header opens with). The
 * camera sits at world z=5 looking toward z=0; a HIGHER rank's world-z
 * (closer to 1) is therefore CLOSER to the camera than a lower rank's
 * (closer to 0) — and under an ordinary, non-reversed depth convention,
 * CLOSER means a SMALLER stored depth value. So "higher rank wins" is
 * `LessDepth`, not `GreaterDepth`, GIVEN this camera's own position and
 * facing. This was never a `reversedDepthBuffer` backend quirk (the
 * candidate explanation this file's own comments first reached for) — it
 * was this bench's own camera-relative distance running backwards from an
 * unstated assumption. Clear depth is `1` (the far/"nothing wins over
 * this" value): every real rank's world-z sits in `(0,1)`, always closer to
 * the camera than the clear plane, so an unwritten texel always loses to
 * anything real — the SAME fail-open guarantee, reached by the opposite
 * convention. The mechanism itself proved out exactly as designed on the
 * FIRST try: the two order-independence renders were pixel-identical from
 * the very first run, confirming a real depth test does not care about
 * submission order — a property `vt/scene-attr.js`'s alpha blend never had.
 * Only the WINNER was backwards, and only because of this bench's own
 * camera choice, not the mechanism being proven.
 *
 * @module tools/shader-lab/bench-scene-depth
 */
import { createDepthAuthority } from '../../src/scene/index.js';
import { collectLevelTextures } from '../../src/foundry/scene-layers.js';
import { loadMaskImageTexture } from '../../src/vt/mask-image.js';
import { computeQuadCorners } from '../../src/foundry/scene-geometry.js';
import { buildQuadPositions, QUAD_UVS, QUAD_INDICES } from '../../src/scene/world-quad.js';
import FIXTURE from './fixtures/tower-bridge.js';
import { check, evaluate, registerBench, saveCanvasPng } from './contract.js';

/** Small synthetic world — fast to iterate, no image loads. */
const WORLD = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
const DIM = 256;

/**
 * A world-rect quad with a REAL uv attribute — the SAME construction
 * `bench-floor-lighting.js`'s own stage-0 `buildWorldQuadMesh` uses (kept as
 * a second small copy here rather than an export across bench files, per
 * this lab's own established per-bench-ownership precedent — AGENTS.md §5).
 *
 * @param {*} THREE @param {{minX:number,minY:number,maxX:number,maxY:number}} rect
 * @param {*} material @param {number} z
 * @returns {*} a `THREE.Mesh`.
 */
function buildQuadMesh(THREE, rect, material, z) {
  const placement = {
    x: (rect.minX + rect.maxX) / 2,
    y: (rect.minY + rect.maxY) / 2,
    width: rect.maxX - rect.minX,
    height: rect.maxY - rect.minY,
    anchorX: 0.5,
    anchorY: 0.5,
    rotation: 0,
  };
  const corners = computeQuadCorners(placement);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(buildQuadPositions(corners), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geo.setIndex([...QUAD_INDICES]);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.z = z;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * THE DEPTH-WRITER MATERIAL — the one thing `vt/scene-depth.js`'s real pass
 * will also build, proven here first. `tex` absent means "always solid"
 * (the synthetic scenarios' own common case); present means "read this
 * item's own real alpha", matching production's `.level(float(0))` pin
 * (round 10 of the light-elevation investigation — an implicitly-selected
 * mip on a real texture reading alpha≈0 over visibly opaque paint is a bug
 * this project has already paid for once).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} [args.tex] - a real loaded texture, or absent for "always solid".
 * @param {number} [args.alphaThreshold] - Foundry's own per-item field
 *   (`collectLevelTextures`'s `alphaThreshold`, default 0.75) — the REAL
 *   threshold, never the old attr buffer's hard-coded 0.5
 *   (`ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD`, ` scene-attr.js`) which this
 *   mechanism has no reason to inherit.
 * @param {number} args.r255 @param {number} args.g255 @param {number} args.b255 -
 *   the payload bytes (0-255), packed the same way `packFloorAttr` does.
 * @returns {*} a `THREE.NodeMaterial`.
 */
function buildDepthWriterMaterial({ THREE, tex, alphaThreshold = 0, r255, g255, b255 }) {
  const { Fn, float, vec4, texture } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.side = THREE.DoubleSide;
  material.transparent = false; // no blending anywhere — the depth TEST is the composition
  material.depthTest = true;
  material.depthWrite = true;
  // LessDepth, not GreaterDepth — see this module's own header, "THE
  // MATERIAL, IN ONE SENTENCE" addendum, for the camera-relative-distance
  // reasoning this bench found empirically on its first run.
  material.depthFunc = THREE.LessDepth;
  material.fragmentNode = Fn(() => {
    const a = tex ? texture(tex).level(float(0)).a : float(1);
    a.lessThan(float(alphaThreshold)).discard();
    return vec4(float(r255 / 255), float(g255 / 255), float(b255 / 255), float(1));
  })();
  return material;
}

/**
 * THE QUERY MATERIAL — Β§11's own last-named risk, and the one thing scenarios
 * 1-4 deliberately do NOT prove: every check in this file up to here reads
 * the depth attachment back through `renderer.readRenderTargetPixelsAsync`, a
 * CPU-side copy. A real point light's own shader cannot do that — it has to
 * sample the depth texture from ITS OWN, separate TSL fragment shader, on the
 * GPU, in the same draw call that decides whether to light a pixel at all.
 * This material is that: a SEPARATE material from the one that wrote
 * `depthTexture`, sampling it twice β€” once at `screenUV` (this fragment's own
 * position, whatever is drawn "here") and once at `queryUV` (a KNOWN, fixed
 * screen position established by the write pass) β€” and comparing the two
 * RAW STORED DEPTH values directly.
 *
 * Deliberately NOT attempted: converting either sampled value back into an
 * integer rank. The depth TEST already performed the one conversion that
 * matters (closer-wins); re-deriving what a given rank's stored-depth value
 * "should" be would mean reimplementing `OrthographicCamera`'s own
 * view-to-NDC formula independently in JS, on the strength of reasoning
 * alone, which is exactly the confidence this file's own header already
 * burned once on `GreaterDepth`. Comparing two GPU-sampled values against
 * each other sidesteps that entirely and still proves the thing Β§11 actually
 * asks for: can a DIFFERENT material read this texture and get a usable,
 * order-preserving answer.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.depthTexture - the SAME `THREE.DepthTexture` a prior
 *   `renderDepthPass` wrote into.
 * @param {number} args.queryU - normalised (0..1) screen-space X of a KNOWN
 *   strip's own centre β€” the reference rank being queried against.
 * @param {number} [args.queryV=0.5] - normalised screen-space Y; irrelevant
 *   whenever the reference strip spans the full viewport height, as every
 *   strip in scenario 5 does.
 * @param {number} [args.epsilon=0.01] - how close two stored depths must be
 *   to count as "the same rank". Scenario 5's own three ranks are each
 *   `1/(maxRank+1)` apart (β‰ˆ0.25 here) β€” this is well under a third of that
 *   gap, tight enough to reject a neighbouring rank, loose enough to absorb
 *   ordinary float noise from the depth32float round trip.
 * @returns {*} a `THREE.NodeMaterial` whose color output is
 *   `(isAbove, isEqual, storedDepthHere, 1)` β€” `isAbove`/`isEqual` as 0 or 1
 *   in R/G so a CPU readback of the OUTPUT (a plain colour texture, the
 *   already-proven-working read path) can check the shader's own verdict.
 */
function buildDepthQueryMaterial({ THREE, depthTexture, queryU, queryV = 0.5, epsilon = 0.01 }) {
  const { Fn, texture, screenUV, vec2, vec4, float, select, abs } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => {
    const storedHere = texture(depthTexture, screenUV);
    const queryDepth = texture(depthTexture, vec2(float(queryU), float(queryV)));
    // Smaller stored depth = higher rank (this module's own `LessDepth`
    // convention) — "above" the query means something CLOSER is here.
    const isAbove = storedHere.lessThan(queryDepth);
    const isEqual = abs(storedHere.sub(queryDepth)).lessThan(float(epsilon));
    return vec4(select(isAbove, float(1), float(0)), select(isEqual, float(1), float(0)), storedHere, float(1));
  })();
  return material;
}

export function createSceneDepthBench({ THREE, log }) {
  let renderer = null;
  let camera = null;
  let colorRt = null;
  let depthTex = null;
  /** Empirically established — see `calibrate()`. Never assumed twice (`feedback_y_flip_recurring_risk`). */
  let orientation = null;

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    // Conventional near/far (both POSITIVE, camera looking toward -Z from a
    // point in front of everything) — deliberately NOT this file's sibling
    // bench's `near:-1000, far:1000` convention, which only ever worked
    // because depth was never tested there. Ranks normalise into (0,1); a
    // camera at z=5 looking at z=0 with near=0.01/far=10 brackets that range
    // with wide, unambiguous margin on both sides.
    camera = new THREE.OrthographicCamera(WORLD.minX, WORLD.maxX, WORLD.maxY, WORLD.minY, 0.01, 10);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    depthTex = new THREE.DepthTexture(DIM, DIM, THREE.FloatType);
    colorRt = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
      depthTexture: depthTex,
    });
    log?.(`SCENE-DEPTH: renderer backend ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
  }

  /**
   * Render a list of `{rect, z, material}` draw items into `colorRt`+`depthTex`,
   * in WHATEVER order the array is in — the point of `order` as an explicit
   * parameter is that a caller can pass the SAME items in a DIFFERENT array
   * order and this function must not care.
   *
   * @param {Array<{rect: object, z: number, material: *}>} drawItems
   * @param {{clearDepth?: number}} [opts]
   */
  async function renderDepthPass(drawItems, opts = {}) {
    const scene = new THREE.Scene();
    const disposables = [];
    for (const it of drawItems) {
      const mesh = buildQuadMesh(THREE, it.rect, it.material, it.z);
      scene.add(mesh);
      disposables.push(mesh.geometry);
    }
    const prevTarget = renderer.getRenderTarget();
    const prevClearDepth = renderer.getClearDepth();
    renderer.setRenderTarget(colorRt);
    renderer.setClearColor(0x000000, 0);
    // Clear to 1 (the far plane) — `LessDepth` means SMALLER wins, and every
    // real rank's world-z sits in `(0,1)`, always closer to the camera (and
    // therefore always a smaller stored depth) than the clear value. So a
    // freshly-cleared texel always loses to anything real, same fail-open
    // guarantee `buf:scene.attr`'s own zero-clear reaches for, arrived at
    // from the opposite end. See this module's header for why `LessDepth`
    // and not the initially-assumed `GreaterDepth`.
    renderer.setClearDepth(opts.clearDepth ?? 1);
    renderer.clear(true, true, true);
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearDepth(prevClearDepth);
    // colorRt's CURRENT size, never the DIM constant — scenario 7 resizes the
    // target mid-scenario, and a 256-texel copy out of a 192-texel texture is
    // a device-level validation error (found by that scenario's own first run).
    const colorBuf = await renderer.readRenderTargetPixelsAsync(colorRt, 0, 0, colorRt.width, colorRt.height);
    for (const d of disposables) d.dispose?.();
    return {
      color: ArrayBuffer.isView(colorBuf) ? colorBuf : new Uint8Array(colorBuf),
    };
  }

  /** World (x,y) → readback pixel index, honouring the calibrated orientation. */
  function pixelIndex(x, y) {
    const fx = (x - WORLD.minX) / (WORLD.maxX - WORLD.minX);
    const fy = (y - WORLD.minY) / (WORLD.maxY - WORLD.minY);
    const px = Math.min(DIM - 1, Math.max(0, Math.floor(fx * DIM)));
    const rowFromBottom = Math.min(DIM - 1, Math.max(0, Math.floor(fy * DIM)));
    const row = orientation === 'flipped' ? DIM - 1 - rowFromBottom : rowFromBottom;
    return row * DIM + px;
  }

  function sampleColor(colorBuf, x, y) {
    const i = pixelIndex(x, y) * 4;
    return { r: colorBuf[i], g: colorBuf[i + 1], b: colorBuf[i + 2], a: colorBuf[i + 3] };
  }

  /**
   * ESTABLISH ROW ORDER EMPIRICALLY. Two quads at KNOWN, deliberately
   * Y-ASYMMETRIC world rects (never a Y-centred probe — a centred feature
   * cannot distinguish a flip, `feedback_calibration_needs_a_contrast_guard`'s
   * own "Y-CENTRED test feature cannot calibrate a Y-flip" lesson,
   * `bench-floor-lighting.js` AGENTS.md §10's own trap): one covering only
   * y∈[0,300), the other only y∈[700,1000), different ranks. Reads the
   * COLOR buffer (not depth) since colour is the simplest, already-trusted
   * signal.
   */
  async function calibrate() {
    const low = buildDepthWriterMaterial({ THREE, r255: 10, g255: 0, b255: 0 });
    const high = buildDepthWriterMaterial({ THREE, r255: 200, g255: 0, b255: 0 });
    const { color } = await renderDepthPass([
      { rect: { minX: 0, minY: 0, maxX: 1000, maxY: 300 }, z: 0.3, material: low },
      { rect: { minX: 0, minY: 700, maxX: 1000, maxY: 1000 }, z: 0.3, material: high },
    ]);
    const rowAt = (y, flip) => {
      const fy = y / 1000;
      const rowFromBottom = Math.min(DIM - 1, Math.floor(fy * DIM));
      const row = flip ? DIM - 1 - rowFromBottom : rowFromBottom;
      return color[(row * DIM + Math.floor(DIM / 2)) * 4];
    };
    const straightLow = rowAt(150, false);
    const flippedLow = rowAt(150, true);
    if (straightLow === 10 && flippedLow !== 10) orientation = 'straight';
    else if (flippedLow === 10 && straightLow !== 10) orientation = 'flipped';
    else {
      throw new Error(
        `scene-depth calibrate: ambiguous (straight=${straightLow}, flipped=${flippedLow}, expected exactly one to read 10)`
      );
    }
    log?.(`SCENE-DEPTH: orientation ${orientation} (straight=${straightLow}, flipped=${flippedLow})`);
  }

  function paint(canvas, colorBuf, label) {
    canvas.width = DIM;
    canvas.height = DIM;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(DIM, DIM);
    img.data.set(colorBuf);
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = 'white';
    ctx.font = '12px monospace';
    ctx.fillText(label, 6, 16);
    return canvas;
  }

  const scenarios = new Map();

  /**
   * SCENARIO 1 — THE HEADLINE PROOF: a real depth test resolves overlap
   * ORDER-INDEPENDENTLY. Two full-canvas quads at DIFFERENT ranks (so
   * different Z), fully overlapping. Rendered TWICE — once submitted
   * low-then-high, once high-then-low — through the SAME depth-test
   * material. If the mechanism works, both renders are IDENTICAL: the
   * higher-ranked quad wins regardless of submission order. This is the
   * property `vt/scene-attr.js`'s alpha blend never had (rounds 7 and 10 of
   * the light-elevation investigation are both, in different ways, "the
   * last writer won and it was the wrong one").
   */
  scenarios.set('order-independence', {
    name: 'order-independence',
    summary: 'Two overlapping quads, opposite submission order, SAME depth-test material. Must render identically.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let calibration = 'OK';
      try {
        await calibrate();
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      const low = buildDepthWriterMaterial({ THREE, r255: 40, g255: 40, b255: 40 });
      const high = buildDepthWriterMaterial({ THREE, r255: 220, g255: 220, b255: 220 });
      const rect = WORLD;
      const lowItem = { rect, z: 0.3, material: low };
      const highItem = { rect, z: 0.7, material: high };

      const lowThenHigh = await renderDepthPass([lowItem, highItem]);
      const highThenLow = await renderDepthPass([highItem, lowItem]);

      checks.push(
        evaluate('higher-rank-wins-when-drawn-second', () => {
          const s = sampleColor(lowThenHigh.color, 500, 500);
          return {
            ok: s.r === 220,
            measured: s.r,
            expected: 220,
            note: 'sanity: the higher quad must win when submitted last, the ordinary case',
          };
        })
      );
      checks.push(
        evaluate('THE-PROOF-higher-rank-STILL-wins-when-drawn-FIRST', () => {
          const s = sampleColor(highThenLow.color, 500, 500);
          return {
            ok: s.r === 220,
            measured: s.r,
            expected: 220,
            note: 'the depth TEST decides the winner, not draw order — reversing submission order must change NOTHING',
          };
        })
      );
      checks.push(
        evaluate('the-two-renders-are-pixel-identical', () => {
          let diff = 0;
          for (let i = 0; i < lowThenHigh.color.length; i++) if (lowThenHigh.color[i] !== highThenLow.color[i]) diff++;
          return {
            ok: diff === 0,
            measured: `${diff} differing bytes`,
            expected: '0',
            note: 'order-independence, proven over the WHOLE frame, not one sample point',
          };
        })
      );

      const artifacts = [];
      const canvas = document.createElement('canvas');
      paint(canvas, lowThenHigh.color, 'low then high (submission order)');
      artifacts.push(await saveCanvasPng(ctx.runId, 'order-low-then-high.png', canvas));
      paint(canvas, highThenLow.color, 'high then low (submission order)');
      artifacts.push(await saveCanvasPng(ctx.runId, 'order-high-then-low.png', canvas));

      return { checks, calibration, artifacts: artifacts.filter(Boolean), inputs: { orientation }, stats: {} };
    },
  });

  /**
   * SCENARIO 2 — THE RANK ROUND-TRIP. N synthetic items at KNOWN, deliberately
   * NON-ADJACENT ranks (fed through the REAL `createDepthAuthority`, not a
   * hand-typed z value) must decode back to their OWN rank, exactly, from
   * the payload the material wrote — the direct GPU-side proof of
   * `depth-authority.test.mjs`'s own CPU-side fuzz.
   */
  scenarios.set('rank-round-trips-through-the-real-authority', {
    name: 'rank-round-trips-through-the-real-authority',
    summary: 'N items ranked by the REAL createDepthAuthority; each must be identifiable at its own world position.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let calibration = 'OK';
      try {
        await calibrate();
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      // Five non-overlapping quads, DELIBERATELY handed to the authority in
      // shuffled order — rebuild must do the real sort, this bench must not
      // assume it already agrees with array order.
      const strips = [
        { id: 's0', x0: 0, x1: 200, elevation: 40 },
        { id: 's1', x0: 200, x1: 400, elevation: 0 },
        { id: 's2', x0: 400, x1: 600, elevation: 20 },
        { id: 's3', x0: 600, x1: 800, elevation: 10 },
        { id: 's4', x0: 800, x1: 1000, elevation: 30 },
      ];
      const items = strips.map((s) => ({
        id: s.id,
        key: { elevation: s.elevation, sortLayer: 0, sort: 0, zIndex: 0, tiebreak: 0 },
      }));
      const depth = createDepthAuthority();
      // Shuffle a COPY before rebuilding — the authority's own job is to sort, not trust input order.
      const shuffled = [items[3], items[0], items[4], items[1], items[2]];
      depth.rebuild(shuffled);
      const maxRank = depth.maxRank;

      const drawItems = strips.map((s) => {
        const rank = depth.rankOf(items.find((i) => i.id === s.id));
        const mat = buildDepthWriterMaterial({ THREE, r255: rank, g255: 0, b255: 0 });
        return {
          rect: { minX: s.x0, minY: 0, maxX: s.x1, maxY: 1000 },
          z: (rank + 1) / (maxRank + 1),
          material: mat,
          rank,
        };
      });
      const { color } = await renderDepthPass(drawItems);

      for (const d of drawItems) {
        const midX = (strips.find((s) => s.x0 === d.rect.minX).x0 + d.rect.maxX) / 2;
        checks.push(
          evaluate(`rank-${d.rank}-reads-back-at-its-own-strip`, () => {
            const s = sampleColor(color, midX, 500);
            return {
              ok: s.r === d.rank,
              measured: s.r,
              expected: d.rank,
              note: 'the payload R channel carries the real authority-assigned rank, unchanged by the round trip',
            };
          })
        );
      }

      const artifacts = [];
      const canvas = document.createElement('canvas');
      paint(canvas, color, 'five ranked strips (R = rank byte)');
      artifacts.push(await saveCanvasPng(ctx.runId, 'rank-round-trip.png', canvas));

      return {
        checks,
        calibration,
        artifacts: artifacts.filter(Boolean),
        inputs: { orientation, strips, maxRank },
        stats: { ranks: drawItems.map((d) => d.rank) },
      };
    },
  });

  /**
   * SCENARIO 3 — DISCARD IS THE HOLE-STACK MODEL, IN ONE LINE. A higher-rank
   * quad with a HOLE (alpha=0 over half its area, alpha=1 over the other
   * half) drawn over a lower-rank solid quad. Where the top quad is opaque,
   * it must win (higher rank, real depth write). Where it is transparent,
   * `.discard()` must mean the fragment NEVER enters the depth test at all —
   * so the pixel must show the LOWER item, not a blended/attenuated mix of
   * both (`packFloorAttr`'s whole "a soft edge scales the WHOLE packed byte"
   * failure class, round 15 of the light-elevation investigation, cannot
   * occur here because there is no blend to attenuate).
   */
  scenarios.set('discard-reveals-whats-underneath', {
    name: 'discard-reveals-whats-underneath',
    summary: 'A higher-rank quad with a real alpha hole must let the lower-rank quad show through the hole, untouched.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let calibration = 'OK';
      try {
        await calibrate();
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      const under = buildDepthWriterMaterial({ THREE, r255: 60, g255: 60, b255: 60 });
      // The "hole" material: alpha 0 on the LEFT half of its own UV, alpha 1
      // on the right half — a hand-built step function standing in for a
      // real authored hole, so this scenario needs no image load at all.
      const { Fn, float, vec4, uv, step } = THREE.TSL;
      const holeMat = new THREE.NodeMaterial();
      holeMat.side = THREE.DoubleSide;
      holeMat.transparent = false;
      holeMat.depthTest = true;
      holeMat.depthWrite = true;
      holeMat.depthFunc = THREE.LessDepth; // see this module's header — LessDepth wins under this bench's own camera
      holeMat.fragmentNode = Fn(() => {
        const a = step(float(0.5), uv().x); // 0 for u<0.5 (the hole), 1 for u>=0.5 (solid)
        a.lessThan(float(0.5)).discard();
        return vec4(float(200 / 255), float(0), float(0), float(1));
      })();

      const { color } = await renderDepthPass([
        { rect: WORLD, z: 0.3, material: under },
        { rect: WORLD, z: 0.7, material: holeMat },
      ]);

      checks.push(
        evaluate('the-hole-shows-the-item-underneath-UNCHANGED', () => {
          const s = sampleColor(color, 150, 500); // left quarter — inside the hole (u≈0.15)
          return {
            ok: s.r === 60,
            measured: s.r,
            expected: 60,
            note: 'a discarded fragment never enters the depth test — the item below is untouched, not dimmed',
          };
        })
      );
      checks.push(
        evaluate('the-solid-half-shows-the-higher-rank-item', () => {
          const s = sampleColor(color, 850, 500); // right quarter — outside the hole (u≈0.85)
          return {
            ok: s.r === 200,
            measured: s.r,
            expected: 200,
            note: 'where the top item is genuinely opaque, its higher rank wins normally',
          };
        })
      );
      checks.push(
        evaluate('the-boundary-is-not-a-blended-average-of-both', () => {
          const hole = sampleColor(color, 150, 500).r;
          const solid = sampleColor(color, 850, 500).r;
          // Neither reading should sit anywhere between 60 and 200 — a
          // blended write (the OLD mechanism's own failure mode) would show
          // exactly that at a soft edge; a discard-based one cannot, by
          // construction, produce anything but one whole value or the other.
          return {
            ok: (hole === 60 || hole === 200) && (solid === 60 || solid === 200),
            measured: { hole, solid },
            expected: 'both exactly 60 or exactly 200, never an in-between value',
          };
        })
      );

      const artifacts = [];
      const canvas = document.createElement('canvas');
      paint(canvas, color, 'hole (left) reveals the item underneath; solid (right) wins normally');
      artifacts.push(await saveCanvasPng(ctx.runId, 'discard-hole.png', canvas));

      return { checks, calibration, artifacts: artifacts.filter(Boolean), inputs: { orientation }, stats: {} };
    },
  });

  /**
   * ============================================================================
   * SCENARIO 4 — THE REAL MAP, THROUGH THE NEW MECHANISM
   * ============================================================================
   * The same "town river bridge" real assets `bench-floor-lighting.js`'s own
   * stage-0 scenario proved the OLD mechanism's live bug against — three real
   * Level backgrounds, two real `_Overhead` foregrounds, real alpha, real
   * silhouettes — this time drawn through the depth-TEST mechanism instead of
   * the alpha-blended MRT write. Not re-deriving stage 0's own found test
   * points (a different bench, a different resolution, and this scenario
   * asks a DIFFERENT question — "is the picture structurally sane", not
   * "does the specific known bug reproduce") — the check here is coarser and
   * deliberately so: real per-floor variation must exist, at real alpha
   * boundaries, with no synthetic geometry anywhere.
   */
  let realAssets = null;
  async function ensureRealAssets() {
    if (realAssets) return realAssets;
    const scale = FIXTURE.exploreScale;
    const findArt = (floorId, role) => FIXTURE.artLayers.find((a) => a.floorId === floorId && a.role === role);
    const loadOne = async (file) => {
      const res = await loadMaskImageTexture({ url: `${FIXTURE.dir}/${file}`, THREE, scale, channels: 'rgb' });
      if (!res) throw new Error(`scene-depth: failed to load ${file}`);
      return res;
    };
    const layers = {};
    for (const floor of FIXTURE.floors) {
      const bg = findArt(floor.id, 'background');
      const fg = findArt(floor.id, 'overhead');
      if (bg) layers[`${floor.id}:levelBackground`] = await loadOne(bg.file);
      if (fg) layers[`${floor.id}:levelForeground`] = await loadOne(fg.file);
    }
    const sceneDoc = {
      name: 'shader-lab scene-depth real map',
      levels: FIXTURE.floors.map((floor) => {
        const bg = findArt(floor.id, 'background');
        const fg = findArt(floor.id, 'overhead');
        return {
          id: floor.id,
          index: floor.index,
          elevation: floor.elevation,
          background: bg ? { src: `${FIXTURE.dir}/${bg.file}` } : {},
          foreground: fg ? { src: `${FIXTURE.dir}/${fg.file}` } : {},
          visibility: { levels: [] },
        };
      }),
    };
    const { items } = collectLevelTextures(sceneDoc, {
      viewedLevelId: 'roof',
      visibleLevelIds: FIXTURE.floors.map((f) => f.id),
    });
    if (items.length !== 5) throw new Error(`scene-depth: expected 5 real items, got ${items.length}`);
    // Attach floorIndex the same way scene-attr.js's "owned" lookup does for
    // a levelId-carrying item — every one of these 5 real items has one, so
    // the general elevation-band fallback (needed for a loose, levelId-less
    // tile) is not exercised by this proving bench.
    for (const it of items) {
      it.floorIndex = FIXTURE.floors.find((f) => f.id === it.levelId)?.index ?? null;
    }
    const depth = createDepthAuthority();
    depth.rebuild(items); // THE REAL AUTHORITY — same module vt-pan-viewer.js now calls live.

    const rect = FIXTURE.worldRect;
    const realDimW = Math.ceil(layers['roof:levelBackground'].width / 64) * 64; // WebGPU 256-byte row alignment
    const realDimH = Math.max(1, Math.round(realDimW * ((rect.maxY - rect.minY) / (rect.maxX - rect.minX))));
    const realCamera = new THREE.OrthographicCamera(rect.minX, rect.maxX, rect.maxY, rect.minY, 0.01, 10);
    realCamera.position.set(0, 0, 5);
    realCamera.lookAt(0, 0, 0);
    realCamera.updateProjectionMatrix();
    const realDepthTex = new THREE.DepthTexture(realDimW, realDimH, THREE.FloatType);
    const realColorRt = new THREE.RenderTarget(realDimW, realDimH, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
      depthTexture: realDepthTex,
    });
    realAssets = { layers, items, depth, rect, realDimW, realDimH, realCamera, realColorRt, worldRect: rect };
    return realAssets;
  }

  scenarios.set('real-map-through-the-new-mechanism', {
    name: 'real-map-through-the-new-mechanism',
    summary:
      'The REAL tower-bridge map (3 backgrounds + 2 _Overhead layers), drawn through depthFunc:LessDepth ' +
      'instead of an alpha-blended MRT write. Must show real, varied floor structure — not synthetic, not uniform.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let ra;
      try {
        ra = await ensureRealAssets();
      } catch (err) {
        return {
          checks: [check({ id: 'real-assets-loaded', status: 'UNMEASURED', note: String(err?.message ?? err) })],
          calibration: 'FAILED',
          artifacts: [],
          inputs: {},
          stats: {},
        };
      }

      const scene = new THREE.Scene();
      const disposables = [];
      const maxRank = ra.depth.maxRank;
      // ⚠️ THE PAYLOAD CARRIES ELEVATION, NOT JUST FLOOR INDEX — an author's
      // own live observation (2026-08-04, first pass): a floor's plain
      // background and that SAME floor's own `_Overhead` layer share one
      // `floorIndex` (both belong to, say, Underground), so packing
      // floorIndex alone made a background and its roof render as the
      // IDENTICAL grey. A first fix packed ordinal `rank` instead — which
      // told them apart, but only by "which of the 5 items is this", so an
      // overhead layer authored a long way above its floor and one authored
      // 1ft above it would still just land on two adjacent rank slots.
      //
      // The author's own follow-up ask: *"give them a different shade based
      // on their elevation so that if they are a long way above the ground
      // they would be treated potentially differently to if they were 1ft
      // above the ground."* So the DOMINANT signal here is each item's own
      // real `key.elevation` (world units), normalised against the min/max
      // elevation actually present — a shade now reads as "how high up",
      // not "which item".
      //
      // A first pass reserved a small GLOBAL rank-based nudge to break exact
      // elevation ties (Underground Overhead's top, 20, equals Middle's own
      // background bottom, 20; Middle Overhead's top, 40, equals Roof's
      // background bottom, 40 — two real seams, not an edge case). That
      // nudge was ~8% of the full byte spread across the WHOLE item count,
      // which for a tied PAIR meant one rank step apart out of five — about
      // 6 grey levels out of 255, numerically distinct but not something an
      // eye can actually pick out. The fix: make the tie-break LOCAL to only
      // the siblings sharing one exact elevation (never more than two for
      // real Level art, which only ties at a floor-to-floor seam), and give
      // it real headroom (`SIBLING_TIE_HEADROOM`) instead of a sliver. Safe
      // because it's bounded against the SMALLEST real gap between two
      // distinct elevations this map actually has: with elevations at
      // 0/20/40 (a 50%-of-range step), a sibling pair can claim up to
      // `H/(1-H)` of that step before it would risk reading as HIGHER than
      // the band above it — `H=0.25` stays well under that (`0.25/0.75 ≈
      // 0.33` vs. the fixture's own 0.5 gap), so tie-broken siblings still
      // sort correctly relative to every OTHER elevation, not just visibly
      // apart from each other. This is a debug visualisation, not the
      // occlusion mechanism itself — the real depth-test result never reads
      // this byte; only human eyes do.
      const SIBLING_TIE_HEADROOM = 0.25;
      const elevations = ra.items.map((it) => it.key.elevation);
      const minElev = Math.min(...elevations);
      const maxElev = Math.max(...elevations);
      const elevSpan = maxElev - minElev;
      const elevationSiblings = new Map();
      for (const it of ra.items) {
        const list = elevationSiblings.get(it.key.elevation) ?? [];
        list.push(it);
        elevationSiblings.set(it.key.elevation, list);
      }
      for (const list of elevationSiblings.values()) {
        list.sort((a, b) => ra.depth.rankOf(a) - ra.depth.rankOf(b));
      }
      for (const item of ra.items) {
        const tex = ra.layers[`${item.levelId}:${item.kind}`]?.texture;
        const rank = ra.depth.rankOf(item);
        const elevFrac = elevSpan > 0 ? (item.key.elevation - minElev) / elevSpan : 0.5;
        const siblings = elevationSiblings.get(item.key.elevation);
        const siblingFrac = siblings.length > 1 ? siblings.indexOf(item) / (siblings.length - 1) : 0;
        const shadeByte = Math.round(
          (elevFrac * (1 - SIBLING_TIE_HEADROOM) + siblingFrac * SIBLING_TIE_HEADROOM) * 255
        );
        const mat = buildDepthWriterMaterial({
          THREE,
          tex,
          alphaThreshold: item.alphaThreshold ?? 0.75,
          r255: shadeByte,
          g255: item.floorIndex ?? 0,
          b255: 0,
        });
        const placement = {
          x: (ra.rect.minX + ra.rect.maxX) / 2,
          y: (ra.rect.minY + ra.rect.maxY) / 2,
          width: ra.rect.maxX - ra.rect.minX,
          height: ra.rect.maxY - ra.rect.minY,
          anchorX: 0.5,
          anchorY: 0.5,
          rotation: 0,
        };
        const corners = computeQuadCorners(placement);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(buildQuadPositions(corners), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
        geo.setIndex([...QUAD_INDICES]);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = (rank + 1) / (maxRank + 1);
        mesh.frustumCulled = false;
        scene.add(mesh);
        disposables.push(geo, mat);
      }
      const prevTarget = renderer.getRenderTarget();
      const prevClearDepth = renderer.getClearDepth();
      renderer.setRenderTarget(ra.realColorRt);
      renderer.setClearColor(0x000000, 0);
      renderer.setClearDepth(1); // LessDepth wins under this bench's own camera — see the module header
      renderer.clear(true, true, true);
      await renderer.renderAsync(scene, ra.realCamera);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearDepth(prevClearDepth);
      const colorBuf0 = await renderer.readRenderTargetPixelsAsync(ra.realColorRt, 0, 0, ra.realDimW, ra.realDimH);
      const colorBuf = ArrayBuffer.isView(colorBuf0) ? colorBuf0 : new Uint8Array(colorBuf0);
      for (const d of disposables) d.dispose?.();

      // TWO histograms, deliberately over DIFFERENT channels: `shadeHist` (R)
      // is the fine-grained signal — one bucket per real ITEM's elevation+
      // tiebreak shade, so a floor's background and that SAME floor's own
      // `_Overhead` layer land in DIFFERENT buckets even though they share a
      // floor. `floorHist` (G) is the coarser "which of the 3 floors" signal
      // `roof-floor-index-2` still needs. Neither is a re-derivation of the
      // other; they are the two real fields the material actually packed.
      const shadeHist = {};
      const floorHist = {};
      let drawnCount = 0;
      for (let i = 0; i < colorBuf.length; i += 4) {
        if (colorBuf[i + 3] > 0) {
          drawnCount++;
          shadeHist[colorBuf[i]] = (shadeHist[colorBuf[i]] || 0) + 1;
          floorHist[colorBuf[i + 1]] = (floorHist[colorBuf[i + 1]] || 0) + 1;
        }
      }
      const distinctShades = Object.keys(shadeHist).length;
      const distinctFloors = Object.keys(floorHist).length;
      // A COUNT of distinct byte values is not the claim being made — two
      // shades one bit apart are "distinct" by that measure and still
      // unreadable to an eye. `minShadeGap` is the smallest step between any
      // two neighbouring shades actually present, which is what "can I SEE
      // them apart" really asks.
      const sortedShadeKeys = Object.keys(shadeHist)
        .map(Number)
        .sort((a, b) => a - b);
      const minShadeGap =
        sortedShadeKeys.length > 1 ? Math.min(...sortedShadeKeys.slice(1).map((v, i) => v - sortedShadeKeys[i])) : 255;

      checks.push(
        evaluate('something-was-actually-drawn', () => {
          const frac = drawnCount / (ra.realDimW * ra.realDimH);
          return {
            ok: frac > 0.5,
            measured: frac.toFixed(3),
            expected: '> 0.5',
            note: 'a background-covered real map should read as drawn almost everywhere',
          };
        })
      );
      checks.push(
        evaluate('real-per-floor-variation-exists-not-a-single-uniform-value', () => {
          return {
            ok: distinctFloors >= 2,
            measured: distinctFloors,
            expected: '>= 2',
            note:
              'the OLD mechanism´s worst bug (round 15 of the light-elevation investigation) was the whole ' +
              'buffer reading as ONE floor everywhere — this is that detector, pointed at the NEW mechanism',
          };
        })
      );
      checks.push(
        evaluate('roof-floor-index-2-is-present-somewhere', () => {
          return {
            ok: (floorHist[2] || 0) > 0,
            measured: floorHist[2] || 0,
            expected: '> 0',
            note: 'the topmost real floor must win SOMEWHERE — the two Tower Bridge towers',
          };
        })
      );
      checks.push(
        evaluate('overhead-layers-render-as-a-DIFFERENT-shade-than-their-own-floor', () => {
          // THE AUTHOR'S OWN LIVE CATCH (2026-08-04): a floor's background and
          // that SAME floor's `_Overhead` layer used to pack the IDENTICAL
          // `floorIndex` byte and were visually indistinguishable, even
          // though they are genuinely different items at genuinely different
          // elevations. With 5 real items (3 backgrounds + 2 overheads) at
          // elevation-plus-tiebreak shades that never collide (proven above:
          // the fixture even forces two EXACT elevation ties — Underground
          // Overhead vs Middle background, both at 20; Middle Overhead vs
          // Roof background, both at 40 — and the tiebreak still keeps all
          // 5 apart), the visible picture must show 5 distinct shades, not
          // 3 — this is that fix's own regression guard. `minShadeGap >= 16`
          // is the SAME author catching the same bug a second time: an
          // earlier version of this fix DID reach 5 numerically-distinct
          // bytes, six apart, which is "distinct" on paper and invisible on
          // screen — this bound exists so a future edit can't quietly regress
          // back to a gap no eye can actually read.
          return {
            ok: distinctShades >= 5 && minShadeGap >= 16,
            measured: `${distinctShades} shades, min gap ${minShadeGap}/255`,
            expected: '>= 5 distinct shades, each >= 16/255 from its neighbour',
            note: 'a background and its own floor´s overhead layer must NEVER share one shade again',
          };
        })
      );

      const artifacts = [];
      const canvas = document.createElement('canvas');
      canvas.width = ra.realDimW;
      canvas.height = ra.realDimH;
      const ctx2d = canvas.getContext('2d');
      const img = ctx2d.createImageData(ra.realDimW, ra.realDimH);
      for (let i = 0; i < ra.realDimW * ra.realDimH; i++) {
        // THE SHADE BYTE (R), painted DIRECTLY as the grey level — dominated
        // by each item's own real elevation (normalised to the map's own
        // min/max), with a sibling-local headroom reserved to keep exact
        // elevation ties visibly apart (not just numerically). A background
        // and its own floor's `_Overhead` layer are now VISUALLY DIFFERENT
        // shades, AND an overhead layer authored a long way above its
        // floor's ground reads as visibly lighter than one authored just
        // above it — per the author's own ask: "give them a different shade
        // based on their elevation".
        const shadeGrey = colorBuf[i * 4];
        const drawn = colorBuf[i * 4 + 3] > 0;
        img.data[i * 4] = drawn ? shadeGrey : 0;
        img.data[i * 4 + 1] = drawn ? shadeGrey : 0;
        img.data[i * 4 + 2] = drawn ? shadeGrey : 255;
        img.data[i * 4 + 3] = 255;
      }
      ctx2d.putImageData(img, 0, 0);
      ctx2d.fillStyle = 'white';
      ctx2d.font = '14px monospace';
      ctx2d.fillText('real map via depthFunc:LessDepth (grey ∝ elevation, BLUE = undrawn)', 8, 20);
      artifacts.push(await saveCanvasPng(ctx.runId, 'real-map-depth-mechanism.png', canvas));

      return {
        checks,
        calibration: 'OK',
        artifacts: artifacts.filter(Boolean),
        inputs: { scale: FIXTURE.exploreScale, dim: { w: ra.realDimW, h: ra.realDimH } },
        stats: { shadeHistogram: shadeHist, floorHistogram: floorHist, maxRank, minShadeGap },
      };
    },
  });

  /**
   * SCENARIO 5 β€” THE LAST UNPROVEN PIECE (Β§11): a SEPARATE material samples
   * the depth texture through its own TSL fragment shader, not through a
   * CPU-side readback. Every earlier scenario proved the depth TEST works;
   * none of them proved a shader could QUERY the result afterwards, which is
   * exactly what a future point light's occlusion check needs to do.
   *
   * Three non-overlapping strips, real ranks via the REAL `createDepthAuthority`
   * (shuffled input, same discipline as scenario 2): `below` (lowest
   * elevation), `query` (the strip the query material is pointed at), `above`
   * (highest). Querying against `query`'s own known screen position must read
   * `isAbove=false` at `below` and at itself, `isAbove=true` at `above`, and
   * `isEqual=true` at itself alone.
   */
  scenarios.set('tsl-query-samples-the-real-depth-texture', {
    name: 'tsl-query-samples-the-real-depth-texture',
    summary:
      'A SECOND material samples the already-written depth texture via its own TSL screenUV read, compares ' +
      'against a known reference point, and must agree with the real rank ordering — no CPU readback involved ' +
      'in the comparison itself, only in checking the shader´s own verdict afterwards.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let calibration = 'OK';
      try {
        await calibrate();
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      const strips = [
        { id: 'below', x0: 0, x1: 333, elevation: 0 },
        { id: 'query', x0: 333, x1: 667, elevation: 20 },
        { id: 'above', x0: 667, x1: 1000, elevation: 40 },
      ];
      const items = strips.map((s) => ({
        id: s.id,
        key: { elevation: s.elevation, sortLayer: 0, sort: 0, zIndex: 0, tiebreak: 0 },
      }));
      const depth = createDepthAuthority();
      // Shuffled, same reason scenario 2 shuffles: the authority must do the
      // real sort, this bench must not lean on array order already agreeing.
      depth.rebuild([items[2], items[0], items[1]]);
      const maxRank = depth.maxRank;

      const drawItems = strips.map((s) => {
        const item = items.find((i) => i.id === s.id);
        const rank = depth.rankOf(item);
        const mat = buildDepthWriterMaterial({ THREE, r255: rank, g255: 0, b255: 0 });
        return {
          rect: { minX: s.x0, minY: 0, maxX: s.x1, maxY: 1000 },
          z: (rank + 1) / (maxRank + 1),
          material: mat,
          id: s.id,
          rank,
        };
      });
      await renderDepthPass(drawItems);

      const queryStrip = strips.find((s) => s.id === 'query');
      const queryU = (queryStrip.x0 + queryStrip.x1) / 2 / (WORLD.maxX - WORLD.minX);
      const queryMat = buildDepthQueryMaterial({ THREE, depthTexture: depthTex, queryU });
      const queryRt = new THREE.RenderTarget(DIM, DIM, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        colorSpace: THREE.NoColorSpace,
      });
      const queryMesh = buildQuadMesh(THREE, WORLD, queryMat, 0.5);
      const queryScene = new THREE.Scene();
      queryScene.add(queryMesh);
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(queryRt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      await renderer.renderAsync(queryScene, camera);
      renderer.setRenderTarget(prevTarget);
      const queryBuf0 = await renderer.readRenderTargetPixelsAsync(queryRt, 0, 0, DIM, DIM);
      const queryBuf = ArrayBuffer.isView(queryBuf0) ? queryBuf0 : new Uint8Array(queryBuf0);
      queryMesh.geometry.dispose();
      queryRt.dispose();

      const sampleAt = (id) => {
        const s = strips.find((st) => st.id === id);
        const midX = (s.x0 + s.x1) / 2;
        const i = pixelIndex(midX, 500) * 4;
        return { isAbove: queryBuf[i] > 127, isEqual: queryBuf[i + 1] > 127 };
      };

      for (const [id, expected] of [
        ['below', { isAbove: false, isEqual: false }],
        ['query', { isAbove: false, isEqual: true }],
        ['above', { isAbove: true, isEqual: false }],
      ]) {
        const got = sampleAt(id);
        checks.push(
          evaluate(`gpu-query-${id}-isAbove-matches-real-rank-order`, () => ({
            ok: got.isAbove === expected.isAbove,
            measured: got.isAbove,
            expected: expected.isAbove,
            note: `${id}´s real rank vs 'query'´s real rank, decided ENTIRELY by a TSL shader sampling the depth texture`,
          }))
        );
        checks.push(
          evaluate(`gpu-query-${id}-isEqual-matches-real-rank-order`, () => ({
            ok: got.isEqual === expected.isEqual,
            measured: got.isEqual,
            expected: expected.isEqual,
            note: 'only the strip AT the query´s own reference point may read as the same rank',
          }))
        );
      }

      const artifacts = [];
      const canvas = document.createElement('canvas');
      paint(canvas, queryBuf, 'GPU query result (R=isAbove, G=isEqual, B=raw stored depth)');
      artifacts.push(await saveCanvasPng(ctx.runId, 'tsl-query-result.png', canvas));

      return {
        checks,
        calibration,
        artifacts: artifacts.filter(Boolean),
        inputs: { orientation, strips, maxRank, queryU },
        stats: { ranks: drawItems.map((d) => ({ id: d.id, rank: d.rank })) },
      };
    },
  });

  /**
   * SCENARIO 7 — STAGE 1's LOAD-BEARING UNKNOWNS, RETIRED ON THE REAL DEVICE
   * (docs/planning/Stage-1-Shade-Once.md §4 names this scenario as the gate
   * before any live wiring).
   *
   * ⚠️ THE FIRST DESIGN DIED HERE, WHICH IS THIS BENCH DOING ITS JOB. The
   * original plan had a SECOND render target bind this pass's `depthTexture`
   * as its own depth attachment ("the share"). The vendored
   * `RenderTarget#set depthTexture` (three.webgpu.js:4911) has no
   * "already in use" guard, so source reading said "maybe" — and this
   * scenario's own first run said NO, definitively: the sharer's pass gets
   * NO usable depth (a LessEqualDepth probe drew nothing anywhere;
   * classified `cleared-to-0-or-no-attachment` by the diagnostic below), and
   * it fails SILENTLY — zero validation errors, just black. The author's own
   * independent research landed the same afternoon pointing at the same
   * limitation (threejs discourse #90036: the backend manages GPU resources
   * per RenderTarget; cross-target sharing does not resolve).
   *
   * WHAT THIS SCENARIO NOW PROVES — the design S1.4 actually ships
   * (the "single-target prepass", the recommended shape for this backend):
   * ONE target owns colour AND its own real depthTexture; pass 1 renders the
   * depth-writer scene into it (depth lands); pass 2 renders EQUAL/unblended
   * meshes at the SAME Z values with depth-clear disabled.
   *
   * ⚠️ ROUND TWO (2026-08-11) — THIS SCENARIO ITSELF HAD THE SAME GAP IT WAS
   * BUILT TO CLOSE. Its first version tested `colorWrite:false` against a
   * SINGLE-attachment target and got a clean pass — "the prepass writes no
   * colour". Production's real `scene.color` is a TWO-attachment MRT target
   * (colour + `buf:scene.attr`), and the author's own eyes on a real
   * translucent roof found black-tinted glass BEFORE this scenario ever
   * caught anything wrong. Rebuilt against the real two-attachment shape
   * (`mrtTarget`, `zeroAttrMrt` mirroring production's `sceneAttrZeroMrt`).
   *
   * ⚠️ ROUND FOUR (2026-08-11, SAME DAY) — ROUND TWO'S OWN "CONFIRMED LEAK"
   * WAS ITSELF A MEASUREMENT ARTIFACT, NOT A REAL FINDING. That round
   * compared a readback against the RAW HEX bytes of the clear colour
   * (0x112233 → expected [17,34,51]) and read [1,4,8] — logged as proof
   * `colorWrite:false` leaks the material's payload through. It does not.
   * `renderer.setClearColor(hex, alpha)` decodes hex as sRGB before it
   * reaches the buffer, REGARDLESS of this target's declared `NoColorSpace`
   * — [17,34,51] sRGB-decodes to EXACTLY [1,4,8]. A plain clear with ZERO
   * geometry ever rendered reproduces the identical bytes; a delta between
   * "before the prepass draws" and "after" (same buffer, same colour-space
   * transform on both sides) shows NO difference at all. `colorWrite:false`
   * masks attachment 0 correctly on this target, on this backend, as far as
   * this scenario can now tell. The greenhouse bug the author actually saw
   * is REAL and still needs a correct diagnosis — this was not it. Checks
   * now cover the FULL, corrected story:
   *   - `colorWrite-false-masks-attachment-0-on-a-real-mrt-target` — a
   *     before/after delta on the SAME buffer, immune to whatever
   *     colour-space transform is in play; must read identical;
   *   - EQUAL at the same numeric Z through the same camera is EXACT — zero
   *     epsilon — including an overlap resolved by the depth test;
   *   - a mesh at an unwritten Z contributes NOTHING (non-vacuity);
   *   - `renderer.autoClearDepth = false` around pass 2 is load-bearing;
   *   - a resize survives (setSize disposes GPU resources; the pair of
   *     passes must re-form cleanly at the new size);
   *   - THE PIN: cross-target sharing stays dead. A second target binding
   *     this target's depthTexture still draws nothing through it. If a
   *     future three upgrade makes this check FAIL, the cheaper two-target
   *     design has opened up and Stage 6 should hear about it.
   *
   * The colour-only reclear stays wired in `vt-pan-viewer.js` regardless —
   * cheap, unconditionally correct (a plain clear cannot leave stale data
   * behind, whatever the real bug turns out to be) — but its doc comment
   * there needs the same correction this one just got: it no longer has a
   * confirmed mechanism to point to, only a symptom still waiting on one.
   *
   * Production's claim is STRONGER than what this proves in one way, weaker
   * in none: production shares the actual geometry INSTANCE between the two
   * passes; this scenario rebuilds value-identical geometry through the same
   * `buildQuadMesh`. Value-identical inputs proving exact ⇒ instance-shared
   * inputs are exact a fortiori.
   */
  scenarios.set('single-target-prepass-equal', {
    name: 'single-target-prepass-equal',
    summary:
      'Stage 1 gate, single-target design: a colorWrite:false depth prepass into the SAME target, ' +
      'then EQUAL-at-the-same-Z colour draws — exact, zero epsilon, no validation errors. ' +
      'Plus the pin: cross-target depthTexture sharing stays dead on this backend.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let calibration = 'OK';
      try {
        await calibrate();
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      // Count real device validation errors across the WHOLE scenario. The
      // device is reachable on the backend; if a future three rearranges
      // that, the check degrades to UNMEASURED rather than silently passing.
      const device = renderer?.backend?.device ?? null;
      let uncapturedErrors = 0;
      const onError = (e) => {
        uncapturedErrors++;
        log?.(`SCENE-DEPTH shared-depth-equal: uncapturederror: ${e?.error?.message ?? e}`);
      };
      device?.addEventListener?.('uncapturederror', onError);

      const { float, vec4 } = THREE.TSL;
      /** Flat-colour material in the exact interior-draw state the plan
       * specifies: EQUAL, no depth write, no blend, no discard anywhere.
       *
       * ⚠️ `.colorNode`, NOT `.fragmentNode` (changed 2026-08-11, chasing the
       * SAME MRT saga as `zeroAttrMrt`'s own comment above). A `fragmentNode`
       * material never routes through the `colorNode`/MRT build path at all —
       * it always emits a single unnamed `@location(0)` output, no matter
       * what `mrt()` is bound, material- or renderer-level. That is invisible
       * on a target with only ONE real attachment (every earlier version of
       * this scenario), but `mrtTarget` genuinely has two, and WebGPU
       * requires a matching fragment output for EVERY attachment whose write
       * mask is nonzero — `colorWrite:false` (the prepass's own escape hatch)
       * apparently zeroes that requirement for BOTH attachments uniformly,
       * but pass 2 needs attachment 0's real output, so that escape hatch
       * isn't available here. `colorNode` populates `TSL.output` at build
       * time (`scene-attr.js`'s own "THE MRT MECHANISM" header), which is
       * exactly what lets the renderer-global `zeroAttrMrt` — now carrying
       * BOTH `output` and `attr` keys — supply a real member for attachment 0
       * (this material's own colour) AND attachment 1 (the safe zero),
       * without this helper needing its own per-material mrtNode at all.
       * This is not a lab-only workaround: it makes `equalMat` MORE faithful
       * to production, not less — the real interior/EQUAL draw material
       * (`buildWholeImageMaterial`) is colorNode-based too; `equalMat` was
       * simplified for depth-test isolation, never meant to also stand in
       * for `buildDepthWriterMaterial`'s fragmentNode shape. That shape stays
       * exactly as shipped in `prepassMat` below, unchanged — it is the real
       * production prepass function, not a lab helper, and this scenario's
       * whole point is to test what THAT actually does. */
      const equalMat = (r255, g255, b255) => {
        const m = new THREE.NodeMaterial();
        m.side = THREE.DoubleSide;
        m.transparent = false;
        m.depthTest = true;
        m.depthWrite = false;
        m.depthFunc = THREE.EqualDepth;
        m.colorNode = vec4(float(r255 / 255), float(g255 / 255), float(b255 / 255), float(1));
        return m;
      };

      // Geometry: L covers x∈[0,666], R covers x∈[333,1000] (both y∈[100,900],
      // leaving uncovered rows to prove EQUAL-against-cleared-depth draws
      // nothing). Overlap x∈[333,666] — R at the higher rank must own it.
      const maxRank = 3;
      const zL = (0 + 1) / (maxRank + 1); // rankToDepthZ(0, 3), inlined with its formula visible
      const zR = (2 + 1) / (maxRank + 1); // rankToDepthZ(2, 3)
      const zGhost = (1 + 1) / (maxRank + 1); // rank 1 — NOTHING writes this depth
      const rectL = { minX: 0, minY: 100, maxX: 666, maxY: 900 };
      const rectR = { minX: 333, minY: 100, maxX: 1000, maxY: 900 };

      /** The depth-writer material in PREPASS trim: same depth state, colour
       * writes masked — the exact production shape (the proxy scene rendered
       * into sceneColor before the world draw, leaving colour untouched). */
      const prepassMat = () => {
        const m = buildDepthWriterMaterial({ THREE, r255: 123, g255: 45, b255: 67 });
        m.colorWrite = false; // does NOT mask on a real MRT target — see this scenario's own header
        return m;
      };

      // ⚠️ A DEDICATED TWO-ATTACHMENT TARGET, NOT THE BENCH'S SHARED `colorRt`.
      // FOUND LIVE, 2026-08-11 (the author's own eyes on a real translucent
      // roof, not this harness): the FIRST version of this scenario used
      // `colorRt` — a SINGLE-attachment target — and `prepass-writes-no-colour`
      // passed clean. Production's real `scene.color` is a TWO-attachment MRT
      // target (colour + `buf:scene.attr`), and on THAT shape `colorWrite:false`
      // does NOT mask attachment 0 on this backend — confirmed here by
      // rebuilding the scenario against the real shape, after the live bug
      // pointed at the gap. A single-attachment lab proof is not equivalent to
      // a multi-attachment production target; this scenario now tests the one
      // that ships. `mrtNode` mirrors `sceneAttrZeroMrt` (`vt-pan-viewer.js`) —
      // the SAME "safe zero attr" binding held during production's own prepass.
      const { mrt, output: mrtOutput, vec4: vec4TSL } = THREE.TSL;
      const mrtTarget = new THREE.RenderTarget(DIM, DIM, {
        count: 2,
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: true,
      });
      mrtTarget.textures[0].name = 'output';
      mrtTarget.textures[1].name = 'attr';
      // ⚠️ BOTH keys, not just 'attr' — THIS WAS ITS OWN BUG, found chasing a
      // pipeline-validation error ("targets[1]…no corresponding fragment stage
      // output but writeMask is not zero") that showed up only once pass 2's
      // materials (colorWrite defaulting to true, unlike the prepass) rendered
      // under this binding. `scene-attr.js#buildSceneAttrZeroMrt` — the exact
      // production node this is supposed to mirror — is `mrt({ output, attr:
      // vec4(0,0,0,0) })`; a version with only 'attr' silently leaves the
      // OTHER attachment with no merged-MRT-side output at all. The prepass
      // (colorWrite:false) never surfaced this: a zero write mask needs no
      // matching shader output, so the gap was invisible there. Production
      // never had this bug — only this scenario's first draft, which copied
      // half the real node.
      const zeroAttrMrt = mrt({ output: mrtOutput, attr: vec4TSL(0, 0, 0, 0) });

      const runBothPasses = async () => {
        const dim = mrtTarget.width;
        const preScene = new THREE.Scene();
        const preMeshes = [
          buildQuadMesh(THREE, rectL, prepassMat(), zL),
          buildQuadMesh(THREE, rectR, prepassMat(), zR),
        ];
        for (const m of preMeshes) preScene.add(m);
        const prevTarget = renderer.getRenderTarget();
        const prevClearDepth = renderer.getClearDepth();
        const prevMRT = renderer.getMRT();
        renderer.setMRT(zeroAttrMrt); // bound across BOTH passes, exactly as production holds it
        renderer.setRenderTarget(mrtTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.setClearDepth(1);
        renderer.clear(true, true, true);
        await renderer.renderAsync(preScene, camera);
        // THE FIX UNDER TEST: a colour-only reclear between the prepass and the
        // world draw — depth is NOT touched (see vt-pan-viewer.js's own comment
        // at this exact call for the full account of why colorWrite alone
        // cannot be trusted here). Kept here so pass 2 experiences the EXACT
        // production call sequence; its own before/after bytes are proven by
        // the dedicated non-zero-clear probe below, NOT read back here — see
        // that probe's own header for why a (0,0,0,0)-cleared readback can
        // never show whether this line did anything at all.
        renderer.clear(true, false, false);
        // ⚠️ MRT STAYS BOUND THROUGH PASS 2 — TRIED UNBINDING IT HERE FIRST,
        // THAT WAS THE WRONG FIX. `mrtTarget` genuinely has two real
        // attachments regardless of whether any mrt() node is bound at all —
        // the render pass descriptor is built from the TARGET's own texture
        // list, not from `renderer.getMRT()`. So unbinding does not remove
        // the "every attachment with a nonzero write mask needs a matching
        // fragment output" requirement, it just removes the one mechanism
        // (`colorNode` + `mrt()`) that can SATISFY it for attachment 1. The
        // real fix was `equalMat` itself — see its own doc comment above for
        // why it is `.colorNode` now, not `.fragmentNode`, and why that makes
        // it MORE production-faithful, not a lab-only workaround.
        // Pass 2 — the "world" pass into the SAME target: NOTHING cleared;
        // autoClearDepth/autoClearColor both off so the pass loads what pass 1
        // left (production clears colour at frame start too — here pass 1's
        // clear IS the frame start).
        const scene = new THREE.Scene();
        const meshes = [
          buildQuadMesh(THREE, rectL, equalMat(255, 0, 0), zL),
          buildQuadMesh(THREE, rectR, equalMat(0, 255, 0), zR),
          // The negative control, IN the same draw: full-coverage mesh at a
          // depth nothing wrote. EQUAL must reject it at every pixel — this is
          // what makes the positive checks non-vacuous.
          buildQuadMesh(THREE, WORLD, equalMat(0, 0, 255), zGhost),
        ];
        for (const m of meshes) scene.add(m);
        const prevAutoClearDepth = renderer.autoClearDepth;
        const prevAutoClearColor = renderer.autoClearColor;
        renderer.autoClearDepth = false; // ← load-bearing; see this scenario's header
        renderer.autoClearColor = false;
        renderer.setRenderTarget(mrtTarget);
        await renderer.renderAsync(scene, camera);
        renderer.setRenderTarget(prevTarget);
        renderer.setMRT(prevMRT);
        renderer.setClearDepth(prevClearDepth);
        renderer.autoClearDepth = prevAutoClearDepth;
        renderer.autoClearColor = prevAutoClearColor;
        const buf0 = await renderer.readRenderTargetPixelsAsync(mrtTarget, 0, 0, dim, dim, 0, 0);
        for (const m of [...preMeshes, ...meshes]) m.geometry.dispose?.();
        return {
          buf: ArrayBuffer.isView(buf0) ? buf0 : new Uint8Array(buf0),
        };
      };

      // `sampleColor` is DIM-bound; sample the sharer at its own size directly.
      const sampleAt = (buf, dim, x, y) => {
        const fx = (x - WORLD.minX) / (WORLD.maxX - WORLD.minX);
        const fy = (y - WORLD.minY) / (WORLD.maxY - WORLD.minY);
        const px = Math.min(dim - 1, Math.max(0, Math.floor(fx * dim)));
        const rowFromBottom = Math.min(dim - 1, Math.max(0, Math.floor(fy * dim)));
        const row = orientation === 'flipped' ? dim - 1 - rowFromBottom : rowFromBottom;
        const i = (row * dim + px) * 4;
        return { r: buf[i], g: buf[i + 1], b: buf[i + 2], a: buf[i + 3] };
      };

      const { buf } = await runBothPasses();

      // ⚠️ THE ORIGINAL "LEAK" FINDING WAS A MEASUREMENT ARTIFACT, NOT A REAL
      // ONE — CORRECTED 2026-08-11, round four of this scenario's MRT saga,
      // and this is the one worth reading before touching this block again.
      //
      // Every earlier version of this probe compared the readback against
      // the RAW hex bytes of the clear colour (e.g. clearColor 0x112233 →
      // expected [17,34,51]) and read back [1,4,8] instead — logged as proof
      // `colorWrite:false` leaks the material's own payload through. It does
      // not. `renderer.setClearColor(hex, alpha)` decodes its hex argument
      // as sRGB before it ever reaches the buffer, REGARDLESS of this
      // target's own `colorSpace: NoColorSpace` — [17,34,51] sRGB-decodes to
      // EXACTLY [1,4,8] (confirmed by hand: standard sRGB→linear on each
      // channel, ((c+0.055)/1.055)^2.4, matches to the integer). A SECOND,
      // differently-coloured clear (0xc86432 → expected raw [200,100,50])
      // read back [147,32,8] — ALSO an exact sRGB decode of ITS OWN hex, not
      // of the previous clear or of anything a material wrote. Most
      // decisively: a PLAIN clear with ZERO geometry ever rendered produces
      // the identical [1,4,8,255] this "leak" was measured at — there is
      // nothing left for `colorWrite:false` to have failed to mask.
      //
      // The correct test compares BEFORE vs AFTER the prepass draws, on the
      // SAME buffer, through the SAME (whatever it is) colour-space
      // transform — a delta, not a comparison against a hand-computed
      // expectation. If they match, colorWrite:false masked correctly.
      //
      // This does NOT (yet) explain the greenhouse bug the author actually
      // saw — that diagnosis needs to be redone; see Stage-1-Shade-Once.md
      // and V4-Testament.md's own notes on this round for the honest
      // "still open" status. The colour-only reclear stays wired in
      // vt-pan-viewer.js regardless — it is cheap, unconditionally correct
      // (a plain clear cannot leave stale data behind, whatever the actual
      // bug turns out to be), and this round never found a reason to distrust
      // it, only a reason to distrust WHY it was first believed necessary.
      let noDrawBaseline = null;
      let afterDrawSameBuffer = null;
      {
        const probeTarget = new THREE.RenderTarget(DIM, DIM, {
          count: 2,
          type: THREE.UnsignedByteType,
          format: THREE.RGBAFormat,
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          colorSpace: THREE.NoColorSpace,
          depthBuffer: true,
        });
        probeTarget.textures[0].name = 'output';
        probeTarget.textures[1].name = 'attr';
        const probeScene = new THREE.Scene();
        probeScene.add(buildQuadMesh(THREE, rectL, prepassMat(), zL));
        probeScene.add(buildQuadMesh(THREE, rectR, prepassMat(), zR));
        const pPrevTarget = renderer.getRenderTarget();
        const pPrevMRT = renderer.getMRT();
        renderer.setMRT(zeroAttrMrt);
        renderer.setRenderTarget(probeTarget);
        renderer.setClearColor(0x112233, 1); // any non-zero, distinguishable colour
        renderer.setClearDepth(1);
        renderer.clear(true, true, true);
        const baseline0 = await renderer.readRenderTargetPixelsAsync(probeTarget, 0, 0, DIM, DIM, 0, 0);
        noDrawBaseline = sampleAt(ArrayBuffer.isView(baseline0) ? baseline0 : new Uint8Array(baseline0), DIM, 166, 500);
        await renderer.renderAsync(probeScene, camera); // colorWrite:false — should change NOTHING
        const afterDraw0 = await renderer.readRenderTargetPixelsAsync(probeTarget, 0, 0, DIM, DIM, 0, 0);
        afterDrawSameBuffer = sampleAt(
          ArrayBuffer.isView(afterDraw0) ? afterDraw0 : new Uint8Array(afterDraw0),
          DIM,
          166,
          500
        );
        renderer.setRenderTarget(pPrevTarget);
        renderer.setMRT(pPrevMRT);
        renderer.setClearColor(0x000000, 0); // restore runBothPasses' own convention for any caller after this
        probeTarget.dispose();
      }

      checks.push(
        evaluate('colorWrite-false-masks-attachment-0-on-a-real-mrt-target', () => {
          const a = noDrawBaseline;
          const b = afterDrawSameBuffer;
          const matches = a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
          return {
            ok: matches,
            measured: `no-draw=${a.r},${a.g},${a.b},${a.a} vs after-colorWrite-false-draw=${b.r},${b.g},${b.b},${b.a}`,
            expected: 'identical — a colorWrite:false draw must be indistinguishable from no draw at all',
            note: 'CORRECTED 2026-08-11 — this used to assert the OPPOSITE, on a comparison against the wrong (non-sRGB-decoded) expected value; see this block´s own header',
          };
        })
      );

      checks.push(
        evaluate('EQUAL-exact-left-exclusive-region-is-rank0', () => {
          const s = sampleAt(buf, DIM, 166, 500);
          return {
            ok: s.r === 255 && s.g === 0 && s.b === 0,
            measured: `${s.r},${s.g},${s.b}`,
            expected: '255,0,0',
            note: 'L´s EQUAL passes with ZERO epsilon where the depth pass stored L´s own Z',
          };
        })
      );
      checks.push(
        evaluate('EQUAL-exact-overlap-region-is-rank2-not-rank0', () => {
          const s = sampleAt(buf, DIM, 500, 500);
          return {
            ok: s.g === 255 && s.r === 0,
            measured: `${s.r},${s.g},${s.b}`,
            expected: '0,255,0',
            note: 'where the depth test resolved the overlap to R, L´s EQUAL must FAIL and R´s must pass',
          };
        })
      );
      checks.push(
        evaluate('EQUAL-exact-right-exclusive-region-is-rank2', () => {
          const s = sampleAt(buf, DIM, 833, 500);
          return { ok: s.g === 255 && s.r === 0, measured: `${s.r},${s.g},${s.b}`, expected: '0,255,0', note: '' };
        })
      );
      checks.push(
        evaluate('wrong-Z-mesh-contributes-NOTHING-anywhere', () => {
          let blue = 0;
          for (let i = 2; i < buf.length; i += 4) if (buf[i] !== 0) blue++;
          return {
            ok: blue === 0,
            measured: `${blue} blue-tinted pixels`,
            expected: '0',
            note: 'the ghost mesh at an unwritten depth is rejected EVERYWHERE — the positive checks are not vacuous',
          };
        })
      );
      checks.push(
        evaluate('uncovered-rows-stay-clear', () => {
          const s = sampleAt(buf, DIM, 500, 40);
          return {
            ok: s.r === 0 && s.g === 0 && s.b === 0 && s.a === 0,
            measured: `${s.r},${s.g},${s.b},${s.a}`,
            expected: '0,0,0,0',
            note: 'cleared depth (far plane) EQUALs nothing — no mesh covers these rows anyway',
          };
        })
      );

      // Resize the target (production: a window resize), re-run both passes
      // at the new size, and demand the same answers — setSize() disposes GPU
      // resources (RenderTarget#setSize calls dispose), so the prepass+EQUAL
      // pair must re-form cleanly from nothing.
      const DIM2 = 192;
      mrtTarget.setSize(DIM2, DIM2);
      const { buf: buf2 } = await runBothPasses();
      checks.push(
        evaluate('survives-a-resize', () => {
          const a = sampleAt(buf2, DIM2, 166, 500);
          const b = sampleAt(buf2, DIM2, 500, 500);
          return {
            ok: a.r === 255 && a.g === 0 && b.g === 255 && b.r === 0,
            measured: `left=${a.r},${a.g} overlap=${b.r},${b.g}`,
            expected: 'left=255,0 overlap=0,255',
            note: 'the single-target prepass+EQUAL pair re-forms cleanly after every GPU resource was disposed',
          };
        })
      );
      // Restore this scenario's own target size, and refill the depth
      // attachment at the restored size for the pin below.
      mrtTarget.setSize(DIM, DIM);
      await runBothPasses();

      // THE PIN — cross-target sharing stays dead. A second target binding
      // THIS target's depthTexture must see none of its values (this
      // scenario's own first run proved the share silently resolves to
      // nothing on this backend; the author's independent research agreed —
      // threejs discourse #90036). A permissive LessEqualDepth probe through
      // the "shared" attachment must draw NOTHING. If a future three makes
      // this FAIL, the cheaper two-target design has opened up — re-plan
      // Stage 6's keel resource model with it.
      {
        const sharer = new THREE.RenderTarget(DIM, DIM, {
          type: THREE.UnsignedByteType,
          format: THREE.RGBAFormat,
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          colorSpace: THREE.NoColorSpace,
          depthBuffer: true,
        });
        sharer.depthTexture = mrtTarget.depthTexture;
        const probeScene = new THREE.Scene();
        const probeMat = equalMat(255, 255, 0);
        probeMat.depthFunc = THREE.LessEqualDepth;
        const probeMesh = buildQuadMesh(THREE, WORLD, probeMat, zL);
        probeScene.add(probeMesh);
        const prevTarget = renderer.getRenderTarget();
        const prevAutoClearDepth = renderer.autoClearDepth;
        renderer.autoClearDepth = false;
        renderer.setRenderTarget(sharer);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        await renderer.renderAsync(probeScene, camera);
        renderer.setRenderTarget(prevTarget);
        renderer.autoClearDepth = prevAutoClearDepth;
        const pinBuf0 = await renderer.readRenderTargetPixelsAsync(sharer, 0, 0, DIM, DIM);
        const pinBuf = ArrayBuffer.isView(pinBuf0) ? pinBuf0 : new Uint8Array(pinBuf0);
        probeMesh.geometry.dispose?.();
        sharer.dispose();
        checks.push(
          evaluate('cross-target-share-stays-dead-pin', () => {
            let drawn = 0;
            for (let i = 0; i < pinBuf.length; i += 4) if (pinBuf[i] !== 0) drawn++;
            return {
              ok: drawn === 0,
              measured: `${drawn} pixels drawn through the share`,
              expected: '0 (the share resolves to nothing on this backend)',
              note: 'a FAILURE here means a three upgrade made cross-target depth sharing work — good news, re-plan on it',
            };
          })
        );
      }

      device?.removeEventListener?.('uncapturederror', onError);
      checks.push(
        device
          ? evaluate('no-webgpu-validation-errors', () => ({
              ok: uncapturedErrors === 0,
              measured: `${uncapturedErrors} uncapturederror events`,
              expected: '0',
              note: 'the share, the EQUAL pipeline, the resize and the dispose all validated clean on the real device',
            }))
          : check({
              id: 'no-webgpu-validation-errors',
              status: 'UNMEASURED',
              note: 'renderer.backend.device not reachable — cannot listen for uncapturederror',
            })
      );

      const artifacts = [];
      const canvas = document.createElement('canvas');
      paint(canvas, buf, 'single-target prepass+EQUAL (red=rank0, green=rank2)');
      artifacts.push(await saveCanvasPng(ctx.runId, 'single-target-prepass-equal.png', canvas));

      // This scenario's OWN target, built fresh every run — unlike `colorRt`
      // (owned by `ensureRenderer()`, persists for the bench's lifetime), this
      // one must dispose itself or a repeated run leaks VRAM for the session.
      mrtTarget.dispose();

      return {
        checks,
        calibration,
        artifacts: artifacts.filter(Boolean),
        inputs: { orientation, zL, zR, zGhost, DIM, DIM2 },
        stats: { uncapturedErrors },
      };
    },
  });

  const bench = {
    name: 'scene-depth',
    title: 'The depth authority´s GPU half — order-independent occlusion',
    rung: 4,
    summary:
      'Proves the REAL depth-test mechanism (depthFunc:LessDepth, rank-as-Z, alpha-test discard) that ' +
      'vt/scene-depth.js is about to be built on: order-independence, a lossless rank round-trip through the ' +
      'REAL createDepthAuthority, discard-based holes that never blend, and a SEPARATE material querying the ' +
      'depth texture through its own TSL shader. All four are things vt/scene-attr.js´s alpha-blended write ' +
      'structurally could not guarantee.',
    scenarios,
    checkIds: [
      'higher-rank-wins-when-drawn-second',
      'THE-PROOF-higher-rank-STILL-wins-when-drawn-FIRST',
      'the-two-renders-are-pixel-identical',
      'rank-0-reads-back-at-its-own-strip',
      'rank-1-reads-back-at-its-own-strip',
      'rank-2-reads-back-at-its-own-strip',
      'rank-3-reads-back-at-its-own-strip',
      'rank-4-reads-back-at-its-own-strip',
      'the-hole-shows-the-item-underneath-UNCHANGED',
      'the-solid-half-shows-the-higher-rank-item',
      'the-boundary-is-not-a-blended-average-of-both',
      'something-was-actually-drawn',
      'real-per-floor-variation-exists-not-a-single-uniform-value',
      'roof-floor-index-2-is-present-somewhere',
      'overhead-layers-render-as-a-DIFFERENT-shade-than-their-own-floor',
      'gpu-query-below-isAbove-matches-real-rank-order',
      'gpu-query-below-isEqual-matches-real-rank-order',
      'gpu-query-query-isAbove-matches-real-rank-order',
      'gpu-query-query-isEqual-matches-real-rank-order',
      'gpu-query-above-isAbove-matches-real-rank-order',
      'gpu-query-above-isEqual-matches-real-rank-order',
      'colorWrite-false-masks-attachment-0-on-a-real-mrt-target',
      'EQUAL-exact-left-exclusive-region-is-rank0',
      'EQUAL-exact-overlap-region-is-rank2-not-rank0',
      'EQUAL-exact-right-exclusive-region-is-rank2',
      'wrong-Z-mesh-contributes-NOTHING-anywhere',
      'uncovered-rows-stay-clear',
      'survives-a-resize',
      'cross-target-share-stays-dead-pin',
      'no-webgpu-validation-errors',
    ],
    ready: () => true,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },
  };

  registerBench(bench);
  return bench;
}
