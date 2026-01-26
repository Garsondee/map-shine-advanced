/**
 * @fileoverview Scene composer - creates 2.5D scene from battlemap assets
 * Handles scene setup, camera positioning, and grid alignment
 * @module scene/composer
 */

import { createLogger } from '../core/log.js';
import * as assetLoader from '../assets/loader.js';
import { weatherController } from '../core/WeatherController.js';
import { globalLoadingProfiler } from '../core/loading-profiler.js';

const log = createLogger('SceneComposer');

let _lpSeq = 0;

// Perspective strength multiplier for the camera.
// 1.0  = mathematically exact 1:1 ground-plane mapping (stronger perspective)
// <1.0 = flatter perspective (more orthographic-feeling)
// >1.0 = more exaggerated perspective
// NOTE: Values very far from 1.0 can introduce slight desync vs PIXI; small tweaks
// like 0.9–0.95 are usually safe. Adjust to taste.
const PERSPECTIVE_STRENGTH = 1.0;

/**
 * Scene composer class - manages three.js scene setup for battlemaps
 */
export class SceneComposer {
  constructor() {
    /** @type {THREE.Scene|null} */
    this.scene = null;
    
    /** @type {THREE.PerspectiveCamera|null} */
    this.camera = null;
    
    /** @type {MapAssetBundle|null} */
    this.currentBundle = null;
    
    /** @type {THREE.Mesh|null} */
    this.basePlaneMesh = null;
    
    /** @type {Object} */
    this.foundrySceneData = null;

    /** @type {number|undefined} Canonical ground plane Z (set in setupCamera) */
    this.groundZ = undefined;

    /** @type {number|undefined} Top of the logical world volume (for weather, fog, etc.) */
    this.worldTopZ = undefined;

    /** @type {number|undefined} Preferred emitter Z for world-space weather volumes */
    this.weatherEmitterZ = undefined;

    // Track owned GPU resources so scene transitions don't leak.
    /** @type {THREE.Mesh|null} */
    this._backgroundMesh = null;
    /** @type {THREE.Mesh|null} */
    this._backFaceMesh = null;
    /** @type {Set<THREE.Texture>} */
    this._ownedTextures = new Set();

    // Cache the last successful basePath used for suffix-mask discovery so that
    // scene rebuilds (including grid type changes) do not depend on transient
    // canvas/tile readiness.
    this._lastMaskBasePath = null;
  }

  _markOwnedTexture(texture) {
    if (!texture) return texture;
    try {
      if (!texture.userData) texture.userData = {};
      texture.userData._mapShineOwned = true;
      this._ownedTextures.add(texture);
    } catch (e) {
    }
    return texture;
  }

  _disposeOwnedTexture(texture) {
    if (!texture) return;
    try {
      const owned = !!texture?.userData?._mapShineOwned || this._ownedTextures.has(texture);
      if (owned && typeof texture.dispose === 'function') {
        texture.dispose();
      }
    } catch (e) {
    }
  }

  async _loadMasksOnlyForBasePath(basePath, options = {}) {
    try {
      const res = await assetLoader.loadAssetBundle(basePath, null, { skipBaseTexture: true, ...options });
      if (res?.success && res?.bundle?.masks && Array.isArray(res.bundle.masks)) {
        return res.bundle.masks;
      }
    } catch (e) {
    }
    return [];
  }

  _iterTileDocs(foundryScene = null) {
    try {
      let tiles = canvas?.scene?.tiles ?? null;
      if (!tiles || (typeof tiles.size === 'number' && tiles.size === 0)) {
        tiles = foundryScene?.tiles ?? null;
      }
      if (!tiles) return [];

      if (Array.isArray(tiles)) return tiles;
      if (Array.isArray(tiles?.contents)) return tiles.contents;
      if (typeof tiles?.values === 'function') return Array.from(tiles.values());
      return [];
    } catch (e) {
      return [];
    }
  }

  async _probeBestMaskBasePath(foundryScene = null) {
    // Robust mask-source resolution:
    // When the scene has no background and tile heuristics fail (common during
    // grid/dimension rebuilds), probe candidate basePaths and pick the one that
    // actually contains the expected suffix masks.
    try {
      const tiles = this._iterTileDocs(foundryScene);
      if (!tiles.length) return null;

      const candidates = new Set();
      for (const tileDoc of tiles) {
        if (tileDoc?.hidden) continue;
        const src = tileDoc?.texture?.src;
        if (typeof src !== 'string' || src.trim().length === 0) continue;
        const basePath = this.extractBasePath(src.trim());
        if (basePath) candidates.add(basePath);
      }

      if (!candidates.size) return null;

      const keyMasks = ['specular', 'water', 'outdoors'];

      let bestPath = null;
      let bestScore = -Infinity;

      for (const basePath of candidates) {
        const masks = await this._loadMasksOnlyForBasePath(basePath, { suppressProbeErrors: true });
        if (!Array.isArray(masks) || masks.length === 0) continue;

        const ids = new Set(masks.map((m) => String(m?.id ?? m?.type ?? '').toLowerCase()).filter(Boolean));

        // Score:
        // - Prefer more masks overall.
        // - Strongly prefer presence of the key masks that gate many effects.
        let score = masks.length;
        for (const k of keyMasks) {
          if (ids.has(k)) score += 10;
        }

        if (score > bestScore) {
          bestScore = score;
          bestPath = basePath;
        }

        // If we found a basePath with all key masks, stop early.
        if (keyMasks.every((k) => ids.has(k))) {
          bestPath = basePath;
          break;
        }
      }

      return bestPath;
    } catch (e) {
      return null;
    }
  }

  _getLargeSceneMaskTiles(foundryScene = null) {
    try {
      // Prefer canvas data when available, but fall back to the provided Foundry scene.
      // During some grid transitions (notably hex), canvas state can be temporarily
      // inconsistent while Foundry is rebuilding dimensions.
      let tiles = canvas?.scene?.tiles ?? null;
      if (!tiles || (typeof tiles.size === 'number' && tiles.size === 0)) {
        tiles = foundryScene?.tiles ?? null;
      }
      const d = canvas?.dimensions ?? foundryScene?.dimensions;

      if (!tiles || !d) return [];

      // Prefer explicit sceneRect, otherwise derive from dimension fields.
      const sr = d.sceneRect ?? {
        x: Number.isFinite(d.sceneX) ? d.sceneX : 0,
        y: Number.isFinite(d.sceneY) ? d.sceneY : 0,
        width: d.sceneWidth ?? d.width ?? 0,
        height: d.sceneHeight ?? d.height ?? 0
      };

      if (!sr || !Number.isFinite(sr.width) || !Number.isFinite(sr.height)) return [];

      const sceneX = sr.x ?? 0;
      const sceneY = sr.y ?? 0;
      const sceneW = sr.width ?? 0;
      const sceneH = sr.height ?? 0;
      if (!sceneW || !sceneH) return [];

      const foregroundElevation = canvas?.scene?.foregroundElevation ?? Number.POSITIVE_INFINITY;

      const tol = 1;
      const minArea = sceneW * sceneH * 0.2;
      const out = [];

      // tiles may be an Array, a Foundry Collection (with .contents), or something iterable.
      const tileIter = Array.isArray(tiles)
        ? tiles
        : (Array.isArray(tiles?.contents) ? tiles.contents : (tiles?.values?.() ?? tiles));
      for (const tileDoc of tileIter) {
        const src = tileDoc?.texture?.src;
        if (typeof src !== 'string' || src.trim().length === 0) continue;

        const x = Number.isFinite(tileDoc?.x) ? tileDoc.x : 0;
        const y = Number.isFinite(tileDoc?.y) ? tileDoc.y : 0;
        const w = Number.isFinite(tileDoc?.width) ? tileDoc.width : 0;
        const h = Number.isFinite(tileDoc?.height) ? tileDoc.height : 0;
        if (!w || !h) continue;

        const area = w * h;
        if (area < minArea) continue;

        const yAligned = Math.abs(y - sceneY) <= tol && Math.abs(h - sceneH) <= tol;
        if (!yAligned) continue;

        out.push({
          tileDoc,
          src: src.trim(),
          basePath: this.extractBasePath(src.trim()),
          rect: { x, y, w, h }
        });
      }

      out.sort((a, b) => (a.rect.x - b.rect.x));
      return out;
    } catch (e) {
    }
    return [];
  }

  _computeSceneMaskCompositeLayout(tiles, foundryScene = null) {
    try {
      const d = canvas?.dimensions ?? foundryScene?.dimensions;
      const sr = d?.sceneRect ?? {
        x: Number.isFinite(d.sceneX) ? d.sceneX : 0,
        y: Number.isFinite(d.sceneY) ? d.sceneY : 0,
        width: d.sceneWidth ?? d.width ?? 0,
        height: d.sceneHeight ?? d.height ?? 0
      };

      if (!sr) return null;

      const sceneX = sr.x ?? 0;
      const sceneY = sr.y ?? 0;
      const sceneW = sr.width ?? 0;
      const sceneH = sr.height ?? 0;
      if (!sceneW || !sceneH) return null;

      if (!Array.isArray(tiles) || tiles.length < 2) return null;

      const tol = 1;
      const segments = [];
      for (const t of tiles) {
        const r = t?.rect;
        if (!r) continue;
        const coversY = Math.abs(r.y - sceneY) <= tol && Math.abs(r.h - sceneH) <= tol;
        if (!coversY) continue;
        const x0 = r.x;
        const x1 = r.x + r.w;
        const sx0 = Math.max(sceneX, Math.min(sceneX + sceneW, x0));
        const sx1 = Math.max(sceneX, Math.min(sceneX + sceneW, x1));
        if (sx1 - sx0 <= tol) continue;

        segments.push({
          basePath: t.basePath,
          src: t.src,
          tileDoc: t.tileDoc,
          sceneX,
          sceneY,
          sceneW,
          sceneH,
          segX0: sx0,
          segX1: sx1
        });
      }

      if (segments.length < 2) return null;

      segments.sort((a, b) => a.segX0 - b.segX0);
      let covered = 0;
      let cursor = sceneX;
      for (const s of segments) {
        if (s.segX1 <= cursor + tol) continue;
        if (s.segX0 > cursor + tol) {
          cursor = s.segX0;
        }
        const add = Math.max(0, s.segX1 - cursor);
        covered += add;
        cursor = Math.max(cursor, s.segX1);
      }

      const coverFrac = covered / sceneW;
      if (coverFrac < 0.95) return null;

      return { sceneX, sceneY, sceneW, sceneH, segments };
    } catch (e) {
      return null;
    }
  }

  _getFullSceneMaskTileBasePaths() {
    try {
      const tiles = canvas?.scene?.tiles;
      const d = canvas?.dimensions;
      const sr = d?.sceneRect;
      if (!tiles || !sr) return [];

      const sceneX = sr.x ?? 0;
      const sceneY = sr.y ?? 0;
      const sceneW = sr.width ?? 0;
      const sceneH = sr.height ?? 0;
      if (!sceneW || !sceneH) return [];
      const tol = 1;

      const out = new Set();
      for (const tileDoc of tiles) {
        if (tileDoc?.hidden) continue;
        const src = tileDoc?.texture?.src;
        if (typeof src !== 'string' || src.trim().length === 0) continue;

        const x = Number.isFinite(tileDoc?.x) ? tileDoc.x : 0;
        const y = Number.isFinite(tileDoc?.y) ? tileDoc.y : 0;
        const w = Number.isFinite(tileDoc?.width) ? tileDoc.width : 0;
        const h = Number.isFinite(tileDoc?.height) ? tileDoc.height : 0;
        if (!w || !h) continue;

        const coversScene = (
          Math.abs(x - sceneX) <= tol &&
          Math.abs(y - sceneY) <= tol &&
          Math.abs(w - sceneW) <= tol &&
          Math.abs(h - sceneH) <= tol
        );
        if (!coversScene) continue;

        out.add(this.extractBasePath(src.trim()));
      }

      return Array.from(out);
    } catch (e) {
      return [];
    }
  }

  async _buildUnionMaskForBasePaths(maskId, basePaths) {
    const THREE = window.THREE;
    if (!THREE) return null;
    if (!maskId || !Array.isArray(basePaths) || basePaths.length === 0) return null;

    const registry = assetLoader.getEffectMaskRegistry?.() || {};
    const def = registry?.[maskId] || null;
    const suffix = def?.suffix;
    if (typeof suffix !== 'string' || !suffix) return null;

    const sourceMasks = [];
    let outW = 0;
    let outH = 0;

    for (const basePath of basePaths) {
      if (typeof basePath !== 'string' || !basePath.trim()) continue;
      const masks = await this._loadMasksOnlyForBasePath(basePath.trim());
      const m = masks.find((x) => x?.id === maskId || x?.type === maskId);
      const tex = m?.texture;
      const img = tex?.image;
      if (!img) continue;

      const w = img?.width ?? 0;
      const h = img?.height ?? 0;
      if (!w || !h) continue;

      outW = Math.max(outW, w);
      outH = Math.max(outH, h);
      sourceMasks.push({ tex, img });
    }

    if (!sourceMasks.length || !outW || !outH) return null;

    const canvasEl = document.createElement('canvas');
    canvasEl.width = outW;
    canvasEl.height = outH;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, outW, outH);

    let prevCompositeOp = null;
    try {
      prevCompositeOp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighten';
    } catch (e) {
      prevCompositeOp = null;
    }

    for (const s of sourceMasks) {
      try {
        ctx.drawImage(s.img, 0, 0, s.img.width, s.img.height, 0, 0, outW, outH);
      } catch (e) {
      }
    }

    if (prevCompositeOp !== null) {
      try {
        ctx.globalCompositeOperation = prevCompositeOp;
      } catch (e) {
      }
    }

    const outTex = this._markOwnedTexture(new THREE.Texture(canvasEl));
    outTex.needsUpdate = true;

    const isDataTexture = ['normal', 'roughness', 'water'].includes(maskId);
    if (THREE.SRGBColorSpace && !isDataTexture) {
      outTex.colorSpace = THREE.SRGBColorSpace;
    }

    outTex.minFilter = THREE.LinearFilter;
    outTex.magFilter = THREE.LinearFilter;
    outTex.generateMipmaps = false;
    outTex.flipY = false;

    return {
      id: maskId,
      suffix,
      type: maskId,
      texture: outTex,
      required: !!def?.required
    };
  }

  async _buildCompositeSceneMasks(layout, perBaseMasks) {
    const THREE = window.THREE;
    if (!THREE || !layout) return null;

    const renderer = window.MapShine?.renderer;
    const maxTex = renderer?.capabilities?.maxTextureSize;
    const cap = Number.isFinite(maxTex) ? Math.max(256, Math.floor(maxTex)) : 4096;
    const hardCap = Math.min(cap, 8192);

    const sceneW = layout.sceneW;
    const sceneH = layout.sceneH;
    const scale = Math.min(1.0, hardCap / Math.max(1, sceneW), hardCap / Math.max(1, sceneH));

    const outW = Math.max(1, Math.round(sceneW * scale));
    const outH = Math.max(1, Math.round(sceneH * scale));

    const registry = assetLoader.getEffectMaskRegistry?.() || {};
    const compositeMasks = [];

    for (const [maskId, def] of Object.entries(registry)) {
      const suffix = def?.suffix;
      if (typeof suffix !== 'string' || !suffix) continue;

      const canvasEl = document.createElement('canvas');
      canvasEl.width = outW;
      canvasEl.height = outH;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) continue;

      ctx.clearRect(0, 0, outW, outH);

      let prevCompositeOp = null;
      if (maskId === 'water') {
        try {
          prevCompositeOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'lighten';
        } catch (e) {
          prevCompositeOp = null;
        }
      }

      let any = false;

      for (const seg of layout.segments) {
        const masks = perBaseMasks.get(seg.basePath) || [];
        const m = masks.find((x) => x?.id === maskId || x?.type === maskId);
        const tex = m?.texture;
        const img = tex?.image;
        if (!img) continue;

        const segU0 = (seg.segX0 - layout.sceneX) / layout.sceneW;
        const segU1 = (seg.segX1 - layout.sceneX) / layout.sceneW;
        const dx = Math.round(segU0 * outW);
        const dw = Math.max(1, Math.round((segU1 - segU0) * outW));

        try {
          ctx.drawImage(img, 0, 0, img.width, img.height, dx, 0, dw, outH);
          any = true;
        } catch (e) {
        }
      }

      if (prevCompositeOp !== null) {
        try {
          ctx.globalCompositeOperation = prevCompositeOp;
        } catch (e) {
        }
      }

      if (!any) continue;

      const outTex = this._markOwnedTexture(new THREE.Texture(canvasEl));
      outTex.needsUpdate = true;

      const isDataTexture = ['normal', 'roughness', 'water'].includes(maskId);
      if (THREE.SRGBColorSpace && !isDataTexture) {
        outTex.colorSpace = THREE.SRGBColorSpace;
      }

      outTex.minFilter = THREE.LinearFilter;
      outTex.magFilter = THREE.LinearFilter;
      outTex.generateMipmaps = false;

      // Invariant: MapShine mask textures use flipY=false, and coordinate
      // alignment is handled via geometry/shader conventions.
      outTex.flipY = false;

      compositeMasks.push({
        id: maskId,
        suffix,
        type: maskId,
        texture: outTex,
        required: !!def?.required
      });
    }

    return { masks: compositeMasks, width: outW, height: outH };
  }

  async _buildCompositeSceneAlbedo(layout) {
    const THREE = window.THREE;
    if (!THREE || !layout) return null;

    const renderer = window.MapShine?.renderer;
    const maxTex = renderer?.capabilities?.maxTextureSize;
    const cap = Number.isFinite(maxTex) ? Math.max(256, Math.floor(maxTex)) : 4096;
    const hardCap = Math.min(cap, 8192);

    const sceneW = layout.sceneW;
    const sceneH = layout.sceneH;
    const scale = Math.min(1.0, hardCap / Math.max(1, sceneW), hardCap / Math.max(1, sceneH));

    const outW = Math.max(1, Math.round(sceneW * scale));
    const outH = Math.max(1, Math.round(sceneH * scale));

    const canvasEl = document.createElement('canvas');
    canvasEl.width = outW;
    canvasEl.height = outH;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, outW, outH);

    const loadTextureFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
    if (!loadTextureFn) return null;

    let any = false;

    for (const seg of layout.segments) {
      const src = seg?.src;
      if (typeof src !== 'string' || !src.trim()) continue;

      let img = null;
      try {
        const pixiTexture = await loadTextureFn(src.trim());
        const resource = pixiTexture?.baseTexture?.resource;
        img = resource?.source || null;
      } catch (e) {
        img = null;
      }

      if (!img) continue;

      const segU0 = (seg.segX0 - layout.sceneX) / layout.sceneW;
      const segU1 = (seg.segX1 - layout.sceneX) / layout.sceneW;
      const dx = Math.round(segU0 * outW);
      const dw = Math.max(1, Math.round((segU1 - segU0) * outW));

      try {
        ctx.drawImage(img, 0, 0, img.width, img.height, dx, 0, dw, outH);
        any = true;
      } catch (e) {
      }
    }

    if (!any) return null;

    const outTex = this._markOwnedTexture(new THREE.Texture(canvasEl));
    outTex.needsUpdate = true;
    if (THREE.SRGBColorSpace) {
      outTex.colorSpace = THREE.SRGBColorSpace;
    }
    outTex.minFilter = THREE.LinearFilter;
    outTex.magFilter = THREE.LinearFilter;
    outTex.generateMipmaps = false;
    outTex.flipY = false;

    return { texture: outTex, width: outW, height: outH };
  }

  _resolveMaskSourceSrc(foundryScene) {
    try {
      const override = foundryScene?.getFlag?.('map-shine-advanced', 'maskSource');
      if (typeof override === 'string' && override.trim().length > 0) {
        return override.trim();
      }
    } catch (e) {
    }

    // Prefer the scene background image when available. Many premium/complex maps
    // use multiple full-scene tiles (e.g. *-Overlay) which are not the correct
    // source for suffix-mask discovery.
    try {
      const bg = foundryScene?.background?.src;
      if (typeof bg === 'string' && bg.trim().length > 0) {
        return bg.trim();
      }
    } catch (e) {
    }

    // Auto-detect: choose a likely full-scene "base" tile (common for multi-layer maps)
    try {
      const d = canvas?.dimensions ?? foundryScene?.dimensions;
      const sr = d?.sceneRect ?? (d ? {
        x: Number.isFinite(d.sceneX) ? d.sceneX : 0,
        y: Number.isFinite(d.sceneY) ? d.sceneY : 0,
        width: d.sceneWidth ?? d.width ?? 0,
        height: d.sceneHeight ?? d.height ?? 0
      } : null);
      if (!sr) return null;

      const sceneX = sr.x ?? 0;
      const sceneY = sr.y ?? 0;
      const sceneW = sr.width ?? (d?.sceneWidth ?? d?.width ?? 0);
      const sceneH = sr.height ?? (d?.sceneHeight ?? d?.height ?? 0);
      if (!sceneW || !sceneH) return null;

      const foregroundElevation = canvas?.scene?.foregroundElevation ?? Number.POSITIVE_INFINITY;

      // IMPORTANT:
      // Only consider large "ground" tiles as mask sources.
      // If we allow any tile to be chosen here, small props (boats, decals) can
      // accidentally become the suffix-mask discovery source, causing their _Water
      // mask to be treated as a scene-wide water mask and stretched across the map.
      const candidates = this._getLargeSceneMaskTiles?.(foundryScene) || [];
      if (!Array.isArray(candidates) || candidates.length === 0) {
        // Fallback: choose the largest visible tile in the scene.
        // Some scenes (especially with non-square grid geometry) may temporarily
        // fail our “sceneRect-aligned” heuristic due to fractional offsets.
        let tiles = canvas?.scene?.tiles ?? foundryScene?.tiles ?? null;
        if (tiles && typeof tiles.size === 'number' && tiles.size === 0) tiles = foundryScene?.tiles ?? null;

        const iter = Array.isArray(tiles)
          ? tiles
          : (Array.isArray(tiles?.contents) ? tiles.contents : (tiles?.values?.() ?? null));

        if (iter) {
          let best = null;
          let bestArea = -Infinity;
          for (const tileDoc of iter) {
            const src = tileDoc?.texture?.src;
            if (typeof src !== 'string' || src.trim().length === 0) continue;
            if (tileDoc?.hidden) continue;

            const w = Number.isFinite(tileDoc?.width) ? tileDoc.width : 0;
            const h = Number.isFinite(tileDoc?.height) ? tileDoc.height : 0;
            const area = Math.max(0, w * h);
            if (area > bestArea) {
              bestArea = area;
              best = src.trim();
            }
          }
          if (best) return best;
        }

        return null;
      }

      let bestSrc = null;
      let bestScore = -Infinity;

      for (const entry of candidates) {
        const tileDoc = entry?.tileDoc;
        const src = tileDoc?.texture?.src;
        if (typeof src !== 'string' || src.trim().length === 0) continue;

        if (tileDoc?.hidden) continue;

        let score = 0;

        // Prefer non-overhead tiles
        const elev = Number.isFinite(tileDoc?.elevation) ? tileDoc.elevation : 0;
        if (Number.isFinite(foregroundElevation) && elev >= foregroundElevation) score -= 1000;

        // Prefer tiles that cover the full sceneRect
        const tol = 1;
        const coversScene = (
          Math.abs((tileDoc?.x ?? 0) - sceneX) <= tol &&
          Math.abs((tileDoc?.y ?? 0) - sceneY) <= tol &&
          Math.abs((tileDoc?.width ?? 0) - sceneW) <= tol &&
          Math.abs((tileDoc?.height ?? 0) - sceneH) <= tol
        );
        if (coversScene) score += 50;

        // Prefer common naming conventions
        try {
          const filename = src.substring(src.lastIndexOf('/') + 1).toLowerCase();
          if (filename.includes('ground')) score += 15;
          if (filename.includes('base')) score += 5;
          if (filename.includes('albedo')) score += 2;
        } catch (e) {
        }

        // Prefer larger tiles in general
        const area = Math.max(0, (tileDoc?.width ?? 0) * (tileDoc?.height ?? 0));
        score += Math.min(10, Math.log2(area + 1));

        // Prefer lower elevations
        score -= elev * 0.01;

        if (score > bestScore) {
          bestScore = score;
          bestSrc = src.trim();
        }
      }

      return bestSrc;
    } catch (e) {
    }

    return null;
  }

  /**
   * Initialize a new scene from Foundry scene data
   * @param {Scene} foundryScene - Foundry VTT scene object
   * @param {number} viewportWidth - Viewport width in pixels
   * @param {number} viewportHeight - Viewport height in pixels
   * @param {{onProgress?: (loaded:number, total:number, asset:string)=>void}} [options]
   * @returns {Promise<{scene: THREE.Scene, camera: THREE.Camera, bundle: MapAssetBundle}>}
   */
  async initialize(foundryScene, viewportWidth, viewportHeight, options = {}) {
    log.info(`Initializing scene: ${foundryScene?.name || 'unnamed'}`);

    const lp = globalLoadingProfiler;
    const doLoadProfile = !!lp?.enabled;
    const spanToken = doLoadProfile ? (++_lpSeq) : 0;

    const THREE = window.THREE;
    if (!THREE) {
      throw new Error('three.js not loaded');
    }

    // Validate foundryScene exists
    if (!foundryScene) {
      throw new Error('No Foundry scene provided');
    }

    // Validate dimensions exist (required for camera/plane setup)
    if (!foundryScene.dimensions) {
      throw new Error('Scene has no dimensions data');
    }

    // Store Foundry scene data with safe defaults.
    // Foundry v13 uses background.offsetX/offsetY (not shiftX/shiftY) as the primary
    // mechanism to align the map image to the grid. These offsets are already reflected
    // in `foundryScene.dimensions.sceneX/sceneY`.
    this.foundrySceneData = {
      // Full canvas dimensions (includes padding)
      width: foundryScene.dimensions.width || 1000,
      height: foundryScene.dimensions.height || 1000,

      // Scene rectangle (actual map bounds within the padded canvas)
      sceneX: Number.isFinite(foundryScene.dimensions.sceneX) ? foundryScene.dimensions.sceneX : 0,
      sceneY: Number.isFinite(foundryScene.dimensions.sceneY) ? foundryScene.dimensions.sceneY : 0,
      sceneWidth: foundryScene.dimensions.sceneWidth || foundryScene.dimensions.width || 1000,
      sceneHeight: foundryScene.dimensions.sceneHeight || foundryScene.dimensions.height || 1000,

      // Useful for debugging/diagnostics
      backgroundOffsetX: Number.isFinite(foundryScene.background?.offsetX) ? foundryScene.background.offsetX : 0,
      backgroundOffsetY: Number.isFinite(foundryScene.background?.offsetY) ? foundryScene.background.offsetY : 0,

      gridSize: foundryScene.grid?.size || 100,
      gridType: foundryScene.grid?.type || 1,
      padding: foundryScene.padding || 0,
      backgroundColor: foundryScene.backgroundColor || '#999999'
    };

    // Create three.js scene
    this.scene = new THREE.Scene();
    // Remove explicit scene background to rely on renderer clear color (which is forced to black)
    // this.scene.background = new THREE.Color(0x000000); 
    
    // Check if scene has a background image
    const hasBackgroundImage = foundryScene.background?.src && 
                               typeof foundryScene.background.src === 'string' && 
                               foundryScene.background.src.trim().length > 0;
    
    let baseTexture = null;
    let bgPath = null;

    // Determine which source image drives suffix-mask discovery.
    // This may be the scene background or a full-scene tile (common for layered maps).
    const maskSourceSrc = this._resolveMaskSourceSrc(foundryScene);
    if (maskSourceSrc) {
      bgPath = this.extractBasePath(maskSourceSrc);
      log.info(`Mask source: ${maskSourceSrc}`);
      log.info(`Loading effect masks for: ${bgPath}`);
    }

    // If mask source resolution failed (or a previous run discovered a good basePath),
    // use a cached/probed basePath. This is critical for robustness during grid
    // type changes where canvas/tile readiness can be transient.
    if (!bgPath && this._lastMaskBasePath) {
      bgPath = this._lastMaskBasePath;
      log.info(`Using cached mask basePath: ${bgPath}`);
    }

    if (hasBackgroundImage) {
      // Use Foundry's already-loaded background texture instead of reloading
      // Foundry's canvas.primary.background.texture is already loaded and accessible
      if (doLoadProfile) {
        try {
          lp.begin(`sceneComposer.getFoundryBackgroundTexture:${spanToken}`);
        } catch (e) {
        }
      }
      try {
        baseTexture = await this.getFoundryBackgroundTexture(foundryScene);
      } finally {
        if (doLoadProfile) {
          try {
            lp.end(`sceneComposer.getFoundryBackgroundTexture:${spanToken}`);
          } catch (e) {
          }
        }
      }
      if (!baseTexture) {
        log.warn('Could not access Foundry background texture, using fallback');
      }
    } else {
      log.info('Scene has no background image, using solid color fallback');
    }
    
    // Load effect masks if we have a background path
    let result = { success: false, bundle: { masks: [] }, warnings: [] };
    if (bgPath) {
      if (doLoadProfile) {
        try {
          lp.begin(`sceneComposer.loadAssetBundle:${spanToken}`, { basePath: bgPath });
        } catch (e) {
        }
      }
      try {
        result = await assetLoader.loadAssetBundle(
          bgPath,
          (loaded, total, asset) => {
            log.debug(`Asset loading: ${loaded}/${total} - ${asset}`);
            try {
              if (typeof options?.onProgress === 'function') {
                options.onProgress(loaded, total, asset);
              }
            } catch (e) {
              log.warn('Asset progress callback failed:', e);
            }
          },
          { skipBaseTexture: true } // Skip base texture since we got it from Foundry
        );
      } finally {
        if (doLoadProfile) {
          try {
            lp.end(`sceneComposer.loadAssetBundle:${spanToken}`);
          } catch (e) {
          }
        }
      }
    }

    // Robust fallback: if bgPath is missing OR the loaded bundle contains zero masks,
    // probe tile basePaths to locate the basePath that actually has suffix masks.
    // This makes mask loading independent of grid type and resilient to transient
    // canvas/tile readiness during grid/dimension rebuilds.
    if (!bgPath || !(result?.bundle?.masks?.length > 0)) {
      const maxAttempts = 6;
      const retryDelayMs = 50;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const probed = await this._probeBestMaskBasePath(foundryScene);
          if (probed) {
            bgPath = probed;
            log.info(`Probed mask basePath: ${bgPath}`);
            result = await assetLoader.loadAssetBundle(bgPath, null, { skipBaseTexture: true, suppressProbeErrors: true });
          }
        } catch (e) {
          // Ignore and retry
        }

        if (result?.bundle?.masks?.length > 0) break;
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }

    if (bgPath && (result?.bundle?.masks?.length > 0)) {
      this._lastMaskBasePath = bgPath;
    }

    this._maskCompositeInfo = null;
    this._albedoCompositeInfo = null;
    let compositeLayout = null;
    try {
      if (doLoadProfile) {
        try {
          lp.begin(`sceneComposer.composite.layout:${spanToken}`);
        } catch (e) {
        }
      }
      const tileCandidates = this._getLargeSceneMaskTiles(foundryScene);
      const layout = this._computeSceneMaskCompositeLayout(tileCandidates, foundryScene);
      compositeLayout = layout;
      if (doLoadProfile) {
        try {
          lp.end(`sceneComposer.composite.layout:${spanToken}`, { segments: layout?.segments?.length ?? 0 });
        } catch (e) {
        }
      }

      if (layout) {
        const perBaseMasks = new Map();
        if (doLoadProfile) {
          try {
            lp.begin(`sceneComposer.composite.loadPerBaseMasks:${spanToken}`, { bases: layout?.segments?.length ?? 0 });
          } catch (e) {
          }
        }
        try {
          for (const seg of layout.segments) {
            if (!seg?.basePath || perBaseMasks.has(seg.basePath)) continue;
            const masks = await this._loadMasksOnlyForBasePath(seg.basePath);
            perBaseMasks.set(seg.basePath, masks);
          }
        } finally {
          if (doLoadProfile) {
            try {
              lp.end(`sceneComposer.composite.loadPerBaseMasks:${spanToken}`, { uniqueBases: perBaseMasks.size });
            } catch (e) {
            }
          }
        }

        if (doLoadProfile) {
          try {
            lp.begin(`sceneComposer.composite.buildMasks:${spanToken}`, { uniqueBases: perBaseMasks.size });
          } catch (e) {
          }
        }
        let composite = null;
        try {
          composite = await this._buildCompositeSceneMasks(layout, perBaseMasks);
        } finally {
          if (doLoadProfile) {
            try {
              lp.end(`sceneComposer.composite.buildMasks:${spanToken}`, { outW: composite?.width ?? null, outH: composite?.height ?? null, maskCount: composite?.masks?.length ?? 0 });
            } catch (e) {
            }
          }
        }

        if (composite?.masks?.length) {
          result = {
            success: true,
            bundle: {
              masks: composite.masks,
              isMapShineCompatible: true
            },
            warnings: result?.warnings || [],
            error: null
          };

          this._maskCompositeInfo = {
            enabled: true,
            sceneRect: { x: layout.sceneX, y: layout.sceneY, w: layout.sceneW, h: layout.sceneH },
            outputSize: { w: composite.width, h: composite.height },
            segments: layout.segments.map((s) => ({
              basePath: s.basePath,
              src: s.src,
              segX0: s.segX0,
              segX1: s.segX1
            }))
          };
        }
      }
    } catch (e) {
      if (doLoadProfile) {
        try {
          lp.mark(`sceneComposer.composite.error:${spanToken}`, { message: String(e?.message ?? e) });
        } catch (e2) {
        }
      }
    }

    if (!hasBackgroundImage && !baseTexture && compositeLayout) {
      try {
        if (doLoadProfile) {
          try {
            lp.begin(`sceneComposer.composite.buildAlbedo:${spanToken}`);
          } catch (e) {
          }
        }
        const compositeAlbedo = await this._buildCompositeSceneAlbedo(compositeLayout);
        if (doLoadProfile) {
          try {
            lp.end(`sceneComposer.composite.buildAlbedo:${spanToken}`, { outW: compositeAlbedo?.width ?? null, outH: compositeAlbedo?.height ?? null });
          } catch (e) {
          }
        }
        if (compositeAlbedo?.texture) {
          baseTexture = compositeAlbedo.texture;
          this._albedoCompositeInfo = {
            enabled: true,
            outputSize: { w: compositeAlbedo.width, h: compositeAlbedo.height },
            segments: compositeLayout.segments.map((s) => ({
              basePath: s.basePath,
              src: s.src,
              segX0: s.segX0,
              segX1: s.segX1
            }))
          };
        }
      } catch (e) {
        if (doLoadProfile) {
          try {
            lp.mark(`sceneComposer.composite.albedoError:${spanToken}`, { message: String(e?.message ?? e) });
          } catch (e2) {
          }
        }
      }
    }

    try {
      const fullSceneBasePaths = this._getFullSceneMaskTileBasePaths();
      const moduleId = 'map-shine-advanced';
      const unionWaterEnabled = foundryScene?.getFlag?.(moduleId, 'unionWaterMasks')
        ?? foundryScene?.flags?.[moduleId]?.unionWaterMasks;

      if (unionWaterEnabled && fullSceneBasePaths.length > 1) {
        if (doLoadProfile) {
          try {
            lp.begin(`sceneComposer.unionMasks.water:${spanToken}`, { basePaths: fullSceneBasePaths.length });
          } catch (e) {
          }
        }
        let unionWater = null;
        try {
          unionWater = await this._buildUnionMaskForBasePaths('water', fullSceneBasePaths);
        } finally {
          if (doLoadProfile) {
            try {
              lp.end(`sceneComposer.unionMasks.water:${spanToken}`, { success: !!unionWater });
            } catch (e) {
            }
          }
        }
        if (unionWater) {
          if (!result || typeof result !== 'object') result = { success: false, bundle: { masks: [] }, warnings: [] };
          if (!result.bundle || typeof result.bundle !== 'object') result.bundle = { masks: [] };

          const masks = Array.isArray(result.bundle.masks) ? result.bundle.masks : [];
          const next = masks.filter((m) => (m?.id !== 'water' && m?.type !== 'water'));
          next.push(unionWater);
          result.bundle.masks = next;

          result.success = true;
          result.bundle.isMapShineCompatible = true;
        }
      }
    } catch (e) {
      if (doLoadProfile) {
        try {
          lp.mark(`sceneComposer.unionMasks.error:${spanToken}`, { message: String(e?.message ?? e) });
        } catch (e2) {
        }
      }
    }

    // Create bundle with Foundry's texture + any masks that loaded successfully
    this.currentBundle = {
      basePath: bgPath || '',
      baseTexture: baseTexture,
      masks: result.success ? result.bundle.masks : [],
      isMapShineCompatible: result.success ? result.bundle.isMapShineCompatible : false
    };

    // Normalize mask textures to the same UV convention as the base plane.
    // The base plane uses flipY=false and a geometry Y-inversion (scale.y=-1)
    // to align Foundry's top-left origin. Masks must follow the same.
    try {
      if (this.currentBundle?.masks && Array.isArray(this.currentBundle.masks)) {
        for (const m of this.currentBundle.masks) {
          const tex = m?.texture;
          if (!tex || typeof tex.flipY !== 'boolean') continue;
          if (tex.flipY !== false) {
            tex.flipY = false;
            tex.needsUpdate = true;
          }
        }
      }
    } catch (e) {
    }

    // Create base plane mesh (with texture or fallback color)
    if (doLoadProfile) {
      try {
        lp.begin(`sceneComposer.createBasePlane:${spanToken}`);
      } catch (e) {
      }
    }
    try {
      this.createBasePlane(baseTexture);
    } finally {
      if (doLoadProfile) {
        try {
          lp.end(`sceneComposer.createBasePlane:${spanToken}`);
        } catch (e) {
        }
      }
    }

    // Setup perspective camera with FOV-based zoom
    if (doLoadProfile) {
      try {
        lp.begin(`sceneComposer.setupCamera:${spanToken}`);
      } catch (e) {
      }
    }
    try {
      this.setupCamera(viewportWidth, viewportHeight);
    } finally {
      if (doLoadProfile) {
        try {
          lp.end(`sceneComposer.setupCamera:${spanToken}`);
        } catch (e) {
        }
      }
    }

    log.info(`Scene initialized: ${this.currentBundle.masks.length} effect masks available`);
    if (result.warnings && result.warnings.length > 0) {
      log.warn('Asset warnings:', result.warnings);
    }

    return {
      scene: this.scene,
      camera: this.camera,
      bundle: this.currentBundle
    };
  }

  /**
   * Extract base path from Foundry image URL
   * @param {string} src - Foundry image source path
   * @returns {string} Base path without extension
   * @private
   */
  extractBasePath(src) {
    // Remove extension
    const lastDot = src.lastIndexOf('.');
    if (lastDot > 0) {
      return src.substring(0, lastDot);
    }
    return src;
  }

  /**
   * Get Foundry's already-loaded background texture as a THREE.Texture
   * @param {Scene} foundryScene - Foundry VTT scene object
   * @returns {Promise<THREE.Texture|null>} THREE.js texture or null if not found
   * @private
   */
  async getFoundryBackgroundTexture(foundryScene) {
    const THREE = window.THREE;
    
    // Wait for Foundry's canvas to be ready
    if (!canvas || !canvas.primary) {
      log.warn('Foundry canvas not ready');
      return null;
    }

    // Access Foundry's PIXI texture for the scene background
    const pixiTexture = canvas.primary.background?.texture;
    if (!pixiTexture || !pixiTexture.baseTexture) {
      log.warn('Foundry background texture not found');
      return null;
    }

    // Get the HTMLImageElement or HTMLCanvasElement from PIXI
    const baseTexture = pixiTexture.baseTexture;
    const resource = baseTexture.resource;
    
    if (!resource || !resource.source) {
      log.warn('Foundry texture resource not accessible');
      return null;
    }

    // Create THREE.Texture from the same image source
    const threeTexture = this._markOwnedTexture(new THREE.Texture(resource.source));
    threeTexture.needsUpdate = true;
    // Use sRGB for correct color in lighting calculations
    if (THREE.SRGBColorSpace) {
      threeTexture.colorSpace = THREE.SRGBColorSpace;
    }
    // Flip Y: PIXI textures are top-left origin, three.js UVs are bottom-left origin
    threeTexture.flipY = false;
    
    // Match PIXI's texture settings
    threeTexture.wrapS = THREE.ClampToEdgeWrapping;
    threeTexture.wrapT = THREE.ClampToEdgeWrapping;
    threeTexture.minFilter = THREE.LinearFilter;
    threeTexture.magFilter = THREE.LinearFilter;

    log.debug('Converted Foundry texture to THREE.Texture');
    return threeTexture;
  }

  /**
   * Create the base plane mesh with battlemap texture
   * @param {THREE.Texture|null} texture - Base battlemap texture (null for blank maps)
   * @private
   */
  createBasePlane(texture) {
    const THREE = window.THREE;

    // Get texture dimensions (or use scene dimensions for blank maps)
    const imgWidth = texture?.image?.width || this.foundrySceneData.sceneWidth;
    const imgHeight = texture?.image?.height || this.foundrySceneData.sceneHeight;

    log.debug(`Creating base plane: ${imgWidth}x${imgHeight}px${texture ? '' : ' (no texture)'}`);

    // Create plane geometry matching texture aspect ratio
    // Use Foundry scene dimensions for world space size
    const worldWidth = this.foundrySceneData.width;
    const worldHeight = this.foundrySceneData.height;
    const sceneWidth = this.foundrySceneData.sceneWidth;
    const sceneHeight = this.foundrySceneData.sceneHeight;

    // Solid background plane covering the entire world (including padding)
    const bgColorStr = this.foundrySceneData.backgroundColor || '#999999';
    let bgColorInt = 0x999999;
    try {
      const hex = bgColorStr.replace('#', '');
      const parsed = parseInt(hex, 16);
      if (!Number.isNaN(parsed)) bgColorInt = parsed;
    } catch (e) {
      // Fallback already set
    }
    const bgGeometry = new THREE.PlaneGeometry(worldWidth, worldHeight);
    const bgMaterial = new THREE.MeshBasicMaterial({ color: bgColorInt });
    const bgMesh = new THREE.Mesh(bgGeometry, bgMaterial);
    // Position background slightly behind the base plane
    // groundZ is set when basePlaneMesh is created (1000 by default)
    // For perfect PIXI alignment with camera at Z=2000, ground should be at Z=1000
    // This gives distanceToGround = 1000, matching the base FOV calculation
    const GROUND_Z = 1000; // Canonical ground plane Z position
    bgMesh.position.set(worldWidth / 2, worldHeight / 2, GROUND_Z - 0.1);
    this.scene.add(bgMesh);
    this._backgroundMesh = bgMesh;

    // Use SCENE dimensions for geometry to prevent stretching texture across padding
    const geometry = new THREE.PlaneGeometry(sceneWidth, sceneHeight);
    
    // Basic material for now (will be replaced with PBR material in effect system)
    // If no texture, use scene background color
    let material;
    if (texture) {
      material = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.FrontSide, // Only render texture on front
        transparent: false
      });
      // Flip Y to correct UV orientation mismatch between PIXI and three.js
      if (material.map) { 
        material.map.flipY = false; 
        material.map.needsUpdate = true; 
      }
    } else {
      // Fallback: solid color plane for blank maps
      material = new THREE.MeshBasicMaterial({
        color: bgColorInt,
        side: THREE.FrontSide,
        transparent: false
      });
      log.info('Using solid color material for blank map');
    }

    this.basePlaneMesh = new THREE.Mesh(geometry, material);
    this.basePlaneMesh.name = 'BasePlane';
    
    // Create red back-face for orientation debugging
    const backMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      side: THREE.BackSide
    });
    const backMesh = new THREE.Mesh(geometry, backMaterial);
    backMesh.name = 'BasePlane_Back';
    this.basePlaneMesh.add(backMesh);
    this._backFaceMesh = backMesh;
    
    // Position the map plane at the center of the scene rectangle.
    // Scene rectangle coordinates are in Foundry canvas space (top-left origin, Y-down).
    // Our Three world uses Y-up, so we invert using the full canvas height.
    const sceneX = this.foundrySceneData.sceneX ?? 0;
    const sceneY = this.foundrySceneData.sceneY ?? 0;
    const sceneCenterX = sceneX + (sceneWidth / 2);
    const sceneCenterYFoundry = sceneY + (sceneHeight / 2);
    const sceneCenterYWorld = worldHeight - sceneCenterYFoundry;

    // This value (1000) is the canonical groundZ that all other layers reference.
    // With camera at Z=2000, this gives distanceToGround=1000 for clean 1:1 pixel mapping.
    this.basePlaneMesh.position.set(sceneCenterX, sceneCenterYWorld, GROUND_Z);
    
    // CRITICAL: Foundry uses Y-down coordinates (0 at top, H at bottom). 
    // Three.js uses Y-up (0 at bottom, H at top).
    // Strategy: Map Foundry 0 -> World H (Top) and Foundry H -> World 0 (Bottom).
    // Plane Geometry is created at center (W/2, H/2).
    // Top-Left Vertex is at (0, H). Bottom-Right is at (W, 0).
    // Texture (FlipY=false) maps Image Top-Left to Vertex Bottom-Left? No.
    // With scale.y = -1, we invert the geometry.
    
    this.basePlaneMesh.scale.y = -1; 
    
    this.scene.add(this.basePlaneMesh);
    log.info(`Base plane added: canvas ${worldWidth}x${worldHeight}, sceneRect (${sceneX}, ${sceneY}, ${sceneWidth}, ${sceneHeight})`);
  }

  /**
   * Setup perspective camera with FOV-based zoom for 2.5D top-down view
   * 
   * This approach keeps the camera at a FIXED Z position and zooms by
   * adjusting the FOV. This gives us:
   * - Perspective depth for particles (rain/snow look 3D)
   * - Fixed near/far planes (no depth precision issues)
   * - Ground plane always at same depth in frustum (no disappearing)
   * - Parallax effects during pan
   * 
   * The key insight: ground plane disappearing was caused by camera Z
   * moving, which changed the ground's position in the depth buffer.
   * With FOV zoom, ground stays at constant depth.
   * 
   * @param {number} viewportWidth - Viewport width in CSS pixels
   * @param {number} viewportHeight - Viewport height in CSS pixels
   * @private
   */
  setupCamera(viewportWidth, viewportHeight) {
    const THREE = window.THREE;

    const worldWidth = this.foundrySceneData.width;
    const worldHeight = this.foundrySceneData.height;

    // Center the camera on the *scene rectangle* (actual map bounds), not the padded canvas.
    // This matches BasePlane/Grid placement and Foundry's default view behavior.
    const sceneX = this.foundrySceneData.sceneX ?? 0;
    const sceneY = this.foundrySceneData.sceneY ?? 0;
    const sceneW = this.foundrySceneData.sceneWidth ?? worldWidth;
    const sceneH = this.foundrySceneData.sceneHeight ?? worldHeight;
    const centerX = sceneX + (sceneW / 2);
    const centerYFoundry = sceneY + (sceneH / 2);
    const centerY = worldHeight - centerYFoundry;

    // FIXED CAMERA HEIGHT - never changes during zoom
    // This is the key to stability: ground plane is always at a predictable
    // depth relative to camera, so no near/far plane issues.
    const CAMERA_HEIGHT = 2000;
    
    // The ground plane may be offset in Z (e.g. 0, 900, etc.). Use the
    // ACTUAL distance between camera and ground for FOV math so that
    // moving the plane in Z does not break alignment with PIXI.
    const groundZ = this.basePlaneMesh?.position?.z ?? 0;
    const distanceToGround = Math.max(1, CAMERA_HEIGHT - groundZ);

    // Calculate base FOV to achieve 1:1 pixel mapping at zoom=1.
    // At zoom=1, we want to see exactly viewportHeight world units vertically
    // at the ground plane depth.
    // FOV = 2 * atan((viewportHeight/2) / distanceToGround)
    const baseFovRadiansRaw = 2 * Math.atan(viewportHeight / (2 * distanceToGround));

    // Apply perspective strength tweak: 1.0 = raw math, <1.0 = flatter.
    const baseFovRadians = baseFovRadiansRaw * PERSPECTIVE_STRENGTH;
    const baseFovDegrees = baseFovRadians * (180 / Math.PI);
    
    const aspect = viewportWidth / viewportHeight;

    this.camera = new THREE.PerspectiveCamera(
      baseFovDegrees,
      aspect,
      1,            // near - fixed, close enough for all content
      5000          // far - fixed, far enough for all content
    );

    // Position camera at fixed height above world center, looking down -Z
    this.camera.position.set(centerX, centerY, CAMERA_HEIGHT);
    
    // Standard Orientation (Look down -Z, Up is +Y)
    this.camera.rotation.set(0, 0, 0);
    
    this.camera.updateMatrix();
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();
    
    // Store camera constants for zoom calculations
    this.cameraHeight = CAMERA_HEIGHT;
    this.groundZ = groundZ;
    this.groundDistance = distanceToGround;
    // Define canonical vertical bounds for the world volume so that
    // all effects (weather, fog, etc.) can place content relative to
    // the ground plane without duplicating constants.
    this.worldTopZ = groundZ + 7500;
    this.weatherEmitterZ = groundZ + 6500;
    this.baseFov = baseFovDegrees;
    this.baseFovRadians = baseFovRadians;
    this.baseFovTanHalf = Math.tan(baseFovRadians / 2);
    this.currentZoom = 1.0;
    
    // Store base viewport dimensions for resize calculations
    this.baseViewportWidth = viewportWidth;
    this.baseViewportHeight = viewportHeight;
    
    // Legacy compatibility - some code checks these
    this.cameraDistance = CAMERA_HEIGHT;
    this.baseDistance = CAMERA_HEIGHT;

    log.info(`Perspective camera setup (FOV zoom): height=${CAMERA_HEIGHT}, groundZ=${groundZ}, distance=${distanceToGround}, baseFOV=${baseFovDegrees.toFixed(2)}°, center (${centerX}, ${centerY}), viewport ${viewportWidth}x${viewportHeight}`);
  }

  /**
   * Update camera on viewport resize
   * @param {number} viewportWidth - New viewport width
   * @param {number} viewportHeight - New viewport height
   */
  resize(viewportWidth, viewportHeight) {
    if (!this.camera) return;

    // Update aspect ratio
    this.camera.aspect = viewportWidth / viewportHeight;
    
    // Recalculate base FOV for new viewport height using the actual
    // camera-to-ground distance. This keeps zoom + parallax consistent
    // even if the base plane Z has been tweaked.
    const groundZ = this.basePlaneMesh?.position?.z ?? (this.groundZ ?? 0);
    const distanceToGround = Math.max(1, this.cameraHeight - groundZ);
    this.groundZ = groundZ;
    this.groundDistance = distanceToGround;
    // Keep vertical bounds in sync if the base plane Z changes (e.g. via
    // future editing tools or scene configuration).
    this.worldTopZ = groundZ + 7500;
    this.weatherEmitterZ = groundZ + 6500;

    const baseFovRadiansRaw = 2 * Math.atan(viewportHeight / (2 * distanceToGround));
    const baseFovRadians = baseFovRadiansRaw * PERSPECTIVE_STRENGTH;
    this.baseFov = baseFovRadians * (180 / Math.PI);
    this.baseFovRadians = baseFovRadians;
    this.baseFovTanHalf = Math.tan(baseFovRadians / 2);

    // Apply current zoom to new base FOV
    if (this.camera.isPerspectiveCamera) {
      const baseTan = this.baseFovTanHalf;
      const zoom = this.currentZoom || 1;
      const fovRad = 2 * Math.atan(baseTan / zoom);
      this.camera.fov = fovRad * (180 / Math.PI);
    }
    
    this.camera.updateProjectionMatrix();
    
    // Update stored dimensions
    this.baseViewportWidth = viewportWidth;
    this.baseViewportHeight = viewportHeight;

    log.debug(`Camera resized: ${viewportWidth}x${viewportHeight}, FOV=${this.camera.fov.toFixed(2)}°`);
  }

  /**
   * Pan camera by offset
   * @param {number} deltaX - X offset in world units
   * @param {number} deltaY - Y offset in world units
   */
  pan(deltaX, deltaY) {
    if (!this.camera) return;

    // Translate camera in XY (Z stays fixed)
    let newX = this.camera.position.x + deltaX;
    let newY = this.camera.position.y + deltaY;
    
    // Clamp camera to scene bounds + margin
    const width = this.foundrySceneData.width;
    const height = this.foundrySceneData.height;
    const marginX = Math.max(2000, width * 0.5);
    const marginY = Math.max(2000, height * 0.5);
    
    newX = Math.max(-marginX, Math.min(newX, width + marginX));
    newY = Math.max(-marginY, Math.min(newY, height + marginY));
    
    this.camera.position.x = newX;
    this.camera.position.y = newY;
    // Z stays at cameraHeight - never changes
    
    log.debug(`Camera pan to (${this.camera.position.x.toFixed(1)}, ${this.camera.position.y.toFixed(1)})`);
  }

  /**
   * Get Foundry-compatible zoom scale limits
   * Mirrors Foundry VTT's Canvas#getDimensions zoom calculation
   * @returns {{min: number, max: number}} Scale limits (1.0 = base zoom)
   * @private
   */
  getZoomLimits() {
    const vw = this.baseViewportWidth ?? window.innerWidth;
    const vh = this.baseViewportHeight ?? window.innerHeight;
    const width = this.foundrySceneData.width;
    const height = this.foundrySceneData.height;
    const gridSize = this.foundrySceneData.gridSize;
    const padding = gridSize; // Use grid size as padding like Foundry
    
    // Min scale: fit entire padded scene in viewport
    // Matches Foundry: Math.min(innerWidth / paddedWidth, innerHeight / paddedHeight, 1)
    const paddedWidth = width + (2 * padding);
    const paddedHeight = height + (2 * padding);
    let minScale = CONFIG?.Canvas?.minZoom;
    if (minScale === undefined) {
      minScale = Math.min(vw / paddedWidth, vh / paddedHeight, 1);
    }
    
    // Max scale: zoom in to see ~3 grid cells
    // Matches Foundry: factor = 3 * (sourceGridSize / gridSize)
    // maxScale = Math.max(Math.min(innerWidth / gridSizeX, innerHeight / gridSizeY) / factor, minScale)
    let maxScale = CONFIG?.Canvas?.maxZoom;
    if (maxScale === undefined) {
      const factor = 3; // 3 grid cells visible at max zoom
      maxScale = Math.max(Math.min(vw / gridSize, vh / gridSize) / factor, minScale);
    }
    
    return { min: minScale, max: maxScale };
  }

  /**
   * Zoom camera by factor using FOV adjustment
   * 
   * FOV zoom: narrower FOV = magnified view (zoom in)
   *           wider FOV = wider view (zoom out)
   * 
   * Formula: currentFOV = baseFOV / zoomLevel
   * 
   * @param {number} zoomFactor - Zoom multiplier (>1 = zoom in, <1 = zoom out)
   * @param {number} centerX - Zoom center X in viewport space (0-1, default 0.5) - UNUSED for now
   * @param {number} centerY - Zoom center Y in viewport space (0-1, default 0.5) - UNUSED for now
   */
  zoom(zoomFactor, centerX = 0.5, centerY = 0.5) {
    if (!this.camera) return;

    let newZoom = this.currentZoom * zoomFactor;
    
    // Get Foundry-compatible zoom limits
    const limits = this.getZoomLimits();
    
    // Clamp zoom to limits
    newZoom = Math.max(limits.min, Math.min(newZoom, limits.max));
    
    // Store zoom level
    this.currentZoom = newZoom;

    // Apply FOV zoom using tan-half formulation for mathematical consistency
    // with resize(). This preserves stable zoom across viewport changes.
    const baseTan = this.baseFovTanHalf || Math.tan((this.baseFovRadians || (this.baseFov * Math.PI / 180)) / 2);
    const fovRad = 2 * Math.atan(baseTan / newZoom);
    const newFov = Math.max(1, Math.min(170, fovRad * (180 / Math.PI)));
    this.camera.fov = newFov;
    this.camera.updateProjectionMatrix();

    log.debug(`Camera zoom: ${newZoom.toFixed(3)} (FOV=${newFov.toFixed(2)}°, limits: ${limits.min.toFixed(3)}-${limits.max.toFixed(3)})`);
  }

  /**
   * Get current zoom scale
   * @returns {number} Current zoom scale (1.0 = default)
   */
  getZoomScale() {
    if (!this.camera) return 1.0;
    // FOV-based zoom: return stored zoom level
    return this.currentZoom;
  }

  /**
   * Get the current asset bundle
   * @returns {MapAssetBundle|null}
   */
  getAssetBundle() {
    return this.currentBundle;
  }

  /**
   * Get the base plane mesh
   * @returns {THREE.Mesh|null}
   */
  getBasePlane() {
    return this.basePlaneMesh;
  }

  /**
   * Dispose scene resources
   */
  dispose() {
    // Dispose bundle textures (masks + base) if we own them.
    try {
      const bundle = this.currentBundle;
      if (bundle?.masks && Array.isArray(bundle.masks)) {
        for (const m of bundle.masks) {
          this._disposeOwnedTexture(m?.texture);
        }
      }
      this._disposeOwnedTexture(bundle?.baseTexture);
    } catch (e) {
    }

    // Dispose background mesh resources (not covered by basePlaneMesh disposal).
    if (this._backgroundMesh) {
      try {
        if (this._backgroundMesh.parent) this._backgroundMesh.parent.remove(this._backgroundMesh);
        if (this._backgroundMesh.geometry) this._backgroundMesh.geometry.dispose();
        if (this._backgroundMesh.material) this._backgroundMesh.material.dispose();
      } catch (e) {
      }
      this._backgroundMesh = null;
    }

    if (this.basePlaneMesh) {
      // Dispose any child mesh materials (e.g., the red debug back-face) to avoid leaks.
      try {
        this.basePlaneMesh.traverse((obj) => {
          if (!obj || !obj.isMesh) return;
          if (obj === this.basePlaneMesh) return;
          const mat = obj.material;
          if (Array.isArray(mat)) {
            for (const m of mat) {
              try { m?.dispose?.(); } catch (e) {}
            }
          } else {
            try { mat?.dispose?.(); } catch (e) {}
          }

          // Only dispose child geometry if it's distinct from the base plane geometry.
          try {
            if (obj.geometry && obj.geometry !== this.basePlaneMesh.geometry) obj.geometry.dispose();
          } catch (e) {
          }
        });
      } catch (e) {
      }

      this.basePlaneMesh.geometry.dispose();
      if (Array.isArray(this.basePlaneMesh.material)) {
        for (const m of this.basePlaneMesh.material) {
          try { m?.dispose?.(); } catch (e) {}
        }
      } else {
        this.basePlaneMesh.material.dispose();
      }
      this.basePlaneMesh = null;
    }

    if (this.scene) {
      this.scene.clear();
      this.scene = null;
    }

    this.camera = null;
    this.currentBundle = null;

    try {
      this._ownedTextures.clear();
    } catch (e) {
    }

    log.info('Scene composer disposed');
  }
}
