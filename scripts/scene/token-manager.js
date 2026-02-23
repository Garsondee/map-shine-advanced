/**
 * @fileoverview Token manager - syncs Foundry tokens to THREE.js sprites
 * Handles creation, updates, and deletion of token sprites in the THREE.js scene
 * @module scene/token-manager
 */

import { createLogger } from '../core/log.js';
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from '../foundry/levels-compatibility.js';
import { isLevelsEnabledForScene } from '../foundry/levels-scene-flags.js';
import { getPerspectiveElevation } from '../foundry/elevation-context.js';

const log = createLogger('TokenManager');

/**
 * Z-position base for tokens.
 * Tokens render at this z-position + elevation above the scene groundZ.
 * Layer ordering: ground(0) → BG(1.0) → FG(2.0) → TOKEN(3.0) → OVERHEAD(4.0)
 */
const TOKEN_BASE_Z = 3.0;

/**
 * TokenManager - Synchronizes Foundry VTT tokens to THREE.js sprites
 * Uses Foundry hooks for reactive updates instead of polling
 */
export class TokenManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene to add token sprites to
   */
  constructor(scene) {
    this.scene = scene;
    
    /** @type {Map<string, TokenSpriteData>} */
    this.tokenSprites = new Map();
    
    /** @type {THREE.TextureLoader} */
    this.textureLoader = new THREE.TextureLoader();
    
    /** @type {Map<string, THREE.Texture>} */
    this.textureCache = new Map();
    
    this.initialized = false;
    this.hooksRegistered = false;
    
    /** @type {EffectComposer|null} */
    this.effectComposer = null;

    /** @type {import('./token-movement-manager.js').TokenMovementManager|null} */
    this.movementManager = null;

    // Track active animations
    // Map<tokenId, { 
    //   attributes: Array<{parent, attribute, start, to, diff}>, 
    //   duration: number, 
    //   elapsed: number, 
    //   easing: string 
    // }>
    this.activeAnimations = new Map();

    /**
     * Sub-rate update lane — tint changes slowly and token animations are delta-driven,
     * so 15 Hz is sufficient for the per-frame update loop.
     * Set to 0 or undefined to run every rendered frame.
     * @type {number}
     */
    this.updateHz = 15;

    this._globalTint = null;
    this._daylightTint = null;
    this._darknessTint = null;
    this._ambientTint = null;
    this._lastTintKey = null;
    this._tintDirty = true;

    this._tokenCCDirty = true;
    this.tokenColorCorrection = {
      enabled: true,
      exposure: 1.0,
      temperature: 0.0,
      tint: 0.0,
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
      gamma: 1.0,
      windowLightIntensity: 1.0
    };

    /** @type {Array<(tokenId: string) => void>} */
    this._onTokenMovementStartListeners = [];

    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];

    /** @type {boolean} Whether Foundry highlight-all (Alt) is currently active */
    this._highlightAllTokensActive = false;

    /**
     * P4-02: When true, token sprites use depthTest:true/depthWrite:true so they
     * are correctly occluded by elevated foreground tiles in the depth buffer.
     * When false (default), tokens always render on top (legacy behaviour).
     * @type {boolean}
     */
    this.tokenDepthInteraction = false;

    // Cache renderer-derived values for texture filtering.
    this._maxAnisotropy = null;
    
    log.debug('TokenManager created');
  }

  /**
   * Returns true if TokenManager is currently animating the given token.
   * This is used by systems like DynamicExposureManager to avoid sampling state
   * while a token is moving across many tiles.
   * @param {string} tokenId
   */
  isTokenAnimating(tokenId) {
    if (!tokenId) return false;
    return this.activeAnimations?.has(tokenId) === true;
  }

  _getRenderer() {
    return this.effectComposer?.renderer || window.MapShine?.renderer || null;
  }

  _getMaxAnisotropy() {
    if (typeof this._maxAnisotropy === 'number') return this._maxAnisotropy;
    const renderer = this._getRenderer();
    const max = renderer?.capabilities?.getMaxAnisotropy?.();
    this._maxAnisotropy = (typeof max === 'number' && max > 0) ? max : 1;
    return this._maxAnisotropy;
  }

  _isPowerOfTwo(value) {
    const v = value | 0;
    return v > 0 && (v & (v - 1)) === 0;
  }

  _getTextureDimensions(texture) {
    const img = texture?.image;
    if (!img) return { w: 0, h: 0 };
    const w = Number(img?.naturalWidth ?? img?.videoWidth ?? img?.width ?? 0);
    const h = Number(img?.naturalHeight ?? img?.videoHeight ?? img?.height ?? 0);
    return { w, h };
  }

  _configureTokenTextureFiltering(texture) {
    const THREE = window.THREE;
    if (!THREE || !texture) return;

    // Mipmaps are critical for stable, smooth minification when zoomed out.
    // WebGL1 requires POT textures for mipmaps; WebGL2 supports NPOT.
    const renderer = this._getRenderer();
    const isWebGL2 = !!renderer?.capabilities?.isWebGL2;
    const { w, h } = this._getTextureDimensions(texture);
    const isPot = this._isPowerOfTwo(w) && this._isPowerOfTwo(h);
    const canMipmap = isWebGL2 || isPot;

    texture.generateMipmaps = canMipmap;
    texture.minFilter = canMipmap ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = canMipmap ? Math.min(16, this._getMaxAnisotropy()) : 1;
    texture.needsUpdate = true;
  }

  /**
   * Apply current scene lighting tint to a single sprite
   * Used when a new token is created to immediately pick up scene lighting
   * @param {THREE.Sprite} sprite - Token sprite to tint
   * @private
   */
  _applyLightingTintToSprite(sprite) {
    if (!sprite || !sprite.material) return;

    const THREE = window.THREE;
    if (!THREE) return;

    if (!this._globalTint) this._globalTint = new THREE.Color(1, 1, 1);
    if (!this._daylightTint) this._daylightTint = new THREE.Color(1, 1, 1);
    if (!this._darknessTint) this._darknessTint = new THREE.Color(1, 1, 1);
    if (!this._ambientTint) this._ambientTint = new THREE.Color(1, 1, 1);

    try {
      const le = window.MapShine?.lightingEffect;
      if (le && le.enabled) {
        sprite.material.color.setRGB(1, 1, 1);
        return;
      }
    } catch (_) {
    }

    const globalTint = this._globalTint;
    globalTint.setRGB(1, 1, 1);

    try {
      const scene = canvas?.scene;
      const env = canvas?.environment;

      if (scene?.environment?.darknessLevel !== undefined) {
        let darkness = scene.environment.darknessLevel;
        const le = window.MapShine?.lightingEffect;
        if (le && typeof le.getEffectiveDarkness === 'function') {
          darkness = le.getEffectiveDarkness();
        }

        const getThreeColor = (src, def, out) => {
          try {
            if (!out) out = new THREE.Color(def);
            if (!src) {
              out.set(def);
              return out;
            }
            if (src instanceof THREE.Color) {
              out.copy(src);
              return out;
            }
            if (src.rgb) {
              out.setRGB(src.rgb[0], src.rgb[1], src.rgb[2]);
              return out;
            }
            if (Array.isArray(src)) {
              out.setRGB(src[0], src[1], src[2]);
              return out;
            }
            out.set(src);
            return out;
          } catch (e) {
            out.set(def);
            return out;
          }
        };

        const daylight = getThreeColor(env?.colors?.ambientDaylight, 0xffffff, this._daylightTint);
        const darknessColor = getThreeColor(env?.colors?.ambientDarkness, 0x242448, this._darknessTint);

        const ambientTint = this._ambientTint.copy(daylight).lerp(darknessColor, darkness);

        const lightLevel = Math.max(1.0 - darkness, 0.25);

        globalTint.copy(ambientTint).multiplyScalar(lightLevel);
      }
    } catch (e) {
    }

    sprite.material.color.copy(globalTint);
  }

  setColorCorrectionParams(params) {
    if (!params || typeof params !== 'object') return;
    Object.assign(this.tokenColorCorrection, params);
    this._tokenCCDirty = true;
    this.applyColorCorrectionToAllTokens();
  }

  applyColorCorrectionToAllTokens() {
    for (const data of this.tokenSprites.values()) {
      const mat = data?.sprite?.material;
      if (mat) {
        this._ensureTokenColorCorrection(mat);
        this._applyTokenColorCorrectionUniforms(mat, data?.tokenDoc || null);
      }
    }
    this._tokenCCDirty = false;
  }

  _getUndergroundSaturationMultiplier(tokenDoc) {
    const elevation = Number(tokenDoc?.elevation ?? 0);
    if (!Number.isFinite(elevation) || elevation >= 0) return 1.0;

    const depth = Math.min(1, Math.abs(elevation) / 30);
    // At deep underground levels, heavily desaturate but keep some color identity.
    return Math.max(0.2, 1 - (0.65 * depth));
  }

  _applyTokenColorCorrectionUniforms(material, tokenDoc = null) {
    const shader = material?.userData?._msTokenCCShader;
    if (!shader?.uniforms) return;

    const p = this.tokenColorCorrection;
    const undergroundSaturation = this._getUndergroundSaturationMultiplier(
      tokenDoc || material?.userData?._msTokenDoc || null
    );
    shader.uniforms.uTokenCCEnabled.value = p.enabled ? 1.0 : 0.0;
    shader.uniforms.uTokenExposure.value = p.exposure ?? 1.0;
    shader.uniforms.uTokenTemperature.value = p.temperature ?? 0.0;
    shader.uniforms.uTokenTint.value = p.tint ?? 0.0;
    shader.uniforms.uTokenBrightness.value = p.brightness ?? 0.0;
    shader.uniforms.uTokenContrast.value = p.contrast ?? 1.0;
    shader.uniforms.uTokenSaturation.value = p.saturation ?? 1.0;
    if (shader.uniforms.uTokenSaturationMultiplier) {
      shader.uniforms.uTokenSaturationMultiplier.value = undergroundSaturation;
    }
    shader.uniforms.uTokenGamma.value = p.gamma ?? 1.0;

    // Update window light texture
    try {
      const wle = window.MapShine?.windowLightEffect;
      const tex = (wle && typeof wle.getLightTexture === 'function') ? wle.getLightTexture() : (wle?.lightTarget?.texture ?? null);
      if (shader.uniforms.tWindowLight) {
        shader.uniforms.tWindowLight.value = tex || null;
        shader.uniforms.uHasWindowLight.value = tex ? 1.0 : 0.0;
        if (shader.uniforms.uWindowLightScreenSize?.value?.set) {
          const w = wle?.lightTarget?.width ?? window.innerWidth ?? 1;
          const h = wle?.lightTarget?.height ?? window.innerHeight ?? 1;
          shader.uniforms.uWindowLightScreenSize.value.set(w, h);
        }
        if (shader.uniforms.uWindowLightIntensity) {
          shader.uniforms.uWindowLightIntensity.value = p.windowLightIntensity ?? 1.0;
        }
      }
    } catch (_) {
    }
  }

  /**
   * P4-02/03: Enable or disable depth interaction for all token sprites.
   * When enabled, tokens participate in the depth buffer (depthTest + depthWrite)
   * so elevated foreground tiles correctly occlude them.
   * When disabled, tokens always render on top (legacy behaviour).
   * @param {boolean} enabled
   */
  setDepthInteraction(enabled) {
    this.tokenDepthInteraction = enabled === true;
    for (const data of this.tokenSprites.values()) {
      const mat = data?.sprite?.material;
      if (!mat) continue;
      mat.depthTest = this.tokenDepthInteraction;
      mat.depthWrite = this.tokenDepthInteraction;
      mat.needsUpdate = true;
    }
  }

  _ensureTokenColorCorrection(material) {
    if (!material || material.userData?._msTokenCCInstalled) return;

    material.userData._msTokenCCInstalled = true;
    material.onBeforeCompile = (shader) => {
      // Store shader reference so we can update uniforms live without recompiling.
      material.userData._msTokenCCShader = shader;

      shader.uniforms.uTokenCCEnabled = { value: 1.0 };
      shader.uniforms.uTokenExposure = { value: 1.0 };
      shader.uniforms.uTokenTemperature = { value: 0.0 };
      shader.uniforms.uTokenTint = { value: 0.0 };
      shader.uniforms.uTokenBrightness = { value: 0.0 };
      shader.uniforms.uTokenContrast = { value: 1.0 };
      shader.uniforms.uTokenSaturation = { value: 1.0 };
      shader.uniforms.uTokenSaturationMultiplier = { value: 1.0 };
      shader.uniforms.uTokenGamma = { value: 1.0 };
      shader.uniforms.tWindowLight = { value: null };
      shader.uniforms.uHasWindowLight = { value: 0.0 };
      shader.uniforms.uWindowLightScreenSize = { value: new window.THREE.Vector2(1, 1) };
      shader.uniforms.uWindowLightIntensity = { value: 1.0 };

      // P4-07/08/09: LightingEffect composite target + outdoors mask for indoor/outdoor
      // light intensity gating on tokens.
      shader.uniforms.tLightingTarget = { value: null };
      shader.uniforms.uHasLightingTarget = { value: 0.0 };
      shader.uniforms.tOutdoorsMask = { value: null };
      shader.uniforms.uHasOutdoorsMask = { value: 0.0 };
      shader.uniforms.uLightingScreenSize = { value: new window.THREE.Vector2(1, 1) };

      const uniformBlock = `
uniform float uTokenCCEnabled;
uniform float uTokenExposure;
uniform float uTokenTemperature;
uniform float uTokenTint;
uniform float uTokenBrightness;
uniform float uTokenContrast;
uniform float uTokenSaturation;
uniform float uTokenSaturationMultiplier;
uniform float uTokenGamma;
uniform sampler2D tWindowLight;
uniform float uHasWindowLight;
uniform vec2 uWindowLightScreenSize;
uniform float uWindowLightIntensity;
uniform sampler2D tLightingTarget;
uniform float uHasLightingTarget;
uniform sampler2D tOutdoorsMask;
uniform float uHasOutdoorsMask;
uniform vec2 uLightingScreenSize;

vec3 ms_applyTokenWhiteBalance(vec3 color, float temp, float tint) {
  vec3 tempShift = vec3(1.0 + temp, 1.0, 1.0 - temp);
  if (temp < 0.0) tempShift = vec3(1.0, 1.0, 1.0 - temp * 0.5);
  else tempShift = vec3(1.0 + temp * 0.5, 1.0, 1.0);

  vec3 tintShift = vec3(1.0, 1.0 + tint, 1.0);
  return color * tempShift * tintShift;
}

vec3 ms_applyTokenColorCorrection(vec3 color) {
  if (uTokenCCEnabled < 0.5) return color;

  color *= uTokenExposure;
  color = ms_applyTokenWhiteBalance(color, uTokenTemperature, uTokenTint);
  color += uTokenBrightness;
  color = (color - 0.5) * uTokenContrast + 0.5;

  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float saturation = max(0.0, uTokenSaturation * uTokenSaturationMultiplier);
  color = mix(vec3(luma), color, saturation);

  color = max(color, vec3(0.0));
  color = pow(color, vec3(1.0 / max(uTokenGamma, 0.0001)));
  return color;
}

vec3 ms_applyWindowLight(vec3 color) {
  if (uHasWindowLight < 0.5) return color;
  vec2 wuv = gl_FragCoord.xy / max(uWindowLightScreenSize, vec2(1.0));
  vec3 windowLight = texture2D(tWindowLight, clamp(wuv, vec2(0.001), vec2(0.999))).rgb;
  // Treat the window light texture as an illumination term.
  // Multiplicative lighting reads more like "light" (preserves saturation)
  // than pure additive, which can look like grey fog on tokens.
  vec3 illum = max(windowLight, vec3(0.0)) * max(uWindowLightIntensity, 0.0);
  return color * (vec3(1.0) + illum);
}

// P4-07: Sample the LightingEffect composite target at the token's screen position.
// This applies the scene's ambient + dynamic light contribution to the token color,
// making tokens react to the same lighting as the ground beneath them.
vec3 ms_applySceneLighting(vec3 color) {
  if (uHasLightingTarget < 0.5) return color;
  vec2 luv = gl_FragCoord.xy / max(uLightingScreenSize, vec2(1.0));
  vec3 lightSample = texture2D(tLightingTarget, clamp(luv, vec2(0.001), vec2(0.999))).rgb;
  // P4-08: Gate indoor/outdoor light intensity via the outdoors mask.
  // Tokens fully indoors (outdoorStrength=0) receive only indoor ambient;
  // tokens outdoors (outdoorStrength=1) receive full scene lighting.
  float outdoorStrength = 1.0;
  if (uHasOutdoorsMask > 0.5) {
    outdoorStrength = texture2D(tOutdoorsMask, clamp(luv, vec2(0.001), vec2(0.999))).r;
  }
  // Blend between unlit (1.0) and scene-lit based on outdoor strength.
  vec3 lightFactor = mix(vec3(1.0), lightSample, outdoorStrength);
  return color * max(lightFactor, vec3(0.0));
}
`;

      // Inject uniforms + helper functions.
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        `${uniformBlock}\nvoid main() {`
      );

      // SpriteMaterial's fragment shader does not consistently include <output_fragment>
      // across Three versions. Apply CC and window light using a robust set of fallbacks.
      let patched = false;

      if (shader.fragmentShader.includes('#include <output_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <output_fragment>',
          `#include <output_fragment>\n  gl_FragColor.rgb = ms_applyTokenColorCorrection(gl_FragColor.rgb);\n  gl_FragColor.rgb = ms_applyWindowLight(gl_FragColor.rgb);\n  gl_FragColor.rgb = ms_applySceneLighting(gl_FragColor.rgb);`
        );
        patched = true;
      }

      // Common SpriteMaterial pattern (Three r150+):
      // gl_FragColor = vec4( outgoingLight, diffuseColor.a );
      if (!patched && shader.fragmentShader.includes('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
          `vec3 ccLight = ms_applyTokenColorCorrection(outgoingLight);\n  ccLight = ms_applyWindowLight(ccLight);\n  ccLight = ms_applySceneLighting(ccLight);\n  gl_FragColor = vec4( ccLight, diffuseColor.a );`
        );
        patched = true;
      }

      // Another common pattern (duplicate guard — same string, kept for safety):
      if (!patched && shader.fragmentShader.includes('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
          `vec3 ccLight = ms_applyTokenColorCorrection(outgoingLight);\n  ccLight = ms_applyWindowLight(ccLight);\n  ccLight = ms_applySceneLighting(ccLight);\n  gl_FragColor = vec4( ccLight, diffuseColor.a );`
        );
        patched = true;
      }

      // Final fallback: if we failed to identify the assignment site, at least patch
      // gl_FragColor after it has been written by appending right before the end.
      // This is intentionally conservative and should never break compilation.
      if (!patched) {
        shader.fragmentShader = shader.fragmentShader.replace(
          /}\s*$/,
          `  gl_FragColor.rgb = ms_applyTokenColorCorrection(gl_FragColor.rgb);\n  gl_FragColor.rgb = ms_applyWindowLight(gl_FragColor.rgb);\n  gl_FragColor.rgb = ms_applySceneLighting(gl_FragColor.rgb);\n}`
        );
      }

      // Push current UI values into uniforms.
      this._applyTokenColorCorrectionUniforms(material, material?.userData?._msTokenDoc || null);
    };

    material.needsUpdate = true;
  }

  /**
   * Register a callback invoked when a token begins moving (authoritative update).
   * Replaces all existing listeners with a single callback (legacy API).
   * Prefer addOnTokenMovementStart() for non-exclusive listeners.
   * @param {(tokenId: string) => void} callback
   */
  setOnTokenMovementStart(callback) {
    this._onTokenMovementStartListeners = [];
    if (typeof callback === 'function') {
      this._onTokenMovementStartListeners.push(callback);
    }
  }

  /**
   * Add a callback invoked when a token begins moving (authoritative update).
   * Unlike setOnTokenMovementStart, this does NOT replace existing listeners.
   * @param {(tokenId: string) => void} callback
   */
  addOnTokenMovementStart(callback) {
    if (typeof callback === 'function') {
      this._onTokenMovementStartListeners.push(callback);
    }
  }

  /**
   * Notify all listeners that a token has started moving.
   * @param {string} tokenId
   */
  emitTokenMovementStart(tokenId) {
    if (!tokenId) return;
    for (const cb of this._onTokenMovementStartListeners) {
      try {
        cb(tokenId);
      } catch (_) {
      }
    }
  }

  /**
   * Set the TokenMovementManager instance used for authoritative movement styles.
   * @param {import('./token-movement-manager.js').TokenMovementManager|null} manager
   */
  setMovementManager(manager) {
    this.movementManager = manager || null;
    this._reapplyMovementStyleBaselines();
  }

  /**
   * Re-apply movement-style baseline transforms for all live token sprites.
   *
   * This is especially important during startup/scene activation where token
   * sprites may be created before TokenMovementManager is wired, leaving flying
   * tokens grounded (or with stale scale/pose) until the first move update.
   * @private
   */
  _reapplyMovementStyleBaselines() {
    for (const spriteData of this.tokenSprites.values()) {
      const sprite = spriteData?.sprite;
      const tokenDoc = spriteData?.tokenDoc;
      if (!sprite || !tokenDoc || sprite.userData?._removed) continue;
      this._applyMovementStyleBaseline(sprite, tokenDoc);
    }
  }

  /**
   * Apply the current movement-style baseline pose for a single token.
   * Falls back to TokenManager's transform logic when movement manager is
   * unavailable or declines handling.
   * @param {THREE.Sprite} sprite
   * @param {TokenDocument|object} tokenDoc
   * @private
   */
  _applyMovementStyleBaseline(sprite, tokenDoc) {
    if (!sprite || !tokenDoc) return;

    const movementManager = this.movementManager;
    if (!movementManager?.handleTokenSpriteUpdate) {
      this.updateSpriteTransform(sprite, tokenDoc, false);
      return;
    }

    try {
      const handled = !!movementManager.handleTokenSpriteUpdate({
        sprite,
        tokenDoc,
        targetDoc: tokenDoc,
        changes: {},
        options: {},
        animate: false,
        fallback: () => this.updateSpriteTransform(sprite, tokenDoc, false)
      });
      if (!handled) {
        this.updateSpriteTransform(sprite, tokenDoc, false);
      }
    } catch (error) {
      log.warn(`Failed to apply movement baseline for token ${tokenDoc.id}`, error);
      this.updateSpriteTransform(sprite, tokenDoc, false);
    }
  }

  /**
   * Set the EffectComposer instance
   * @param {EffectComposer} composer 
   */
  setEffectComposer(composer) {
    this.effectComposer = composer;
    // Auto-register if already initialized
    if (this.initialized && this.effectComposer) {
      this.effectComposer.addUpdatable(this);
    }
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) {
      log.warn('TokenManager already initialized');
      return;
    }

    this.setupHooks();
    this.initialized = true;
    
    if (this.effectComposer) {
      this.effectComposer.addUpdatable(this);
    }
    
    log.info('TokenManager initialized');
  }

  /**
   * Update tokens (called every frame by EffectComposer)
   * @param {TimeInfo} timeInfo 
   */
  update(timeInfo) {
    // Update window light texture + P4-10: lighting target + outdoors mask for all tokens.
    try {
      const wle = window.MapShine?.windowLightEffect;
      const wlTex = (wle && typeof wle.getLightTexture === 'function') ? wle.getLightTexture() : (wle?.lightTarget?.texture ?? null);
      const hasWindowLight = wlTex ? 1.0 : 0.0;
      const wlW = wle?.lightTarget?.width ?? window.innerWidth ?? 1;
      const wlH = wle?.lightTarget?.height ?? window.innerHeight ?? 1;

      // P4-10: Resolve LightingEffect composite target + outdoors mask once per frame.
      const le = window.MapShine?.lightingEffect;
      const lightTex = le?.lightTarget?.texture ?? null;
      const hasLightTex = lightTex ? 1.0 : 0.0;
      const lightW = le?.lightTarget?.width ?? window.innerWidth ?? 1;
      const lightH = le?.lightTarget?.height ?? window.innerHeight ?? 1;
      const outdoorsTex = le?.outdoorsTarget?.texture ?? null;
      const hasOutdoors = outdoorsTex ? 1.0 : 0.0;

      for (const data of this.tokenSprites.values()) {
        const shader = data?.sprite?.material?.userData?._msTokenCCShader;
        if (!shader?.uniforms) continue;
        const u = shader.uniforms;
        if (u.tWindowLight) {
          u.tWindowLight.value = wlTex || null;
          u.uHasWindowLight.value = hasWindowLight;
          if (u.uWindowLightScreenSize?.value?.set) {
            u.uWindowLightScreenSize.value.set(wlW, wlH);
          }
        }
        // P4-10: Push lighting target + outdoors mask.
        if (u.tLightingTarget !== undefined) {
          u.tLightingTarget.value = lightTex;
          u.uHasLightingTarget.value = hasLightTex;
          if (u.uLightingScreenSize?.value?.set) {
            u.uLightingScreenSize.value.set(lightW, lightH);
          }
        }
        if (u.tOutdoorsMask !== undefined) {
          u.tOutdoorsMask.value = outdoorsTex;
          u.uHasOutdoorsMask.value = hasOutdoors;
        }
      }
    } catch (_) {
    }

    // Process active animations
    for (const [tokenId, anim] of this.activeAnimations.entries()) {
      // Update elapsed time
      anim.elapsed += timeInfo.delta * 1000; // Convert seconds to ms for duration compatibility
      
      const progress = Math.min(anim.elapsed / anim.duration, 1);
      
      // EaseInOutCosine: 0.5 - Math.cos(progress * Math.PI) / 2
      const ease = 0.5 - Math.cos(progress * Math.PI) / 2;

      for (const data of anim.attributes) {
        data.parent[data.attribute] = data.start + (data.diff * ease);
      }

      if (progress >= 1) {
        // Ensure final values are exact
        for (const data of anim.attributes) {
          data.parent[data.attribute] = data.to;
        }
        this.activeAnimations.delete(tokenId);
      }

      const spriteData = this.tokenSprites.get(tokenId);
      const sprite = spriteData?.sprite;
      if (sprite && sprite.matrixAutoUpdate === false) {
        sprite.updateMatrix();
      }
    }

    // Apply global lighting tint to tokens based on scene darkness
    const THREE = window.THREE;
    if (THREE) {
      if (!this._globalTint) this._globalTint = new THREE.Color(1, 1, 1);
      if (!this._daylightTint) this._daylightTint = new THREE.Color(1, 1, 1);
      if (!this._darknessTint) this._darknessTint = new THREE.Color(1, 1, 1);
      if (!this._ambientTint) this._ambientTint = new THREE.Color(1, 1, 1);

      // If LightingEffect is active, token lighting is handled by the lighting composite.
      // Keep token base colors neutral so lights can punch through the global darkness.
      try {
        const le = window.MapShine?.lightingEffect;
        if (le && le.enabled) {
          const globalTint = this._globalTint;
          globalTint.setRGB(1, 1, 1);

          const tintKey = 0xffffff;
          if (!this._tintDirty && tintKey === this._lastTintKey) {
            return;
          }

          this._lastTintKey = tintKey;
          this._tintDirty = false;

          for (const data of this.tokenSprites.values()) {
            const { sprite } = data;
            if (sprite && sprite.material) {
              sprite.material.color.copy(globalTint);
            }
          }
          return;
        }
      } catch (_) {
      }

      const globalTint = this._globalTint;
      globalTint.setRGB(1, 1, 1);

      try {
        const scene = canvas?.scene;
        const env = canvas?.environment;

        if (scene?.environment?.darknessLevel !== undefined) {
          let darkness = scene.environment.darknessLevel;
          const le = window.MapShine?.lightingEffect;
          if (le && typeof le.getEffectiveDarkness === 'function') {
            darkness = le.getEffectiveDarkness();
          }

          const getThreeColor = (src, def, out) => {
            try {
              if (!out) out = new THREE.Color(def);
              if (!src) {
                out.set(def);
                return out;
              }
              if (src instanceof THREE.Color) {
                out.copy(src);
                return out;
              }
              if (src.rgb) {
                out.setRGB(src.rgb[0], src.rgb[1], src.rgb[2]);
                return out;
              }
              if (Array.isArray(src)) {
                out.setRGB(src[0], src[1], src[2]);
                return out;
              }
              out.set(src);
              return out;
            } catch (e) {
              out.set(def);
              return out;
            }
          };

          const daylight = getThreeColor(env?.colors?.ambientDaylight, 0xffffff, this._daylightTint);
          const darknessColor = getThreeColor(env?.colors?.ambientDarkness, 0x242448, this._darknessTint);

          const ambientTint = this._ambientTint.copy(daylight).lerp(darknessColor, darkness);

          const lightLevel = Math.max(1.0 - darkness, 0.25);

          globalTint.copy(ambientTint).multiplyScalar(lightLevel);
        }
      } catch (e) {
      }

      const tr = Math.max(0, Math.min(255, (globalTint.r * 255 + 0.5) | 0));
      const tg = Math.max(0, Math.min(255, (globalTint.g * 255 + 0.5) | 0));
      const tb = Math.max(0, Math.min(255, (globalTint.b * 255 + 0.5) | 0));
      const tintKey = (tr << 16) | (tg << 8) | tb;

      if (!this._tintDirty && tintKey === this._lastTintKey) {
        return;
      }

      this._lastTintKey = tintKey;
      this._tintDirty = false;

      for (const data of this.tokenSprites.values()) {
        const { sprite } = data;
        if (sprite && sprite.material) {
          sprite.material.color.copy(globalTint);
        }
      }

      if (this._tokenCCDirty) {
        this.applyColorCorrectionToAllTokens();
      }
    }
  }

  /**
   * Set up Foundry VTT hooks for token synchronization
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    // Initial load when canvas is ready
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
      log.debug('Canvas ready, syncing all tokens');
      this.syncAllTokens();
    })]);

    // Create new token
    this._hookIds.push(['createToken', Hooks.on('createToken', (tokenDoc, options, userId) => {
      log.debug(`Token created: ${tokenDoc.id}`);
      this.createTokenSprite(tokenDoc);
    })]);

    // Update existing token
    this._hookIds.push(['updateToken', Hooks.on('updateToken', (tokenDoc, changes, options, userId) => {
      log.debug(`Token updated: ${tokenDoc.id}`, changes);
      this.updateTokenSprite(tokenDoc, changes, options);
    })]);

    // Delete token
    this._hookIds.push(['deleteToken', Hooks.on('deleteToken', (tokenDoc, options, userId) => {
      log.debug(`Token deleted: ${tokenDoc.id}`);
      this.removeTokenSprite(tokenDoc.id);
    })]);

    // Refresh token (rendering changes)
    this._hookIds.push(['refreshToken', Hooks.on('refreshToken', (token) => {
      log.debug(`Token refreshed: ${token.id}`);
      // Refresh typically means visual state changed (visibility, effects, etc.)
      this.refreshTokenSprite(token.document);
    })]);

    // Target updates (local + remote users).
    // Foundry emits this whenever a token target state changes, which is the
    // authoritative trigger we should mirror in Three.
    this._hookIds.push(['targetToken', Hooks.on('targetToken', (user, token, targeted) => {
      const tokenId = token?.id ?? token?.document?.id ?? null;
      if (tokenId) this.updateTokenTargetIndicator(tokenId);
      else this.refreshAllTargetIndicators();
    })]);

    // Keep Three selection visuals in sync when control state changes from
    // outside InteractionManager (core keybinds, macros, other modules).
    this._hookIds.push(['controlToken', Hooks.on('controlToken', (token, controlled) => {
      const tokenId = token?.id ?? token?.document?.id ?? null;
      const spriteData = tokenId ? this.tokenSprites.get(tokenId) : null;
      if (!spriteData) return;
      spriteData.isSelected = !!controlled;
      this._updateTokenBorderVisibility(spriteData);
      this._updateNameLabelVisibility(spriteData);
    })]);

    // Keep Three hover visuals in sync for native PIXI hover workflows.
    this._hookIds.push(['hoverToken', Hooks.on('hoverToken', (token, hovered) => {
      const tokenId = token?.id ?? token?.document?.id ?? null;
      const spriteData = tokenId ? this.tokenSprites.get(tokenId) : null;
      if (!spriteData) return;
      spriteData.isHovered = !!hovered;
      this._updateTokenBorderVisibility(spriteData);
      this._updateNameLabelVisibility(spriteData);
    })]);

    // Foundry Alt highlight toggle. Mirror this to Three token overlays.
    this._hookIds.push(['highlightObjects', Hooks.on('highlightObjects', (active) => {
      this._highlightAllTokensActive = !!active;
      this.refreshAllTokenOverlayStates();
    })]);

    this.hooksRegistered = true;
    log.debug('Foundry hooks registered');
  }

  /**
   * Sync all existing tokens from Foundry to THREE.js
   * Called on canvasReady
   * @private
   */
  syncAllTokens() {
    if (!canvas || !canvas.tokens) {
      log.warn('Canvas or tokens layer not available');
      return;
    }

    const tokens = canvas.tokens.placeables || [];
    log.info(`Syncing ${tokens.length} tokens`);

    this._highlightAllTokensActive = !!canvas?.tokens?.highlightObjects;

    for (const token of tokens) {
      this.createTokenSprite(token.document);
    }

    this.refreshAllTokenOverlayStates();
    this.refreshAllTargetIndicators();
  }

  /**
   * Create a THREE.js sprite for a Foundry token
   * @param {TokenDocument} tokenDoc - Foundry token document
   * @private
   */
  async createTokenSprite(tokenDoc) {
    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE.js not available');
      return;
    }

    // Load token texture
    const texturePath = tokenDoc.texture?.src;
    if (!texturePath) {
      log.warn(`Token ${tokenDoc.id} has no texture`);
      return;
    }

    // Create sprite with material
    // P4-01: depthTest/depthWrite follow the tokenDepthInteraction setting.
    // When false (default), tokens always render on top (legacy behaviour).
    // When true, tokens are correctly occluded by elevated foreground tiles.
    const material = new THREE.SpriteMaterial({
      transparent: true,
      alphaTest: 0.1, // Discard fully transparent pixels
      depthTest: this.tokenDepthInteraction,
      depthWrite: this.tokenDepthInteraction,
      sizeAttenuation: true, // Enable perspective scaling - tokens should scale with the world
      side: THREE.DoubleSide // CRITICAL: Prevent culling when projection matrix is flipped
    });
    material.userData._msTokenDoc = tokenDoc;

    this._ensureTokenColorCorrection(material);

    const sprite = new THREE.Sprite(material);
    sprite.name = `Token_${tokenDoc.id}`;
    sprite.matrixAutoUpdate = false;

    // Render tokens in the main scene (layer 0) so they are included in the
    // LightingEffect + post-processing chain.
    // Water/Distortion passes should mask tokens out using tokenMask.screen.
    sprite.layers.set(0);

    // Compositor V2: assign token to its floor layer for layer-based isolation.
    const floorLayerMgr = window.MapShine?.floorLayerManager;
    if (floorLayerMgr) {
      floorLayerMgr.assignTokenToFloor(sprite, tokenDoc);
    }

    // Store token metadata
    sprite.userData = {
      tokenId: tokenDoc.id,
      type: 'token',
    };

    sprite.userData.tokenDoc = tokenDoc;
    sprite.userData._removed = false;

    // Load texture (async, will update material when loaded)
    // IMPORTANT: Token can be deleted before the texture resolves; guard against writing
    // into a disposed material/sprite.
    this.loadTokenTexture(texturePath).then(texture => {
      const currentData = this.tokenSprites.get(tokenDoc.id);
      const currentSprite = currentData?.sprite;
      if (!currentSprite || currentSprite.userData?._removed) return;
      if (!currentSprite.material || currentSprite.material.disposed) return;

      currentSprite.material.map = texture;
      // Restore opacity, but respect VisibilityController authority.
      // If VC is active and the sprite is hidden, don't override opacity —
      // the VC will set the correct opacity when it makes the sprite visible.
      const vc = window.MapShine?.visibilityController;
      if (vc?._initialized) {
        if (currentSprite.visible) {
          currentSprite.material.opacity = currentData?.tokenDoc?.hidden ? 0.5 : 1.0;
        }
        // else: sprite is hidden by VC, leave opacity as-is
      } else {
        currentSprite.material.opacity = 1;
      }
      currentSprite.material.needsUpdate = true;
    }).catch(error => {
      log.error(`Failed to load token texture: ${texturePath}`, error);
    });

    // Set initial position, scale, visibility
    this.updateSpriteTransform(sprite, tokenDoc);
    this.updateSpriteVisibility(sprite, tokenDoc);

    // When VC is active, new sprites must start hidden. The VC will set
    // correct visibility on the next sightRefresh / _refreshVisibility pass.
    // Without this, the THREE.js default (visible=true) would flash tokens.
    const vc = window.MapShine?.visibilityController;
    if (vc?._initialized) {
      sprite.visible = false;
    }
    
    // Start with 0 opacity to prevent white flash before texture loads
    sprite.material.opacity = 0;

    // Add to scene
    // DEBUG: TEMPORARILY DISABLED TOKEN RENDERING
    // log.warn(`DEBUG: Token rendering disabled for ${tokenDoc.id}`);
    this.scene.add(sprite);

    const foundryToken = canvas?.tokens?.get?.(tokenDoc.id) || null;

    // Store reference
    const spriteData = {
      sprite,
      tokenDoc,
      lastUpdate: Date.now(),
      isSelected: !!foundryToken?.controlled,
      isHovered: !!foundryToken?.hover,
      targetIndicator: null,
      targetArrowsGroup: null,
      targetPipsGroup: null,
      targetPipCount: 0,
      targetPipSignature: ''
    };
    this.tokenSprites.set(tokenDoc.id, spriteData);

    // Apply current movement-style baseline immediately so startup/scene-load
    // tokens do not wait for the first movement hook to get correct style pose.
    this._applyMovementStyleBaseline(sprite, tokenDoc);

    this._updateTokenBorderVisibility(spriteData);
    this._updateNameLabelVisibility(spriteData);

    this.updateTokenTargetIndicator(tokenDoc.id);

    // Apply current lighting tint immediately so new tokens (e.g., copy-pasted)
    // pick up scene lighting right away instead of waiting for next update() call
    this._tintDirty = true;
    this._applyLightingTintToSprite(sprite);

    log.debug(`Created token sprite: ${tokenDoc.id} at (${tokenDoc.x}, ${tokenDoc.y}, z=${sprite.position.z})`);
  }

  /**
   * Update an existing token sprite
   * @param {TokenDocument} tokenDoc - Updated token document
   * @param {object} changes - Changed properties
   * @param {object} [options={}] - Update options
   * @private
   */
  updateTokenSprite(tokenDoc, changes, options = {}) {
    const spriteData = this.tokenSprites.get(tokenDoc.id);
    if (!spriteData) {
      // Token doesn't exist yet, create it
      log.warn(`Token sprite not found for update: ${tokenDoc.id}, creating`);
      this.createTokenSprite(tokenDoc);
      return;
    }

    const { sprite } = spriteData;
    
    log.debug(`updateTokenSprite: ${tokenDoc.id} | changes:`, changes);

    // Compositor V2: reassign token to correct floor layer when elevation changes.
    if ('elevation' in changes) {
      const floorLayerMgr = window.MapShine?.floorLayerManager;
      if (floorLayerMgr) {
        floorLayerMgr.assignTokenToFloor(sprite, tokenDoc);
      }
    }

    // Update transform if position/size/elevation changed
    if ('x' in changes || 'y' in changes || 'width' in changes || 
        'height' in changes || 'elevation' in changes || 'rotation' in changes) {
      
      // Create a proxy/merged object for target state
      // We prefer 'changes' values as they are authoritative for the new state
      // This fixes the "lagging behind" issue where tokenDoc might be stale in the hook
      const targetDoc = {
        x: 'x' in changes ? changes.x : tokenDoc.x,
        y: 'y' in changes ? changes.y : tokenDoc.y,
        width: 'width' in changes ? changes.width : tokenDoc.width,
        height: 'height' in changes ? changes.height : tokenDoc.height,
        elevation: 'elevation' in changes ? changes.elevation : tokenDoc.elevation,
        rotation: 'rotation' in changes ? changes.rotation : tokenDoc.rotation,
        // For complex objects like texture, fall back to tokenDoc for now unless critical
        texture: tokenDoc.texture,
        id: tokenDoc.id
      };

      log.debug(`Updating transform for ${tokenDoc.id}: x=${targetDoc.x}, y=${targetDoc.y}, z=${targetDoc.elevation}`);
      
      // Check if we should animate (default true unless specified false)
      // Also, if only elevation/size changed, we might snap? Foundry animates size/elevation too usually.
      const animate = options.animate !== false;

      // Delegate movement-style handling to TokenMovementManager when available.
      // If no custom style is active (or manager declines), fall back to legacy
      // TokenManager transform animation.
      const handledByMovementManager = !!this.movementManager?.handleTokenSpriteUpdate?.({
        sprite,
        tokenDoc,
        targetDoc,
        changes,
        options,
        animate,
        fallback: () => this.updateSpriteTransform(sprite, targetDoc, animate)
      });

      if (!handledByMovementManager) {
        this.updateSpriteTransform(sprite, targetDoc, animate);
      }
    }

    // Update texture if changed
    if ('texture' in changes && changes.texture?.src) {
      const src = changes.texture.src;
      this.loadTokenTexture(src).then(texture => {
        const currentData = this.tokenSprites.get(tokenDoc.id);
        const currentSprite = currentData?.sprite;
        if (!currentSprite || currentSprite.userData?._removed) return;
        if (!currentSprite.material || currentSprite.material.disposed) return;

        currentSprite.material.map = texture;
        currentSprite.material.needsUpdate = true;
      }).catch(error => {
        log.error(`Failed to load updated token texture`, error);
      });
    }

    // Update visibility if hidden state changed
    if ('hidden' in changes) {
      this.updateSpriteVisibility(sprite, tokenDoc);
    }

    // Update stored reference
    spriteData.tokenDoc = tokenDoc;
    spriteData.lastUpdate = Date.now();
    if (sprite.material?.userData) {
      sprite.material.userData._msTokenDoc = tokenDoc;
      this._applyTokenColorCorrectionUniforms(sprite.material, tokenDoc);
    }
    
    // CRITICAL: Update sprite userData so InteractionManager sees the new doc
    sprite.userData.tokenDoc = tokenDoc;

    if ('name' in changes) {
      this._refreshNameLabel(spriteData);
    }

    if ('name' in changes || 'displayName' in changes || 'disposition' in changes) {
      this._updateNameLabelVisibility(spriteData);
    }

    this.updateTokenTargetIndicator(tokenDoc.id);

    log.debug(`Updated token sprite: ${tokenDoc.id}`);
  }

  /**
   * Refresh token sprite (visual state changed)
   * @param {TokenDocument} tokenDoc - Token document
   * @private
   */
  refreshTokenSprite(tokenDoc) {
    const spriteData = this.tokenSprites.get(tokenDoc.id);
    if (!spriteData) return;

    const { sprite } = spriteData;

    const foundryToken = canvas?.tokens?.get?.(tokenDoc.id) || null;
    if (foundryToken) {
      spriteData.isSelected = !!foundryToken.controlled;
      spriteData.isHovered = !!foundryToken.hover;
    }
    
    // Update visibility based on current state
    this.updateSpriteVisibility(sprite, tokenDoc);
    this._updateTokenBorderVisibility(spriteData);
    this._updateNameLabelVisibility(spriteData);
    this.updateTokenTargetIndicator(tokenDoc.id);

    if (sprite.material?.userData) {
      sprite.material.userData._msTokenDoc = tokenDoc;
      this._applyTokenColorCorrectionUniforms(sprite.material, tokenDoc);
    }
  }

  /**
   * Remove a token sprite
   * @param {string} tokenId - Token document ID
   * @private
   */
  removeTokenSprite(tokenId) {
    const spriteData = this.tokenSprites.get(tokenId);
    if (!spriteData) {
      log.warn(`Token sprite not found for removal: ${tokenId}`);
      return;
    }

    const { sprite } = spriteData;

    // If Foundry's Token HUD is currently bound to this token, close it.
    // Otherwise InteractionManager may attempt to reposition HUD for a token whose
    // Three sprite has been removed.
    try {
      const hud = canvas.tokens?.hud;
      const hudTokenId = hud?.object?.id;
      if (hud?.rendered && hudTokenId === tokenId) {
        hud.close();
      }
    } catch (_) {
    }

    // Mark removed early so any in-flight async callbacks can bail.
    try {
      sprite.userData._removed = true;
    } catch (_) {
    }

    this._disposeTokenOverlays(spriteData);

    // Remove from scene
    this.scene.remove(sprite);

    // Dispose material and geometry
    if (sprite.material) {
      if (sprite.material.map) {
        // Don't dispose texture if it's cached for reuse
        // sprite.material.map.dispose();
      }
      sprite.material.dispose();
    }
    sprite.geometry?.dispose();

    // Remove from map
    this.tokenSprites.delete(tokenId);

    this._tintDirty = true;

    log.debug(`Removed token sprite: ${tokenId}`);
  }

  /**
   * Update sprite transform (position, scale, rotation)
   * @param {THREE.Sprite} sprite - THREE.js sprite
   * @param {TokenDocument} tokenDoc - Foundry token document
   * @param {boolean} [animate=false] - Whether to animate the transition
   * @private
   */
  updateSpriteTransform(sprite, tokenDoc, animate = false) {
    // Get grid size for proper scaling
    const grid = canvas?.grid;
    const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0)
      ? grid.sizeX
      : ((grid && typeof grid.size === 'number' && grid.size > 0) ? grid.size : 100);
    const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0)
      ? grid.sizeY
      : ((grid && typeof grid.size === 'number' && grid.size > 0) ? grid.size : 100);
    const gridSize = Math.max(gridSizeX, gridSizeY);
    
    // Get texture scale factors (default to 1)
    const scaleX = tokenDoc.texture?.scaleX ?? 1;
    const scaleY = tokenDoc.texture?.scaleY ?? 1;
    
    // Token width/height are in grid units, convert to pixels AND apply texture scale
    const widthPx = tokenDoc.width * gridSizeX * scaleX;
    const heightPx = tokenDoc.height * gridSizeY * scaleY;
    
    // Convert Foundry position (top-left origin) to THREE.js (center origin)
    const rectWidth = tokenDoc.width * gridSizeX;
    const rectHeight = tokenDoc.height * gridSizeY;
    const centerX = tokenDoc.x + rectWidth / 2;
    
    // Invert Y for Standard Coordinate System
    const sceneHeight = canvas.dimensions?.height || 10000;
    const centerY = sceneHeight - (tokenDoc.y + rectHeight / 2);
    
    // Z-position = groundZ + base + elevation
    const elevation = tokenDoc.elevation || 0;
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    const zPosition = groundZ + TOKEN_BASE_Z + elevation;

    log.debug(`Calculated Sprite Pos: (${centerX}, ${centerY}, ${zPosition}) from Token (${tokenDoc.x}, ${tokenDoc.y})`);
    log.debug(`Current Sprite Pos: (${sprite.position.x}, ${sprite.position.y}, ${sprite.position.z})`);

    // Handle Scale (usually instant)
    // MS-LVL-022: Apply elevation-based scale factor when Levels compatibility
    // is active. Tokens on a different floor than the viewer appear smaller,
    // giving a visual depth cue. The algorithm matches Levels' tokenElevScale:
    // scaleFactor = min(multiplier / (abs(tokenElev - viewerElev) / 8), 1)
    let elevScaleFactor = 1;
    try {
      if (getLevelsCompatibilityMode() !== LEVELS_COMPATIBILITY_MODES.OFF
          && isLevelsEnabledForScene(canvas?.scene)) {
        const tokenElev = Number(tokenDoc.elevation ?? 0);
        const perspective = getPerspectiveElevation();
        const viewerElev = Number(perspective.elevation ?? tokenElev);
        const elevDiff = Math.abs(tokenElev - viewerElev) / 8;
        if (elevDiff > 0) {
          // Default multiplier of 1.0 (Levels default); clamped to [0.3, 1.0]
          elevScaleFactor = Math.max(0.3, Math.min(1.0 / elevDiff, 1));
        }
      }
    } catch (_) {
      // Fail-open: if elevation context is unavailable, keep full scale
    }

    sprite.scale.set(widthPx * elevScaleFactor, heightPx * elevScaleFactor, 1);
    if (sprite.matrixAutoUpdate === false) {
      sprite.updateMatrix();
    }

    // Target Rotation (radians)
    let targetRotation = 0;
    if (tokenDoc.rotation !== undefined) {
      targetRotation = THREE.MathUtils.degToRad(tokenDoc.rotation);
    }

    // Animation Logic
    if (animate && typeof CanvasAnimation !== 'undefined') {
      const attributes = [];
      
      // Position X
      if (Math.abs(sprite.position.x - centerX) > 0.1) {
        attributes.push({ parent: sprite.position, attribute: "x", to: centerX });
      }
      // Position Y
      if (Math.abs(sprite.position.y - centerY) > 0.1) {
        attributes.push({ parent: sprite.position, attribute: "y", to: centerY });
      }
      // Position Z (Elevation)
      if (Math.abs(sprite.position.z - zPosition) > 0.1) {
        attributes.push({ parent: sprite.position, attribute: "z", to: zPosition });
      }
      // Rotation
      if (sprite.material && Math.abs(sprite.material.rotation - targetRotation) > 0.01) {
        attributes.push({ parent: sprite.material, attribute: "rotation", to: targetRotation });
      }

      if (attributes.length > 0) {
        this.emitTokenMovementStart(tokenDoc.id);
        // Calculate duration based on distance
        const dist = Math.hypot(sprite.position.x - centerX, sprite.position.y - centerY);
        
        // If distance is negligible, snap instantly
        if (dist < 1) {
          log.debug(`Distance too small (${dist}), snapping`);
          sprite.position.set(centerX, centerY, zPosition);
          if (sprite.material) sprite.material.rotation = targetRotation;
          if (sprite.matrixAutoUpdate === false) {
            sprite.updateMatrix();
          }
          return;
        }

        const duration = Math.max(250, Math.min((dist / gridSize) * 250, 2000));
        
        log.debug(`Starting animation for ${tokenDoc.id}. Duration: ${duration}, Attrs: ${attributes.length}`);
        
        this.startAnimation(tokenDoc.id, attributes, duration);
        return;
      } else {
        log.debug(`No animation needed for ${tokenDoc.id} (already at target)`);
      }
    } else {
      log.debug(`Skipping animation for ${tokenDoc.id} (animate=${animate})`);
    }

    // Fallback: Instant Snap
    if (
      Math.abs(sprite.position.x - centerX) > 0.1 ||
      Math.abs(sprite.position.y - centerY) > 0.1 ||
      Math.abs(sprite.position.z - zPosition) > 0.1
    ) {
      this.emitTokenMovementStart(tokenDoc.id);
    }
    sprite.position.set(centerX, centerY, zPosition);
    if (sprite.material) {
      sprite.material.rotation = targetRotation;
    }
    if (sprite.matrixAutoUpdate === false) {
      sprite.updateMatrix();
    }
  }

  /**
   * Start a token animation (managed by main loop)
   * @param {string} tokenId 
   * @param {Array} attributes 
   * @param {number} duration 
   * @private
   */
  startAnimation(tokenId, attributes, duration) {
    // Cancel existing (overwrite)
    this.activeAnimations.delete(tokenId);

    // Ensure smooth visuals while tokens animate.
    // Without this, idle frame skipping can throttle rendering (camera is static),
    // which makes movement appear "steppy".
    try {
      const rl = window.MapShine?.renderLoop;
      if (rl?.requestContinuousRender) {
        // Add a small buffer to cover timing jitter.
        rl.requestContinuousRender((Number(duration) || 0) + 50);
      } else if (rl?.requestRender) {
        rl.requestRender();
      }
    } catch (_) {
    }

    // Capture start values and calculate diffs
    const animAttributes = attributes.map(attr => ({
      parent: attr.parent,
      attribute: attr.attribute,
      start: attr.parent[attr.attribute], // Current value is start
      to: attr.to,
      diff: attr.to - attr.parent[attr.attribute]
    }));

    log.debug(`startAnimation: ${tokenId}, duration=${duration}, diffs=${animAttributes.map(a => a.diff).join(',')}`);

    this.activeAnimations.set(tokenId, {
      attributes: animAttributes,
      duration: duration,
      elapsed: 0
    });
  }

  /**
   * Update sprite visibility based on token state
   * @param {THREE.Sprite} sprite - THREE.js sprite
   * @param {TokenDocument} tokenDoc - Foundry token document
   * @private
   */
  updateSpriteVisibility(sprite, tokenDoc) {
    // When the VisibilityController is active, it is the SOLE authority on
    // Three.js sprite visibility (via _refreshVisibility patch + sightRefresh
    // hook). Do NOT touch sprite.visible here — doing so would race with
    // the VC and cause tokens to flicker or stay permanently hidden.
    const vc = window.MapShine?.visibilityController;
    if (vc?._initialized) {
      return;
    }

    // Fallback when no VisibilityController is active (e.g. during init)
    if (tokenDoc.hidden) {
      sprite.visible = game.user?.isGM || false;
      sprite.material.opacity = 0.5;
    } else {
      sprite.visible = true;
      sprite.material.opacity = 1.0;
    }

    // Level-based filtering: hide tokens above the current active level.
    // This mirrors VisibilityController._isTokenAboveCurrentLevel for
    // the fallback path when the VC is not yet initialized.
    if (sprite.visible) {
      try {
        const levelContext = window.MapShine?.activeLevelContext;
        if (levelContext && Number.isFinite(levelContext.top) && (levelContext.count ?? 0) > 1) {
          const tokenElev = Number(tokenDoc?.elevation ?? 0);
          if (Number.isFinite(tokenElev) && tokenElev >= levelContext.top - 0.01) {
            sprite.visible = false;
          }
        }
      } catch (_) {
        // Fail-open: if level context is unavailable, keep visibility as-is
      }
    }
  }

  /**
   * Ensure a token has a target indicator group.
   * The indicator mirrors Foundry's targeting semantics:
   * - local user target => ring
   * - other users targeting => pips
   *
   * @param {TokenSpriteData} spriteData
   * @returns {void}
   */
  _ensureTargetIndicator(spriteData) {
    if (!spriteData || spriteData.targetIndicator) return;

    const THREE = window.THREE;
    const sprite = spriteData.sprite;
    if (!THREE || !sprite) return;

    const indicator = new THREE.Group();
    indicator.name = 'TargetIndicator';
    indicator.matrixAutoUpdate = false;
    indicator.visible = false;
    indicator.layers.set(OVERLAY_THREE_LAYER);

    const arrowsGroup = new THREE.Group();
    arrowsGroup.name = 'TargetArrows';
    arrowsGroup.matrixAutoUpdate = false;
    arrowsGroup.visible = false;
    arrowsGroup.layers.set(OVERLAY_THREE_LAYER);

    const makeArrow = (x0, y0, x1, y1, x2, y2) => {
      const geometry = new THREE.BufferGeometry();
      const vertices = new Float32Array([
        x0, y0, 0,
        x1, y1, 0,
        x2, y2, 0
      ]);
      geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      geometry.computeVertexNormals();

      const material = new THREE.MeshBasicMaterial({
        color: 0xff9829,
        transparent: true,
        opacity: 0.98,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.layers.set(OVERLAY_THREE_LAYER);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      return mesh;
    };

    const m = 0.02;
    const l = 0.16;
    const xL = -0.5 + m;
    const xR = 0.5 - m;
    const yT = 0.5 - m;
    const yB = -0.5 + m;

    arrowsGroup.add(makeArrow(xL, yT, xL - l, yT, xL, yT + l)); // top-left
    arrowsGroup.add(makeArrow(xR, yT, xR + l, yT, xR, yT + l)); // top-right
    arrowsGroup.add(makeArrow(xL, yB, xL - l, yB, xL, yB - l)); // bottom-left
    arrowsGroup.add(makeArrow(xR, yB, xR + l, yB, xR, yB - l)); // bottom-right
    arrowsGroup.updateMatrix();

    const pipsGroup = new THREE.Group();
    pipsGroup.name = 'TargetPips';
    pipsGroup.matrixAutoUpdate = false;
    pipsGroup.visible = false;
    pipsGroup.layers.set(OVERLAY_THREE_LAYER);
    pipsGroup.updateMatrix();

    indicator.add(arrowsGroup);
    indicator.add(pipsGroup);
    sprite.add(indicator);
    indicator.updateMatrix();

    spriteData.targetIndicator = indicator;
    spriteData.targetArrowsGroup = arrowsGroup;
    spriteData.targetPipsGroup = pipsGroup;
    spriteData.targetPipCount = 0;
    spriteData.targetPipSignature = '';
  }

  /**
   * @param {string|number|undefined|null} color
   * @param {number} fallback
   * @returns {number}
   */
  _parseColorHex(color, fallback) {
    if (typeof color === 'number' && Number.isFinite(color)) return color;
    if (typeof color === 'string') {
      const cleaned = color.trim().replace(/^#/, '');
      if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return parseInt(cleaned, 16);
    }
    return fallback;
  }

  /**
   * @returns {number}
   */
  _getSelfTargetColor() {
    const userColor = game?.user?.color;
    return this._parseColorHex(userColor, 0xff9829);
  }

  /**
   * Get non-self users currently targeting a token.
   * @param {Token|null} token
   * @returns {Array<User>}
   */
  _getOtherTargetUsers(token) {
    if (!token) return [];

    try {
      if (token.targeted && typeof token.targeted[Symbol.iterator] === 'function') {
        return Array.from(token.targeted).filter((user) => user && !user.isSelf);
      }
    } catch (_) {
    }

    const users = [];
    try {
      for (const user of game?.users || []) {
        if (!user || user.isSelf) continue;
        if (user?.targets?.has?.(token)) users.push(user);
      }
    } catch (_) {
    }
    return users;
  }

  /**
   * Rebuild target pips to match non-self targeting users, colored per-user.
   * @param {TokenSpriteData} spriteData
   * @param {Array<User>} targetUsers - Non-self users targeting this token
   */
  _refreshTargetPips(spriteData, targetUsers) {
    const THREE = window.THREE;
    const group = spriteData?.targetPipsGroup;
    if (!THREE || !group) return;

    const users = Array.isArray(targetUsers) ? targetUsers.slice(0, 8) : [];
    const count = users.length;
    const signature = users.map((user) => `${user.id}:${String(user.color || '')}`).join('|');
    if (spriteData.targetPipCount === count && spriteData.targetPipSignature === signature) {
      group.visible = count > 0;
      return;
    }

    for (let i = group.children.length - 1; i >= 0; i--) {
      const pip = group.children[i];
      group.remove(pip);
      pip.geometry?.dispose?.();
      pip.material?.dispose?.();
    }

    if (count > 0) {
      const spacing = 0.14;
      const startX = -((count - 1) * spacing) / 2;
      const y = 0.72;
      for (let i = 0; i < count; i++) {
        const userColor = this._parseColorHex(users[i]?.color, 0x7fd6ff);
        const geometry = new THREE.CircleGeometry(0.045, 12);
        const material = new THREE.MeshBasicMaterial({
          color: userColor,
          transparent: true,
          opacity: 0.95,
          depthTest: false,
          depthWrite: false
        });
        const pip = new THREE.Mesh(geometry, material);
        pip.position.set(startX + (i * spacing), y, 0);
        pip.layers.set(OVERLAY_THREE_LAYER);
        pip.matrixAutoUpdate = false;
        pip.updateMatrix();
        group.add(pip);
      }
    }

    group.visible = count > 0;
    group.updateMatrix();
    spriteData.targetPipCount = count;
    spriteData.targetPipSignature = signature;
  }

  /**
   * Update one token's target indicator from Foundry's authoritative state.
   * @param {string} tokenId
   */
  updateTokenTargetIndicator(tokenId) {
    if (!tokenId) return;
    const spriteData = this.tokenSprites.get(tokenId);
    if (!spriteData) return;

    this._ensureTargetIndicator(spriteData);

    const indicator = spriteData.targetIndicator;
    const arrows = spriteData.targetArrowsGroup;
    if (!indicator || !arrows) return;

    const token = canvas?.tokens?.get?.(tokenId) || null;
    if (!token) {
      indicator.visible = false;
      arrows.visible = false;
      this._refreshTargetPips(spriteData, []);
      return;
    }

    let isSecret = false;
    try {
      isSecret = !!token.document?.isSecret && !game?.user?.isGM && !token.document?.isOwner;
    } catch (_) {
      isSecret = false;
    }
    if (isSecret) {
      indicator.visible = false;
      arrows.visible = false;
      this._refreshTargetPips(spriteData, []);
      return;
    }

    const isLocalTargeted = !!token.isTargeted || !!game?.user?.targets?.has?.(token);
    const otherTargetUsers = this._getOtherTargetUsers(token);

    arrows.visible = isLocalTargeted;
    if (isLocalTargeted) {
      const selfColor = this._getSelfTargetColor();
      for (const child of arrows.children || []) {
        if (child?.material?.color?.setHex) child.material.color.setHex(selfColor);
      }
    }

    this._refreshTargetPips(spriteData, otherTargetUsers);
    indicator.visible = isLocalTargeted || (otherTargetUsers.length > 0);
  }

  /**
   * Refresh all target indicators.
   */
  refreshAllTargetIndicators() {
    for (const tokenId of this.tokenSprites.keys()) {
      this.updateTokenTargetIndicator(tokenId);
    }
  }

  /**
   * Dispose per-token overlays (selection border, labels, target indicators).
   * @param {TokenSpriteData} spriteData
   */
  _disposeTokenOverlays(spriteData) {
    if (!spriteData) return;

    try {
      if (spriteData.selectionBorder) {
        spriteData.selectionBorder.parent?.remove?.(spriteData.selectionBorder);
        spriteData.selectionBorder.geometry?.dispose?.();
        spriteData.selectionBorder.material?.dispose?.();
        spriteData.selectionBorder = null;
      }
    } catch (_) {
    }

    try {
      const label = spriteData.nameLabel;
      if (label) {
        label.parent?.remove?.(label);
        label.material?.map?.dispose?.();
        label.material?.dispose?.();
        spriteData.nameLabel = null;
      }
    } catch (_) {
    }

    try {
      const indicator = spriteData.targetIndicator;
      if (indicator) {
        for (const child of indicator.children || []) {
          if (child.type === 'Group') {
            for (const nested of child.children || []) {
              nested.geometry?.dispose?.();
              nested.material?.dispose?.();
            }
          }
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        }
        indicator.parent?.remove?.(indicator);
        spriteData.targetIndicator = null;
        spriteData.targetArrowsGroup = null;
        spriteData.targetPipsGroup = null;
        spriteData.targetPipCount = 0;
        spriteData.targetPipSignature = '';
      }
    } catch (_) {
    }
  }

  /**
   * Set token selection state
   * @param {string} tokenId 
   * @param {boolean} selected 
   */
  setTokenSelection(tokenId, selected) {
    const spriteData = this.tokenSprites.get(tokenId);
    if (!spriteData) return;

    const { sprite, tokenDoc } = spriteData;

    spriteData.isSelected = !!selected;

    this._updateTokenBorderVisibility(spriteData);

    this._updateNameLabelVisibility(spriteData);
    
    // Reset tint
    sprite.material.color.setHex(0xffffff);
    this._tintDirty = true;
  }

  /**
   * Set token hover state
   * @param {string} tokenId 
   * @param {boolean} hovered 
   */
  setHover(tokenId, hovered) {
    const spriteData = this.tokenSprites.get(tokenId);
    if (!spriteData) return;

    spriteData.isHovered = !!hovered;

    this._updateTokenBorderVisibility(spriteData);
    this._updateNameLabelVisibility(spriteData);
  }

  refreshAllTokenOverlayStates() {
    for (const spriteData of this.tokenSprites.values()) {
      this._updateTokenBorderVisibility(spriteData);
      this._updateNameLabelVisibility(spriteData);
    }
  }

  _isGlobalTokenHighlightActive() {
    const highlighted = this._highlightAllTokensActive || !!canvas?.tokens?.highlightObjects;
    if (!highlighted) return false;

    // Guard against stuck highlight state: Foundry highlight is key-held. If the
    // key-up is missed (focus loss, input interception), layer state can remain true.
    // In that case, treat highlight as inactive to avoid global hostile red borders.
    try {
      const keyboard = game?.keyboard;
      if (keyboard?.isCoreActionKeyActive && !keyboard.isCoreActionKeyActive('highlight')) {
        return false;
      }
    } catch (_) {
      // Fail-open to the Foundry flag if keyboard state is unavailable.
    }

    return true;
  }

  _shouldShowTokenBorder(spriteData) {
    const highlighted = this._isGlobalTokenHighlightActive();
    return !!(spriteData?.isSelected || spriteData?.isHovered || highlighted);
  }

  _getTokenBorderColor(tokenDoc, isSelected) {
    const colors = CONFIG?.Canvas?.dispositionColors || {};
    if (isSelected) return colors.CONTROLLED ?? 0xFF9829;

    const disp = tokenDoc?.disposition;
    if (disp === CONST?.TOKEN_DISPOSITIONS?.FRIENDLY) return colors.FRIENDLY ?? 0x43DFDF;
    if (disp === CONST?.TOKEN_DISPOSITIONS?.NEUTRAL) return colors.NEUTRAL ?? 0xF1D836;
    if (disp === CONST?.TOKEN_DISPOSITIONS?.HOSTILE) return colors.HOSTILE ?? 0xE72124;
    return colors.INACTIVE ?? 0xFFFFFF;
  }

  _updateTokenBorderVisibility(spriteData) {
    if (!spriteData) return;

    const show = this._shouldShowTokenBorder(spriteData);
    if (show && !spriteData.selectionBorder) {
      this.createSelectionBorder(spriteData);
    }

    if (!spriteData.selectionBorder) return;

    spriteData.selectionBorder.visible = show;
    const color = this._getTokenBorderColor(spriteData.tokenDoc, !!spriteData.isSelected);
    if (spriteData.selectionBorder.material?.color?.setHex) {
      spriteData.selectionBorder.material.color.setHex(color);
    }
  }

  _refreshNameLabel(spriteData) {
    const label = spriteData?.nameLabel;
    const sprite = spriteData?.sprite;
    if (!label || !sprite) return;

    try {
      sprite.remove(label);
    } catch (_) {
    }

    try {
      const map = label.material?.map;
      if (map) map.dispose();
      label.material?.dispose?.();
    } catch (_) {
    }

    spriteData.nameLabel = null;
  }

  _canViewMode(mode, spriteData) {
    try {
      const m = mode ?? CONST?.TOKEN_DISPLAY_MODES?.NONE;
      if (m === CONST.TOKEN_DISPLAY_MODES.NONE) return false;
      if (m === CONST.TOKEN_DISPLAY_MODES.ALWAYS) return true;
      if (m === CONST.TOKEN_DISPLAY_MODES.CONTROL) return !!spriteData?.isSelected;

      const hover = !!spriteData?.isHovered || this._isGlobalTokenHighlightActive();
      if (m === CONST.TOKEN_DISPLAY_MODES.HOVER) return hover;

      const isOwner = !!spriteData?.tokenDoc?.isOwner
        || !!spriteData?.tokenDoc?.actor?.testUserPermission?.(game.user, 'OWNER')
        || !!game?.user?.isGM;

      if (m === CONST.TOKEN_DISPLAY_MODES.OWNER_HOVER) return isOwner && hover;
      if (m === CONST.TOKEN_DISPLAY_MODES.OWNER) return isOwner;
      return false;
    } catch (_) {
      return false;
    }
  }

  _updateNameLabelVisibility(spriteData) {
    const tokenDoc = spriteData?.tokenDoc;
    if (!tokenDoc) return;

    let isOwner = false;
    try {
      isOwner = !!tokenDoc.isOwner || !!tokenDoc.actor?.testUserPermission?.(game.user, 'OWNER') || !!game?.user?.isGM;
    } catch (_) {
      isOwner = !!game?.user?.isGM;
    }

    let isSecret = false;
    try {
      isSecret = tokenDoc.disposition === CONST.TOKEN_DISPOSITIONS.SECRET && !isOwner;
    } catch (_) {
      isSecret = false;
    }

    const visible = !isSecret && this._canViewMode(tokenDoc.displayName, spriteData);

    if (visible && !spriteData.nameLabel) {
      this.createNameLabel(spriteData);
    }

    if (spriteData.nameLabel) {
      spriteData.nameLabel.visible = visible;
    }
  }

  /**
   * Create selection border for a token
   * @param {object} spriteData 
   * @private
   */
  createSelectionBorder(spriteData) {
    const THREE = window.THREE;
    const { sprite, tokenDoc } = spriteData;
    
    // Create square geometry (1x1, centered)
    // Vertices: TopLeft, TopRight, BottomRight, BottomLeft
    const points = [];
    points.push(new THREE.Vector3(-0.5, 0.5, 0));
    points.push(new THREE.Vector3(0.5, 0.5, 0));
    points.push(new THREE.Vector3(0.5, -0.5, 0));
    points.push(new THREE.Vector3(-0.5, -0.5, 0));
    
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    
    // Orange/Yellow selection color: 0xFF9829 (Foundry-ish)
    const material = new THREE.LineBasicMaterial({ 
      color: 0xFF9829, 
      linewidth: 2, // Note: WebGL lineWidth often limited to 1
      depthTest: false, // Always show on top
      depthWrite: false
    });
    
    const border = new THREE.LineLoop(geometry, material);
    border.name = 'SelectionBorder';
    border.matrixAutoUpdate = false;
    // Render selection border in overlay pass so it's not affected by bloom
    border.layers.set(OVERLAY_THREE_LAYER);
    
    // Scale to match sprite (which matches token size)
    // Sprite has scale set to pixel width/height
    // But we are adding as child of sprite? 
    // If child of sprite, it inherits sprite scale.
    // Since sprite is 1x1 geometry scaled to WxH.
    // Our border is 1x1. So it matches perfectly.
    // BUT sprite might be scaled differently if texture is non-square?
    // TokenManager sets sprite scale to (widthPx, heightPx, 1).
    // So child at scale (1,1,1) will stretch to (widthPx, heightPx).
    // Correct.
    
    // Z-offset to prevent z-fighting with token? 
    // Token is at Z=10. Border at Z=0 relative to token.
    // We set depthTest: false so it draws on top.
    
    sprite.add(border);
    border.updateMatrix();
    spriteData.selectionBorder = border;
  }

  /**
   * Create name label for a token
   * @param {object} spriteData 
   * @private
   */
  createNameLabel(spriteData) {
    const THREE = window.THREE;
    const { sprite, tokenDoc } = spriteData;
    
    // Create canvas for text
    // High resolution for crisp rendering
    const fontSize = 96; 
    const padding = 20;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const text = tokenDoc.name || "Unknown";
    const font = `bold ${fontSize}px Arial, sans-serif`;
    
    ctx.font = font;
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const canvasWidth = Math.ceil(textWidth + padding * 2);
    const canvasHeight = Math.ceil(fontSize * 1.4); // Room for descenders/outline
    
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    
    // Text Configuration
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Center position
    const cx = canvasWidth / 2;
    const cy = canvasHeight / 2;

    // Text Outline (Stroke) for readability without background
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 8; // Thick outline
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeText(text, cx, cy);
    
    // Text Fill
    ctx.fillStyle = 'white';
    ctx.fillText(text, cx, cy);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace; // Ensure correct colors
    
    const material = new THREE.SpriteMaterial({ 
      map: texture, 
      transparent: true,
      depthTest: false // Always on top
    });
    
    const label = new THREE.Sprite(material);
    label.name = 'NameLabel';
    label.matrixAutoUpdate = false;
    // Render label in overlay pass so it's not affected by bloom
    label.layers.set(OVERLAY_THREE_LAYER);
    
    // Scale calculation:
    // Maintain constant world height regardless of resolution
    const parentScaleX = sprite.scale.x || 100;
    const parentScaleY = sprite.scale.y || 100;
    
    // Target height in world units (approx 1/3 grid square)
    // Slightly adjusted for visual balance
    const targetHeight = 30; 
    const aspectRatio = canvasWidth / canvasHeight;
    const targetWidth = targetHeight * aspectRatio;
    
    // Apply relative scale to counteract parent scaling
    label.scale.set(
      targetWidth / parentScaleX,
      targetHeight / parentScaleY,
      1
    );
    
    // Position above token
    const relativeLabelHeight = targetHeight / parentScaleY;
    // 0.5 is top edge. Move up by half label height + margin.
    label.position.set(0, 0.5 + (relativeLabelHeight / 2) + 0.05, 0);
    label.updateMatrix();
    
    sprite.add(label);
    spriteData.nameLabel = label;
  }

  /**
   * Load texture with caching
   * @param {string} texturePath - Path to texture
   * @returns {Promise<THREE.Texture>}
   * @private
   */
  async loadTokenTexture(texturePath) {
    // Check cache first
    if (this.textureCache.has(texturePath)) {
      return this.textureCache.get(texturePath);
    }

    // Load new texture
    return new Promise((resolve, reject) => {
      this.textureLoader.load(
        texturePath,
        (texture) => {
          // Configure texture
          texture.colorSpace = THREE.SRGBColorSpace;
          this._configureTokenTextureFiltering(texture);
          texture.needsUpdate = true;
          
          // Cache for reuse
          this.textureCache.set(texturePath, texture);
          
          resolve(texture);
        },
        undefined, // onProgress
        (error) => {
          reject(error);
        }
      );
    });
  }

  /**
   * Get token sprite by Foundry token ID
   * @param {string} tokenId - Token document ID
   * @returns {THREE.Sprite|null}
   * @public
   */
  getTokenSprite(tokenId) {
    return this.tokenSprites.get(tokenId)?.sprite || null;
  }

  /**
   * Get all token sprites
   * @returns {THREE.Sprite[]}
   * @public
   */
  getAllTokenSprites() {
    return Array.from(this.tokenSprites.values()).map(data => data.sprite);
  }

  /**
   * Dispose all resources
   * @public
   */
  dispose() {
    log.info(`Disposing TokenManager with ${this.tokenSprites.size} tokens`);

    // Unregister Foundry hooks using correct two-argument signature
    try {
      if (this._hookIds && this._hookIds.length) {
        for (const [hookName, hookId] of this._hookIds) {
          try {
            Hooks.off(hookName, hookId);
          } catch (e) {
          }
        }
      }
    } catch (e) {
    }
    this._hookIds = [];
    this.hooksRegistered = false;

    // Remove all token sprites
    for (const [tokenId, data] of this.tokenSprites.entries()) {
      this._disposeTokenOverlays(data);
      this.scene.remove(data.sprite);
      data.sprite.material?.dispose();
      data.sprite.geometry?.dispose();
    }

    this.tokenSprites.clear();

    // Dispose cached textures
    for (const texture of this.textureCache.values()) {
      texture.dispose();
    }
    this.textureCache.clear();

    this.initialized = false;
    
    log.info('TokenManager disposed');
  }

  /**
   * Get statistics for debugging
   * @returns {object}
   * @public
   */
  getStats() {
    return {
      tokenCount: this.tokenSprites.size,
      cachedTextures: this.textureCache.size,
      initialized: this.initialized,
      hooksRegistered: this.hooksRegistered
    };
  }
}

/**
 * @typedef {object} TokenSpriteData
 * @property {THREE.Sprite} sprite - THREE.js sprite
 * @property {TokenDocument} tokenDoc - Foundry token document
 * @property {number} lastUpdate - Timestamp of last update
 */
