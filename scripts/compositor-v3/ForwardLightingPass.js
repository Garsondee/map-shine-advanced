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
import {
  resolveViewedBandOutdoorsMask,
  collectCompositorFloorCandidateKeys,
} from '../masks/indoor-outdoor-mask-api.js';
import { isV3IndoorOutdoorEnabled, isV3OutdoorsDebugEnabled } from './v3-flags.js';

const log = createLogger('V3ForwardLighting');

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Shared indoor/outdoor sampling — used by the ambient base AND every light's
// illumination shader, so both agree on the per-pixel ambient. The scene-UV
// reconstruction + flip replicate ColorCorrectionEffectV2 exactly (the proven
// convention). `msaAmbientBase` = the ambient this pixel would have with no
// lights: indoor darkness where the _Outdoors mask says indoor, sky ambient
// where it says outdoor (or everywhere when no mask is bound).
const OUTDOORS_HELPERS = /* glsl */`
  uniform sampler2D uOutdoorsMask;
  uniform float uHasOutdoors;
  uniform vec4 uSceneBounds;  // x, y, width, height (world space)
  uniform float uOutdoorsFlipY;
  uniform vec3 uOutdoorBg;   // sky ambient (mix daylight/darkness by darkness)
  uniform vec3 uIndoorBg;    // base darkness (no sky contribution)
  float msaOutdoors(vec2 worldXY) {
    if (uHasOutdoors < 0.5) return 1.0;
    vec2 sUv = vec2(
      (worldXY.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z),
      1.0 - ((worldXY.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w))
    );
    float inScene = step(0.0, sUv.x) * step(sUv.x, 1.0) * step(0.0, sUv.y) * step(sUv.y, 1.0);
    if (uOutdoorsFlipY > 0.5) sUv.y = 1.0 - sUv.y;
    // Authoritative _Outdoors decode — matches ColorCorrectionEffectV2 /
    // LightingEffectV2 / water (waterTimelineIndoorWeight). Outdoor value is
    // max(rgb) with a soft 0.18..0.82 band and hard <=0.10 / >=0.90 stops; the
    // ALPHA channel gates validity — where alpha < 0.5 the pixel is unauthored
    // and defaults to outdoor. (A naive .r read reports outdoor everywhere when
    // the signal lives in g/b or the alpha-validity channel — the all-green bug.)
    vec4 od = texture2D(uOutdoorsMask, clamp(sUv, vec2(0.0), vec2(1.0)));
    float raw = clamp(max(od.r, max(od.g, od.b)), 0.0, 1.0);
    float mid = smoothstep(0.18, 0.82, raw);
    float outdoorClass = (raw <= 0.10) ? 0.0 : ((raw >= 0.90) ? 1.0 : mid);
    float alphaValid = step(0.5, clamp(od.a, 0.0, 1.0));
    float outdoors = mix(1.0, outdoorClass, alphaValid);
    return mix(1.0, outdoors, inScene); // outside the scene rect → treat as outdoor
  }
  vec3 msaAmbientBase(vec2 worldXY) {
    return mix(uIndoorBg, uOutdoorBg, msaOutdoors(worldXY));
  }
`;

// Illumination base: the ambient background, written into the illumination
// buffer (NOT multiplied by albedo — the composite step does albedo × illum).
const AMBIENT_FRAG = /* glsl */`
  precision highp float;
  ${OUTDOORS_HELPERS}
  uniform vec2 uViewMin;
  uniform vec2 uViewMax;
  varying vec2 vUv;
  void main() {
    vec2 worldXY = mix(uViewMin, uViewMax, vUv);
    gl_FragColor = vec4(msaAmbientBase(worldXY), 1.0);
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
//
// The falloff blends from the PER-PIXEL ambient base (indoor or outdoor, same
// _Outdoors sample as the ambient pass), not a global outdoor floor. With MAX
// blending, a global outdoor floor here would erase indoor darkening inside
// every light's polygon — MAX(indoorDark, outdoorBg) = outdoorBg — which made
// indoor/outdoor invisible on light-dense interiors (the Mansion bug).
const ILLUM_FRAG = /* glsl */`
  precision highp float;
  ${LIGHT_HELPERS}
  ${OUTDOORS_HELPERS}
  varying vec2 vWorldXY;
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
    gl_FragColor = vec4(mix(msaAmbientBase(vWorldXY), levels, fall), 1.0);
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
    /**
     * Resolved _Outdoors state for this frame, shared by the ambient pass and
     * every light's illumination shader (and read by {@link debugOutdoorsResolve}).
     * @type {{tex: any, flipY: boolean, sb: {x:number,y:number,w:number,h:number}, route: string|null, floorKey: string|null}|null}
     */
    this._outdoorsState = null;
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
      // Prefer LightingDirector's merged masterDarkness (Foundry slider + calendar
      // time-of-day + weather, resolved by the darknessPriority policy) over the raw
      // Foundry darknessLevel. Fall back to the raw value before the director has
      // produced state (frameId 0 = neutral, never updated). B2 GAP-A.
      let darknessResolved = null;
      try {
        const ds = globalThis.window?.MapShine?.lightingDirector?.get?.();
        if (ds && ds.frameId > 0 && Number.isFinite(Number(ds.masterDarkness))) darknessResolved = Number(ds.masterDarkness);
      } catch (_) {}
      if (darknessResolved == null && Number.isFinite(Number(env?.darknessLevel))) darknessResolved = Number(env.darknessLevel);
      if (Number.isFinite(Number(darknessResolved))) darkness = Math.max(0, Math.min(1, Number(darknessResolved)));
      daylight = rgb(cols?.ambientDaylight, daylight);
      darknessColor = rgb(cols?.ambientDarkness, darknessColor);
      brightest = rgb(cols?.ambientBrightest, brightest);
      if (Number.isFinite(Number(env?.weights?.bright))) wBright = Number(env.weights.bright);
      if (Number.isFinite(Number(env?.weights?.dim))) wDim = Number(env.weights.dim);
    } catch (_) {}
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const maxc = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
    // Light LEVELS (what a light's core/ring fade TO) stay on the Foundry
    // brightness model.
    const foundryBase = mix(daylight, darknessColor, darkness);
    let bright = mix(foundryBase, brightest, wBright);
    let dim = mix(foundryBase, bright, wDim);

    // Ambient ENDPOINTS (the no-light base; what lights fade FROM) come from V2's
    // ambient model so the "Ambient light (linear HDR)" control — the Day/Night ×
    // indoor/outdoor sliders on LightingEffectV2 — actually drives V3, and V3
    // reproduces the V2 ambient look. Reached via a runtime handle
    // (window.MapShine.__ambientCompose) rather than a static import, to keep the
    // LightingDirector→WeatherController circular dep out of V3's Node test bundle.
    // Falls back to the Foundry day/night mix (outdoor) / darkness (indoor) when
    // the V2 lighting effect isn't available, so it can't regress.
    let outdoorBg = foundryBase;
    let indoorBg = darknessColor;
    try {
      const compose = globalThis.window?.MapShine?.__ambientCompose;
      if (compose) {
        const le = globalThis.window?.MapShine?.floorCompositorV2?._lightingEffect ?? null;
        const o = compose.outdoor?.({ lightingEffect: le });
        const i = compose.indoor?.({ lightingEffect: le });
        const ok = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
        if (ok(o)) outdoorBg = o;
        if (ok(i)) indoorBg = i;
      }
    } catch (_) {}

    // `indoorBg` = the no-sky indoor base (indoor areas get this, lit by local
    // lights); `bg` = the outdoor/sky base. Light levels are floored at the
    // outdoor base so a light never reads darker than ambient.
    return { bg: outdoorBg, indoorBg, dim: maxc(dim, outdoorBg), bright: maxc(bright, outdoorBg) };
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
    this._outdoorsState = null;
    if (!isV3IndoorOutdoorEnabled()) return;

    let tex = null;
    let route = null;
    let floorKey = null;
    try {
      const comp = globalThis.window?.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
      if (comp) {
        const ctx = globalThis.window?.MapShine?.activeLevelContext ?? null;
        const res = resolveViewedBandOutdoorsMask(comp, ctx, { preferEffectiveStack: false });
        tex = res?.texture ?? null;
        route = res?.route ?? null;
        floorKey = res?.floorKey ?? null;
      }
    } catch (_) {}
    if (!tex) return;

    const sb = { x: 0, y: 0, w: 1, h: 1 };
    try {
      const sr = globalThis.canvas?.dimensions?.sceneRect;
      sb.x = sr?.x ?? 0; sb.y = sr?.y ?? 0; sb.w = sr?.width ?? 1; sb.h = sr?.height ?? 1;
    } catch (_) {}
    au.uSceneBounds.value.set(sb.x, sb.y, sb.w, sb.h);

    // World-space view rectangle for the fullscreen ambient pass. Compute it by
    // UNPROJECTING the screen corners — robust even though the passed camera
    // reports isOrthographicCamera=false (which had left the bounds at their
    // (0,0)-(1,1) initializers, putting every pixel outside the scene rect → the
    // all-outdoor/all-green bug). vUv(0,0) is screen bottom-left = NDC(-1,-1);
    // vUv(1,1) is top-right = NDC(1,1). Ortho left/right/zoom formula is the fallback.
    let viewOk = false;
    const THREE = this._THREE ?? (typeof window !== 'undefined' ? window.THREE : null);
    try {
      if (THREE && camera && typeof camera.unproject === 'function') {
        if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld();
        const bl = new THREE.Vector3(-1, -1, 0).unproject(camera);
        const tr = new THREE.Vector3(1, 1, 0).unproject(camera);
        if (Number.isFinite(bl.x) && Number.isFinite(bl.y)
          && Number.isFinite(tr.x) && Number.isFinite(tr.y)
          && Math.abs(tr.x - bl.x) > 1e-3 && Math.abs(tr.y - bl.y) > 1e-3) {
          au.uViewMin.value.set(bl.x, bl.y);
          au.uViewMax.value.set(tr.x, tr.y);
          viewOk = true;
        }
      }
    } catch (_) {}
    if (!viewOk && camera?.isOrthographicCamera) {
      const p = camera.position; const z = camera.zoom || 1;
      au.uViewMin.value.set(p.x + camera.left / z, p.y + camera.bottom / z);
      au.uViewMax.value.set(p.x + camera.right / z, p.y + camera.top / z);
      viewOk = true;
    }

    au.uOutdoorsMask.value = tex;
    au.uOutdoorsFlipY.value = tex.flipY ? 1 : 0;
    au.uHasOutdoors.value = 1;
    // Share with the per-light illumination shaders (set in _syncLights).
    this._outdoorsState = {
      tex, flipY: !!tex.flipY, sb, route, floorKey, viewOk,
      viewMin: [au.uViewMin.value.x, au.uViewMin.value.y],
      viewMax: [au.uViewMax.value.x, au.uViewMax.value.y],
    };
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
      uniforms: {
        ...base(),
        uDimColor: { value: new THREE.Vector3(1, 1, 1) },
        uBrightColor: { value: new THREE.Vector3(1, 1, 1) },
        uExposure: { value: 0 },
        // OUTDOORS_HELPERS — per-pixel ambient base (indoor/outdoor) the light
        // falloff blends from; synced from _outdoorsState each frame.
        uOutdoorsMask: { value: null },
        uHasOutdoors: { value: 0 },
        uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        uOutdoorsFlipY: { value: 0 },
        uOutdoorBg: { value: new THREE.Vector3(1, 1, 1) },
        uIndoorBg: { value: new THREE.Vector3(0, 0, 0) },
      },
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
   * @param {{out:number[], indoor:number[]}} baseEndpoints - debug-aware ambient
   *   endpoints the light falloff blends from (match the ambient pass exactly).
   * @returns {number} live light count
   * @private
   */
  _syncLights(THREE, env, baseEndpoints) {
    const ods = this._outdoorsState;
    const bOut = baseEndpoints?.out ?? env.bg;
    const bIn = baseEndpoints?.indoor ?? env.indoorBg;
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
        // Per-pixel ambient base (indoor/outdoor) — same state as the ambient pass.
        iu.uOutdoorsMask.value = ods?.tex ?? null;
        iu.uHasOutdoors.value = ods?.tex ? 1 : 0;
        if (ods) {
          iu.uSceneBounds.value.set(ods.sb.x, ods.sb.y, ods.sb.w, ods.sb.h);
          iu.uOutdoorsFlipY.value = ods.flipY ? 1 : 0;
        }
        iu.uOutdoorBg.value.set(bOut[0], bOut[1], bOut[2]);
        iu.uIndoorBg.value.set(bIn[0], bIn[1], bIn[2]);
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
    // Debug tint (MapShine.v3.outdoorsDebug(true)): paint the ambient endpoints
    // red (indoor) / green (outdoor) so mask resolve + alignment are visible at a
    // glance. Lights still render on top (they blend from the tinted base).
    const dbg = isV3OutdoorsDebugEnabled();
    const baseEndpoints = {
      out: dbg ? [0.05, 0.85, 0.05] : env.bg,
      indoor: dbg ? [0.85, 0.05, 0.05] : env.indoorBg,
    };
    const au = this._ambientMat.uniforms;
    au.uOutdoorBg.value.set(baseEndpoints.out[0], baseEndpoints.out[1], baseEndpoints.out[2]);
    au.uIndoorBg.value.set(baseEndpoints.indoor[0], baseEndpoints.indoor[1], baseEndpoints.indoor[2]);
    this._syncOutdoorsUniforms(camera);

    let live = 0;
    try { live = this._syncLights(THREE, env, baseEndpoints); } catch (err) { log.warn('light sync failed; ambient only', err); }
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

  /**
   * One-call diagnostic for the indoor/outdoor path (console:
   * `MapShine.v3.outdoors()`). Reports every step of the exact resolve the
   * lighting pass performs, so a "nothing changes" report can be pinpointed to
   * a missing handle, an empty floor cache, a failed resolve, or (if all of
   * those pass) the shader/UV side — without another guess-and-reupload cycle.
   * @returns {object}
   */
  debugOutdoorsResolve() {
    const report = {
      indoorOutdoorFlag: isV3IndoorOutdoorEnabled(),
      outdoorsDebugTint: isV3OutdoorsDebugEnabled(),
      sceneLoading: globalThis.window?.MapShine?.__msaSceneLoading === true,
      maskCompositor: false,
      activeLevelContext: null,
      activeFloor: null,
      candidateKeys: [],
      floorCacheOutdoors: [],
      resolve: null,
      lastFrame: null,
      ambientUniforms: null,
    };
    try {
      const ms = globalThis.window?.MapShine ?? {};
      const comp = ms.sceneComposer?._sceneMaskCompositor ?? null;
      report.maskCompositor = !!comp;
      const ctx = ms.activeLevelContext ?? null;
      report.activeLevelContext = ctx ? { bottom: ctx.bottom ?? null, top: ctx.top ?? null } : null;
      const af = ms.floorStack?.getActiveFloor?.() ?? null;
      report.activeFloor = af
        ? { index: af.index ?? null, compositorKey: af.compositorKey != null ? String(af.compositorKey) : null }
        : null;
      if (comp) {
        try {
          report.candidateKeys = collectCompositorFloorCandidateKeys(comp, ctx).uniqueKeys;
        } catch (err) { report.candidateKeys = [`<error: ${err?.message ?? err}>`]; }
        try {
          const rows = [];
          const cache = comp._floorCache;
          if (cache && typeof cache.entries === 'function') {
            for (const [k, m] of cache.entries()) {
              const od = m?.get?.('outdoors')?.texture ?? null;
              rows.push({
                key: String(k),
                hasOutdoors: !!od,
                w: od?.image?.width ?? null,
                h: od?.image?.height ?? null,
                bundleBake: !!od?.userData?.msaBundleBake,
              });
            }
          }
          report.floorCacheOutdoors = rows;
        } catch (err) { report.floorCacheOutdoors = [`<error: ${err?.message ?? err}>`]; }
        try {
          const res = resolveViewedBandOutdoorsMask(comp, ctx, { preferEffectiveStack: false });
          report.resolve = {
            hasTexture: !!res?.texture,
            route: res?.route ?? null,
            floorKey: res?.floorKey ?? null,
            flipY: res?.texture ? !!res.texture.flipY : null,
            w: res?.texture?.image?.width ?? null,
            h: res?.texture?.image?.height ?? null,
          };
        } catch (err) { report.resolve = { error: String(err?.message ?? err) }; }

        // Read back a grid of mask pixels to distinguish the remaining causes:
        // uniform-white content (bake bug) vs. real structure (→ suspect UV) vs.
        // value living in a channel other than .r. One-shot; safe for a manual call.
        try {
          const renderer = globalThis.window?.MapShine?.floorCompositorV2?.renderer
            ?? globalThis.window?.MapShine?.renderer ?? null;
          const fk = report.resolve?.floorKey;
          const rt = (fk && comp?._floorCache?.get?.(fk)?.get?.('outdoors')) || null;
          if (renderer && rt && typeof renderer.readRenderTargetPixels === 'function'
            && Number(rt.width) > 0 && Number(rt.height) > 0) {
            const N = 6;
            const buf = new Uint8Array(4);
            const chan = { r: [255, 0, 0], g: [255, 0, 0], b: [255, 0, 0], a: [255, 0, 0] }; // [min,max,sum]
            const grid = [];
            let n = 0;
            for (let gy = 0; gy < N; gy++) {
              const rowR = [];
              for (let gx = 0; gx < N; gx++) {
                const px = Math.min(rt.width - 1, Math.round((gx + 0.5) / N * rt.width));
                const py = Math.min(rt.height - 1, Math.round((gy + 0.5) / N * rt.height));
                try {
                  renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);
                  const vals = { r: buf[0], g: buf[1], b: buf[2], a: buf[3] };
                  for (const c of ['r', 'g', 'b', 'a']) {
                    chan[c][0] = Math.min(chan[c][0], vals[c]);
                    chan[c][1] = Math.max(chan[c][1], vals[c]);
                    chan[c][2] += vals[c];
                  }
                  rowR.push(vals.r);
                  n++;
                } catch (_) { rowR.push(-1); }
              }
              grid.push(rowR.join(','));
            }
            const stat = (c) => ({ min: chan[c][0], max: chan[c][1], mean: n ? Math.round(chan[c][2] / n) : null });
            const r = stat('r');
            report.maskContent = {
              width: rt.width, height: rt.height, samples: n,
              r, g: stat('g'), b: stat('b'), a: stat('a'),
              verdict: (r.max - r.min) <= 6
                ? (r.min > 250 ? 'R UNIFORM WHITE → mask baked all-outdoor, or outdoors value is not in .r'
                  : r.min < 6 ? 'R UNIFORM BLACK → all-indoor' : 'R UNIFORM MID')
                : 'R HAS STRUCTURE → mask content is fine; suspect UV/sampling in the shader',
              grid6x6Red: grid,
            };
          } else {
            report.maskContent = { skipped: 'no renderer/RT for readback', haveRenderer: !!renderer, haveRt: !!rt };
          }
        } catch (err) { report.maskContent = { error: String(err?.message ?? err) }; }
      }
      // What the last rendered frame actually bound (null = ambient was uniform).
      const s = this._outdoorsState;
      report.lastFrame = s
        ? {
          bound: true, route: s.route, floorKey: s.floorKey, flipY: s.flipY,
          sceneBounds: { ...s.sb }, viewOk: s.viewOk ?? null,
          viewMin: s.viewMin ?? null, viewMax: s.viewMax ?? null,
        }
        : { bound: false };
      const au = this._ambientMat?.uniforms;
      if (au) {
        report.ambientUniforms = {
          uHasOutdoors: au.uHasOutdoors?.value ?? null,
          viewMin: au.uViewMin?.value ? [au.uViewMin.value.x, au.uViewMin.value.y] : null,
          viewMax: au.uViewMax?.value ? [au.uViewMax.value.x, au.uViewMax.value.y] : null,
          sceneBounds: au.uSceneBounds?.value
            ? [au.uSceneBounds.value.x, au.uSceneBounds.value.y, au.uSceneBounds.value.z, au.uSceneBounds.value.w]
            : null,
        };
      }
    } catch (err) {
      report.error = String(err?.message ?? err);
    }
    return report;
  }

  dispose() {
    try { this._ambientMat?.dispose?.(); } catch (_) {}
    try { this._compositeMat?.dispose?.(); } catch (_) {}
    this._pruneAll();
    this._ambientScene = null; this._compositeScene = null;
    this._illumScene = null; this._coloScene = null; this._built = false;
  }
}
