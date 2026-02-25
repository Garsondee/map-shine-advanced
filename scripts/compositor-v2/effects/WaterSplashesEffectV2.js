/**
 * @fileoverview V2 Water Splashes Effect — per-floor particle systems from _Water masks.
 *
 * Architecture:
 *   Owns a three.quarks BatchedRenderer added to the FloorRenderBus scene via
 *   addEffectOverlay(). For each tile with a `_Water` mask, scans the mask on
 *   the CPU to build edge (shoreline) and interior spawn point lists, then
 *   creates foam plume + rain splash particle systems. Systems are grouped by
 *   floor index. Floor isolation is achieved by swapping active systems in/out
 *   of the BatchedRenderer on floor change.
 *
 * Follows the same proven pattern as FireEffectV2:
 *   - Self-contained V2 class with its own BatchedRenderer
 *   - worldSpace: true — absolute world-space particle positions
 *   - Emitters as children of BatchedRenderer (transitive scene membership)
 *   - Async texture loading with await before system creation
 *   - Non-zero emission rates (no bridge / external data dependency)
 *   - Floor-aware system swapping
 *   - Added to bus via renderBus.addEffectOverlay()
 *
 * Replaces the legacy 3-layer foam bridge:
 *   WaterEffectV2._syncLegacyFoamParticles → WeatherParticlesV2 → WeatherParticles._foamSystem
 *
 * @module compositor-v2/effects/WaterSplashesEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { OVERLAY_THREE_LAYER } from '../../effects/EffectComposer.js';
import {
  WaterEdgeMaskShape,
  WaterInteriorMaskShape,
  FoamPlumeLifecycleBehavior,
  SplashRingLifecycleBehavior,
  scanWaterEdgePoints,
  scanWaterInteriorPoints,
} from './water-splash-behaviors.js';
import {
  ParticleSystem as QuarksParticleSystem,
  BatchedRenderer,
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ConstantValue,
} from '../../libs/three.quarks.module.js';

const log = createLogger('WaterSplashesV2');

// Ground Z for the bus scene (matches FloorRenderBus GROUND_Z).
const GROUND_Z = 1000;

// Spatial bucket size for splitting large water masks into smaller emitters (px).
const BUCKET_SIZE = 2500;

// ─── WaterSplashesEffectV2 ──────────────────────────────────────────────────

export class WaterSplashesEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    this._renderBus = renderBus;
    this._enabled = true;
    this._initialized = false;

    /** @type {BatchedRenderer|null} three.quarks batch renderer */
    this._batchRenderer = null;

    /**
     * Per-floor cached system sets. Key: floorIndex.
     * Value: { foamSystems: QuarksParticleSystem[], splashSystems: [] }
     * @type {Map<number, object>}
     */
    this._floorStates = new Map();

    /**
     * Set of floor indices whose systems are currently in the BatchedRenderer.
     * @type {Set<number>}
     */
    this._activeFloors = new Set();

    /** @type {THREE.Texture|null} Foam sprite texture (foam.webp) */
    this._foamTexture = null;
    /** @type {THREE.Texture|null} Generic particle texture for splash rings */
    this._splashTexture = null;
    /** @type {Promise<void>|null} Resolves when sprite textures are loaded */
    this._texturesReady = null;

    /** @type {boolean} One-time debug log guard for populate point counts */
    this._loggedPopulateCountsOnce = false;

    /** @type {boolean} One-time debug log guard for runtime registration probes */
    this._loggedRuntimeDebugOnce = false;

    /** @type {THREE.Vector2|null} reused drawing-buffer size vector */
    this._tempVec2 = null;

    /** @type {{ sx:number, syWorld:number, sw:number, sh:number }|null} cached scene bounds for mask sampling */
    this._sceneBounds = null;

    /** @type {Array<QuarksParticleSystem>} reused systems list */
    this._tempSystems = [];

    // Effect parameters — tuneable from Tweakpane UI.
    this.params = {
      enabled: true,

      // Foam plumes (shoreline)
      foamEnabled: true,
      foamRate: 3.0,
      foamSizeMin: 30,
      foamSizeMax: 90,
      foamLifeMin: 0.8,
      foamLifeMax: 2.0,
      foamPeakOpacity: 0.65,
      foamColorR: 0.85,
      foamColorG: 0.90,
      foamColorB: 0.88,
      foamWindDriftScale: 0.3,

      // Rain splashes (interior)
      splashEnabled: true,
      splashRate: 5.0,
      splashSizeMin: 8,
      splashSizeMax: 25,
      splashLifeMin: 0.3,
      splashLifeMax: 0.8,
      splashPeakOpacity: 0.70,

      // Scan settings
      edgeScanStride: 2,
      interiorScanStride: 4,
      maskThreshold: 0.15,
    };

    log.debug('WaterSplashesEffectV2 created');
  }

  // ── Private: Material patching (floor occlusion) ──────────────────────────

  /**
   * Patch a material (MeshBasicMaterial or ShaderMaterial) to consult the
   * screen-space floor-presence RT and occlude particles under upper-floor tiles.
   *
   * The floor-presence texture is authored by DistortionManager and is already
   * aligned with the main camera using a screen-space prepass.
   * @private
   */
  _patchFloorPresenceMaterial(material) {
    const THREE = window.THREE;
    if (!material || !THREE) return;
    // Re-patch if we already patched an older version (before water-mask clipping).
    const existing = material.userData?._msFloorPresenceUniforms;
    if (existing && existing.uWaterMask && existing.uSceneBounds) return;

    const uniforms = {
      uFloorPresenceMap: { value: null },
      uHasFloorPresenceMap: { value: 0.0 },
      uResolution: { value: new THREE.Vector2(1, 1) },

      // Water mask clipping (scene-UV space raw water mask, R channel)
      uWaterMask: { value: null },
      uHasWaterMask: { value: 0.0 },
      // Matches legacy foam: flip V based on mask metadata / THREE.Texture.flipY
      uWaterFlipV: { value: 0.0 },
      // Scene bounds in Three world coords: (sceneX, sceneY, sceneW, sceneH)
      uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
    };

    material.userData = material.userData || {};
    material.userData._msFloorPresenceUniforms = uniforms;

    const isShaderMat = material.isShaderMaterial === true;
    const marker = '/* MS_WATER_SPLASHES_MASKING_V1 */';

    // Direct patch path for three.quarks SpriteBatch ShaderMaterial.
    // onBeforeCompile does NOT run for already-compiled ShaderMaterials.
    if (isShaderMat) {
      const uni = material.uniforms || (material.uniforms = {});
      uni.uFloorPresenceMap = uniforms.uFloorPresenceMap;
      uni.uHasFloorPresenceMap = uniforms.uHasFloorPresenceMap;
      uni.uResolution = uniforms.uResolution;
      uni.uWaterMask = uniforms.uWaterMask;
      uni.uHasWaterMask = uniforms.uHasWaterMask;
      uni.uWaterFlipV = uniforms.uWaterFlipV;
      uni.uSceneBounds = uniforms.uSceneBounds;

      let shaderChanged = false;

      // Vertex shader: add varying world position.
      if (typeof material.vertexShader === 'string') {
        const beforeVS = material.vertexShader;
        let vs = material.vertexShader;

        if (!vs.includes('varying vec3 vMsWorldPos')) {
          vs = vs.replace('void main() {', 'varying vec3 vMsWorldPos;\nvoid main() {');
        }

        // Prefer per-vertex world pos for correct sprite clipping. If quarks uses
        // rotatedPosition (billboard corner offset), include it so the varying
        // interpolates across the full quad.
        const hasRotatedPosition = /\brotatedPosition\b/.test(vs);
        const legacyAssign = 'vMsWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;';
        const desiredAssign = hasRotatedPosition
          ? 'vMsWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;\n  vMsWorldPos.xy += rotatedPosition;'
          : legacyAssign;

        if (vs.includes(legacyAssign) && !vs.includes(desiredAssign)) {
          vs = vs.replace(legacyAssign, desiredAssign);
        }
        if (!vs.includes('vMsWorldPos =') && vs.includes('#include <soft_vertex>')) {
          vs = vs.replace('#include <soft_vertex>', '#include <soft_vertex>\n  ' + desiredAssign);
        }

        if (vs !== beforeVS) {
          material.vertexShader = vs;
          shaderChanged = true;
        }
      }

      // Fragment shader: inject water mask clip + floor occluder.
      if (typeof material.fragmentShader === 'string') {
        const beforeFS = material.fragmentShader;
        let fs = material.fragmentShader;

        if (!fs.includes(marker)) {
          fs = fs.replace(
            'void main() {',
            marker + '\n' +
            'varying vec3 vMsWorldPos;\n' +
            'uniform sampler2D uFloorPresenceMap;\n' +
            'uniform float uHasFloorPresenceMap;\n' +
            'uniform vec2 uResolution;\n' +
            'uniform sampler2D uWaterMask;\n' +
            'uniform float uHasWaterMask;\n' +
            'uniform float uWaterFlipV;\n' +
            'uniform vec4 uSceneBounds;\n' +
            'void main() {'
          );

          const maskBlock =
            '  // Water mask clip: suppress particles outside the raw _Water mask (prevents land leaks).\n' +
            '  if (uHasWaterMask > 0.5) {\n' +
            '    vec2 uvMask = vec2(\n' +
            '      (vMsWorldPos.x - uSceneBounds.x) / uSceneBounds.z,\n' +
            '      (vMsWorldPos.y - uSceneBounds.y) / uSceneBounds.w\n' +
            '    );\n' +
            '    if (uWaterFlipV > 0.5) uvMask.y = 1.0 - uvMask.y;\n' +
            '    if (uvMask.x < 0.0 || uvMask.x > 1.0 || uvMask.y < 0.0 || uvMask.y > 1.0) {\n' +
            '      gl_FragColor.a *= 0.0;\n' +
            '    } else {\n' +
            '      float m = texture2D(uWaterMask, uvMask).r;\n' +
            '      gl_FragColor.a *= m;\n' +
            '    }\n' +
            '  }\n' +
            '  // Floor-presence gate: occlude particles under the current floor\'s solid tiles.\n' +
            '  if (uHasFloorPresenceMap > 0.5) {\n' +
            '    vec2 fpScreenUV = gl_FragCoord.xy / uResolution;\n' +
            '    float floorPresence = texture2D(uFloorPresenceMap, fpScreenUV).a;\n' +
            '    gl_FragColor.a *= (1.0 - floorPresence);\n' +
            '  }\n';

          if (fs.includes('#include <soft_fragment>')) {
            fs = fs.replace('#include <soft_fragment>', maskBlock + '#include <soft_fragment>');
          } else {
            // Fallback: inject at top of main; no guarantee of soft particles.
            fs = fs.replace(marker + '\n', marker + '\n' + maskBlock);
          }

          material.fragmentShader = fs;
          shaderChanged = true;
        }

        if (material.fragmentShader !== beforeFS) shaderChanged = true;
      }

      if (shaderChanged) material.needsUpdate = true;
      return;
    }

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFloorPresenceMap = uniforms.uFloorPresenceMap;
      shader.uniforms.uHasFloorPresenceMap = uniforms.uHasFloorPresenceMap;
      shader.uniforms.uResolution = uniforms.uResolution;
      shader.uniforms.uWaterMask = uniforms.uWaterMask;
      shader.uniforms.uHasWaterMask = uniforms.uHasWaterMask;
      shader.uniforms.uWaterFlipV = uniforms.uWaterFlipV;
      shader.uniforms.uSceneBounds = uniforms.uSceneBounds;

      // Inject world position varying (works for quarks SpriteBatch and MeshBasicMaterial)
      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          'varying vec3 vMsWorldPos;\nvoid main() {'
        )
        .replace(
          '#include <soft_vertex>',
          '#include <soft_vertex>\n  vMsWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;'
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'varying vec3 vMsWorldPos;\n' +
          'uniform sampler2D uFloorPresenceMap;\nuniform float uHasFloorPresenceMap;\nuniform vec2 uResolution;\n' +
          'uniform sampler2D uWaterMask;\nuniform float uHasWaterMask;\nuniform float uWaterFlipV;\nuniform vec4 uSceneBounds;\n' +
          'void main() {'
        )
        .replace(
          '#include <soft_fragment>',
          '  // Water mask clip: suppress particles outside the raw _Water mask (prevents land leaks).\n' +
          '  if (uHasWaterMask > 0.5) {\n' +
          '    vec2 uvMask = vec2(\n' +
          '      (vMsWorldPos.x - uSceneBounds.x) / uSceneBounds.z,\n' +
          '      (vMsWorldPos.y - uSceneBounds.y) / uSceneBounds.w\n' +
          '    );\n' +
          '    if (uWaterFlipV > 0.5) uvMask.y = 1.0 - uvMask.y;\n' +
          '    if (uvMask.x < 0.0 || uvMask.x > 1.0 || uvMask.y < 0.0 || uvMask.y > 1.0) {\n' +
          '      gl_FragColor.a *= 0.0;\n' +
          '    } else {\n' +
          '      float m = texture2D(uWaterMask, uvMask).r;\n' +
          '      gl_FragColor.a *= m;\n' +
          '    }\n' +
          '  }\n' +
          '  // Floor-presence gate: occlude particles under the current floor\'s solid tiles.\n' +
          '  if (uHasFloorPresenceMap > 0.5) {\n' +
          '    vec2 fpScreenUV = gl_FragCoord.xy / uResolution;\n' +
          '    // V2 uses a screen-space occluder alpha RT (same as WaterEffectV2).\n' +
          '    float floorPresence = texture2D(uFloorPresenceMap, fpScreenUV).a;\n' +
          '    gl_FragColor.a *= (1.0 - floorPresence);\n' +
          '  }\n' +
          '#include <soft_fragment>'
        );
    };

    material.needsUpdate = true;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, 'enabled')) {
      this.params.enabled = this._enabled;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    // Create a dedicated BatchedRenderer for water splash particles.
    this._batchRenderer = new BatchedRenderer();
    this._batchRenderer.renderOrder = 49; // Just below weather particles (50)
    this._batchRenderer.frustumCulled = false;
    try {
      if (this._batchRenderer.layers && typeof this._batchRenderer.layers.enable === 'function') {
        this._batchRenderer.layers.enable(OVERLAY_THREE_LAYER);
      }
    } catch (_) {}

    // Start loading sprite textures (populate() will await this).
    this._texturesReady = this._loadTextures();

    this._initialized = true;
    log.info('WaterSplashesEffectV2 initialized');
  }

  /**
   * Populate water splash systems for all tiles with _Water masks.
   * Groups spawn points by floor index. Call after FloorRenderBus.populate().
   *
   * @param {object} foundrySceneData - Scene geometry data
   */
  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this.clear();

    // Wait for foam/splash sprite textures before creating systems.
    if (this._texturesReady) await this._texturesReady;

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    if (tileDocs.length === 0) { log.info('populate: no tiles'); return; }

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const d = canvas?.dimensions;
    if (!d) { log.warn('populate: no canvas dimensions'); return; }

    const sceneWidth = d.sceneWidth || d.width;
    const sceneHeight = d.sceneHeight || d.height;
    // Foundry scene origin (top-left, Y-down).
    const foundrySceneX = d.sceneX || 0;
    const foundrySceneY = d.sceneY || 0;
    // Three.js scene origin (Y-up).
    const sceneX = foundrySceneX;
    const sceneY = (d.height || sceneHeight) - foundrySceneY - sceneHeight;

    // Cache for per-frame shader uniform binding.
    this._sceneBounds = {
      sx: sceneX,
      syWorld: sceneY,
      sw: sceneWidth,
      sh: sceneHeight,
    };

    // Collect water edge + interior points per floor from all tiles.
    // Key: floorIndex, Value: { edgeArrays: Float32Array[], interiorArrays: Float32Array[] }
    const floorWaterData = new Map();

    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      // Probe for _Water mask.
      const waterResult = await probeMaskFile(basePath, '_Water');
      if (!waterResult?.path) continue;

      // Load the water mask image to scan for spawn points.
      const image = await this._loadImage(waterResult.path);
      if (!image) continue;

      // Scan for edge (shoreline) points.
      const tileEdgePoints = scanWaterEdgePoints(
        image, this.params.maskThreshold, this.params.edgeScanStride
      );
      // Scan for interior points.
      const tileInteriorPoints = scanWaterInteriorPoints(
        image, this.params.maskThreshold, this.params.interiorScanStride
      );

      if (!tileEdgePoints && !tileInteriorPoints) continue;

      // Convert tile-local UVs → scene-global UVs.
      const tileX = Number(tileDoc.x) || 0;
      const tileY = Number(tileDoc.y) || 0;
      const tileW = Number(tileDoc.width) || 1;
      const tileH = Number(tileDoc.height) || 1;

      const convertToSceneUV = (localPoints) => {
        if (!localPoints) return null;
        const sceneGlobal = new Float32Array(localPoints.length);
        for (let i = 0; i < localPoints.length; i += 3) {
          const foundryPx = tileX + localPoints[i] * tileW;
          const foundryPy = tileY + localPoints[i + 1] * tileH;
          sceneGlobal[i]     = (foundryPx - foundrySceneX) / sceneWidth;
          sceneGlobal[i + 1] = (foundryPy - foundrySceneY) / sceneHeight;
          sceneGlobal[i + 2] = localPoints[i + 2]; // strength/brightness unchanged
        }
        return sceneGlobal;
      };

      const sceneEdge = convertToSceneUV(tileEdgePoints);
      const sceneInterior = convertToSceneUV(tileInteriorPoints);

      // Resolve floor index.
      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      if (!floorWaterData.has(floorIndex)) {
        floorWaterData.set(floorIndex, { edgeArrays: [], interiorArrays: [] });
      }
      const floorEntry = floorWaterData.get(floorIndex);
      if (sceneEdge) floorEntry.edgeArrays.push(sceneEdge);
      if (sceneInterior) floorEntry.interiorArrays.push(sceneInterior);

      log.info(`  tile '${tileId}' → floor ${floorIndex}, ${sceneEdge ? sceneEdge.length / 3 : 0} edge pts, ${sceneInterior ? sceneInterior.length / 3 : 0} interior pts`);
    }

    // Build particle systems per floor.
    let totalSystems = 0;
    for (const [floorIndex, { edgeArrays, interiorArrays }] of floorWaterData) {
      // Merge edge arrays.
      const mergedEdge = this._mergeFloat32Arrays(edgeArrays);
      // Merge interior arrays.
      const mergedInterior = this._mergeFloat32Arrays(interiorArrays);

      // One-time diagnostics: show whether scans produced any points.
      if (!this._loggedPopulateCountsOnce) {
        try {
          log.info('[WaterSplashesEffectV2] floor scan summary', {
            floorIndex,
            edgePoints: mergedEdge ? (mergedEdge.length / 3) : 0,
            interiorPoints: mergedInterior ? (mergedInterior.length / 3) : 0,
            edgeArrays: edgeArrays?.length ?? 0,
            interiorArrays: interiorArrays?.length ?? 0,
          });
        } catch (_) {}
      }

      const state = this._buildFloorSystems(
        mergedEdge, mergedInterior, sceneWidth, sceneHeight, sceneX, sceneY, floorIndex
      );
      this._floorStates.set(floorIndex, state);
      totalSystems += state.foamSystems.length + state.splashSystems.length;
    }

    if (!this._loggedPopulateCountsOnce) {
      this._loggedPopulateCountsOnce = true;
      try {
        const keys = [...this._floorStates.keys()];
        log.info('[WaterSplashesEffectV2] populate summary', {
          floors: keys,
          totalSystems,
        });
      } catch (_) {}
    }

    // Add the BatchedRenderer to the bus scene via the overlay API.
    if (this._batchRenderer) {
      this._renderBus.addEffectOverlay('__water_splash_batch__', this._batchRenderer, 0);
    }

    // Activate the current floor's systems.
    this._activateCurrentFloor();

    log.info(`WaterSplashesEffectV2 populated: ${floorWaterData.size} floor(s), ${totalSystems} system(s)`);
  }

  /**
   * Per-frame update. Steps the BatchedRenderer simulation.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._batchRenderer || !this._enabled) return;
    if (!this.params.enabled) return;

    // Optional diagnostics for cases where systems were activated before the
    // user set the debug flag. This runs once when enabled and prints the
    // BatchedRenderer + system registration state.
    // Enable at runtime (any of these):
    //   globalThis.debugWaterSplashesLogs = true
    //   window.debugWaterSplashesLogs = true
    //   window.MapShine.debugWaterSplashesLogs = true
    try {
      const dbg = (globalThis.debugWaterSplashesLogs === true)
        || (window.debugWaterSplashesLogs === true)
        || (window.MapShine?.debugWaterSplashesLogs === true);
      if (dbg && !this._loggedRuntimeDebugOnce) {
        this._loggedRuntimeDebugOnce = true;
        const br = this._batchRenderer;
        const mapSize = br?.systemToBatchIndex?.size ?? null;
        const batchCount = br?.batches?.length ?? null;
        const anyFloor = this._floorStates.keys().next().value;
        const state = (anyFloor !== undefined) ? this._floorStates.get(anyFloor) : null;
        const anySys = state ? ([...(state.foamSystems ?? []), ...(state.splashSystems ?? [])][0] ?? null) : null;
        const idx = (anySys && br?.systemToBatchIndex?.get) ? br.systemToBatchIndex.get(anySys) : null;
        const batch = (idx !== null && idx !== undefined && br?.batches) ? br.batches[idx] : null;
        log.info('[WaterSplashesEffectV2] runtime debug probe', {
          activeFloors: [...this._activeFloors],
          floorStateKeys: [...this._floorStates.keys()],
          mapSize,
          batchCount,
          anySystemCtor: anySys?.constructor?.name ?? null,
          anyEmission: (anySys?.emissionOverTime?.a ?? anySys?.emissionOverTime?.value) ?? null,
          anyHasEmitter: !!anySys?.emitter,
          anyEmitterParent: anySys?.emitter?.parent?.type ?? null,
          anyMaterialHasMap: !!anySys?.material?.map,
          anyBatchHasMaterial: !!batch?.material,
          anyBatchMaterialHasMap: !!(batch?.material?.uniforms?.map?.value || batch?.material?.map),
          batchRendererParent: br?.parent?.type ?? null,
          batchRendererLayer: br?.layers?.mask ?? null,
        });
      }
    } catch (_) {}

    // Compute dt for three.quarks (matches FireEffectV2 time scaling).
    const deltaSec = typeof timeInfo.delta === 'number' ? timeInfo.delta : 0.016;
    const clampedDelta = Math.min(deltaSec, 0.1);
    const simSpeed = (weatherController && typeof weatherController.simulationSpeed === 'number')
      ? weatherController.simulationSpeed : 2.0;
    const dt = clampedDelta * 0.001 * 750 * simSpeed;

    // Update per-frame emission rates and params.
    this._updateSystemParams();

    // Bind floor-presence occlusion uniforms.
    try {
      // V2 occlusion source: FloorCompositor's screen-space occluder alpha RT.
      // This RT marks pixels covered by the current/upper floor's tiles.
      // It is already aligned with the main camera and sampled in screen UV.
      const fc = window.MapShine?.effectComposer?._floorCompositorV2 ?? null;
      const fpTex = fc?._waterOccluderRT?.texture ?? null;
      const waterMaskTex = (fc?._waterEffect && typeof fc._waterEffect.getWaterMaskTexture === 'function')
        ? fc._waterEffect.getWaterMaskTexture()
        : null;

      // Legacy foam determines whether the mask needs V flipping (mask metadata / texture.flipY).
      let waterFlipV = false;
      if (waterMaskTex) {
        try {
          const mm = window.MapShine?.maskManager;
          const rec = mm?.getRecord ? mm.getRecord('water.scene') : null;
          if (rec && typeof rec.uvFlipY === 'boolean') {
            waterFlipV = rec.uvFlipY;
          } else if (typeof waterMaskTex?.flipY === 'boolean') {
            waterFlipV = waterMaskTex.flipY === false;
          } else {
            waterFlipV = false;
          }
        } catch (_) {
          waterFlipV = waterMaskTex?.flipY === false;
        }
      }

      const sceneBounds = this._sceneBounds;

      const renderer = window.MapShine?.renderer || window.canvas?.app?.renderer;
      let resX = 1, resY = 1;
      if (renderer && window.THREE) {
        if (!this._tempVec2) this._tempVec2 = new window.THREE.Vector2();
        const size = this._tempVec2;
        if (typeof renderer.getDrawingBufferSize === 'function') {
          renderer.getDrawingBufferSize(size);
        } else if (typeof renderer.getSize === 'function') {
          renderer.getSize(size);
          const dpr = typeof renderer.getPixelRatio === 'function'
            ? renderer.getPixelRatio()
            : (window.devicePixelRatio || 1);
          size.multiplyScalar(dpr);
        }
        resX = size.x || 1;
        resY = size.y || 1;
      }

      // Collect active systems once (no per-frame allocations).
      const systems = this._tempSystems;
      systems.length = 0;
      for (const floorIndex of this._activeFloors) {
        const st = this._floorStates.get(floorIndex);
        if (!st) continue;
        if (st.foamSystems && st.foamSystems.length) systems.push(...st.foamSystems);
        if (st.splashSystems && st.splashSystems.length) systems.push(...st.splashSystems);
      }

      const br = this._batchRenderer;
      const batches = br?.batches;
      const map = br?.systemToBatchIndex;

      for (const sys of systems) {
        if (!sys) continue;

        // Patch and update the source material (MeshBasicMaterial)
        if (sys.material) {
          this._patchFloorPresenceMaterial(sys.material);
          const u = sys.material.userData?._msFloorPresenceUniforms;
          if (u) {
            u.uFloorPresenceMap.value = fpTex;
            u.uHasFloorPresenceMap.value = fpTex ? 1.0 : 0.0;
            u.uResolution.value.set(resX, resY);
            u.uWaterMask.value = waterMaskTex;
            u.uHasWaterMask.value = waterMaskTex ? 1.0 : 0.0;
            if (u.uWaterFlipV) u.uWaterFlipV.value = waterFlipV ? 1.0 : 0.0;
            if (sceneBounds && u.uSceneBounds?.value?.set) {
              u.uSceneBounds.value.set(sceneBounds.sx, sceneBounds.syWorld, sceneBounds.sw, sceneBounds.sh);
            }
          }
        }

        // Patch and update the quarks batch material (ShaderMaterial)
        const idx = (map && typeof map.get === 'function') ? map.get(sys) : undefined;
        const batch = (idx !== undefined && batches) ? batches[idx] : null;
        const batchMat = batch?.material;
        if (batchMat) {
          this._patchFloorPresenceMaterial(batchMat);
          const u = batchMat.userData?._msFloorPresenceUniforms;
          if (u) {
            u.uFloorPresenceMap.value = fpTex;
            u.uHasFloorPresenceMap.value = fpTex ? 1.0 : 0.0;
            u.uResolution.value.set(resX, resY);
            u.uWaterMask.value = waterMaskTex;
            u.uHasWaterMask.value = waterMaskTex ? 1.0 : 0.0;
            if (u.uWaterFlipV) u.uWaterFlipV.value = waterFlipV ? 1.0 : 0.0;
            if (sceneBounds && u.uSceneBounds?.value?.set) {
              u.uSceneBounds.value.set(sceneBounds.sx, sceneBounds.syWorld, sceneBounds.sw, sceneBounds.sh);
            }
          }
        }
      }
    } catch (_) {}

    // Step the BatchedRenderer.
    this._batchRenderer.update(dt);
  }

  /**
   * Called when the visible floor range changes.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    if (!this._initialized) return;

    const desired = new Set();
    for (const idx of this._floorStates.keys()) {
      if (idx <= maxFloorIndex) desired.add(idx);
    }

    // Deactivate floors that should no longer be visible.
    for (const idx of this._activeFloors) {
      if (!desired.has(idx)) this._deactivateFloor(idx);
    }
    // Activate floors that are newly visible.
    for (const idx of desired) {
      if (!this._activeFloors.has(idx)) this._activateFloor(idx);
    }

    log.info(`onFloorChange(${maxFloorIndex}): active=[${[...desired]}]`);
    this._activeFloors = desired;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  clear() {
    for (const idx of this._activeFloors) {
      this._deactivateFloor(idx);
    }
    this._activeFloors.clear();

    for (const [, state] of this._floorStates) {
      this._disposeFloorState(state);
    }
    this._floorStates.clear();

    this._renderBus.removeEffectOverlay('__water_splash_batch__');
  }

  dispose() {
    this.clear();
    this._foamTexture?.dispose();
    this._splashTexture?.dispose();
    this._foamTexture = null;
    this._splashTexture = null;
    this._batchRenderer = null;
    this._initialized = false;
    log.info('WaterSplashesEffectV2 disposed');
  }

  // ── Private: System building ───────────────────────────────────────────────

  /**
   * Build foam + splash systems from merged points for a single floor.
   * Edge points → foam plume systems. Interior points → rain splash systems.
   * Points are spatially bucketed for efficiency.
   * @private
   */
  _buildFloorSystems(edgePoints, interiorPoints, sceneW, sceneH, sceneX, sceneY, floorIndex) {
    const state = { foamSystems: [], splashSystems: [] };

    // Build foam plume systems from edge points.
    if (edgePoints && edgePoints.length >= 3 && this.params.foamEnabled) {
      const buckets = this._spatialBucket(edgePoints, sceneW, sceneH, sceneX, sceneY);
      const totalEdge = edgePoints.length / 3;
      for (const [, arr] of buckets) {
        if (arr.length < 3) continue;
        const bucketPoints = new Float32Array(arr);
        const weight = totalEdge > 0 ? (bucketPoints.length / 3 / totalEdge) : 1.0;
        const shape = new WaterEdgeMaskShape(
          bucketPoints, sceneW, sceneH, sceneX, sceneY,
          GROUND_Z + (Number(floorIndex) || 0), 0.3
        );
        const sys = this._createFoamSystem(shape, weight);
        if (sys) state.foamSystems.push(sys);
      }
    }

    // Build splash systems from interior points.
    if (interiorPoints && interiorPoints.length >= 3 && this.params.splashEnabled) {
      const buckets = this._spatialBucket(interiorPoints, sceneW, sceneH, sceneX, sceneY);
      const totalInterior = interiorPoints.length / 3;
      for (const [, arr] of buckets) {
        if (arr.length < 3) continue;
        const bucketPoints = new Float32Array(arr);
        const weight = totalInterior > 0 ? (bucketPoints.length / 3 / totalInterior) : 1.0;
        const shape = new WaterInteriorMaskShape(
          bucketPoints, sceneW, sceneH, sceneX, sceneY,
          GROUND_Z + (Number(floorIndex) || 0), 0.3
        );
        const sys = this._createSplashSystem(shape, weight);
        if (sys) state.splashSystems.push(sys);
      }
    }

    return state;
  }

  /** @private */
  _createFoamSystem(shape, weight) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._foamTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;

    const p = this.params;
    const lifeMin = Math.max(0.01, p.foamLifeMin ?? 0.8);
    const lifeMax = Math.max(lifeMin, p.foamLifeMax ?? 2.0);
    const sizeMin = Math.max(0.1, p.foamSizeMin ?? 30);
    const sizeMax = Math.max(sizeMin, p.foamSizeMax ?? 90);

    // NOTE: Weight distributes the global rate across bucketed systems. With many buckets
    // (e.g. 30–50), naive `rate * weight` can drop below 0.1 and effectively not render.
    // FireEffectV2 works largely because its base emission rates are an order of magnitude
    // higher; match that expectation here.
    const foamRateMult = 20.0;
    const foamRate = Math.max(0.0, Number(p.foamRate) || 0) * foamRateMult;

    const foamLifecycle = new FoamPlumeLifecycleBehavior(this);

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 3000,
      emissionOverTime: new IntervalValue(
        Math.max(1.0, foamRate * weight * 0.5),
        Math.max(2.0, foamRate * weight)
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 49,
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [foamLifecycle],
    });

    system.userData = {
      ownerEffect: this,
      _msEmissionScale: weight,
      isFoam: true,
    };

    return system;
  }

  /** @private */
  _createSplashSystem(shape, weight) {
    const THREE = window.THREE;
    if (!THREE) return null;

    // Splash rings use the generic particle texture (or foam texture as fallback).
    const material = new THREE.MeshBasicMaterial({
      map: this._splashTexture || this._foamTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;

    const p = this.params;
    const lifeMin = Math.max(0.01, p.splashLifeMin ?? 0.3);
    const lifeMax = Math.max(lifeMin, p.splashLifeMax ?? 0.8);
    const sizeMin = Math.max(0.1, p.splashSizeMin ?? 8);
    const sizeMax = Math.max(sizeMin, p.splashSizeMax ?? 25);

    const splashRateMult = 20.0;
    const splashRate = Math.max(0.0, Number(p.splashRate) || 0) * splashRateMult;

    const splashLifecycle = new SplashRingLifecycleBehavior(this);

    // Splash emission is gated by precipitation — when it's not raining,
    // the behavior's _precipMult drives alpha to 0 so particles are invisible.
    // We still emit at base rate so particles are ready when rain starts.
    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 4000,
      emissionOverTime: new IntervalValue(
        Math.max(1.0, splashRate * weight * 0.5),
        Math.max(2.0, splashRate * weight)
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 49,
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [splashLifecycle],
    });

    system.userData = {
      ownerEffect: this,
      _msEmissionScale: weight,
      isSplash: true,
    };

    return system;
  }

  // ── Private: Floor switching ───────────────────────────────────────────────

  /** Activate all floors up to the current active floor. @private */
  _activateCurrentFloor() {
    const floorStack = window.MapShine?.floorStack;
    const activeFloor = floorStack?.getActiveFloor();
    const maxFloorIndex = activeFloor?.index ?? Infinity;
    this.onFloorChange(maxFloorIndex);
  }

  /** Add a floor's systems to the BatchedRenderer. @private */
  _activateFloor(floorIndex) {
    const state = this._floorStates.get(floorIndex);
    if (!state || !this._batchRenderer) return;

    const allSystems = [...state.foamSystems, ...state.splashSystems];
    for (const sys of allSystems) {
      try { this._batchRenderer.addSystem(sys); } catch (_) {}
      // Emitters as children of BatchedRenderer — transitive scene membership.
      if (sys.emitter) this._batchRenderer.add(sys.emitter);
    }

    // Optional diagnostics for "systems exist but nothing renders".
    // Enable at runtime: window.MapShine.debugWaterSplashesLogs = true
    try {
      const dbg = (globalThis.debugWaterSplashesLogs === true)
        || (window.debugWaterSplashesLogs === true)
        || (window.MapShine?.debugWaterSplashesLogs === true);
      if (dbg) {
        const br = this._batchRenderer;
        const mapSize = br?.systemToBatchIndex?.size ?? null;
        const batchCount = br?.batches?.length ?? null;
        const first = allSystems[0] ?? null;
        const idx = (first && br?.systemToBatchIndex?.get) ? br.systemToBatchIndex.get(first) : null;
        const batch = (idx !== null && idx !== undefined && br?.batches) ? br.batches[idx] : null;
        log.info('[WaterSplashesEffectV2] activateFloor debug', {
          floorIndex,
          systems: allSystems.length,
          mapSize,
          batchCount,
          firstSystemCtor: first?.constructor?.name ?? null,
          firstEmission: (first?.emissionOverTime?.a ?? first?.emissionOverTime?.value) ?? null,
          firstHasEmitter: !!first?.emitter,
          firstEmitterParent: first?.emitter?.parent?.type ?? null,
          firstMaterialHasMap: !!first?.material?.map,
          firstBatchHasMaterial: !!batch?.material,
          firstBatchMaterialHasMap: !!(batch?.material?.uniforms?.map?.value || batch?.material?.map),
          cameraLayerMask: window.MapShine?.sceneComposer?.camera?.layers?.mask ?? null,
        });
      }
    } catch (_) {}

    log.debug(`activated floor ${floorIndex} (${allSystems.length} systems)`);
  }

  /** Remove a floor's systems from the BatchedRenderer. @private */
  _deactivateFloor(floorIndex) {
    if (!this._batchRenderer) return;
    const state = this._floorStates.get(floorIndex);
    if (!state) return;

    const allSystems = [...state.foamSystems, ...state.splashSystems];
    for (const sys of allSystems) {
      try { this._batchRenderer.deleteSystem(sys); } catch (_) {}
      if (sys.emitter) this._batchRenderer.remove(sys.emitter);
    }
    log.debug(`deactivated floor ${floorIndex}`);
  }

  /** Dispose all systems in a floor state. @private */
  _disposeFloorState(state) {
    const allSystems = [...state.foamSystems, ...state.splashSystems];
    for (const sys of allSystems) {
      try {
        if (this._batchRenderer) this._batchRenderer.deleteSystem(sys);
      } catch (_) {}
      if (sys.emitter && this._batchRenderer) {
        this._batchRenderer.remove(sys.emitter);
      }
      try { sys.material?.dispose(); } catch (_) {}
    }
    state.foamSystems.length = 0;
    state.splashSystems.length = 0;
  }

  // ── Private: Per-frame param sync ──────────────────────────────────────────

  /** Update emission rates based on current params + weather. @private */
  _updateSystemParams() {
    const p = this.params;

    // Keep emission strong enough to remain visible after spatial bucketing.
    // `_createFoamSystem/_createSplashSystem` apply the same multipliers.
    const foamRateMult = 20.0;
    const splashRateMult = 20.0;

    // Get current precipitation for splash rate modulation.
    let precip = 0;
    try {
      const state = weatherController?.getCurrentState?.();
      precip = state?.precipitation ?? 0;
      if (!Number.isFinite(precip)) precip = 0;
    } catch (_) {}

    for (const [, state] of this._floorStates) {
      // Foam systems: emission proportional to foamRate.
      for (const sys of state.foamSystems) {
        if (!sys?.userData) continue;
        const w = sys.userData._msEmissionScale ?? 1.0;
        const foamRate = Math.max(0.0, Number(p.foamRate) || 0) * foamRateMult;
        if (sys.emissionOverTime) {
          sys.emissionOverTime.a = Math.max(1.0, foamRate * w * 0.5);
          sys.emissionOverTime.b = Math.max(2.0, foamRate * w);
        }
      }

      // Splash systems: emission modulated by precipitation.
      for (const sys of state.splashSystems) {
        if (!sys?.userData) continue;
        const w = sys.userData._msEmissionScale ?? 1.0;
        const splashRate = Math.max(0.0, Number(p.splashRate) || 0) * splashRateMult;
        // Scale emission by precipitation so splashes only appear when it rains.
        const precipScale = Math.max(0, Math.min(1.0, precip));
        if (sys.emissionOverTime) {
          // Keep a small baseline so systems remain alive/ready; visual intensity is still
          // strongly gated by precipitation via SplashRingLifecycleBehavior alpha.
          const baseA = splashRate * w * 0.5;
          const baseB = splashRate * w;
          sys.emissionOverTime.a = Math.max(0.2, baseA * precipScale);
          sys.emissionOverTime.b = Math.max(0.5, baseB * precipScale);
        }
      }
    }
  }

  // ── Private: Texture loading ───────────────────────────────────────────────

  /**
   * Load foam and splash sprite textures. Returns a promise that resolves
   * when both are loaded.
   * @returns {Promise<void>}
   * @private
   */
  _loadTextures() {
    const THREE = window.THREE;
    if (!THREE) return Promise.resolve();
    const loader = new THREE.TextureLoader();

    const foamP = new Promise((resolve) => {
      loader.load('modules/map-shine-advanced/assets/foam.webp', (tex) => {
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        this._foamTexture = tex;
        resolve();
      }, undefined, () => { log.warn('Failed to load foam.webp'); resolve(); });
    });

    // Use the generic particle texture for splash rings.
    const splashP = new Promise((resolve) => {
      loader.load('modules/map-shine-advanced/assets/particle.webp', (tex) => {
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        this._splashTexture = tex;
        resolve();
      }, undefined, () => { log.warn('Failed to load particle.webp'); resolve(); });
    });

    return Promise.all([foamP, splashP]).then(() => {
      log.info('Water splash textures loaded');
    });
  }

  /**
   * Load an image from URL and return the HTMLImageElement.
   * @private
   */
  _loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => { log.warn(`Failed to load water mask image: ${url}`); resolve(null); };
      img.src = url;
    });
  }

  // ── Private: Utility ──────────────────────────────────────────────────────

  /**
   * Merge multiple Float32Arrays into one.
   * @param {Float32Array[]} arrays
   * @returns {Float32Array|null}
   * @private
   */
  _mergeFloat32Arrays(arrays) {
    if (!arrays || arrays.length === 0) return null;
    const totalLen = arrays.reduce((sum, arr) => sum + (arr?.length ?? 0), 0);
    if (totalLen === 0) return null;
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
      if (!arr) continue;
      merged.set(arr, offset);
      offset += arr.length;
    }
    return merged;
  }

  /**
   * Spatially bucket (u,v,strength) points for efficient emitter splitting.
   * @param {Float32Array} points - Packed triples
   * @param {number} sceneW
   * @param {number} sceneH
   * @param {number} sceneX
   * @param {number} sceneY
   * @returns {Map<string, number[]>}
   * @private
   */
  _spatialBucket(points, sceneW, sceneH, sceneX, sceneY) {
    const buckets = new Map();
    for (let i = 0; i < points.length; i += 3) {
      const u = points[i];
      const v = points[i + 1];
      const s = points[i + 2];
      if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(s) || s <= 0) continue;
      const worldX = sceneX + u * sceneW;
      const worldY = sceneY + (1.0 - v) * sceneH;
      const bx = Math.floor(worldX / BUCKET_SIZE);
      const by = Math.floor(worldY / BUCKET_SIZE);
      const key = `${bx},${by}`;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(u, v, s);
    }
    return buckets;
  }

  // ── Private: Floor resolution ──────────────────────────────────────────────

  /** Same logic as FireEffectV2 and FloorRenderBus. @private */
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;
    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid <= f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }
    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }

  // ── Static schema (Tweakpane) ───────────────────────────────────────────

  /**
   * Tweakpane control schema for WaterSplashesEffectV2.
   * @returns {object}
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'foam',
          label: 'Foam (Shoreline)',
          type: 'inline',
          parameters: [
            'foamEnabled',
            'foamRate',
            'foamPeakOpacity',
            'foamLifeMin',
            'foamLifeMax',
            'foamSizeMin',
            'foamSizeMax',
            'foamWindDriftScale',
            'foamColorR',
            'foamColorG',
            'foamColorB',
          ]
        },
        {
          name: 'splashes',
          label: 'Splashes (Rain on Water)',
          type: 'inline',
          separator: true,
          parameters: [
            'splashEnabled',
            'splashRate',
            'splashPeakOpacity',
            'splashLifeMin',
            'splashLifeMax',
            'splashSizeMin',
            'splashSizeMax',
          ]
        },
        {
          name: 'mask-scan',
          label: 'Mask Scan / Density',
          type: 'inline',
          separator: true,
          parameters: [
            'maskThreshold',
            'edgeScanStride',
            'interiorScanStride',
          ]
        }
      ],
      parameters: {
        foamEnabled: { type: 'boolean', label: 'Enabled', default: true },
        foamRate: { type: 'slider', label: 'Rate', min: 0, max: 25, step: 0.1, default: 3.0 },
        foamPeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0, max: 1, step: 0.01, default: 0.65 },
        foamLifeMin: { type: 'slider', label: 'Life Min', min: 0.05, max: 10, step: 0.05, default: 0.8 },
        foamLifeMax: { type: 'slider', label: 'Life Max', min: 0.05, max: 10, step: 0.05, default: 2.0 },
        foamSizeMin: { type: 'slider', label: 'Size Min', min: 1, max: 300, step: 1, default: 30 },
        foamSizeMax: { type: 'slider', label: 'Size Max', min: 1, max: 500, step: 1, default: 90 },
        foamWindDriftScale: { type: 'slider', label: 'Wind Drift', min: 0, max: 3, step: 0.01, default: 0.3 },
        foamColorR: { type: 'slider', label: 'Color R', min: 0, max: 1.5, step: 0.01, default: 0.85 },
        foamColorG: { type: 'slider', label: 'Color G', min: 0, max: 1.5, step: 0.01, default: 0.90 },
        foamColorB: { type: 'slider', label: 'Color B', min: 0, max: 1.5, step: 0.01, default: 0.88 },

        splashEnabled: { type: 'boolean', label: 'Enabled', default: true },
        splashRate: { type: 'slider', label: 'Rate', min: 0, max: 40, step: 0.1, default: 5.0 },
        splashPeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0, max: 1, step: 0.01, default: 0.70 },
        splashLifeMin: { type: 'slider', label: 'Life Min', min: 0.05, max: 5, step: 0.05, default: 0.3 },
        splashLifeMax: { type: 'slider', label: 'Life Max', min: 0.05, max: 5, step: 0.05, default: 0.8 },
        splashSizeMin: { type: 'slider', label: 'Size Min', min: 1, max: 200, step: 1, default: 8 },
        splashSizeMax: { type: 'slider', label: 'Size Max', min: 1, max: 300, step: 1, default: 25 },

        maskThreshold: { type: 'slider', label: 'Water Threshold', min: 0.0, max: 1.0, step: 0.01, default: 0.15 },
        edgeScanStride: { type: 'slider', label: 'Edge Stride', min: 1, max: 16, step: 1, default: 2 },
        interiorScanStride: { type: 'slider', label: 'Interior Stride', min: 1, max: 32, step: 1, default: 4 },
      }
    };
  }
}
