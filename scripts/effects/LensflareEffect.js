/**
 * @fileoverview Lensflare Effect
 * Adds cinematic lens flares to light sources in the scene
 * Adapts THREE.Lensflare to work with our effect system
 * @module effects/LensflareEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('LensflareEffect');

// --- Adapted THREE.Lensflare Implementation ---
// We adapt this to use window.THREE instead of imports since we're in a bundled environment without import maps

function getLensflareClasses() {
  const THREE = window.THREE;
  
  class LensflareElement {
    constructor(texture, size = 1, distance = 0, color = new THREE.Color(0xffffff)) {
      this.texture = texture;
      this.size = size;
      this.distance = distance;
      this.color = color;
      
      // Store base values for dynamic updates
      this.baseSize = size;
      this.baseColor = color.clone();
    }
  }

  LensflareElement.Shader = {
    name: 'LensflareElementShader',
    uniforms: {
      'map': { value: null },
      'occlusionMap': { value: null },
      'color': { value: null },
      'scale': { value: null },
      'screenPosition': { value: null }
    },
    vertexShader: /* glsl */`
      precision highp float;
      uniform vec3 screenPosition;
      uniform vec2 scale;
      uniform sampler2D occlusionMap;
      attribute vec3 position;
      attribute vec2 uv;
      varying vec2 vUV;
      varying float vVisibility;
      void main() {
        vUV = uv;
        vec2 pos = position.xy;
        vec4 visibility = texture2D( occlusionMap, vec2( 0.1, 0.1 ) );
        visibility += texture2D( occlusionMap, vec2( 0.5, 0.1 ) );
        visibility += texture2D( occlusionMap, vec2( 0.9, 0.1 ) );
        visibility += texture2D( occlusionMap, vec2( 0.9, 0.5 ) );
        visibility += texture2D( occlusionMap, vec2( 0.9, 0.9 ) );
        visibility += texture2D( occlusionMap, vec2( 0.5, 0.9 ) );
        visibility += texture2D( occlusionMap, vec2( 0.1, 0.9 ) );
        visibility += texture2D( occlusionMap, vec2( 0.1, 0.5 ) );
        visibility += texture2D( occlusionMap, vec2( 0.5, 0.5 ) );
        vVisibility =        visibility.r / 9.0;
        vVisibility *= 1.0 - visibility.g / 9.0;
        vVisibility *=       visibility.b / 9.0;
        gl_Position = vec4( ( pos * scale + screenPosition.xy ).xy, screenPosition.z, 1.0 );
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D map;
      uniform vec3 color;
      varying vec2 vUV;
      varying float vVisibility;
      void main() {
        vec4 texture = texture2D( map, vUV );
        texture.a *= vVisibility;
        gl_FragColor = texture;
        gl_FragColor.rgb *= color;
      }`
  };

  class Lensflare extends THREE.Mesh {
    constructor() {
      super(Lensflare.Geometry, new THREE.MeshBasicMaterial({ opacity: 0, transparent: true }));
      
      this.isLensflare = true;
      this.type = 'Lensflare';
      this.frustumCulled = false;
      this.renderOrder = Infinity;

      const positionScreen = new THREE.Vector3();
      const positionView = new THREE.Vector3();

      // textures
      const tempMap = new THREE.FramebufferTexture(16, 16);
      const occlusionMap = new THREE.FramebufferTexture(16, 16);

      let currentType = THREE.UnsignedByteType;

      // material
      const geometry = Lensflare.Geometry;

      const material1a = new THREE.RawShaderMaterial({
        uniforms: {
          'scale': { value: null },
          'screenPosition': { value: null }
        },
        vertexShader: /* glsl */`
          precision highp float;
          uniform vec3 screenPosition;
          uniform vec2 scale;
          attribute vec3 position;
          void main() {
            gl_Position = vec4( position.xy * scale + screenPosition.xy, screenPosition.z, 1.0 );
          }`,
        fragmentShader: /* glsl */`
          precision highp float;
          void main() {
            gl_FragColor = vec4( 1.0, 0.0, 1.0, 1.0 );
          }`,
        depthTest: true,
        depthWrite: false,
        transparent: false
      });

      const material1b = new THREE.RawShaderMaterial({
        uniforms: {
          'map': { value: tempMap },
          'scale': { value: null },
          'screenPosition': { value: null }
        },
        vertexShader: /* glsl */`
          precision highp float;
          uniform vec3 screenPosition;
          uniform vec2 scale;
          attribute vec3 position;
          attribute vec2 uv;
          varying vec2 vUV;
          void main() {
            vUV = uv;
            gl_Position = vec4( position.xy * scale + screenPosition.xy, screenPosition.z, 1.0 );
          }`,
        fragmentShader: /* glsl */`
          precision highp float;
          uniform sampler2D map;
          varying vec2 vUV;
          void main() {
            gl_FragColor = texture2D( map, vUV );
          }`,
        depthTest: false,
        depthWrite: false,
        transparent: false
      });

      // the following object is used for occlusionMap generation
      const mesh1 = new THREE.Mesh(geometry, material1a);

      this.elements = []; // Exposed for updates
      const shader = LensflareElement.Shader;

      const material2 = new THREE.RawShaderMaterial({
        name: shader.name,
        uniforms: {
          'map': { value: null },
          'occlusionMap': { value: occlusionMap },
          'color': { value: new THREE.Color(0xffffff) },
          'scale': { value: new THREE.Vector2() },
          'screenPosition': { value: new THREE.Vector3() }
        },
        vertexShader: shader.vertexShader,
        fragmentShader: shader.fragmentShader,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false
      });

      const mesh2 = new THREE.Mesh(geometry, material2);

      this.addElement = function (element) {
        this.elements.push(element);
      };

      const scale = new THREE.Vector2();
      const screenPositionPixels = new THREE.Vector2();
      const validArea = new THREE.Box2();
      const viewport = new THREE.Vector4();

      this.onBeforeRender = function (renderer, scene, camera) {
        renderer.getCurrentViewport(viewport);

        const renderTarget = renderer.getRenderTarget();
        const type = (renderTarget !== null) ? renderTarget.texture.type : THREE.UnsignedByteType;

        if (currentType !== type) {
          tempMap.dispose();
          occlusionMap.dispose();
          tempMap.type = occlusionMap.type = type;
          currentType = type;
        }

        const invAspect = viewport.w / viewport.z;
        const halfViewportWidth = viewport.z / 2.0;
        const halfViewportHeight = viewport.w / 2.0;

        let size = 16 / viewport.w;
        scale.set(size * invAspect, size);

        validArea.min.set(viewport.x, viewport.y);
        validArea.max.set(viewport.x + (viewport.z - 16), viewport.y + (viewport.w - 16));

        // calculate position in screen space
        positionView.setFromMatrixPosition(this.matrixWorld);
        positionView.applyMatrix4(camera.matrixWorldInverse);

        if (positionView.z > 0) return; // lensflare is behind the camera

        positionScreen.copy(positionView).applyMatrix4(camera.projectionMatrix);

        // horizontal and vertical coordinate of the lower left corner of the pixels to copy
        screenPositionPixels.x = viewport.x + (positionScreen.x * halfViewportWidth) + halfViewportWidth - 8;
        screenPositionPixels.y = viewport.y + (positionScreen.y * halfViewportHeight) + halfViewportHeight - 8;

        // screen cull
        if (validArea.containsPoint(screenPositionPixels)) {
          // save current RGB to temp texture
          renderer.copyFramebufferToTexture(tempMap, screenPositionPixels);

          // render pink quad
          let uniforms = material1a.uniforms;
          uniforms['scale'].value = scale;
          uniforms['screenPosition'].value = positionScreen;
          renderer.renderBufferDirect(camera, null, geometry, material1a, mesh1, null);

          // copy result to occlusionMap
          renderer.copyFramebufferToTexture(occlusionMap, screenPositionPixels);

          // restore graphics
          uniforms = material1b.uniforms;
          uniforms['scale'].value = scale;
          uniforms['screenPosition'].value = positionScreen;
          renderer.renderBufferDirect(camera, null, geometry, material1b, mesh1, null);

          // render elements
          const vecX = - positionScreen.x * 2;
          const vecY = - positionScreen.y * 2;

          for (let i = 0, l = this.elements.length; i < l; i++) {
            const element = this.elements[i];
            const uniforms = material2.uniforms;

            uniforms['color'].value.copy(element.color);
            uniforms['map'].value = element.texture;
            uniforms['screenPosition'].value.x = positionScreen.x + vecX * element.distance;
            uniforms['screenPosition'].value.y = positionScreen.y + vecY * element.distance;

            size = element.size / viewport.w;
            const invAspect = viewport.w / viewport.z;

            uniforms['scale'].value.set(size * invAspect, size);
            material2.uniformsNeedUpdate = true;
            renderer.renderBufferDirect(camera, null, geometry, material2, mesh2, null);
          }
        }
      };

      this.dispose = function () {
        material1a.dispose();
        material1b.dispose();
        material2.dispose();
        tempMap.dispose();
        occlusionMap.dispose();
        for (let i = 0, l = this.elements.length; i < l; i++) {
          this.elements[i].texture.dispose();
        }
      };
    }
  }

  Lensflare.Geometry = (function () {
    const geometry = new THREE.BufferGeometry();
    const float32Array = new Float32Array([
      - 1, - 1, 0, 0, 0,
      1, - 1, 0, 1, 0,
      1, 1, 0, 1, 1,
      - 1, 1, 0, 0, 1
    ]);
    const interleavedBuffer = new THREE.InterleavedBuffer(float32Array, 5);
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(interleavedBuffer, 3, 0, false));
    geometry.setAttribute('uv', new THREE.InterleavedBufferAttribute(interleavedBuffer, 2, 3, false));
    return geometry;
  })();

  return { Lensflare, LensflareElement };
}

// --- Lensflare Effect Implementation ---

export class LensflareEffect extends EffectBase {
  constructor() {
    super('lensflare', RenderLayers.SURFACE_EFFECTS, 'medium');
    
    this.priority = 100; // Render on top of other surface effects
    this.alwaysRender = false;

    // Stores for flares
    // Map<string (lightId), THREE.Object3D (Lensflare)>
    this.flares = new Map();
    
    // Classes (lazy loaded in initialize)
    this.Lensflare = null;
    this.LensflareElement = null;

    // Textures
    this.flareTexture0 = null;
    this.flareTexture1 = null;

    this.params = {
      enabled: false,
      intensity: 0.7,
      sizeScale: 2.5,
      colorTint: { r: 1, g: 1, b: 1 }
    };
  }

  /**
   * Ensure external managers (GraphicsSettingsManager, UI toggles) can
   * immediately hide/show already-created flare meshes.
   *
   * Important: When an effect is disabled at the composer level, update()
   * no longer runs. Without this hook, flares that were previously visible
   * can remain visible indefinitely.
   *
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    const next = enabled === true;
    this.enabled = next;
    if (this.params && typeof this.params.enabled === 'boolean') {
      this.params.enabled = next;
    }

    for (const flare of this.flares.values()) {
      flare.visible = next;
    }
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: false,
      groups: [
        {
          name: 'lensflare',
          label: 'Lensflare Settings',
          type: 'inline',
          parameters: ['intensity', 'sizeScale', 'colorTint']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },
        intensity: { type: 'slider', min: 0, max: 2, step: 0.1, default: 0.7 },
        sizeScale: { type: 'slider', min: 0.1, max: 3.0, step: 0.1, default: 2.5 },
        colorTint: { type: 'color', default: { r: 1, g: 1, b: 1 } }
      },
      presets: {
        'Subtle': { intensity: 0.5, sizeScale: 0.8 },
        'Cinematic': { intensity: 1.2, sizeScale: 1.2 },
        'Blinding': { intensity: 2.0, sizeScale: 2.0 }
      }
    };
  }

  /**
   * Initialize the effect
   */
  initialize(renderer, scene, camera) {
    log.info('Initializing LensflareEffect');
    
    // Store scene for lazy updates
    this.scene = scene;

    // Load classes
    const classes = getLensflareClasses();
    this.Lensflare = classes.Lensflare;
    this.LensflareElement = classes.LensflareElement;

    // Create textures
    this.createFlareTextures();

    // Scan initial lights
    this.syncAllLights(scene);

    // Register hooks
    this.hookIdCreate = Hooks.on('createAmbientLight', (doc) => this.onLightCreated(doc));
    this.hookIdUpdate = Hooks.on('updateAmbientLight', (doc, changes) => this.onLightUpdated(doc, changes));
    this.hookIdDelete = Hooks.on('deleteAmbientLight', (doc) => this.onLightDeleted(doc));
    
    // Also listen to PointSource updates if possible, but AmbientLight document hooks are safer
    // We might also want to support Token lights?
    // For now, let's stick to AmbientLights (placed lights).
  }

  createFlareTextures() {
    const textureLoader = new window.THREE.TextureLoader();
    
    // Procedural texture generation via Canvas
    const createFlareTexture = (type) => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      const cx = 64;
      const cy = 64;

      if (type === 'glow') {
        const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, 64);
        grd.addColorStop(0, 'rgba(255, 255, 255, 1)');
        grd.addColorStop(0.2, 'rgba(255, 255, 255, 0.8)');
        grd.addColorStop(0.5, 'rgba(255, 255, 255, 0.2)');
        grd.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, 128, 128);
      } else if (type === 'ring') {
        const grd = ctx.createRadialGradient(cx, cy, 30, cx, cy, 60);
        grd.addColorStop(0, 'rgba(255, 255, 255, 0)');
        grd.addColorStop(0.5, 'rgba(255, 255, 255, 0.3)');
        grd.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, 128, 128);
      }

      const texture = new window.THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      return texture;
    };

    this.flareTexture0 = createFlareTexture('glow');
    this.flareTexture1 = createFlareTexture('ring');
  }

  syncAllLights(scene) {
    if (!canvas.lighting) return;
    
    // Clear existing
    this.clearFlares(scene);

    // Find all ambient lights
    const lights = canvas.lighting.placeables;
    lights.forEach(light => {
      this.createFlare(light.document, scene);
    });
  }

  createFlare(doc, scene) {
    if (this.flares.has(doc.id)) return;
    
    // Parse config
    const config = doc.config;
    if (!config) return;

    // Attenuation: soft, diffuse lights should have weaker flares, but not be completely ignored.
    // Default attenuation is 0.5. We no longer hard-skip high-attenuation lights; instead we
    // fold attenuation into the intensity calculation with a softer factor.
    const attenuation = config.attenuation ?? 0.5;

    // Skip if no radius
    const dim = config.dim || 0;
    const bright = config.bright || 0;
    if (dim === 0 && bright === 0) return;
    
    // Calculate base intensity from light properties
    // Bright lights trigger stronger flares than dim lights
    const maxRadius = Math.max(dim, bright);
    const brightness = (bright / (maxRadius || 1)) * 0.8 + (dim / (maxRadius || 1)) * 0.2;
    const alpha = config.alpha ?? 0.5;
    const luminosity = config.luminosity ?? 0.8;
    
    // Combined intensity factor
    // Luminosity boosts stronger lights; attenuation still dampens soft, diffuse lights but
    // does not zero them out completely. High-attenuation lights can still produce subtle flares.
    const attenuationFactor = Math.max(0.1, 1.0 - attenuation * 0.7);
    const flareIntensity = brightness * alpha * (0.5 + luminosity * 0.5) * attenuationFactor;
    
    // Skip very weak lights
    if (flareIntensity < 0.05) return;

    // Foundry stores color as a number (0xRRGGBB) or null.
    // - If null, treat as a neutral warm white.
    // - If present, decode the hex manually into normalized RGB to ensure
    //   distinct hues (e.g. red, green, blue) are preserved.
    const rawColor = (config.color === null || config.color === undefined)
      ? 0xfff2e0
      : config.color;
    const r = ((rawColor >> 16) & 0xff) / 255;
    const g = ((rawColor >> 8) & 0xff) / 255;
    const b = (rawColor & 0xff) / 255;
    const lightColor = new window.THREE.Color(r, g, b);
    
    const lensflare = new this.Lensflare();
    
    // 1. Central Glow (hot core, strongly tinted by light color)
    // Keep most of the light's hue, only slightly mixed with white for a bright center
    const coreColor = lightColor.clone().lerp(new window.THREE.Color(0xffffff), 0.15);
    lensflare.addElement(new this.LensflareElement(
      this.flareTexture0, 
      500 * flareIntensity, // Scale size by intensity 
      0, 
      coreColor
    ));
    
    // 2. Secondary Flares (Artifacts) - These take the light's color strongly
    // Ring
    lensflare.addElement(new this.LensflareElement(
      this.flareTexture1, 
      400 * flareIntensity, 
      0.6, 
      lightColor.clone() // Keep full color for the ring
    ));

    // Small artifacts
    lensflare.addElement(new this.LensflareElement(
      this.flareTexture0, 
      60 * flareIntensity, 
      0.7, 
      lightColor
    ));
    
    lensflare.addElement(new this.LensflareElement(
      this.flareTexture0, 
      100 * flareIntensity, 
      0.9, 
      lightColor.clone().lerp(new window.THREE.Color(0x88ccff), 0.3) // Slight blue anamorphic hint
    ));
    
    lensflare.addElement(new this.LensflareElement(
      this.flareTexture0, 
      70 * flareIntensity, 
      1.0, 
      lightColor
    ));

    // Position
    // Convert Foundry (top-left, Y-down) coords to world (Y-up) using Coordinates utility
    // Then elevate slightly to avoid z-fighting with the ground.
    const worldPos = Coordinates.toWorld(doc.x, doc.y);
    const d = canvas?.dimensions;
    const grid = canvas?.grid;
    const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0) ? grid.sizeX : null;
    const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0) ? grid.sizeY : null;
    const pxPerGrid = (gridSizeX && gridSizeY)
      ? (0.5 * (gridSizeX + gridSizeY))
      : (d?.size ?? 100);
    const distPerGrid = (d && typeof d.distance === 'number' && d.distance > 0) ? d.distance : 1;
    const pxPerUnit = pxPerGrid / distPerGrid;
    lensflare.position.set(
      worldPos.x,
      worldPos.y,
      (doc.elevation || 0) * pxPerUnit + 50
    );

    scene.add(lensflare);
    this.flares.set(doc.id, lensflare);
    
    log.debug(`Created lensflare for light ${doc.id} (intensity: ${flareIntensity.toFixed(2)})`);
  }

  removeFlare(id, scene) {
    const flare = this.flares.get(id);
    if (flare) {
      scene.remove(flare);
      flare.dispose();
      this.flares.delete(id);
      log.debug(`Removed lensflare for light ${id}`);
    }
  }

  clearFlares(scene) {
    for (const [id, flare] of this.flares) {
      scene.remove(flare);
      flare.dispose();
    }
    this.flares.clear();
  }

  _mergeLightDocChanges(doc, changes) {
    if (!doc || !changes || typeof changes !== 'object') return doc;

    let base;
    try {
      base = (typeof doc.toObject === 'function') ? doc.toObject() : doc;
    } catch (_) {
      base = doc;
    }

    let expandedChanges = changes;
    try {
      const hasDotKeys = Object.keys(changes).some((k) => k.includes('.'));
      if (hasDotKeys && foundry?.utils?.expandObject) {
        expandedChanges = foundry.utils.expandObject(changes);
      }
    } catch (_) {
      expandedChanges = changes;
    }

    try {
      if (foundry?.utils?.mergeObject) {
        return foundry.utils.mergeObject(base, expandedChanges, {
          inplace: false,
          overwrite: true,
          recursive: true,
          insertKeys: true,
          insertValues: true
        });
      }
    } catch (_) {
    }

    const merged = { ...base, ...expandedChanges };
    if (base?.config || expandedChanges?.config) {
      merged.config = { ...(base?.config ?? {}), ...(expandedChanges?.config ?? {}) };
    }
    return merged;
  }

  onLightCreated(doc) {
    // We need to wait for the scene object to be available via EffectComposer or passed in update?
    // Hooks are global. EffectBase doesn't store scene permanently unless we save it in initialize.
    // But initialize is called once.
    // We should probably check if we have access to the scene.
    // EffectBase doesn't automatically store 'scene'.
    // We can store it in initialize, but we need to be careful about lifecycle.
    // Actually, update(timeInfo) doesn't pass scene. render(renderer, scene) does.
    
    // Let's just grab the scene from the first flare's parent or store it in initialize.
    // For now, assume 'this.scene' is stored in initialize.
    if (this.scene) {
      this.createFlare(doc, this.scene);
    }
  }

  onLightUpdated(doc, changes) {
    const targetDoc = this._mergeLightDocChanges(doc, changes);
    const flare = this.flares.get(targetDoc.id);
    if (!flare) {
      // Maybe it became valid?
      if (this.scene) this.createFlare(targetDoc, this.scene);
      return;
    }

    if ('x' in changes || 'y' in changes || 'elevation' in changes) {
      const worldPos = Coordinates.toWorld(targetDoc.x, targetDoc.y);
      const d = canvas?.dimensions;
      const grid = canvas?.grid;
      const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0) ? grid.sizeX : null;
      const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0) ? grid.sizeY : null;
      const pxPerGrid = (gridSizeX && gridSizeY)
        ? (0.5 * (gridSizeX + gridSizeY))
        : (d?.size ?? 100);
      const distPerGrid = (d && typeof d.distance === 'number' && d.distance > 0) ? d.distance : 1;
      const pxPerUnit = pxPerGrid / distPerGrid;
      flare.position.set(
        worldPos.x,
        worldPos.y,
        (targetDoc.elevation || 0) * pxPerUnit + 50
      );
    }
    
    if ('config' in changes) {
      // Color update or radius update - easier to recreate
      if (this.scene) {
        this.removeFlare(targetDoc.id, this.scene);
        this.createFlare(targetDoc, this.scene);
      }
    }
  }

  onLightDeleted(doc) {
    if (this.scene) {
      this.removeFlare(doc.id, this.scene);
    }
  }

  /**
   * Update parameters
   */
  update(timeInfo) {
    // Update global parameters on flares
    const p = this.params;

    // Respect the UI-driven params.enabled flag to hide/show all flares
    if (!p.enabled) {
      for (const flare of this.flares.values()) {
        flare.visible = false;
      }
      return;
    }
    const tint = new window.THREE.Color(p.colorTint.r, p.colorTint.g, p.colorTint.b);

    for (const flare of this.flares.values()) {
      flare.visible = true;
      
      // Update elements based on global params
      if (flare.elements) {
        for (const element of flare.elements) {
          // Update Size
          if (element.baseSize) {
            element.size = element.baseSize * p.sizeScale;
          }
          
          // Update Color (Base * Intensity * Tint)
          if (element.baseColor) {
            element.color.copy(element.baseColor)
              .multiplyScalar(p.intensity)
              .multiply(tint);
          }
        }
      }
    }
  }
  

  dispose() {
    Hooks.off('createAmbientLight', this.hookIdCreate);
    Hooks.off('updateAmbientLight', this.hookIdUpdate);
    Hooks.off('deleteAmbientLight', this.hookIdDelete);
    
    if (this.scene) {
      this.clearFlares(this.scene);
    }
    
    if (this.flareTexture0) this.flareTexture0.dispose();
    if (this.flareTexture1) this.flareTexture1.dispose();
    
    this.scene = null;
  }
}
