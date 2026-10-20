/**
 * FIRE — THE BILLOW RENDERER (2026-10-20). TSL graphs and the render-target lifecycle for
 * `fire-billow-geometry.js`'s lobes. THREE is INJECTED (`effects/` may not import the vendor bundle's renderer).
 *
 * ============================================================================
 * THE PIPELINE: PARTICLES -> FIELD -> CONTOUR
 * ============================================================================
 *
 * 1. SPLAT. Every lobe is an instanced quad whose fragment writes the lobe's smooth kernel
 *    `k(q) = (1 - q^2)^2` (compact support, zero slope at the rim) into a half-float FIELD target with plain
 *    additive blending: R = flame density, G = flame heat-weighted density, B = smoke density,
 *    A = smoke tone-weighted density. Order-independent, so lobes can be drawn in any order and nothing pops: a
 *    lobe enters by growing from radius 0.
 * 2. CONTOUR. One quad per fire (or one for the view) reads the field and turns it into the painted look: the
 *    silhouette is the iso-contour of the density, the tone bands are higher contours (cream core where the
 *    density is highest), valleys between lobes get a darker crease, a slow noise roughens the edges, and a
 *    faint glow is the field blurred. Metaballs of lobed particles = the author's lobed daubs.
 *
 * Why not draw each lobe as its own opaque disc? Overlapping discs show every circle's outline and need a depth
 * sort. A field has neither problem, and the "vitality" of a dying fire is just the contour level rising, so a
 * doused flame shrinks smoothly onto its coals instead of thinning into dots.
 *
 * ⚠️ THE FIELD IS WORLD-RECT ALIGNED, NOT SCREEN ALIGNED. It covers the rect `sync()` is given (the visible
 * world, which every other engine here also takes), sized to the drawing buffer's pixel density, so it does not
 * care about the camera's jitter or the viewport's exact shape, and the contour reads it by world position.
 *
 * ⚠️ READ THE OTHER HALF OF THIS CONTRACT IN THE LAB (`tools/shader-lab/fire-billow-lab.js`): orientation of the
 * field texture is calibrated empirically there, never assumed (`feedback_y_flip_recurring_risk`).
 *
 * @module effects/fire/fire-billow-render
 */
import { BILLOW_FLAME_RAMP, BILLOW_SMOKE_RAMP, BILLOW_FLECK_HEX, LOBE_STRIDE } from './fire-billow-geometry.js';
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
  /** Density level of the silhouette. A single lobe's visible radius is where (1-q^2)^2 = this (0.3 -> 0.67 r). */
  outline: 0.5,
  /** Density above the outline at which the tone reaches the cream core. */
  span: 8.2,
  /** How much of the tone follows heat rather than density (0 = pure density). */
  toneHeat: 0.63,
  /** Tone gamma: < 1 lifts the whole flame toward the cream end (the painted flame is ~25% cream + yellow). */
  tonePow: 0.84,
  /** 0 = smooth photographic ramp .. 1 = hard cel bands. */
  posterize: 0.62,
  bandCount: 5,
  /** Painterly roughness of the edge: px of noise warp, and the noise's spatial frequency (1/px). */
  warpPx: 2.6,
  warpFreq: 0.05,
  warpSpeed: 0.7,
  /** Darkening in the valleys between lobes. */
  crease: 0.0,
  /** The cel-shaded crescents: how steeply the density surface tilts the normal, and how far a lit / shaded flank moves the tone. */
  relief: 2.6,
  crescent: 0.06,
  /** Painterly mottling of the tone (noise added to the temperature, 1/px and amount). */
  mottle: 0.1,
  mottleFreq: 0.07,
  /**
   * The splat kernel is a PLATEAU, not a bump: k = 1 inside `plateau` of the radius and falls to 0 at the rim. Each billow
   * then adds a flat +strength inside its own edge, so the SUM counts how many billows overlap a pixel. The contour of
   * the sum is the UNION of the discs (a cartoon cloud: crisp cusps, never a metaball's liquid fillets), the tone steps
   * are the overlap count (translucent daubs stacked: every billow's own outline shows inside the flame), and the
   * edge crescents ride each disc's own rim. 0 = a soft bump (the first version, which read as orange slime).
   */
  plateau: 0.8,
  /** How much cooler a disc is at its rim than at its middle (0..1). */
  discGradient: 0.555,
  /** The dome: how much lower a disc is at its rim than its middle, so each puff has a shaded flank. */
  dome: 0.37,
  /** Levels on the tone (0..1): stretches the flame's tone so the middle really reaches the cream stop. */
  toneLo: 0.03,
  toneHi: 0.8,
  /** The flame's minimum edge softness, in density units (0.012 = razor, 0.1 = painted gouache). */
  edgeSoft: 0.08,
  /** A finer second octave of edge roughness (px, 1/px). */
  warpPx2: 1.1,
  warpFreq2: 0.15,
  /** Faint halo around the flame (HDR, additive: feeds the bloom). */
  glow: 0.35,
  glowRadiusPx: 14,
  /** Emission multiplier on the flame colours (1 = the painted colours exactly). */
  emission: 1.0,
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
 * @param {number} [deps.capacity=8192] lobes
 * @param {object} [deps.lighting] `{illumTexNode, colorationTexNode}`: the scene's own light on the SMOKE (the flame
 *   is emissive and ignores it). Without it the smoke is lit by `uAmbient` alone.
 * @param {object} [deps.depth] `{depthTexNode, depthFlagsTexNode, buildGate}` the occlusion gate every post-lit draw uses.
 * @param {boolean} [deps.flipV=false] field texture orientation, from the lab's calibration.
 * @returns {object}
 */
export function createBillowRenderer({ THREE, capacity = 8192, lighting = null, depth = null, flipV = false }) {
  const TSL = THREE.TSL;
  const {
    Fn,
    attribute,
    uniform,
    float,
    vec2,
    vec3,
    vec4,
    uv,
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
    abs,
    floor,
    fract,
    normalize,
    length,
    sin,
    mx_noise_float,
    screenUV,
    sRGBTransferEOTF,
  } = TSL;

  // ── the field target ────────────────────────────────────────────────────────────────────────────
  let fieldW = 4;
  let fieldH = 4;
  let field = null;
  const makeField = (w, h) => {
    const rt = new THREE.RenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  };
  field = makeField(fieldW, fieldH);
  const fieldNode = texture(field.texture);

  // ── instance data ─────────────────────────────────────────────────────────────────────────────
  const cap = Math.max(16, capacity | 0);
  const lobeArray = new Float32Array(cap * LOBE_STRIDE);
  const geometry = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.attributes.position);
  geometry.setAttribute('uv', quad.attributes.uv);
  const interleaved = new THREE.InstancedInterleavedBuffer(lobeArray, LOBE_STRIDE, 1);
  interleaved.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('lobeA', new THREE.InterleavedBufferAttribute(interleaved, 4, 0));
  geometry.setAttribute('lobeB', new THREE.InterleavedBufferAttribute(interleaved, 4, 4));
  geometry.setAttribute('lobeC', new THREE.InterleavedBufferAttribute(interleaved, 4, 8));
  geometry.instanceCount = 0;

  // ── uniforms ──────────────────────────────────────────────────────────────────────────────────
  const U = {
    rectMin: uniform(vec2(0, 0)),
    rectSize: uniform(vec2(1, 1)),
    texel: uniform(vec2(1, 1)),
    time: uniform(float(0)),
    outline: uniform(float(BILLOW_LOOK.outline)),
    span: uniform(float(BILLOW_LOOK.span)),
    toneHeat: uniform(float(BILLOW_LOOK.toneHeat)),
    tonePow: uniform(float(BILLOW_LOOK.tonePow)),
    posterize: uniform(float(BILLOW_LOOK.posterize)),
    bandCount: uniform(float(BILLOW_LOOK.bandCount)),
    warpPx: uniform(float(BILLOW_LOOK.warpPx)),
    warpFreq: uniform(float(BILLOW_LOOK.warpFreq)),
    warpSpeed: uniform(float(BILLOW_LOOK.warpSpeed)),
    crease: uniform(float(BILLOW_LOOK.crease)),
    relief: uniform(float(BILLOW_LOOK.relief)),
    crescent: uniform(float(BILLOW_LOOK.crescent)),
    mottle: uniform(float(BILLOW_LOOK.mottle)),
    mottleFreq: uniform(float(BILLOW_LOOK.mottleFreq)),
    plateau: uniform(float(BILLOW_LOOK.plateau)),
    discGradient: uniform(float(BILLOW_LOOK.discGradient)),
    dome: uniform(float(BILLOW_LOOK.dome)),
    toneLo: uniform(float(BILLOW_LOOK.toneLo)),
    toneHi: uniform(float(BILLOW_LOOK.toneHi)),
    edgeSoft: uniform(float(BILLOW_LOOK.edgeSoft)),
    warpPx2: uniform(float(BILLOW_LOOK.warpPx2)),
    warpFreq2: uniform(float(BILLOW_LOOK.warpFreq2)),
    glow: uniform(float(BILLOW_LOOK.glow)),
    glowRadiusPx: uniform(float(BILLOW_LOOK.glowRadiusPx)),
    emission: uniform(float(BILLOW_LOOK.emission)),
    smokeOutline: uniform(float(BILLOW_LOOK.smokeOutline)),
    smokeSoft: uniform(float(BILLOW_LOOK.smokeSoft)),
    smokeOpacity: uniform(float(BILLOW_LOOK.smokeOpacity)),
    smokeSoot: uniform(float(BILLOW_LOOK.smokeSoot)),
    light: uniform(vec2(BILLOW_LOOK.lightX, BILLOW_LOOK.lightY)),
    hue: uniform(float(0)),
    tint: uniform(vec3(1, 1, 1)),
    /** 0..1 the brightest fire's power: lowers the contour level's reach and cools the tone (a dying flame). */
    power: uniform(float(1)),
    ambient: uniform(vec3(1, 1, 1)),
    expectedDepth: uniform(float(0)),
  };

  // ── 1. THE SPLAT ────────────────────────────────────────────────────────────────────────────────
  const lobeA = attribute('lobeA', 'vec4'); // x, y, radius, strength
  const lobeB = attribute('lobeB', 'vec4'); // heat, stretch, dirX, dirY
  const lobeC = attribute('lobeC', 'vec4'); // kind, tone, z, 0

  const splatMaterial = new THREE.NodeMaterial();
  const vLocal = Fn(() => positionGeometry.xy.mul(2))().toVarying('vBillowLocal');
  const vData = Fn(() => vec4(lobeA.w, lobeB.x, lobeC.x, lobeC.y))().toVarying('vBillowData');
  splatMaterial.positionNode = Fn(() => {
    const corner = positionGeometry.xy.mul(2);
    const dir = vec2(lobeB.z, lobeB.w);
    const nrm = vec2(dir.y.negate(), dir.x);
    const st = max(lobeB.y, float(1));
    const along = sqrt(st);
    const across = float(1).div(along);
    const off = dir.mul(corner.x.mul(lobeA.z).mul(along)).add(nrm.mul(corner.y.mul(lobeA.z).mul(across)));
    return vec3(lobeA.x.add(off.x), lobeA.y.add(off.y), float(0));
  })();
  splatMaterial.fragmentNode = Fn(() => {
    const qd = sqrt(dot(vLocal, vLocal));
    // FLAME: a plateau with a slight dome (so a puff has a lit side and a shaded side across its whole face);
    // SMOKE: a soft bump (painted smoke is airy; a hard plateau made it chunky).
    const kFlame = float(1).sub(smoothstep(U.plateau, float(1), qd)).mul(float(1).sub(U.dome.mul(qd.mul(qd))));
    const kSoft0 = max(float(1).sub(qd.mul(qd)), float(0));
    const k = mix(kFlame, kSoft0.mul(kSoft0), vData.z);
    const w = vData.x.mul(k);
    const isSmoke = vData.z;
    const flame = float(1).sub(isSmoke);
    // each puff is hotter at its middle than at its rim: a soft gradient inside every disc (a lit billow, not a flat coin)
    const radialHeat = float(1).sub(U.discGradient.mul(qd.mul(qd)));
    return vec4(w.mul(flame), w.mul(vData.y).mul(radialHeat).mul(flame), w.mul(isSmoke), w.mul(vData.w).mul(isSmoke));
  })();
  splatMaterial.transparent = true;
  splatMaterial.depthTest = false;
  splatMaterial.depthWrite = false;
  splatMaterial.side = THREE.DoubleSide;
  splatMaterial.toneMapped = false;
  splatMaterial.blending = THREE.CustomBlending;
  splatMaterial.blendEquation = THREE.AddEquation;
  splatMaterial.blendSrc = THREE.OneFactor;
  splatMaterial.blendDst = THREE.OneFactor;
  splatMaterial.blendEquationAlpha = THREE.AddEquation;
  splatMaterial.blendSrcAlpha = THREE.OneFactor;
  splatMaterial.blendDstAlpha = THREE.OneFactor;

  const splatMesh = new THREE.Mesh(geometry, splatMaterial);
  splatMesh.frustumCulled = false;
  const splatScene = new THREE.Scene();
  splatScene.add(splatMesh);
  const splatCamera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);

  // ── 2. THE CONTOUR ──────────────────────────────────────────────────────────────────────────────
  const rampStops = billowRampStops();
  const smokeHi = hexToLinear(BILLOW_SMOKE_RAMP.highlight);
  const smokeMid = hexToLinear(BILLOW_SMOKE_RAMP.mid);
  const smokeShade = hexToLinear(BILLOW_SMOKE_RAMP.shade);
  const smokeDeep = hexToLinear(BILLOW_SMOKE_RAMP.deep);
  const smokeLit = hexToLinear(BILLOW_SMOKE_RAMP.lit);
  const smokeSoot = hexToLinear(BILLOW_SMOKE_RAMP.soot);
  const rimRgb = hexToLinear('#e27b13');
  const flipUV = (p) => (flipV ? vec2(p.x, float(1).sub(p.y)) : p);

  const resolveGeometry = new THREE.PlaneGeometry(1, 1);
  const resolveMaterial = new THREE.NodeMaterial();
  const uQuadMin = uniform(vec2(0, 0));
  const uQuadSize = uniform(vec2(1, 1));
  const worldAt = Fn(() => uQuadMin.add(positionGeometry.xy.add(vec2(0.5, 0.5)).mul(uQuadSize)))();
  const vWorld = worldAt.toVarying('vBillowWorld');
  resolveMaterial.positionNode = Fn(() => vec3(worldAt, float(0)))();

  resolveMaterial.fragmentNode = Fn(() => {
    const local = vWorld.sub(U.rectMin);
    const uv0 = local.div(U.rectSize);
    // ── edge roughening: a slow noise advected through the lookup ──
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
    const exv = vec2(e.x, float(0));
    const eyv = vec2(float(0), e.y);
    const c0 = fieldNode.sample(p);
    const cR = fieldNode.sample(p.add(flipUV(exv).sub(flipUV(vec2(0, 0)))));
    const cL = fieldNode.sample(p.sub(flipUV(exv).sub(flipUV(vec2(0, 0)))));
    const cD = fieldNode.sample(p.add(flipUV(eyv).sub(flipUV(vec2(0, 0)))));
    const cU = fieldNode.sample(p.sub(flipUV(eyv).sub(flipUV(vec2(0, 0)))));

    // ───────────── FLAME ─────────────
    const D = c0.x;
    const heat = c0.y.div(max(D, float(0.001))).clamp(0, 1);
    const grad = vec2(cR.x.sub(cL.x), cD.x.sub(cU.x)).mul(0.5);
    const gradLen = length(grad);
    const lap = cR.x.add(cL.x).add(cD.x).add(cU.x).sub(D.mul(4));
    const theta0 = U.outline.add(float(1).sub(U.power).mul(0.55));
    const aa = clamp(gradLen.mul(0.9), U.edgeSoft, float(0.4));
    const cover = smoothstep(theta0.sub(aa), theta0.add(aa), D);

    const sD = clamp(D.sub(theta0).div(U.span), float(0), float(1));
    const inside0 = smoothstep(theta0.add(0.02), theta0.add(0.3), D);
    let tau = sD.mul(float(1).sub(U.toneHeat)).add(heat.mul(U.toneHeat));
    const nm = mx_noise_float(vec3(local.x.mul(U.mottleFreq), local.y.mul(U.mottleFreq), tt.mul(0.5).add(3.3)));
    tau = clamp(tau.sub(U.toneLo).div(U.toneHi.sub(U.toneLo)), float(0), float(1));
    tau = tau.mul(float(0.45).add(U.power.mul(0.55))).add(nm.mul(U.mottle)).add(n1.mul(0.03));
    // CEL-SHADED CRESCENTS: the density surface is a landscape of billows; the flank facing the light moves up a
    // tone, the flank facing away moves down one — the painted flame's lit and shaded crescents, for free.
    const gN = grad.mul(U.relief);
    const nrmC = normalize(vec3(gN.x.negate(), gN.y.negate(), float(1)));
    const litC = dot(nrmC, normalize(vec3(U.light.x, U.light.y, float(0.9))));
    const crescentAmt = smoothstep(float(0.8), float(0.95), litC).sub(smoothstep(float(0.64), float(0.4), litC));
    const calmCore = float(1).sub(smoothstep(float(0.35), float(0.8), sD));
    tau = tau.add(crescentAmt.mul(U.crescent).mul(inside0).mul(calmCore));
    // while it burns the flame never goes below the painted deep orange; only a DYING fire walks down into coal reds
    const floorTau = float(0.2).mul(smoothstep(float(0.35), float(0.95), U.power));
    tau = pow(clamp(tau, floorTau, float(1)), U.tonePow);
    // banding with an antialiased step: floor + smoothstep(fract)
    const steps = max(U.bandCount.sub(1), float(1));
    const x = tau.mul(steps);
    const fx = fract(x);
    const soft = float(0.06).add(float(1).sub(U.posterize).mul(0.44));
    const stepped = floor(x).add(smoothstep(float(0.5).sub(soft), float(0.5).add(soft), fx)).div(steps);
    const tauB = mix(tau, stepped, U.posterize);
    let rgb = piecewiseLinearRgb(TSL, tauB, rampStops).toVar();
    // creases: the valleys between lobes get the rim colour, inside the body only
    const inside = smoothstep(theta0.add(0.08), theta0.add(0.5), D);
    const crease = clamp(lap.mul(U.crease), float(0), float(1)).mul(inside);
    rgb = mix(rgb, vec3(rimRgb[0], rimRgb[1], rimRgb[2]), crease.mul(0.6));
    // the very subtle light direction: lit sides a touch brighter
    rgb = rgb.mul(U.tint).mul(U.emission);
    rgb = hueRotateNode(TSL, rgb, U.hue);

    // the glow: the field blurred by eight taps on a ring
    const gr = U.texel.mul(U.glowRadiusPx);
    let ring = c0.x.toVar();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ring = ring.add(fieldNode.sample(p.add(vec2(gr.x.mul(Math.cos(a)), gr.y.mul(Math.sin(a))))).x);
    }
    const glowD = ring.div(9);
    const glowA = smoothstep(float(0.0), float(1.2), glowD).mul(float(1).sub(cover)).mul(U.glow);
    const glowRgb = vec3(1.0, 0.42, 0.06).mul(glowA);

    // ───────────── SMOKE ─────────────
    const S = c0.z;
    const toneS = c0.w.div(max(S, float(0.001))).clamp(0, 1);
    const sAA = clamp(length(vec2(cR.z.sub(cL.z), cD.z.sub(cU.z))).mul(0.5), float(0.02), float(0.5)).add(U.smokeSoft);
    const sCover = smoothstep(U.smokeOutline.sub(sAA), U.smokeOutline.add(sAA), S).mul(U.smokeOpacity);
    const dens = clamp(S.sub(U.smokeOutline).div(1.6), float(0), float(1));
    // young smoke (low tone) is lit warm by the fire under it; old smoke goes grey-brown. Dense = bright core.
    let sRgb = mix(vec3(smokeHi[0], smokeHi[1], smokeHi[2]), vec3(smokeMid[0], smokeMid[1], smokeMid[2]), smoothstep(float(0.0), float(0.55), toneS));
    sRgb = mix(sRgb, vec3(smokeShade[0], smokeShade[1], smokeShade[2]), smoothstep(float(0.45), float(0.95), toneS).mul(0.8));
    sRgb = mix(sRgb, vec3(smokeDeep[0], smokeDeep[1], smokeDeep[2]), float(1).sub(dens).mul(0.45));
    sRgb = mix(vec3(smokeLit[0], smokeLit[1], smokeLit[2]), sRgb, smoothstep(float(0.0), float(0.28), toneS));
    sRgb = mix(sRgb, vec3(smokeSoot[0], smokeSoot[1], smokeSoot[2]), U.smokeSoot.mul(toneS));
    const sGrad = vec2(cR.z.sub(cL.z), cD.z.sub(cU.z)).mul(0.5);
    const sNrm = normalize(vec3(sGrad.x.negate().mul(1.2), sGrad.y.negate().mul(1.2), float(1)));
    const sLit = dot(sNrm, normalize(vec3(U.light.x, U.light.y, float(0.9))));
    sRgb = sRgb.mul(float(0.88).add(clamp(sLit, float(-0.3), float(1)).mul(0.2)));
    let smokeLinear;
    if (lighting?.illumTexNode) {
      const illum = lighting.illumTexNode.sample(screenUV).rgb;
      const coloration = lighting.colorationTexNode ? lighting.colorationTexNode.sample(screenUV).rgb : vec3(0, 0, 0);
      // the scene's own composite: lit = EOTF(OETF(albedo) * illum + coloration). The painted smoke colours are
      // sRGB albedo, so they go in as they are (not pre-decoded).
      const albedo = vec3(smokeToSrgb(sRgb));
      smokeLinear = sRGBTransferEOTF(albedo.mul(illum).add(coloration));
    } else {
      smokeLinear = sRgb.mul(U.ambient);
    }

    // ───────────── COMPOSE (premultiplied): smoke over flame, glow added ─────────────
    let gate = float(1);
    if (depth?.depthTexNode && depth?.buildGate) {
      gate = depth.buildGate(TSL, { depthTexNode: depth.depthTexNode, depthFlagsTexNode: depth.depthFlagsTexNode, expectedDepth: U.expectedDepth });
    }
    // The flame is IN FRONT of its smoke: from the 3/4 view the smoke climbs behind and above the body, and the
    // painted plumes leave the flame legible at their base. Premultiplied: flame over smoke, glow added on top.
    const flamePre = rgb.mul(cover).add(glowRgb);
    const flameA = cover;
    const smokePre = smokeLinear.mul(sCover);
    const outA = flameA.add(sCover.mul(float(1).sub(flameA)));
    const outRgb = flamePre.add(smokePre.mul(float(1).sub(flameA)));
    return vec4(outRgb.mul(gate), outA.mul(gate));
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

  /** Linear -> sRGB for the smoke albedo (the scene composite wants sRGB albedo). */
  function smokeToSrgb(linearRgb) {
    return TSL.sRGBTransferOETF(linearRgb);
  }

  let count = 0;
  const api = {
    /** The scene to draw into the frame (visible flag is the caller's). */
    scene: resolveScene,
    /** The lobe buffer the CPU model writes (`LOBE_STRIDE` floats per lobe). */
    lobes: lobeArray,
    capacity: cap,
    uniforms: U,
    get fieldTexture() {
      return field.texture;
    },
    get fieldTarget() {
      return field;
    },
    get fieldSize() {
      return { w: fieldW, h: fieldH };
    },
    /** Tell the renderer how many lobes of `lobes` are valid this frame. */
    setCount(n) {
      count = Math.max(0, Math.min(cap, n | 0));
      geometry.instanceCount = count;
      interleaved.needsUpdate = true;
    },
    get count() {
      return count;
    },
    /** Place the contour quad (world px): the whole view, or one fire's box. */
    setQuad(minX, minY, w, h) {
      uQuadMin.value.set(minX, minY);
      uQuadSize.value.set(w, h);
      resolveMesh.visible = w > 0 && h > 0;
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
     * Splat every lobe into the field. Call from `sync()` (no render target bound), after `setCount`.
     * @param {*} renderer
     * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect world rect the field covers.
     * @param {{pxPerWorld?:number, scale?:number, maxDim?:number, timeSec?:number}} [opts]
     */
    renderField(renderer, rect, { pxPerWorld = 1, scale = 1, maxDim = 2048, timeSec = 0 } = {}) {
      const W = Math.max(1, rect.maxX - rect.minX);
      const H = Math.max(1, rect.maxY - rect.minY);
      const w = Math.max(16, Math.min(maxDim, Math.round(W * pxPerWorld * scale)));
      const h = Math.max(16, Math.min(maxDim, Math.round(H * pxPerWorld * scale)));
      if (w !== fieldW || h !== fieldH) {
        fieldW = w;
        fieldH = h;
        field.setSize(w, h);
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

      const prevTarget = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      const prevColor = renderer.getClearColor(new THREE.Color());
      const prevAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(field);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.clear(true, false, false);
      if (count > 0) {
        renderer.autoClear = false;
        renderer.render(splatScene, splatCamera);
      }
      renderer.autoClear = prevAuto;
      renderer.setClearColor(prevColor, prevAlpha);
      renderer.setRenderTarget(prevTarget);
    },
    dispose() {
      geometry.dispose();
      splatMaterial.dispose();
      resolveGeometry.dispose();
      resolveMaterial.dispose();
      field.dispose();
    },
  };
  return api;
}

export { BILLOW_FLECK_HEX };
