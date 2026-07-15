/**
 * @fileoverview FSR 1.0 EASU presentation upscale (AMD FidelityFX, MIT license).
 *
 * Upsamples the internal compositor frame to the display drawing buffer.
 * Falls back to bilinear passthrough when WebGL2 textureGather is unavailable
 * or when internal resolution matches display.
 *
 * @module compositor-v2/presentation/PresentationUpscalePass
 */

import { createLogger } from '../../core/log.js';
import { computeEasuConstants } from './fsr-easu-constants.js';

const log = createLogger('PresentationUpscalePass');

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const VERT_300 = /* glsl */`
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FSR_EASU_BODY = /* glsl */`
vec4 gatherR(vec2 p) { return textureGather(tInput, p, 0); }
vec4 gatherG(vec2 p) { return textureGather(tInput, p, 1); }
vec4 gatherB(vec2 p) { return textureGather(tInput, p, 2); }
float fsrRcp(float a) { return 1.0 / max(a, 1.0 / 32768.0); }
float fsrSat(float a) { return clamp(a, 0.0, 1.0); }
void fsrEasuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  vec2 v;
  v.x = (off.x * dir.x) + (off.y * dir.y);
  v.y = (off.x * (-dir.y)) + (off.y * dir.x);
  v *= len;
  float d2 = v.x * v.x + v.y * v.y;
  d2 = min(d2, clp);
  float wB = (2.0 / 5.0) * d2 + (-1.0);
  float wA = lob * d2 + (-1.0);
  wB *= wB;
  wA *= wA;
  wB = (25.0 / 16.0) * wB + (-(25.0 / 16.0 - 1.0));
  float w = wB * wA;
  aC += c * w;
  aW += w;
}
void fsrEasuSet(inout vec2 dir, inout float len, vec2 pp, bool biS, bool biT, bool biU, bool biV,
  float lA, float lB, float lC, float lD, float lE) {
  float w = 0.0;
  if (biS) w = (1.0 - pp.x) * (1.0 - pp.y);
  if (biT) w = pp.x * (1.0 - pp.y);
  if (biU) w = (1.0 - pp.x) * pp.y;
  if (biV) w = pp.x * pp.y;
  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = fsrRcp(lenX);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = fsrSat(abs(dirX) * lenX);
  lenX *= lenX;
  len += lenX * w;
  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = fsrRcp(lenY);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = fsrSat(abs(dirY) * lenY);
  lenY *= lenY;
  len += lenY * w;
}
vec3 fsrEasuF(ivec2 ip) {
  vec2 pp = vec2(ip) * uCon0.xy + uCon0.zw;
  vec2 fp = floor(pp);
  pp -= fp;
  vec2 p0 = fp * uCon1.xy + uCon1.zw;
  vec2 p1 = p0 + uCon2.xy;
  vec2 p2 = p0 + uCon2.zw;
  vec2 p3 = p0 + uCon3.xy;
  vec4 bczzR = gatherR(p0);
  vec4 bczzG = gatherG(p0);
  vec4 bczzB = gatherB(p0);
  vec4 ijfeR = gatherR(p1);
  vec4 ijfeG = gatherG(p1);
  vec4 ijfeB = gatherB(p1);
  vec4 klhgR = gatherR(p2);
  vec4 klhgG = gatherG(p2);
  vec4 klhgB = gatherB(p2);
  vec4 zzonR = gatherR(p3);
  vec4 zzonG = gatherG(p3);
  vec4 zzonB = gatherB(p3);
  float bL = bczzB.x * 0.5 + (bczzR.x * 0.5 + bczzG.x);
  float cL = bczzB.y * 0.5 + (bczzR.y * 0.5 + bczzG.y);
  float iL = ijfeB.x * 0.5 + (ijfeR.x * 0.5 + ijfeG.x);
  float jL = ijfeB.y * 0.5 + (ijfeR.y * 0.5 + ijfeG.y);
  float fL = ijfeB.z * 0.5 + (ijfeR.z * 0.5 + ijfeG.z);
  float eL = ijfeB.w * 0.5 + (ijfeR.w * 0.5 + ijfeG.w);
  float kL = klhgB.x * 0.5 + (klhgR.x * 0.5 + klhgG.x);
  float lL = klhgB.y * 0.5 + (klhgR.y * 0.5 + klhgG.y);
  float hL = klhgB.z * 0.5 + (klhgR.z * 0.5 + klhgG.z);
  float gL = klhgB.w * 0.5 + (klhgR.w * 0.5 + klhgG.w);
  float oL = zzonB.z * 0.5 + (zzonR.z * 0.5 + zzonG.z);
  float nL = zzonB.w * 0.5 + (zzonR.w * 0.5 + zzonG.w);
  vec2 dir = vec2(0.0);
  float len = 0.0;
  fsrEasuSet(dir, len, pp, true, false, false, false, bL, eL, fL, gL, jL);
  fsrEasuSet(dir, len, pp, false, true, false, false, cL, fL, gL, hL, kL);
  fsrEasuSet(dir, len, pp, false, false, true, false, fL, iL, jL, kL, nL);
  fsrEasuSet(dir, len, pp, false, false, false, true, gL, jL, kL, lL, oL);
  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zro = dirR < (1.0 / 32768.0);
  dirR = fsrRcp(dirR);
  dirR = zro ? 1.0 : dirR;
  dir.x = zro ? 1.0 : dir.x;
  dir *= vec2(dirR);
  len = len * 0.5;
  len *= len;
  float stretch = (dir.x * dir.x + dir.y * dir.y) * fsrRcp(max(abs(dir.x), abs(dir.y)));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 + (-0.5) * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = fsrRcp(lob);
  vec3 min4 = min(min(vec3(ijfeR.z, ijfeG.z, ijfeB.z), vec3(klhgR.w, klhgG.w, klhgB.w)),
    min(vec3(ijfeR.y, ijfeG.y, ijfeB.y), vec3(klhgR.x, klhgG.x, klhgB.x)));
  vec3 max4 = max(max(vec3(ijfeR.z, ijfeG.z, ijfeB.z), vec3(klhgR.w, klhgG.w, klhgB.w)),
    max(vec3(ijfeR.y, ijfeG.y, ijfeB.y), vec3(klhgR.x, klhgG.x, klhgB.x)));
  vec3 aC = vec3(0.0);
  float aW = 0.0;
  fsrEasuTap(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, vec3(bczzR.x, bczzG.x, bczzB.x));
  fsrEasuTap(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, vec3(bczzR.y, bczzG.y, bczzB.y));
  fsrEasuTap(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, vec3(ijfeR.x, ijfeG.x, ijfeB.x));
  fsrEasuTap(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, vec3(ijfeR.y, ijfeG.y, ijfeB.y));
  fsrEasuTap(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, vec3(ijfeR.z, ijfeG.z, ijfeB.z));
  fsrEasuTap(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, vec3(ijfeR.w, ijfeG.w, ijfeB.w));
  fsrEasuTap(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, vec3(klhgR.x, klhgG.x, klhgB.x));
  fsrEasuTap(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, vec3(klhgR.y, klhgG.y, klhgB.y));
  fsrEasuTap(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, vec3(klhgR.z, klhgG.z, klhgB.z));
  fsrEasuTap(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, vec3(klhgR.w, klhgG.w, klhgB.w));
  fsrEasuTap(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, vec3(zzonR.z, zzonG.z, zzonB.z));
  fsrEasuTap(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, vec3(zzonR.w, zzonG.w, zzonB.w));
  return min(max4, max(min4, aC * vec3(fsrRcp(aW))));
}
`;

export class PresentationUpscalePass {
  constructor() {
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._camera = null;
    /** @type {THREE.Mesh|null} */
    this._quad = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._fsrMaterial = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._bilinearMaterial = null;
    /** @type {boolean} */
    this._useFsr = false;
    /** @type {number} */
    this._internalW = 1;
    /** @type {number} */
    this._internalH = 1;
    /** @type {number} */
    this._displayW = 1;
    /** @type {number} */
    this._displayH = 1;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @private
   */
  _ensureInitialized(renderer) {
    const THREE = window.THREE;
    if (!THREE || this._scene) return;

    const isWebGL2 = renderer?.capabilities?.isWebGL2 === true;
    this._useFsr = isWebGL2;

    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    if (isWebGL2) {
      this._fsrMaterial = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tInput: { value: null },
          uCon0: { value: new THREE.Vector4() },
          uCon1: { value: new THREE.Vector4() },
          uCon2: { value: new THREE.Vector4() },
          uCon3: { value: new THREE.Vector4() },
          uOutputSize: { value: new THREE.Vector2(1, 1) },
        },
        vertexShader: `#version 300 es\n${VERT_300}`,
        fragmentShader: `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D tInput;
uniform vec4 uCon0;
uniform vec4 uCon1;
uniform vec4 uCon2;
uniform vec4 uCon3;
uniform vec2 uOutputSize;
out vec4 outColor;
${FSR_EASU_BODY}
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec3 pix = fsrEasuF(ip);
  outColor = vec4(pix, 1.0);
}`,
        depthTest: false,
        depthWrite: false,
        transparent: false,
        blending: THREE.NoBlending,
      });
      this._fsrMaterial.toneMapped = false;
    }

    this._bilinearMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uInputSize: { value: new THREE.Vector2(1, 1) },
        uOutputSize: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tInput;
        uniform vec2 uInputSize;
        uniform vec2 uOutputSize;
        varying vec2 vUv;
        void main() {
          vec2 uv = gl_FragCoord.xy / uOutputSize;
          gl_FragColor = vec4(texture2D(tInput, uv).rgb, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._bilinearMaterial.toneMapped = false;

    const mat = this._fsrMaterial ?? this._bilinearMaterial;
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);

    log.info(`PresentationUpscalePass initialized (FSR EASU: ${isWebGL2})`);
  }

  /**
   * @param {number} internalW
   * @param {number} internalH
   * @param {number} displayW
   * @param {number} displayH
   */
  setSizes(internalW, internalH, displayW, displayH) {
    this._internalW = Math.max(1, internalW);
    this._internalH = Math.max(1, internalH);
    this._displayW = Math.max(1, displayW);
    this._displayH = Math.max(1, displayH);
  }

  /**
   * @returns {boolean}
   */
  needsUpscale() {
    if (this._internalW >= this._displayW && this._internalH >= this._displayH) return false;
    const scale = Math.min(this._internalW / this._displayW, this._internalH / this._displayH);
    return scale < 0.95;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture} inputTexture
   * @param {{ prepareViewport?: (renderer: THREE.WebGLRenderer) => void }} [opts]
   * @returns {boolean}
   */
  render(renderer, inputTexture, opts = {}) {
    if (!renderer || !inputTexture) return false;
    this._ensureInitialized(renderer);

    const useFsr = this._useFsr && this._fsrMaterial && this.needsUpscale();
    const mat = useFsr ? this._fsrMaterial : this._bilinearMaterial;
    if (!mat || !this._scene || !this._camera || !this._quad) return false;

    this._quad.material = mat;
    mat.uniforms.tInput.value = inputTexture;

    if (useFsr) {
      const { con0, con1, con2, con3 } = computeEasuConstants(
        this._internalW,
        this._internalH,
        this._internalW,
        this._internalH,
        this._displayW,
        this._displayH,
      );
      mat.uniforms.uCon0.value.set(con0[0], con0[1], con0[2], con0[3]);
      mat.uniforms.uCon1.value.set(con1[0], con1[1], con1[2], con1[3]);
      mat.uniforms.uCon2.value.set(con2[0], con2[1], con2[2], con2[3]);
      mat.uniforms.uCon3.value.set(con3[0], con3[1], con3[2], con3[3]);
      mat.uniforms.uOutputSize.value.set(this._displayW, this._displayH);
    } else {
      mat.uniforms.uInputSize.value.set(this._internalW, this._internalH);
      mat.uniforms.uOutputSize.value.set(this._displayW, this._displayH);
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    try {
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      if (typeof opts.prepareViewport === 'function') {
        opts.prepareViewport(renderer);
      }
      renderer.render(this._scene, this._camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
    }
    return true;
  }
}
