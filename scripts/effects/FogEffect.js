/**
 * @fileoverview Fog of War Effect
 * 
 * Composites Foundry's native vision mask and exploration mask over the Three.js scene.
 * 
 * This effect uses FoundryFogBridge to extract Foundry's existing PIXI textures
 * (canvas.masks.vision.renderTexture and canvas.fog.sprite.texture) and convert
 * them to Three.js textures. This approach:
 * - Eliminates custom vision polygon computation
 * - Ensures perfect sync with Foundry's native fog behavior
 * - Leverages Foundry's existing save/load persistence
 * 
 * @module effects/FogEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { FoundryFogBridge } from '../vision/FoundryFogBridge.js';

const log = createLogger('FogEffect');

export class FogEffect extends EffectBase {
  constructor() {
    super('fog', RenderLayers.POST_PROCESSING, 'low');
    
    // High priority - fog should apply after lighting but before bloom
    // Foundry applies Fog *after* lighting (Lighting is hidden by Fog)
    this.priority = 10;
    
    this.params = {
      enabled: true,
      unexploredColor: '#000000',
      exploredColor: '#000000',
      exploredOpacity: 0.5,
      softness: 0.1
    };

    // Bridge to Foundry's native fog system
    this.fogBridge = null;
    
    this.material = null;
    this.quadScene = null;
    this.quadCamera = null;

    // Post-processing integration state
    this.readBuffer = null;
    this.writeBuffer = null;
    this.renderToScreen = false;
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'fog',
          label: 'Fog of War',
          type: 'inline',
          parameters: ['unexploredColor', 'exploredColor', 'exploredOpacity', 'softness']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        unexploredColor: { type: 'color', default: '#000000', label: 'Unexplored' },
        exploredColor: { type: 'color', default: '#000000', label: 'Explored Tint' },
        exploredOpacity: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5, label: 'Explored Opacity' },
        softness: { type: 'slider', min: 0, max: 10, step: 0.1, default: 2.0, label: 'Softness' }
      }
    };
  }

  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    const THREE = window.THREE;

    // Initialize the Foundry fog bridge
    this.fogBridge = new FoundryFogBridge(renderer);
    this.fogBridge.initialize();

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },   // The scene so far
        tVision: { value: null },    // Real-time Vision from Foundry (White = Visible)
        tExplored: { value: null },  // Persistent Exploration from Foundry (White = Visited)
        uUnexploredColor: { value: new THREE.Color(0x000000) },
        uExploredColor: { value: new THREE.Color(0x000000) },
        uExploredOpacity: { value: 0.5 },
        uBypassFog: { value: 0.0 },
        // Camera view bounds in world space for texture sampling
        uViewBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        // Full canvas dimensions (including padding)
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        // Scene rect bounds (actual map area, excluding padding)
        uSceneRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        // Fog sprite position and size (for exploration texture mapping)
        uFogSpriteRect: { value: new THREE.Vector4(0, 0, 1, 1) }
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
        uniform sampler2D tVision;
        uniform sampler2D tExplored;
        
        uniform vec3 uUnexploredColor;
        uniform vec3 uExploredColor;
        uniform float uExploredOpacity;
        uniform float uBypassFog;
        
        // Camera view bounds in Three.js world space: (minX, minY, maxX, maxY)
        // Three.js: Y-up, origin at bottom-left
        uniform vec4 uViewBounds;
        // Full canvas dimensions (Foundry world space)
        uniform vec2 uSceneDimensions;
        // Scene rect bounds: (x, y, width, height) in Foundry coords
        uniform vec4 uSceneRect;
        // Fog sprite rect: (x, y, width, height) in Foundry coords
        uniform vec4 uFogSpriteRect;

        varying vec2 vUv;

        void main() {
          vec4 sceneColor = texture2D(tDiffuse, vUv);
          
          if (uBypassFog > 0.5) {
            gl_FragColor = sceneColor;
            return;
          }
          
          // VISION TEXTURE: Rendered at screen resolution, covers current viewport
          // Foundry's vision mask is rendered to screen-sized texture
          // PIXI has (0,0) at top-left, Three.js has (0,0) at bottom-left
          // So we need to flip Y for the vision texture sampling
          vec2 visionUv = vec2(vUv.x, 1.0 - vUv.y);
          
          // Sample vision mask (current LOS)
          // Foundry uses RED channel for fog data
          float vision = texture2D(tVision, visionUv).r;
          
          // EXPLORATION TEXTURE: Covers the scene rect (not screen)
          // Need to convert screen UV -> world position -> exploration UV
          
          // Convert screen UV to Three.js world position
          // vUv (0,0) = bottom-left of screen, (1,1) = top-right (Three.js convention)
          // uViewBounds = (minX, minY, maxX, maxY) in Three.js coords (Y-up)
          float threeX = mix(uViewBounds.x, uViewBounds.z, vUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, vUv.y);
          
          // Convert Three.js world coords to Foundry coords
          // Three.js: (0,0) at bottom-left, Y-up
          // Foundry: (0,0) at top-left, Y-down
          // Conversion: foundryX = threeX, foundryY = sceneHeight - threeY
          float foundryX = threeX;
          float foundryY = uSceneDimensions.y - threeY;
          
          // Check if we're outside the actual scene rect (in padded region)
          float sceneMinX = uSceneRect.x;
          float sceneMinY = uSceneRect.y;
          float sceneMaxX = uSceneRect.x + uSceneRect.z;
          float sceneMaxY = uSceneRect.y + uSceneRect.w;
          
          bool outsideBounds = foundryX < sceneMinX || foundryX > sceneMaxX || 
                               foundryY < sceneMinY || foundryY > sceneMaxY;
          
          // Convert Foundry position to exploration texture UV
          // Exploration sprite is positioned at sceneRect in Foundry coords (Y-down).
          // The underlying PIXI texture, when sampled via Three.js, ends up vertically
          // inverted relative to our world-space mapping, so we explicitly flip the
          // local Y here to keep the explored fog pinned to world space.
          float localY = (foundryY - uFogSpriteRect.y) / uFogSpriteRect.w;
          vec2 exploredUv = vec2(
            (foundryX - uFogSpriteRect.x) / uFogSpriteRect.z,
            1.0 - localY
          );
          
          // Sample exploration mask (previously seen)
          float explored = texture2D(tExplored, exploredUv).r;
          
          // Fog of War Logic:
          // 1. Currently Visible (vision > threshold) -> Show Scene fully
          // 2. Previously Explored but not visible -> Show Scene dimmed
          // 3. Never Explored -> Show Unexplored Color (Black)

          vec3 finalColor;

          if (vision > 0.1) {
             // Currently visible - full brightness
             finalColor = sceneColor.rgb;
          } else if (explored > 0.1 && !outsideBounds) {
             // Previously explored but not currently visible - dim the scene
             vec3 dimmedScene = mix(sceneColor.rgb, uExploredColor, uExploredOpacity);
             finalColor = dimmedScene;
          } else {
             // Never explored or outside bounds - complete darkness
             finalColor = uUnexploredColor;
          }

          gl_FragColor = vec4(finalColor, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quadScene.add(quad);
    
    log.info('FogEffect initialized with FoundryFogBridge');
  }

  /**
   * Set input/output buffers from EffectComposer
   */
  setBuffers(readBuffer, writeBuffer) {
    this.readBuffer = readBuffer;
    this.writeBuffer = writeBuffer;
  }

  /**
   * Set input texture
   */
  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  update(timeInfo) {
    if (!this.material || !this.fogBridge) return;

    // Sync textures from Foundry every frame
    this.fogBridge.sync();

    // GM convenience: bypass fog when no tokens selected
    // Also check Foundry's native controlled tokens
    try {
      const isGM = game?.user?.isGM;
      
      // Check Foundry's native token control state (most reliable)
      const foundryControlled = canvas?.tokens?.controlled || [];
      let hasControlledTokens = foundryControlled.length > 0;
      
      // Also check MapShine's selection as backup
      if (!hasControlledTokens) {
        try {
          const ms = window.MapShine;
          const interactionManager = ms?.interactionManager;
          const tokenManager = ms?.tokenManager;
          const selection = interactionManager?.selection;

          if (interactionManager && tokenManager && selection && selection.size > 0) {
            for (const id of selection) {
              if (tokenManager.tokenSprites && tokenManager.tokenSprites.has(id)) {
                hasControlledTokens = true;
                break;
              }
            }
          }
        } catch (_) {
          // Ignore MapShine check errors
        }
      }

      // Also check if fog is even enabled for this scene
      const fogEnabled = this.fogBridge.isFogEnabled();
      const bypassFog = !fogEnabled || (isGM && !hasControlledTokens);

      const u = this.material.uniforms;
      u.uBypassFog.value = bypassFog ? 1.0 : 0.0;

      this.enabled = this.params.enabled !== false;
      
      // Debug logging (throttled)
      if (Math.random() < 0.002) {
        log.debug(`Fog state: enabled=${this.enabled}, bypass=${bypassFog}, fogEnabled=${fogEnabled}, isGM=${isGM}, hasTokens=${hasControlledTokens}`);
      }
    } catch (_) {
      // On failure, keep current state
    }

    if (!this.enabled) return;

    // Update uniforms
    const u = this.material.uniforms;
    u.uUnexploredColor.value.set(this.params.unexploredColor);
    u.uExploredColor.value.set(this.params.exploredColor);
    u.uExploredOpacity.value = this.params.exploredOpacity;
    
    // Bind Foundry's textures
    u.tVision.value = this.fogBridge.getVisionTexture();
    u.tExplored.value = this.fogBridge.getExploredTexture();
    
    // Update scene dimensions
    const dims = this.fogBridge.getSceneDimensions();
    u.uSceneDimensions.value.set(dims.width, dims.height);
    
    // Update scene rect
    const rect = this.fogBridge.getSceneRect();
    u.uSceneRect.value.set(rect.x, rect.y, rect.width, rect.height);
    
    // Update fog sprite rect (exploration texture position/size)
    this._updateFogSpriteRect(u);
    
    // Debug logging (throttled)
    if (Math.random() < 0.002) {
      log.debug(`SceneDims: ${dims.width}x${dims.height}, SceneRect: (${rect.x}, ${rect.y}, ${rect.width}, ${rect.height})`);
    }
  }

  /**
   * Update the fog sprite rect uniform from Foundry's fog sprite
   * @private
   */
  _updateFogSpriteRect(uniforms) {
    try {
      // The exploration texture is positioned at the sceneRect, not at the sprite's
      // display position. Use canvas.dimensions.sceneRect for correct world mapping.
      const sceneRect = canvas?.dimensions?.sceneRect;
      if (sceneRect) {
        const x = sceneRect.x;
        const y = sceneRect.y;
        const w = sceneRect.width;
        const h = sceneRect.height;
        uniforms.uFogSpriteRect.value.set(x, y, w, h);
        
        // Debug logging (throttled)
        if (Math.random() < 0.002) {
          log.debug(`FogSpriteRect (from sceneRect): x=${x}, y=${y}, w=${w}, h=${h}`);
        }
      } else {
        // Fallback to scene dimensions
        const dims = this.fogBridge.getSceneDimensions();
        uniforms.uFogSpriteRect.value.set(0, 0, dims.width, dims.height);
      }
    } catch (_) {
      // Keep existing values
    }
  }

  /**
   * Render pass
   */
  render(renderer, scene, camera) {
    if (!this.enabled) return;

    const inputTexture = this.readBuffer ? this.readBuffer.texture : this.material.uniforms.tDiffuse.value;

    // Guard: pass through if resources missing
    if (!inputTexture) {
      return;
    }

    // Set render target
    if (this.writeBuffer) {
      renderer.setRenderTarget(this.writeBuffer);
      renderer.clear();
    } else {
      renderer.setRenderTarget(null);
    }

    // Update view bounds from camera
    if (camera) {
      this.updateViewBounds(camera);
    }

    // Bind uniforms
    this.material.uniforms.tDiffuse.value = inputTexture;

    // Render quad
    renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Update view bounds uniform from the Three.js camera
   * Outputs bounds in Three.js world space (Y-up, origin at bottom-left)
   */
  updateViewBounds(camera) {
    const u = this.material.uniforms;

    const sceneWidth = canvas?.dimensions?.width || 1;
    const sceneHeight = canvas?.dimensions?.height || 1;

    if (!camera) {
      // Default: full scene in Three.js coords
      u.uViewBounds.value.set(0, 0, sceneWidth, sceneHeight);
      return;
    }

    const camPos = camera.position;

    if (camera.isPerspectiveCamera) {
      const distance = camPos.z;
      const vFov = camera.fov * Math.PI / 180.0;
      const visibleHeight = 2 * Math.tan(vFov / 2) * distance;
      const visibleWidth = visibleHeight * camera.aspect;

      // Camera position is already in Three.js world space
      const minX = camPos.x - visibleWidth / 2;
      const maxX = camPos.x + visibleWidth / 2;
      const minY = camPos.y - visibleHeight / 2;
      const maxY = camPos.y + visibleHeight / 2;

      u.uViewBounds.value.set(minX, minY, maxX, maxY);
    } else if (camera.isOrthographicCamera) {
      // Orthographic camera: left/right/top/bottom define the view frustum
      // These are already in world units, just need to apply zoom and offset by camera position
      const minX = camPos.x + camera.left / camera.zoom;
      const maxX = camPos.x + camera.right / camera.zoom;
      const minY = camPos.y + camera.bottom / camera.zoom;
      const maxY = camPos.y + camera.top / camera.zoom;

      u.uViewBounds.value.set(minX, minY, maxX, maxY);
      
      // Debug logging (throttled) - more detailed for debugging drift
      if (Math.random() < 0.005) {
        const vb = u.uViewBounds.value;
        const sd = u.uSceneDimensions.value;
        const sr = u.uSceneRect.value;
        const fsr = u.uFogSpriteRect.value;
        log.debug(`FOG DEBUG:
  ViewBounds: (${vb.x.toFixed(0)}, ${vb.y.toFixed(0)}) to (${vb.z.toFixed(0)}, ${vb.w.toFixed(0)})
  SceneDims: ${sd.x.toFixed(0)}x${sd.y.toFixed(0)}
  SceneRect: (${sr.x.toFixed(0)}, ${sr.y.toFixed(0)}, ${sr.z.toFixed(0)}, ${sr.w.toFixed(0)})
  FogSpriteRect: (${fsr.x.toFixed(0)}, ${fsr.y.toFixed(0)}, ${fsr.z.toFixed(0)}, ${fsr.w.toFixed(0)})
  CamPos: (${camPos.x.toFixed(0)}, ${camPos.y.toFixed(0)}), zoom: ${camera.zoom.toFixed(2)}`);
      }
    } else {
      u.uViewBounds.value.set(0, 0, sceneWidth, sceneHeight);
    }
  }

  /**
   * Helper to pass input to output without applying fog
   */
  passThrough(renderer, inputTexture) {
    const oldBypass = this.material.uniforms.uBypassFog.value;
    this.material.uniforms.uBypassFog.value = 1.0;
    this.material.uniforms.tDiffuse.value = inputTexture;

    if (this.writeBuffer) {
      renderer.setRenderTarget(this.writeBuffer);
      renderer.clear();
    } else {
      renderer.setRenderTarget(null);
    }

    renderer.render(this.quadScene, this.quadCamera);
    this.material.uniforms.uBypassFog.value = oldBypass;
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this.fogBridge) {
      this.fogBridge.dispose();
      this.fogBridge = null;
    }
    super.dispose();
  }
}
