import Coordinates from '../utils/coordinates.js';
import { FoundryDarknessShaderChunks } from './FoundryDarknessShaderChunks.js';

export class ThreeDarknessSource {
  constructor(document) {
    this.id = document.id;
    this.document = document;
    this.mesh = null;
    this.material = null;

    this.animation = {
      seed: Math.floor(Math.random() * 100000),
      time: 0
    };

    this._baseRadiusPx = 0;
    this._borderDistance = 0;
    this._usingCircleFallback = false;
  }

  init() {
    const THREE = window.THREE;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uRadius: { value: 0 },
        uAlpha: { value: 1.0 },
        uAttenuation: { value: 0.5 },
        uIntensity: { value: 1.0 },
        uTime: { value: 0 },
        uAnimType: { value: 0 },
        uAnimIntensity: { value: 0 },
        uSeed: { value: 0 },
        uBorderDistance: { value: 0 },
        uGlobalDarknessLevel: { value: 0 }
      },
      vertexShader: `
        varying vec2 vPos;
        void main() {
          vPos = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vPos;
        uniform float uRadius;
        uniform float uAlpha;
        uniform float uAttenuation;
        uniform float uIntensity;
        uniform float uTime;
        uniform float uAnimType;
        uniform float uAnimIntensity;
        uniform float uBorderDistance;
        uniform float uGlobalDarknessLevel;

        const float PI = 3.141592653589793;
        const float TWOPI = 6.283185307179586;
        const float INVTWOPI = 0.15915494309189535;
        const float INVTHREE = 0.3333333333333333;
        const vec2 PIVOT = vec2(0.5, 0.5);
        const vec3 BT709 = vec3(0.2126, 0.7152, 0.0722);

        float perceivedBrightness(in vec3 c) {
          return sqrt(dot(BT709, c * c));
        }

        float random(in vec2 uv) {
          uv = mod(uv, 1000.0);
          return fract(dot(uv, vec2(5.23, 2.89)
                            * fract((2.41 * uv.x + 2.27 * uv.y)
                                     * 251.19)) * 551.83);
        }

        float noise(in vec2 uv) {
          const vec2 d = vec2(0.0, 1.0);
          vec2 b = floor(uv);
          vec2 f = smoothstep(vec2(0.0), vec2(1.0), fract(uv));
          return mix(
            mix(random(b), random(b + d.yx), f.x),
            mix(random(b + d.xy), random(b + d.yy), f.x),
            f.y
          );
        }

        float fbm(in vec2 uv, in float smoothness) {
          float s = exp2(-smoothness);
          float f = 1.0;
          float a = 1.0;
          float t = 0.0;
          for (int i = 0; i < 3; i++) {
            t += a * noise(f * uv);
            f *= 2.0;
            a *= s;
          }
          return t;
        }

        float fbm(vec2 uv) {
          float total = 0.0;
          float amp = 1.0;
          for (int i = 0; i < 3; i++) {
            total += noise(uv) * amp;
            uv += uv;
            amp *= 0.5;
          }
          return total;
        }

        vec4 permute(in vec4 x) {
          return mod(((x * 34.0) + 1.0) * x, 289.0);
        }

        vec4 taylorInvSqrt(in vec4 r) {
          return 1.79284291400159 - 0.85373472095314 * r;
        }

        float snoise(in vec3 v) {
          const vec2 C = vec2(1.0/6.0, 1.0/3.0);
          const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

          vec3 i = floor(v + dot(v, C.yyy));
          vec3 x0 = v - i + dot(i, C.xxx);
          vec3 g = step(x0.yzx, x0.xyz);
          vec3 l = 1.0 - g;
          vec3 i1 = min(g.xyz, l.zxy);
          vec3 i2 = max(g.xyz, l.zxy);
          vec3 x1 = x0 - i1 + C.xxx;
          vec3 x2 = x0 - i2 + 2.0*C.xxx;
          vec3 x3 = x0 - 1.0 + 3.0*C.xxx;
          i = mod(i, 289.0);

          vec4 p = permute(
                     permute(
                       permute(i.z + vec4(0.0, i1.z, i2.z, 1.0))
                     + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                   + i.x + vec4(0.0, i1.x, i2.x, 1.0));

          float n_ = 1.0 / 7.0;
          vec3 ns = n_ * D.wyz - D.xzx;
          vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
          vec4 x_ = floor(j * ns.z);
          vec4 y_ = floor(j - 7.0 * x_);
          vec4 xx = x_ * ns.x + ns.yyyy;
          vec4 yy = y_ * ns.x + ns.yyyy;
          vec4 h = 1.0 - abs(xx) - abs(yy);
          vec4 b0 = vec4(xx.xy, yy.xy);
          vec4 b1 = vec4(xx.zw, yy.zw);
          vec4 s0 = floor(b0) * 2.0 + 1.0;
          vec4 s1 = floor(b1) * 2.0 + 1.0;
          vec4 sh = -step(h, vec4(0.0));
          vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
          vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
          vec3 p0 = vec3(a0.xy, h.x);
          vec3 p1 = vec3(a0.zw, h.y);
          vec3 p2 = vec3(a1.xy, h.z);
          vec3 p3 = vec3(a1.zw, h.w);
          vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
          p0 *= norm.x;
          p1 *= norm.y;
          p2 *= norm.z;
          p3 *= norm.w;

          vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
          m *= m;
          return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
        }

        float fbm(in vec3 uv, in float smoothness) {
          float s = exp2(-smoothness);
          float f = 1.0;
          float a = 1.0;
          float t = 0.0;
          for (int i = 0; i < 5; i++) {
            t += a * snoise(f * uv);
            f *= 2.0;
            a *= s;
          }
          return t;
        }

        // Magical Gloom helpers
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

          vec2 ruv = radialProjection(uv, 0.0, 0.0);
          float n = interference(ruv * 0.5 + vec2(t * 0.07, -t * 0.03));
          float n2 = interference(ruv * 0.3 + vec2(t * 0.1, -t * 0.02));
          n = mix(n, n2, 0.5);

          float d = length(uv);
          float m = smoothstep(0.0, 0.2, d);
          m *= smoothstep(1.0, 0.8, d);

          return m * n;
        }

        void main() {
          float distPx = length(vPos);
          float r = distPx / max(uRadius, 1.0);
          if (r >= 1.0) discard;

          float softness = clamp(uAttenuation, 0.0, 1.0);
          float outerStart = 1.0 - softness;
          float outerEnd = 1.0 + 0.0001;
          float outerAlpha = 1.0 - smoothstep(outerStart, outerEnd, r);

          vec2 vUvs = (vPos / (max(uRadius, 1.0) * 2.0)) + vec2(0.5);
          float dist = r;

          float mask = outerAlpha * clamp(uAlpha, 0.0, 1.0) * clamp(uIntensity, 0.0, 10.0);

          if (uAnimType > 0.5 && uAnimType < 1.5) {
            // magicalGloom
            float t = uTime * 0.3;
            float i = uAnimIntensity * 0.2;
            vec2 uv = vUvs;
            
            float xOffset = (uv.y < 0.5)
                            ? 23.0 + t * 0.035
                            : -11.0 + t * 0.03;
            uv.x += xOffset;

            uv.y = abs(uv.y - 0.5);
            uv.x *= (10.0 + 80.0 * i);

            vec2 ruv = radialProjection(uv, 0.0, 0.0);
            float n = interference(ruv * 0.5 + vec2(t * 0.07, -t * 0.03));
            float n2 = interference(ruv * 0.3 + vec2(t * 0.1, -t * 0.02));
            n = mix(n, n2, 0.5);

            float d = length(uv);
            float m = smoothstep(0.0, 0.2, d);
            m *= smoothstep(1.0, 0.8, d);

            mask *= m * n;
          } else if (uAnimType > 1.5 && uAnimType < 2.5) {
            // roiling
            float t = uTime;
            float i = uAnimIntensity * 0.2;
            vec2 uv = vUvs * 2.0;
            float n = fbm(vec3(uv + vec2(t * 0.1, t * 0.05), t * 0.2), 1.0);
            mask *= n;
          } else if (uAnimType > 2.5 && uAnimType < 3.5) {
            // hole
            float t = uTime;
            float i = uAnimIntensity * 0.2;
            vec2 uv = vUvs;
            float d = length(uv - 0.5);
            float m = smoothstep(0.0, 0.3, d);
            m *= smoothstep(1.0, 0.7, d);
            mask *= m;
          } else if (uAnimType > 3.5 && uAnimType < 4.5) {
            // denseSmoke
            float t = uTime;
            float i = uAnimIntensity * 0.2;
            vec2 uv = vUvs * 3.0;
            float n = fbm(vec3(uv + vec2(t * 0.05, t * 0.03), t * 0.1), 1.5);
            mask *= n;
          }

          mask = clamp(mask, 0.0, 1.0);
          gl_FragColor = vec4(mask, mask, mask, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthWrite: false,
      depthTest: false
    });

    this.updateData(this.document, true);
    this.material.uniforms.uSeed.value = (this.animation.seed % 100000) / 100000;
  }

  _clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  animateTime(tMs, { speed = 5, reverse = false } = {}) {
    let t = tMs;
    if (reverse) t *= -1;
    this.animation.time = ((speed * t) / 5000) + this.animation.seed;
    return this.animation.time;
  }

  _getGroundZ() {
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer && typeof sceneComposer.groundZ === 'number') {
      return sceneComposer.groundZ;
    }
    return 1000;
  }

  updateData(doc, forceRebuild = false) {
    this.document = doc;
    const config = doc.config;
    const THREE = window.THREE;

    const dim = config.dim || 0;
    const bright = config.bright || 0;
    const radius = Math.max(dim, bright);

    const d = canvas.dimensions;
    const pxPerUnit = d.size / d.distance;
    const rPx = radius * pxPerUnit;
    this._baseRadiusPx = rPx;

    const paddingMultiplier = (CONFIG?.Canvas?.darknessSourcePaddingMultiplier ?? 0);
    const paddingPx = paddingMultiplier * (canvas?.grid?.size ?? 0);
    const denom = rPx + paddingPx;
    this._borderDistance = denom > 0 ? (rPx / denom) : 1.0;

    this.material.uniforms.uRadius.value = rPx;
    this.material.uniforms.uAlpha.value = this._clamp((config.alpha ?? 0.5) * 2.0, 0.0, 1.0);
    this.material.uniforms.uBorderDistance.value = this._clamp(this._borderDistance, 0.0, 1.0);

    const rawAttenuation = config.attenuation ?? 0.5;
    const computedAttenuation = (Math.cos(Math.PI * Math.pow(rawAttenuation, 1.5)) - 1) / -2;
    this.material.uniforms.uAttenuation.value = computedAttenuation;

    const worldPos = Coordinates.toWorld(doc.x, doc.y);
    const groundZ = this._getGroundZ();
    const z = groundZ + 0.11;

    if (forceRebuild || !this.mesh) {
      this.rebuildGeometry(worldPos.x, worldPos.y, rPx, z);
    } else {
      this.mesh.position.set(worldPos.x, worldPos.y, z);
    }
  }

  rebuildGeometry(worldX, worldY, radiusPx, z) {
    const THREE = window.THREE;
    // Preserve visibility state so darkness-gated sources don't flash for one
    // frame when a geometry rebuild creates a new Mesh (defaults to visible=true).
    const prevVisible = this.mesh ? this.mesh.visible : undefined;
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.removeFromParent();
    }

    let geometry;
    let shapePoints = null;

    try {
      const placeable = canvas.lighting?.get(this.id);
      const lightSource = placeable?.lightSource ?? placeable?.source;
      if (lightSource) {
        const poly = lightSource.los || lightSource.shape;
        const points = poly?.points;
        if (points && points.length >= 6) {
          shapePoints = [];
          for (let i = 0; i < points.length; i += 2) {
            const v = Coordinates.toWorld(points[i], points[i + 1]);
            shapePoints.push(new THREE.Vector2(v.x - worldX, v.y - worldY));
          }
        }
      }
    } catch (e) {
    }

    if (shapePoints && shapePoints.length > 2) {
      const shape = new THREE.Shape(shapePoints);
      geometry = new THREE.ShapeGeometry(shape);
      this._usingCircleFallback = false;
    } else {
      geometry = new THREE.CircleGeometry(radiusPx, 128);
      this._usingCircleFallback = true;
    }

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.set(worldX, worldY, z);
    this.mesh.renderOrder = 95;

    // Restore the previous mesh's visibility state so darkness-gated sources
    // don't flash visible for one frame during geometry rebuilds.
    if (prevVisible !== undefined) {
      this.mesh.visible = prevVisible;
    }
  }

  updateAnimation(timeInfo) {
    const tMs = (timeInfo && typeof timeInfo.elapsed === 'number') ? (timeInfo.elapsed * 1000) : 0;
    const a = this.document?.config?.animation;
    const type = a?.type ?? null;
    const speed = typeof a?.speed === 'number' ? a.speed : 5;
    const intensity = typeof a?.intensity === 'number' ? a.intensity : 5;
    const reverse = !!a?.reverse;

    const u = this.material.uniforms;
    u.uIntensity.value = this._clamp(intensity / 5.0, 0.0, 2.0);
    u.uAnimType.value = 0;
    u.uAnimIntensity.value = this._clamp(intensity, 0, 10);

    try {
      const env = canvas?.environment;
      if (env && typeof env.darknessLevel === 'number') {
        u.uGlobalDarknessLevel.value = this._clamp(env.darknessLevel, 0.0, 1.0);
      }
    } catch (e) {
    }

    if (!type || this._baseRadiusPx <= 0) {
      return;
    }

    this.animateTime(tMs, { speed, reverse });
    u.uTime.value = this.animation.time;

    if (type === 'magicalGloom') {
      u.uAnimType.value = 1;
    } else if (type === 'roiling') {
      u.uAnimType.value = 2;
    } else if (type === 'hole') {
      u.uAnimType.value = 3;
    } else if (type === 'denseSmoke') {
      u.uAnimType.value = 4;
    }
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
  }
}
