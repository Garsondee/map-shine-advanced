export const FoundryLightingShaderChunks = {
  wave: `
            // Foundry VTT: lighting/effects/wave.mjs
            // Combines coloration + illumination behaviors.
            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float sinWave = 0.5 * (sin(-uTime * 6.0 + r * 10.0 * inten) + 1.0);
            float waveIllum = 0.3 * sinWave + 0.8;
            float waveColor = 0.55 * sinWave + 0.8;
            animAlphaMul *= waveIllum;
            outColor *= waveColor;
  `,

  fairy: `
            // Foundry VTT: lighting/effects/fairy-light.mjs
            const float INVTWOPI = 0.15915494309189535;
            const float INVTHREE = 0.3333333333333333;
            const vec2 PIVOT = vec2(0.5, 0.5);

            float time = uTime;
            float intensityIn = uAnimIntensity;

            float distortion1 = fbm(vec2(
                              fbm(vUvs * 3.0 + time * 0.50),
                              fbm((-vUvs + vec2(1.0)) * 5.0 + time * INVTHREE)));

            float distortion2 = fbm(vec2(
                              fbm(-vUvs * 3.0 + time * 0.50),
                              fbm((-vUvs + vec2(1.0)) * 5.0 - time * INVTHREE)));

            vec2 uv = vUvs;

            float t = time * 0.5;
            float tcos = 0.5 * (0.5 * (cos(t) + 1.0)) + 0.25;
            float tsin = 0.5 * (0.5 * (sin(t) + 1.0)) + 0.25;

            uv -= PIVOT;
            uv *= tcos * distortion1;
            uv *= tsin * distortion2;
            uv *= fbm(vec2(time + distortion1, time + distortion2));
            uv += PIVOT;

            float intens = intensityIn * 0.1;
            vec2 nuv = vUvs * 2.0 - 1.0;
            vec2 puv = vec2(atan(nuv.x, nuv.y) * INVTWOPI + 0.5, length(nuv));
            vec3 rainbow = hsb2rgb(vec3(puv.x + puv.y - time * 0.2, 1.0, 1.0));
            // Keep fairy lights strongly chromatic (minimal white illumination washout).
            float rainbowMix = mix(0.9, 1.0, smoothstep(0.0, 1.5 - intens, dist));
            vec3 baseColor = max(uColor, vec3(0.001));
            vec3 mixedColor = mix(baseColor, rainbow, rainbowMix);

            outColor = distortion1 * distortion1 *
                       distortion2 * distortion2 *
                       mixedColor * (1.0 - dist * dist * dist) *
                       mix( uv.x + distortion1 * 4.5 * (intensityIn * 0.4),
                            uv.y + distortion2 * 4.5 * (intensityIn * 0.4), tcos);

            float motionWave = 0.5 * (0.5 * (cos(time * 0.5) + 1.0)) + 0.25;
            animAlphaMul = mix(distortion1, distortion2, motionWave);
  `

  ,
  chroma: `
            // Foundry VTT: lighting/effects/chroma.mjs
            // ChromaColorationShader.forceDefaultColor = true
            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            vec3 chromaCol = hsb2rgb(vec3(uTime * 0.25, 1.0, 1.0));
            outColor = mix(vec3(1.0), chromaCol, inten * 0.1);
  `

  ,
  energyField: `
            // Foundry VTT: lighting/effects/energy-field.mjs
            // EnergyFieldColorationShader.forceDefaultColor = true
            vec2 uv = vUvs;
            float inten = clamp(uAnimIntensity, 0.001, 10.0);

            // Hemispherize and scaling the uv
            float d0 = max(dist, 0.0001);
            float f = (1.0 - sqrt(1.0 - d0)) / d0;
            uv -= vec2(0.5);
            uv *= f * 4.0 * inten;
            uv += vec2(0.5);

            // time and uv motion variables
            float t = uTime * 0.4;
            float uvx = cos(uv.x - t);
            float uvy = cos(uv.y + t);
            float uvxt = cos(uv.x + sin(t));
            float uvyt = sin(uv.y + cos(t));

            // creating the voronoi 3D sphere, applying motion
            vec3 c = voronoi3d(vec3(uv.x - uvx + uvyt,
                                   mix(uv.x, uv.y, 0.5) + uvxt - uvyt + uvx,
                                   uv.y + uvxt - uvx));

            // applying color and contrast, to create sharp black areas.
            outColor = c.x * c.x * c.x * vec3(1.0);
  `

  ,
  bewitchingWave: `
            // Foundry VTT: lighting/effects/bewitching-wave.mjs
            // Combines coloration + illumination behaviors.

            float t = uTime * 0.25;
            mat2 rotmat = mat2(cos(t), -sin(t), sin(t), cos(t));
            mat2 scalemat = mat2(2.5, 0.0, 0.0, 2.5);

            vec2 uv = vUvs;
            uv -= vec2(0.5);
            uv *= rotmat * scalemat;
            uv += vec2(0.5);

            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float motion = fbm4(uv + uTime * 0.25);
            float distortion = mix(1.0, motion, clamp(1.0 - dist, 0.0, 1.0));
            float sinWave = 0.5 * (sin(-uTime * 6.0 + dist * 10.0 * inten * distortion) + 1.0);
            float bwIllum = 0.3 * sinWave + 0.8;
            float bwColor = 0.55 * sinWave + 0.8;
            animAlphaMul *= bwIllum;
            outColor *= bwColor;
  `

  ,
  revolving: `
            // Foundry VTT: lighting/effects/revolving-light.mjs
            // RevolvingColorationShader.forceDefaultColor = true
            const float PI = 3.141592653589793;
            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;

            float gradientFade = 0.15;
            float beamLength = 1.0;
            float angle = uSeed * 6.283185307179586;

            vec2 ncoord = vUvs * 2.0 - 1.0;
            float angularIntensity = mix(PI, PI * 0.5, inten * 0.1);
            ncoord *= rot(angle + time);
            float angularCorrection = pie(ncoord, angularIntensity, gradientFade, beamLength);

            outColor = vec3(1.0);
            animAlphaMul *= angularCorrection;
  `

  ,
  siren: `
            // Foundry VTT: lighting/effects/siren-light.mjs
            const float PI = 3.141592653589793;
            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;

            float gradientFade = 0.15;
            float beamLength = 1.0;
            float angle = uSeed * 6.283185307179586;

            vec2 ncoord = vUvs * 2.0 - 1.0;
            float angularIntensity = mix(PI, 0.0, inten * 0.1);
            ncoord *= rot(time * 50.0 + angle);
            float angularCorrection = pie(ncoord, angularIntensity, clamp(gradientFade * dist, 0.05, 1.0), beamLength);

            outColor *= angularCorrection;
            animAlphaMul *= mix(1.0, angularCorrection, 0.5);
  `

  ,
  fog: `
            // Foundry VTT: lighting/effects/fog.mjs
            // FogColorationShader.forceDefaultColor = true
            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;
            vec3 color = vec3(1.0);

            // constructing the palette
            vec3 c1 = color * 0.60;
            vec3 c2 = color * 0.95;
            vec3 c3 = color * 0.50;
            vec3 c4 = color * 0.75;
            vec3 c5 = vec3(0.3);
            vec3 c6 = color;

            // creating the deformation
            vec2 uv = vUvs;
            vec2 p = uv.xy * 8.0;

            // time motion fbm and palette mixing
            float q = fbm4(p - time * 0.1);
            vec2 rr = vec2(fbm4(p + q - time * 0.5 - p.x - p.y),
                          fbm4(p + q - time * 0.3));
            vec3 c = clamp(mix(c1,
                              c2,
                              fbm4(p + rr)) + mix(c3, c4, rr.x)
                                          - mix(c5, c6, rr.y),
                               vec3(0.0), vec3(1.0));

            float intens = inten * 0.2;
            outColor = c * intens;
  `

  ,
  sunburst: `
            // Foundry VTT: lighting/effects/sunburst.mjs
            const float INVTWOPI = 0.15915494309189535;

            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;

            // Smooth back and forth between a and b
            float intensityMod = 1.0 + (inten * 0.05);
            float lpulse = (1.1 * intensityMod - 0.85 * intensityMod) * ((cos(time) + 1.0) * 0.5) + 0.85 * intensityMod;

            vec2 uv = (2.0 * vUvs) - 1.0;
            float ang = atan(uv.x, uv.y) * INVTWOPI;
            float beam = fract(ang * 16.0 + time);
            float light = lpulse * pow(abs(1.0 - dist), 0.65);
            float sb = max(light, max(beam, 1.0 - beam));
            float sbPow = pow(sb, 3.0);
            outColor *= sbPow;
            animAlphaMul *= sbPow;
  `

  ,
  lightDome: `
            // Foundry VTT: lighting/effects/light-dome.mjs
            // LightDomeColorationShader.forceDefaultColor = true
            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;
            vec3 color = vec3(1.0);
            const vec2 PIVOT = vec2(0.5, 0.5);

            float d0 = max(dist, 0.0001);
            float hspherize = (1.0 - sqrt(1.0 - d0)) / d0;
            float tt = time * 0.02;
            mat2 rotmat = mat2(cos(tt), -sin(tt), sin(tt), cos(tt));
            mat2 scalemat = mat2(8.0 * inten, 0.0, 0.0, 8.0 * inten);

            vec2 uv = vUvs;
            uv -= PIVOT;
            uv *= rotmat * scalemat * hspherize;
            uv += PIVOT;

            // ripples palette
            vec3 c1 = color * 0.550;
            vec3 c2 = color * 0.020;
            vec3 c3 = color * 0.3;
            vec3 c4 = color;
            vec3 c5 = color * 0.025;
            vec3 c6 = color * 0.200;

            vec2 p = (uv + vec2(5.0));
            float q = 2.0 * fbm2(p + time * 0.2);
            vec2 rr = vec2(fbm2(p + q + (time) - p.x - p.y), fbm2(p * 2.0 + (time)));
            vec3 rip = clamp(mix(c1, c2, abs(fbm2(p + rr))) + mix(c3, c4, abs(rr.x * rr.x * rr.x)) - mix(c5, c6, abs(rr.y * rr.y)),
                             vec3(0.0), vec3(1.0));

            outColor = rip * pow(1.0 - dist, 0.25);
  `

  ,
  emanation: `
            // Foundry VTT: lighting/effects/emanation.mjs
            // EmanationColorationShader.forceDefaultColor = true
            const float INVTWOPI = 0.15915494309189535;

            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;
            vec3 color = vec3(1.0);

            vec2 uv = (2.0 * vUvs) - 1.0;
            float ang = atan(uv.x, uv.y) * INVTWOPI;
            float beams = fract(ang * inten + sin(dist * 10.0 - time));
            beams = max(beams, 1.0 - beams);

            outColor = smoothstep(vec3(0.0), vec3(1.0), beams * color);
  `

  ,
  hexaDome: `
            // Foundry VTT: lighting/effects/hexa-dome.mjs
            // HexaDomeColorationShader.forceDefaultColor = true
            const vec2 PIVOT = vec2(0.5, 0.5);

            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;
            vec3 color = vec3(1.0);

            float d0 = max(dist, 0.0001);
            float hspherize = (1.0 - sqrt(1.0 - d0)) / d0;
            float t = -time * 0.20;
            float scale = 10.0 / (11.0 - inten);
            float cost = cos(t);
            float sint = sin(t);
            mat2 rotmat = mat2(cost, -sint, sint, cost);
            mat2 scalemat = mat2(scale, 0.0, 0.0, scale);

            vec2 uv = vUvs;
            uv -= PIVOT;
            uv *= rotmat * scalemat * hspherize;
            uv += PIVOT;

            float tt2 = time;
            vec2 uv1 = uv + vec2(0.0, sin(uv.y) * 0.25);
            vec2 uv2 = 0.5 * uv1 + 0.5 * uv + vec2(0.55, 0.0);
            float cRot = 0.5;
            float sRot = -1.0;
            uv2 *= mat2(cRot, -sRot, sRot, cRot);

            vec2 rHex = vec2(1.0, 1.73);
            vec2 hHex = rHex * 0.5;
            vec2 uvHex = uv2 * 10.0;
            vec2 aHex = mod(uvHex, rHex) - hHex;
            vec2 bHex = mod(uvHex - hHex, rHex) - hHex;
            vec2 gv = dot(aHex, aHex) < dot(bHex, bHex) ? aHex : bHex;
            vec2 pAbs = abs(gv);
            float cHex = dot(pAbs, normalize(vec2(1.0, 1.73)));
            cHex = max(cHex, pAbs.x);
            float hexy = 0.55 - cHex;

            float hexa = smoothstep(3.0 * (cos(tt2)) + 4.5, 12.0, hexy * 20.0) * 3.0;

            vec3 col = color;
            col *= mix(hexa, 1.0 - hexa, min(hexy, 1.0 - hexy));
            col += color * fract(smoothstep(1.0, 2.0, hexy * 20.0)) * 0.65;

            outColor = col * pow(1.0 - dist, 0.18);
  `

  ,
  ghostLight: `
            // Foundry VTT: lighting/effects/ghost-light.mjs
            const float INVTHREE = 0.3333333333333333;
            const vec2 PIVOT = vec2(0.5, 0.5);

            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;

            float distortion1 = fbm(vec2(
                              fbm(vUvs * 3.0 + time * 0.50),
                              fbm((-vUvs + vec2(1.0)) * 5.0 + time * INVTHREE)));

            float distortion2 = fbm(vec2(
                              fbm(-vUvs * 3.0 + time * 0.50),
                              fbm((-vUvs + vec2(1.0)) * 5.0 - time * INVTHREE)));
            vec2 uv = vUvs;

            float t = time * 0.5;
            float tcos = 0.5 * (0.5 * (cos(t) + 1.0)) + 0.25;
            float tsin = 0.5 * (0.5 * (sin(t) + 1.0)) + 0.25;

            uv -= PIVOT;
            uv *= tcos * distortion1;
            uv *= tsin * distortion2;
            uv *= fbm(vec2(time + distortion1, time + distortion2));
            uv += PIVOT;

            outColor = distortion1 * distortion1 *
                       distortion2 * distortion2 *
                       outColor * pow(1.0 - dist, dist) *
                       mix(uv.x + distortion1 * 4.5 * (inten * 0.2),
                           uv.y + distortion2 * 4.5 * (inten * 0.2), tcos);

            float illum = mix(distortion1 * 1.5 * (inten * 0.2),
                              distortion2 * 1.5 * (inten * 0.2), tcos);
            animAlphaMul *= illum;
  `

  ,
  vortex: `
            // Foundry VTT: lighting/effects/vortex.mjs
            // VortexColorationShader.forceDefaultColor = true
            const float TWOPI = 6.283185307179586;
            const vec2 PIVOT = vec2(0.5, 0.5);

            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;

            float intens = inten * 0.2;
            float t = time * 0.5;
            float cost = cos(t);
            float sint = sin(t);
            mat2 vortexRotMat = mat2(cost, -sint, sint, cost);
            mat2 spiceRotMat = mat2(cost * 2.0, -sint * 2.0, sint * 2.0, cost * 2.0);

            vec2 uvs = vUvs - PIVOT;
            vec2 uvRot = (vUvs - PIVOT) * vortexRotMat;
            if (dist < 1.0) {
              float sigma = (1.0 - dist);
              float theta = sigma * sigma * TWOPI * intens;
              float st = sin(theta);
              float ct = cos(theta);
              uvs = vec2(dot(uvs, vec2(ct, -st)), dot(uvs, vec2(st, ct)));
            }
            uvs += PIVOT;

            vec2 suv = uvs;
            suv -= PIVOT;
            suv *= spiceRotMat;
            vec2 p = suv.xy * 6.0;
            suv += PIVOT;

            vec3 c1 = vec3(1.0) * 0.55;
            vec3 c2 = vec3(1.0) * 0.95;
            vec3 c3 = vec3(1.0) * 0.45;
            vec3 c4 = vec3(1.0) * 0.75;
            vec3 c5 = vec3(0.20);
            vec3 c6 = vec3(1.0) * 1.2;

            float q = fbm4(p + time);
            vec2 rr = vec2(fbm4(p + q + time * 0.9 - p.x - p.y),
                          fbm4(p + q + time * 0.6));
            vec3 col = mix(c1, c2, fbm4(p + rr)) + mix(c3, c4, rr.x) - mix(c5, c6, rr.y);

            outColor = col;
  `

  ,
  swirlingRainbow: `
            // Foundry VTT: lighting/effects/swirling-rainbow.mjs
            // SwirlingRainbowColorationShader.forceDefaultColor = true
            const float INVTWOPI = 0.15915494309189535;

            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;

            float intens = inten * 0.1;
            vec2 nuv = vUvs * 2.0 - 1.0;
            vec2 puv = vec2(atan(nuv.x, nuv.y) * INVTWOPI + 0.5, length(nuv));
            vec3 rainbow = hsb2rgb(vec3(puv.x + puv.y - time * 0.2, 1.0, 1.0));
            outColor = mix(vec3(1.0), rainbow, smoothstep(0.0, 1.5 - intens, dist))
                     * (1.0 - dist * dist * dist);
  `

  ,
  radialRainbow: `
            // Foundry VTT: lighting/effects/radial-rainbow.mjs
            // RadialRainbowColorationShader.forceDefaultColor = true
            const float INVTWOPI = 0.15915494309189535;

            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;

            float intens = inten * 0.1;
            vec2 nuv = vUvs * 2.0 - 1.0;
            vec2 puv = vec2(atan(nuv.x, nuv.y) * INVTWOPI + 0.5, length(nuv));
            vec3 rainbow = hsb2rgb(vec3(puv.y - time * 0.2, 1.0, 1.0));
            outColor = mix(vec3(1.0), rainbow, smoothstep(0.0, 1.5 - intens, dist))
                     * (1.0 - dist * dist * dist);
  `

  ,
  forceGrid: `
            // Foundry VTT: lighting/effects/force-grid.mjs
            // ForceGridColorationShader.forceDefaultColor = true
            const float MAX_INTENSITY = 1.2;
            const float MIN_INTENSITY = 0.8;

            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;
            vec3 color = vec3(1.0);

            float d0 = max(dist, 0.0001);
            float f = (1.0 - sqrt(1.0 - d0)) / d0;
            vec2 suvs;
            {
              vec2 uvs = vUvs;
              uvs -= vec2(0.5);
              uvs *= inten * 0.2;
              uvs += vec2(0.5);
              uvs -= vec2(0.50);
              uvs *= f * 5.0;
              uvs += vec2(0.5);
              suvs = uvs;
            }

            float sinWave = 0.5 * (sin(time * 6.0 + pow(1.0 - dist, 0.10) * 35.0 * inten) + 1.0);
            float w = ((MAX_INTENSITY - MIN_INTENSITY) * sinWave) + MIN_INTENSITY;

            vec2 uv = suvs - vec2(0.2075, 0.2075);
            uv = fract(uv);
            float rr = 0.3;
            float d = 1.0;
            float e;
            float cc;
            for (int i = 0; i < 5; i++) {
              e = uv.x - rr;
              cc = clamp(1.0 - abs(e * 0.75), 0.0, 1.0);
              d += pow(cc, 200.0) * (1.0 - dist);
              if (e > 0.0) {
                uv.x = (uv.x - rr) / (2.0 - rr);
              }
              uv = uv.yx;
            }

            vec2 duv = suvs - vec2(0.5);
            float fp = 0.0;
            {
              float p = min( duv.y,  duv.x);
              fp += max(0.3 - mod(p + time + d * 0.3, 3.5), 0.0) * inten * 2.0;
              p = min(-duv.y,  duv.x);
              fp += max(0.3 - mod(p + time + d * 0.3, 3.5), 0.0) * inten * 2.0;
              p = min(-duv.y, -duv.x);
              fp += max(0.3 - mod(p + time + d * 0.3, 3.5), 0.0) * inten * 2.0;
              p = min( duv.y, -duv.x);
              fp += max(0.3 - mod(p + time + d * 0.3, 3.5), 0.0) * inten * 2.0;
            }
            fp *= fp;
            float pert = max(fp, 3.0 - fp) * w;

            vec3 col = vec3(max(d - 1.0, 0.0)) * 1.8;
            col *= pert;
            col += color * 0.30 * w;
            outColor = col * color;
  `

  ,
  starLight: `
            // Foundry VTT: lighting/effects/star-light.mjs
            // StarLightColorationShader.forceDefaultColor = true
            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;
            vec3 color = vec3(1.0);

            float t = time * 0.20;
            mat2 rotmat = mat2(cos(t), -sin(t), sin(t), cos(t));

            vec2 uv = (vUvs - 0.5);
            uv *= rotmat;

            vec2 uvn = normalize(uv * (uv + time * 0.5)) * (5.0 + inten);
            float rays = max(clamp(0.5 * tan(fbm2(uvn - time * 0.5)), 0.0, 2.25),
                             clamp(3.0 - tan(fbm2(uvn + time)), 0.0, 2.25));
            float st = pow(1.0 - dist, rays) * pow(1.0 - dist, 0.25);
            outColor = clamp(color * st, 0.0, 1.0);
  `

  ,
  smokePatch: `
            // Foundry VTT: lighting/effects/smoke-patch.mjs
            const vec2 PIVOT = vec2(0.5, 0.5);

            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            float time = uTime;
            vec3 color = outColor;

            float t = time * 0.1;
            float cost = cos(t);
            float sint = sin(t);
            mat2 rotmat = mat2(cost, -sint, sint, cost);

            vec2 uv = vUvs;
            mat2 scalemat = mat2(10.0, uv.x, uv.y, 10.0);
            uv -= PIVOT;
            uv *= (rotmat * scalemat);
            uv += PIVOT;

            float tt = time * 0.4;
            float fade = pow(1.0 - dist,
              mix(fbm(uv, 1.0 + inten * 0.4),
                  max(fbm(uv + tt, 1.0), fbm(uv - tt, 1.0)),
                  pow(dist, inten * 0.5)));

            outColor = color;
            animAlphaMul *= fade;
  `

  ,
  torch: `
            outColor *= uIntensity;
  `

  ,
  flame: `
            float inten = clamp(uAnimIntensity, 0.0, 10.0);
            vec2 uv = vUvs * (10.0 * (0.35 + 0.65 * clamp(uBrightRadius / max(uRadius, 1.0), 0.0, 1.0)));
            float n1 = fbm(vec2(uv.x + uTime * 8.01, uv.y + uTime * 10.72), 1.0);
            float n2 = fbm(vec2(uv.x + uTime * 7.04, uv.y + uTime * 9.51), 2.0);

            float edgeInner = 1.0 - smoothstep(0.65 - 0.15 * inten * 0.1, 1.0, dist + 0.08 * n1);
            float edgeOuter = 1.0 - smoothstep(0.85 - 0.10 * inten * 0.1, 1.0, dist + 0.10 * n2);
            float core = clamp(edgeInner * 0.85 + edgeOuter * 0.35, 0.0, 1.0);

            vec3 hot = uColor * 8.0;
            vec3 warm = uColor * 1.2;
            outColor = mix(uColor, warm, core);
            outColor = mix(outColor, hot, edgeInner * edgeInner);
            outColor *= uIntensity;
            animAlphaMul *= clamp(core, 0.0, 1.0);
  `

  ,
  pulse: `
            float pfade = 1.0 - smoothstep(uPulse * 0.5, 1.0, dist);
            outColor *= pfade;
            animAlphaMul *= pfade;
  `
};
