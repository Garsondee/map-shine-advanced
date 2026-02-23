/**
 * @fileoverview GLSL shaders for V2 Specular Effect.
 *
 * V2 design: specular-only additive overlays rendered on top of albedo tiles.
 * The fragment shader outputs specular color only (no albedo pass). The mesh
 * uses AdditiveBlending so specular light adds naturally on top of the base.
 *
 * Stripped from V1:
 *   - uOutputMode branching (always specular-only)
 *   - Floor-presence gate (tFloorPresence, tBelowFloorPresence, uFloorPresenceGate)
 *   - Below-floor specular blending (tBelowSpecularMap)
 *   - Depth-pass occlusion (uUseDepthPass, uDepthPassTexture)
 *   - uTileAlphaClip (alpha clipping handled by simple discard on albedo.a)
 *
 * Preserved from V1 (all visual features):
 *   - Multi-layer animated stripes with parallax, waviness, gaps
 *   - Micro sparkles
 *   - Wet surface (rain) specular from albedo grayscale
 *   - Frost/ice glaze
 *   - Outdoor cloud specular
 *   - Dynamic light falloff and color tinting
 *   - Building shadow suppression
 *   - Wind-driven ripple on wet surfaces
 *   - Reinhard-Jodie tone mapping
 *   - World-space pattern coordinates
 *
 * @module compositor-v2/effects/specular-shader
 */

// ─── Vertex Shader ───────────────────────────────────────────────────────────

export function getVertexShader() {
  return /* glsl */`
    varying vec2 vUv;
    varying vec3 vWorldPosition;

    void main() {
      vUv = uv;
      vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
}

// ─── Fragment Shader ─────────────────────────────────────────────────────────

/**
 * @param {number} maxLights - Maximum number of dynamic lights (compile-time constant)
 * @returns {string} GLSL fragment shader source
 */
export function getFragmentShader(maxLights = 64) {
  return /* glsl */`
    // ── Texture samplers ──────────────────────────────────────────────────────
    uniform sampler2D uAlbedoMap;      // Tile albedo (needed for wet specular + alpha clip)
    uniform sampler2D uSpecularMap;    // _Specular mask (intensity)
    uniform sampler2D uRoughnessMap;   // _Roughness mask (optional)
    uniform sampler2D uNormalMap;      // _Normal map (optional, reserved for future)

    uniform bool uHasRoughnessMap;
    uniform bool uHasNormalMap;

    // ── Global toggles ────────────────────────────────────────────────────────
    uniform bool uEffectEnabled;

    // ── PBR parameters ────────────────────────────────────────────────────────
    uniform float uSpecularIntensity;
    uniform float uRoughness;

    // ── Lighting ──────────────────────────────────────────────────────────────
    uniform vec3 uLightDirection;
    uniform vec3 uLightColor;
    uniform vec3 uCameraPosition;
    uniform vec2 uCameraOffset;  // Camera pan offset for parallax

    // ── Time ──────────────────────────────────────────────────────────────────
    uniform float uTime;

    // ── Multi-layer stripe system ─────────────────────────────────────────────
    uniform bool  uStripeEnabled;
    uniform float uStripeBlendMode;
    uniform float uParallaxStrength;
    uniform float uStripeMaskThreshold;
    uniform float uWorldPatternScale;

    // Layer 1
    uniform bool  uStripe1Enabled;
    uniform float uStripe1Frequency;
    uniform float uStripe1Speed;
    uniform float uStripe1Angle;
    uniform float uStripe1Width;
    uniform float uStripe1Intensity;
    uniform float uStripe1Parallax;
    uniform float uStripe1Wave;
    uniform float uStripe1Gaps;
    uniform float uStripe1Softness;

    // Layer 2
    uniform bool  uStripe2Enabled;
    uniform float uStripe2Frequency;
    uniform float uStripe2Speed;
    uniform float uStripe2Angle;
    uniform float uStripe2Width;
    uniform float uStripe2Intensity;
    uniform float uStripe2Parallax;
    uniform float uStripe2Wave;
    uniform float uStripe2Gaps;
    uniform float uStripe2Softness;

    // Layer 3
    uniform bool  uStripe3Enabled;
    uniform float uStripe3Frequency;
    uniform float uStripe3Speed;
    uniform float uStripe3Angle;
    uniform float uStripe3Width;
    uniform float uStripe3Intensity;
    uniform float uStripe3Parallax;
    uniform float uStripe3Wave;
    uniform float uStripe3Gaps;
    uniform float uStripe3Softness;

    // ── Micro Sparkle ─────────────────────────────────────────────────────────
    uniform bool uSparkleEnabled;
    uniform float uSparkleIntensity;
    uniform float uSparkleScale;
    uniform float uSparkleSpeed;

    // ── Outdoor cloud specular ────────────────────────────────────────────────
    uniform bool uOutdoorCloudSpecularEnabled;
    uniform float uOutdoorStripeBlend;
    uniform float uCloudSpecularIntensity;

    // ── Wet surface (rain) ────────────────────────────────────────────────────
    uniform bool uWetSpecularEnabled;
    uniform float uRainWetness;        // 0=dry, 1=fully wet
    // Input CC
    uniform float uWetInputBrightness;
    uniform float uWetInputGamma;
    uniform float uWetSpecularContrast;
    uniform float uWetBlackPoint;
    uniform float uWetWhitePoint;
    // Output CC
    uniform float uWetSpecularIntensity;
    uniform float uWetOutputMax;
    uniform float uWetOutputGamma;

    // ── Outdoor/roof mask ─────────────────────────────────────────────────────
    uniform sampler2D uRoofMap;
    uniform float uRoofMaskEnabled;
    uniform vec4 uSceneBounds;         // (sceneX, sceneY_world, sceneW, sceneH)

    // ── Cloud shadow map ──────────────────────────────────────────────────────
    uniform bool uHasCloudShadowMap;
    uniform sampler2D uCloudShadowMap;
    uniform vec2 uScreenSize;

    // ── Foundry environment ───────────────────────────────────────────────────
    uniform float uDarknessLevel;
    uniform vec3 uAmbientDaylight;
    uniform vec3 uAmbientDarkness;
    uniform vec3 uAmbientBrightest;

    // ── Dynamic lights ────────────────────────────────────────────────────────
    uniform int numLights;
    uniform vec3 lightPosition[${maxLights}];
    uniform vec3 lightColor[${maxLights}];
    uniform vec4 lightConfig[${maxLights}]; // (radius, dim, attenuation, unused)

    // ── Frost / Ice Glaze ─────────────────────────────────────────────────────
    uniform bool uFrostGlazeEnabled;
    uniform float uFrostLevel;
    uniform float uFrostIntensity;
    uniform float uFrostTintStrength;

    // ── Dynamic light color tinting ───────────────────────────────────────────
    uniform bool uDynamicLightTintEnabled;
    uniform float uDynamicLightTintStrength;

    // ── Wind-driven stripe animation ──────────────────────────────────────────
    uniform bool uWindDrivenStripesEnabled;
    uniform float uWindStripeInfluence;
    uniform vec2 uWindAccum;

    // ── Building shadow suppression ───────────────────────────────────────────
    uniform bool uBuildingShadowSuppressionEnabled;
    uniform float uBuildingShadowSuppressionStrength;
    uniform bool uHasBuildingShadowMap;
    uniform sampler2D uBuildingShadowMap;

    // ── Varyings ──────────────────────────────────────────────────────────────
    varying vec2 vUv;
    varying vec3 vWorldPosition;

    // ── Noise helpers ─────────────────────────────────────────────────────────

    float noise1D(float p) {
      return fract(sin(p * 127.1) * 43758.5453);
    }

    float hash12(vec2 p) {
      vec3 p3  = fract(vec3(p.xyx) * .1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float sparkleNoise(vec2 uv, float scale, float time, float speed) {
      vec2 p = uv * scale;
      vec2 id = floor(p);
      float rnd = hash12(id);
      float phase = time * speed + rnd * 6.28;
      float blink = max(0.0, sin(phase) - 0.8) * 5.0;
      return blink * rnd;
    }

    // Simplex 2D noise for stripe distortion and gaps
    vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }

    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                          -0.577350269189626, 0.024390243902439);
      vec2 i  = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod(i, 289.0);
      vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
                      + i.x + vec3(0.0, i1.x, 1.0 ));
      vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
      m *= m;
      m *= m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
      vec3 g;
      g.x  = a0.x  * x0.x  + h.x  * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    // ── Stripe layer generator ────────────────────────────────────────────────

    float generateStripeLayer(
      vec2 uv,
      vec3 worldPos,
      vec3 cameraPos,
      float time,
      float frequency,
      float speed,
      float angle,
      float width,
      float parallaxDepth,
      float parallaxStrength,
      float wave,
      float gaps,
      float softness
    ) {
      // Freeze animation when speed is effectively zero.
      float timeAnim = (abs(speed) > 0.000001) ? time : 0.0;
      float speedAnimScale = clamp(abs(speed) / 0.01, 0.0, 10.0);

      // Camera-based parallax offset
      vec2 parallaxUv = uv;
      if (parallaxDepth != 0.0) {
        vec2 offset = uCameraOffset * parallaxDepth * parallaxStrength * 0.001;
        parallaxUv -= offset;
      }

      // Waviness distortion
      if (wave > 0.0) {
        float waveNoise = snoise(parallaxUv * 2.0 + timeAnim * (0.1 * speedAnimScale));
        parallaxUv += waveNoise * wave * 0.05;
      }

      // Rotate UV by angle
      float rad = radians(angle);
      float cosA = cos(rad);
      float sinA = sin(rad);
      vec2 rotUv = vec2(
        parallaxUv.x * cosA - parallaxUv.y * sinA,
        parallaxUv.x * sinA + parallaxUv.y * cosA
      );

      // Scrolling stripes
      float pos = rotUv.x * frequency + timeAnim * speed;
      float stripe = fract(pos);

      // Map width (0-1) to band half-size
      float w = clamp(width, 0.0, 1.0);
      float bandHalfWidth = mix(0.02, 0.48, w);

      // Subtle jitter per stripe
      float noiseVal = noise1D(floor(pos));
      bandHalfWidth *= (0.95 + 0.1 * noiseVal);

      // Distance from center of period
      float d = abs(stripe - 0.5);

      // Soft edges
      float s = clamp(softness, 0.0, 1.0);
      float edgeSoftness = mix(0.005, 0.18, s);
      float innerRadius = max(bandHalfWidth - edgeSoftness, 0.0);

      float stripePattern = smoothstep(bandHalfWidth, innerRadius, d);

      // Temporal pulse
      float pulse = 0.9 + 0.1 * sin(timeAnim * (0.7 * speedAnimScale) + frequency * 1.23);
      stripePattern *= pulse;

      // Gap breakup
      if (gaps > 0.0) {
        float gapNoise = snoise(rotUv * 5.0 + timeAnim * (0.2 * speedAnimScale));
        float normNoise = gapNoise * 0.5 + 0.5;
        float gapMask = smoothstep(gaps, gaps + 0.2, normNoise);
        stripePattern *= gapMask;
      }

      return stripePattern;
    }

    // ── Blend modes ───────────────────────────────────────────────────────────

    float blendMode(float base, float blend, float mode) {
      if (mode < 0.5) {
        return base + blend;                             // Add
      } else if (mode < 1.5) {
        return base * (1.0 + blend);                     // Multiply
      } else if (mode < 2.5) {
        return 1.0 - (1.0 - base) * (1.0 - blend);     // Screen
      } else {
        return base < 0.5                                // Overlay
          ? 2.0 * base * blend
          : 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
      }
    }

    // ── Tone mapping ──────────────────────────────────────────────────────────

    vec3 reinhardJodie(vec3 c) {
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      vec3 tc = c / (c + 1.0);
      return mix(c / (l + 1.0), tc, tc);
    }

    // ── Main ──────────────────────────────────────────────────────────────────

    void main() {
      vec4 albedo = texture2D(uAlbedoMap, vUv);
      vec4 specularMaskSample = texture2D(uSpecularMap, vUv);

      // Discard fully transparent tile texels so specular doesn't bleed
      // through tile holes. With additive blending, black (0,0,0) adds nothing,
      // but discard is cleaner and prevents any alpha artifacts.
      if (albedo.a < 0.01) discard;

      // Early out when effect is disabled — output transparent black.
      if (!uEffectEnabled) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
      }

      // ── Environment lighting ──────────────────────────────────────────────
      float safeDarkness = clamp(uDarknessLevel, 0.0, 1.0);
      float lightLevel = max(1.0 - safeDarkness, 0.25);
      vec3 ambientTint = mix(uAmbientDaylight, uAmbientDarkness, safeDarkness);

      // ── Dynamic lights ────────────────────────────────────────────────────
      vec3 totalDynamicLight = vec3(0.0);
      vec3 dominantDynLightColor = vec3(1.0);
      float dominantDynLightWeight = 0.0;

      for (int i = 0; i < ${maxLights}; i++) {
        if (i >= numLights) break;

        vec3 lPos = lightPosition[i];
        vec3 lColor = lightColor[i];
        float radius = lightConfig[i].x;
        float dim = lightConfig[i].y;
        float attenuation = lightConfig[i].z;

        float dist = distance(vWorldPosition.xy, lPos.xy);

        if (dist < radius) {
          float d = dist / radius;
          float inner = (radius > 0.0) ? clamp(dim / radius, 0.0, 0.99) : 0.0;
          float falloff = 1.0 - smoothstep(inner, 1.0, d);
          float linear = 1.0 - d;
          float squared = 1.0 - d * d;
          float lightIntensity = mix(linear, squared, attenuation) * falloff;

          totalDynamicLight += lColor * lightIntensity;

          // Track brightest contributing light for color tinting.
          float contribution = dot(lColor, vec3(0.2126, 0.7152, 0.0722)) * lightIntensity;
          if (contribution > dominantDynLightWeight) {
            dominantDynLightWeight = contribution;
            float lum = max(dot(lColor, vec3(0.2126, 0.7152, 0.0722)), 0.001);
            dominantDynLightColor = lColor / lum;
          }
        }
      }

      vec3 ambientLight = ambientTint * lightLevel;
      vec3 totalIncidentLight = ambientLight + totalDynamicLight;

      vec4 specularMask = specularMaskSample;
      float roughness = uHasRoughnessMap ? texture2D(uRoughnessMap, vUv).r : uRoughness;

      // ── Outdoor factor ────────────────────────────────────────────────────
      float outdoorFactor = 1.0;
      if (uRoofMaskEnabled > 0.5) {
        float u = (vWorldPosition.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z);
        float v = (vWorldPosition.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w);
        v = 1.0 - v; // Y-flip for roof mask UV convention
        vec2 roofUv = clamp(vec2(u, v), 0.0, 1.0);
        outdoorFactor = texture2D(uRoofMap, roofUv).r;
      }

      // ── Wet surface mask ──────────────────────────────────────────────────
      float wetMask = 0.0;
      if (uWetSpecularEnabled && uRainWetness > 0.001) {
        float gray = dot(albedo.rgb, vec3(0.299, 0.587, 0.114));
        gray = clamp(gray + uWetInputBrightness, 0.0, 1.0);
        gray = pow(gray, max(uWetInputGamma, 0.01));
        float contrasted = clamp((gray - 0.5) * uWetSpecularContrast + 0.5, 0.0, 1.0);
        float bp = min(uWetBlackPoint, uWetWhitePoint - 0.001);
        contrasted = smoothstep(bp, uWetWhitePoint, contrasted);
        wetMask = contrasted * outdoorFactor * uRainWetness;
      }

      // ── Specular mask strength ────────────────────────────────────────────
      float specularStrength = dot(specularMask.rgb, vec3(0.299, 0.587, 0.114)) * specularMask.a;

      // ── Cloud lighting ────────────────────────────────────────────────────
      float cloudLit = 1.0;
      if (uHasCloudShadowMap) {
        vec2 screenUv0 = gl_FragCoord.xy / max(uScreenSize, vec2(1.0));
        cloudLit = texture2D(uCloudShadowMap, screenUv0).r;
      }

      // ── World-space pattern coordinates ───────────────────────────────────
      float worldPatternScalePx = max(1.0, uWorldPatternScale);
      float worldX = (vWorldPosition.x - uSceneBounds.x);
      float worldYTopDown = ((uSceneBounds.y + uSceneBounds.w) - vWorldPosition.y);
      vec2 worldPatternUv = vec2(worldX, worldYTopDown) / worldPatternScalePx;

      // ── Multi-layer stripes ───────────────────────────────────────────────
      float stripeMaskAnimated = 0.0;

      if (uStripeEnabled) {
        float layer1 = 0.0;
        float layer2 = 0.0;
        float layer3 = 0.0;

        if (uStripe1Enabled) {
          layer1 = generateStripeLayer(
            worldPatternUv, vWorldPosition, uCameraPosition, uTime,
            uStripe1Frequency, uStripe1Speed, uStripe1Angle,
            uStripe1Width, uStripe1Parallax, uParallaxStrength,
            uStripe1Wave, uStripe1Gaps, uStripe1Softness
          ) * uStripe1Intensity;
        }

        if (uStripe2Enabled) {
          layer2 = generateStripeLayer(
            worldPatternUv, vWorldPosition, uCameraPosition, uTime,
            uStripe2Frequency, uStripe2Speed, uStripe2Angle,
            uStripe2Width, uStripe2Parallax, uParallaxStrength,
            uStripe2Wave, uStripe2Gaps, uStripe2Softness
          ) * uStripe2Intensity;
        }

        if (uStripe3Enabled) {
          layer3 = generateStripeLayer(
            worldPatternUv, vWorldPosition, uCameraPosition, uTime,
            uStripe3Frequency, uStripe3Speed, uStripe3Angle,
            uStripe3Width, uStripe3Parallax, uParallaxStrength,
            uStripe3Wave, uStripe3Gaps, uStripe3Softness
          ) * uStripe3Intensity;
        }

        stripeMaskAnimated = layer1;
        if (uStripe2Enabled) {
          stripeMaskAnimated = blendMode(stripeMaskAnimated, layer2, uStripeBlendMode);
        }
        if (uStripe3Enabled) {
          stripeMaskAnimated = blendMode(stripeMaskAnimated, layer3, uStripeBlendMode);
        }
      }

      // ── Sparkles ──────────────────────────────────────────────────────────
      float sparkleVal = 0.0;
      if (uSparkleEnabled) {
        sparkleVal = sparkleNoise(worldPatternUv, uSparkleScale, uTime, uSparkleSpeed);
        sparkleVal *= specularStrength;
      }

      // ── Outdoor cloud specular ────────────────────────────────────────────
      float stripeContribution = stripeMaskAnimated;
      float cloudSpecular = 0.0;

      if (uOutdoorCloudSpecularEnabled && uHasCloudShadowMap) {
        cloudSpecular = cloudLit * uCloudSpecularIntensity * outdoorFactor;
        stripeContribution *= mix(1.0, uOutdoorStripeBlend, outdoorFactor);
      }

      // Effects-only modulator (stripes + clouds + sparkles, no base 1.0).
      float effectsOnly = stripeContribution + cloudSpecular + (sparkleVal * uSparkleIntensity);

      // Full modulator for original specular mask (base 1.0 + effects).
      float totalModulator = 1.0 + effectsOnly;

      // Stripe brightness threshold
      if (uStripeEnabled && uStripeMaskThreshold > 0.0) {
        float thresholdMask = smoothstep(uStripeMaskThreshold, 1.0, specularStrength);
        totalModulator *= thresholdMask;
      }

      // ── Dynamic light color tinting ───────────────────────────────────────
      vec3 effectiveLightColor = uLightColor;
      if (uDynamicLightTintEnabled && dominantDynLightWeight > 0.01) {
        effectiveLightColor = mix(uLightColor, dominantDynLightColor, uDynamicLightTintStrength);
      }

      // ── Building shadow suppression ───────────────────────────────────────
      float buildingShadowFactor = 1.0;
      if (uBuildingShadowSuppressionEnabled && uHasBuildingShadowMap) {
        float bu = (vWorldPosition.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z);
        float bv = (vWorldPosition.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w);
        bv = 1.0 - bv;
        vec2 bsUv = clamp(vec2(bu, bv), 0.0, 1.0);
        float shadowVal = texture2D(uBuildingShadowMap, bsUv).r;
        buildingShadowFactor = mix(1.0, shadowVal, uBuildingShadowSuppressionStrength);
      }

      // ── Base specular color ───────────────────────────────────────────────
      vec3 specularColor = specularMask.rgb * specularMask.a
        * totalModulator * uSpecularIntensity
        * effectiveLightColor * totalIncidentLight * buildingShadowFactor;

      // ── Wind ripple (wet surfaces only) ───────────────────────────────────
      float windRipple = 0.0;
      if (uWindDrivenStripesEnabled && uWindStripeInfluence > 0.0
          && uRainWetness > 0.001 && outdoorFactor > 0.01) {
        vec2 windUv = worldPatternUv + uWindAccum * uWindStripeInfluence;
        float ripple1 = snoise(windUv * 8.0) * 0.6;
        float ripple2 = snoise(windUv * 16.0 + 3.7) * 0.4;
        windRipple = max(0.0, ripple1 + ripple2) * outdoorFactor;
      }

      // ── Wet specular ─────────────────────────────────────────────────────
      float wetEffects = effectsOnly + windRipple;
      vec3 wetSpecularColor = vec3(wetMask) * wetEffects * uWetSpecularIntensity
        * effectiveLightColor * totalIncidentLight * buildingShadowFactor;

      // Output CC for wet specular
      if (uWetOutputGamma != 1.0) {
        wetSpecularColor = pow(max(wetSpecularColor, vec3(0.0)), vec3(max(uWetOutputGamma, 0.01)));
      }
      wetSpecularColor = min(wetSpecularColor, vec3(uWetOutputMax));

      // ── Frost / Ice Glaze ─────────────────────────────────────────────────
      vec3 frostSpecularColor = vec3(0.0);
      if (uFrostGlazeEnabled && uFrostLevel > 0.001) {
        vec3 frostTint = mix(vec3(1.0), vec3(0.75, 0.88, 1.0), uFrostTintStrength);
        float frostMask = max(specularStrength, wetMask) * outdoorFactor * uFrostLevel;
        frostSpecularColor = frostTint * frostMask * uFrostIntensity
          * totalIncidentLight * buildingShadowFactor;
      }

      // ── Final composite (specular only — additive blending handles albedo) ─
      vec3 litSpecular = specularColor + wetSpecularColor + frostSpecularColor;
      vec3 outColor = reinhardJodie(litSpecular);

      gl_FragColor = vec4(outColor, 1.0);
    }
  `;
}
