/**
 * LIGHTNING — THE RUNTIME (the batched ribbon mesh's TSL material + its
 * THREE geometry wrapper). Pure math (path/branch/envelope/light-source
 * building) lives in lightning-geometry.js; this file is TSL/THREE glue only,
 * browser-verified live, mirroring candle-flame-render.js's own split.
 *
 * ============================================================================
 * WORLD-SPACE RIBBON, NOT V2's SCREEN-SPACE ONE — a deliberate adaptation
 * ============================================================================
 *
 * V2's GLSL vertex shader built a CONSTANT-SCREEN-PIXEL-WIDTH ribbon: it
 * projected positions to clip space and did its miter-join math in NDC/pixel
 * space via a resolution uniform, so the bolt's width never changed on
 * screen regardless of camera zoom. Every other MSA effect's `px` params are
 * WORLD-space (a candle's `sizePx` is a fixed world size the camera frames
 * differently at different zooms — see candle-flame-render.js's own header),
 * and this project's own established ribbon idiom
 * (effects/particles/gust-runtime.js's `material.positionNode`) already
 * builds its trail ribbons the same way: tangent → perpendicular normal →
 * offset by a half-width, entirely in WORLD units. This file follows that
 * SAME established idiom rather than porting V2's NDC-space approach — one
 * fewer novel technique, one more effect consistent with how zoom already
 * works everywhere else in MSA. The MITER-JOIN math itself (not just a plain
 * per-vertex normal offset) IS ported from V2, applied to world-space
 * tangents instead of clip-space ones, since sharp fractal zigzags really do
 * need it to avoid a visible notch at each joint.
 *
 * ============================================================================
 * THE ENVELOPE IS COMPUTED ON THE GPU, PER VERTEX — the batching payoff
 * ============================================================================
 *
 * V2 computed `_computeStrikeEnvelope` once per frame, per strike, in JS, and
 * pushed the result as a couple of per-mesh uniforms. This effect has ONE
 * mesh for every active strand, so growth/env/age are instead recomputed
 * here from each vertex's own BAKED strand attributes
 * (lightning-geometry.js#computeLightningStrandArrays) against the ONE
 * shared `uGlobalTimeMs` clock — a hand-transcription of
 * lightning-geometry.js#computeStrandEnvelope's SHAPE (leader growth cubic,
 * restrike sine, decay, connect spike), not a code-shared copy (TSL isn't
 * "the same JS function running on GPU"). Two DELIBERATE divergences from
 * that JS reference, both because a live scene to verify against wasn't
 * available this session and both cheap to tighten later against one:
 *   - A branch's growth mask here rides its OWN leader phase, not its
 *     parent's growth-coupled one (the JS reference's `parentT`/`growthSpeed`
 *     coupling is skipped here) — branches and their parent share the same
 *     `spawnMs`, so the two agree almost everywhere; the difference is a
 *     narrow window while the PARENT is still mid-leader.
 *   - The flicker term uses a noise-based approximation (`simplexFloat` at a
 *     discretized time tick) rather than the JS reference's exact integer
 *     hash — same continuous, deterministic, frame-rate-independent shape,
 *     different bit pattern.
 *
 * `discard()` is called from inside a `Fn(() => {...})()` used to build
 * `material.fragmentNode` — NEVER called procedurally — per the project's own
 * documented trap (region-darkness.js's header: `discard()` called outside a
 * build-time stack context silently compiles to nothing).
 *
 * @module effects/lightning-render
 */

import { createWindHandle } from '../world/index.js';
import { simplexFloat } from './lighting/animations/tsl-noise-toolkit.js';
import { buildDepthHeightGateNode } from './lighting/point-light-illumination.js';

/** Bake-less fallback handle — organic gust/flutter noise only, no baked
 * openness/wall-avoidance field. Mirrors candle-flame-render.js's own
 * TIER0_WIND_HANDLE exactly (see that file's header for why "no baked
 * structure" is the correct degrade, never "no wind at all"). */
const TIER0_WIND_HANDLE = createWindHandle();

/**
 * Build (or refill) the batched strand `BufferGeometry` from
 * `computeLightningStrandArrays`' output. Kept thin so the vertex-array MATH
 * stays in lightning-geometry.js (Node-tested); only the GPU-object glue is
 * here — mirrors `candle-flame-render.js#buildCandleFlameGeometry`.
 *
 * @param {*} THREE
 * @param {ReturnType<typeof import('./lightning-geometry.js').computeLightningStrandArrays>} arrays
 * @returns {*} a `THREE.BufferGeometry`.
 */
const DIRECT_ATTRS = Object.freeze([
  ['position', 'positions', 3],
  ['prevPos', 'prevPos', 3],
  ['nextPos', 'nextPos', 3],
]);

/**
 * Packed groups — [attrName, itemSize, [sourceKeys...]]. Interleaving several
 * separate per-vertex float fields into ONE vec-N attribute is the standard
 * WebGPU technique for staying under the hardware-GUARANTEED
 * `maxVertexBuffers` ceiling of 8.
 *
 * ⚠️ 2026-08-01, caught LIVE via Shader Lab (the exact class of catch that
 * tool exists for — see docs/planning/Shader-Lab.md's own "first real use"):
 * this file's original shape set 12 SEPARATE attributes (3 vec3 + 9 scalar).
 * (`strandBakeB` was widened vec3→vec4 on 2026-08-03 to fold in the height
 * gate's rank field (renamed `expectedDepth` in the 2026-08-05 depth-authority
 * migration — see `lightning-geometry.js#computeLightningStrandArrays`'s own
 * doc) — staying at 6 total buffers rather than opening a 7th.)
 * The real WebGPU render pipeline failed to COMPILE — "Vertex buffer count
 * (12) exceeds the maximum number of vertex buffers (8)" — so the bolt mesh
 * never drew a single pixel, on real hardware, despite every Node test
 * (including the one that constructs this exact material via a real THREE,
 * `lightning-subsystem.test.mjs`) passing green throughout. Graph
 * CONSTRUCTION succeeds in Node; only pipeline COMPILATION, which needs a
 * real adapter, fails — Node alone can never catch this class of bug.
 *
 * 6 buffers total today (3 direct + 3 packed) — real headroom under 8, but
 * never add a 7th separate attribute here without folding it into one of
 * these groups or opening a deliberate new one.
 */
const PACKED_ATTRS = Object.freeze([
  ['sideUv', 2, ['side', 'uvOffset']],
  ['strandBakeA', 4, ['spawnMs', 'durationMs', 'seed', 'leaderFrac']],
  ['strandBakeB', 4, ['restrikeCount', 'baseIntensity', 'widthScale', 'expectedDepth']],
]);

/** Interleave `keys.length` same-length source arrays into one packed
 * Float32Array (stride `itemSize`) — reuses `existing` in place when it's
 * already big enough (the same "mutate the same buffer, don't reallocate"
 * discipline this file's whole refill path exists for), else allocates. */
function interleaveInto(arrays, keys, itemSize, existing) {
  const n = arrays[keys[0]].length;
  const need = n * itemSize;
  const dst = existing && existing.length >= need ? existing : new Float32Array(need);
  for (let v = 0; v < n; v++) {
    const base = v * itemSize;
    for (let k = 0; k < itemSize; k++) dst[base + k] = arrays[keys[k]][v];
  }
  return dst;
}

export function buildLightningGeometry(THREE, arrays) {
  const geometry = new THREE.BufferGeometry();
  for (const [attrName, arrayKey, itemSize] of DIRECT_ATTRS) {
    geometry.setAttribute(attrName, new THREE.BufferAttribute(arrays[arrayKey], itemSize));
  }
  for (const [attrName, itemSize, keys] of PACKED_ATTRS) {
    geometry.setAttribute(attrName, new THREE.BufferAttribute(interleaveInto(arrays, keys, itemSize), itemSize));
  }
  geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  geometry.setDrawRange(0, arrays.indexCount);
  return geometry;
}

/**
 * Refill an EXISTING geometry's attributes/index in place (reuse discipline —
 * same "mutate the same buffer, flag needsUpdate" contract point-light-
 * pool.js's own header documents the device-lost reason for). Only grows a
 * BufferAttribute (new array + new attribute object) when this frame's
 * vertex/index count exceeds the geometry's current capacity.
 *
 * @param {*} THREE @param {*} geometry - a geometry built by {@link buildLightningGeometry}.
 * @param {ReturnType<typeof import('./lightning-geometry.js').computeLightningStrandArrays>} arrays
 */
export function refillLightningGeometry(THREE, geometry, arrays) {
  for (const [attrName, arrayKey, itemSize] of DIRECT_ATTRS) {
    const array = arrays[arrayKey];
    const attr = geometry.getAttribute(attrName);
    if (attr && attr.array.length >= array.length) {
      attr.array.set(array);
      attr.needsUpdate = true;
    } else {
      geometry.setAttribute(attrName, new THREE.BufferAttribute(array, itemSize));
    }
  }
  for (const [attrName, itemSize, keys] of PACKED_ATTRS) {
    const attr = geometry.getAttribute(attrName);
    const packed = interleaveInto(arrays, keys, itemSize, attr ? attr.array : null);
    if (attr && attr.array === packed) {
      attr.needsUpdate = true; // reused in place
    } else {
      geometry.setAttribute(attrName, new THREE.BufferAttribute(packed, itemSize));
    }
  }
  const idx = geometry.getIndex();
  if (idx && idx.array.length >= arrays.indices.length) {
    idx.array.set(arrays.indices);
    idx.needsUpdate = true;
  } else {
    geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  }
  geometry.setDrawRange(0, arrays.indexCount);
}

/**
 * Build the batched strand ribbon's TSL material. Live uniforms (colour,
 * brightness, width, taper, glow, detail, drift strength) are created here
 * and returned for the caller to drive every frame — the same "uniforms out,
 * .value per frame" contract candle's `buildCandleFlameMaterial` uses.
 *
 * @param {{THREE:*, uGlobalTimeMs:*, quality?:number, windHandle?:object, depthTexNode?:*, depthFlagsTexNode?:*}} args
 *   `quality` (default 2) graph-build-time gates the core-static crackle term
 *   (Effects.md Law 4: a tier that's off must never be constructed) — below 2
 *   skips constructing it entirely, never just multiplies it by zero.
 *   `depthTexNode`/`depthFlagsTexNode` — `buf:scene.depth`, UNSAMPLED — wires
 *   the SAME depth-authority occlusion gate a point light uses
 *   (`point-light-illumination.js#buildDepthHeightGateNode`; 2026-08-05
 *   migration from the OLD `buf:scene.attr`/`buildHeightGateNode` mechanism —
 *   candle's own flame sprite is still on that OLD mechanism, deliberately
 *   out of scope here). Omit both for a bolt that ignores floor occlusion
 *   entirely (byte-identical pre-gate behaviour, e.g. Shader Lab).
 * @returns {{material:*, uniforms: Record<string, *>}}
 */
export function buildLightningMaterial({
  THREE,
  uGlobalTimeMs,
  quality = 2,
  windHandle = TIER0_WIND_HANDLE,
  depthTexNode,
  depthFlagsTexNode,
}) {
  const {
    Fn,
    uniform,
    attribute,
    vec2,
    vec3,
    vec4,
    float,
    length,
    dot,
    clamp,
    smoothstep,
    mix,
    max,
    min,
    abs,
    pow,
    sin,
    exp,
    normalize,
    screenUV,
  } = THREE.TSL;

  const uWidth = uniform(float(30));
  const uTaper = uniform(float(0.08));
  const uBrightness = uniform(float(5));
  const uGlowStrength = uniform(float(5));
  const uTextureScrollSpeed = uniform(float(25));
  const uCoreStaticAmount = uniform(float(1));
  const uCoreStaticRange = uniform(float(0.85));
  const uWindDriftStrength = uniform(float(0));
  const uOuterColor = uniform(vec3(0, 0.2144, 1));
  const uCoreColor = uniform(vec3(1, 1, 1));
  const uFlickerChance = uniform(float(0.15));

  const prevPos = attribute('prevPos', 'vec3');
  const nextPos = attribute('nextPos', 'vec3');
  // Packed vertex attributes (see lightning-render.js's own PACKED_ATTRS
  // header — 3 vec3 + 3 packed groups stays under WebGPU's 8-vertex-buffer
  // ceiling; 9 separate scalar attributes did not). Swizzled back out to the
  // same names every downstream expression in this file already expects.
  const sideUv = attribute('sideUv', 'vec2');
  const side = sideUv.x;
  const uvOffset = sideUv.y;
  const strandBakeA = attribute('strandBakeA', 'vec4');
  const strandSpawnMs = strandBakeA.x;
  const strandDurationMs = strandBakeA.y;
  const strandSeed = strandBakeA.z;
  const strandLeaderFrac = strandBakeA.w;
  const strandBakeB = attribute('strandBakeB', 'vec4');
  const strandRestrikeCount = strandBakeB.x;
  const strandBaseIntensity = strandBakeB.y;
  const strandWidthScale = strandBakeB.z;
  const strandExpectedDepth = strandBakeB.w;

  /** Cubic smoothstep of an already-clamped-at-0 ratio — the shader twin of
   * lightning-geometry.js's own `smooth01`. */
  const smooth01 = (ratio) => {
    const c = clamp(ratio, float(0), float(1));
    return c.mul(c).mul(float(3).sub(c.mul(float(2))));
  };

  // ── VARYINGS — vertex-stage reads, carried to the fragment stage. Simple
  // attribute forwards/short expressions need no Fn() wrapper (TSL infers the
  // vertex stage from what each node reads); only positionNode/fragmentNode
  // below need one, for their select()/discard() build-context requirements. ──
  const vT = clamp(uGlobalTimeMs.sub(strandSpawnMs).div(max(strandDurationMs, float(1))), float(0), float(1)).toVarying(
    'vLightningT'
  );
  const vAlong = uvOffset.toVarying('vLightningAlong');
  const vSide = side.toVarying('vLightningSide');
  const vSeed = strandSeed.toVarying('vLightningSeed');
  const vLeaderFrac = strandLeaderFrac.toVarying('vLightningLeaderFrac');
  const vRestrikeCount = strandRestrikeCount.toVarying('vLightningRestrikeCount');
  const vBaseIntensity = strandBaseIntensity.toVarying('vLightningBaseIntensity');
  const vExpectedDepth = strandExpectedDepth.toVarying('vLightningExpectedDepth');

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;

  // ── VERTEX STAGE — world-space miter-join ribbon expansion + real wind drift ──
  material.positionNode = Fn(() => {
    const t = clamp(uGlobalTimeMs.sub(strandSpawnMs).div(max(strandDurationMs, float(1))), float(0), float(1));

    const cur = attribute('position', 'vec3');
    let dirPrev = cur.xy.sub(prevPos.xy);
    let dirNext = nextPos.xy.sub(cur.xy);
    const prevLen = length(dirPrev);
    const nextLen = length(dirNext);
    dirPrev = prevLen.lessThan(float(1e-6)).select(dirNext, dirPrev);
    dirNext = nextLen.lessThan(float(1e-6)).select(dirPrev, dirNext);
    dirPrev = normalize(dirPrev);
    dirNext = normalize(dirNext);

    const nPrev = vec2(dirPrev.y.negate(), dirPrev.x);
    const nNext = vec2(dirNext.y.negate(), dirNext.x);
    let miter = nPrev.add(nNext);
    const miterLen = length(miter);
    miter = miterLen.lessThan(float(1e-3)).select(nNext, miter.div(max(miterLen, float(1e-6))));
    const denom = max(float(0.25), abs(dot(miter, nNext)));
    const miterScale = min(float(2.25), float(1).div(denom));
    const normal = miter.mul(miterScale);

    let taperT = pow(uvOffset, max(uTaper, float(0.001)));
    taperT = taperT.mul(taperT).mul(float(3).sub(taperT.mul(float(2))));
    const taperWidth = mix(float(1), float(0.12), taperT);
    const ageScale = mix(float(1.55), float(0.22), t);
    const w = max(uWidth.mul(strandWidthScale).mul(taperWidth).mul(ageScale), float(1));

    let world = cur.xy.add(normal.mul(side).mul(w));

    // WIND DRIFT — the REAL shared wind field (a genuine V3-only capability;
    // V2 faked this with a random per-strike direction), gated to AFTER the
    // return stroke connects and stronger toward the tip (V2's own
    // `windT = max(0, uStrikeAge01)` × `uvOffset` timing), off by default
    // (`uWindDriftStrength` defaults to 0, V2's own default).
    const gust = windHandle.node(THREE.TSL, { centerXY: cur.xy, time: uGlobalTimeMs, exposure: float(1) });
    const windT = max(float(0), t).mul(uvOffset);
    world = world.add(gust.mul(uWindDriftStrength).mul(windT).mul(float(40)));

    return vec3(world.x, world.y, float(0));
  })();

  // ── FRAGMENT STAGE — envelope brightness, growth-reveal discard, outer/core
  // glow bands, procedural plasma + (tier-gated) core-static crackle. ──
  material.fragmentNode = Fn(() => {
    const t = vT;
    const leaderFrac = max(vLeaderFrac, float(0.08));
    const growth = smooth01(t.div(leaderFrac));
    const nowS = uGlobalTimeMs.mul(float(0.001));

    // ⚠️ 2026-08-01, LIVE BUG (author: "a branch will appear entirely black,
    // then fill in" / "Bloom blacks out the area in pure black squares") —
    // ROOT CAUSE, reproduced directly against this exact `mx_noise_float`
    // call: `vSeed` carries the strand's raw baked uint32 seed AS-IS (up to
    // ~4.29e9 — lightning-geometry.js's own seeds are full-range hashes, no
    // different from `hashStringToSeed`'s output anywhere else in this
    // effect). Fed straight into a noise coordinate, that magnitude measurably
    // breaks `mx_noise_float`: verified live, `mx_noise_float(vec2(3502423040
    // + 0.618, 0.382))` returns NaN while the identical call with `12345.6`
    // returns a real value. NaN then poisons the WHOLE additively-blended
    // fragment (both flickerMul() calls below run for every fragment, in
    // both envelope branches) — a strand's own seed decided, per burst,
    // whether it rendered at all, which is exactly the "sometimes" the
    // author reported. Independent of Bloom entirely: the NaN lands in
    // scene.lit before Bloom ever reads it; Bloom's blur/downsample chain
    // only SPREADS one already-NaN pixel into the visible blocky region
    // ("pure black squares") — see keyhole-vertex-buffer-limit-fix.md's
    // sibling memory note for the full mechanism.
    //
    // Fix: normalize to a SMALL, noise-safe magnitude before use — the exact
    // same pattern lightning-geometry.js's own JS-side flicker already uses
    // (`seedToUnitFloat(strand.seed) * 41.3`, computeOriginFlashVisualMul) —
    // never feed a raw hash/seed integer into a trig-based noise coordinate.
    const seedPhase = vSeed.mul(float(1 / 4294967296)).mul(float(100));

    /** Deterministic, continuous flicker approximation — see this file's own
     * header for why it is not bit-identical to lightning-geometry.js's
     * flickerMultiplier (an exact integer hash, not shader-friendly here). */
    const flickerMul = (tickHz, loMul, hiMul, salt) => {
      const tick = nowS.mul(float(tickHz)).floor();
      const roll = simplexFloat(
        THREE.TSL,
        vec2(seedPhase.add(float(salt)).add(tick.mul(float(0.618))), tick.mul(float(0.382)))
      )
        .mul(float(0.5))
        .add(float(0.5));
      const depth = simplexFloat(
        THREE.TSL,
        vec2(seedPhase.add(float(salt + 91.7)).add(tick.mul(float(0.382))), tick.mul(float(0.618)))
      )
        .mul(float(0.5))
        .add(float(0.5));
      return roll.greaterThanEqual(uFlickerChance).select(float(1), mix(float(loMul), float(hiMul), depth));
    };

    const leaderEnv = float(0.05)
      .add(float(0.16).mul(t.div(leaderFrac)))
      .mul(flickerMul(20, 0.2, 0.85, 0));
    const postT = clamp(t.sub(leaderFrac).div(max(float(1).sub(leaderFrac), float(0.001))), float(0), float(1));
    const restrikes = max(float(0), sin(postT.mul(vRestrikeCount).mul(float(Math.PI))));
    const decay = pow(max(float(0), float(1).sub(postT)), float(2));
    const connectSpike = exp(postT.mul(float(-28))).mul(float(1.75));
    let postEnv = max(restrikes.mul(decay), connectSpike);
    postEnv = max(postEnv, decay.mul(float(0.1)));
    postEnv = postEnv.mul(flickerMul(20, 0.75, 1.0, 1));
    const env = t.lessThan(leaderFrac).select(leaderEnv, postEnv);
    // V2's own `uIntensity` = envelope.env * strike.baseIntensity — a branch's
    // reduced intensity (lightning-geometry.js#generateBurst's
    // `branchIntensityScale`) and a source's own emission-intensity floor
    // both ride on this, not just the raw envelope shape.
    const intensity = env.mul(vBaseIntensity);

    // Growth-reveal mask — the "leader searching downward" visual. MUST be
    // discard()ed from here, inside this Fn() — see the module header.
    const growthMask = float(1).sub(smoothstep(growth.sub(float(0.035)), growth.add(float(0.008)), vAlong));
    growthMask.lessThanEqual(float(0.001)).discard();

    const uvY = vSide.mul(float(0.5)).add(float(0.5));
    const yAbs = abs(uvY.sub(float(0.5))).mul(float(2));
    const aa = float(0.02); // a fixed anti-alias band — no cross-backend fwidth() dependency
    const outer = float(1).sub(smoothstep(float(1).sub(aa), float(1).add(aa), yAbs));
    const core = float(1).sub(
      smoothstep(float(0.55).sub(aa.mul(float(0.5))), float(0.55).add(aa.mul(float(0.5))), yAbs)
    );

    // PROCEDURAL NOISE, not V2's tiny hand-rolled CanvasTexture — see the
    // module header / this effect's design doc for why coherent Perlin
    // (plasma glow) + cellular Worley (core-static crackle) are the better
    // substitutes for the two different jobs V2's one white-noise texture did.
    const scrollT = nowS.mul(uTextureScrollSpeed);
    const plasmaRaw = simplexFloat(
      THREE.TSL,
      vec2(vAlong.mul(float(2.5)).add(scrollT.mul(float(0.1))), uvY.mul(float(1.25)))
    )
      .mul(float(0.5))
      .add(float(0.5));
    const plasma = clamp(plasmaRaw.mul(float(1.25)), float(0), float(1));

    const vTipFade = float(1).sub(smoothstep(float(0.62), float(1), vAlong));

    let alpha = outer.mul(float(0.35).add(float(0.65).mul(plasma)));
    alpha = alpha.mul(intensity);
    alpha = alpha.mul(vTipFade);
    alpha = alpha.mul(growthMask);
    alpha = alpha.mul(mix(float(0.45), float(1), growth));

    // ============================================================================
    // THE DEPTH-AUTHORITY OCCLUSION GATE (2026-08-05 — migrated from the OLD
    // buf:scene.attr/buildHeightGateNode mechanism, still described in this
    // file's own git history, to the SAME depth authority a point light
    // already uses live — point-light-illumination.js#buildDepthHeightGateNode,
    // the project's sole occlusion/rank system, see
    // keyhole-depth-authority-sole-system-decision). Multiplied into ALPHA
    // (not just rgb): this material is AdditiveBlending, so an un-gated alpha
    // would keep punching a lit value into the scene even with colour zeroed
    // elsewhere (`feedback_blend_neutral_element_is_per_blend`).
    //
    // ⚠️ `screenUV`, never the bare node — `buf:scene.depth` is SCREEN-space
    // and this is a WORLD-space ribbon mesh with no meaningful mesh uv of its
    // own (`feedback_shared_texture_node_carries_the_wrong_uv`). Lightning's
    // own draw uses the SAME shared world camera the depth-authority write
    // pass frames against (`scene-depth.js#computeCameraFrustum`), which is
    // what keeps this screenUV sample indexing the right world position —
    // confirmed by reading that module directly, not assumed.
    //
    // `vExpectedDepth` is a per-STRAND varying (`generateBurst`'s own doc for
    // why: a branch inherits its parent's floor, a fresh strike gets its own),
    // never a uniform — this mesh batches every active strand into one draw.
    // A JS-time branch: with no `depthTexNode` this material is byte-identical
    // to before the gate existed.
    if (depthTexNode) {
      const depthHere = depthTexNode.sample(screenUV);
      const flagsHere = depthFlagsTexNode ? depthFlagsTexNode.sample(screenUV) : null;
      alpha = alpha.mul(
        buildDepthHeightGateNode(THREE.TSL, {
          depthHere,
          flagsHere,
          uLightExpectedDepth: vExpectedDepth,
        })
      );
    }

    let col = mix(uOuterColor, uCoreColor, core);
    col = mix(col, vec3(1, 1, 1), smoothstep(float(0.55), float(1), intensity));
    col = mix(col, uOuterColor, smoothstep(float(0.35), float(1), t).mul(float(0.85)));
    let rgb = col.mul(uBrightness).mul(uGlowStrength);

    if (quality >= 2) {
      const staticRange = max(float(0.05), uCoreStaticRange);
      const coreZone = float(1).sub(smoothstep(float(0), staticRange, vAlong));
      const staticA = clamp(
        simplexFloat(
          THREE.TSL,
          vec2(vAlong.mul(float(22)).add(scrollT.mul(float(1.1))), uvY.mul(float(10)).add(scrollT.mul(float(0.76))))
        )
          .mul(float(0.5))
          .add(float(0.5)),
        float(0),
        float(1)
      );
      const staticB = clamp(
        simplexFloat(
          THREE.TSL,
          vec2(vAlong.mul(float(31)).sub(scrollT.mul(float(0.84))), uvY.mul(float(14)).sub(scrollT.mul(float(0.52))))
        )
          .mul(float(0.5))
          .add(float(0.5)),
        float(0),
        float(1)
      );
      let crackle = clamp(staticA.mul(staticB).mul(float(2.35)), float(0), float(1));
      crackle = pow(crackle, float(2.8)).mul(coreZone).mul(core);
      const gate = uCoreStaticAmount
        .greaterThan(float(0.001))
        .and(coreZone.greaterThan(float(0.001)))
        .and(core.greaterThan(float(0.001)));
      const crackleGated = gate.select(crackle, float(0));
      rgb = rgb.mul(float(1).add(crackleGated.mul(uCoreStaticAmount).mul(float(1.65))));
      alpha = alpha.mul(float(1).add(crackleGated.mul(uCoreStaticAmount).mul(float(0.45))));
    }

    return vec4(rgb, alpha);
  })();

  return {
    material,
    uniforms: {
      uWidth,
      uTaper,
      uBrightness,
      uGlowStrength,
      uTextureScrollSpeed,
      uCoreStaticAmount,
      uCoreStaticRange,
      uWindDriftStrength,
      uOuterColor,
      uCoreColor,
      uFlickerChance,
    },
  };
}
