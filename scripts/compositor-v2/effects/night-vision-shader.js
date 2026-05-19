/**
 * @fileoverview Shader sources for Night Vision post-pass (PlayerLightEffectV2).
 *
 * Order: distort UV → chromatic sample → HDR luma gain (stops) → Purkinje/saturation → tint → bloom burn add →
 *        scanlines → scintillation noise → phosphor flicker → eyepiece vignette → master power.
 *
 * Light amplification meters linear HDR (`tHdrLinear`, post-bloom pre-grade) when available
 * and applies the scale to the display-referred sample (`tDiffuse`, post tone map).
 */

export function getNightVisionVertexShader() {
  return /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;
}

export function getNightVisionFragmentShader() {
  return /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tHdrLinear;
    uniform sampler2D tBloomBurnMap;
    uniform vec2  uResolution;
    uniform float uTime;

    uniform vec3  uTint;
    uniform float uTintStrength;
    uniform float uSaturation;
    uniform float uBrightness;

    // Purkinje rod/cone crossover: pre-gain photometric luma drives desaturation so
    // heavily amplified shadows read monochrome while mesopic/bright areas keep color.
    uniform float uPurkinjeStrength;
    uniform float uPurkinjeDarkStart;
    uniform float uPurkinjeBrightEnd;
    uniform float uPurkinjeCurve;

    uniform float uUseHdrLinear;
    uniform float uGainStops;
    uniform float uShadowCurve;
    uniform float uMaxLuma;
    uniform float uDarkLift;

    uniform float uDistortionAmount;
    uniform vec2  uDistortionCenter;
    uniform float uCAAmountPx;
    uniform float uCAEdgePower;

    uniform float uScanlinesEnabled;
    uniform float uScanIntensity;
    uniform float uScanDensity;
    uniform float uScanSpeed;
    uniform float uScanThickness;

    uniform float uNoiseAmount;
    uniform float uNoiseLowLightBoost;
    uniform float uNoiseSpeed;
    uniform float uNoiseScale;

    uniform float uPhosphorFlickerAmount;
    uniform float uPhosphorFlickerSpeed;
    uniform float uPhosphorSize;
    uniform float uPhosphorDensity;
    uniform float uPhosphorIntensity;

    uniform float uBloomEnabled;
    uniform float uBloomIntensity;
    uniform float uBloomBlurPx;

    uniform float uEyepieceStyle;
    uniform float uEyepieceRadius;
    uniform float uEyepieceSoftness;
    uniform float uEyepieceIntensity;
    uniform vec3  uEyepieceColor;

    uniform float uEyepieceSeparation;

    uniform float uPower;

    varying vec2 vUv;

    const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);

    vec3 sampleHdrLinear(vec2 uv) {
      if (uUseHdrLinear < 0.5) return vec3(0.0);
      return texture2D(tHdrLinear, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
    }

    // Stops-based tube gain: meters HDR photometric luma, applies scale to display RGB.
    vec3 amplifyNightVision(vec3 displayCol, vec3 hdrCol) {
      float Y = max(dot(hdrCol, LUM), 1e-5);
      float Yd = max(dot(displayCol, LUM), 1e-5);

      float stops = uGainStops;
      float curve = max(0.05, uShadowCurve);
      float shadowW = pow(clamp(1.0 - Y / max(uMaxLuma * 0.35, 0.02), 0.0, 1.0), curve);
      float effectiveStops = stops * (0.25 + 0.75 * shadowW);

      float lifted = max(Y + max(0.0, uDarkLift), 1e-5);
      float logY = log2(lifted);
      float maxLog = log2(max(uMaxLuma, 1e-3));
      float targetLog = clamp(logY + effectiveStops, -12.0, maxLog);
      float targetY = exp2(targetLog);
      float knee = max(uMaxLuma, 1e-3);
      targetY = targetY / (1.0 + max(targetY - knee, 0.0) / knee);

      float scale = clamp(targetY / Yd, 0.0, 64.0);
      return displayCol * scale;
    }

    // Mesopic crossover keyed on pre-gain scene luma (not post-amplification brightness).
    float purkinjeSaturation(vec3 amplifiedCol, vec3 preGainCol, float baseSat) {
      float sat = clamp(baseSat, 0.0, 2.0);
      if (uPurkinjeStrength <= 1e-5) return sat;

      float preY = max(dot(preGainCol, LUM), 1e-6);
      float darkStart = max(1e-5, uPurkinjeDarkStart);
      float brightEnd = max(darkStart + 1e-5, uPurkinjeBrightEnd);
      float curve = max(0.15, uPurkinjeCurve);

      // Cone retention rises with ambient photometric level before tube gain.
      float coneMix = smoothstep(darkStart, brightEnd, preY);
      coneMix = pow(coneMix, curve);

      // Extra rod bias when amplification ratio is high (deep shadow lift).
      float postY = max(dot(amplifiedCol, LUM), 1e-6);
      float ampRatio = clamp(postY / preY, 1.0, 64.0);
      float ampDesat = clamp(log2(ampRatio) / 4.0, 0.0, 1.0);
      float colorRetention = coneMix * (1.0 - ampDesat * 0.85);

      float purkinjeSat = sat * colorRetention;
      return mix(sat, purkinjeSat, clamp(uPurkinjeStrength, 0.0, 1.0));
    }

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    vec2 radialDistort(vec2 uv, vec2 center, float k) {
      vec2 p = uv - center;
      return center + p * (1.0 + k * dot(p, p));
    }

    vec3 sampleSceneWithCA(vec2 uv, vec2 texelSize) {
      vec2 clampedUv = clamp(uv, vec2(0.0), vec2(1.0));
      vec2 toCenter = clampedUv - uDistortionCenter;
      float edgeR = length(toCenter);
      vec2 caDir = (edgeR > 1e-5) ? (toCenter / edgeR) : vec2(0.0);
      float caEdge = pow(clamp(edgeR * 1.9, 0.0, 1.0), max(0.01, uCAEdgePower));
      vec2 caDelta = caDir * uCAAmountPx * caEdge * texelSize;

      vec3 c;
      c.r = texture2D(tDiffuse, clamp(clampedUv + caDelta, vec2(0.0), vec2(1.0))).r;
      c.g = texture2D(tDiffuse, clampedUv).g;
      c.b = texture2D(tDiffuse, clamp(clampedUv - caDelta, vec2(0.0), vec2(1.0))).b;
      return c;
    }

    vec3 sampleBloom(vec2 uv, vec2 texelSize) {
      if (uBloomEnabled < 0.5 || uBloomIntensity <= 1e-5) return vec3(0.0);
      float blurPx = max(0.0, uBloomBlurPx);
      if (blurPx <= 0.0001) {
        return texture2D(tBloomBurnMap, clamp(uv, vec2(0.0), vec2(1.0))).rgb * uBloomIntensity;
      }
      vec2 s = texelSize * blurPx;
      vec3 acc = vec3(0.0);
      acc += texture2D(tBloomBurnMap, clamp(uv + vec2( s.x, 0.0), vec2(0.0), vec2(1.0))).rgb * 0.25;
      acc += texture2D(tBloomBurnMap, clamp(uv + vec2(-s.x, 0.0), vec2(0.0), vec2(1.0))).rgb * 0.25;
      acc += texture2D(tBloomBurnMap, clamp(uv + vec2(0.0,  s.y), vec2(0.0), vec2(1.0))).rgb * 0.25;
      acc += texture2D(tBloomBurnMap, clamp(uv + vec2(0.0, -s.y), vec2(0.0), vec2(1.0))).rgb * 0.25;
      return acc * uBloomIntensity;
    }

    float eyepieceMask(vec2 uv) {
      vec2 c = vec2(0.5);
      float rad = max(0.01, uEyepieceRadius);
      float soft = max(0.001, uEyepieceSoftness);
      float sep = clamp(uEyepieceSeparation, 0.0, 0.48);

      if (uEyepieceStyle > 0.5) {
        vec2 leftC = vec2(0.5 - sep, 0.5);
        vec2 rightC = vec2(0.5 + sep, 0.5);
        float dL = length(uv - leftC);
        float dR = length(uv - rightC);
        float mL = smoothstep(rad + soft, rad - soft, dL);
        float mR = smoothstep(rad + soft, rad - soft, dR);
        return max(mL, mR);
      }

      float d = length(uv - c);
      return smoothstep(rad + soft, rad - soft, d);
    }

    void main() {
      vec2 texelSize = vec2(1.0) / max(uResolution, vec2(1.0));

      vec2 distUv = radialDistort(vUv, uDistortionCenter, uDistortionAmount);
      distUv = clamp(distUv, vec2(0.0), vec2(1.0));

      vec3 col = sampleSceneWithCA(distUv, texelSize);
      vec3 hdrCol = (uUseHdrLinear > 0.5) ? sampleHdrLinear(distUv) : col;
      vec3 preGainMeter = hdrCol;
      col = amplifyNightVision(col, hdrCol);

      float sat = purkinjeSaturation(col, preGainMeter, uSaturation);
      float gray = dot(col, LUM);
      col = mix(vec3(gray), col, sat);

      vec3 tint = clamp(uTint, vec3(0.0), vec3(4.0));
      float ts = clamp(uTintStrength, 0.0, 1.0);
      col = mix(col, col * tint, ts);

      col *= max(0.0, uBrightness);

      vec3 bloom = sampleBloom(vUv, texelSize);
      col += bloom;

      if (uScanlinesEnabled > 0.5 && uScanIntensity > 1e-5) {
        float phase = vUv.y * uScanDensity + uTime * uScanSpeed;
        float wave = sin(phase);
        float thick = max(0.01, uScanThickness);
        float line = pow(max(0.0, abs(wave)), mix(4.0, 1.0, thick));
        float scanMul = 1.0 - uScanIntensity * line * 0.85;
        col *= clamp(scanMul, 0.15, 1.0);
      }

      float Y2 = dot(col, LUM);
      vec2 nUv = vUv * uNoiseScale + vec2(uTime * uNoiseSpeed * 0.03, uTime * uNoiseSpeed * 0.07);
      float n = hash12(floor(nUv * vec2(800.0, 600.0)) + fract(uTime * 17.0));
      float n2 = hash12(floor(nUv * vec2(400.0, 300.0)) + fract(uTime * 31.0));
      float flick = (n + n2 - 1.0);
      float darkBoost = mix(1.0, 1.0 + uNoiseLowLightBoost, 1.0 - clamp(Y2 * 2.0, 0.0, 1.0));
      col += vec3(flick) * uNoiseAmount * 0.35 * darkBoost;

      float pf = sin(uTime * uPhosphorFlickerSpeed * 6.2832) * 0.5 + 0.5;
      float flickerMul = 1.0 - uPhosphorFlickerAmount * (0.35 + 0.65 * pf);
      col *= flickerMul;

      // Add a subtle phosphor scintillation layer that remains visible on
      // brighter surfaces instead of only reading against black regions.
      float phosphorLuma = clamp(dot(col, LUM), 0.0, max(uMaxLuma, 1.0));
      float phosphorPresence = smoothstep(0.05, 0.9, phosphorLuma);
      float phosphorSize = max(0.05, uPhosphorSize);
      float phosphorDensity = max(0.01, uPhosphorDensity);
      float phosphorHash = hash12(floor(vUv * uResolution * phosphorSize) + fract(uTime * (11.0 + uPhosphorFlickerSpeed * 37.0)));
      float phosphorGate = smoothstep(0.0, min(1.0, phosphorDensity), phosphorHash);
      float phosphorSpark = (phosphorHash * 2.0 - 1.0) * phosphorGate;
      float phosphorAmp = uPhosphorFlickerAmount * max(0.0, uPhosphorIntensity) * (0.02 + 0.06 * phosphorPresence);
      col += vec3(phosphorSpark) * phosphorAmp;

      float eyeOpen = eyepieceMask(vUv);
      float ei = clamp(uEyepieceIntensity, 0.0, 1.0);
      vec3 edgeCol = clamp(uEyepieceColor, vec3(0.0), vec3(1.0));
      col = mix(edgeCol, col, mix(1.0, eyeOpen, ei));

      // Power should fade between original scene and NV look.
      // Multiplying the final color by power forces the entire frame to black
      // at low/zero power (e.g. bright scenes with darkness gating).
      float pwr = clamp(uPower, 0.0, 1.0);
      vec3 baseCol = texture2D(tDiffuse, clamp(vUv, vec2(0.0), vec2(1.0))).rgb;
      col = mix(baseCol, col, pwr);

      gl_FragColor = vec4(col, 1.0);
    }
  `;
}
