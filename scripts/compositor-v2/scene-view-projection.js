/**
 * Shared ground-plane view projection: screen UV → Three world XY → Foundry scene UV.
 * Single source of truth for LightingEffectV2 compose, WindowLightEffectV2 outdoors
 * clip, and overlay destination gating (avoids FOV-box vs raycast corner drift).
 *
 * @module compositor-v2/scene-view-projection
 */

/** NDC corners for perspective → ground-plane unproject (TL, TR, BL, BR). */
const _NDC_CORNERS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * Canonical _Outdoors decode (matches SpecularEffectV2 / decodeOutdoorsMaskSample).
 * White/outdoor → 1.0, black/indoor → 0.0, cleared texel (0,0,0,0) → 1.0 (outdoor default).
 */
export const GLSL_DECODE_OUTDOORS_MASK = /* glsl */`
float msDecodeOutdoorsMaskSample(vec4 s) {
  float lum = max(s.r, max(s.g, s.b));
  if (lum < 1e-5 && s.a < 1e-5) return 1.0;
  return clamp(lum * s.a, 0.0, 1.0);
}
`;

/** Bilinear view-corner ground projection + Foundry scene UV (LightingEffectV2 compose). */
export const GLSL_SCREEN_TO_SCENE_UV = /* glsl */`
vec2 msBilinearViewCornerToWorld(vec2 screenUv,
  vec2 c00, vec2 c10, vec2 c01, vec2 c11) {
  vec2 w0 = mix(c00, c10, screenUv.x);
  vec2 w1 = mix(c01, c11, screenUv.x);
  return mix(w0, w1, screenUv.y);
}

vec2 msWorldToSceneUvRaw(vec2 worldXY, vec2 sceneOrigin, vec2 sceneSize, vec2 sceneDimensions) {
  float foundryY = sceneDimensions.y - worldXY.y;
  return (vec2(worldXY.x, foundryY) - sceneOrigin) / max(sceneSize, vec2(1e-5));
}

vec2 msScreenUvToSceneUvRaw(vec2 screenUv,
  vec2 c00, vec2 c10, vec2 c01, vec2 c11,
  vec2 sceneOrigin, vec2 sceneSize, vec2 sceneDimensions) {
  vec2 world = msBilinearViewCornerToWorld(screenUv, c00, c10, c01, c11);
  return msWorldToSceneUvRaw(world, sceneOrigin, sceneSize, sceneDimensions);
}

float msInSceneBounds(vec2 sceneUvRaw) {
  return step(0.0, sceneUvRaw.x) * step(0.0, sceneUvRaw.y)
       * step(sceneUvRaw.x, 1.0) * step(sceneUvRaw.y, 1.0);
}
`;

/**
 * @typedef {object} SceneViewProjectionCache
 * @property {boolean} isValid
 * @property {boolean} isOrtho
 * @property {number} px
 * @property {number} py
 * @property {number} pz
 * @property {number} qx
 * @property {number} qy
 * @property {number} qz
 * @property {number} qw
 * @property {number} zoom
 * @property {number} left
 * @property {number} right
 * @property {number} top
 * @property {number} bottom
 * @property {number} fov
 * @property {number} aspect
 * @property {number} near
 * @property {number} far
 * @property {number} groundZ
 * @property {number} vMinX
 * @property {number} vMinY
 * @property {number} vMaxX
 * @property {number} vMaxY
 * @property {number} c00x
 * @property {number} c00y
 * @property {number} c10x
 * @property {number} c10y
 * @property {number} c01x
 * @property {number} c01y
 * @property {number} c11x
 * @property {number} c11y
 */

/**
 * @returns {SceneViewProjectionCache}
 */
export function createSceneViewProjectionCache() {
  return { isValid: false };
}

/**
 * Raycast camera frustum corners to the ground plane and cache view bounds + bilinear corners.
 *
 * @param {import('three').PerspectiveCamera|import('three').OrthographicCamera|null} camera
 * @param {number} groundZ
 * @param {SceneViewProjectionCache} cache
 * @param {{ ndc?: import('three').Vector3, world?: import('three').Vector3, dir?: import('three').Vector3 }|null} [temps]
 * @returns {boolean} Whether cache was updated with valid bounds
 */
export function updateSceneViewProjectionFromCamera(camera, groundZ, cache, temps = null) {
  if (!camera || !cache) return false;

  const q = camera.quaternion;
  const isOrtho = camera.isOrthographicCamera === true;
  const cameraChanged = !cache.isValid
    || cache.isOrtho !== isOrtho
    || cache.px !== camera.position.x || cache.py !== camera.position.y || cache.pz !== camera.position.z
    || cache.qx !== (q?.x ?? 0) || cache.qy !== (q?.y ?? 0) || cache.qz !== (q?.z ?? 0) || cache.qw !== (q?.w ?? 1)
    || cache.zoom !== camera.zoom
    || cache.left !== (camera.left ?? 0) || cache.right !== (camera.right ?? 0)
    || cache.top !== (camera.top ?? 0) || cache.bottom !== (camera.bottom ?? 0)
    || cache.fov !== (camera.fov ?? 0) || cache.aspect !== (camera.aspect ?? 0)
    || cache.near !== (camera.near ?? 0) || cache.far !== (camera.far ?? 0)
    || cache.groundZ !== groundZ;

  if (!cameraChanged) return true;

  let vMinX = 0;
  let vMinY = 0;
  let vMaxX = 1;
  let vMaxY = 1;
  let c00x = 0;
  let c00y = 0;
  let c10x = 1;
  let c10y = 0;
  let c01x = 0;
  let c01y = 1;
  let c11x = 1;
  let c11y = 1;

  if (isOrtho) {
    vMinX = camera.position.x + camera.left / camera.zoom;
    vMinY = camera.position.y + camera.bottom / camera.zoom;
    vMaxX = camera.position.x + camera.right / camera.zoom;
    vMaxY = camera.position.y + camera.top / camera.zoom;

    c00x = vMinX; c00y = vMinY;
    c10x = vMaxX; c10y = vMinY;
    c01x = vMinX; c01y = vMaxY;
    c11x = vMaxX; c11y = vMaxY;
  } else {
    const THREE = window.THREE;
    const ndc = temps?.ndc;
    const world = temps?.world;
    const dir = temps?.dir;
    if (THREE && ndc && world && dir) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let validCornerCount = 0;

      for (let i = 0; i < 4; i += 1) {
        const cx = _NDC_CORNERS[i][0];
        const cy = _NDC_CORNERS[i][1];

        ndc.set(cx, cy, 0.5);
        world.copy(ndc).unproject(camera);
        dir.copy(world).sub(camera.position);

        const dz = dir.z;
        if (dz > -1e-6 && dz < 1e-6) continue;

        const t = (groundZ - camera.position.z) / dz;
        if (!Number.isFinite(t) || t <= 0) continue;

        const ix = camera.position.x + dir.x * t;
        const iy = camera.position.y + dir.y * t;

        if (ix < minX) minX = ix;
        if (iy < minY) minY = iy;
        if (ix > maxX) maxX = ix;
        if (iy > maxY) maxY = iy;
        validCornerCount += 1;

        if (i === 0) { c00x = ix; c00y = iy; }
        else if (i === 1) { c10x = ix; c10y = iy; }
        else if (i === 2) { c01x = ix; c01y = iy; }
        else if (i === 3) { c11x = ix; c11y = iy; }
      }

      if (minX !== Infinity) {
        vMinX = minX;
        vMinY = minY;
        vMaxX = maxX;
        vMaxY = maxY;
      } else {
        cache.isValid = false;
        return false;
      }
      if (validCornerCount < 4 && minX !== Infinity) {
        c00x = minX; c00y = minY;
        c10x = maxX; c10y = minY;
        c01x = minX; c01y = maxY;
        c11x = maxX; c11y = maxY;
      }
    }
  }

  cache.isValid = true;
  cache.isOrtho = isOrtho;
  cache.px = camera.position.x;
  cache.py = camera.position.y;
  cache.pz = camera.position.z;
  cache.qx = q?.x ?? 0;
  cache.qy = q?.y ?? 0;
  cache.qz = q?.z ?? 0;
  cache.qw = q?.w ?? 1;
  cache.zoom = camera.zoom;
  cache.left = camera.left ?? 0;
  cache.right = camera.right ?? 0;
  cache.top = camera.top ?? 0;
  cache.bottom = camera.bottom ?? 0;
  cache.fov = camera.fov ?? 0;
  cache.aspect = camera.aspect ?? 0;
  cache.near = camera.near ?? 0;
  cache.far = camera.far ?? 0;
  cache.groundZ = groundZ;
  cache.vMinX = vMinX;
  cache.vMinY = vMinY;
  cache.vMaxX = vMaxX;
  cache.vMaxY = vMaxY;
  cache.c00x = c00x;
  cache.c00y = c00y;
  cache.c10x = c10x;
  cache.c10y = c10y;
  cache.c01x = c01x;
  cache.c01y = c01y;
  cache.c11x = c11x;
  cache.c11y = c11y;
  return true;
}

/**
 * Push cached projection into Three.js uniform objects.
 *
 * @param {SceneViewProjectionCache} cache
 * @param {{
 *   uViewBoundsMin?: { value: import('three').Vector2 },
 *   uViewBoundsMax?: { value: import('three').Vector2 },
 *   uViewBounds?: { value: import('three').Vector4 },
 *   uViewCorner00?: { value: import('three').Vector2 },
 *   uViewCorner10?: { value: import('three').Vector2 },
 *   uViewCorner01?: { value: import('three').Vector2 },
 *   uViewCorner11?: { value: import('three').Vector2 },
 *   uBldViewCorner00?: { value: import('three').Vector2 },
 *   uBldViewCorner10?: { value: import('three').Vector2 },
 *   uBldViewCorner01?: { value: import('three').Vector2 },
 *   uBldViewCorner11?: { value: import('three').Vector2 },
 *   uBldViewBoundsMin?: { value: import('three').Vector2 },
 *   uBldViewBoundsMax?: { value: import('three').Vector2 },
 * }|null|undefined} uniforms
 */
export function applySceneViewProjectionToUniforms(cache, uniforms) {
  if (!cache?.isValid || !uniforms) return;

  uniforms.uViewBoundsMin?.value?.set(cache.vMinX, cache.vMinY);
  uniforms.uViewBoundsMax?.value?.set(cache.vMaxX, cache.vMaxY);
  uniforms.uViewBounds?.value?.set(cache.vMinX, cache.vMinY, cache.vMaxX, cache.vMaxY);
  uniforms.uViewCorner00?.value?.set(cache.c00x, cache.c00y);
  uniforms.uViewCorner10?.value?.set(cache.c10x, cache.c10y);
  uniforms.uViewCorner01?.value?.set(cache.c01x, cache.c01y);
  uniforms.uViewCorner11?.value?.set(cache.c11x, cache.c11y);
  uniforms.uBldViewCorner00?.value?.set(cache.c00x, cache.c00y);
  uniforms.uBldViewCorner10?.value?.set(cache.c10x, cache.c10y);
  uniforms.uBldViewCorner01?.value?.set(cache.c01x, cache.c01y);
  uniforms.uBldViewCorner11?.value?.set(cache.c11x, cache.c11y);
  uniforms.uBldViewBoundsMin?.value?.set(cache.vMinX, cache.vMinY);
  uniforms.uBldViewBoundsMax?.value?.set(cache.vMaxX, cache.vMaxY);
}
