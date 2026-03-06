/**
 * @fileoverview Shader sources for LensEffectV2.
 *
 * Execution order (intentional):
 *   1. Estimate scene luma from sparse 9-sample grid
 *   2. Add overlay (screen-space, undistorted UV — sits on the lens glass)
 *   3. Sample scene at distorted UV with chromatic aberration
 *   4. Vignette
 *   5. Grain
 */

export function getVertexShader() {
  return /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;
}

export function getFragmentShader() {
  return /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform float uTime;
    uniform float uSceneLumaOverride;
    uniform float uUseSceneLumaOverride;
    uniform float uAutoFocusAmount;
    uniform float uAutoFocusBlurPx;
    uniform vec2  uAutoFocusShiftPx;
    uniform sampler2D tLightBurnMap;
    uniform float uLightBurnEnabled;
    uniform float uLightBurnIntensity;
    uniform float uLightBurnBlurPx;

    // ── Distortion ─────────────────────────────────────────────────────────────
    uniform float uDistortionAmount;
    uniform vec2  uDistortionCenter;

    // ── Chromatic aberration ────────────────────────────────────────────────────
    uniform float uChromaticAmountPx;
    uniform float uChromaticEdgePower;

    // ── Vignette ────────────────────────────────────────────────────────────────
    uniform float uVignetteIntensity;
    uniform float uVignetteSoftness;

    // ── Grain ───────────────────────────────────────────────────────────────────
    uniform float uGrainAmount;
    uniform float uGrainSpeed;
    uniform float uAdaptiveGrainEnabled;
    uniform float uGrainLowLightBoost;
    uniform float uGrainCellSizeBright;
    uniform float uGrainCellSizeDark;
    uniform float uDigitalNoiseEnabled;
    uniform float uDigitalNoiseAmount;
    uniform float uDigitalNoiseChance;
    uniform float uDigitalNoiseGreenBias;
    uniform float uDigitalNoiseLowLightBoost;

    // ── Layered overlay slots (A..D) ───────────────────────────────────────────
    uniform sampler2D uOverlayTex0;
    uniform sampler2D uOverlayTex1;
    uniform sampler2D uOverlayTex2;
    uniform sampler2D uOverlayTex3;
    uniform sampler2D uOverlayPrevTex0;
    uniform sampler2D uOverlayPrevTex1;
    uniform sampler2D uOverlayPrevTex2;
    uniform sampler2D uOverlayPrevTex3;
    uniform float     uOverlayActive0;
    uniform float     uOverlayActive1;
    uniform float     uOverlayActive2;
    uniform float     uOverlayActive3;
    uniform float     uOverlayPrevActive0;
    uniform float     uOverlayPrevActive1;
    uniform float     uOverlayPrevActive2;
    uniform float     uOverlayPrevActive3;
    uniform float     uOverlayBlend0;
    uniform float     uOverlayBlend1;
    uniform float     uOverlayBlend2;
    uniform float     uOverlayBlend3;
    uniform vec4      uOverlayScaleOffset0; // xy=scale, zw=offset
    uniform vec4      uOverlayScaleOffset1;
    uniform vec4      uOverlayScaleOffset2;
    uniform vec4      uOverlayScaleOffset3;
    uniform vec4      uOverlayParams0;      // x=intensity, y=lumaReactivity, z=lumaBoost, w=clearRadius
    uniform vec4      uOverlayParams1;
    uniform vec4      uOverlayParams2;
    uniform vec4      uOverlayParams3;
    uniform vec4      uOverlayAnim0;        // x=clearSoftness, y=driftX, z=driftY, w=pulseMag
    uniform vec4      uOverlayAnim1;
    uniform vec4      uOverlayAnim2;
    uniform vec4      uOverlayAnim3;
    uniform vec2      uOverlayPulse0;       // x=pulseFreq, y=pulsePhase
    uniform vec2      uOverlayPulse1;
    uniform vec2      uOverlayPulse2;
    uniform vec2      uOverlayPulse3;
    uniform vec4      uOverlayLumaGate0;    // x=minLuma, y=maxLuma, z=softness, w=influence
    uniform vec4      uOverlayLumaGate1;
    uniform vec4      uOverlayLumaGate2;
    uniform vec4      uOverlayLumaGate3;

    varying vec2 vUv;

    const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);

    // ── Helpers ─────────────────────────────────────────────────────────────────

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Cheap 9-sample sparse-grid scene brightness estimate — zero CPU overhead.
    float estimateSceneLuma() {
      float s = 0.0;
      s += dot(texture2D(tDiffuse, vec2(0.2, 0.2)).rgb, LUM);
      s += dot(texture2D(tDiffuse, vec2(0.5, 0.2)).rgb, LUM);
      s += dot(texture2D(tDiffuse, vec2(0.8, 0.2)).rgb, LUM);
      s += dot(texture2D(tDiffuse, vec2(0.2, 0.5)).rgb, LUM);
      s += dot(texture2D(tDiffuse, vec2(0.5, 0.5)).rgb, LUM);
      s += dot(texture2D(tDiffuse, vec2(0.8, 0.5)).rgb, LUM);
      s += dot(texture2D(tDiffuse, vec2(0.2, 0.8)).rgb, LUM);
      s += dot(texture2D(tDiffuse, vec2(0.5, 0.8)).rgb, LUM);
      s += dot(texture2D(tDiffuse, vec2(0.8, 0.8)).rgb, LUM);
      return s / 9.0;
    }

    // Simple barrel/pincushion warp.
    vec2 radialDistort(vec2 uv, vec2 center, float k) {
      vec2 p = uv - center;
      return center + p * (1.0 + k * dot(p, p));
    }

    vec3 sampleSceneWithCA(vec2 uv, vec2 texelSize) {
      vec2 clampedUv = clamp(uv, vec2(0.0), vec2(1.0));
      vec2 toCenter = clampedUv - uDistortionCenter;
      float edgeR   = length(toCenter);
      vec2 caDir    = (edgeR > 1e-5) ? (toCenter / edgeR) : vec2(0.0);
      float caEdge  = pow(clamp(edgeR * 1.9, 0.0, 1.0), max(0.01, uChromaticEdgePower));
      vec2 caDelta  = caDir * uChromaticAmountPx * caEdge * texelSize;

      vec3 c;
      c.r = texture2D(tDiffuse, clamp(clampedUv + caDelta, vec2(0.0), vec2(1.0))).r;
      c.g = texture2D(tDiffuse, clampedUv).g;
      c.b = texture2D(tDiffuse, clamp(clampedUv - caDelta, vec2(0.0), vec2(1.0))).b;
      return c;
    }

    vec3 sampleOverlay(
      sampler2D tex,
      float activeFlag,
      vec4 scaleOffset,
      vec4 params,
      vec4 anim,
      vec2 pulse,
      vec4 lumaGate,
      float sceneLuma
    ) {
      if (activeFlag < 0.5 || params.x <= 0.0001) return vec3(0.0);

      vec2 uvFit = vUv * scaleOffset.xy + scaleOffset.zw;
      uvFit += vec2(anim.y, anim.z) * uTime;
      vec3 texColor = texture2D(tex, uvFit).rgb;

      float intensity      = params.x;
      float lumaReactivity = params.y;
      float lumaBoost      = params.z;
      float clearRadius    = params.w;

      float clearSoftness  = anim.x;
      float pulseMag       = anim.w;
      float pulseFreq      = pulse.x;
      float pulsePhase     = pulse.y;
      float gateMinLuma    = lumaGate.x;
      float gateMaxLuma    = max(gateMinLuma, lumaGate.y);
      float gateSoftness   = max(0.001, lumaGate.z);
      float gateInfluence  = clamp(lumaGate.w, 0.0, 1.0);

      float reactivity = mix(1.0, sceneLuma * lumaBoost, lumaReactivity);
      float pulseVal = 1.0 + sin(uTime * pulseFreq * 6.2832 + pulsePhase) * pulseMag;

      float gateIn  = smoothstep(gateMinLuma - gateSoftness, gateMinLuma + gateSoftness, sceneLuma);
      float gateOut = 1.0 - smoothstep(gateMaxLuma - gateSoftness, gateMaxLuma + gateSoftness, sceneLuma);
      float lumaWindow = clamp(gateIn * gateOut, 0.0, 1.0);
      float lumaWindowApplied = mix(1.0, lumaWindow, gateInfluence);

      float dist = length(vUv - vec2(0.5));
      float clearMask = smoothstep(
        clearRadius - clearSoftness,
        clearRadius + clearSoftness,
        dist
      );
      float appliedClear = (clearRadius < 0.001) ? 1.0 : clearMask;

      return texColor * intensity * reactivity * pulseVal * appliedClear * lumaWindowApplied;
    }

    vec3 sampleOverlayCrossfade(
      sampler2D prevTex,
      sampler2D currTex,
      float prevActive,
      float currActive,
      float blend,
      vec4 scaleOffset,
      vec4 params,
      vec4 anim,
      vec2 pulse,
      vec4 lumaGate,
      float sceneLuma
    ) {
      vec3 prevSample = sampleOverlay(prevTex, prevActive, scaleOffset, params, anim, pulse, lumaGate, sceneLuma);
      vec3 currSample = sampleOverlay(currTex, currActive, scaleOffset, params, anim, pulse, lumaGate, sceneLuma);
      return mix(prevSample, currSample, clamp(blend, 0.0, 1.0));
    }

    // ── Main ────────────────────────────────────────────────────────────────────

    void main() {
      // 1. Scene luma (shared, computed once)
      float estimatedSceneLuma = estimateSceneLuma();
      float sceneLuma = mix(estimatedSceneLuma, clamp(uSceneLumaOverride, 0.0, 1.0), clamp(uUseSceneLumaOverride, 0.0, 1.0));

      // 2. Overlays — sampled at undistorted screen UV so they stay locked to
      //    the lens glass while the scene beneath gets warped.
      vec3 overlayAdd = vec3(0.0);
      overlayAdd += sampleOverlayCrossfade(uOverlayPrevTex0, uOverlayTex0, uOverlayPrevActive0, uOverlayActive0, uOverlayBlend0, uOverlayScaleOffset0, uOverlayParams0, uOverlayAnim0, uOverlayPulse0, uOverlayLumaGate0, sceneLuma);
      overlayAdd += sampleOverlayCrossfade(uOverlayPrevTex1, uOverlayTex1, uOverlayPrevActive1, uOverlayActive1, uOverlayBlend1, uOverlayScaleOffset1, uOverlayParams1, uOverlayAnim1, uOverlayPulse1, uOverlayLumaGate1, sceneLuma);
      overlayAdd += sampleOverlayCrossfade(uOverlayPrevTex2, uOverlayTex2, uOverlayPrevActive2, uOverlayActive2, uOverlayBlend2, uOverlayScaleOffset2, uOverlayParams2, uOverlayAnim2, uOverlayPulse2, uOverlayLumaGate2, sceneLuma);
      overlayAdd += sampleOverlayCrossfade(uOverlayPrevTex3, uOverlayTex3, uOverlayPrevActive3, uOverlayActive3, uOverlayBlend3, uOverlayScaleOffset3, uOverlayParams3, uOverlayAnim3, uOverlayPulse3, uOverlayLumaGate3, sceneLuma);

      // 3. Distort scene UV and sample with chromatic aberration
      vec2 texelSize = vec2(1.0) / max(uResolution, vec2(1.0));
      vec2 distUV = radialDistort(vUv, uDistortionCenter, uDistortionAmount);
      vec2 focusShiftUv = uAutoFocusShiftPx * texelSize * clamp(uAutoFocusAmount, 0.0, 1.0);
      vec2 focusUV = clamp(distUV + focusShiftUv, vec2(0.0), vec2(1.0));
      vec3 sceneColor = sampleSceneWithCA(focusUV, texelSize);

      // Optional autofocus pulse blur (infrequent lens shift / refocus moment).
      if (uAutoFocusAmount > 0.0001 && uAutoFocusBlurPx > 0.0001) {
        float blurPx = uAutoFocusBlurPx * clamp(uAutoFocusAmount, 0.0, 1.0);
        vec2 blurStep = texelSize * blurPx;
        vec3 blurAccum = vec3(0.0);
        blurAccum += sampleSceneWithCA(focusUV + vec2( blurStep.x, 0.0), texelSize) * 0.20;
        blurAccum += sampleSceneWithCA(focusUV + vec2(-blurStep.x, 0.0), texelSize) * 0.20;
        blurAccum += sampleSceneWithCA(focusUV + vec2(0.0,  blurStep.y), texelSize) * 0.20;
        blurAccum += sampleSceneWithCA(focusUV + vec2(0.0, -blurStep.y), texelSize) * 0.20;
        blurAccum += sampleSceneWithCA(focusUV + vec2( blurStep.x,  blurStep.y), texelSize) * 0.10;
        blurAccum += sampleSceneWithCA(focusUV + vec2(-blurStep.x, -blurStep.y), texelSize) * 0.10;
        sceneColor = mix(sceneColor, blurAccum, clamp(uAutoFocusAmount, 0.0, 1.0));
      }

      // 4. Add overlay on top of distorted scene
      sceneColor += overlayAdd;

      // Optional light burning persistence (bright residual bloom/afterimage).
      if (uLightBurnEnabled > 0.5 && uLightBurnIntensity > 0.0001) {
        vec3 burnColor = texture2D(tLightBurnMap, vUv).rgb;
        if (uLightBurnBlurPx > 0.0001) {
          vec2 burnStep = texelSize * uLightBurnBlurPx;
          vec3 blurBurn = vec3(0.0);
          blurBurn += texture2D(tLightBurnMap, clamp(vUv + vec2( burnStep.x, 0.0), vec2(0.0), vec2(1.0))).rgb * 0.25;
          blurBurn += texture2D(tLightBurnMap, clamp(vUv + vec2(-burnStep.x, 0.0), vec2(0.0), vec2(1.0))).rgb * 0.25;
          blurBurn += texture2D(tLightBurnMap, clamp(vUv + vec2(0.0,  burnStep.y), vec2(0.0), vec2(1.0))).rgb * 0.25;
          blurBurn += texture2D(tLightBurnMap, clamp(vUv + vec2(0.0, -burnStep.y), vec2(0.0), vec2(1.0))).rgb * 0.25;
          burnColor = mix(burnColor, blurBurn, 0.75);
        }
        sceneColor += burnColor * uLightBurnIntensity;
      }

      // 5. Vignette (screen-space, unaffected by distortion)
      float vDist = length(vUv - vec2(0.5));
      float vig   = smoothstep(max(0.01, uVignetteSoftness), 0.95, vDist);
      sceneColor  *= mix(1.0, 1.0 - uVignetteIntensity, vig);

      // 6. Grain (efficient cell-based hash noise)
      if (uGrainAmount > 0.0001) {
        float lowLight = clamp(1.0 - sceneLuma, 0.0, 1.0);
        float adaptiveMix = (uAdaptiveGrainEnabled > 0.5) ? lowLight : 0.0;
        float grainBoost = 1.0 + adaptiveMix * max(0.0, uGrainLowLightBoost);
        float cellPx = mix(max(1.0, uGrainCellSizeBright), max(1.0, uGrainCellSizeDark), adaptiveMix);

        vec2 pixelCoord = floor((vUv * uResolution) / cellPx);
        float t = floor(uTime * max(0.0, uGrainSpeed) * 24.0);
        float n = hash12(pixelCoord + vec2(t, t * 1.618033));
        sceneColor += (n - 0.5) * 2.0 * uGrainAmount * grainBoost;

        // Optional digital chroma noise (sensor-ish speckle), stronger in low light.
        if (uDigitalNoiseEnabled > 0.5 && uDigitalNoiseAmount > 0.0001) {
          float chance = clamp(uDigitalNoiseChance * (1.0 + lowLight * max(0.0, uDigitalNoiseLowLightBoost)), 0.0, 1.0);
          float glitchGate = step(1.0 - chance, hash12(pixelCoord + vec2(t * 0.37, 11.17)));
          if (glitchGate > 0.5) {
            float signMix = mix(-1.0, 1.0, hash12(pixelCoord + vec2(7.1, t * 0.13)));
            vec3 chroma = vec3(
              mix(0.25, 1.0, hash12(pixelCoord + vec2(13.7, 1.1))),
              mix(0.35, 1.0, hash12(pixelCoord + vec2(3.2, 9.4))),
              mix(0.25, 1.0, hash12(pixelCoord + vec2(8.8, 5.6)))
            );
            float greenBias = clamp(uDigitalNoiseGreenBias, 0.0, 1.0);
            chroma.g = mix(chroma.g, max(chroma.r, chroma.b) * 1.2 + 0.2, greenBias);
            chroma = normalize(max(chroma, vec3(0.0001)));
            float glitchAmp = uDigitalNoiseAmount * (0.35 + lowLight * 0.65);
            sceneColor += chroma * signMix * glitchAmp;
          }
        }
      }

      gl_FragColor = vec4(sceneColor, 1.0);
    }
  `;
}
