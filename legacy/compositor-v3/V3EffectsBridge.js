/**
 * @fileoverview V3EffectsBridge — drives existing MSA effect instances under V3.
 *
 * The heavy effects (candle flames, vegetation) are large simulation systems.
 * V3 reuses those effect *classes* (their domain logic — how a flame flickers,
 * how a bush sways) rather than reimplementing them; it just owns when they tick
 * and where they composite. This is migration, not "gluing V2's pipeline": V3
 * calls the effect instances directly, not FloorCompositor's orchestration.
 *
 * Under V3, V2's `FloorCompositor.render()` is not called, so these effects were
 * neither ticked nor composited. This bridge restores both:
 *
 *   • **Candle flames** render as meshes already attached to the bus scene
 *     (layer 0), so they draw inside `FloorRenderBus.renderTo` — they only need
 *     their `update(timeInfo)` ticked (which does the particle sim). Ticked in
 *     the geometry pass, before the bus render.
 *   • **Vegetation** (bush/tree) lives on layer 32 (excluded from the bus draw),
 *     as per-overlay `mesh` (canopy) + `shadowMesh` roots. It composites after
 *     lighting by rendering those roots with the main camera onto `scene.lit`
 *     (shadows first, then canopies) — the same `renderer.render(root, camera)`
 *     draw V2 uses in `_compositeVegetationAboveWater`.
 *
 * **Known first-cut limits (documented, expected):**
 * - Candle flames render into the albedo (pre-lighting), so they are modulated by
 *   the lighting pass and can look dim in dark rooms; and candle *glow* does not
 *   yet contribute light (V3 lighting only does Foundry AmbientLights). Both are
 *   follow-ups (render flames post-lighting; add candle glow to the light pass).
 * - Vegetation renders with whatever material uniforms it last held; the full
 *   shadow/cloud/grade uniform sync is not replicated here yet.
 *
 * @module compositor-v3/V3EffectsBridge
 */

import { createLogger } from '../core/log.js';
import { VEGETATION_ABOVE_WATER_LAYER } from '../core/render-layers.js';

const log = createLogger('V3EffectsBridge');

export class V3EffectsBridge {
  constructor() {
    this._warnedNoCompositor = false;
  }

  /** @returns {any|null} the V2 FloorCompositor (holds the effect instances + bus). @private */
  _compositor() {
    return window.MapShine?.floorCompositorV2
      ?? window.MapShine?.effectComposer?._floorCompositorV2
      ?? null;
  }

  /**
   * Tick effect simulations that must advance every frame. Candle meshes live in
   * the bus scene, so once ticked + attached they render in the bus pass.
   * @param {object} timeInfo
   * @param {any} busScene - FloorRenderBus._scene (candles attach here)
   */
  tickSims(timeInfo, busScene) {
    const fc = this._compositor();
    if (!fc) {
      if (!this._warnedNoCompositor) { log.debug('no V2 compositor yet; effects idle'); this._warnedNoCompositor = true; }
      return;
    }
    const candle = fc._candleFlamesEffect ?? null;
    const bush = fc._bushEffect ?? null;
    const tree = fc._treeEffect ?? null;

    if (candle) {
      try { if (busScene) candle.ensureMeshesAttached?.(busScene); } catch (_) {}
      try { candle.update?.(timeInfo); } catch (err) { log.debug('candle update failed', err); }
    }
    if (bush) { try { bush.update?.(timeInfo); } catch (err) { log.debug('bush update failed', err); } }
    if (tree) { try { tree.update?.(timeInfo); } catch (err) { log.debug('tree update failed', err); } }
  }

  /**
   * Collect bush/tree overlay roots as {shadows[], canopies[]} (draw order:
   * all shadows, then all canopies — matching V2).
   * @returns {{shadows: any[], canopies: any[]}}
   * @private
   */
  _vegetationRoots() {
    const fc = this._compositor();
    const shadows = [];
    const canopies = [];
    if (!fc) return { shadows, canopies };
    const maxFloor = Number.isFinite(Number(fc._renderBus?._visibleMaxFloorIndex))
      ? Number(fc._renderBus._visibleMaxFloorIndex) : 0;
    const collect = (effect) => {
      const overlays = effect?._overlays;
      if (!overlays?.values) return;
      for (const entry of overlays.values()) {
        const fi = Number(entry?.floorIndex);
        if (Number.isFinite(fi) && fi > maxFloor) continue;
        if (entry?.shadowMesh) shadows.push(entry.shadowMesh);
        if (entry?.mesh) canopies.push(entry.mesh);
      }
    };
    collect(fc._bushEffect);
    collect(fc._treeEffect);
    return { shadows, canopies };
  }

  /**
   * Make the vegetation canopy render correctly under V3.
   *
   * The canopy fragment multiplies its albedo by several terms driven by V2
   * producers that are dead under V3, each of which can zero it to black:
   *   • `uVegetationAmbientIllum` — V2 computes it from `LightingEffectV2`
   *     (never runs under V3) → ~0. We set it directly to the V3 scene ambient.
   *   • building / painted / cloud **received-shadow** applies —
   *     `c *= (1 - darken)` sampling V2 shadow producer textures that are empty
   *     under V3 → full darken → black. We disable the enables so they pass
   *     through. (The vegetation's own CAST shadow is a separate pass and is
   *     unaffected.) These are set by each effect's update() from params, and
   *     this runs after that (effects pass), so the override sticks for the draw.
   * @private
   */
  _syncVegetationUniforms() {
    const fc = this._compositor();
    if (!fc) return;
    const bg = this._sceneAmbientRgb();
    for (const effect of [fc._bushEffect, fc._treeEffect]) {
      const u = effect?._sharedUniforms;
      if (!u) continue;
      try { u.uVegetationAmbientIllum?.value?.set?.(bg[0], bg[1], bg[2]); } catch (_) {}
      // Disable received-shadow / lightning darkening (dead producers under V3).
      for (const key of ['uBuildingShadowEnabled', 'uPaintedShadowEnabled', 'uCloudShadowEnabled', 'uLightningVegetationEnabled']) {
        if (u[key]) { try { u[key].value = 0.0; } catch (_) {} }
      }
    }
  }

  /**
   * Scene ambient background = mix(ambientDaylight, ambientDarkness, darkness) —
   * the same value the V3 lighting pass uses for its unlit base, so vegetation
   * shading matches unlit surfaces.
   * @returns {number[]} [r,g,b]
   * @private
   */
  _sceneAmbientRgb() {
    const rgb = (c, fb) => { try { if (c && Array.isArray(c.rgb)) return c.rgb; } catch (_) {} return fb; };
    let darkness = 0; let daylight = [1, 1, 1]; let darknessColor = [0, 0, 0];
    try {
      const env = globalThis.canvas?.environment; const cols = globalThis.canvas?.colors;
      if (Number.isFinite(Number(env?.darknessLevel))) darkness = Math.max(0, Math.min(1, Number(env.darknessLevel)));
      daylight = rgb(cols?.ambientDaylight, daylight);
      darknessColor = rgb(cols?.ambientDarkness, darknessColor);
    } catch (_) {}
    return [
      daylight[0] + (darknessColor[0] - daylight[0]) * darkness,
      daylight[1] + (darknessColor[1] - daylight[1]) * darkness,
      daylight[2] + (darknessColor[2] - daylight[2]) * darkness,
    ];
  }

  /**
   * Additive glow groups (candle glow, …) for the lighting pass to render into
   * its illumination buffer, so they light the map underneath — the way V2 feeds
   * candle glow into its light buffer. Returns the live `_glowGroup`s; the light
   * pass renders each additively into scene.illum before `lit = albedo × illum`.
   * @returns {any[]}
   */
  getGlowGroups() {
    const fc = this._compositor();
    const out = [];
    const candleGlow = fc?._candleFlamesEffect?._glowGroup ?? null;
    if (candleGlow && candleGlow.children?.length > 0) out.push(candleGlow);
    return out;
  }

  /**
   * Composite vegetation overlays onto the lit scene (after lighting).
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera - main orthographic camera
   * @param {THREE.WebGLRenderTarget} litRT - scene.lit (rendered into, blended)
   * @returns {boolean} whether anything drew
   */
  compositeVegetation(renderer, camera, litRT) {
    if (!renderer || !camera || !litRT) return false;
    const { shadows, canopies } = this._vegetationRoots();
    if (!shadows.length && !canopies.length) return false;

    this._syncVegetationUniforms();

    const prevTarget = renderer.getRenderTarget?.();
    const prevAutoClear = renderer.autoClear;
    const prevDepthTest = renderer.depthTest;
    const prevDepthWrite = renderer.depthWrite;
    const prevLayerMask = camera.layers?.mask;
    let drew = false;
    try {
      renderer.setRenderTarget(litRT);
      renderer.autoClear = false;
      renderer.depthTest = false;
      renderer.depthWrite = false;
      if (camera.layers?.set) { camera.layers.set(VEGETATION_ABOVE_WATER_LAYER); camera.layers.enable(21); }
      for (const root of shadows) {
        if (!root || root.visible === false) continue;
        try { renderer.render(root, camera); drew = true; } catch (_) {}
      }
      for (const root of canopies) {
        if (!root || root.visible === false) continue;
        try { renderer.render(root, camera); drew = true; } catch (_) {}
      }
    } catch (err) {
      log.debug('vegetation composite failed', err);
    } finally {
      if (camera.layers && prevLayerMask != null) camera.layers.mask = prevLayerMask;
      renderer.depthTest = prevDepthTest;
      renderer.depthWrite = prevDepthWrite;
      renderer.autoClear = prevAutoClear;
      try { renderer.setRenderTarget(prevTarget ?? null); } catch (_) {}
    }
    return drew;
  }
}
