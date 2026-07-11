/**
 * @fileoverview ForwardLightingPass — V3 lighting, modeled on Foundry v14,
 * with wall occlusion.
 *
 * Reproduces Foundry's `AdaptiveIllumination`/`AdaptiveColoration` lighting so
 * pre-authored maps light up the same way in the Three.js pipeline, and clips
 * each light to walls by rendering it inside its Foundry-computed
 * `ClockwiseSweepPolygon` (the same wall-aware shape Foundry itself renders) —
 * never recomputing occlusion (Forward+ §4.2 / §11: consume Foundry's polygons).
 *
 *   final = screen( albedo × illumination , coloration )
 *
 *   • **illumination** (Foundry blend MAX_COLOR — lights do NOT add/stack):
 *       per light: mix( ambientBg, switchColor(brightLevel, dimLevel, dist), falloff )
 *       brightLevel/dimLevel are ENVIRONMENT brightness colors (ambientDaylight/
 *       Darkness/Brightest + darkness weights), not the light's own color.
 *   • **coloration** (Foundry blend SCREEN): the light's color × colorationAlpha,
 *       modulated by the albedo's perceived brightness.
 *   • **switchColor**: smoothstep(ratio·(0.99−0.7·att), ratio·(1.01+0.7·att), dist)
 *       — bright core to `ratio`, fading to the dim ring; `att` widens it.
 *   • **falloff**: smoothstep(1.0, 1.0−attenuation, dist).
 *   • **ratio** = source.ratio = clamp(bright/max(dim,bright), 0, 1).
 *   • **attenuation** (user 0..1 → shader): (cos(π·a^1.5)−1)/−2.
 *   • **exposure** = luminosity·2−1.
 *
 * **Wall occlusion:** each light is a `THREE.ShapeGeometry` triangulated from
 * `lightSource.shape.points` (Foundry canvas coords → MSA world via
 * `Coordinates.toWorld`). Inside the polygon the shader computes `dist` from the
 * light center in world space and applies the falloff; outside the polygon (past
 * a wall) nothing is drawn, so the ambient base shows through — light stops at
 * walls. Geometry is cached per source and rebuilt only when Foundry replaces
 * the shape (light/wall change). The main camera is orthographic, so world
 * polygons align with the geometry with no unprojection.
 *
 * **Light set = `canvas.effects.lightSources`** — exactly the active, wall-aware
 * lights Foundry renders (so V3 matches Foundry's active lighting, including
 * level/elevation gating). GlobalLightSource and negative (darkness) sources are
 * skipped for now (the ambient base approximates global light; darkness lights
 * are a follow-up).
 *
 * **Still NOT matched (follow-ups):** indoor/outdoor darkness (per-pixel
 * `_Outdoors` mask), darkness/negative lights, non-default coloration techniques,
 * light animation, soft wall edges.
 *
 * @module compositor-v3/ForwardLightingPass
 */

import { createLogger } from '../core/log.js';
import { resolveGroundZ } from '../streaming/view-projection-service.js';
import { resolveViewedBandOutdoorsMask } from '../masks/indoor-outdoor-mask-api.js';
import { isV3IndoorOutdoorEnabled } from './v3-flags.js';

const log = createLogger('V3ForwardLighting');

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
// Illumination base: the ambient background, written into the illumination
// buffer (NOT multiplied by albedo — the composite step does albedo × illum).
//
// Indoor/outdoor: sample the scene's _Outdoors mask so indoor areas (no sky)
// get only the base darkness ambient while outdoor areas get the sky ambient.
// The view→world→sceneUv reconstruction + flip replicate ColorCorrectionEffectV2
// exactly (the proven scene-UV outdoors sampling convention).
const AMBIENT_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uOutdoorBg;   // sky ambient (mix daylight/darkness by darkness)
  uniform vec3 uIndoorBg;    // base darkness (no sky contribution)
  uniform sampler2D uOutdoorsMask;
  uniform float uHasOutdoors;
  uniform vec2 uViewMin;
  uniform vec2 uViewMax;
  uniform vec4 uSceneBounds;  // x, y, width, height (world space)
  uniform float uOutdoorsFlipY;
  varying vec2 vUv;
  void main() {
    float outdoors = 1.0;
    if (uHasOutdoors > 0.5) {
      vec2 worldXY = mix(uViewMin, uViewMax, vUv);
      vec2 sUv = vec2(
        (worldXY.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z),
        1.0 - ((worldXY.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w))
      );
      float inScene = step(0.0, sUv.x) * step(sUv.x, 1.0) * step(0.0, sUv.y) * step(sUv.y, 1.0);
      if (uOutdoorsFlipY > 0.5) sUv.y = 1.0 - sUv.y;
      float od = texture2D(uOutdoorsMask, clamp(sUv, vec2(0.0), vec2(1.0))).r;
      outdoors = mix(1.0, od, inScene); // outside the scene rect → treat as outdoor
    }
    gl_FragColor = vec4(mix(uIndoorBg, uOutdoorBg, outdoors), 1.0);
  }
`;

// Final composite: lit = albedo × illumination. Keeps the Foundry-light result
// identical to the old per-light albedo×illum bake (MAX(albedo·x)=albedo·MAX(x))
// while letting additive contributions (candle glow) into the illumination
// buffer light the map underneath.
const COMPOSITE_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tAlbedo;
  uniform sampler2D tIllum;
  varying vec2 vUv;
  void main() {
    vec3 albedo = texture2D(tAlbedo, vUv).rgb;
    vec3 illum = texture2D(tIllum, vUv).rgb;
    gl_FragColor = vec4(albedo * illum, 1.0);
  }
`;

// Light meshes are polygons in world space. The vertex shader forwards the
// world XY so the fragment can compute radial distance from the light center.
const POLY_VERT = /* glsl */`
  varying vec2 vWorldXY;
  void main() {
    vWorldXY = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LIGHT_HELPERS = /* glsl */`
  uniform vec2 uCenter;
  uniform float uRadiusPx;
  uniform float uRatio;
  uniform float uAttenuation;
  float msaFalloff(float dist) {
    if (uAttenuation <= 0.0) return 1.0;
    return smoothstep(1.0, 1.0 - uAttenuation, dist);
  }
  vec3 msaSwitchColor(vec3 inner, vec3 outer, float dist) {
    float a = uAttenuation * 0.7;
    return mix(inner, outer, smoothstep(uRatio * (0.99 - a), clamp(uRatio * (1.01 + a), 0.0001, 1.0), dist));
  }
`;

// Foundry-light illumination (MAX-blended into the illum buffer): the
// brightness levels, NOT multiplied by albedo (composite does that).
const ILLUM_FRAG = /* glsl */`
  precision highp float;
  ${LIGHT_HELPERS}
  varying vec2 vWorldXY;
  uniform vec3 uAmbientBg;
  uniform vec3 uDimColor;
  uniform vec3 uBrightColor;
  uniform float uExposure;
  void main() {
    float dist = length(vWorldXY - uCenter) / max(uRadiusPx, 1.0);
    if (dist > 1.0) discard;
    vec3 levels = msaSwitchColor(uBrightColor, uDimColor, dist);
    if (uExposure > 0.0) {
      float q = uExposure * 0.25;
      float as = uAttenuation * 0.25;
      float fe = q * (1.0 - smoothstep(uRatio * (0.98 - as), clamp(uRatio * (1.02 + as), 0.0001, 1.0), dist)) + q;
      levels *= (1.0 + fe);
    }
    float fall = msaFalloff(dist);
    gl_FragColor = vec4(mix(uAmbientBg, levels, fall), 1.0);
  }
`;

const COLO_FRAG = /* glsl */`
  precision highp float;
  ${LIGHT_HELPERS}
  varying vec2 vWorldXY;
  uniform sampler2D tAlbedo;
  uniform vec2 uResolution;
  uniform vec3 uColor;
  uniform float uColorationAlpha;
  float perceivedBrightness(vec3 c) { return sqrt(dot(c * c, vec3(0.299, 0.587, 0.114))); }
  void main() {
    float dist = length(vWorldXY - uCenter) / max(uRadiusPx, 1.0);
    if (dist > 1.0) discard;
    float fall = msaFalloff(dist);
    if (fall <= 0.0) discard;
    vec2 screenUv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
    vec3 albedo = texture2D(tAlbedo, screenUv).rgb;
    float reflection = perceivedBrightness(albedo);
    gl_FragColor = vec4(uColor * uColorationAlpha * reflection * fall, 1.0);
  }
`;

/** Foundry attenuation remap (base-light-source.mjs). */
function computeAttenuation(a) {
  const att = Number.isFinite(Number(a)) ? Number(a) : 0.5;
  return (Math.cos(Math.PI * Math.pow(att, 1.5)) - 1) / -2;
}

export class ForwardLightingPass {
  /** @param {object} [options] @param {any} [options.THREE] */
  constructor(options = {}) {
    this._THREE = options.THREE ?? (typeof window !== 'undefined' ? window.THREE : null);
    this._ambientScene = null;
    this._ambientCamera = null;
    this._ambientMat = null;
    this._compositeScene = null;
    this._compositeMat = null;
    this._illumScene = null;
    this._coloScene = null;
    /** @type {Map<any, {illumMesh:any, illumMat:any, coloMesh:any, coloMat:any, geo:any, shapeRef:any}>} keyed by light source. */
    this._lights = new Map();
    this._built = false;
  }

  /** @param {any} THREE @private */
  _ensure(THREE) {
    if (this._built || !THREE) return;
    this._ambientScene = new THREE.Scene();
    this._ambientCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._ambientMat = new THREE.ShaderMaterial({
      uniforms: {
        uOutdoorBg: { value: new THREE.Vector3(1, 1, 1) },
        uIndoorBg: { value: new THREE.Vector3(0, 0, 0) },
        uOutdoorsMask: { value: null },
        uHasOutdoors: { value: 0 },
        uViewMin: { value: new THREE.Vector2(0, 0) },
        uViewMax: { value: new THREE.Vector2(1, 1) },
        uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        uOutdoorsFlipY: { value: 0 },
      },
      vertexShader: QUAD_VERT, fragmentShader: AMBIENT_FRAG,
      depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending,
    });
    this._ambientMat.toneMapped = false;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._ambientMat);
    quad.frustumCulled = false;
    this._ambientScene.add(quad);

    // Composite: lit = albedo × illum (fullscreen, shares the ortho camera).
    this._compositeScene = new THREE.Scene();
    this._compositeMat = new THREE.ShaderMaterial({
      uniforms: { tAlbedo: { value: null }, tIllum: { value: null } },
      vertexShader: QUAD_VERT, fragmentShader: COMPOSITE_FRAG,
      depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending,
    });
    this._compositeMat.toneMapped = false;
    const cquad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._compositeMat);
    cquad.frustumCulled = false;
    this._compositeScene.add(cquad);

    this._illumScene = new THREE.Scene();
    this._coloScene = new THREE.Scene();
    this._built = true;
    log.debug('ForwardLightingPass initialized (illumination buffer + Foundry model + occlusion)');
  }

  /**
   * Read Foundry's environment brightness colors → ambient bg + dim/bright levels
   * (COMPUTE_ILLUMINATION on the CPU).
   * @returns {{bg:number[], dim:number[], bright:number[]}}
   * @private
   */
  _environment() {
    const rgb = (c, fb) => { try { if (c && Array.isArray(c.rgb)) return c.rgb; if (Array.isArray(c)) return c; } catch (_) {} return fb; };
    let darkness = 0, daylight = [1, 1, 1], darknessColor = [0, 0, 0], brightest = [1, 1, 1], wBright = 1, wDim = 0.5;
    try {
      const env = globalThis.canvas?.environment; const cols = globalThis.canvas?.colors;
      if (Number.isFinite(Number(env?.darknessLevel))) darkness = Math.max(0, Math.min(1, Number(env.darknessLevel)));
      daylight = rgb(cols?.ambientDaylight, daylight);
      darknessColor = rgb(cols?.ambientDarkness, darknessColor);
      brightest = rgb(cols?.ambientBrightest, brightest);
      if (Number.isFinite(Number(env?.weights?.bright))) wBright = Number(env.weights.bright);
      if (Number.isFinite(Number(env?.weights?.dim))) wDim = Number(env.weights.dim);
    } catch (_) {}
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const maxc = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
    const bg = mix(daylight, darknessColor, darkness);
    let bright = mix(bg, brightest, wBright);
    let dim = mix(bg, bright, wDim);
    // `indoorBg` = the base darkness with no sky contribution: indoor areas get
    // this (dark, lit only by local lights); outdoor areas get `bg`.
    return { bg, indoorBg: darknessColor, dim: maxc(dim, bg), bright: maxc(bright, bg) };
  }

  /**
   * Resolve the viewed-floor _Outdoors mask and set the ambient pass's outdoors
   * uniforms (view/scene bounds + flip), replicating ColorCorrectionEffectV2's
   * proven scene-UV convention. Falls back to `uHasOutdoors = 0` (uniform sky
   * ambient — the prior behavior) when disabled or no mask is available, so it
   * can never regress; only aligned indoor darkening is added.
   * @param {THREE.Camera} camera
   * @private
   */
  _syncOutdoorsUniforms(camera) {
    const au = this._ambientMat.uniforms;
    au.uHasOutdoors.value = 0;
    if (!isV3IndoorOutdoorEnabled()) return;

    let tex = null;
    try {
      const comp = globalThis.window?.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
      if (comp) {
        const ctx = globalThis.window?.MapShine?.activeLevelContext ?? null;
        const res = resolveViewedBandOutdoorsMask(comp, ctx, { preferEffectiveStack: false });
        tex = res?.texture ?? null;
      }
    } catch (_) {}
    if (!tex) return;

    try {
      const sr = globalThis.canvas?.dimensions?.sceneRect;
      au.uSceneBounds.value.set(sr?.x ?? 0, sr?.y ?? 0, sr?.width ?? 1, sr?.height ?? 1);
    } catch (_) {}
    if (camera?.isOrthographicCamera) {
      const p = camera.position; const z = camera.zoom || 1;
      au.uViewMin.value.set(p.x + camera.left / z, p.y + camera.bottom / z);
      au.uViewMax.value.set(p.x + camera.right / z, p.y + camera.top / z);
    }
    au.uOutdoorsMask.value = tex;
    au.uOutdoorsFlipY.value = tex.flipY ? 1 : 0;
    au.uHasOutdoors.value = 1;
  }

  /** @param {any} THREE @returns {{illumMesh:any, illumMat:any, coloMesh:any, coloMat:any, geo:any, shapeRef:any}} @private */
  _createEntry(THREE) {
    const base = () => ({
      tAlbedo: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uRadiusPx: { value: 1 },
      uRatio: { value: 0.5 },
      uAttenuation: { value: 0.5 },
    });
    const illumMat = new THREE.ShaderMaterial({
      uniforms: { ...base(), uAmbientBg: { value: new THREE.Vector3(0, 0, 0) }, uDimColor: { value: new THREE.Vector3(1, 1, 1) }, uBrightColor: { value: new THREE.Vector3(1, 1, 1) }, uExposure: { value: 0 } },
      vertexShader: POLY_VERT, fragmentShader: ILLUM_FRAG,
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    illumMat.toneMapped = false;
    const coloMat = new THREE.ShaderMaterial({
      uniforms: { ...base(), uColor: { value: new THREE.Vector3(1, 1, 1) }, uColorationAlpha: { value: 1 } },
      vertexShader: POLY_VERT, fragmentShader: COLO_FRAG,
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor,
    });
    coloMat.toneMapped = false;
    const illumMesh = new THREE.Mesh(undefined, illumMat);
    const coloMesh = new THREE.Mesh(undefined, coloMat);
    for (const m of [illumMesh, coloMesh]) { m.frustumCulled = false; m.layers.set(0); m.visible = false; }
    this._illumScene.add(illumMesh);
    this._coloScene.add(coloMesh);
    return { illumMesh, illumMat, coloMesh, coloMat, geo: null, shapeRef: null };
  }

  /**
   * Build a ShapeGeometry from a Foundry polygon (flat [x,y,...] canvas coords),
   * converted to MSA world space.
   * @param {any} THREE @param {number[]} pts @param {number} h - canvas height
   * @returns {any|null}
   * @private
   */
  _buildGeometry(THREE, pts, h) {
    if (!pts || pts.length < 6) return null;
    const shape = new THREE.Shape();
    shape.moveTo(pts[0], h - pts[1]);
    for (let i = 2; i < pts.length; i += 2) shape.lineTo(pts[i], h - pts[i + 1]);
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }

  /**
   * Sync per-light polygon meshes from `canvas.effects.lightSources`.
   * @param {any} THREE @param {{bg:number[], dim:number[], bright:number[]}} env
   * @returns {number} live light count
   * @private
   */
  _syncLights(THREE, env) {
    const sources = globalThis.canvas?.effects?.lightSources;
    if (!sources) { this._pruneAll(); return 0; }
    let h = 0;
    try { h = Number(globalThis.canvas?.dimensions?.height) || 0; } catch (_) {}
    // Place light polygons at the bus ground plane so they sit inside the
    // orthographic camera's near/far frustum (geometry is at Z=0 otherwise, and
    // ortho clips by Z; XY projection is Z-independent so alignment is exact).
    let groundZ = 0;
    try { groundZ = Number(resolveGroundZ()) || 0; } catch (_) {}

    const seen = new Set();
    let live = 0;
    for (const src of sources) {
      try {
        if (!src?.active) continue;
        if (src.constructor?.name === 'GlobalLightSource') continue;
        if (src.data?.negative === true || src.isDarkness === true) continue;
        const shape = src.shape;
        const pts = shape?.points;
        if (!pts || pts.length < 6) continue;

        let entry = this._lights.get(src);
        if (!entry) { entry = this._createEntry(THREE); this._lights.set(src, entry); }
        seen.add(src);

        // Rebuild geometry only when Foundry replaced the shape (light/wall change).
        if (entry.shapeRef !== shape) {
          const geo = this._buildGeometry(THREE, pts, h);
          if (geo) {
            try { entry.geo?.dispose?.(); } catch (_) {}
            entry.geo = geo;
            entry.illumMesh.geometry = geo;
            entry.coloMesh.geometry = geo;
          }
          entry.shapeRef = shape;
        }
        if (!entry.geo) continue;

        const radiusPx = Number(shape.config?.radius) || Number(src.data?.radius) || 1;
        const ratio = Number.isFinite(Number(src.ratio)) ? Math.max(0, Math.min(1, Number(src.ratio))) : 0.5;
        const attenuation = computeAttenuation(src.data?.attenuation ?? 0.5);
        const luminosity = Number.isFinite(Number(src.data?.luminosity)) ? Number(src.data.luminosity) : 0.5;
        const exposure = luminosity * 2 - 1;
        const alpha = Number.isFinite(Number(src.data?.alpha)) ? Number(src.data.alpha) : 0.5;
        const colorationAlpha = alpha * 2;
        const col = Array.isArray(src.colorRGB) ? src.colorRGB : [1, 1, 1];
        const cx = Number(src.data?.x) || 0;
        const cy = Number(src.data?.y) || 0;
        const worldCx = cx;
        const worldCy = h - cy;

        entry.illumMesh.visible = entry.coloMesh.visible = true;
        entry.illumMesh.position.z = groundZ;
        entry.coloMesh.position.z = groundZ;
        const iu = entry.illumMat.uniforms;
        iu.uCenter.value.set(worldCx, worldCy); iu.uRadiusPx.value = radiusPx;
        iu.uRatio.value = ratio; iu.uAttenuation.value = attenuation; iu.uExposure.value = exposure;
        iu.uAmbientBg.value.set(env.bg[0], env.bg[1], env.bg[2]);
        iu.uDimColor.value.set(env.dim[0], env.dim[1], env.dim[2]);
        iu.uBrightColor.value.set(env.bright[0], env.bright[1], env.bright[2]);
        const cu = entry.coloMat.uniforms;
        cu.uCenter.value.set(worldCx, worldCy); cu.uRadiusPx.value = radiusPx;
        cu.uRatio.value = ratio; cu.uAttenuation.value = attenuation;
        cu.uColor.value.set(col[0], col[1], col[2]); cu.uColorationAlpha.value = colorationAlpha;
        live += 1;
      } catch (err) {
        log.debug('light source sync skipped', err);
      }
    }

    // Prune entries whose source is gone.
    for (const [src, entry] of this._lights) {
      if (!seen.has(src)) this._disposeEntry(entry), this._lights.delete(src);
    }
    return live;
  }

  /** @private */
  _pruneAll() {
    for (const [, entry] of this._lights) this._disposeEntry(entry);
    this._lights.clear();
  }

  /** @param {object} entry @private */
  _disposeEntry(entry) {
    try { this._illumScene?.remove(entry.illumMesh); } catch (_) {}
    try { this._coloScene?.remove(entry.coloMesh); } catch (_) {}
    try { entry.geo?.dispose?.(); } catch (_) {}
    try { entry.illumMat?.dispose?.(); } catch (_) {}
    try { entry.coloMat?.dispose?.(); } catch (_) {}
  }

  /**
   * @param {THREE.WebGLRenderer} renderer @param {THREE.Camera} camera
   * @param {THREE.Texture} albedoTexture - linear albedo (scene.color)
   * @param {THREE.WebGLRenderTarget} illumRT - illumination buffer (scene.illum)
   * @param {THREE.WebGLRenderTarget} litRT - lit output (scene.lit)
   * @param {{width:number, height:number}} size
   * @param {Array<any>} [glowGroups] - additive glow meshes (candle glow, …)
   *   rendered into the illumination buffer so they light the map.
   * @returns {boolean}
   */
  render(renderer, camera, albedoTexture, illumRT, litRT, size, glowGroups = null) {
    const THREE = this._THREE ?? (typeof window !== 'undefined' ? window.THREE : null);
    if (!renderer || !albedoTexture || !illumRT || !litRT || !THREE) return false;
    this._ensure(THREE);
    const width = Math.max(1, Number(size?.width) || 1);
    const height = Math.max(1, Number(size?.height) || 1);

    const env = this._environment();
    const au = this._ambientMat.uniforms;
    au.uOutdoorBg.value.set(env.bg[0], env.bg[1], env.bg[2]);
    au.uIndoorBg.value.set(env.indoorBg[0], env.indoorBg[1], env.indoorBg[2]);
    this._syncOutdoorsUniforms(camera);

    let live = 0;
    try { live = this._syncLights(THREE, env); } catch (err) { log.warn('light sync failed; ambient only', err); }
    for (const [, entry] of this._lights) {
      if (!entry.coloMesh.visible) continue;
      entry.coloMat.uniforms.tAlbedo.value = albedoTexture;
      entry.coloMat.uniforms.uResolution.value.set(width, height);
    }

    const groups = Array.isArray(glowGroups) ? glowGroups.filter((g) => g && g.children?.length > 0) : [];

    const prevTarget = renderer.getRenderTarget?.();
    const prevAutoClear = renderer.autoClear;
    const prevLayerMask = camera?.layers?.mask;
    try {
      renderer.autoClear = false;

      // ── Pass 1: illumination buffer (bg base + Foundry lights MAX + glow add) ─
      renderer.setRenderTarget(illumRT);
      if (typeof renderer.clear === 'function') renderer.clear(true, true, true);
      renderer.render(this._ambientScene, this._ambientCamera); // illum = bg
      if (live > 0 && camera) {
        if (camera.layers?.set) camera.layers.set(0);
        renderer.render(this._illumScene, camera); // Foundry lights, MAX
      }
      if (groups.length && camera) {
        if (camera.layers?.enableAll) camera.layers.enableAll(); // glow uses per-point layers
        for (const g of groups) {
          try { renderer.render(g, camera); } catch (_) {} // glow meshes' own additive blend
        }
      }

      // ── Pass 2: composite lit = albedo × illum, then screen coloration ────────
      this._compositeMat.uniforms.tAlbedo.value = albedoTexture;
      this._compositeMat.uniforms.tIllum.value = illumRT.texture;
      renderer.setRenderTarget(litRT);
      if (typeof renderer.clear === 'function') renderer.clear(true, true, true);
      renderer.render(this._compositeScene, this._ambientCamera);
      if (live > 0 && camera) {
        if (camera.layers?.set) camera.layers.set(0);
        renderer.render(this._coloScene, camera); // coloration, SCREEN
      }
    } catch (err) {
      log.warn('lighting render failed', err);
      return false;
    } finally {
      if (camera?.layers && prevLayerMask != null) camera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      try { renderer.setRenderTarget(prevTarget ?? null); } catch (_) {}
    }
    return true;
  }

  dispose() {
    try { this._ambientMat?.dispose?.(); } catch (_) {}
    try { this._compositeMat?.dispose?.(); } catch (_) {}
    this._pruneAll();
    this._ambientScene = null; this._compositeScene = null;
    this._illumScene = null; this._coloScene = null; this._built = false;
  }
}
