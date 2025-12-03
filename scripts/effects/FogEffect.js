/**
 * @fileoverview Fog of War Effect
 * Composites the real-time vision mask and persistent exploration mask over the scene.
 * @module effects/FogEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('FogEffect');

export class FogEffect extends EffectBase {
  constructor() {
    super('fog', RenderLayers.POST_PROCESSING, 'low');
    
    this.priority = 10; // High priority, apply after lighting but before bloom? 
    // Actually, Fog usually occludes lighting. But we might want glow to show through?
    // Foundry applies Fog *after* lighting (Lighting is hidden by Fog).
    // So RenderLayers.POST_PROCESSING is appropriate, likely effectively last or near last.
    
    this.params = {
      enabled: true,
      unexploredColor: '#000000',
      exploredColor: '#000000', // Usually black but transparent? No, usually dark.
      exploredOpacity: 0.5, // How much to dim the explored area
      softness: 0.1
    };

    this.visionTexture = null;
    this.exploredTexture = null;
    
    this.material = null;
    this.quadScene = null;
    this.quadCamera = null;

    // Post-processing integration state
    this.readBuffer = null;   // Input render target from EffectComposer
    this.writeBuffer = null;  // Output render target (or null for screen)
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
          parameters: ['unexploredColor', 'exploredColor', 'exploredOpacity']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        unexploredColor: { type: 'color', default: '#000000', label: 'Unexplored' },
        exploredColor: { type: 'color', default: '#000000', label: 'Explored Tint' },
        exploredOpacity: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5, label: 'Explored Opacity' }
      }
    };
  }

  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    const THREE = window.THREE;

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },   // The scene so far
        tVision: { value: null },    // Real-time Vision (White = Visible)
        tExplored: { value: null },  // Persistent Exploration (Red/Alpha = Visited)
        uUnexploredColor: { value: new THREE.Color(0x000000) },
        uExploredColor: { value: new THREE.Color(0x000000) },
        uExploredOpacity: { value: 0.6 },
        uSoftness: { value: 0.1 }, // Not used yet, blur handled elsewhere?
        uBypassFog: { value: 0.0 },
        // Camera view bounds in world space for vision texture sampling
        // vec4(minX, minY, maxX, maxY) in world coordinates
        uViewBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        // Full canvas dimensions (including padding)
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        // Scene rect bounds (actual map area, excluding padding)
        // vec4(x, y, width, height) in world coordinates
        uSceneRect: { value: new THREE.Vector4(0, 0, 1, 1) }
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
        
        // Camera view bounds: (minX, minY, maxX, maxY) in world space
        uniform vec4 uViewBounds;
        // Full canvas dimensions: (width, height) in world space
        uniform vec2 uSceneDimensions;
        // Scene rect bounds: (x, y, width, height) - the actual map area excluding padding
        uniform vec4 uSceneRect;

        varying vec2 vUv;

        void main() {
          vec4 sceneColor = texture2D(tDiffuse, vUv);
          if (uBypassFog > 0.5) {
            gl_FragColor = sceneColor;
            return;
          }
          
          // Convert screen UV to world position
          // Screen UV (0,0) = bottom-left of view, (1,1) = top-right of view
          // View bounds define the world-space rectangle being viewed
          float worldX = mix(uViewBounds.x, uViewBounds.z, vUv.x);
          float worldY = mix(uViewBounds.y, uViewBounds.w, vUv.y);
          
          // Convert world position to vision texture UV
          // 
          // Main scene camera: Position at (width/2, height/2, z), Y-up
          // worldX/worldY from view bounds are in this coordinate system
          // 
          // VisionManager camera: Centered orthographic at (0,0,10)
          //   - left=-width/2, right=+width/2, bottom=-height/2, top=+height/2
          // 
          // GeometryConverter transforms Foundry coords to centered Three.js coords:
          //   threeX = foundryX - width/2
          //   threeY = -(foundryY - height/2) = height/2 - foundryY
          // 
          // So for a token at Foundry (fx, fy):
          //   Three.js position = (fx - width/2, height/2 - fy)
          //   Vision texture UV = ((fx - width/2 + width/2) / width, (height/2 - fy + height/2) / height)
          //                     = (fx / width, (height - fy) / height)
          // 
          // The main camera worldY is in Y-up coords where worldY=0 is bottom, worldY=height is top
          // But Foundry Y=0 is top, Y=height is bottom
          // So: foundryY = height - worldY
          // 
          // Therefore: visionUv = (worldX / width, worldY / height)
          // (No flip needed because the GeometryConverter already flipped Y when creating the mesh)
          vec2 visionUv = vec2(worldX / uSceneDimensions.x, worldY / uSceneDimensions.y);
          
          // Check if we're outside the actual scene rect (in the padded region)
          // Scene rect is (x, y, width, height) in world coordinates
          // We need to check if worldX/worldY falls within the scene rect
          float sceneMinX = uSceneRect.x;
          float sceneMinY = uSceneRect.y;
          float sceneMaxX = uSceneRect.x + uSceneRect.z;
          float sceneMaxY = uSceneRect.y + uSceneRect.w;
          
          // Note: worldY is in Y-up coordinates, but sceneRect is in Foundry Y-down
          // We need to convert: foundryY = sceneHeight - worldY (approximately)
          // Actually, the scene rect is already in the same coordinate system as worldX/worldY
          // since both come from Foundry's canvas.dimensions
          bool outsideBounds = worldX < sceneMinX || worldX > sceneMaxX || 
                               worldY < sceneMinY || worldY > sceneMaxY;
          
          if (outsideBounds) {
            // Outside scene rect (in padded region) - show unexplored color (black)
            gl_FragColor = vec4(uUnexploredColor, 1.0);
            return;
          }
          
          // Sample vision mask (current LOS) and exploration mask (previously seen)
          float vision = texture2D(tVision, visionUv).r;
          float explored = texture2D(tExplored, visionUv).r;
          
          // Fog of War Logic:
          // 1. Currently Visible (vision > threshold) -> Show Scene fully
          // 2. Previously Explored but not visible -> Show Scene dimmed (exploredOpacity)
          // 3. Never Explored -> Show Unexplored Color (Black)

          vec3 finalColor;

          if (vision > 0.1) {
             // Currently visible - full brightness
             finalColor = sceneColor.rgb;
          } else if (explored > 0.1) {
             // Previously explored but not currently visible - dim the scene
             // Mix between scene color and explored tint based on exploredOpacity
             vec3 dimmedScene = mix(sceneColor.rgb, uExploredColor, uExploredOpacity);
             finalColor = dimmedScene;
          } else {
             // Never explored - complete darkness
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
  }

  /**
   * Set the textures from the managers
   * @param {THREE.Texture} vision 
   * @param {THREE.Texture} explored 
   */
  setTextures(vision, explored) {
    this.visionTexture = vision;
    this.exploredTexture = explored;
    if (this.material) {
      this.material.uniforms.tVision.value = vision;
      this.material.uniforms.tExplored.value = explored;
    }
  }

  /**
   * Set input/output buffers from EffectComposer
   * @param {THREE.WebGLRenderTarget} readBuffer 
   * @param {THREE.WebGLRenderTarget} writeBuffer 
   */
  setBuffers(readBuffer, writeBuffer) {
    this.readBuffer = readBuffer;
    this.writeBuffer = writeBuffer;
  }

  /**
   * Set input texture (Alternative to setBuffers for simple effects)
   * @param {THREE.Texture} texture 
   */
  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  update(timeInfo) {
    if (!this.material) return;

    // GM convenience: when a GM has no tokens selected, show the full
    // scene with no fog. When a GM selects a token (via the Three.js
    // interaction manager), re-enable fog so their view is constrained
    // by vision again. Non-GM users always respect fog.
    try {
      const isGM = game?.user?.isGM;

      // Prefer MapShine's own selection state, since the PIXI canvas is
      // visually hidden and Foundry's canvas.tokens.controlled array
      // may not reflect Three.js interaction.
      let hasControlledTokens = false;
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
        // Fallback to Foundry selection if anything goes wrong.
        const controlled = canvas?.tokens?.controlled || [];
        hasControlledTokens = controlled.length > 0;
      }

      const bypassFog = isGM && !hasControlledTokens;

      if (Math.random() < 0.01) {
        log.debug(`Fog Update: isGM=${isGM}, hasControlled=${hasControlledTokens}, bypass=${bypassFog}, enabled=${this.params.enabled}`);
      }

      // Drive shader bypass flag instead of disabling the effect, so
      // the post-processing chain continues to receive valid color.
      const u = this.material.uniforms;
      u.uBypassFog.value = bypassFog ? 1.0 : 0.0;

      // Restore enabled state from params for cases where the user
      // explicitly toggles the fog effect via UI.
      this.enabled = this.params.enabled !== false;
    } catch (_) {
      // On any failure, fall back to respecting the current enabled flag.
    }

    if (!this.enabled) return;

    // Update Uniforms
    const u = this.material.uniforms;
    u.uUnexploredColor.value.set(this.params.unexploredColor);
    u.uExploredColor.value.set(this.params.exploredColor);
    u.uExploredOpacity.value = this.params.exploredOpacity;
    // Sync from Foundry if available (Optional, can override with params)
    if (canvas && canvas.colors) {
       // canvas.colors.fogUnexplored / fogExplored
       // We can choose to sync these if params.autoSync is true, or just let the user tweak.
       // For now, let params drive it.
    }
  }

  /**
   * Render pass
   * NOTE: EffectComposer calls render(renderer, scene, camera).
   * We use the camera to compute view bounds for vision texture sampling.
   * @param {THREE.Renderer} renderer 
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  render(renderer, scene, camera) {
    if (!this.enabled) return;

    const inputTexture = this.readBuffer ? this.readBuffer.texture : this.material.uniforms.tDiffuse.value;

    // Guard: If vital resources are missing, pass through the input to output
    // to prevent breaking the chain (which results in a black screen).
    if (!inputTexture || !this.visionTexture) {
      if (inputTexture) {
        this.passThrough(renderer, inputTexture);
      }
      return;
    }

    // 1. Set Render Target
    if (this.writeBuffer) {
      renderer.setRenderTarget(this.writeBuffer);
      renderer.clear();
    } else {
      renderer.setRenderTarget(null);
    }

    // 2. Compute camera view bounds in world space
    // This allows the shader to transform screen UVs to world-space UVs
    if (camera) {
      this.updateViewBounds(camera);
    }

    // 3. Bind Uniforms
    this.material.uniforms.tDiffuse.value = inputTexture;
    // tVision and tExplored are set via setTextures/update, but ensure they are bound
    if (this.visionTexture) this.material.uniforms.tVision.value = this.visionTexture;
    if (this.exploredTexture) this.material.uniforms.tExplored.value = this.exploredTexture;

    // 4. Render Quad
    renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Update view bounds uniform from camera
   * @param {THREE.Camera} camera - Main scene camera
   */
  updateViewBounds(camera) {
    const u = this.material.uniforms;
    
    // Get scene dimensions (full canvas including padding)
    const sceneWidth = canvas?.dimensions?.width || 1;
    const sceneHeight = canvas?.dimensions?.height || 1;
    u.uSceneDimensions.value.set(sceneWidth, sceneHeight);
    
    // Get scene rect (actual map area, excluding padding)
    // sceneRect is in Foundry Y-down coordinates, but our worldY is in Y-up
    // We need to convert the Y coordinates
    const sceneRect = canvas?.dimensions?.sceneRect;
    if (sceneRect) {
      // Convert from Foundry Y-down to Three.js Y-up coordinates
      // In Foundry: sceneRect.y is distance from top
      // In Three.js: we need distance from bottom
      // sceneMinY (Three.js) = sceneHeight - (sceneRect.y + sceneRect.height)
      // sceneMaxY (Three.js) = sceneHeight - sceneRect.y
      const threeMinY = sceneHeight - (sceneRect.y + sceneRect.height);
      const threeMaxY = sceneHeight - sceneRect.y;
      u.uSceneRect.value.set(sceneRect.x, threeMinY, sceneRect.width, threeMaxY - threeMinY);
    } else {
      // Fallback: assume entire canvas is the scene
      u.uSceneRect.value.set(0, 0, sceneWidth, sceneHeight);
    }
    
    // Compute view bounds based on camera type
    if (camera.isPerspectiveCamera) {
      // For perspective camera, compute visible world rect at z=0
      // Camera looks down -Z, so we need to find the frustum intersection with z=0
      const camPos = camera.position;
      const distance = camPos.z; // Distance to z=0 plane
      
      // Calculate visible height at z=0 using FOV
      const vFov = camera.fov * Math.PI / 180;
      const visibleHeight = 2 * Math.tan(vFov / 2) * distance;
      const visibleWidth = visibleHeight * camera.aspect;
      
      // View bounds centered on camera position
      const minX = camPos.x - visibleWidth / 2;
      const maxX = camPos.x + visibleWidth / 2;
      const minY = camPos.y - visibleHeight / 2;
      const maxY = camPos.y + visibleHeight / 2;
      
      u.uViewBounds.value.set(minX, minY, maxX, maxY);
      
      if (Math.random() < 0.005) {
        log.debug(`ViewBounds (perspective): cam=(${camPos.x.toFixed(0)}, ${camPos.y.toFixed(0)}), visible=${visibleWidth.toFixed(0)}x${visibleHeight.toFixed(0)}, bounds=(${minX.toFixed(0)}, ${minY.toFixed(0)}) to (${maxX.toFixed(0)}, ${maxY.toFixed(0)}), scene=${sceneWidth}x${sceneHeight}`);
      }
    } else if (camera.isOrthographicCamera) {
      // For orthographic camera, bounds are directly from camera properties
      const camPos = camera.position;
      u.uViewBounds.value.set(
        camPos.x + camera.left,
        camPos.y + camera.bottom,
        camPos.x + camera.right,
        camPos.y + camera.top
      );
    }
  }

  /**
   * Helper to pass input to output without applying fog
   * @param {THREE.Renderer} renderer 
   * @param {THREE.Texture} inputTexture 
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
    
    // Restore bypass flag (though update() will override it next frame)
    this.material.uniforms.uBypassFog.value = oldBypass;
  } 
}
