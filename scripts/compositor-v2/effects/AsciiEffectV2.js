import { createLogger } from '../../core/log.js';

const log = createLogger('AsciiEffectV2');

/**
 * AsciiEffectV2 - screen-space ASCII art post-processing filter.
 *
 * Archetype: C (Post-Processing Effect)
 * Converts the composed scene to ASCII glyphs using a generated font atlas.
 */
export class AsciiEffectV2 {
  constructor() {
    this._enabled = false;
    this._initialized = false;

    this._quadScene = null;
    this._quadCamera = null;
    this._mesh = null;
    this._material = null;

    this._fontTexture = null;
    this._fontTexture2 = null;
    this._lastCharSet = null;

    this._lastGridResolution = null;
    this._lastLineHeight = null;
    this._lastPadX = null;
    this._lastPadY = null;
    /** @type {number|null} */
    this._lastGridPixelW = null;
    /** @type {number|null} */
    this._lastGridPixelH = null;

    this.params = {
      enabled: false,
      resolution: 0.12,
      lineHeight: 1.5,
      opacity: 0.95,
      color: true,
      invert: false,
      charSet: 'detailed',
      glyphScaleX: 1.15,
      glyphScaleY: 0.95,
      cellPaddingX: 0.15,
      cellPaddingY: 0.15,
      churn: 0.72,
      churnSpeed: 0.75,
      blockOpacity: 0.4,
      textOpacity: 1.0,
      blackPoint: 0.0,
      whitePoint: 0.82,
      contrast: 1.66,
      brightness: 0.18,
    };

    this._charSets = {
      simple: ' .:-=+*#%@',
      detailed: ' .\'`^\",:;Il!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
      matrix: ' 01',
      blocks: ' ░▒▓█',
      hybrid: 'hybrid',
    };

    this._enabled = !!this.params.enabled;
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(v) {
    this._enabled = !!v;
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, 'enabled')) {
      this.params.enabled = this._enabled;
    }
  }

  static getControlSchema() {
    return {
      enabled: false,
      help: {
        title: 'ASCII art',
        summary: [
          'Turns the map into letters and symbols, like old computer art or a “hacker” screen. It looks at your picture, picks matching characters, and can gently shuffle them over time.',
          'Works on the whole finished image. No special map layers needed.',
          'If letters keep changing, the scene may run a bit more often for smooth motion — turn **Letter shuffle** down to zero for a still image.',
          'Settings save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          'Grid detail': 'How many letter columns you get — higher means smaller letters.',
          'Row height': 'How tall each row of letters is.',
          'Effect strength': 'How much you see the letters versus the normal map.',
          'Letter shuffle': 'How often letters are re-picked (living / glitchy look).',
          'Hybrid mode': 'A style that mixes shaded blocks with simple text on top.',
        },
      },
      presetApplyDefaults: true,
      groups: [
        {
          name: 'picture',
          label: 'Picture',
          type: 'folder',
          expanded: true,
          parameters: ['resolution', 'lineHeight', 'opacity'],
        },
        {
          name: 'letterShape',
          label: 'Letter shape',
          type: 'folder',
          expanded: true,
          parameters: ['glyphScaleX', 'glyphScaleY'],
        },
        {
          name: 'spacing',
          label: 'Spacing',
          type: 'folder',
          expanded: false,
          parameters: ['cellPaddingX', 'cellPaddingY'],
        },
        {
          name: 'look',
          label: 'Look & motion',
          type: 'folder',
          expanded: true,
          parameters: ['charSet', 'color', 'invert', 'churn', 'churnSpeed'],
        },
        {
          name: 'hybrid',
          label: 'Hybrid mode',
          type: 'folder',
          expanded: false,
          parameters: ['blockOpacity', 'textOpacity'],
        },
        {
          name: 'tone',
          label: 'Brightness & contrast',
          type: 'folder',
          expanded: false,
          parameters: ['blackPoint', 'whitePoint', 'contrast', 'brightness'],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },
        resolution: {
          type: 'slider',
          label: 'Grid detail',
          min: 0.05,
          max: 0.5,
          step: 0.01,
          default: 0.12,
          tooltip: 'How many letter columns across the screen. Higher means smaller letters and more detail.',
        },
        lineHeight: {
          type: 'slider',
          label: 'Row height',
          min: 0.5,
          max: 4.0,
          step: 0.1,
          default: 1.5,
          tooltip: 'How tall each row is. Higher spreads rows apart and changes the letter shapes.',
        },
        opacity: {
          type: 'slider',
          label: 'Effect strength',
          min: 0,
          max: 1,
          step: 0.05,
          default: 0.95,
          tooltip: 'How strong the letter picture is compared to the normal map underneath.',
        },
        glyphScaleX: {
          type: 'slider',
          label: 'Letter width',
          min: 0.25,
          max: 1.5,
          step: 0.05,
          default: 1.15,
          tooltip: 'Stretch letters wider or narrower inside each cell.',
        },
        glyphScaleY: {
          type: 'slider',
          label: 'Letter height',
          min: 0.25,
          max: 1.5,
          step: 0.05,
          default: 0.95,
          tooltip: 'Stretch letters taller or shorter inside each cell.',
        },
        cellPaddingX: {
          type: 'slider',
          label: 'Side padding',
          min: 0.0,
          max: 0.45,
          step: 0.01,
          default: 0.15,
          tooltip: 'Empty space on the left and right inside each letter box.',
        },
        cellPaddingY: {
          type: 'slider',
          label: 'Top/bottom padding',
          min: 0.0,
          max: 0.45,
          step: 0.01,
          default: 0.15,
          tooltip: 'Empty space above and below inside each letter box.',
        },
        churn: {
          type: 'slider',
          label: 'Letter shuffle',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.72,
          tooltip: 'How much letters keep changing. Zero keeps a steady picture.',
        },
        churnSpeed: {
          type: 'slider',
          label: 'Shuffle speed',
          min: 0.25,
          max: 30.0,
          step: 0.25,
          default: 0.75,
          tooltip: 'How fast letters change when shuffle is turned up.',
        },
        color: {
          type: 'boolean',
          label: 'Keep map colors',
          default: true,
          tooltip: 'On: letters keep your map’s colors. Off: gray shades only.',
        },
        invert: {
          type: 'boolean',
          label: 'Invert light/dark',
          default: false,
          tooltip: 'Swap bright and dark areas, like a photo negative.',
        },
        charSet: {
          type: 'list',
          label: 'Character style',
          options: {
            Simple: 'simple',
            Detailed: 'detailed',
            Matrix: 'matrix',
            Blocks: 'blocks',
            'Hybrid (Block+Simple)': 'hybrid',
          },
          default: 'detailed',
          tooltip: 'Which symbols are used to draw the picture. Hybrid mixes blocks and simple letters.',
        },
        blockOpacity: {
          type: 'slider',
          label: 'Block strength',
          min: 0,
          max: 1,
          step: 0.05,
          default: 0.4,
          tooltip: 'For Hybrid style: how strong the shaded block layer is behind the letters.',
        },
        textOpacity: {
          type: 'slider',
          label: 'Letter strength',
          min: 0,
          max: 1,
          step: 0.05,
          default: 1.0,
          tooltip: 'For Hybrid style: how strong the letters are on top of the blocks.',
        },
        blackPoint: {
          type: 'slider',
          label: 'Shadow depth',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.0,
          tooltip: 'Treat more of the dark areas as “fully black” before picking letters.',
        },
        whitePoint: {
          type: 'slider',
          label: 'Highlight point',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.82,
          tooltip: 'How bright something must be before it counts as a full highlight.',
        },
        contrast: {
          type: 'slider',
          label: 'Contrast',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.66,
          tooltip: 'More contrast: shadows and lights look farther apart. Less: flatter, softer.',
        },
        brightness: {
          type: 'slider',
          label: 'Brightness',
          min: -0.5,
          max: 0.5,
          step: 0.01,
          default: 0.18,
          tooltip: 'Lighten or darken the whole picture before it becomes letters.',
        },
      },
      presets: {
        'Chunky letters': {
          resolution: 0.07,
          lineHeight: 1.8,
          charSet: 'simple',
          churn: 0.2,
          churnSpeed: 0.75,
        },
        'Fine detail': {
          resolution: 0.22,
          lineHeight: 1.35,
          charSet: 'detailed',
          churn: 0.35,
        },
        'Code rain look': {
          charSet: 'matrix',
          color: false,
          invert: false,
          churn: 0.85,
          churnSpeed: 2.5,
          brightness: 0.05,
        },
      },
    };
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE not available');
      return;
    }

    this._quadScene = new THREE.Scene();
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._updateFontTexture(this.params.charSet);
    this._lastCharSet = this.params.charSet;

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tFont: { value: this._fontTexture },
        tFont2: { value: this._fontTexture2 || null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uGridSize: { value: new THREE.Vector2(100, 100) },
        uCharCount: { value: 10.0 },
        uCharCount2: { value: 0.0 },
        uGlyphScale: { value: new THREE.Vector2(1.0, 1.0) },
        uTime: { value: 0.0 },
        uChurn: { value: 0.0 },
        uChurnSpeed: { value: 4.0 },
        uOpacity: { value: 1.0 },
        uColor: { value: false },
        uInvert: { value: false },
        uHybrid: { value: false },
        uBlockOpacity: { value: 1.0 },
        uTextOpacity: { value: 1.0 },
        uBlackPoint: { value: 0.0 },
        uWhitePoint: { value: 1.0 },
        uContrast: { value: 1.0 },
        uBrightness: { value: 0.0 },
      },
      vertexShader: this._getVertexShader(),
      fragmentShader: this._getFragmentShader(),
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      transparent: false,
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    this._mesh = new THREE.Mesh(geometry, this._material);
    this._mesh.frustumCulled = false;
    this._quadScene.add(this._mesh);

    this._initialized = true;
  }

  update(timeInfo) {
    if (!this._initialized || !this._material) return;

    const p = this.params;
    const u = this._material.uniforms;

    if (p.charSet !== this._lastCharSet) {
      this._updateFontTexture(p.charSet);
      this._lastCharSet = p.charSet;
    }

    const isHybrid = p.charSet === 'hybrid';

    u.uOpacity.value = p.opacity;
    u.uColor.value = !!p.color;
    u.uInvert.value = !!p.invert;
    u.uGlyphScale.value.set(p.glyphScaleX, p.glyphScaleY);
    u.uTime.value = Number.isFinite(timeInfo?.elapsed) ? timeInfo.elapsed : u.uTime.value;
    u.uChurn.value = p.churn;
    u.uChurnSpeed.value = p.churnSpeed;
    u.uHybrid.value = isHybrid;
    u.uBlockOpacity.value = p.blockOpacity;
    u.uTextOpacity.value = p.textOpacity;
    u.uBlackPoint.value = p.blackPoint;
    u.uWhitePoint.value = p.whitePoint;
    u.uContrast.value = p.contrast;
    u.uBrightness.value = p.brightness;
  }

  render(renderer, camera, inputRT, outputRT) {
    if (!this._enabled || !this._initialized || !this._material || !inputRT || !outputRT) return false;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    this._material.uniforms.tDiffuse.value = inputRT.texture;

    // Match the texture being sampled (post RT), not the drawing buffer — they can differ (DPR, sizing).
    const w = Math.max(1, inputRT.width | 0);
    const h = Math.max(1, inputRT.height | 0);
    this._material.uniforms.uResolution.value.set(w, h);
    this._updateGridSize(w, h);

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = false;
    renderer.render(this._quadScene, this._quadCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    return true;
  }

  onFloorChange(maxFloorIndex) {}

  onResize(width, height) {
    if (!this._material) return;
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this._material.uniforms.uResolution.value.set(w, h);
    this._updateGridSize(w, h);
  }

  wantsContinuousRender() {
    if (!this._enabled) return false;
    return (this.params.churn ?? 0) > 0.0;
  }

  dispose() {
    if (this._fontTexture) {
      this._fontTexture.dispose();
      this._fontTexture = null;
    }
    if (this._fontTexture2) {
      this._fontTexture2.dispose();
      this._fontTexture2 = null;
    }
    if (this._material) {
      this._material.dispose();
      this._material = null;
    }
    if (this._mesh) {
      if (this._mesh.geometry) this._mesh.geometry.dispose();
      this._mesh = null;
    }

    this._quadScene = null;
    this._quadCamera = null;
    this._initialized = false;
  }

  _updateGridSize(width, height) {
    if (!this._material) return;

    const resolution = this.params.resolution;
    const lineHeight = this.params.lineHeight || 1.0;
    const padX = this.params.cellPaddingX ?? 0.0;
    const padY = this.params.cellPaddingY ?? 0.0;

    if (
      this._lastGridPixelW === width &&
      this._lastGridPixelH === height &&
      this._lastGridResolution === resolution &&
      this._lastLineHeight === lineHeight &&
      this._lastPadX === padX &&
      this._lastPadY === padY
    ) {
      return;
    }

    const padScaleX = Math.max(0.05, 1.0 - 2.0 * Math.min(Math.max(padX, 0.0), 0.49));
    const padScaleY = Math.max(0.05, 1.0 - 2.0 * Math.min(Math.max(padY, 0.0), 0.49));

    const cols = Math.max(1, Math.floor(width * resolution * padScaleX));
    const rows = Math.max(1, Math.floor((height * resolution * padScaleY) / lineHeight));
    this._material.uniforms.uGridSize.value.set(cols, rows);

    this._lastGridPixelW = width;
    this._lastGridPixelH = height;
    this._lastGridResolution = resolution;
    this._lastLineHeight = lineHeight;
    this._lastPadX = padX;
    this._lastPadY = padY;
  }

  _updateFontTexture(charSetName) {
    const THREE = window.THREE;
    if (!THREE) return;

    const createAtlas = (chars) => {
      const fontSize = 64;
      const width = fontSize * chars.length;
      const height = fontSize;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // Opaque black backing so glyph coverage lives in .rgb; transparent canvas + WebGL alpha upload is unreliable for masks.
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF';

      for (let i = 0; i < chars.length; i++) {
        ctx.fillText(chars[i], i * fontSize + fontSize / 2, fontSize / 2);
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.premultiplyAlpha = false;
      return texture;
    };

    const isHybrid = charSetName === 'hybrid';
    if (isHybrid) {
      const simpleChars = this._charSets.simple;
      const blockChars = this._charSets.blocks;

      if (this._fontTexture) this._fontTexture.dispose();
      if (this._fontTexture2) this._fontTexture2.dispose();

      this._fontTexture = createAtlas(simpleChars);
      this._fontTexture2 = createAtlas(blockChars);

      if (this._material) {
        this._material.uniforms.tFont.value = this._fontTexture;
        this._material.uniforms.tFont2.value = this._fontTexture2;
        this._material.uniforms.uCharCount.value = simpleChars.length;
        this._material.uniforms.uCharCount2.value = blockChars.length;
        this._material.needsUpdate = true;
      }
      return;
    }

    const chars = this._charSets[charSetName] || this._charSets.simple;

    if (this._fontTexture) this._fontTexture.dispose();
    if (this._fontTexture2) {
      this._fontTexture2.dispose();
      this._fontTexture2 = null;
    }

    this._fontTexture = createAtlas(chars);

    if (this._material) {
      this._material.uniforms.tFont.value = this._fontTexture;
      this._material.uniforms.tFont2.value = null;
      this._material.uniforms.uCharCount.value = chars.length;
      this._material.uniforms.uCharCount2.value = 0.0;
      this._material.needsUpdate = true;
    }
  }

  _getVertexShader() {
    return /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `;
  }

  _getFragmentShader() {
    return /* glsl */`
      uniform sampler2D tDiffuse;
      uniform sampler2D tFont;
      uniform sampler2D tFont2;
      uniform vec2 uResolution;
      uniform vec2 uGridSize;
      uniform float uCharCount;
      uniform float uCharCount2;
      uniform vec2 uGlyphScale;
      uniform float uTime;
      uniform float uChurn;
      uniform float uChurnSpeed;
      uniform float uOpacity;
      uniform bool uColor;
      uniform bool uInvert;
      uniform bool uHybrid;
      uniform float uBlockOpacity;
      uniform float uTextOpacity;
      uniform float uBlackPoint;
      uniform float uWhitePoint;
      uniform float uContrast;
      uniform float uBrightness;
      varying vec2 vUv;

      float random(vec2 p) {
        return fract(sin(dot(p.xy, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec4 scenePx = texture2D(tDiffuse, vUv);
        vec2 cellCoord = floor(vUv * uGridSize);
        vec2 cellCenterUV = (cellCoord + 0.5) / uGridSize;
        vec4 texel = texture2D(tDiffuse, cellCenterUV);

        float brightness = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));
        brightness = (brightness - 0.5) * uContrast + 0.5 + uBrightness;
        brightness = smoothstep(uBlackPoint, uWhitePoint, brightness);
        if (uInvert) brightness = 1.0 - brightness;

        brightness = clamp(brightness, 0.0, 1.0);
        float charIndex = floor(brightness * (uCharCount - 0.01));

        if (uChurn > 0.0 && uCharCount > 1.0) {
          float speed = max(0.01, uChurnSpeed);
          float quantizedTime = floor(uTime * speed) / speed;
          float n = random(cellCenterUV * 37.0 + vec2(quantizedTime, 0.0));
          float signedNoise = (n - 0.5) * 2.0;
          float maxSteps = 4.0 * uChurn;
          float offset = signedNoise * maxSteps;
          float stepOffset = floor(offset + 0.5);
          float newIndex = charIndex + stepOffset;
          charIndex = clamp(newIndex, 0.0, uCharCount - 1.0);
        }

        vec2 cellUV = fract(vUv * uGridSize);
        vec2 scale = clamp(uGlyphScale, vec2(0.1), vec2(4.0));
        vec2 innerUV = (cellUV - vec2(0.5)) / scale + vec2(0.5);

        vec2 fontUV1 = vec2((charIndex + innerUV.x) / max(uCharCount, 1.0), innerUV.y);
        vec4 fontColor1 = texture2D(tFont, fontUV1);
        // Atlas is white-on-black; use luminance from RGB (alpha from 2D canvas is often wrong in WebGL uploads).
        float charMask1 = max(max(fontColor1.r, fontColor1.g), fontColor1.b);
        vec3 baseColor = uColor ? texel.rgb : vec3(1.0);
        vec3 finalColor;

        if (uHybrid && uCharCount2 > 0.0) {
          vec2 fontUV2 = vec2((charIndex + innerUV.x) / max(uCharCount2, 1.0), innerUV.y);
          vec4 fontColor2 = texture2D(tFont2, fontUV2);
          float charMask2 = max(max(fontColor2.r, fontColor2.g), fontColor2.b);
          vec3 blockLayer = baseColor * charMask2 * uBlockOpacity;
          vec3 textLayer = baseColor * charMask1 * uTextOpacity;
          finalColor = blockLayer + textLayer;
        } else {
          finalColor = uColor ? (texel.rgb * charMask1) : vec3(charMask1);
        }

        if (uOpacity < 1.0) {
          gl_FragColor = mix(scenePx, vec4(finalColor, scenePx.a), uOpacity);
        } else {
          gl_FragColor = vec4(finalColor, scenePx.a);
        }
      }
    `;
  }
}
