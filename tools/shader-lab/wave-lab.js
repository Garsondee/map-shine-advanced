/**
 * WAVE LAB (2026-11-10, Ingram: "caustics, wave shape and the light shafts would all be from a single connected system
 * working together on the GPU ... this would obviously need to change the specular which should be driven by the normal
 * of the waves").
 *
 * ONE SOURCE OF TRUTH: a wind-wave SPECTRUM (K sine components on a lattice that tiles every TILE_PX, built on the CPU
 * from the wind speed and the fetch) evaluated on the GPU by ONE function, `waveAt(p)` → (height, slope x, slope y,
 * curvature). Every consumer calls that same function:
 *
 *   SURFACE   normal = (−sx, −sy, 1): sky reflection, Fresnel and the sun glint (GGX).
 *   REFRACTION the bed seen through the surface is bent by the same normal (Snell, straight down).
 *   CAUSTICS  a photon grid: each surface cell refracts the SUN ray (real elevation and azimuth, Snell) down to the bed at
 *             five depths and is splatted there with brightness = the area it had ÷ the area it lands on. Bright lines
 *             are wherever the real waves focus light; nothing is drawn that the waves did not make.
 *   SHAFTS    light scattered in the water column: the same five caustic slices integrated down to the bed, attenuated
 *             by absorption on the way in and back out.
 *
 * Real numbers: 100 px = 5 ft (65.6 px/m). Peak wavelength from fetch-limited JONSWAP (Hasselmann 1973); total surface
 * slope variance from Cox & Munk (1954): σ² = 0.003 + 0.00512·U (here 0.0005 floor, so dead calm reads glassy). Phase
 * speed from the real dispersion relation with capillarity: ω² = g·k + (τ/ρ)·k³.
 *
 * Drive: `window.waveLab` — `set({...})`, `shot(name)` → {name, dataUrl}, `info()`.
 */

import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { metresPerSecondForSpeed01 } from '../../src/world/wind-scale.js';
import { createWindHandle, windStrength01Node } from '../../src/world/index.js';

const TSL = THREE.TSL;
const {
  Fn,
  Loop,
  uniform,
  float,
  int,
  vec2,
  vec3,
  vec4,
  ivec2,
  textureLoad,
  texture,
  uv,
  sin,
  cos,
  normalize,
  refract,
  reflect,
  varying,
  dFdx,
  dFdy,
  abs,
  max,
  min,
  clamp,
  exp,
  pow,
  mix,
  smoothstep,
  instanceIndex,
  floor,
  length,
  dot,
  log,
  mx_fractal_noise_float,
  mx_worley_noise_float,
} = TSL;

const W = 1280;
const H = 720;
export const PX_PER_M = 100 / 1.524;
export const TILE_PX = 1024;
const K = 64;
const BAKE_RES = 384;
const SPLAT_PX = 3; // splat grid spacing, world px at zoom 1
/** Depth slices, metres (log spaced). */
export const SLICES_M = [0.15, 0.4, 0.9, 1.8, 3.5];
const G = 9.81;
const TAU_RHO = 7.3e-5;
const IOR = 1.333;

const statusEl = document.getElementById('status');
const say = (m) => (statusEl.textContent = m);

// ── THE SPECTRUM (CPU) ────────────────────────────────────────────────────────────────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/**
 * Pick K lattice wave components for a wind. Importance-sampled by SLOPE spectrum, so each picked component carries the
 * same slope variance: a_i = s0 / |k_i|. Heights in px.
 */
export function buildSpectrum({ wind01 = 0.1, windDeg = 0, fetchM = 400, seed = 7, resolved = 0.2 } = {}) {
  const U = Math.max(0.3, Math.min(30, metresPerSecondForSpeed01(Math.max(0, wind01))));
  const tileM = TILE_PX / PX_PER_M;
  const dk = (2 * Math.PI) / tileM;
  const kMax = (2 * Math.PI) / 0.22; // shortest resolved wave 0.22 m (~14 px)
  const nMax = Math.ceil(kMax / dk);
  const gF = (G * fetchM) / (U * U);
  let wp = 2 * Math.PI * 3.5 * (G / U) * Math.pow(gF, -0.33);
  wp = Math.max(wp, (0.855 * G) / U);
  const alpha = 0.076 * Math.pow(gF, -0.22);
  const gamma = 3.3;
  // the wind's own bearing convention (world/wind-bake.js#windFlowVector: toward (sin d, −cos d), y down)
  const wr = (windDeg * Math.PI) / 180;
  const th0 = Math.atan2(-Math.cos(wr), Math.sin(wr));
  const cand = [];
  for (let n = -nMax; n <= nMax; n++) {
    for (let m = -nMax; m <= nMax; m++) {
      if (!n && !m) continue;
      const kx = n * dk;
      const ky = m * dk;
      const k = Math.hypot(kx, ky);
      if (k > kMax) continue;
      const w = Math.sqrt(G * k + TAU_RHO * k * k * k);
      const sig = w <= wp ? 0.07 : 0.09;
      const r = Math.exp(-((w - wp) ** 2) / (2 * sig * sig * wp * wp));
      const S = ((alpha * G * G) / w ** 5) * Math.exp(-1.25 * (wp / w) ** 4) * gamma ** r;
      const dwdk = (G + 3 * TAU_RHO * k * k) / (2 * w);
      const s = Math.max(1, Math.min(20, 11.5 * Math.pow(w / wp, w > wp ? -2.5 : 5)));
      const dth = Math.atan2(ky, kx) - th0;
      const D = Math.pow(Math.abs(Math.cos(dth / 2)), 2 * s) * Math.sqrt(s); // ~normalised
      const F = (S * dwdk * D) / k; // height spectrum per k-area
      const wSlope = F * k * k;
      if (wSlope > 0) cand.push({ kx, ky, k, w, wSlope });
    }
  }
  // weighted sampling without replacement (Efraimidis–Spirakis)
  const rnd = rng(seed);
  for (const c of cand) c.key = Math.log(rnd()) / c.wSlope;
  cand.sort((a, b) => b.key - a.key);
  const picked = cand.slice(0, K);
  const sigma2 = 0.0005 + 0.00512 * U;
  const s0 = Math.sqrt((2 * sigma2 * resolved) / picked.length);
  const prnd = rng(seed * 31 + 3);
  const kp = (wp * wp) / G;
  const comps = picked.map((c) => ({
    kx: c.kx / PX_PER_M, // rad per px
    ky: c.ky / PX_PER_M,
    amp: (s0 / c.k) * PX_PER_M, // px
    w: c.w,
    ph: prnd() * Math.PI * 2,
    // RIPPLE band (short waves, > 2.5× the peak wavenumber) answers the LOCAL wind at once; the rest (the wind sea)
    // answers it gently. Both read the real wind field (see `waveAt`).
    ripple: c.k > 2.5 * kp ? 1 : 0,
  }));
  const lp = (2 * Math.PI * G) / (wp * wp);
  const hs = 4 * Math.sqrt(comps.reduce((a, c) => a + (c.amp / PX_PER_M) ** 2 / 2, 0));
  return {
    U,
    fetchM,
    peakWavelengthM: lp,
    peakWavelengthPx: lp * PX_PER_M,
    peakPeriodSec: (2 * Math.PI) / wp,
    peakSpeedPxPerSec: (wp / ((wp * wp) / G)) * PX_PER_M,
    slopeVariance: sigma2,
    glintRoughness: Math.sqrt(sigma2 * (1 - resolved)),
    hsM: hs,
    comps,
  };
}

// ── THE GPU SYSTEM ────────────────────────────────────────────────────────────────────────────────────────────────────
class WaveLab {
  constructor() {
    this.canvas = document.getElementById('view');
    this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: false, alpha: false });
    this.p = {
      wind01: 0.1,
      windDeg: 0,
      fetchM: 400,
      seed: 7,
      sunElevDeg: 60,
      sunAzDeg: 210,
      flowPx: [0, 0],
      time: 0,
      mode: 0,
      viewX: 0,
      viewY: 0,
      zoom: 1,
      depthMaxM: 4,
      shafts: 1,
      caustics: 1,
    };
  }

  async init() {
    const r = this.renderer;
    await r.init();
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;

    this.compData = new Float32Array(K * 2 * 4);
    this.compTex = new THREE.DataTexture(this.compData, K, 2, THREE.RGBAFormat, THREE.FloatType);
    this.compTex.minFilter = THREE.NearestFilter;
    this.compTex.magFilter = THREE.NearestFilter;
    this.compTex.needsUpdate = true;
    const compTex = this.compTex;

    /** THE one wave function: (height px, slope x, slope y, laplacian /px). Phases include time (CPU-wrapped). */
    const waveAt = Fn(([p, gSea, gRip]) => {  // (kept: reference evaluator)
      const h = float(0).toVar();
      const sx = float(0).toVar();
      const sy = float(0).toVar();
      const lap = float(0).toVar();
      Loop(K, ({ i }) => {
        const c = textureLoad(compTex, ivec2(i, int(0)));
        const e = textureLoad(compTex, ivec2(i, int(1)));
        const ph = c.x.mul(p.x).add(c.y.mul(p.y)).add(e.x);
        const cs = cos(ph);
        const sn = sin(ph);
        const a = c.z.mul(mix(gSea, gRip, e.y));
        h.addAssign(a.mul(cs));
        sx.addAssign(a.mul(c.x).mul(sn).negate());
        sy.addAssign(a.mul(c.y).mul(sn).negate());
        lap.addAssign(a.mul(c.x.mul(c.x).add(c.y.mul(c.y))).mul(cs).negate());
      });
      return vec4(h, sx, sy, lap);
    });
    this.waveAt = waveAt;
    /** One BAND of the spectrum (0 = wind sea, 1 = ripples), unscaled: what the per-frame bake writes. */
    const waveBand = (p, band) => waveAt(p, float(1 - band), float(band));

    // ── PER-FRAME BAKE 1: the two bands into tiling textures (64 sines per texel, once) ──
    const bakeRT = () => {
      const t = new THREE.RenderTarget(BAKE_RES, BAKE_RES, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
      t.texture.minFilter = THREE.LinearFilter;
      t.texture.magFilter = THREE.LinearFilter;
      t.texture.wrapS = THREE.RepeatWrapping;
      t.texture.wrapT = THREE.RepeatWrapping;
      t.texture.colorSpace = THREE.NoColorSpace;
      return t;
    };
    this.bandRT = [bakeRT(), bakeRT()];
    this.bandQuad = [0, 1].map((b) => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = Fn(() => waveBand(uv().mul(float(TILE_PX)), b))();
      return new THREE.QuadMesh(m);
    });

    // THE REAL WIND FIELD (Ingram: "use the actual wind texture ... we have a complex wind simulation so use it"):
    // the same handle every effect samples (gust fronts, turbulence; in the viewer also walls, shelter and the 3-D air
    // via the baked strength texture). Local strength ÷ the scene's speed = how sheltered or gusted this spot is.
    this.uTimeMs = uniform(float(0));
    this.ambient = {
      directionDeg: uniform(float(0)),
      speed01: uniform(float(0.1)),
      gustiness01: uniform(float(0.6)),
      pixelsPerMetre: uniform(float(PX_PER_M)),
    };
    this.windHandle = createWindHandle({ ambientWind: this.ambient });
    const ambient = this.ambient;
    const windHandle = this.windHandle;
    const uTimeMs = this.uTimeMs;
    this.uLocalWind = uniform(1);
    const localGains = (p) => {
      const v = windHandle.strengthNode(TSL, { centerXY: p, time: uTimeMs });
      const ratio = length(v).div(max(windStrength01Node(TSL, ambient.speed01), float(1e-3)));
      const r = mix(float(1), ratio, this.uLocalWind);
      return { gSea: pow(clamp(r, float(0.1), float(1.8)), float(0.5)), gRip: pow(clamp(r, float(0), float(2.2)), float(1.5)), r };
    };
    this.localGains = localGains;
    this.uView = uniform(new THREE.Vector4(0, 0, W, H)); // origin x, y, span x, span y (world px)
    const uView = this.uView;
    /** world px → view uv, the SAME mapping a view-sized quad and the splat camera use. */
    const uvW = (p) => vec2(p.x.sub(uView.x).div(uView.z), float(1).sub(p.y.sub(uView.y).div(uView.w)));
    const pFromUv = (u) => vec2(uView.x.add(u.x.mul(uView.z)), uView.y.add(float(1).sub(u.y).mul(uView.w)));
    this.uvW = uvW;
    // ── PER-FRAME BAKE 2: the local wind (the real gust field) at quarter res over the view ──
    this.windRT = new THREE.RenderTarget(W / 4, H / 4, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
    this.windRT.texture.minFilter = THREE.LinearFilter;
    this.windRT.texture.magFilter = THREE.LinearFilter;
    {
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = Fn(() => {
        const g0 = localGains(pFromUv(uv()));
        return vec4(g0.gSea, g0.gRip, g0.r, float(1));
      })();
      this.windQuad = new THREE.QuadMesh(m);
    }
    const windTex = this.windRT.texture;
    const bandTex = this.bandRT.map((t) => t.texture);
    /** THE surface anywhere: both band textures, scaled by the local wind there. */
    const surfAt = (p) => {
      const gw = texture(windTex, clamp(uvW(p), float(0.001), float(0.999)));
      const tuv = p.div(float(TILE_PX));
      return texture(bandTex[0], tuv).mul(gw.x).add(texture(bandTex[1], tuv).mul(gw.y));
    };
    this.surfAt = surfAt;
    this.uSun = uniform(new THREE.Vector3(0, 0, 1));
    this.uDepthPx = uniform(100);

    // ── CAUSTIC SPLAT: a photon grid over the view (+ a margin for the refraction run), one per depth slice ──
    this.caustRT = SLICES_M.map(() => {
      const t = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
      t.texture.minFilter = THREE.LinearFilter;
      t.texture.magFilter = THREE.LinearFilter;
      t.texture.colorSpace = THREE.NoColorSpace;
      return t;
    });
    const MARGIN = 300;
    const geo = new THREE.PlaneGeometry(1, 1, Math.ceil((W + 2 * MARGIN) / SPLAT_PX), Math.ceil((H + 2 * MARGIN) / SPLAT_PX));
    const splat = new THREE.MeshBasicNodeMaterial();
    const g = uv();
    const mW = uView.z.div(float(W)).mul(MARGIN);
    const mH = uView.w.div(float(H)).mul(MARGIN);
    const pS = vec2(uView.x.sub(mW).add(g.x.mul(uView.z.add(mW.mul(2)))), uView.y.sub(mH).add(g.y.mul(uView.w.add(mH.mul(2)))));
    const wS = surfAt(pS);
    const nS = normalize(vec3(wS.y.negate(), wS.z.negate(), float(1)));
    const R = refract(this.uSun.negate(), nS, float(1 / IOR));
    const tHit = this.uDepthPx.div(max(R.z.negate(), float(0.05)));
    const q = pS.add(R.xy.mul(tHit));
    const qUv = uvW(q);
    splat.positionNode = vec3(qUv.x, qUv.y, float(0));
    const vP = varying(pS);
    const vQ = varying(q);
    const area = (v) => abs(dFdx(v).x.mul(dFdy(v).y).sub(dFdx(v).y.mul(dFdy(v).x)));
    const inten = clamp(area(vP).div(max(area(vQ), float(1e-6))), float(0), float(60));
    splat.colorNode = vec4(inten, inten, inten, float(1));
    splat.blending = THREE.AdditiveBlending;
    splat.transparent = true;
    splat.depthTest = false;
    splat.depthWrite = false;
    splat.side = THREE.DoubleSide;
    this.splatMesh = new THREE.Mesh(geo, splat);
    this.splatMesh.frustumCulled = false;
    this.splatScene = new THREE.Scene();
    this.splatScene.add(this.splatMesh);
    this.splatCam = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);

    // ── COMPOSE: the water as seen from straight above ──
    this.uMode = uniform(0);
    this.uDepthMax = uniform(4);
    this.uGlintRough = uniform(0.1);
    this.uShafts = uniform(1);
    this.uCaustics = uniform(1);
    const uMode = this.uMode;

    const aces = (x0) => {
      const x = x0.mul(0.6);
      return clamp(x.mul(x.mul(2.51).add(0.03)).div(x.mul(x.mul(2.43).add(0.59)).add(0.14)), float(0), float(1));
    };
    const comp = new THREE.MeshBasicNodeMaterial();
    comp.colorNode = Fn(() => {
      const sUv = uv();
      const p = vec2(uView.x.add(sUv.x.mul(uView.z)), uView.y.add(float(1).sub(sUv.y).mul(uView.w)));
      // lab depth layout: dry beach at left, ramp to depthMax, a dry rock island, a deep hole
      const ramp = clamp(p.x.sub(140).div(900), float(0), float(1));
      const island = float(1).sub(smoothstep(float(60), float(78), length(p.sub(vec2(980, 250)))));
      const hole = smoothstep(float(160), float(60), length(p.sub(vec2(560, 560))));
      const depthM = max(ramp.mul(this.uDepthMax).add(hole.mul(1.5)).mul(float(1).sub(island)), float(0));
      const wet = smoothstep(float(0.0), float(0.03), depthM);
      const depthPx = depthM.mul(float(PX_PER_M));

      const lg = { r: texture(windTex, clamp(uvW(p), float(0.001), float(0.999))).z };
      const w = surfAt(p);
      const n = normalize(vec3(w.y.negate(), w.z.negate(), float(1)).mul(vec3(wet, wet, 1)));
      // the bed seen straight down through the bent surface
      const Rv = refract(vec3(0, 0, -1), n, float(1 / IOR));
      const bedP = p.add(Rv.xy.mul(depthPx.div(max(Rv.z.negate(), float(0.2)))));

      // bed albedo: sand, pebbles, weed, and the map grid (to see refraction)
      const sandN = mx_fractal_noise_float(vec3(bedP.mul(0.02), 0.0), 3, 2.0, 0.5);
      const peb = mx_worley_noise_float(bedP.mul(0.06));
      let alb = mix(vec3(0.58, 0.5, 0.36), vec3(0.72, 0.64, 0.48), smoothstep(float(-0.4), float(0.4), sandN));
      alb = mix(vec3(0.33, 0.3, 0.26), alb, smoothstep(float(0.08), float(0.2), peb));
      const gx = abs(bedP.x.div(100).sub(floor(bedP.x.div(100).add(0.5))));
      const gy = abs(bedP.y.div(100).sub(floor(bedP.y.div(100).add(0.5))));
      const gridL = float(1).sub(smoothstep(float(0.006), float(0.016), min(gx, gy)).oneMinus().mul(0.35));
      alb = alb.mul(gridL);

      // caustics at the bed: the slices, blended in log depth
      const tileUv = uvW(bedP);
      const ld = log(max(depthM, float(0.05)));
      const sliceAt = (i) => texture(this.caustRT[i].texture, tileUv).r;
      let caust = float(0);
      let wsum = float(0);
      const lds = SLICES_M.map((d) => Math.log(d));
      for (let i = 0; i < SLICES_M.length; i++) {
        const lo = i > 0 ? lds[i - 1] : lds[i] - 3;
        const hi = i < lds.length - 1 ? lds[i + 1] : lds[i] + 3;
        const wi = clamp(
          float(1).sub(
            abs(ld.sub(lds[i])).div(ld.lessThan(lds[i]).select(float(lds[i] - lo), float(hi - lds[i])))
          ),
          float(0),
          float(1)
        );
        caust = caust.add(sliceAt(i).mul(wi));
        wsum = wsum.add(wi);
      }
      caust = mix(float(1), caust.div(max(wsum, float(1e-4))), this.uCaustics);

      // light
      const L = this.uSun;
      const sunCol = vec3(1.0, 0.96, 0.88).mul(2.2);
      const skyCol = vec3(0.45, 0.6, 0.85);
      const Rs = refract(L.negate(), vec3(0, 0, 1), float(1 / IOR));
      const cosT = max(Rs.z.negate(), float(0.2));
      const sigma = vec3(0.45, 0.1, 0.075).add(vec3(0.12, 0.09, 0.1)); // pure water + a little turbidity, per m
      const fresnelIn = float(1).sub(float(0.02).add(float(0.98).mul(pow(float(1).sub(max(L.z, float(0))), 5))));
      const direct = sunCol.mul(cosT).mul(fresnelIn).mul(caust).mul(exp(sigma.negate().mul(depthM.div(cosT))));
      const ambient = skyCol.mul(0.55).mul(exp(sigma.negate().mul(depthM.mul(1.3))));
      const bedOut = alb.mul(direct.add(ambient)).mul(exp(sigma.negate().mul(depthM)));
      // volume: in-scatter plus SHAFTS (the caustic slices integrated down the column)
      const scatterCol = vec3(0.12, 0.42, 0.5);
      const volBase = scatterCol
        .mul(sunCol.mul(0.025).add(skyCol.mul(0.03)))
        .mul(float(1).sub(exp(sigma.negate().mul(depthM.mul(2)))));
      // SHAFTS: march the column from the surface to the bed. Between slices the light pattern is the nearest slice
      // carried along the refracted sun ray (its horizontal run per metre of depth = Rs.xy / −Rs.z), so a low sun
      // smears each focused bright spot into a streak down-sun: a shaft seen from above.
      const runPerM = Rs.xy.div(max(Rs.z.negate(), float(0.2))).mul(float(PX_PER_M));
      let shafts = vec3(0);
      const SUB = 4;
      for (let i = 0; i < SLICES_M.length; i++) {
        const zi = SLICES_M[i];
        const z0 = i > 0 ? SLICES_M[i - 1] : 0;
        for (let j = 0; j < SUB; j++) {
          const z = z0 + ((j + 0.5) / SUB) * (zi - z0);
          const dz = (zi - z0) / SUB;
          const inWater = smoothstep(float(z * 0.9), float(z * 1.05), depthM);
          const att = exp(sigma.negate().mul(z).mul(float(1).div(cosT).add(1)));
          const sp = uvW(p.sub(runPerM.mul(z - zi)));
          const ci = texture(this.caustRT[i].texture, sp).r;
          shafts = shafts.add(att.mul(ci.sub(0.6).max(0).mul(inWater).mul(dz)));
        }
      }
      shafts = shafts.mul(scatterCol).mul(sunCol).mul(0.09).mul(this.uShafts);
      const under = bedOut.add(volBase).add(shafts);

      // the surface: sky reflection + sun glint from the SAME normal
      // a real eye above the view centre (production's viewer height), so slopes catch the sun across the frame
      const eye = vec3(uView.x.add(uView.z.mul(0.5)), uView.y.add(uView.w.mul(0.5)), float(2600));
      const V = normalize(eye.sub(vec3(p.x, p.y, w.x)));
      const cosV = max(dot(n, V), float(0));
      const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(cosV), 5)));
      const Rr = reflect(V.negate(), n);
      const sky = mix(vec3(0.75, 0.82, 0.9), skyCol, clamp(Rr.z, float(0), float(1)));
      const Hh = normalize(L.add(V));
      const nh = max(dot(n, Hh), float(0));
      const a2 = this.uGlintRough.mul(this.uGlintRough);
      const dd = nh.mul(nh).mul(a2.sub(1)).add(1);
      const D = a2.div(dd.mul(dd).mul(Math.PI));
      const glint = sunCol.mul(D).mul(F.max(0.02)).mul(0.25).mul(max(L.z, float(0)));
      const water = under.mul(float(1).sub(F)).add(sky.mul(F)).add(glint);

      const land = alb.mul(sunCol.mul(max(L.z, float(0))).mul(0.5).add(skyCol.mul(0.5)));
      let col = mix(land, water, wet);

      // debug modes: 1 height, 2 slope, 3 caustic at bed, 4 shafts, 5 glint, 6 laplacian vs shallow caustic
      const hView = vec3(w.x.div(6).add(0.5));
      const sView = vec3(w.y.mul(2).add(0.5), w.z.mul(2).add(0.5), float(0.5));
      const cView = vec3(caust.mul(0.25));
      const lapView = vec3(w.w.negate().mul(120).add(0.5));
      const c0 = vec3(sliceAt(0).sub(1).mul(2).add(0.5));
      const m6 = sUv.x.lessThan(0.5).select(lapView, c0);
      col = uMode
        .equal(1)
        .select(
          hView,
          uMode
            .equal(2)
            .select(
              sView,
              uMode
                .equal(3)
                .select(
                  cView,
                  uMode
                    .equal(4)
                    .select(
                      shafts.mul(4),
                      uMode.equal(5).select(glint, uMode.equal(6).select(m6, uMode.equal(7).select(vec3(lg.r.mul(0.5)), aces(col))))
                    )
                )
            )
        );
      return vec4(pow(clamp(col, float(0), float(1)), vec3(1 / 2.2)), float(1));
    })();
    this.compQuad = new THREE.QuadMesh(comp);
    this.outRT = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.outRT.texture.colorSpace = THREE.NoColorSpace;
    this.apply();
    say('ready');
  }

  apply() {
    const p = this.p;
    this.spec = buildSpectrum(p);
    const t = p.time;
    const [fx, fy] = p.flowPx;
    for (let i = 0; i < K; i++) {
      const c = this.spec.comps[i] ?? { kx: 0, ky: 0, amp: 0, w: 0, ph: 0 };
      this.compData[i * 4] = c.kx;
      this.compData[i * 4 + 1] = c.ky;
      this.compData[i * 4 + 2] = c.amp;
      this.compData[i * 4 + 3] = c.w;
      // phase with time and the current folded in on the CPU, wrapped (no float blow-up at long times)
      const ph = c.ph - c.w * t - (c.kx * fx + c.ky * fy) * t;
      this.compData[(K + i) * 4] = ph - Math.floor(ph / (2 * Math.PI)) * 2 * Math.PI;
      this.compData[(K + i) * 4 + 1] = c.ripple ?? 0;
    }
    this.compTex.needsUpdate = true;
    const e = (p.sunElevDeg * Math.PI) / 180;
    const a = (p.sunAzDeg * Math.PI) / 180;
    this.uSun.value.set(Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e));
    this.uMode.value = p.mode;
    this.ambient.speed01.value = p.wind01;
    this.ambient.directionDeg.value = p.windDeg;
    this.ambient.gustiness01.value = p.gust ?? 0.6;
    this.uTimeMs.value = p.time * 1000;
    this.uLocalWind.value = p.localWind ?? 1;
    this.uDepthMax.value = p.depthMaxM;
    this.uGlintRough.value = Math.max(0.03, this.spec.glintRoughness * 1.4);
    this.uShafts.value = p.shafts;
    this.uCaustics.value = p.caustics;
    const span = 1 / p.zoom;
    this.uView.value.set(p.viewX, p.viewY, W * span, H * span);
  }

  set(o = {}) {
    Object.assign(this.p, o);
    this.apply();
    return this.info();
  }

  info() {
    const s = this.spec;
    return {
      U_ms: +s.U.toFixed(1),
      peakWavelength_m: +s.peakWavelengthM.toFixed(2),
      peakWavelength_px: Math.round(s.peakWavelengthPx),
      peakPeriod_s: +s.peakPeriodSec.toFixed(2),
      peakSpeed_px_s: Math.round(s.peakSpeedPxPerSec),
      Hs_m: +s.hsM.toFixed(3),
      slopeVar: +s.slopeVariance.toFixed(4),
      glintRough: +this.uGlintRough.value.toFixed(3),
    };
  }

  render() {
    const r = this.renderer;
    const prevAuto = r.autoClear;
    r.autoClear = false;
    for (let b = 0; b < 2; b++) {
      r.setRenderTarget(this.bandRT[b]);
      this.bandQuad[b].render(r);
    }
    r.setRenderTarget(this.windRT);
    this.windQuad.render(r);
    for (let i = 0; i < SLICES_M.length; i++) {
      this.uDepthPx.value = SLICES_M[i] * PX_PER_M;
      r.setRenderTarget(this.caustRT[i]);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(this.splatScene, this.splatCam);
    }
    r.setRenderTarget(this.outRT);
    this.compQuad.render(r);
    r.setRenderTarget(null);
    this.compQuad.render(r);
    r.autoClear = prevAuto;
  }

  async shot(name) {
    this.render();
    const bytes = await this.renderer.readRenderTargetPixelsAsync(this.outRT, 0, 0, W, H);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    img.data.set(bytes.subarray(0, W * H * 4));
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    return { name, dataUrl: c.toDataURL('image/png') };
  }
}

const lab = new WaveLab();
window.waveLab = lab;
lab.init().catch((e) => {
  say('init failed: ' + (e?.stack ?? e));
  console.error(e);
});
