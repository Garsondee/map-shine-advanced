/**
 * FIRE — THE BILLOW RENDERER (2026-10-20). TSL graphs and the render-target lifecycle for
 * `fire-billow-geometry.js`'s lobes. THREE is INJECTED (`effects/` may not import the vendor bundle's renderer).
 *
 * ============================================================================
 * THE PIPELINE: PARTICLES -> FIELD -> CONTOUR
 * ============================================================================
 *
 * 1. SPLAT. Every lobe is an instanced quad whose fragment writes the lobe's kernel into a half-float FIELD with
 *    plain additive blending. Two fields: the FLAME field (R = flame density, G = heat-weighted density,
 *    B = coal density, A = coal heat-weighted density) and the SMOKE field (R = density, G = tone-weighted density).
 *    Order-independent, so lobes can be drawn in any order and nothing pops: a lobe enters by growing from radius 0.
 * 2. CONTOUR. Instanced quads (one per fire box) read the fields and turn them into the painted look: the flame's
 *    silhouette is the iso-contour of the density, the tone bands are the overlap count (cream where the most
 *    billows stack), crescents ride each puff's edge, the coal bed glows through cracked cells, smoke is soft
 *    warm-white billows lit by the scene.
 *
 * THE FLAME KERNEL IS A PLATEAU, NOT A BUMP. Each billow adds a flat +strength inside its own edge, so the SUM counts
 * how many billows overlap a pixel. The contour of that sum is the UNION of the discs (a cartoon cloud: crisp cusps,
 * never a metaball's liquid fillets), the tone steps are the overlap count (translucent daubs stacked, every billow's
 * own outline showing inside the flame — the painted campfires exactly), and the edge crescents ride each disc's own
 * rim. The first version used a soft bump and read as orange slime.
 *
 * ⚠️ THE FIELDS ARE WORLD-RECT ALIGNED, NOT SCREEN ALIGNED. They cover the rect `sync()` is given (the visible
 * world, which every other engine here also takes), sized to the drawing buffer's pixel density, so they do not
 * care about the camera's jitter or the viewport's shape, and the contour reads them by world position.
 *
 * ⚠️ ORIENTATION OF THE FIELD TEXTURE IS CALIBRATED IN THE LAB (`fire-billow-lab.js#calibrate`), NEVER ASSUMED.
 *
 * ⚠️ THIS FILE NEVER TOUCHES THE RENDERER'S STATE OR ALLOCATES A TARGET, and that is a wall, not a style
 * (`renderer-state/graph-only`, `gpu/allocator-only`, tools/verify-structure.mjs). The field targets come from an
 * INJECTED `createTarget(name, w, h)` (the allocator, defined in `vt/`), and the splat is handed back as a declarative
 * job list — `prepareField()` returns `[{target, scene, camera, count}]` and `vt-pan-viewer.js`'s `tickFireField`
 * does the `setRenderTarget`/`clear`/`render`, exactly as `fluid-surface-subsystem.js#prepareSimTick` hands
 * `tickFluidSim` its job list.
 *
 * @module effects/fire/fire-billow-render
 */
import { BILLOW_FLAME_RAMP, BILLOW_SMOKE_RAMP, BILLOW_FLECK_HEX, LOBE_STRIDE } from './fire-billow-geometry.js';
import { BLOOM_SOLVE_STEPS } from './fire-billow-bloom.js';
import { hexToRgb01 } from './fire-geometry.js';
import { piecewiseLinearRgb, hueRotateNode } from './fire-sprite.js';

/** sRGB (0..1) -> linear, the exact IEC 61966-2-1 curve. */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** A hex colour as LINEAR 0..1 rgb. */
export function hexToLinear(hex) {
  const c = hexToRgb01(hex) ?? [1, 1, 1];
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

/** The flame ramp as ASCENDING linear-rgb stops (what `piecewiseLinearRgb` wants). */
export function billowRampStops() {
  return [...BILLOW_FLAME_RAMP].map((s) => ({ t: s.t, rgb: hexToLinear(s.hex) })).sort((a, b) => a.t - b.t);
}

/** Defaults for every look uniform. The lab overrides any of them; the engine maps the author's dials onto them. */
export const BILLOW_LOOK = Object.freeze({
  /** Density level of the silhouette (each billow adds ~1 inside its edge, so 0.5 = the union of the discs). */
  outline: 0.5,
  /** Density above the outline at which the tone reaches the cream core. */
  span: 8.2,
  /** How much of the tone follows heat rather than density (0 = pure density). */
  toneHeat: 0.63,
  /** Tone gamma: < 1 lifts the whole flame toward the cream end. */
  tonePow: 0.84,
  /** Levels on the tone (0..1): stretches it so the middle really reaches the cream stop. */
  toneLo: 0.03,
  toneHi: 0.8,
  /** 0 = smooth photographic ramp .. 1 = hard cel bands. */
  posterize: 0.62,
  bandCount: 5,
  /** The splat kernel: flat inside `plateau` of the radius, falling to 0 at the rim, with a slight `dome`. */
  plateau: 0.8,
  dome: 0.37,
  /** How much cooler a disc is at its rim than its middle (0..1): a soft gradient inside every puff. */
  discGradient: 0.555,
  /** The flame's minimum edge softness, in density units (0.012 = razor, 0.1 = painted gouache). */
  edgeSoft: 0.08,
  /** Painterly roughness of the edge: px of noise warp, and the noise's spatial frequency (1/px); two octaves. */
  warpPx: 2.6,
  warpFreq: 0.05,
  warpSpeed: 0.7,
  warpPx2: 1.1,
  warpFreq2: 0.15,
  /** Painterly mottling of the tone (noise added to the temperature). */
  mottle: 0.1,
  mottleFreq: 0.07,
  /** The cel-shaded crescents: how steeply the density surface tilts the normal, and how far a lit/shaded flank moves the tone. */
  relief: 2.6,
  crescent: 0.06,
  /** Faint halo around the flame (HDR, additive: feeds the bloom). */
  glow: 0.35,
  glowRadiusPx: 14,
  /** Emission multiplier on the flame colours (1 = the painted colours exactly). */
  emission: 1.0,
  /** The coal bed: its glow strength, the cracked cells' size (1/px) and crack width. */
  coalGain: 1.0,
  coalCell: 0.16,
  coalCrack: 0.22,
  /** Smoke. */
  smokeOutline: 0.3,
  smokeSoft: 0.2,
  smokeOpacity: 0.92,
  smokeSoot: 0.0,
  /** Shading light direction (screen space, up-left). */
  lightX: -0.55,
  lightY: -0.55,
});

/**
 * @param {object} deps
 * @param {*} deps.THREE
 * @param {(name:string, w:number, h:number) => *} deps.createTarget half-float RGBA, linear, no depth: `allocator.create(...)`
 * @param {(rt:*) => void} [deps.disposeTarget] `allocator.dispose(rt)`
 * @param {number} [deps.flameCapacity=6144] flame + coal lobes
 * @param {number} [deps.smokeCapacity=2048]
 * @param {number} [deps.maxQuads=64] contour boxes (one per fire)
 * @param {object} [deps.lighting] `{illumTexNode, colorationTexNode}`: the scene's own light on the SMOKE (the flame is
 *   emissive and ignores it). Without it the smoke is lit by `uAmbient` alone.
 * @param {object} [deps.depth] `{depthTexNode, depthFlagsTexNode, buildGate}` the occlusion gate every post-lit draw uses.
 * @param {boolean} [deps.flipV=false] field texture orientation, from the lab's calibration.
 * @returns {object}
 */
export function createBillowRenderer({
  THREE,
  createTarget,
  disposeTarget = null,
  flameCapacity = 6144,
  smokeCapacity = 2048,
  maxQuads = 64,
  lighting = null,
  depth = null,
  flipV = false,
}) {
  if (typeof createTarget !== 'function') {
    throw new TypeError(
      'createBillowRenderer: `createTarget(name, w, h)` is required (the allocator, injected — see this module header).'
    );
  }
  const TSL = THREE.TSL;
  const {
    Fn,
    attribute,
    uniform,
    float,
    vec2,
    vec3,
    vec4,
    mix,
    clamp,
    smoothstep,
    positionGeometry,
    texture,
    dot,
    sqrt,
    pow,
    max,
    min,
    floor,
    fract,
    normalize,
    length,
    sin,
    select,
    mx_noise_float,
    screenUV,
    sRGBTransferEOTF,
    sRGBTransferOETF,
  } = TSL;

  // ── the two field targets ─────────────────────────────────────────────────────────────────────
  let fieldW = 64;
  let fieldH = 64;
  let flameField = createTarget('fire.flame', fieldW, fieldH);
  let smokeField = createTarget('fire.smoke', fieldW, fieldH);
  const flameNode = texture(flameField.texture);
  const smokeNode = texture(smokeField.texture);

  // ── instance data: three vec4 attributes per lobe, two buffers ────────────────────────────────
  const makeLobeGeometry = (capacity) => {
    const array = new Float32Array(capacity * LOBE_STRIDE);
    const geometry = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.attributes.position);
    geometry.setAttribute('uv', quad.attributes.uv);
    const interleaved = new THREE.InstancedInterleavedBuffer(array, LOBE_STRIDE, 1);
    interleaved.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('lobeA', new THREE.InterleavedBufferAttribute(interleaved, 4, 0));
    geometry.setAttribute('lobeB', new THREE.InterleavedBufferAttribute(interleaved, 4, 4));
    geometry.setAttribute('lobeC', new THREE.InterleavedBufferAttribute(interleaved, 4, 8));
    geometry.instanceCount = 0;
    return { array, geometry, interleaved };
  };
  const fCap = Math.max(16, flameCapacity | 0);
  const sCap = Math.max(16, smokeCapacity | 0);
  const flameBuf = makeLobeGeometry(fCap);
  const smokeBuf = makeLobeGeometry(sCap);

  // ── uniforms ──────────────────────────────────────────────────────────────────────────────────
  const num = (k) => uniform(float(BILLOW_LOOK[k]));
  const U = {
    rectMin: uniform(vec2(0, 0)),
    rectSize: uniform(vec2(1, 1)),
    texel: uniform(vec2(1, 1)),
    time: uniform(float(0)),
    outline: num('outline'),
    span: num('span'),
    toneHeat: num('toneHeat'),
    tonePow: num('tonePow'),
    toneLo: num('toneLo'),
    toneHi: num('toneHi'),
    posterize: num('posterize'),
    bandCount: num('bandCount'),
    plateau: num('plateau'),
    dome: num('dome'),
    discGradient: num('discGradient'),
    edgeSoft: num('edgeSoft'),
    warpPx: num('warpPx'),
    warpFreq: num('warpFreq'),
    warpSpeed: num('warpSpeed'),
    warpPx2: num('warpPx2'),
    warpFreq2: num('warpFreq2'),
    mottle: num('mottle'),
    mottleFreq: num('mottleFreq'),
    relief: num('relief'),
    crescent: num('crescent'),
    glow: num('glow'),
    glowRadiusPx: num('glowRadiusPx'),
    emission: num('emission'),
    coalGain: num('coalGain'),
    coalCell: num('coalCell'),
    coalCrack: num('coalCrack'),
    smokeOutline: num('smokeOutline'),
    smokeSoft: num('smokeSoft'),
    smokeOpacity: num('smokeOpacity'),
    smokeSoot: num('smokeSoot'),
    light: uniform(vec2(BILLOW_LOOK.lightX, BILLOW_LOOK.lightY)),
    hue: uniform(float(0)),
    tint: uniform(vec3(1, 1, 1)),
    ambient: uniform(vec3(1, 1, 1)),
    expectedDepth: uniform(float(0)),
  };

  // ── 1. THE SPLATS ───────────────────────────────────────────────────────────────────────────────
  const lobeA = attribute('lobeA', 'vec4'); // x, y, radius, strength
  const lobeB = attribute('lobeB', 'vec4'); // heat, along, dirX, dirY
  const lobeC = attribute('lobeC', 'vec4'); // kind, tone, across, z

  const splatVertex = Fn(() => {
    const corner = positionGeometry.xy.mul(2);
    const dir = vec2(lobeB.z, lobeB.w);
    const nrm = vec2(dir.y.negate(), dir.x);
    // B.y = the length scale along the lobe's direction, C.z = the width scale across it (set by the model)
    const along = max(lobeB.y, float(1));
    const across = max(lobeC.z, float(0.2));
    const off = dir.mul(corner.x.mul(lobeA.z).mul(along)).add(nrm.mul(corner.y.mul(lobeA.z).mul(across)));
    return vec3(lobeA.x.add(off.x), lobeA.y.add(off.y), float(0));
  });
  const vLocal = Fn(() => positionGeometry.xy.mul(2))().toVarying('vBillowLocal');
  const vData = Fn(() => vec4(lobeA.w, lobeB.x, lobeC.x, lobeC.y))().toVarying('vBillowData');
  const applySplatState = (material) => {
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.toneMapped = false;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendEquationAlpha = THREE.AddEquation;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneFactor;
  };

  // FLAME + COAL: a plateau with a slight dome. kind 0 = flame, 2 = coal (its own channels).
  const flameSplat = new THREE.NodeMaterial();
  flameSplat.positionNode = splatVertex();
  flameSplat.fragmentNode = Fn(() => {
    const qd = sqrt(dot(vLocal, vLocal));
    const k = float(1)
      .sub(smoothstep(U.plateau, float(1), qd))
      .mul(float(1).sub(U.dome.mul(qd.mul(qd))));
    const w = vData.x.mul(k);
    const isCoal = select(vData.z.greaterThan(1.5), float(1), float(0));
    const flame = float(1).sub(isCoal);
    // each puff is hotter at its middle than at its rim: a soft gradient inside every disc
    const radialHeat = float(1).sub(U.discGradient.mul(qd.mul(qd)));
    return vec4(w.mul(flame), w.mul(vData.y).mul(radialHeat).mul(flame), w.mul(isCoal), w.mul(vData.y).mul(isCoal));
  })();
  applySplatState(flameSplat);

  // SMOKE: a soft bump (painted smoke is airy; a hard plateau made it chunky).
  const smokeSplat = new THREE.NodeMaterial();
  smokeSplat.positionNode = splatVertex();
  smokeSplat.fragmentNode = Fn(() => {
    const qd2 = dot(vLocal, vLocal);
    const k0 = max(float(1).sub(qd2), float(0));
    const w = vData.x.mul(k0).mul(k0);
    // B carries the STEAM weight (a doused fire's smoke is wet: whiter, denser)
    return vec4(w, w.mul(vData.w), w.mul(vData.y), float(0));
  })();
  applySplatState(smokeSplat);

  const flameMesh = new THREE.Mesh(flameBuf.geometry, flameSplat);
  flameMesh.frustumCulled = false;
  const smokeMesh = new THREE.Mesh(smokeBuf.geometry, smokeSplat);
  smokeMesh.frustumCulled = false;
  const flameScene = new THREE.Scene();
  flameScene.add(flameMesh);
  const smokeScene = new THREE.Scene();
  smokeScene.add(smokeMesh);
  const splatCamera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);

  // ── 2. THE CONTOUR ──────────────────────────────────────────────────────────────────────────────
  const rampStops = billowRampStops();
  const lin = (hex) => {
    const c = hexToLinear(hex);
    return vec3(c[0], c[1], c[2]);
  };
  const smokeHi = lin(BILLOW_SMOKE_RAMP.highlight);
  const smokeMid = lin(BILLOW_SMOKE_RAMP.mid);
  const smokeShade = lin(BILLOW_SMOKE_RAMP.shade);
  const smokeDeep = lin(BILLOW_SMOKE_RAMP.deep);
  const smokeLit = lin(BILLOW_SMOKE_RAMP.lit);
  const smokeSootC = lin(BILLOW_SMOKE_RAMP.soot);
  const flipUV = (p) => (flipV ? vec2(p.x, float(1).sub(p.y)) : p);
  const dirY = (v) => (flipV ? v.negate() : v);

  // contour boxes: one instanced quad per fire (`quadFill` = how much of the scene's bloom a flame this big on screen gets)
  const quadBoxes = new Float32Array(maxQuads * 4);
  const quadFills = new Float32Array(maxQuads);
  const resolveGeometry = new THREE.InstancedBufferGeometry();
  {
    const quad = new THREE.PlaneGeometry(1, 1);
    resolveGeometry.index = quad.index;
    resolveGeometry.setAttribute('position', quad.attributes.position);
    resolveGeometry.setAttribute('uv', quad.attributes.uv);
    const attr = new THREE.InstancedBufferAttribute(quadBoxes, 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    resolveGeometry.setAttribute('quadBox', attr);
    const fillAttr = new THREE.InstancedBufferAttribute(quadFills, 1);
    fillAttr.setUsage(THREE.DynamicDrawUsage);
    resolveGeometry.setAttribute('quadFill', fillAttr);
    resolveGeometry.instanceCount = 0;
  }
  const quadBox = attribute('quadBox', 'vec4');
  const quadFill = attribute('quadFill', 'float');
  const resolveMaterial = new THREE.NodeMaterial();
  const worldAt = Fn(() => quadBox.xy.add(positionGeometry.xy.add(vec2(0.5, 0.5)).mul(quadBox.zw)))();
  const vWorld = worldAt.toVarying('vBillowWorld');
  const vFill = Fn(() => quadFill)().toVarying('vBillowFill');
  resolveMaterial.positionNode = Fn(() => vec3(worldAt, float(0)))();

  // THE BLOOM COUNTER (fire-billow-bloom.js): the scene's bloom adds its glow on top of the flame, so the flame paints the
  // INVERSE of it — for a wanted colour T with max channel `brT`, the scale `s` that solves s * (1 + K * fill * contribution(s *
  // brT)) = 1 — and the bloom hands T back. Four uniforms (K = 0 means no bloom: s is exactly 1) and nine unrolled bisection
  // steps; NOT a lookup texture (`gpu/textures-in-vt-only`). `inverseBloomScale` is the same algorithm in plain numbers.
  const bloomK = uniform(float(0));
  const bloomThr = uniform(float(1));
  const bloomKnee = uniform(float(0.5));
  const bloomMix = uniform(float(0));
  const bloomScale = (brT, fill) => {
    const kEff = bloomK.mul(clamp(fill, float(0), float(1))).toVar();
    const kneeW = bloomThr.mul(bloomKnee).add(1e-4).toVar();
    // the bloom bright pass's share of a pixel that is kept (bloom-render.js `brightMaterial`, line for line)
    const contribution = (b) => {
      const soft = clamp(b.sub(bloomThr).add(kneeW), float(0), kneeW.mul(2));
      const softQ = soft.mul(soft).div(kneeW.mul(4).add(1e-4));
      return max(softQ, b.sub(bloomThr))
        .div(max(b, float(1e-4)))
        .max(float(0));
    };
    let lo = float(0).toVar();
    let hi = float(1).toVar();
    for (let i = 0; i < BLOOM_SOLVE_STEPS; i++) {
      const mid = lo.add(hi).mul(0.5).toVar();
      const over = mid.mul(float(1).add(kEff.mul(contribution(mid.mul(brT))))).greaterThan(1);
      const nextHi = select(over, mid, hi).toVar();
      const nextLo = select(over, lo, mid).toVar();
      hi = nextHi;
      lo = nextLo;
    }
    // `hi` (not the midpoint): with no bloom `hi` never moves off 1, so the flame is exactly its palette
    return mix(float(1), hi, bloomMix);
  };

  // cellular (Worley) noise: distances to the nearest two feature points, and the nearest cell's random
  const hash22 = (p) => {
    const q = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(q).mul(43758.5453));
  };
  const worley = (p) => {
    const ip = floor(p);
    const fp = fract(p);
    let f1 = float(8);
    let f2 = float(8);
    let rnd = float(0);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const o = vec2(i, j);
        const h = hash22(ip.add(o));
        const r = o.add(h).sub(fp);
        const d = dot(r, r);
        const closer = d.lessThan(f1);
        rnd = select(closer, h.x, rnd);
        f2 = min(f2, max(f1, d));
        f1 = min(f1, d);
      }
    }
    return { f1: sqrt(f1), f2: sqrt(f2), rnd };
  };

  resolveMaterial.fragmentNode = Fn(() => {
    const local = vWorld.sub(U.rectMin);
    const uv0 = local.div(U.rectSize);
    // ── edge roughening: slow noise advected through the lookup, two octaves ──
    const pn = local.mul(U.warpFreq);
    const tt = U.time.mul(U.warpSpeed);
    const n1 = mx_noise_float(vec3(pn.x, pn.y, tt));
    const n2 = mx_noise_float(vec3(pn.x.add(37.2), pn.y.add(11.7), tt.mul(1.13)));
    const pn2 = local.mul(U.warpFreq2);
    const n3 = mx_noise_float(vec3(pn2.x.add(5.3), pn2.y.add(91.1), tt.mul(1.9)));
    const n4 = mx_noise_float(vec3(pn2.x.add(63.7), pn2.y.add(7.7), tt.mul(2.1)));
    const warp = vec2(n1, n2).mul(U.warpPx).add(vec2(n3, n4).mul(U.warpPx2)).div(U.rectSize);
    const p = flipUV(uv0.add(warp));
    const e = U.texel.mul(1.5);
    const ex = vec2(e.x, float(0));
    const ey = vec2(float(0), dirY(e.y));
    const c0 = flameNode.sample(p);
    const cR = flameNode.sample(p.add(ex));
    const cL = flameNode.sample(p.sub(ex));
    const cD = flameNode.sample(p.add(ey));
    const cU = flameNode.sample(p.sub(ey));

    // ───────────── FLAME ─────────────
    const D = c0.x;
    const heat = c0.y.div(max(D, float(0.001))).clamp(0, 1);
    const grad = vec2(cR.x.sub(cL.x), cD.x.sub(cU.x)).mul(0.5);
    const gradLen = length(grad);
    const theta0 = U.outline;
    const aa = clamp(gradLen.mul(0.9), U.edgeSoft, float(0.4));
    const cover = smoothstep(theta0.sub(aa), theta0.add(aa), D);

    const sD = clamp(D.sub(theta0).div(U.span), float(0), float(1));
    const inside0 = smoothstep(theta0.add(0.02), theta0.add(0.3), D);
    let tau = sD.mul(float(1).sub(U.toneHeat)).add(heat.mul(U.toneHeat));
    const nm = mx_noise_float(vec3(local.x.mul(U.mottleFreq), local.y.mul(U.mottleFreq), tt.mul(0.5).add(3.3)));
    tau = clamp(tau.sub(U.toneLo).div(U.toneHi.sub(U.toneLo)), float(0), float(1));
    tau = tau.add(nm.mul(U.mottle)).add(n1.mul(0.03));
    // CEL-SHADED CRESCENTS: the density surface is a landscape of billows; the flank facing the light moves up a
    // tone, the flank facing away moves down one — the painted flame's lit and shaded crescents, for free.
    const gN = grad.mul(U.relief);
    const nrmC = normalize(vec3(gN.x.negate(), gN.y.negate(), float(1)));
    const litC = dot(nrmC, normalize(vec3(U.light.x, U.light.y, float(0.9))));
    const crescentAmt = smoothstep(float(0.8), float(0.95), litC).sub(smoothstep(float(0.64), float(0.4), litC));
    const calmCore = float(1).sub(smoothstep(float(0.35), float(0.8), sD));
    tau = tau.add(crescentAmt.mul(U.crescent).mul(inside0).mul(calmCore));
    // while a flame burns it never goes below the painted deep orange; only COOL lobes (a dying fire's) walk down to coal reds
    const floorTau = float(0.2).mul(smoothstep(float(0.08), float(0.32), heat));
    tau = pow(clamp(tau, floorTau, float(1)), U.tonePow);
    // banding with an antialiased step: floor + smoothstep(fract)
    const steps = max(U.bandCount.sub(1), float(1));
    const x = tau.mul(steps);
    const fx = fract(x);
    const soft = float(0.06).add(float(1).sub(U.posterize).mul(0.44));
    const stepped = floor(x)
      .add(smoothstep(float(0.5).sub(soft), float(0.5).add(soft), fx))
      .div(steps);
    const tauB = mix(tau, stepped, U.posterize);
    let rgb = piecewiseLinearRgb(TSL, tauB, rampStops).toVar();
    rgb = rgb.mul(U.tint).mul(U.emission);
    rgb = hueRotateNode(TSL, rgb, U.hue);

    // the glow: the density blurred by eight taps on a ring
    const gr = U.texel.mul(U.glowRadiusPx);
    let ring = c0.x.toVar();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ring = ring.add(flameNode.sample(p.add(vec2(gr.x.mul(Math.cos(a)), dirY(gr.y.mul(Math.sin(a)))))).x);
    }
    const glowA = smoothstep(float(0.0), float(1.2), ring.div(9)).mul(float(1).sub(cover)).mul(U.glow);
    const glowRgb = vec3(1.0, 0.42, 0.06).mul(glowA);

    // ───────────── COAL BED: cracked glowing cells, additive over whatever is painted ─────────────
    const C = c0.z;
    const coverC = smoothstep(float(0.3), float(0.8), C);
    // the cells' own outline wobbles (a straight crack reads as a tile edge, not a split in burning wood)
    const cw = vec2(
      mx_noise_float(vec3(local.x.mul(0.07), local.y.mul(0.07), float(7.7))),
      mx_noise_float(vec3(local.x.mul(0.07).add(31.4), local.y.mul(0.07).add(5.9), float(2.1)))
    ).mul(float(6));
    const w = worley(local.add(cw).mul(U.coalCell));
    const crack = smoothstep(float(0.0), U.coalCrack, w.f2.sub(w.f1));
    const pulse = float(0.75).add(sin(U.time.mul(float(0.9).add(w.rnd.mul(1.7))).add(w.rnd.mul(40))).mul(0.25));
    const coalHeat = clamp(c0.w.div(max(C, float(0.001))), float(0), float(1));
    // rounded glowing lumps with dark gaps (not crystal facets): bright in each cell's middle, falling toward its border
    const lump = float(1).sub(smoothstep(float(0.08), float(0.6), w.f1));
    // a cooling bed goes dark FAST: the tone is raised to a power so a half-cool coal is rust, not orange
    const coalTau = pow(
      clamp(
        coalHeat
          .mul(float(0.2).add(w.rnd.mul(0.8)))
          .mul(pulse)
          .mul(float(0.4).add(lump.mul(0.6)))
          .mul(1.05),
        float(0),
        float(0.95)
      ),
      float(1.5)
    );
    const coalA = coverC
      .mul(crack)
      .mul(smoothstep(float(0.02), float(0.2), coalTau))
      .mul(U.coalGain)
      .clamp(0, 0.92);
    const coalRgb = piecewiseLinearRgb(TSL, coalTau, rampStops);

    // ───────────── SMOKE ─────────────
    const s0 = smokeNode.sample(p);
    const sR = smokeNode.sample(p.add(ex));
    const sL = smokeNode.sample(p.sub(ex));
    const sD2 = smokeNode.sample(p.add(ey));
    const sU = smokeNode.sample(p.sub(ey));
    const S = s0.x;
    const toneS = s0.y.div(max(S, float(0.001))).clamp(0, 1);
    const sGrad = vec2(sR.x.sub(sL.x), sD2.x.sub(sU.x)).mul(0.5);
    const sAA = clamp(length(sGrad), float(0.02), float(0.5)).add(U.smokeSoft);
    const sCover = smoothstep(U.smokeOutline.sub(sAA), U.smokeOutline.add(sAA), S).mul(U.smokeOpacity);
    const dens = clamp(S.sub(U.smokeOutline).div(1.6), float(0), float(1));
    // young smoke (low tone) is lit warm by the fire under it; old smoke goes grey-brown. Dense = bright core.
    const steam = clamp(s0.z.div(max(S, float(0.001))), float(0), float(1));
    let sRgb = mix(smokeHi, smokeMid, smoothstep(float(0.0), float(0.55), toneS));
    sRgb = mix(sRgb, smokeShade, smoothstep(float(0.45), float(0.95), toneS).mul(0.8));
    sRgb = mix(sRgb, smokeDeep, float(1).sub(dens).mul(0.45));
    sRgb = mix(smokeLit, sRgb, smoothstep(float(0.0), float(0.28), toneS));
    sRgb = mix(sRgb, smokeSootC, U.smokeSoot.mul(toneS));
    // steam is the brightest, whitest smoke there is
    sRgb = mix(sRgb, smokeHi, steam.mul(0.85));
    const sNrm = normalize(vec3(sGrad.x.negate().mul(1.2), sGrad.y.negate().mul(1.2), float(1)));
    const sLit = dot(sNrm, normalize(vec3(U.light.x, U.light.y, float(0.9))));
    sRgb = sRgb.mul(float(0.88).add(clamp(sLit, float(-0.3), float(1)).mul(0.2)));
    let smokeLinear;
    if (lighting?.illumTexNode) {
      const illum = lighting.illumTexNode.sample(screenUV).rgb;
      const coloration = lighting.colorationTexNode ? lighting.colorationTexNode.sample(screenUV).rgb : vec3(0, 0, 0);
      // the scene's own composite: lit = EOTF(OETF(albedo) * illum + coloration); the painted smoke colours are sRGB albedo
      smokeLinear = sRGBTransferEOTF(sRGBTransferOETF(sRgb).mul(illum).add(coloration));
    } else {
      smokeLinear = sRgb.mul(U.ambient);
    }

    // ───────────── COMPOSE (premultiplied): flame over smoke, glow and coals added ─────────────
    let gate = float(1);
    if (depth?.depthTexNode && depth?.buildGate) {
      gate = depth.buildGate(TSL, {
        depthTexNode: depth.depthTexNode,
        depthFlagsTexNode: depth.depthFlagsTexNode,
        expectedDepth: U.expectedDepth,
      });
    }
    // bottom to top: the coal bed (painted over the ground), the smoke, the flame; the glow is added on top of all
    const coalPre = coalRgb.mul(coalA);
    const smokePre = smokeLinear.mul(sCover);
    const flamePre = rgb.mul(cover).add(glowRgb);
    const aSmoke = sCover.add(coalA.mul(float(1).sub(sCover)));
    const rgbSmoke = smokePre.add(coalPre.mul(float(1).sub(sCover)));
    const outA = cover.add(aSmoke.mul(float(1).sub(cover)));
    const outRgb = flamePre.add(rgbSmoke.mul(float(1).sub(cover)));
    // THE BLOOM COUNTER: paint s*T so that the scene's bloom adds its share and hands T back (fire-billow-bloom.js). `s` is
    // solved from the colour's own max channel and this fire's on-screen size; it is exactly 1 when the bloom is off.
    const brT = max(max(outRgb.r, outRgb.g), outRgb.b);
    const counter = bloomScale(brT, vFill);
    return vec4(outRgb.mul(counter).mul(gate), outA.mul(gate));
  })();
  resolveMaterial.transparent = true;
  resolveMaterial.depthTest = false;
  resolveMaterial.depthWrite = false;
  resolveMaterial.side = THREE.DoubleSide;
  resolveMaterial.toneMapped = false;
  resolveMaterial.blending = THREE.CustomBlending;
  resolveMaterial.blendEquation = THREE.AddEquation;
  resolveMaterial.blendSrc = THREE.OneFactor;
  resolveMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
  resolveMaterial.blendEquationAlpha = THREE.AddEquation;
  resolveMaterial.blendSrcAlpha = THREE.OneFactor;
  resolveMaterial.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

  const resolveMesh = new THREE.Mesh(resolveGeometry, resolveMaterial);
  resolveMesh.frustumCulled = false;
  const resolveScene = new THREE.Scene();
  resolveScene.add(resolveMesh);

  let nFlame = 0;
  let nSmoke = 0;
  let nQuads = 0;
  const api = {
    /** The scene to draw into the frame (visible flag is the caller's). */
    scene: resolveScene,
    /** The lobe buffers the CPU model writes (`LOBE_STRIDE` floats per lobe): flame + coal, and smoke. */
    flameLobes: flameBuf.array,
    smokeLobes: smokeBuf.array,
    flameCapacity: fCap,
    smokeCapacity: sCap,
    uniforms: U,
    get flameTexture() {
      return flameField.texture;
    },
    get flameTarget() {
      return flameField;
    },
    get smokeTarget() {
      return smokeField;
    },
    get fieldSize() {
      return { w: fieldW, h: fieldH };
    },
    /** Tell the renderer how many lobes of each buffer are valid this frame. */
    setCounts(flame, smoke) {
      nFlame = Math.max(0, Math.min(fCap, flame | 0));
      nSmoke = Math.max(0, Math.min(sCap, smoke | 0));
      flameBuf.geometry.instanceCount = nFlame;
      smokeBuf.geometry.instanceCount = nSmoke;
      flameBuf.interleaved.needsUpdate = true;
      smokeBuf.interleaved.needsUpdate = true;
    },
    get counts() {
      return { flame: nFlame, smoke: nSmoke };
    },
    /**
     * Place the contour boxes (world px): `[minX, minY, w, h]` per fire; with `n = 0` nothing is drawn. `fills` (optional,
     * one 0..1 number per box) says how much of the scene's bloom a flame that big on screen gets; omitted = 0 = no counter.
     */
    setQuads(boxes, n, fills = null) {
      nQuads = Math.max(0, Math.min(maxQuads, n | 0));
      for (let i = 0; i < nQuads * 4; i++) quadBoxes[i] = boxes[i];
      for (let i = 0; i < nQuads; i++) quadFills[i] = fills ? Number(fills[i]) || 0 : 0;
      resolveGeometry.instanceCount = nQuads;
      resolveGeometry.attributes.quadBox.needsUpdate = true;
      resolveGeometry.attributes.quadFill.needsUpdate = true;
      resolveMesh.visible = nQuads > 0;
    },
    /**
     * Set what the flame counters (`bloomCounterUniforms(...)`): the bloom's broad-region gain `k`, its `threshold` and `knee`,
     * and the author's `mix`. `k = 0` is no bloom: the flame is exactly its palette.
     */
    setBloomCounter({ k = 0, threshold = 1, knee = 0.5, mix = 0 } = {}) {
      bloomK.value = Number.isFinite(k) ? Math.max(0, k) : 0;
      bloomThr.value = Number.isFinite(threshold) ? Math.max(0, threshold) : 1;
      bloomKnee.value = Number.isFinite(knee) ? Math.min(1, Math.max(0, knee)) : 0.5;
      bloomMix.value = Number.isFinite(mix) ? Math.min(1, Math.max(0, mix)) : 0;
    },
    /** One box covering a world rect (the lab, and the first-cut engine). */
    setQuad(minX, minY, w, h) {
      this.setQuads([minX, minY, w, h], w > 0 && h > 0 ? 1 : 0);
    },
    /** Override look uniforms by name (numbers, or arrays for vec uniforms). */
    setLook(look = {}) {
      for (const [key, value] of Object.entries(look)) {
        const u = U[key];
        if (!u || value === undefined || value === null) continue;
        if (Array.isArray(value)) u.value.set(...value);
        else if (Number.isFinite(value)) u.value = value;
      }
    },
    /**
     * Get the fields ready for this frame and hand back the splat as a JOB LIST for the caller to run (this module may
     * not touch the renderer's state — see the header). Call after `setCounts`. Each job: clear `target` to transparent
     * black, then (if `count > 0`) `renderer.render(scene, camera)` into it.
     *
     * The target size is the rect at the drawing buffer's pixel density, rounded UP to a multiple of 64 and capped at
     * `maxDim`, and the targets are only re-allocated when that bucket changes, so a pan reuses them and a zoom costs a
     * re-allocation only when it crosses a bucket.
     *
     * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect world rect the fields cover.
     * @param {{pxPerWorld?:number, scale?:number, maxDim?:number, timeSec?:number}} [opts]
     * @returns {Array<{name:string, target:*, scene:*, camera:*, count:number}>}
     */
    prepareField(rect, { pxPerWorld = 1, scale = 1, maxDim = 2048, timeSec = 0 } = {}) {
      const W = Math.max(1, rect.maxX - rect.minX);
      const H = Math.max(1, rect.maxY - rect.minY);
      const bucket = (v) => Math.max(64, Math.min(maxDim, Math.ceil((v * pxPerWorld * scale) / 64) * 64));
      const w = bucket(W);
      const h = bucket(H);
      if (w !== fieldW || h !== fieldH) {
        const oldFlame = flameField;
        const oldSmoke = smokeField;
        fieldW = w;
        fieldH = h;
        flameField = createTarget('fire.flame', w, h);
        smokeField = createTarget('fire.smoke', w, h);
        flameNode.value = flameField.texture;
        smokeNode.value = smokeField.texture;
        if (disposeTarget) {
          disposeTarget(oldFlame);
          disposeTarget(oldSmoke);
        }
      }
      U.rectMin.value.set(rect.minX, rect.minY);
      U.rectSize.value.set(W, H);
      U.texel.value.set(1 / w, 1 / h);
      U.time.value = timeSec;
      splatCamera.left = rect.minX;
      splatCamera.right = rect.maxX;
      splatCamera.top = rect.minY;
      splatCamera.bottom = rect.maxY;
      splatCamera.updateProjectionMatrix();
      return [
        { name: 'fire.flame', target: flameField, scene: flameScene, camera: splatCamera, count: nFlame },
        { name: 'fire.smoke', target: smokeField, scene: smokeScene, camera: splatCamera, count: nSmoke },
      ];
    },
    dispose() {
      flameBuf.geometry.dispose();
      smokeBuf.geometry.dispose();
      flameSplat.dispose();
      smokeSplat.dispose();
      resolveGeometry.dispose();
      resolveMaterial.dispose();
      if (disposeTarget) {
        disposeTarget(flameField);
        disposeTarget(smokeField);
      }
    },
  };
  return api;
}

export { BILLOW_FLECK_HEX };
