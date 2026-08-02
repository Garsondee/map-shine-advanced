/**
 * THE LAYER SMEAR SHADOW MODEL — the TSL bake material.
 * Plan of record: `docs/planning/Sun-Shadows-Layer-Smear.md`.
 *
 * A line-for-line transcription of `layer-smear.js#layerSmearVisibility`. Read
 * THAT module's header for the model, the compositing argument, and THE LAW's
 * proof; this file is the same arithmetic in nodes, and every place the two
 * could drift (station spacing, falloff shape, throw lengths) is either shared
 * through a CPU-resolved uniform or has a named twin function on both sides.
 *
 * THE LAYER TEXTURE'S PACKING — one channel per occluder layer, and nothing
 * else. No heights, no gate, no merged silhouettes:
 *
 *   R  this floor's WALLS      (`_Outdoors` dark)
 *   G  this floor's OVERHEAD   (overhead tiles hosted here)
 *   B  the floor DIRECTLY ABOVE (background ∪ foreground art)
 *   A  EVERYTHING HIGHER, merged
 *
 * That the whole occluder description is ONE texture plus ONE `vec4` of heights
 * is the point of this model, not a coincidence — the packing it replaced
 * carried coverage and height in channels that disagreed at every silhouette
 * edge, which is what a per-texel height buys you.
 *
 * @module effects/lighting/layer-smear-render
 */
import { PENUMBRA_PER_PX, GATE_SHARPEN_LOW, GATE_SHARPEN_HIGH } from './sun-occlusion.js';
import { SHADOW_LAYER_COUNT, DEPTH_SCALES } from './layer-smear.js';

/** Ceiling on a requested mip level — a texture's chain tops out at
 * `log2(dimension)`, and asking past it is undefined on some backends. */
const MAX_LOD = 12;

/**
 * Build the layer-smear bake material.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.layerTexture - RGBA coverage, one channel per layer, sampled
 *   with CLAMP-TO-EDGE. The clamp is load-bearing, not incidental: the author's
 *   edge rule is *"if the black pixels of `_Outdoors` extend across the edge of
 *   the map then we assume that this continues into the distance"*, and
 *   clamp-to-edge IS that rule, for free, in the sampler.
 * @param {number} [args.steps=32] - stations along the smear. Unrolled, so a
 *   change means a new material — the caller rebuilds one when the tier moves.
 * @returns {{
 *   material: *,
 *   layerTexNode: *,
 *   setSun: (resolved: {dirX:number, dirY:number, throwPx:number[], maxThrowPx:number}) => void,
 *   setLayers: (args: {strengths?: number[]}) => void,
 *   setDepth: (args: {radiiPx: number[]}) => void,
 *   setField: (args: {layerGridDimPx?: number}) => void,
 *   setLook: (args: {strength01?: number, softnessMul?: number, basePx?: number, falloffExp?: number, tipBlurMul?: number}) => void,
 *   setRect: (rect: {minX:number, minY:number, maxX:number, maxY:number}) => void,
 *   setEdgeBandPx: (px: number) => void,
 * }}
 */
export function buildLayerSmearBakeMaterial({ THREE, layerTexture, steps = 32 }) {
  const { uniform, texture, uv, vec2, vec3, vec4, float, max, min, select, log2, smoothstep, pow, Fn } = THREE.TSL;

  const STEPS = Number.isFinite(steps) ? Math.max(4, Math.floor(steps)) : 32;

  const layerTexNode = texture(layerTexture);
  /** (dirToSunX, dirToSunY, maxThrowPx, _) — resolved on the CPU once per bake
   * by `layer-smear.js#resolveLayerSmear`, so the twin and the shader cannot
   * disagree about where the sun is or how far the stack reaches. */
  const uSun = uniform(vec4(0, -1, 0, 0));
  /** Per-layer throw distance, world px — `heightᵢ / tan(elevation)`, CPU-side. */
  const uThrowPx = uniform(vec4(0, 0, 0, 0));
  /** Per-layer strength 0..1. An upper floor need not darken as hard as a wall. */
  const uStrength = uniform(vec4(1, 1, 1, 1));
  /** (globalStrength, softnessMul, basePenumbraPx, falloffExponent). */
  const uLook = uniform(vec4(1, 1, 2, 1.6));
  /** (tipBlurMul, _, _, _) — how fast the penumbra widens with distance. */
  const uBlur = uniform(vec4(3, 0, 0, 0));
  /** Per-layer isotropic blur radius, world px — THE SKY-REACH GRADIENT
   * (`layer-smear.js#isotropicDepthTerm`'s own header has the physics). 0 =
   * off, this layer behaves exactly as it did before this uniform existed. */
  const uDepth = uniform(vec4(0, 0, 0, 0));
  /** The world rect this field covers: (minX, minY, maxX, maxY). */
  const uRect = uniform(vec4(0, 0, 1, 1));
  /** ⚠️ THE LAYER TEXTURE'S OWN resolution — NEVER the bake target's `fieldDim`.
   * Feeding the wrong one silently mis-sizes every mip request, which is a live
   * bug this project already shipped once (see `sun-occlusion-render.js`'s
   * `uCasterGridDim` for the full post-mortem). */
  const uLayerGridDim = uniform(float(1024));
  /** Width of the map-edge ramp, world px. */
  const uEdgeBandPx = uniform(float(0));

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;

  material.fragmentNode = Fn(() => {
    const rectSize = vec2(uRect.z.sub(uRect.x), uRect.w.sub(uRect.y));
    // uv().y = 0 is the rect's minY, matching `MaskGrid`'s "row 0 = minY" and a
    // DataTexture's default flipY:false — three spaces, one direction, no flip
    // anywhere in this file (memory: feedback_y_flip_recurring_risk).
    const world = vec2(uRect.x, uRect.y).add(uv().mul(rectSize));
    const toSun = vec2(uSun.x, uSun.y);
    const maxThrow = uSun.z;

    const strength = uLook.x;
    const softnessMul = uLook.y;
    const basePx = uLook.z;
    const falloffExp = uLook.w;

    // THE RECEIVER GATE — the sharpened `_Outdoors` read, from the WALL channel
    // (R): `1 − walls` is how outdoors this texel is. Same sharpening constants
    // the previous model used, so "indoors takes no sun shadow" behaves
    // identically across the change.
    const here = layerTexNode.sample(uv());
    const gate = smoothstep(float(GATE_SHARPEN_LOW), float(GATE_SHARPEN_HIGH), float(1).sub(here.r));

    const texelWorldPx = max(rectSize.x, rectSize.y).div(uLayerGridDim);
    const sampleUvAt = (at) => {
      const raw = at.sub(vec2(uRect.x, uRect.y)).div(rectSize);
      // Clamped, never wrapped. See `layerTexture`'s own doc — this IS the
      // author's edge rule, and wrapping would teleport a shadow across the map.
      return vec2(raw.x.clamp(0, 1), raw.y.clamp(0, 1));
    };

    // One running max per layer — the union WITHIN a layer.
    const occ = [];
    for (let i = 0; i < SHADOW_LAYER_COUNT; i++) occ.push(float(0).toVar());
    const layerThrow = [uThrowPx.x, uThrowPx.y, uThrowPx.z, uThrowPx.w];
    const depthRadii = [uDepth.x, uDepth.y, uDepth.z, uDepth.w];

    for (let j = 0; j <= STEPS; j++) {
      // `stationDistancePx(j, STEPS, maxThrow)` — stations bunch toward the
      // caster. `u` and `spacing` are plain JS numbers times a node, because
      // `j`/`STEPS` are compile-time constants; the twin computes the identical
      // values from the identical formula.
      const u = j / STEPS;
      const d = maxThrow.mul(float(u * u));
      const stationUv = sampleUvAt(world.add(toSun.mul(d)));
      // `stationSpacingPx(j, STEPS, maxThrow)` — the anti-aliasing FLOOR. No
      // sample may be narrower than the gap to its neighbour, or a thin caster
      // slips between two stations and THE LAW breaks discretely even though it
      // holds continuously (the twin's header spells this out).
      const spacing = maxThrow.mul(float((2 * u) / STEPS));
      const blurPx = max(
        basePx.add(d.mul(float(PENUMBRA_PER_PX)).mul(uBlur.x)).mul(softnessMul),
        max(spacing, texelWorldPx)
      );
      const lod = max(float(0), min(float(MAX_LOD), log2(max(blurPx.div(texelWorldPx), float(1)))));
      // ONE fetch serves every layer WITHOUT a depth radius — they are
      // channels of the same texel, so carrying four throw lengths through a
      // single shared walk is free.
      const packed = layerTexNode.sample(stationUv).level(lod);
      const cov = [packed.r, packed.g, packed.b, packed.a];

      for (let i = 0; i < SHADOW_LAYER_COUNT; i++) {
        const L = layerThrow[i];
        const r = depthRadii[i];
        // THE SKY-REACH GRADIENT — `layer-smear.js#isotropicDepthTerm`'s own
        // header has the physics, and its own comment explains why this is
        // NOT a term `max`'d in alongside the march (measured: a station's
        // own `d=0` sample already saturates occ[i] to 1 for any receiver
        // inside solid coverage, making a separately-added term a no-op — the
        // first version of this feature did exactly that). Instead, for a
        // layer with `r>0`, THIS STATION'S coverage read IS the isotropic
        // blur, taken AT the station's own position — so the near-field read
        // is "how enclosed is the receiver itself" and far stations still
        // carry the normal dawn/dusk elongation via the same `falloff(d/L)`
        // every layer uses. `r=0` (the default) always builds this fetch —
        // TSL has no cheap way to skip a sample on a RUNTIME uniform — but it
        // reads at mip 0 (no blur) and is unused (`select` below keeps `cov[i]`).
        //
        // NESTED RADII, not one — `layer-smear.js#DEPTH_SCALES` has the full
        // argument: a single radius SATURATES, so the middle of a wide span
        // and a point one radius in from its edge come out identical, which
        // is exactly the flatness this feature exists to remove. Averaging
        // several nested mip levels encodes depth as "how many scales still
        // see solid", so the gradient keeps deepening inward.
        let depthCov = float(0);
        for (let s = 1; s <= DEPTH_SCALES; s++) {
          const rs = r.mul(float(s / DEPTH_SCALES));
          const lodS = max(float(0), min(float(MAX_LOD), log2(max(rs.div(texelWorldPx), float(1)))));
          const packedS = layerTexNode.sample(stationUv).level(lodS);
          depthCov = depthCov.add([packedS.r, packedS.g, packedS.b, packedS.a][i]);
        }
        depthCov = depthCov.mul(float(1 / DEPTH_SCALES));
        // `r > 0` picks the isotropic read; `r == 0` keeps the sharp one. This
        // IS a real per-pixel branch (`select`, not `step`-as-arithmetic) —
        // safe here because nothing downstream shares state ACROSS layers or
        // stations the way the debug-channel fold that stranded 12 of 20
        // channels did (memory: feedback_tsl_select_chain_strands_vars); each
        // `occ[i]` is written exactly once per station regardless of which
        // branch is taken.
        const coverage = select(r.greaterThan(float(0)), depthCov, cov[i]);
        // `t > 1` (past this layer's throw) and `L <= 0` (this layer casts
        // nothing) both need to contribute ZERO. `max(L, 1e-3)` keeps the
        // divide finite and `clamp(0,1)` then pins `t` to 1, where the falloff
        // is exactly 0 — so both cases fall out of the arithmetic with no
        // branch.
        const t = d.div(max(L, float(1e-3))).clamp(0, 1);
        const fall = pow(float(1).sub(t), falloffExp);
        occ[i].assign(max(occ[i], coverage.mul(fall)));
      }
    }

    // Map-edge ramp, unchanged from the previous model.
    const dEdge = min(min(world.x.sub(uRect.x), uRect.z.sub(world.x)), min(world.y.sub(uRect.y), uRect.w.sub(world.y)));
    const ramp = smoothstep(float(0), max(uEdgeBandPx, float(1e-3)), dEdge);

    // ⚠️ TRANSMITTANCES MULTIPLY — different occluders in series. `strength ·
    // gate · ramp` scales each FACTOR rather than the product, so strength 0
    // returns exactly 1 however many layers are stacked.
    const attenuate = strength.mul(gate).mul(ramp);
    const layerStrength = [uStrength.x, uStrength.y, uStrength.z, uStrength.w];
    let transmittance = float(1);
    for (let i = 0; i < SHADOW_LAYER_COUNT; i++) {
      transmittance = transmittance.mul(float(1).sub(occ[i].mul(layerStrength[i]).mul(attenuate)));
    }
    const vis = transmittance.clamp(0, 1);
    // RGB, not just R, so the field is readable as a greyscale image in the
    // debug layer cycler — a shadow field you can LOOK at is the difference
    // between "this is broken" and "this has no casters".
    return vec4(vec3(vis, vis, vis), float(1));
  })();

  return {
    material,
    layerTexNode,
    /** @param {{dirX:number, dirY:number, throwPx:number[], maxThrowPx:number}} resolved -
     *  computed by the CALLER through `layer-smear.js#resolveLayerSmear`. */
    setSun(resolved) {
      uSun.value.set(resolved.dirX, resolved.dirY, resolved.maxThrowPx, 0);
      const t = resolved.throwPx ?? [];
      uThrowPx.value.set(t[0] ?? 0, t[1] ?? 0, t[2] ?? 0, t[3] ?? 0);
    },
    setLayers({ strengths }) {
      if (!Array.isArray(strengths)) return;
      const s = (i) => (Number.isFinite(strengths[i]) ? Math.max(0, Math.min(1, strengths[i])) : 1);
      uStrength.value.set(s(0), s(1), s(2), s(3));
    },
    /** @param {{radiiPx: number[]}} args - THE SKY-REACH GRADIENT, per layer,
     *  world px. 0 (the default) leaves that layer unchanged. */
    setDepth({ radiiPx }) {
      if (!Array.isArray(radiiPx)) return;
      const r = (i) => (Number.isFinite(radiiPx[i]) && radiiPx[i] > 0 ? radiiPx[i] : 0);
      uDepth.value.set(r(0), r(1), r(2), r(3));
    },
    setField({ layerGridDimPx }) {
      if (Number.isFinite(layerGridDimPx) && layerGridDimPx > 0) uLayerGridDim.value = layerGridDimPx;
    },
    setLook({ strength01, softnessMul, basePx, falloffExp, tipBlurMul }) {
      if (Number.isFinite(strength01)) uLook.value.x = Math.max(0, Math.min(1, strength01));
      if (Number.isFinite(softnessMul) && softnessMul > 0) uLook.value.y = softnessMul;
      if (Number.isFinite(basePx) && basePx >= 0) uLook.value.z = basePx;
      // ⚠️ Must stay > 0 — THE LAW's proof needs the falloff monotonically
      // decreasing, and an exponent of 0 makes it the constant 1.
      if (Number.isFinite(falloffExp) && falloffExp > 0) uLook.value.w = falloffExp;
      if (Number.isFinite(tipBlurMul) && tipBlurMul > 0) uBlur.value.x = tipBlurMul;
    },
    setRect(rect) {
      uRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
    },
    setEdgeBandPx(px) {
      uEdgeBandPx.value = px > 0 ? px : 0;
    },
  };
}
