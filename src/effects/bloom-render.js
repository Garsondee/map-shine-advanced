/**
 * BLOOM RENDER — the TSL material builders for the dual-filter bloom pyramid.
 *
 * Pure builders: THREE/TSL is INJECTED (never imported), no renderer, no
 * allocator, no RenderTargets — exactly the boundary candle-flame-render.js and
 * grade-present.js keep, so `effects/` never reaches the GPU driver directly.
 * The viewer (vt/vt-pan-viewer.js#runPostBloomPass) owns the render targets and
 * the pass sequencing; this file owns the SHADERS and returns the swappable
 * uniform handles the viewer drives per frame.
 *
 * THE PIPELINE (docs/planning/Bloom.md — Jimenez / Call of Duty: Advanced
 * Warfare "physically-based bloom"):
 *
 *   scene.lit ──[bright]──▶ m0 ──[downsample ×5]──▶ m1 m2 m3 m4 m5
 *                                 (13-tap; Karis average on the FIRST step,
 *                                  m0→m1, to kill fireflies)
 *   CORE  band: m2 ─tent▶ m1 ─tent▶ m0   (additive) → m0 = smooth blur of 0..2
 *   ATMO  band: m5 ─tent▶ m4 ─tent▶ m3   (additive) → m3 = smooth blur of 3..5
 *   [composite]: strength·(coreStrength·coreTint·m0 + atmoStrength·atmoTint·m3)
 *                additively into scene.lit  ← graded WITH the scene by present
 *
 * The bright pass DARKENS its input by a world-space mask BEFORE any blur, so a
 * bright source in a clamped region contributes zero energy to the pyramid and
 * cannot bloom outward. Today: the `_Outdoors` "outdoor spill" clamp. The same
 * hook is where a native fog-of-war visibility texture connects later.
 *
 * TSL trap heeded (reference_tsl_method_chaining_trap): `mix`/`smoothstep` are
 * used in FUNCTION form; `.clamp()`/`.max()` are safe as methods (the receiver
 * is the value, not the interpolant) and match the house style.
 *
 * @module effects/bloom-render
 */

import { buildOutdoorsGate } from './lighting/environmental-light.js';

/** Rec.709 luminance of a linear-RGB node (for the Karis firefly weight). */
function lumaOf(TSL, c) {
  const { dot, vec3 } = TSL;
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

/**
 * Build every bloom material once. The viewer allocates the mip render targets
 * first, then hands their textures in here (the composite samples two of them
 * directly; the down/upsample materials swap their input per pass).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.litTexture   - scene.lit's texture (linear HDR) — the bright-pass source.
 * @param {*} args.coreTexture  - the CORE band's top mip texture (mips[0]).
 * @param {*} args.atmoTexture  - the ATMOSPHERE band's top mip texture (mips[atmoTop]).
 * @param {*} [args.outdoorsTexNode] - the SHARED `_Outdoors` node from
 *   environmental-light.js (share it, never a private `texture()`, so a mask
 *   rebake reaches bloom too — the frozen-input lesson grade-present.js records).
 * @param {*} [args.uViewRect]      - SHARED camera-rect uniform (per-frame world rect).
 * @param {*} [args.uOutdoorsRect]  - SHARED mask-rect uniform.
 * @returns {object} materials + uniform handles (see the return literal).
 */
export function buildBloomMaterials({
  THREE,
  litTexture,
  coreTexture,
  atmoTexture,
  outdoorsTexNode,
  uViewRect,
  uOutdoorsRect,
}) {
  const TSL = THREE.TSL;
  const { texture, uv, vec2, vec4, float, uniform, Fn, mix, smoothstep, max } = TSL;

  // ── BRIGHT PASS ──────────────────────────────────────────────────────────
  // Soft-knee threshold (Unity/COD prefilter) × the outdoor-spill clamp.
  const litTexNode = texture(litTexture);
  const uThreshold = uniform(1.0);
  const uKnee = uniform(0.5);
  const uSpillEnabled = uniform(1.0); // 0/1 — outdoorSpillSuppress toggle
  const uSpillLo = uniform(0.42);
  const uSpillHi = uniform(0.92);

  // The world-space gate (null when no `_Outdoors` mask node was supplied — the
  // whole clamp term then compiles OUT, per the dead-code rule). 1 = outdoors.
  const outdoorsGate = buildOutdoorsGate(TSL, { uViewRect, uOutdoorsRect, outdoorsTexNode });

  const brightMaterial = new THREE.NodeMaterial();
  brightMaterial.depthTest = false;
  brightMaterial.depthWrite = false;
  brightMaterial.fragmentNode = Fn(() => {
    const c = litTexNode.sample(uv()).rgb;
    // Brightness = max channel (does not desaturate coloured highlights).
    const br = c.r.max(c.g).max(c.b);

    // Quadratic soft knee: a gentle roll-in across [threshold-knee, threshold+knee]
    // instead of a hard step (the hard step is the classic "grainy bloom" source).
    const kneeW = uThreshold.mul(uKnee).add(1e-4);
    const soft = br.sub(uThreshold).add(kneeW).clamp(0.0, kneeW.mul(2.0));
    const softQ = soft.mul(soft).div(kneeW.mul(4.0).add(1e-4));
    const contribution = max(softQ, br.sub(uThreshold)).div(max(br, 1e-4)).max(0.0);
    let bright = c.mul(contribution);

    // OUTDOOR SPILL CLAMP — only where the `_Outdoors` mask exists (JS-gated).
    if (outdoorsGate) {
      const lo = uThreshold.mul(uSpillLo);
      const hi = uThreshold.mul(uSpillHi);
      // Dark outdoor ground (< lo) keeps no bloom; real outdoor highlights (> hi)
      // keep full bloom; fades between. Indoors (mask 0) and when disabled → 1.
      const lumGate = smoothstep(lo, hi, br);
      const outdoorFactor = outdoorsGate.mul(uSpillEnabled);
      bright = bright.mul(mix(float(1.0), lumGate, outdoorFactor));
    }

    return vec4(bright, 1.0);
  })();
  brightMaterial.name = 'Bloom_bright';

  // ── DOWNSAMPLE (13-tap) ──────────────────────────────────────────────────
  // Two variants: the FIRST step (m0→m1) applies the Karis average to suppress
  // fireflies; the rest are the plain weighted 13-tap. `uInvTexel` = 1/srcRes,
  // swapped per pass by the viewer.
  const makeDownsample = (karis, tag) => {
    const inputNode = texture(null);
    const uInvTexel = uniform(new THREE.Vector2(1, 1));
    const mat = new THREE.NodeMaterial();
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.fragmentNode = Fn(() => {
      const base = uv();
      const x = uInvTexel.x;
      const y = uInvTexel.y;
      const S = (ox, oy) => inputNode.sample(base.add(vec2(x.mul(ox), y.mul(oy)))).rgb;

      // a b c / j k / d e f / l m / g h i  (COD 36-effective-tap pattern)
      const a = S(-2, 2);
      const b = S(0, 2);
      const c = S(2, 2);
      const d = S(-2, 0);
      const e = S(0, 0);
      const f = S(2, 0);
      const g = S(-2, -2);
      const h = S(0, -2);
      const i = S(2, -2);
      const j = S(-1, 1);
      const k = S(1, 1);
      const l = S(-1, -1);
      const m = S(1, -1);

      let outc;
      if (karis) {
        // Five overlapping boxes, each averaged then Karis-weighted by 1/(1+luma)
        // so one blown-out subpixel cannot dominate (the pulsating-bloom fix).
        const k0 = a.add(b).add(d).add(e).mul(0.25);
        const k1 = b.add(c).add(e).add(f).mul(0.25);
        const k2 = d.add(e).add(g).add(h).mul(0.25);
        const k3 = e.add(f).add(h).add(i).mul(0.25);
        const k4 = j.add(k).add(l).add(m).mul(0.25);
        const w = (grp) => float(1.0).div(lumaOf(TSL, grp).mul(0.25).add(1.0));
        outc = k0
          .mul(w(k0))
          .mul(0.125)
          .add(k1.mul(w(k1)).mul(0.125))
          .add(k2.mul(w(k2)).mul(0.125))
          .add(k3.mul(w(k3)).mul(0.125))
          .add(k4.mul(w(k4)).mul(0.5));
      } else {
        outc = e
          .mul(0.125)
          .add(a.add(c).add(g).add(i).mul(0.03125))
          .add(b.add(d).add(f).add(h).mul(0.0625))
          .add(j.add(k).add(l).add(m).mul(0.125));
      }
      return vec4(outc, 1.0);
    })();
    mat.name = `Bloom_downsample_${tag}`;
    return { material: mat, inputNode, uInvTexel };
  };
  const downsampleKaris = makeDownsample(true, 'karis');
  const downsample = makeDownsample(false, 'plain');

  // ── UPSAMPLE (3×3 tent, additive) ────────────────────────────────────────
  // One material, reused for both bands; `uFilterRadius` (UV units) is the tent
  // reach, set per band by the viewer (coreSpread vs atmoSpread). Additive blend
  // accumulates the coarser mip into the finer one — the viewer guards the clear.
  const upInputNode = texture(null);
  const uFilterRadius = uniform(0.005);
  const upsampleMaterial = new THREE.NodeMaterial();
  upsampleMaterial.depthTest = false;
  upsampleMaterial.depthWrite = false;
  upsampleMaterial.transparent = true;
  upsampleMaterial.blending = THREE.AdditiveBlending;
  upsampleMaterial.fragmentNode = Fn(() => {
    const base = uv();
    const r = uFilterRadius;
    const S = (ox, oy) => upInputNode.sample(base.add(vec2(r.mul(ox), r.mul(oy)))).rgb;
    const a = S(-1, 1);
    const b = S(0, 1);
    const c = S(1, 1);
    const d = S(-1, 0);
    const e = S(0, 0);
    const f = S(1, 0);
    const g = S(-1, -1);
    const h = S(0, -1);
    const i = S(1, -1);
    // 1 2 1 / 2 4 2 / 1 2 1, ÷16
    const outc = e
      .mul(4.0)
      .add(b.add(d).add(f).add(h).mul(2.0))
      .add(a.add(c).add(g).add(i))
      .mul(1.0 / 16.0);
    return vec4(outc, 1.0);
  })();
  upsampleMaterial.name = 'Bloom_upsample';

  // ── COMPOSITE (two bands → scene.lit, additive) ──────────────────────────
  const coreTexNode = texture(coreTexture);
  const atmoTexNode = texture(atmoTexture);
  const uStrength = uniform(1.0);
  const uCoreStrength = uniform(1.0);
  const uWideStrength = uniform(0.5);
  const uCoreTint = uniform(new THREE.Vector3(1, 1, 1));
  const uWideTint = uniform(new THREE.Vector3(1, 1, 1));

  const compositeMaterial = new THREE.NodeMaterial();
  compositeMaterial.depthTest = false;
  compositeMaterial.depthWrite = false;
  compositeMaterial.transparent = true;
  compositeMaterial.blending = THREE.AdditiveBlending;
  compositeMaterial.fragmentNode = Fn(() => {
    const core = coreTexNode.sample(uv()).rgb.mul(uCoreTint).mul(uCoreStrength);
    const atmo = atmoTexNode.sample(uv()).rgb.mul(uWideTint).mul(uWideStrength);
    const bloom = core.add(atmo).mul(uStrength);
    return vec4(bloom, 1.0);
  })();
  compositeMaterial.name = 'Bloom_composite';

  return {
    brightMaterial,
    downsampleKaris,
    downsample,
    upsampleMaterial,
    upsample: { inputNode: upInputNode, uFilterRadius },
    compositeMaterial,
    // Uniform handles the viewer writes each frame from the resolved params.
    uniforms: {
      threshold: uThreshold,
      knee: uKnee,
      spillEnabled: uSpillEnabled,
      spillLo: uSpillLo,
      spillHi: uSpillHi,
      strength: uStrength,
      coreStrength: uCoreStrength,
      atmoStrength: uWideStrength,
      coreTint: uCoreTint,
      atmoTint: uWideTint,
    },
    /** True when the outdoor-spill clamp is compiled in (a mask node was supplied). */
    outdoorGateCompiled: !!outdoorsGate,
  };
}
