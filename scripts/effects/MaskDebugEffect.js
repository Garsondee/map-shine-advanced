import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('MaskDebugEffect');

export class MaskDebugEffect extends EffectBase {
  constructor() {
    super('mask-debug', RenderLayers.POST_PROCESSING, 'low');

    this.priority = 10000;

    this.enabled = false;

    this.params = {
      enabled: false,
      maskId: 'fire.scene',
      sampleSpace: 'auto',
      channel: 'r',
      invert: false,
      thresholdEnabled: false,
      thresholdLo: 0.0,
      thresholdHi: 1.0,
      mode: 'overlay',
      opacity: 1.0
    };

    this.renderer = null;
    this.mainCamera = null;

    this.material = null;
    this.quadScene = null;
    this.quadCamera = null;

    this.readBuffer = null;
    this.writeBuffer = null;

    this._tempSize = null;
    this._tempNdc = null;
    this._tempWorld = null;
    this._tempDir = null;
    this._viewBounds = null;
  }

  static getControlSchema(maskOptions = null) {
    const options = (maskOptions && typeof maskOptions === 'object') ? maskOptions : null;

    return {
      enabled: false,
      groups: [
        {
          name: 'mask-debug',
          label: 'Mask Debug',
          type: 'inline',
          parameters: [
            'maskId',
            'sampleSpace',
            'channel',
            'mode',
            'opacity',
            'invert',
            'thresholdEnabled',
            'thresholdLo',
            'thresholdHi'
          ]
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: false },
        maskId: {
          label: 'Mask',
          default: 'outdoors.scene',
          options: options ?? undefined
        },
        sampleSpace: {
          label: 'Space',
          default: 'auto',
          options: {
            Auto: 'auto',
            Screen: 'screen',
            Scene: 'scene'
          }
        },
        channel: {
          label: 'Channel',
          default: 'r',
          options: {
            R: 'r',
            G: 'g',
            B: 'b',
            A: 'a',
            Luma: 'luma'
          }
        },
        mode: {
          label: 'Mode',
          default: 'overlay',
          options: {
            Overlay: 'overlay',
            Replace: 'replace'
          }
        },
        opacity: {
          type: 'slider',
          label: 'Opacity',
          min: 0,
          max: 1,
          step: 0.01,
          default: 1.0,
          throttle: 50
        },
        invert: { type: 'boolean', label: 'Invert', default: false },
        thresholdEnabled: { type: 'boolean', label: 'Threshold', default: false },
        thresholdLo: {
          type: 'slider',
          label: 'Lo',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.0,
          throttle: 50
        },
        thresholdHi: {
          type: 'slider',
          label: 'Hi',
          min: 0,
          max: 1,
          step: 0.01,
          default: 1.0,
          throttle: 50
        }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) return;

    this.renderer = renderer;
    this.mainCamera = camera;

    this._tempSize = new THREE.Vector2();
    this._tempNdc = new THREE.Vector3();
    this._tempWorld = new THREE.Vector3();
    this._tempDir = new THREE.Vector3();
    this._viewBounds = new THREE.Vector4(0, 0, 1, 1);

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tMask: { value: null },
        uHasMask: { value: 0.0 },
        uMaskFlipY: { value: 0.0 },

        uMode: { value: 1.0 },
        uOpacity: { value: 1.0 },
        uChannel: { value: 0.0 },
        uInvert: { value: 0.0 },
        uUseThreshold: { value: 0.0 },
        uLo: { value: 0.0 },
        uHi: { value: 1.0 },

        uSampleSpace: { value: 0.0 },
        uViewBounds: { value: this._viewBounds },
        uSceneDimensions: { value: new THREE.Vector2(1.0, 1.0) },
        uSceneRect: { value: new THREE.Vector4(0.0, 0.0, 1.0, 1.0) },
        uHasSceneRect: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tMask;
        uniform float uHasMask;
        uniform float uMaskFlipY;

        uniform float uMode;
        uniform float uOpacity;
        uniform float uChannel;
        uniform float uInvert;
        uniform float uUseThreshold;
        uniform float uLo;
        uniform float uHi;

        uniform float uSampleSpace;
        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;

        varying vec2 vUv;

        vec2 screenUvToFoundry(vec2 screenUv) {
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          float foundryX = threeX;
          float foundryY = uSceneDimensions.y - threeY;
          return vec2(foundryX, foundryY);
        }

        vec2 foundryToSceneUv(vec2 foundryPos) {
          vec2 sceneOrigin = uSceneRect.xy;
          vec2 sceneSize = uSceneRect.zw;
          return (foundryPos - sceneOrigin) / sceneSize;
        }

        float msLuminance(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        float sampleChannel(vec4 m) {
          if (uChannel < 0.5) return m.r;
          if (uChannel < 1.5) return m.g;
          if (uChannel < 2.5) return m.b;
          if (uChannel < 3.5) return m.a;
          return msLuminance(m.rgb);
        }

        void main() {
          vec4 sceneColor = texture2D(tDiffuse, vUv);

          if (uHasMask < 0.5) {
            gl_FragColor = sceneColor;
            return;
          }

          vec2 uv = vUv;
          if (uSampleSpace > 0.5 && uHasSceneRect > 0.5) {
            vec2 foundryPos = screenUvToFoundry(vUv);
            uv = foundryToSceneUv(foundryPos);
            uv = clamp(uv, vec2(0.0), vec2(1.0));
          }

          if (uMaskFlipY > 0.5) {
            uv.y = 1.0 - uv.y;
          }

          vec4 m = texture2D(tMask, uv);
          float v = sampleChannel(m);

          if (uUseThreshold > 0.5) {
            v = smoothstep(uLo, uHi, v);
          }
          if (uInvert > 0.5) {
            v = 1.0 - v;
          }

          vec3 maskColor = vec3(v);

          if (uMode < 0.5) {
            gl_FragColor = vec4(maskColor, 1.0);
          } else {
            float a = clamp(uOpacity, 0.0, 1.0);
            vec3 outC = mix(sceneColor.rgb, maskColor, a);
            gl_FragColor = vec4(outC, sceneColor.a);
          }
        }
      `,
      depthWrite: false,
      depthTest: false
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quadScene.add(quad);

    log.info('MaskDebugEffect initialized');
  }

  setBuffers(readBuffer, writeBuffer) {
    this.readBuffer = readBuffer;
    this.writeBuffer = writeBuffer;
  }

  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  applyParamChange(paramId, value) {
    if (!this.params) return;
    if (paramId === 'enabled') {
      this.enabled = !!value;
      this.params.enabled = !!value;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }
  }

  update(timeInfo) {
    if (!this.enabled || !this.material) return;

    const u = this.material.uniforms;

    try {
      const d = canvas?.dimensions;
      if (d && typeof d.width === 'number' && typeof d.height === 'number') {
        u.uSceneDimensions.value.set(d.width, d.height);
      }

      const sceneRect = d?.sceneRect;
      if (sceneRect && typeof sceneRect.x === 'number' && typeof sceneRect.y === 'number') {
        u.uSceneRect.value.set(sceneRect.x, sceneRect.y, sceneRect.width || 1, sceneRect.height || 1);
        u.uHasSceneRect.value = 1.0;
      } else {
        u.uHasSceneRect.value = 0.0;
      }

      const camera = this.mainCamera;
      const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
      if (camera) {
        this._updateViewBoundsFromCamera(camera, groundZ, u.uViewBounds.value);
      }
     } catch (e) {
      u.uHasSceneRect.value = 0.0;
    }

    const mm = window.MapShine?.maskManager;
    const maskId = this.params.maskId;
    let tex = null;
    let rec = null;

    if (mm && typeof mm.getTexture === 'function') {
      tex = mm.getTexture(maskId);
      rec = mm.getRecord(maskId);
    }

    if (tex) {
      u.tMask.value = tex;
      u.uHasMask.value = 1.0;
      const metaFlipY = (rec && typeof rec.uvFlipY === 'boolean') ? rec.uvFlipY : null;
      u.uMaskFlipY.value = (metaFlipY !== null) ? (metaFlipY ? 1.0 : 0.0) : (tex.flipY ? 1.0 : 0.0);
    } else {
      u.tMask.value = null;
      u.uHasMask.value = 0.0;
      u.uMaskFlipY.value = 0.0;
    }

    let sampleSpace = this.params.sampleSpace;
    if (sampleSpace !== 'screen' && sampleSpace !== 'scene') {
      const s = rec?.space;
      sampleSpace = (s === 'sceneUv') ? 'scene' : 'screen';
    }

    u.uSampleSpace.value = sampleSpace === 'scene' ? 1.0 : 0.0;

    const channel = this.params.channel;
    if (channel === 'r') u.uChannel.value = 0.0;
    else if (channel === 'g') u.uChannel.value = 1.0;
    else if (channel === 'b') u.uChannel.value = 2.0;
    else if (channel === 'a') u.uChannel.value = 3.0;
    else u.uChannel.value = 4.0;

    u.uInvert.value = this.params.invert ? 1.0 : 0.0;
    u.uUseThreshold.value = this.params.thresholdEnabled ? 1.0 : 0.0;
    u.uLo.value = this.params.thresholdLo;
    u.uHi.value = this.params.thresholdHi;

    u.uOpacity.value = this.params.opacity;
    u.uMode.value = (this.params.mode === 'replace') ? 0.0 : 1.0;
  }

  render(renderer, scene, camera) {
    if (!this.enabled || !this.material) return;

    const inputTexture = this.readBuffer ? this.readBuffer.texture : this.material.uniforms.tDiffuse.value;
    if (!inputTexture) return;

    this.material.uniforms.tDiffuse.value = inputTexture;

    if (this.writeBuffer) {
      renderer.setRenderTarget(this.writeBuffer);
      renderer.clear();
    } else {
      renderer.setRenderTarget(null);
    }

    renderer.render(this.quadScene, this.quadCamera);
  }

  _updateViewBoundsFromCamera(camera, groundZ, outVec4) {
    const THREE = window.THREE;
    if (!THREE || !outVec4 || !camera) return;

    if (camera.isOrthographicCamera) {
      const camPos = camera.position;
      const minX = camPos.x + camera.left / camera.zoom;
      const maxX = camPos.x + camera.right / camera.zoom;
      const minY = camPos.y + camera.bottom / camera.zoom;
      const maxY = camPos.y + camera.top / camera.zoom;
      outVec4.set(minX, minY, maxX, maxY);
      return;
    }

    const origin = camera.position;
    const ndc = this._tempNdc;
    const world = this._tempWorld;
    const dir = this._tempDir;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1]
    ];

    for (let i = 0; i < corners.length; i++) {
      const cx = corners[i][0];
      const cy = corners[i][1];

      ndc.set(cx, cy, 0.5);
      world.copy(ndc).unproject(camera);

      dir.subVectors(world, origin).normalize();
      const dz = dir.z;
      if (Math.abs(dz) < 1e-6) continue;

      const t = (groundZ - origin.z) / dz;
      if (!Number.isFinite(t) || t <= 0) continue;

      const ix = origin.x + dir.x * t;
      const iy = origin.y + dir.y * t;

      if (ix < minX) minX = ix;
      if (iy < minY) minY = iy;
      if (ix > maxX) maxX = ix;
      if (iy > maxY) maxY = iy;
    }

    if (minX !== Infinity && minY !== Infinity && maxX !== -Infinity && maxY !== -Infinity) {
      outVec4.set(minX, minY, maxX, maxY);
    }
  }

  dispose() {
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.quadScene) {
      this.quadScene = null;
    }
    this.quadCamera = null;
    this.renderer = null;
    this.mainCamera = null;
  }
}
