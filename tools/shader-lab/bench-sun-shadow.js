/**
 * SHADER LAB — THE SUN-SHADOW BENCH (rung 3), the handoff `bench-derive.js`
 * built for.
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS
 * ============================================================================
 * Every prior sun-shadow measurement in this lab (`lab.js`/`smear-prototype.js`,
 * pre-contract) rasterized its OWN synthetic caster packing. That closed the
 * plateau/staircase/sampling-floor bugs of the retired march/old-smear models,
 * but it could never see anything that only exists in REAL, messy silhouette
 * geometry — and the author's live report after the (then-default) smear model
 * shipped was exactly that: *"a confusing mix of shadows, one of which has a
 * halo"* on the REAL Tower Bridge-shaped scene, not reproduced by any prior
 * synthetic scenario.
 *
 * This bench closes that gap the way `bench-derive.js` closed derivation's: it
 * takes a REAL layer field — `buildLayerField()`, packed by the REAL
 * `packLayerTexelData` over the REAL three-floor Tower Bridge item set — and
 * renders it through the REAL `buildLayerSmearBakeMaterial`, unmodified, at
 * real tier settings. Whatever the author saw, this is the first place that
 * can actually be asked to reproduce it.
 *
 * ============================================================================
 * WHAT "HOLE"/"HALO" MEANS HERE, MEASURED NOT EYEBALLED
 * ============================================================================
 * `feedback_instruments_must_not_lie` + the lab's own `findHoles` history: a
 * 1-D scanline can pass straight between two specks and report "smooth". This
 * bench scans the WHOLE frame for a LOCAL MAXIMUM — a pixel markedly brighter
 * than BOTH sides of some opposing pair, while its neighbourhood is genuinely
 * in shadow. A steep monotonic penumbra edge is not flagged (it is one-sided);
 * a genuine lit speck or ring INSIDE a shadow mass is.
 *
 * @module tools/shader-lab/bench-sun-shadow
 */
import { marchDirectionToSun } from '../../src/effects/lighting/sun-occlusion.js';
import { buildLayerSmearBakeMaterial } from '../../src/effects/lighting/layer-smear-render.js';
import { resolveLayerSmear, layerSmearTierPlan } from '../../src/effects/lighting/layer-smear.js';
import { packLayerTexelData } from '../../src/effects/lighting/sun-shadow-subsystem.js';
import { createDeriveBench } from './bench-derive.js';
import FIXTURE from './fixtures/tower-bridge.js';
import { check, evaluate, registerBench, saveCanvasPng } from './contract.js';

export function createSunShadowBench({ THREE, log }) {
  const deriveBench = createDeriveBench({ THREE, log });

  let renderer = null;
  let rt = null;
  let rtDim = 0;
  /** Empirically calibrated, never assumed (`feedback_y_flip_recurring_risk`) —
   * `null` until `ensureRenderer` runs its own `selfTest`. */
  let yFlip = null;
  /** Last GPU-rendered frame, for interactive probing — see its own assignment. */
  let lastRender = null;

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    log?.(`SUN-SHADOW: renderer backend ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
  }

  function stub() {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.needsUpdate = true;
    return t;
  }

  async function renderTo(bake, quad, dim) {
    if (!rt || rtDim !== dim) {
      rt?.dispose();
      rt = new THREE.RenderTarget(dim, dim, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
      rtDim = dim;
    }
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    quad.render(renderer);
    renderer.setRenderTarget(prev);
    const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, dim, dim);
    return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
  }

  /** Calibrate row order ONCE, empirically, the same technique the
   * pre-contract lab used — a known asymmetric marker, checked against which
   * readback row comes back bright. Never assumed twice in one process.
   *
   * ⚠️ DRIVES THE LAYER-SMEAR MATERIAL ITSELF (2026-08-02, replacing a
   * dedicated march-only calibration path retired with the march model) — the
   * caller must have already called `ensureLayerSmear` for whatever `dim` it
   * is about to render at, exactly as the retired version required
   * `ensureMaterials` first. The synthetic field puts coverage on the
   * OVERHEAD layer (G), not the wall layer (R): a wall texel's own gate would
   * suppress its d≈0 self-read (`here.r` feeds the receiver gate as well as
   * layer 0's coverage), where overhead has no such self-cancellation — this
   * is the layer-smear analogue of the retired march's dedicated
   * R/sky-reach d=0 seed. */
  async function selfTest(dim) {
    if (yFlip !== null) return yFlip;
    const w = 8;
    const data = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // G = overhead coverage: covered in the top half of the SOURCE, open
        // in the bottom half. At elevationDeg 90 the sun throws nothing
        // (every station collapses to ~d=0), so a covered texel self-darkens
        // directly off its own station-0 read.
        data[i + 1] = y < w / 2 ? 255 : 0;
      }
    const field = { data, w, h: w, rect: { minX: 0, minY: 0, maxX: 100, maxY: 100 } };
    layerSmear.layerTexNode.value = uploadLayers(field);
    layerSmear.setRect(field.rect);
    layerSmear.setField({ layerGridDimPx: field.w });
    layerSmear.setSun(resolveLayerSmear({ azimuthDeg: 0, elevationDeg: 90, heightsPx: [0, 300, 0, 0] }));
    layerSmear.setLayers({ strengths: [1, 1, 1, 1] });
    layerSmear.setDepth({ radiiPx: [0, 0, 0, 0] });
    layerSmear.setLook({ strength01: 1, softnessMul: 1, basePx: 2, falloffExp: 1.6, tipBlurMul: 3 });
    layerSmear.setEdgeBandPx(0);
    const bytes = await renderTo(layerSmear, layerSmearQuad, dim);
    const at = (x, y, flip) => bytes[((flip ? dim - 1 - y : y) * dim + x) * 4];
    const straightTop = at(dim >> 1, 4, false);
    yFlip = straightTop > 128; // covered (dark, low value) expected near y=0 without a flip
    log?.(`SUN-SHADOW: selfTest orientation ${yFlip ? 'FLIPPED' : 'OK'} (top-row sample=${straightTop})`);
    return yFlip;
  }

  /** THE HOLE/HALO DETECTOR — see this module's own header. Returns
   * `{count, samples}`; `samples` carries WORLD coordinates, not just pixels,
   * so a follow-up probe starts from a real place, not "somewhere in that
   * picture" (`AGENTS.md` §4's own point). */
  function findHoles(bytes, dim, rect, { minShadow = 0.3, brightDelta = 0.15, radius = 4 } = {}) {
    const flip = yFlip === true;
    const at = (x, y) => bytes[((flip ? dim - 1 - y : y) * dim + x) * 4] / 255;
    const holes = [];
    for (let y = radius; y < dim - radius; y += 1) {
      for (let x = radius; x < dim - radius; x += 1) {
        const v = at(x, y);
        if (v > 1 - minShadow) continue;
        const pairs = [
          [at(x - radius, y), at(x + radius, y)],
          [at(x, y - radius), at(x, y + radius)],
          [at(x - radius, y - radius), at(x + radius, y + radius)],
          [at(x - radius, y + radius), at(x + radius, y - radius)],
        ];
        let best = 0;
        for (const [a, b] of pairs) best = Math.max(best, Math.min(v - a, v - b));
        if (best > brightDelta) {
          holes.push({
            x,
            y,
            vis: Number(v.toFixed(3)),
            rise: Number(best.toFixed(3)),
            wx: Math.round(rect.minX + (x / (dim - 1)) * (rect.maxX - rect.minX)),
            wy: Math.round(rect.minY + (y / (dim - 1)) * (rect.maxY - rect.minY)),
          });
        }
      }
    }
    return { count: holes.length, samples: holes.sort((a, b) => b.rise - a.rise).slice(0, 15) };
  }

  function paintTo(canvasId, bytes, dim) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d');
    const flip = yFlip === true;
    const out = new Uint8ClampedArray(dim * dim * 4);
    for (let y = 0; y < dim; y++) {
      const srcY = flip ? dim - 1 - y : y;
      out.set(bytes.subarray(srcY * dim * 4, (srcY + 1) * dim * 4), y * dim * 4);
    }
    ctx.putImageData(new ImageData(out, dim, dim), 0, 0);
  }

  /** Debug/probe entry point — render an ARBITRARY (possibly hand-modified)
   * layer field through the layer-smear material at a given tier + sun,
   * without going through a registered scenario. Exists for exactly one kind
   * of question: "if I change ONLY this one thing about the source data,
   * does the artifact change?" — an A/B test that stays honest only if it
   * drives the SAME real material the shipped code uses, not a
   * reimplementation.
   * @param {object} field - same shape `buildLayerField` returns.
   * @param {object} [sun] @param {number} [tier=3]
   * @returns {Promise<{bytes:Uint8Array, dim:number, rect:object}>}
   */
  async function renderField(field, sun = {}, tier = 3) {
    await ensureRenderer();
    const plan = layerSmearTierPlan(tier);
    ensureLayerSmear(plan.steps);
    await selfTest(plan.fieldDim);
    const s = { azimuthDeg: 220, elevationDeg: 30, heightsPx: [300, 220, 400, 0], ...sun };
    const resolved = resolveLayerSmear({
      azimuthDeg: s.azimuthDeg,
      elevationDeg: s.elevationDeg,
      heightsPx: s.heightsPx,
    });
    layerSmear.layerTexNode.value = uploadLayers(field);
    layerSmear.setRect(field.rect);
    layerSmear.setField({ layerGridDimPx: field.w });
    layerSmear.setSun(resolved);
    layerSmear.setLayers({ strengths: s.strengths ?? [1, 0.85, 0.88, 0.88] });
    layerSmear.setDepth({ radiiPx: s.depthRadiusPx ?? [0, 0, 0, 0] });
    layerSmear.setLook({ strength01: 1, softnessMul: 1, basePx: 2, falloffExp: 1.6, tipBlurMul: 3 });
    layerSmear.setEdgeBandPx(0);
    const bytes = await renderTo(layerSmear, layerSmearQuad, plan.fieldDim);
    lastRender = { bytes, dim: plan.fieldDim, rect: field.rect, yFlip };
    return { bytes, dim: plan.fieldDim, rect: field.rect };
  }

  // ══════════════════════════════════════════════════════════════════════
  // THE LAYER SMEAR MODEL — docs/planning/Sun-Shadows-Layer-Smear.md
  // ══════════════════════════════════════════════════════════════════════

  let layerSmear = null;
  let layerSmearQuad = null;
  let builtLayerSteps = 0;

  function ensureLayerSmear(steps) {
    if (layerSmear && builtLayerSteps === steps) return;
    layerSmear?.material?.dispose?.();
    layerSmear = buildLayerSmearBakeMaterial({ THREE, layerTexture: stub(), steps });
    layerSmearQuad = new THREE.QuadMesh(layerSmear.material);
    builtLayerSteps = steps;
  }

  /**
   * Pack the REAL derived products of floor `k` into the four-channel layer
   * texture the model reads, via the SAME `packLayerTexelData` production
   * uses (`sun-shadow-subsystem.js#bakeLayerTexture`'s own call site) —
   * nothing here is a hand-rolled transcription, which is the whole reason
   * this bench exists.
   *
   * ⚠️ `casterGridDim`, NOT `gridMaxDim` (2026-08-02, corrected same day as
   * first found — see `mask-derive.js`'s own doc on `casterChannels.outdoors`/
   * `.coverAbove` for the full story). The first version of this fix passed
   * `gridMaxDim`, which raises `derive()`'s SHARED `gridSpec` globally — every
   * consumer, not just the caster channels — which happened to make Shader
   * Lab's own picture crisp while leaving PRODUCTION's real `outdoors`/
   * `coverAbove` still pinned to the shared, low-res grid (only
   * `casterChannels.overhead` scaled with the tier there). The two benches
   * were measuring two DIFFERENT pictures without either side knowing it —
   * exactly what the author caught comparing a real scene against this same
   * bench's own render of the identical floor. `casterGridDim` requests the
   * SAME narrower, caster-only resolution bump `boot.js`'s real
   * `casterSpec.gridMaxDim` does, and this now reads the resulting
   * `casterChannels.outdoors`/`.coverAbove` twins — not the shared-resolution
   * `p.outdoors`/`p.coverAbove` — so this bench and production request, and
   * read, the identical thing.
   */
  async function buildLayerField(floorIndex, dim, casterGridDim, overheadHostType = 'tile') {
    const { products } = await deriveBench.derive({
      ...(casterGridDim > 0 ? { casterGridDim } : {}),
      // ⚠️ `tile`, NOT `bench-derive.js`'s own `levelForeground` DEFAULT
      // (2026-08-02 — found the moment the new layer-isolation view was first
      // pointed at the OVERHEAD layer, which came back a flat 1.000 "no shadow
      // anywhere" on ALL THREE floors).
      //
      // `deriveFloorProducts`'s overhead band requires `owner === null` — a
      // level's OWN art is never an overhead protrusion, it is either the
      // floor itself or (for a lower floor) sky-reach. So hosting the
      // `_Overhead` art as a `levelForeground` leaves `coverOverhead`
      // PERMANENTLY EMPTY, and the bench could never show an overhead shadow
      // at all. The fixture's own `OVERHEAD_HOST_TYPES` doc already warned
      // that "modelling only the first left the OVERHEAD caster band
      // permanently empty" — the warning was there, the bench just never took
      // the other branch.
      //
      // The author's REAL scene hosts it as a tile (their own sun-shadows
      // report: `tile:dt8vGcvc2BbGD4vo`, `"band": "overhead"`), so `tile` is
      // both the production-matching choice and the only one where the layer
      // the author asked to inspect actually exists. Overridable, because the
      // author uses BOTH shapes across their maps ("I use tiles or the
      // foreground image for that scene's level").
      overheadHostType,
    });
    const p = products.find((x) => x.index === floorIndex);
    if (!p) throw new Error(`no derived products for floor index ${floorIndex}`);
    // The OUTPUT spec is `coverOverhead`'s own — matching `bakeLayerTexture`'s
    // real call site — NOT `outdoors`'s. `outdoors`/`coverAbove` are
    // world-sampled by `packLayerTexelData` itself precisely because they can
    // legitimately sit at a DIFFERENT resolution than this one.
    const spec = p.casterChannels.coverOverhead.spec;
    const { data } = packLayerTexelData({
      channels: p.casterChannels,
      outdoorsGrid: p.casterChannels.outdoors,
      coverAboveGrid: p.casterChannels.coverAbove ?? null,
      spec,
    });
    return {
      data,
      w: spec.w,
      h: spec.h,
      rect: { minX: spec.x, minY: spec.y, maxX: spec.x + spec.width, maxY: spec.y + spec.height },
      dim,
    };
  }

  function uploadLayers(field) {
    const tex = new THREE.DataTexture(field.data, field.w, field.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    // ⚠️ CLAMP, NEVER WRAP — this IS the author's edge rule ("if the black pixels
    // of _Outdoors extend across the edge of the map then we assume that this
    // continues into the distance"), enforced by the sampler for free.
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * ⚖️ THE LAW, measured on real geometry: sweep outward from every real wall
   * edge along the direction a shadow is thrown, and find the worst place the
   * profile gets DARKER instead of lighter. Author: *"There should never be a
   * case where a shadow has that curve when dealing with one light source and
   * opaque occluders."*
   *
   * Returns world coordinates for the worst offender, because "somewhere in that
   * picture" is not a place anyone can go and probe.
   *
   * ⚠️ THE SWEEP MUST STOP AT `maxThrowPx`, NOT AT SOME FRACTION OF THE MAP
   * (bug in THIS bench, caught 2026-08-02 by looking at the actual profile
   * before trusting a 0.98 "violation"). A busy real floor has many separate
   * buildings; a span longer than any single shadow's own legitimate throw
   * WILL cross into a different building's own — separate, unrelated — shadow,
   * and the ordinary "lit gap between two buildings, then a second dark
   * region" that produces is not a violation of anything. THE LAW is a claim
   * about ONE occluder's own curve. Bounding the walk to `maxThrowPx` (with a
   * small margin past the tip, to also catch a hard cutoff there) is what
   * keeps this check honest about what it is actually testing.
   */
  function measureTheLaw(bytes, dim, field, azimuthDeg, maxThrowPx, { maxAnchors = 400, tolerance = 0.02 } = {}) {
    const flip = yFlip === true;
    const { rect, w: W, h: H } = field;
    const toSun = marchDirectionToSun(azimuthDeg);
    const sd = { x: -toSun.x, y: -toSun.y };
    const wallAt = (tx, ty) => field.data[(ty * W + tx) * 4] / 255;
    const visAtWorld = (wx, wy) => {
      const px = Math.round(((wx - rect.minX) / (rect.maxX - rect.minX)) * (dim - 1));
      const py = Math.round(((wy - rect.minY) / (rect.maxY - rect.minY)) * (dim - 1));
      if (px < 0 || py < 0 || px >= dim || py >= dim) return null;
      return bytes[((flip ? dim - 1 - py : py) * dim + px) * 4] / 255;
    };
    // Anchor on the first LIT texel on the shadow side of a wall.
    // ⚠️ THE LOOKBACK MUST BE WORLD-PX, NOT TEXELS (found 2026-08-02, chasing
    // "as high resolution as possible"): raising `layerGridDim` from ~512 to
    // 2048 shrank each texel from ~20 world px to ~5, so a fixed "1.5 texel"
    // lookback that used to land 30px into solid wall now lands 7.5px in —
    // inside the anti-aliased edge band, not confidently on either side —
    // and the anchor search silently found ZERO anchors. A resolution CHANGE
    // broke a CHECK, not the model; the fix is to measure in the space the
    // claim is actually about (world px), matching the pattern
    // `stationSpacingPx`'s own header already argues for.
    const texelWorldPx = (rect.maxX - rect.minX) / W;
    const lookbackTexels = Math.max(1.5, 20 / texelWorldPx);
    /** ⚠️ THE LAW IS ABOUT CAST SHADOW ON OPEN GROUND, NOT DEPTH UNDER COVER
     * (author, 2026-08-02: *"The 'law' that I ask you to set up is over
     * strict"*, in the same breath as asking for the middle of a covered span
     * to get DARKER the further in it sits).
     *
     * Both are true at once, and they are not in conflict — they govern
     * DIFFERENT REGIONS. Walk away from a wall across open ground and the
     * shadow must only ever lighten; that is the invariant that caught a
     * bright halo and a detached second shadow, and it stays. But a receiver
     * standing UNDER an overhead mass is in the depth regime, where "further
     * from the edge" legitimately means darker, and sweeping a ray from open
     * ground in under a bridge deck crosses from one regime into the other —
     * so a blanket "never darkens" would flag the author's own requested look
     * as a violation.
     *
     * Scoping it: stop each sweep when the receiver goes under cover, exactly
     * as it already stops when the receiver hits another wall. What remains
     * measured is the claim the check was always really making. */
    const coverAtWorld = (wx, wy) => {
      const tx = Math.round(((wx - rect.minX) / (rect.maxX - rect.minX)) * (W - 1));
      const ty = Math.round(((wy - rect.minY) / (rect.maxY - rect.minY)) * (H - 1));
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return 0;
      const o = (ty * W + tx) * 4;
      // G/B/A = overhead, floor-above, higher — every layer that can put
      // something over this texel. R (walls) is handled by its own stop.
      return Math.max(field.data[o + 1], field.data[o + 2], field.data[o + 3]) / 255;
    };
    const anchors = [];
    for (let ty = 3; ty < H - 3 && anchors.length < maxAnchors; ty++) {
      for (let tx = 3; tx < W - 3 && anchors.length < maxAnchors; tx++) {
        if (wallAt(tx, ty) > 0.15) continue;
        const bx = Math.round(tx - sd.x * lookbackTexels);
        const by = Math.round(ty - sd.y * lookbackTexels);
        if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
        if (wallAt(bx, by) < 0.85) continue;
        anchors.push({
          wx: rect.minX + (tx / (W - 1)) * (rect.maxX - rect.minX),
          wy: rect.minY + (ty / (H - 1)) * (rect.maxY - rect.minY),
        });
      }
    }
    // 1.15x margin past the tip — enough to see a hard cutoff if one exists.
    const spanPx = Math.max(1, maxThrowPx) * 1.15;
    /** ⚠️ SECOND FIX, SAME BUG (2026-08-02): bounding by `maxThrowPx` alone
     * still was not enough. On a dense real town floor, a second UNRELATED
     * building routinely sits well within any one building's own throw
     * radius — measured directly: a clean, textbook monotonic ramp for the
     * first ~70px (darkest at the wall, exactly as required), then a genuine
     * separate building's own wall and shadow starting around d=320. Walking
     * PAST that second wall and grading its shadow as though it were the
     * first anchor's own curve is not a defect, it is two independent
     * shadows on the same map — the wandering-into-another-building failure
     * mode this measurement exists to AVOID, not detect.
     *
     * The correct stopping rule is not a distance, it is geometric: THE LAW
     * is a claim about ONE occluder's own curve, so the sweep stops the
     * instant the ray walks onto a DIFFERENT wall's own footprint. Everything
     * from the anchor up to that point is unambiguously "this wall's
     * approach corridor"; nothing past it is this wall's claim to make. */
    const wallAtWorld = (wx, wy) => {
      const tx = Math.round(((wx - rect.minX) / (rect.maxX - rect.minX)) * (W - 1));
      const ty = Math.round(((wy - rect.minY) / (rect.maxY - rect.minY)) * (H - 1));
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return 0;
      return wallAt(tx, ty);
    };
    let worstRise = 0;
    let worstAt = null;
    let darkest = 1;
    let lightest = 0;
    let sweptPx = 0;
    for (const a of anchors) {
      let prev = null;
      for (let k = 0; k <= 60; k++) {
        const d = (spanPx * k) / 60;
        const wx = a.wx + sd.x * d;
        const wy = a.wy + sd.y * d;
        // Walked onto a DIFFERENT building's own wall — this anchor's own
        // corridor has ended; whatever is past here is not its claim.
        if (k > 0 && wallAtWorld(wx, wy) > 0.5) break;
        // Walked UNDER COVER — left the cast-shadow regime for the depth
        // regime, where darker-further-in is the REQUIRED look, not a
        // violation. See `coverAtWorld`'s own header.
        if (k > 0 && coverAtWorld(wx, wy) > 0.5) break;
        const v = visAtWorld(wx, wy);
        if (v === null) break;
        if (v < darkest) darkest = v;
        if (v > lightest) lightest = v;
        if (prev !== null) {
          sweptPx += spanPx / 60;
          const rise = prev - v; // visibility DROPPING = occlusion RISING = a violation
          if (rise > worstRise) {
            worstRise = rise;
            worstAt = { wx: Math.round(wx), wy: Math.round(wy), distPx: Math.round(d) };
          }
        }
        prev = v;
      }
    }
    return {
      anchors: anchors.length,
      worstRise: Number(worstRise.toFixed(4)),
      worstAt,
      darkest,
      lightest,
      sweptPx: Math.round(sweptPx),
      tolerance,
    };
  }

  /**
   * 🚪 DOES THIS SHADOW SURVIVE THE LIVE FLOOR GATE?
   *
   * THE GAP THIS CLOSES (author, live, 2026-08-02: the River Town Bridge map
   * showed *"basically no shadow"* while THIS BENCH rendered the picture they
   * called "damn near perfect", on the same data): this bench renders the
   * BAKED FIELD, whole. The real composite does not. `environmental-light.js`
   * multiplies the field by a FLOOR-MATCH gate —
   * `mix(1, sunVis, floorMatch)`, where `floorMatch` is 1 only where
   * `buf:scene.attr`'s R (each drawn item's OWN floor index,
   * `vt/scene-attr.js`) equals the floor this field was baked for. A pixel
   * that draws a DIFFERENT floor's art gets a provable 1 — no shadow at all.
   *
   * That gate is correct in itself (it stops floor 0's field darkening floor
   * 1's rooftops). But it interacts badly with the sky-reach layer in a way
   * neither this bench nor any Node test could see: `coverAbove` is nonzero
   * exactly where an upper floor HAS art — and that is exactly where that
   * upper floor's art gets DRAWN, so `attr.r != bakedFloor` there. The
   * darkest part of a sky-reach shadow — the whole depth gradient, which
   * lives under the covering mass by construction — can land entirely on
   * pixels the gate then blanks.
   *
   * So this measures the OVERLAP, not the field: of all the darkness this
   * bake produces, how much falls on texels the live gate will reject? A high
   * number means the lab picture is honest about the FIELD and dishonest
   * about the SCREEN, which is the exact failure mode
   * `feedback_instruments_must_not_lie` names.
   *
   * ⚠️ `coverAbove > 0.5` is a PROXY for "the gate will reject here", not the
   * gate itself — the real gate reads `buf:scene.attr`, which only exists in
   * the live geometry pass. It is a good proxy (upper-floor art present ⇒
   * that art is what draws there) and a deliberately conservative one: it
   * cannot see partial alpha, so it under-counts rejection rather than
   * inventing it.
   */
  function measureFloorGateSurvival(bytes, dim, field) {
    const flip = yFlip === true;
    const { w: W, h: H } = field;
    let dark = 0;
    let darkGatedOut = 0;
    let darkSurvives = 0;
    let worstSurvivingVis = 1;
    for (let py = 0; py < dim; py++) {
      for (let px = 0; px < dim; px++) {
        const vis = bytes[((flip ? dim - 1 - py : py) * dim + px) * 4] / 255;
        if (vis >= 0.5) continue; // not meaningfully shadowed
        // Output pixel → field texel (both span the identical world rect).
        const tx = Math.min(W - 1, Math.round((px / (dim - 1)) * (W - 1)));
        const ty = Math.min(H - 1, Math.round((py / (dim - 1)) * (H - 1)));
        const coverAbove = field.data[(ty * W + tx) * 4 + 2] / 255;
        dark++;
        if (coverAbove > 0.5) darkGatedOut++;
        else {
          darkSurvives++;
          if (vis < worstSurvivingVis) worstSurvivingVis = vis;
        }
      }
    }
    return {
      darkTexels: dark,
      gatedOut: darkGatedOut,
      survives: darkSurvives,
      gatedOutPct: dark > 0 ? +((darkGatedOut / dark) * 100).toFixed(1) : 0,
      // The darkest shadow the author can ACTUALLY see in the game, as opposed
      // to the darkest this bench paints. 1.0 = they see nothing at all.
      darkestVisibleOnScreen: +worstSurvivingVis.toFixed(3),
    };
  }

  /**
   * 🔬 ONE LAYER AT A TIME (author, 2026-08-02: *"We need to accurately see the
   * shadows for the overhead layers, building shadows, AO and sky reach all
   * separatable for easy comparison."*).
   *
   * A multiplier over the per-layer strengths, so isolating a layer costs
   * nothing new in the shader — the model already has a per-layer strength
   * vector, and zeroing three of four is exactly "show me only that one".
   *
   * ⚠️ THERE IS NO `ao` ENTRY, AND THAT IS NOT AN OVERSIGHT. The author asked
   * for AO as a fourth separable layer, but the layer-smear model HAS no
   * ambient-occlusion term — the retired softmax-mean smear had a dedicated
   * contact-AO accumulator (`accContact`, a lee-gated wide-mip read at the
   * receiver), and the layer-smear redesign deliberately dropped it: contact
   * darkening now falls out of station 0's own near-field read rather than
   * being a separate term with its own strength. Adding an `ao: [0,0,0,0]`
   * key would render a blank frame and read as "AO is broken" rather than
   * "AO does not exist here" — the exact lie `feedback_instruments_must_not_lie`
   * is about. If a real AO term is ever wanted back, it gets a real
   * accumulator first and an entry here second.
   */
  const LAYER_ISOLATION = Object.freeze({
    all: [1, 1, 1, 1],
    walls: [1, 0, 0, 0],
    overhead: [0, 1, 0, 0],
    // B and A together: `packLayerTexelData` merges "the floor directly above"
    // and "everything higher" into B today (A is the documented empty slot),
    // so sky-reach is honestly ONE isolation, not two.
    skyReach: [0, 0, 1, 1],
  });

  /** Every look/geometry input one render needs, resolved from `ctx.params`
   * ONCE so the single-floor and all-floors scenarios cannot drift apart in
   * what they actually feed the material. */
  function resolveShadowParams(params) {
    const isolateKey = params.layerIsolate ?? 'all';
    const isolate = LAYER_ISOLATION[isolateKey] ?? LAYER_ISOLATION.all;
    const baseStrengths = params.strengths ?? [0.95, 0.95, 0.95, 0.95];
    return {
      isolateKey,
      azimuthDeg: params.azimuthDeg ?? 220,
      elevationDeg: params.elevationDeg ?? 30,
      tier: params.tier ?? 3,
      heightsPx: [params.wallHeightPx ?? 300, params.overheadHeightPx ?? 220, params.aboveHeightPx ?? 400, 0],
      strengths: baseStrengths.map((s, i) => s * isolate[i]),
      // See `buildLayerField` for why this defaults to `tile` rather than the
      // derive bench's own `levelForeground`.
      overheadHostType: params.overheadHostType ?? 'tile',
      depthRadiusPx: params.depthRadiusPx ?? [0, 0, 1300, 1340],
      softnessMul: params.softnessMul ?? 0.2,
      basePx: params.basePx ?? 1,
      falloffExp: params.falloffExp ?? 1,
      tipBlurMul: params.tipBlurMul ?? 3,
    };
  }

  /** Build + upload + render ONE floor's field. Returns the raw bytes plus the
   * field itself, so a caller can measure it as well as look at it. */
  async function renderOneFloor(floorIndex, plan, p) {
    const field = await buildLayerField(floorIndex, plan.fieldDim, plan.layerGridDim, p.overheadHostType);
    const resolved = resolveLayerSmear({
      azimuthDeg: p.azimuthDeg,
      elevationDeg: p.elevationDeg,
      heightsPx: p.heightsPx,
    });
    layerSmear.layerTexNode.value = uploadLayers(field);
    layerSmear.setRect(field.rect);
    layerSmear.setField({ layerGridDimPx: field.w });
    layerSmear.setSun(resolved);
    layerSmear.setLayers({ strengths: p.strengths });
    layerSmear.setDepth({ radiiPx: p.depthRadiusPx });
    layerSmear.setLook({
      strength01: 1,
      softnessMul: p.softnessMul,
      basePx: p.basePx,
      falloffExp: p.falloffExp,
      tipBlurMul: p.tipBlurMul,
    });
    layerSmear.setEdgeBandPx(0);
    const bytes = await renderTo(layerSmear, layerSmearQuad, plan.fieldDim);
    return { bytes, field, resolved };
  }

  /**
   * Paint several floors into the ONE canvas, stacked, each at its TRUE world
   * aspect (author, 2026-08-02: *"a debug view of all three floors composited
   * together so that I can check if the whole scene's three floor structure
   * shadows mix together correctly"* — and, earlier and emphatically, that
   * there be exactly one viewing panel).
   *
   * ⚠️ ASPECT-CORRECTED, unlike `paintTo`. The bake target is SQUARE
   * (`fieldDim²`) while the world rect is not (this scene is 10650×4950), so
   * painting the square buffer straight to the canvas — which is what the
   * single-floor view does — stretches everything vertically by ~2.15×. That
   * is tolerable when you are looking at one frame and know it; it is not when
   * the whole point is comparing three frames against each other and against
   * a screenshot of the real map.
   */
  function paintStack(canvasId, frames, dim, rect) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const worldAspect = (rect.maxX - rect.minX) / (rect.maxY - rect.minY);
    const outW = dim;
    const frameH = Math.max(1, Math.round(outW / worldAspect));
    const labelH = 28;
    const gap = 10;
    canvas.width = outW;
    canvas.height = frames.length * (frameH + labelH + gap);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // One reusable scratch canvas holding a frame at its NATIVE square size;
    // `drawImage` then does the aspect correction and scaling in one step.
    const scratch = document.createElement('canvas');
    scratch.width = dim;
    scratch.height = dim;
    const sctx = scratch.getContext('2d');
    const flip = yFlip === true;

    let y = 0;
    for (const f of frames) {
      const out = new Uint8ClampedArray(dim * dim * 4);
      for (let row = 0; row < dim; row++) {
        const srcRow = flip ? dim - 1 - row : row;
        out.set(f.bytes.subarray(srcRow * dim * 4, (srcRow + 1) * dim * 4), row * dim * 4);
      }
      sctx.putImageData(new ImageData(out, dim, dim), 0, 0);

      ctx.fillStyle = '#e8e8ee';
      ctx.font = '16px ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.label, 8, y + labelH / 2);
      y += labelH;
      ctx.drawImage(scratch, 0, 0, dim, dim, 0, y, outW, frameH);
      y += frameH + gap;
    }
  }

  const scenarios = new Map();

  scenarios.set('layer-smear-real-floor', {
    name: 'layer-smear-real-floor',
    summary:
      'THE LAYER SMEAR MODEL over the REAL derived Tower Bridge layer stack, at real Extreme-tier ' +
      'resolution. Enforces THE LAW (a shadow may only ever get lighter with distance) by sweeping ' +
      'outward from every real wall edge, and reports where the worst violation is in world coordinates.',
    async run(ctx) {
      const floorId = ctx.params.floorId ?? 'middle';
      const azimuthDeg = ctx.params.azimuthDeg ?? 220;
      const elevationDeg = ctx.params.elevationDeg ?? 30;
      const tier = ctx.params.tier ?? 3;
      const fx = FIXTURE.floors.find((f) => f.id === floorId);
      if (!fx) return { checks: [check({ id: 'floor-exists', status: 'UNMEASURED', note: `no floor '${floorId}'` })] };

      await ensureRenderer();
      const plan = layerSmearTierPlan(tier);
      ensureLayerSmear(plan.steps);
      let calibration = 'OK';
      try {
        await selfTest(plan.fieldDim);
        if (yFlip === null) calibration = 'FAILED';
      } catch {
        calibration = 'FAILED';
      }
      if (calibration === 'FAILED') {
        return {
          calibration,
          checks: [
            check({
              id: 'orientation-calibrated',
              status: 'UNMEASURED',
              note: 'selfTest could not establish row order',
            }),
          ],
        };
      }

      // Heights, strengths, the sky-reach gradient and the layer isolation all
      // resolve through `resolveShadowParams` — ONE place, shared with the
      // all-floors scenario, so the two views cannot silently disagree about
      // what they are rendering. See that function (and `LAYER_ISOLATION`) for
      // each default's own story, including why the author's requested "AO"
      // isolation deliberately does not exist.
      const p = resolveShadowParams(ctx.params);
      const { heightsPx, strengths, depthRadiusPx } = p;
      const { bytes, field, resolved } = await renderOneFloor(fx.index, plan, p);
      lastRender = { bytes, dim: plan.fieldDim, rect: field.rect, yFlip };
      paintTo('sunShadowView', bytes, plan.fieldDim);

      const law = measureTheLaw(bytes, plan.fieldDim, field, azimuthDeg, resolved.maxThrowPx);
      const holes = findHoles(bytes, plan.fieldDim, field.rect);
      const gate = measureFloorGateSurvival(bytes, plan.fieldDim, field);

      return {
        calibration,
        checks: [
          evaluate('the-law-never-darkens-with-distance', () => ({
            ok: law.worstRise <= law.tolerance,
            measured: law.worstRise,
            expected: `<= ${law.tolerance}`,
            note:
              `worst violation at ${JSON.stringify(law.worstAt)} across ${law.anchors} real wall edges. ` +
              'A shadow from one light and opaque occluders may only ever get lighter with distance.',
          })),
          evaluate('the-law-sweep-is-not-vacuous', () => ({
            // TWO ways this check can go vacuous, both guarded: (1) a fully-lit
            // picture satisfies "never darkens" trivially — darkest/lightest
            // catch that; (2) the per-anchor "stop at the next wall" rule could
            // degenerate to every anchor stopping after one step, which would
            // ALSO satisfy "never darkens" trivially by sweeping almost nothing
            // — sweptPx catches that. Both are real failure modes this check
            // has actually shown on real geometry mid-development, not a
            // theoretical worry (memory: feedback_instruments_must_not_lie).
            ok: law.anchors > 20 && law.darkest < 0.7 && law.lightest > 0.9 && law.sweptPx > law.anchors * 100,
            measured: `${law.anchors} anchors, ${law.sweptPx}px total swept, darkest ${law.darkest.toFixed(3)}, lightest ${law.lightest.toFixed(3)}`,
            expected: 'sweeps through real shadow AND real light, over a real distance',
          })),
          evaluate('no-holes-or-halos', () => ({
            ok: holes.count === 0,
            measured: holes.count,
            expected: 0,
            note: `worst: ${JSON.stringify(holes.samples[0] ?? null)}`,
          })),
          evaluate('survives-the-live-floor-gate', () => ({
            // See `measureFloorGateSurvival`'s own header. This is the ONLY
            // check here that asks about the SCREEN rather than the FIELD —
            // everything above can pass on a picture the player never sees.
            ok: gate.gatedOutPct < 60 && gate.darkestVisibleOnScreen < 0.7,
            measured: `${gate.gatedOutPct}% of this shadow lands under upper-floor art; darkest SURVIVING = ${gate.darkestVisibleOnScreen}`,
            expected: '< 60% gated out, and something genuinely dark left on screen',
            note:
              'environmental-light.js gates this field to pixels whose buf:scene.attr floor index matches the ' +
              'baked floor. Darkness landing where an upper floor draws its own art is erased before the ' +
              'author ever sees it — the field can be perfect and the map still look unshadowed.',
          })),
        ],
        inputs: {
          floorId,
          floorIndex: fx.index,
          azimuthDeg,
          elevationDeg,
          tier,
          plan,
          heightsPx,
          strengths,
          depthRadiusPx,
          layerIsolate: p.isolateKey,
        },
        stats: { law, holes: holes.count, gate, layerGrid: `${field.w}x${field.h}`, fieldDim: plan.fieldDim },
      };
    },
  });

  scenarios.set('all-floors-stack', {
    name: 'all-floors-stack',
    summary:
      'EVERY floor of the real Tower Bridge stack, rendered through the same real material and painted ' +
      'into the ONE canvas at true world aspect, newest floor last. Built to answer the author`s own ' +
      'question: is a lower floor`s shadow CONSISTENT as you move up the stack — identical except for ' +
      'the higher floors occluding what is below them? Combine with `layerIsolate` ' +
      '(all | walls | overhead | skyReach) to compare one layer at a time across all three.',
    async run(ctx) {
      await ensureRenderer();
      const p = resolveShadowParams(ctx.params);
      const plan = layerSmearTierPlan(p.tier);
      ensureLayerSmear(plan.steps);
      let calibration = 'OK';
      try {
        await selfTest(plan.fieldDim);
        if (yFlip === null) calibration = 'FAILED';
      } catch {
        calibration = 'FAILED';
      }
      if (calibration === 'FAILED') {
        return {
          calibration,
          checks: [
            check({
              id: 'orientation-calibrated',
              status: 'UNMEASURED',
              note: 'selfTest could not establish row order',
            }),
          ],
        };
      }

      const frames = [];
      const perFloor = [];
      for (const fx of FIXTURE.floors) {
        const { bytes, field } = await renderOneFloor(fx.index, plan, p);
        const gate = measureFloorGateSurvival(bytes, plan.fieldDim, field);
        // Mean darkness over the WHOLE frame — the one number that says "this
        // floor got more/less shadow than that one" at a glance, next to the
        // picture that says where.
        let sum = 0;
        for (let i = 0; i < bytes.length; i += 4) sum += bytes[i];
        const meanVis = sum / (bytes.length / 4) / 255;
        frames.push({
          bytes,
          label: `floor ${fx.index} — ${fx.id}   [${p.isolateKey}]   mean vis ${meanVis.toFixed(3)}`,
        });
        perFloor.push({
          floorId: fx.id,
          floorIndex: fx.index,
          meanVis: +meanVis.toFixed(4),
          gatedOutPct: gate.gatedOutPct,
        });
        // Keep the LAST floor probeable, matching the single-floor scenario's
        // own contract rather than leaving `lastRender` stale from a prior run.
        lastRender = { bytes, dim: plan.fieldDim, rect: field.rect, yFlip };
      }
      paintStack('sunShadowView', frames, plan.fieldDim, lastRender.rect);

      return {
        calibration,
        checks: [
          check({ id: 'orientation-calibrated', status: 'pass', measured: yFlip ? 'flipped' : 'unflipped' }),
          evaluate('every-floor-rendered', () => ({
            ok: frames.length === FIXTURE.floors.length,
            measured: frames.length,
            expected: FIXTURE.floors.length,
          })),
          evaluate('no-floor-is-blank', () => ({
            // A blank (mean vis 1.0) floor is the failure this view exists to
            // make visible — it is exactly what "the sky reach isn't picking up
            // the roof floor" looked like. An isolation that legitimately has
            // no casters on some floor will trip this; that is the point, and
            // the note says which.
            ok: perFloor.every((f) => f.meanVis < 0.999),
            measured: perFloor.map((f) => `${f.floorId}=${f.meanVis}`).join(' '),
            expected: 'every floor shows SOME shadow',
            note: 'a floor at exactly 1.000 cast nothing at all — with layerIsolate set, that may be honest (that layer has no casters on that floor) rather than a defect.',
          })),
        ],
        inputs: {
          floors: FIXTURE.floors.map((f) => f.id),
          tier: p.tier,
          layerIsolate: p.isolateKey,
          azimuthDeg: p.azimuthDeg,
          elevationDeg: p.elevationDeg,
          heightsPx: p.heightsPx,
          strengths: p.strengths,
          depthRadiusPx: p.depthRadiusPx,
        },
        stats: { perFloor, fieldDim: plan.fieldDim },
      };
    },
  });

  async function runScenario(scenario, ctx) {
    const result = await scenario.run(ctx);
    const artifacts = [];
    // ⚠️ ONE canvas (author, 2026-08-02: "Use only a single display for
    // everything, this means that I can then share the images it generates
    // with you at much higher resolution").
    for (const id of ['sunShadowView']) {
      const canvas = document.getElementById(id);
      if (canvas && canvas.width > 0) {
        const saved = await saveCanvasPng(ctx.runId, `${id}.png`, canvas);
        if (saved) artifacts.push(saved);
      }
    }
    return { ...result, artifacts };
  }

  registerBench({
    name: 'sun-shadow',
    title: 'Sun shadow — real derived data through the real shadow material',
    rung: 3,
    summary:
      'Renders buildLayerSmearBakeMaterial against a REAL packLayerTexelData layer field (the handoff ' +
      'bench-derive.js built), enforcing THE LAW and scanning for the hole/halo signature the author ' +
      'reported live on real geometry.',
    scenarios,
    params: {
      floorId: 'underground | middle | roof (default middle) — single-floor scenario only',
      layerIsolate:
        'all | walls | overhead | skyReach (default all). NO `ao` — the layer-smear model has no AO term; see LAYER_ISOLATION.',
      azimuthDeg: 'default 220',
      elevationDeg: 'default 30',
      tier: 'default 3 (Extreme)',
      wallHeightPx: 'default 300',
      overheadHeightPx: 'default 220',
      aboveHeightPx: 'default 400',
      strengths: 'per-layer 0..1, default [0.95, 0.95, 0.95, 0.95]',
      depthRadiusPx: 'per-layer world px, THE SKY-REACH GRADIENT, default [0, 0, 1300, 1340]',
    },
    checkIds: [
      'the-law-never-darkens-with-distance',
      'the-law-sweep-is-not-vacuous',
      'no-holes-or-halos',
      'survives-the-live-floor-gate',
      'orientation-calibrated',
      'every-floor-rendered',
      'no-floor-is-blank',
    ],
    ready: () => true,
    runScenario,
  });

  return {
    deriveBench,
    findHoles,
    paintTo,
    scenarios,
    getLastRender: () => lastRender,
    renderField,
  };
}
