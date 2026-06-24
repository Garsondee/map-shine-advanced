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
 *   - Multi-layer top-down shimmer (anisotropic micro-glint blobs + cellular FBM)
 *   - Micro sparkles
 *   - Wet surface (rain) specular from albedo grayscale
 *   - Frost/ice glaze
 *   - Outdoor cloud specular
 *   - Dynamic light falloff and color tinting
 *   - Building shadow suppression
 *   - Wind-driven ripple on wet surfaces
 *   - Outdoor-only shimmer scroll (manual layer speeds + wind drift along wind direction)
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
    // Build: no uRoughnessMap / uNormalMap / uLightDirection (removed — were unused).

    // ── Texture samplers ──────────────────────────────────────────────────────
    uniform sampler2D uAlbedoMap;      // Tile albedo (needed for wet specular + alpha clip)
    uniform sampler2D uSpecularMap;    // _Specular mask (intensity)
    uniform sampler2D uNoiseTex;       // Tiling noise: R=value, G=voronoi, B=crystalline

    // ── Global toggles ────────────────────────────────────────────────────────
    uniform bool uEffectEnabled;
    uniform float uTileOpacity;

    // ── Strength & tint ───────────────────────────────────────────────────────
    uniform float uSpecularIntensity;
    uniform float uSpecularMaskSaturation;

    // ── Lighting ──────────────────────────────────────────────────────────────
    uniform vec3 uLightColor;
    uniform vec3 uCameraPosition;
    uniform vec2 uCameraOffset;  // Camera pan offset for parallax

    // ── Time ──────────────────────────────────────────────────────────────────
    uniform float uTime;

    // Sun / scene light azimuth (radians) — biases anisotropic grain brightness.
    uniform float uLightAzimuth;

    // ── Multi-layer stripe system ─────────────────────────────────────────────
    uniform bool  uStripeEnabled;
    uniform float uStripeBlendMode;
    uniform float uParallaxStrength;
    uniform float uStripeMaskThreshold;
    uniform float uWorldPatternScale;

    // Per-layer stripe params (precomputed uStripeDir = vec2(cos, sin) in JS)
    uniform float uStripeLayerEnabled[3];
    uniform float uStripeFrequency[3];
    uniform float uStripeSpeed[3];
    uniform vec2  uStripeDir[3];
    uniform float uStripeWidth[3];
    uniform float uStripeIntensity[3];
    uniform float uStripeParallax[3];
    uniform float uStripeWave[3];
    uniform float uStripeGaps[3];
    uniform float uStripeSoftness[3];

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
    uniform float uWetBaseSheen;
    uniform float uWetWindRippleStrength;

    // ── Outdoor/roof mask ─────────────────────────────────────────────────────
    // Legacy single texture (weatherController.roofMap) when uUsePerFloorOutdoors < 0.5.
    uniform sampler2D uRoofMap;
    uniform float uRoofMaskEnabled;
    uniform vec4 uSceneBounds;         // (sceneX, sceneY_world, sceneW, sceneH)
    uniform sampler2D uRoofMap0;
    uniform sampler2D uRoofMap1;
    uniform sampler2D uRoofMap2;
    uniform sampler2D uRoofMap3;
    uniform float uUsePerFloorOutdoors;
    uniform float uOutdoorsMaskFlipY;
    // Per-overlay: floor index 0..3 (merged from per-tile uniforms).
    uniform float uOutdoorsFloorIdx;

    // ── Cloud shadow map ──────────────────────────────────────────────────────
    uniform bool uHasCloudShadowMap;
    uniform sampler2D uCloudShadowMap;
    uniform vec2 uScreenSize;

    // ── Foundry environment ───────────────────────────────────────────────────
    uniform float uDarknessLevel;
    uniform vec3 uAmbientDaylight;
    uniform vec3 uAmbientDarkness;

    // ── Dynamic lights ────────────────────────────────────────────────────────
    uniform int numLights;
    uniform vec3 lightPosition[${maxLights}];
    uniform vec3 lightColor[${maxLights}];
    // Per light: (outerRadiusPx, brightRadiusPx, attenuation, floorMask)
    // floorMask: bitmask — bit i set ⇒ light contributes on FloorStack floor i (0..3).
    // Used when uAmbientLightFloorGate > 0.5 so upper-floor lights do not add XY disk
    // specular on lower-floor overlays. Same pixel space as lightPosition.xy.
    uniform vec4 lightConfig[${maxLights}];

    // PlayerLightEffectV2 torch / flashlight (not AmbientLight docs). Gated by floor
    // vs uOutdoorsFloorIdx when uPlayerLightFloorGate > 0.5 (multi-floor scenes).
    uniform int uPlayerLightCount;
    uniform int uPlayerLightFloorIndex;
    uniform float uPlayerLightFloorGate;
    // Multi-floor: multiply each Foundry AmbientLight disk by the bit for this overlay's floor.
    uniform float uAmbientLightFloorGate;
    uniform vec3 playerLightPosition[2];
    uniform vec3 playerLightColor[2];
    uniform vec4 playerLightConfig[2];

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

    // ── Token mask suppression (screen-space) ───────────────────────────────
    uniform bool uHasTokenMask;
    uniform sampler2D uTokenMask;

    // ── Varyings ──────────────────────────────────────────────────────────────
    varying vec2 vUv;
    varying vec3 vWorldPosition;

    // Drift speed for wind-driven specular stripe UV (full wind vs legacy uWindAccum damping).
    const float kWindStripeScrollMul = 4.0;

    // ── Noise helpers (texture-backed — replaces per-pixel simplex) ───────────

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

    // Seamlessly tiling noise texture samples (R = smooth value, G = voronoi, B = crystalline).
    float sampleNoiseSigned(vec2 uv) {
      return texture2D(uNoiseTex, fract(uv)).r * 2.0 - 1.0;
    }

    float sampleVoronoi01(vec2 uv) {
      return texture2D(uNoiseTex, fract(uv)).g;
    }

    float sampleCrystal01(vec2 uv) {
      return texture2D(uNoiseTex, fract(uv)).b;
    }

    // _Outdoors RTs store full RGBA (GpuSceneMaskCompositor source-over). Authors often use
    // black RGB with alpha for indoor cutouts; sampling .r alone ignores alpha so
    // semi-transparent blacks still read as 0 in R but bilinear / edge bleed can mis-classify.
    // Weight by alpha like TILE_FRAG lighten: max(r,g,b)*a. Cleared RT texels are (0,0,0,0);
    // treat as untouched → default outdoor so scenes without painted mask stay bright.
    float decodeOutdoorsMaskSample(vec4 s) {
      float lum = max(s.r, max(s.g, s.b));
      if (lum < 1e-5 && s.a < 1e-5) return 1.0;
      return clamp(lum * s.a, 0.0, 1.0);
    }

    // Specular authoring often ships grayscale RGB without meaningful alpha.
    // If alpha is missing/zero but luminance exists, treat it as opaque instead
    // of collapsing highlights to zero.
    float decodeSpecularMaskStrength(vec4 s) {
      float lum = clamp(dot(s.rgb, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
      float a = clamp(s.a, 0.0, 1.0);
      if (a < 1e-4) return lum;
      return lum * a;
    }

    // Blend neutral (grayscale strength) with _Specular mask RGB. 0 = white highlights,
    // 1 = full mask colour, >1 boosts chroma while preserving decoded strength luma.
    vec3 applySpecularMaskColor(vec3 maskRgb, float strength, float saturation) {
      float sat = clamp(saturation, 0.0, 2.0);
      vec3 neutral = vec3(strength);
      float maskLum = max(dot(maskRgb, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
      vec3 colored = maskRgb * (strength / maskLum);
      vec3 result = mix(neutral, colored, min(sat, 1.0));
      if (sat > 1.0) {
        float baseLum = dot(result, vec3(0.2126, 0.7152, 0.0722));
        vec3 chroma = result - vec3(baseLum);
        result = max(vec3(baseLum) + chroma * sat, vec3(0.0));
        float outLum = dot(result, vec3(0.2126, 0.7152, 0.0722));
        if (outLum > 1e-5) result *= (baseLum / outLum);
      }
      return result;
    }

    // ── Top-down shimmer helpers ──────────────────────────────────────────────

    // Brushed-metal / wood-grain bias: brightest when light is perpendicular to grain.
    float anisotropicLightBias(vec2 grainDir, float lightAzimuth) {
      vec2 lightDir = vec2(cos(lightAzimuth), sin(lightAzimuth));
      vec2 grainPerp = vec2(-grainDir.y, grainDir.x);
      return mix(0.35, 1.0, abs(dot(lightDir, grainPerp)));
    }

    // Tiled Gaussian clusters stretched along a grain axis (top-down anisotropic glints).
    float anisotropicBlob(vec2 uv, vec2 grainDir, float scale, float elongation, float spread, float wave) {
      vec2 perp = vec2(-grainDir.y, grainDir.x);
      float along = dot(uv, grainDir) * scale;
      float across = dot(uv, perp) * scale / max(elongation, 0.18);
      vec2 cell = floor(vec2(along, across));
      vec2 offset = fract(vec2(along, across)) - 0.5;

      float cellHash = hash12(cell + vec2(17.3, 91.7));
      float rotAngle = (cellHash - 0.5) * wave * 1.4;
      float cr = cos(rotAngle);
      float sr = sin(rotAngle);
      vec2 localOff = vec2(offset.x * cr - offset.y * sr, offset.x * sr + offset.y * cr);

      vec2 seed = vec2(
        hash12(cell + vec2(127.1, 311.7)),
        hash12(cell + vec2(269.5, 183.3))
      );
      localOff -= (seed - 0.5) * 0.6;

      float spreadMul = mix(18.0, 5.0, clamp(spread, 0.0, 1.0));
      vec2 stretch = vec2(1.0, max(elongation, 0.18));
      return exp(-dot(localOff * stretch, localOff * stretch) * spreadMul);
    }

    // Multi-octave voronoi × value noise — irregular highlight islands, no band seams.
    float cellularShimmerFBM(vec2 uv, float cellScale, float time) {
      float sum = 0.0;
      float amp = 0.55;
      float freq = max(cellScale, 0.5);
      for (int o = 0; o < 3; o++) {
        vec2 oUv = uv * freq + vec2(time * 0.013, time * 0.009);
        float vor = sampleVoronoi01(oUv);
        float val = sampleNoiseSigned(oUv * 0.7) * 0.5 + 0.5;
        sum += vor * val * amp;
        amp *= 0.5;
        freq *= 1.9;
      }
      return smoothstep(0.28, 0.72, sum);
    }

    // Worley F2−F1 — soft caustic rings without hard voronoi cell walls.
    vec2 worleyDistances(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float F1 = 8.0;
      float F2 = 8.0;
      for (int yy = -1; yy <= 1; yy++) {
        for (int xx = -1; xx <= 1; xx++) {
          vec2 g = vec2(float(xx), float(yy));
          vec2 lattice = i + g;
          vec2 rnd = vec2(hash12(lattice), hash12(lattice + 53.7));
          vec2 diff = g + rnd - f;
          float d = dot(diff, diff);
          if (d < F1) {
            F2 = F1;
            F1 = d;
          } else if (d < F2) {
            F2 = d;
          }
        }
      }
      return vec2(sqrt(F1), sqrt(F2));
    }

    float worleyCaustic(vec2 uv) {
      vec2 d = worleyDistances(uv);
      return max(0.0, d.y - d.x);
    }

    // ── Shimmer layer generator (replaces fract-based stripe bands) ───────────

    float generateShimmerLayer(
      vec2 uv,
      vec3 worldPos,
      vec3 cameraPos,
      float time,
      float frequency,
      float speed,
      vec2 grainDir,
      float width,
      float parallaxDepth,
      float parallaxStrength,
      float wave,
      float gaps,
      float softness,
      float outdoorWeight,
      float lightAzimuth
    ) {
      float ow = clamp(outdoorWeight, 0.0, 1.0);
      float timeAnim = (abs(speed) > 0.000001) ? time * ow : 0.0;
      float speedAnimScale = clamp(abs(speed) / 0.01, 0.0, 10.0) * ow;

      vec2 patternUv = uv;
      if (parallaxDepth != 0.0) {
        vec2 offset = uCameraOffset * parallaxDepth * parallaxStrength * 0.0006;
        patternUv -= offset;
      }

      if (wave > 0.0) {
        float waveNoise = sampleNoiseSigned(patternUv * 2.0 + timeAnim * (0.1 * speedAnimScale));
        patternUv += waveNoise * wave * 0.04;
      }

      // Scroll along grain (suppressed outdoors — wind handles drift there).
      float scrollAlong = timeAnim * speed * (1.0 - ow);
      vec2 scrollUv = patternUv + grainDir * scrollAlong * 0.08;

      float elongation = mix(0.25, 4.0, clamp(softness / 5.0, 0.0, 1.0));
      float spread = clamp(gaps, 0.0, 1.0);
      float scale = max(frequency, 0.25);

      float blob = anisotropicBlob(scrollUv, grainDir, scale, elongation, spread, wave);

      // Width thins or fattens glint clusters.
      float w = clamp(width, 0.0, 1.0);
      float widthGate = smoothstep(mix(0.55, 0.08, w), mix(0.95, 0.45, w), blob);

      float lightBias = anisotropicLightBias(grainDir, lightAzimuth);
      float pulse = 0.88 + 0.12 * sin(timeAnim * (0.7 * speedAnimScale) + frequency * 1.23);

      return widthGate * lightBias * pulse;
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

    // NOTE: No tone mapping here. Additive overlay shaders must output raw
    // linear light values so they add correctly onto the linear scene RT.
    // Applying tone mapping before additive blending compresses HDR values
    // to [0,1], causing saturation to white/grey at high intensities instead
    // of bright light. The final blit to screen handles the sRGB encode.

    // Extract one bit (floor index 0..3) from ambient-light floor visibility mask.
    float specularAmbientFloorMaskBit(float mask, float floorIdx) {
      float fi = clamp(floorIdx, 0.0, 3.0);
      float div = pow(2.0, fi);
      return mod(floor(mask / div + 1e-4), 2.0);
    }

    // Analytic disk contribution (Foundry + player specular lights share this falloff).
    vec3 msSpecularDiskContrib(vec3 lPos, vec3 lColor, float radius, float brightRadius, float attenuation) {
      vec2 diff = vWorldPosition.xy - lPos.xy;
      float distSq = dot(diff, diff);
      float radiusSq = radius * radius;
      if (distSq < radiusSq) {
        float dist = sqrt(distSq);
        float d = dist / max(radius, 1e-5);
        float inner = (radius > 0.0) ? clamp(brightRadius / radius, 0.0, 0.99) : 0.0;
        float falloff = 1.0 - smoothstep(inner, 1.0, d);
        float linear = 1.0 - d;
        float squared = 1.0 - d * d;
        float lightIntensity = mix(linear, squared, attenuation) * falloff;
        return lColor * lightIntensity;
      }
      return vec3(0.0);
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
        float brightRadius = lightConfig[i].y;
        float attenuation = lightConfig[i].z;

        vec2 diff = vWorldPosition.xy - lPos.xy;
        float distSq = dot(diff, diff);
        float radiusSq = radius * radius;

        if (distSq < radiusSq) {
          float dist = sqrt(distSq);
          float d = dist / max(radius, 1e-5);
          // Inner edge of falloff = bright core as a fraction of outer radius (Foundry bright/dim).
          float inner = (radius > 0.0) ? clamp(brightRadius / radius, 0.0, 0.99) : 0.0;
          float falloff = 1.0 - smoothstep(inner, 1.0, d);
          float linear = 1.0 - d;
          float squared = 1.0 - d * d;
          float lightIntensity = mix(linear, squared, attenuation) * falloff;

          float floorMul = 1.0;
          if (uAmbientLightFloorGate > 0.5) {
            float m = lightConfig[i].w;
            floorMul = specularAmbientFloorMaskBit(m, uOutdoorsFloorIdx);
          }

          vec3 addL = lColor * lightIntensity * floorMul;
          totalDynamicLight += addL;

          // Track brightest contributing light for color tinting.
          float contribution = dot(addL, vec3(0.2126, 0.7152, 0.0722));
          if (contribution > dominantDynLightWeight) {
            dominantDynLightWeight = contribution;
            float lum = max(dot(lColor, vec3(0.2126, 0.7152, 0.0722)), 0.001);
            dominantDynLightColor = lColor / lum;
          }
        }
      }

      // Player torch / flashlight: same falloff, but only on this overlay's floor band
      // when uPlayerLightFloorGate is on (matches SpecularEffectV2 floor vs token elevation).
      float playerFloorGate = 1.0;
      if (uPlayerLightFloorGate > 0.5 && uPlayerLightFloorIndex >= 0 && uPlayerLightCount > 0) {
        int overlayFi = int(uOutdoorsFloorIdx + 0.5);
        playerFloorGate = (overlayFi == uPlayerLightFloorIndex) ? 1.0 : 0.0;
      }
      for (int j = 0; j < 2; j++) {
        if (j >= uPlayerLightCount) break;
        vec3 pPos = playerLightPosition[j];
        vec3 pCol = playerLightColor[j];
        float pr = playerLightConfig[j].x;
        float pbr = playerLightConfig[j].y;
        float patt = playerLightConfig[j].z;
        vec3 addP = msSpecularDiskContrib(pPos, pCol, pr, pbr, patt) * playerFloorGate;
        totalDynamicLight += addP;
        float pcontrib = dot(addP, vec3(0.2126, 0.7152, 0.0722));
        if (pcontrib > dominantDynLightWeight) {
          dominantDynLightWeight = pcontrib;
          float plum = max(dot(pCol, vec3(0.2126, 0.7152, 0.0722)), 0.001);
          dominantDynLightColor = pCol / plum;
        }
      }

      vec3 ambientLight = ambientTint * lightLevel;
      vec3 totalIncidentLight = ambientLight + totalDynamicLight;

      vec4 specularMask = specularMaskSample;

      // ── Outdoor factor ────────────────────────────────────────────────────
      float outdoorFactor = 1.0;
      if (uRoofMaskEnabled > 0.5) {
        float ru = (vWorldPosition.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z);
        float rv = (vWorldPosition.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w);
        rv = 1.0 - rv; // Foundry scene-UV style (matches uSceneBounds / building shadow)
        vec2 roofUvBase = clamp(vec2(ru, rv), 0.0, 1.0);
        vec2 roofUv = vec2(roofUvBase.x, (uOutdoorsMaskFlipY > 0.5) ? (1.0 - roofUvBase.y) : roofUvBase.y);
        if (uUsePerFloorOutdoors > 0.5) {
          float fi = uOutdoorsFloorIdx;
          if (fi < 0.5) outdoorFactor = decodeOutdoorsMaskSample(texture2D(uRoofMap0, roofUv));
          else if (fi < 1.5) outdoorFactor = decodeOutdoorsMaskSample(texture2D(uRoofMap1, roofUv));
          else if (fi < 2.5) outdoorFactor = decodeOutdoorsMaskSample(texture2D(uRoofMap2, roofUv));
          else outdoorFactor = decodeOutdoorsMaskSample(texture2D(uRoofMap3, roofUv));
        } else {
          outdoorFactor = decodeOutdoorsMaskSample(texture2D(uRoofMap, roofUv));
        }
      }

      // ── Wet surface mask ──────────────────────────────────────────────────
      float wetMask = 0.0;
      if (uWetSpecularEnabled && uRainWetness > 0.001) {
        // Target bright, fairly neutral highlights — not every mid-tone or saturated color.
        float lum = dot(albedo.rgb, vec3(0.299, 0.587, 0.114));
        float whiteness = min(albedo.r, min(albedo.g, albedo.b));
        float gray = lum * smoothstep(0.08, 0.32, whiteness);
        gray = clamp(gray + uWetInputBrightness, 0.0, 1.0);
        gray = pow(gray, max(uWetInputGamma, 0.01));
        float contrasted = clamp((gray - 0.5) * uWetSpecularContrast + 0.5, 0.0, 1.0);
        float bp = min(uWetBlackPoint, uWetWhitePoint - 0.001);
        contrasted = smoothstep(bp, uWetWhitePoint, contrasted);
        wetMask = contrasted * outdoorFactor * uRainWetness;
      }

      // ── Specular mask strength ────────────────────────────────────────────
      float specularStrength = decodeSpecularMaskStrength(specularMask);

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

      // Wind pushes stripe UVs by accumulated (direction × speed). Map uWindAccum into
      // worldPatternUv space so band drift matches on-screen wind (empirically: flip both axes
      // from raw accum so motion is not opposite to weather windDirection).
      vec2 stripePatternUv = worldPatternUv;
      if (uWindDrivenStripesEnabled && uWindStripeInfluence > 0.00001) {
        vec2 windAccumPattern = vec2(-uWindAccum.x, uWindAccum.y);
        stripePatternUv += windAccumPattern * uWindStripeInfluence * outdoorFactor * kWindStripeScrollMul;
      }

      // ── Multi-layer shimmer (anisotropic blobs + cellular FBM) ────────────
      float stripeMaskAnimated = 0.0;

      if (uStripeEnabled) {
        float layer1 = 0.0;
        float layer2 = 0.0;
        float layer3 = 0.0;

        // Brighter mask → finer, denser micro-facet cells (wet albedo mask counts too).
        float maskCellScale = mix(2.5, 13.0, max(specularStrength, wetMask));
        float shimmerBase = cellularShimmerFBM(
          stripePatternUv,
          maskCellScale,
          uTime * outdoorFactor
        );

        if (uStripeLayerEnabled[0] > 0.5) {
          layer1 = generateShimmerLayer(
            stripePatternUv, vWorldPosition, uCameraPosition, uTime,
            uStripeFrequency[0], uStripeSpeed[0], uStripeDir[0],
            uStripeWidth[0], uStripeParallax[0], uParallaxStrength,
            uStripeWave[0], uStripeGaps[0], uStripeSoftness[0],
            outdoorFactor, uLightAzimuth
          ) * uStripeIntensity[0];
        }

        if (uStripeLayerEnabled[1] > 0.5) {
          layer2 = generateShimmerLayer(
            stripePatternUv, vWorldPosition, uCameraPosition, uTime,
            uStripeFrequency[1], uStripeSpeed[1], uStripeDir[1],
            uStripeWidth[1], uStripeParallax[1], uParallaxStrength,
            uStripeWave[1], uStripeGaps[1], uStripeSoftness[1],
            outdoorFactor, uLightAzimuth
          ) * uStripeIntensity[1];
        }

        if (uStripeLayerEnabled[2] > 0.5) {
          layer3 = generateShimmerLayer(
            stripePatternUv, vWorldPosition, uCameraPosition, uTime,
            uStripeFrequency[2], uStripeSpeed[2], uStripeDir[2],
            uStripeWidth[2], uStripeParallax[2], uParallaxStrength,
            uStripeWave[2], uStripeGaps[2], uStripeSoftness[2],
            outdoorFactor, uLightAzimuth
          ) * uStripeIntensity[2];
        }

        stripeMaskAnimated = layer1;
        if (uStripeLayerEnabled[1] > 0.5) {
          stripeMaskAnimated = blendMode(stripeMaskAnimated, layer2, uStripeBlendMode);
        }
        if (uStripeLayerEnabled[2] > 0.5) {
          stripeMaskAnimated = blendMode(stripeMaskAnimated, layer3, uStripeBlendMode);
        }

        // Blend blob layers with mask-scaled cellular shimmer (no parallel band seams).
        stripeMaskAnimated = stripeMaskAnimated * (0.55 + shimmerBase * 0.45) + shimmerBase * 0.22;
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
      vec3 specularMaskColor = applySpecularMaskColor(
        specularMask.rgb, specularStrength, uSpecularMaskSaturation
      );
      vec3 specularColor = specularMaskColor
        * totalModulator * uSpecularIntensity
        * effectiveLightColor * totalIncidentLight * buildingShadowFactor;

      // ── Wind ripple (wet surfaces only) — Worley F2−F1 caustic pools ───────
      float windRipple = 0.0;
      if (uWindDrivenStripesEnabled && uWindStripeInfluence > 0.0
          && uRainWetness > 0.001 && outdoorFactor > 0.01) {
        vec2 windUv = worldPatternUv + uWindAccum * uWindStripeInfluence;
        float t = uTime * 0.04;
        vec2 adv = windUv * 6.0 + vec2(t * 0.5, -t * 0.35);
        float caustic = worleyCaustic(adv);
        windRipple = pow(caustic, 0.65) * 2.8 * outdoorFactor;
      }

      // ── Wet specular ─────────────────────────────────────────────────────
      // wetMask gates WHERE shimmer appears; stripeMaskAnimated supplies parallax shimmer.
      // Full-strength stripes (outdoorStripeBlend only dampens the _Specular mask pass).
      float wetShimmer = stripeMaskAnimated;
      wetShimmer += windRipple * max(0.0, uWetWindRippleStrength);
      wetShimmer += max(0.0, uWetBaseSheen) * outdoorFactor;
      wetShimmer += sparkleVal * uSparkleIntensity;
      if (uOutdoorCloudSpecularEnabled && uHasCloudShadowMap) {
        wetShimmer += cloudLit * uCloudSpecularIntensity * outdoorFactor;
      }
      vec3 wetSpecularColor = vec3(wetMask) * wetShimmer * uWetSpecularIntensity
        * effectiveLightColor * totalIncidentLight * buildingShadowFactor;

      // Output CC for wet specular — scale peak to cap (preserves stripe contrast vs hard clamp).
      if (uWetOutputGamma != 1.0) {
        wetSpecularColor = pow(max(wetSpecularColor, vec3(0.0)), vec3(max(uWetOutputGamma, 0.01)));
      }
      float wetPeak = max(max(wetSpecularColor.r, wetSpecularColor.g), wetSpecularColor.b);
      if (wetPeak > uWetOutputMax && uWetOutputMax > 0.0) {
        wetSpecularColor *= (uWetOutputMax / wetPeak);
      }

      // ── Frost / Ice Glaze ─────────────────────────────────────────────────
      vec3 frostSpecularColor = vec3(0.0);
      if (uFrostGlazeEnabled && uFrostLevel > 0.001) {
        vec3 frostTint = mix(vec3(1.0), vec3(0.75, 0.88, 1.0), uFrostTintStrength);
        float frostMask = max(specularStrength, wetMask) * outdoorFactor * uFrostLevel;
        float frostCrystal = sampleCrystal01(worldPatternUv * 24.0);
        frostCrystal = mix(0.55, 1.0, frostCrystal);
        frostSpecularColor = frostTint * frostMask * frostCrystal * uFrostIntensity
          * totalIncidentLight * buildingShadowFactor;
      }

      // ── Final composite (specular only — additive blending handles albedo) ─
      vec3 litSpecular = specularColor + wetSpecularColor + frostSpecularColor;
      litSpecular *= clamp(uTileOpacity, 0.0, 1.0);

      // Suppress specular where token silhouettes are present so floor overlays
      // don't brighten over token bodies.
      if (uHasTokenMask) {
        vec2 tokenUv = gl_FragCoord.xy / max(uScreenSize, vec2(1.0));
        float tokenMask01 = smoothstep(0.1, 0.9, texture2D(uTokenMask, tokenUv).a);
        litSpecular *= (1.0 - tokenMask01);
      }

      // Output raw linear light — no tone mapping on additive overlays.
      gl_FragColor = vec4(litSpecular, clamp(uTileOpacity, 0.0, 1.0));
    }
  `;
}
