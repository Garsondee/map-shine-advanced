export const FoundryDarknessShaderChunks = {
  magicalGloom: `
            vec3 colorScale(in float t) {
              return vec3(1.0 + 0.8 * t) * t;
            }

            vec2 radialProjection(in vec2 uv, in float s, in float i) {
              uv = vec2(0.5) - uv;
              float px = 1.0 - fract(atan(uv.y, uv.x) / TWOPI + 0.25) + s;
              float py = (length(uv) * (1.0 + i * 2.0) - i) * 2.0;
              return vec2(px, py);
            }

            float interference(in vec2 n) {
              float noise1 = noise(n);
              float noise2 = noise(n * 2.1) * 0.6;
              float noise3 = noise(n * 5.4) * 0.42;
              return noise1 + noise2 + noise3;
            }

            float illuminate(in vec2 uv) {
              float t = uTime;

              float xOffset = (uv.y < 0.5)
                              ? 23.0 + t * 0.035
                              : -11.0 + t * 0.03;
              uv.x += xOffset;

              uv.y = abs(uv.y - 0.5);
              uv.x *= (10.0 + 80.0 * uAnimIntensity * 0.2);

              float q = interference(uv - t * 0.013) * 0.5;
              vec2 r2 = vec2(interference(uv + q * 0.5 + t - uv.x - uv.y),
                             interference(uv + q - t));

              float sh = (r2.y + r2.y) * max(0.0, uv.y) + 0.1;
              return sh * sh * sh;
            }

            vec3 voidHalf(in float intensity) {
              intensity = pow(intensity, 0.75);
              vec3 c = colorScale(intensity);
              c /= (1.0 + max(vec3(0.0), c));
              return c;
            }

            vec3 voidRing(in vec2 uvs) {
              vec2 uv = (uvs - 0.5) / (uBorderDistance * 1.06) + 0.5;
              float rr = 3.6;
              float ff = 1.0 - uv.y;
              vec2 uv2 = uv;
              uv2.y = 1.0 - uv2.y;

              vec3 colorUpper = voidHalf(illuminate(radialProjection(uv, 1.0, rr))) * ff;
              vec3 colorLower = voidHalf(illuminate(radialProjection(uv2, 1.9, rr))) * (1.0 - ff);
              return colorUpper + colorLower;
            }

            vec3 voidRingColor = voidRing(vUvs);
            float lum = pow(perceivedBrightness(voidRingColor), 4.0);
            float lumBase = 1.0;
            lumBase = mix(lumBase, lumBase * 0.33, uGlobalDarknessLevel);
            mask = clamp(mask + (lum * lumBase * uAlpha), 0.0, 1.0);
  `,

  roiling: `
            float distortion1 = fbm(vec2(
                              fbm(vUvs * 2.5 + uTime * 0.5),
                              fbm((-vUvs - vec2(0.01)) * 5.0 + uTime * INVTHREE)));

            float distortion2 = fbm(vec2(
                              fbm(-vUvs * 5.0 + uTime * 0.5),
                              fbm((vUvs + vec2(0.01)) * 2.5 + uTime * INVTHREE)));

            float t = -uTime * 0.5;
            float cost = cos(t);
            float sint = sin(t);
            mat2 rotmat = mat2(cost, -sint, sint, cost);

            vec2 uv = vUvs;
            uv -= vec2(0.5);
            uv *= rotmat;
            uv += vec2(0.5);

            vec2 dstpivot = vec2(sin(min(distortion1 * 0.1, distortion2 * 0.1)),
                                cos(min(distortion1 * 0.1, distortion2 * 0.1))) * INVTHREE
                        - vec2(cos(max(distortion1 * 0.1, distortion2 * 0.1)),
                              sin(max(distortion1 * 0.1, distortion2 * 0.1))) * INVTHREE;

            vec2 apivot = PIVOT - dstpivot;
            uv -= apivot;
            uv *= 1.13 + 1.33 * (cos(sqrt(max(distortion1, distortion2)) + 1.0) * 0.5);
            uv += apivot;

            float ddist = clamp(distance(uv, PIVOT) * 2.0, 0.0, 1.0);
            float smoothv = smoothstep(uBorderDistance, uBorderDistance * 1.2, ddist);
            float inSmooth = min(smoothv, 1.0 - smoothv) * 2.0;

            float membrane = 1.0 - inSmooth;
            float core = 1.0 - smoothstep(0.25, 0.30 + (uAnimIntensity * 0.2), ddist);
            float value = clamp(core * membrane, 0.0, 1.0);
            mask = clamp(mask + (value * uAlpha), 0.0, 1.0);
  `,

  hole: `
            vec3 beamsEmanation(in vec2 uv, in float distIn, in vec3 pCol) {
              float angle = atan(uv.x, uv.y) * INVTWOPI;
              float dad = mix(0.33, 5.0, distIn);
              float beams = fract(angle + sin(distIn * 30.0 * (uAnimIntensity * 0.2) - uTime + fbm(uv * 10.0 + uTime * 0.25, 1.0) * dad));
              beams = max(beams, 1.0 - beams);
              return smoothstep(0.0, 1.1 + (uAnimIntensity * 0.1), beams * pCol);
            }

            vec2 uvs = (2.0 * vUvs) - 1.0;
            float rd = pow(1.0 - dist, 3.0);
            vec3 col = vec3(1.0);
            vec3 b = beamsEmanation(uvs, rd, col);
            float v = clamp(perceivedBrightness(b), 0.0, 1.0);
            mask = clamp(mask + (v * uAlpha), 0.0, 1.0);
  `,

  denseSmoke: `
            float i = (uAnimIntensity * 0.2);
            vec2 uv = vUvs * 2.5;

            float fn1 = i * 0.33 + 0.67 * fbm(vec3(uv, uTime * 0.25), 1.70);
            float fn2 = i * 0.33 + 0.67 * fbm(vec3(uv + 0.5, uTime * 0.25), 1.40);
            float fn3 = i * 0.33 + 0.67 * fbm(vec3(uv - 0.5, uTime * 0.25), 1.65);

            float m1 = fbm(vec3(uv - 1.301, uTime * 0.16), 1.66);
            float m2 = fbm(vec3(uv + 1.187, uTime * 0.21), 1.54);

            float tt = mix(fn1, fn2, m1);
            tt = mix(tt, fn3, m2);
            tt = mix(tt, fn1, 0.5);
            tt = mix(tt, fn2, 0.5);
            tt = mix(tt, fn3, 0.5);

            float bda = 1.0 - smoothstep(uBorderDistance, 1.0, dist);
            float value = clamp(tt * bda, 0.0, 1.0);
            mask = clamp(mask + (value * uAlpha), 0.0, 1.0);
  `
};
