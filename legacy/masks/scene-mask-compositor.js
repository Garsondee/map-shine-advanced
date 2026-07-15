/**
 * @fileoverview Scene Mask Compositor — composites per-tile suffix masks into
 * scene-space textures for effect consumption.
 *
 * Instead of finding ONE large tile and loading its masks, this compositor:
 * 1. Accepts per-tile mask data from TileManager
 * 2. Composites them into scene-space canvases respecting tile transforms
 * 3. Applies per-mask-type composite modes (lighten for additive, source-over for replace)
 * 4. Filters by level band (only active-floor tiles contribute)
 * 5. Outputs THREE.Textures with valid .image (HTMLCanvasElement) for CPU consumers
 *
 * @module masks/scene-mask-compositor
 */

import { createLogger } from '../core/log.js';
import { getEffectMaskRegistry } from '../assets/loader.js';

const log = createLogger('SceneMaskCompositor');

/**
 * Composite modes per mask type.
 * - 'lighten': max blend — union of regions (fire, water, dust, ash)
 * - 'source-over': upper tile replaces lower (outdoors, windows, PBR, etc.)
 */
const COMPOSITE_MODES = {
  fire:         'lighten',
  water:        'lighten',
  dust:         'lighten',
  ash:          'lighten',
  outdoors:     'source-over',
  windows:      'source-over',
  structural:   'source-over',
  specular:     'source-over',
  roughness:    'source-over',
  normal:       'source-over',
  fluid:        'source-over',
  iridescence:  'source-over',
  prism:        'source-over',
  bush:         'source-over',
  tree:         'source-over',
};

/** Max dimension for data mask composites (fire, water, outdoors, dust, ash). */
const DATA_COMPOSITE_MAX = 4096;

/** Max dimension for visual/color mask composites (specular, normal, bush, tree). */
const VISUAL_COMPOSITE_MAX = 8192;

/** Masks containing high-frequency visual detail or RGBA color data. */
const VISUAL_MASK_IDS = new Set([
  'specular', 'roughness', 'normal', 'iridescence', 'prism', 'bush', 'tree'
]);

/** Color texture mask IDs that use sRGB color space. */
const COLOR_TEXTURE_IDS = new Set(['bush', 'tree']);

/**
 * Data-only mask IDs that should NOT have sRGB color space applied.
 * Everything not in VISUAL_MASK_IDS or COLOR_TEXTURE_IDS is a data mask,
 * but we also explicitly list some visual masks that are data-encoded.
 */
const DATA_ENCODED_MASKS = new Set(['normal', 'roughness', 'water']);

export class SceneMaskCompositor {
  constructor() {
    /** @type {Map<string, THREE.Texture>} Most recent compositor output. */
    this._lastOutput = new Map();
  }

  /**
   * Compose per-tile masks into scene-space textures.
   *
   * @param {Array<{tileDoc: object, masks: Map<string, {url: string, texture: THREE.Texture}>}>} tileMaskEntries
   *   Array of tile entries, each with tileDoc and a Map of maskType → {url, texture}.
   * @param {object} scene - Foundry scene (canvas.scene)
   * @param {object} [options]
   * @param {object} [options.levelContext] - Active level band {bottom, top} for filtering
   * @returns {{masks: Array<{id, suffix, type, texture, required}>, width: number, height: number}|null}
   */
  compose(tileMaskEntries, scene, options = {}) {
    const THREE = window.THREE;
    if (!THREE || !tileMaskEntries || tileMaskEntries.length === 0) return null;

    const d = canvas?.dimensions;
    const sr = d?.sceneRect;
    if (!sr || !sr.width || !sr.height) return null;

    const sceneX = sr.x ?? 0;
    const sceneY = sr.y ?? 0;
    const sceneW = sr.width;
    const sceneH = sr.height;

    // Collect all mask types present across all tiles.
    const allMaskTypes = new Set();
    for (const entry of tileMaskEntries) {
      if (!entry.masks) continue;
      for (const key of entry.masks.keys()) {
        allMaskTypes.add(key);
      }
    }

    if (allMaskTypes.size === 0) return null;

    // Sort tiles by Z-order: lowest sort key first, then lowest elevation.
    // Upper tiles composite on top of lower tiles.
    const sortedEntries = [...tileMaskEntries].sort((a, b) => {
      const elevA = Number(a.tileDoc?.elevation ?? 0);
      const elevB = Number(b.tileDoc?.elevation ?? 0);
      if (elevA !== elevB) return elevA - elevB;
      const sortA = Number(a.tileDoc?.sort ?? 0);
      const sortB = Number(b.tileDoc?.sort ?? 0);
      return sortA - sortB;
    });

    const registry = getEffectMaskRegistry();
    const compositeMasks = [];

    // Determine GPU max texture size for output capping.
    const renderer = window.MapShine?.renderer;
    const maxTex = renderer?.capabilities?.maxTextureSize ?? 16384;

    for (const maskType of allMaskTypes) {
      const def = registry[maskType];
      if (!def) continue;

      // Determine output resolution based on mask category.
      const isVisual = VISUAL_MASK_IDS.has(maskType);
      const targetMax = Math.min(
        isVisual ? VISUAL_COMPOSITE_MAX : DATA_COMPOSITE_MAX,
        maxTex
      );

      const scale = Math.min(1.0, targetMax / Math.max(1, sceneW), targetMax / Math.max(1, sceneH));
      const outW = Math.max(1, Math.round(sceneW * scale));
      const outH = Math.max(1, Math.round(sceneH * scale));

      // Create compositor canvas.
      const canvasEl = document.createElement('canvas');
      canvasEl.width = outW;
      canvasEl.height = outH;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) continue;

      ctx.clearRect(0, 0, outW, outH);

      // Apply composite mode for this mask type.
      const mode = COMPOSITE_MODES[maskType] || 'source-over';

      let anyDrawn = false;

      for (const entry of sortedEntries) {
        const maskEntry = entry.masks?.get(maskType);
        if (!maskEntry?.texture) continue;

        const img = maskEntry.texture.image;
        if (!img) continue;

        const tileDoc = entry.tileDoc;
        const tileX = Number(tileDoc?.x ?? 0);
        const tileY = Number(tileDoc?.y ?? 0);
        const tileW = Number(tileDoc?.width ?? 0);
        const tileH = Number(tileDoc?.height ?? 0);
        if (!tileW || !tileH) continue;

        // Compute tile position in compositor canvas coords.
        const u0 = (tileX - sceneX) / sceneW;
        const v0 = (tileY - sceneY) / sceneH;
        const uW = tileW / sceneW;
        const vH = tileH / sceneH;

        const dx = Math.round(u0 * outW);
        const dy = Math.round(v0 * outH);
        const dw = Math.max(1, Math.round(uW * outW));
        const dh = Math.max(1, Math.round(vH * outH));

        // Read tile transform properties.
        const scaleX = Number(tileDoc?.texture?.scaleX ?? 1);
        const scaleY = Number(tileDoc?.texture?.scaleY ?? 1);
        const rotation = Number(tileDoc?.rotation ?? 0);

        ctx.save();
        ctx.globalCompositeOperation = mode;

        // Apply flip and rotation transforms around tile center.
        const cx = dx + dw / 2;
        const cy = dy + dh / 2;

        const needsTransform = (scaleX < 0 || scaleY < 0 || rotation !== 0);
        if (needsTransform) {
          ctx.translate(cx, cy);
          if (rotation !== 0) {
            ctx.rotate(rotation * Math.PI / 180);
          }
          if (scaleX < 0 || scaleY < 0) {
            ctx.scale(Math.sign(scaleX) || 1, Math.sign(scaleY) || 1);
          }
          ctx.translate(-cx, -cy);
        }

        try {
          ctx.drawImage(img, 0, 0, img.width, img.height, dx, dy, dw, dh);
          anyDrawn = true;
        } catch (e) {
          log.debug(`Failed to blit mask ${maskType} for tile ${tileDoc?.id}:`, e);
        }

        ctx.restore();
      }

      if (!anyDrawn) continue;

      // Create THREE.Texture from the compositor canvas.
      const outTex = new THREE.Texture(canvasEl);
      outTex.wrapS = THREE.ClampToEdgeWrapping;
      outTex.wrapT = THREE.ClampToEdgeWrapping;
      outTex.generateMipmaps = false;
      outTex.minFilter = THREE.LinearFilter;
      outTex.magFilter = THREE.LinearFilter;
      outTex.flipY = false;

      // Apply correct color space.
      const isDataEncoded = DATA_ENCODED_MASKS.has(maskType);
      const isColor = COLOR_TEXTURE_IDS.has(maskType);
      if (isColor && THREE.SRGBColorSpace) {
        outTex.colorSpace = THREE.SRGBColorSpace;
      } else if (isDataEncoded) {
        outTex.colorSpace = THREE.NoColorSpace || '';
      } else if (THREE.SRGBColorSpace) {
        // Non-data visual masks (specular, iridescence, prism) — sRGB
        outTex.colorSpace = THREE.SRGBColorSpace;
      }

      outTex.needsUpdate = true;

      compositeMasks.push({
        id: maskType,
        suffix: def.suffix,
        type: maskType,
        texture: outTex,
        required: !!def.required
      });
    }

    if (compositeMasks.length === 0) return null;

    // Dispose previous output textures.
    this._disposeLastOutput();

    // Store new output for future disposal.
    for (const m of compositeMasks) {
      this._lastOutput.set(m.id, m.texture);
    }

    const outW = compositeMasks[0]?.texture?.image?.width ?? 0;
    const outH = compositeMasks[0]?.texture?.image?.height ?? 0;

    log.info(`Composed ${compositeMasks.length} mask types from ${tileMaskEntries.length} tiles (${outW}×${outH})`);

    return { masks: compositeMasks, width: outW, height: outH };
  }

  /**
   * Merge compositor output masks with an existing bundle's masks.
   * Compositor masks take priority; any mask type not produced by the
   * compositor is preserved from the original bundle.
   *
   * @param {Array} originalMasks - Original bundle.masks array
   * @param {Array} compositorMasks - Compositor output masks array
   * @returns {Array} Merged masks array
   */
  mergeMasks(originalMasks, compositorMasks) {
    if (!compositorMasks?.length) return originalMasks || [];
    if (!originalMasks?.length) return compositorMasks;

    const compositorIds = new Set(compositorMasks.map(m => m.id));
    // Keep original masks that the compositor didn't produce.
    const kept = originalMasks.filter(m => !compositorIds.has(m.id));
    return [...kept, ...compositorMasks];
  }

  /**
   * Dispose all stored output textures.
   */
  _disposeLastOutput() {
    for (const tex of this._lastOutput.values()) {
      try { tex?.dispose?.(); } catch (_) {}
    }
    this._lastOutput.clear();
  }

  /**
   * Full cleanup on scene teardown.
   */
  dispose() {
    this._disposeLastOutput();
  }
}
