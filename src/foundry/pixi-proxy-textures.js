/**
 * @fileoverview foundry/pixi-proxy-textures.js — Keyhole Stage 2C: the VRAM
 * severance. Keyhole.md §4.3's "single biggest instant win" — intercept
 * Foundry's texture loading for scene backgrounds *before* PIXI ever decodes
 * the real (potentially 8000px+) file, and hand it a ≤1024px proxy instead.
 * "Prevention, not demotion": the 719 MB PIXI residency / 345 MB LightCovers
 * hostage / continuous re-upload storm named in Keyhole.md §1's evidence
 * table become structurally impossible, not just cleaned up after the fact.
 *
 * THE MECHANISM, verified against the real v14 source before writing anything
 * (per the standing project rule) — not the design Keyhole.md's prose alone
 * would suggest:
 *
 * - `client/canvas/board.mjs` (~line 1119, 1140): `Hooks.callAll("canvasInit",
 *   this)` fires STRICTLY BEFORE `#loadTextures()` — the method that calls
 *   `TextureLoader.loadSceneTextures()`, which enumerates EVERY Level
 *   background/foreground, ALL tile textures, tokens, etc. into one list and
 *   hands each to `PIXI.Assets.load()`. `canvasInit` is therefore the correct,
 *   real, documented hook — registering here beats Foundry's own load by
 *   construction, not by a timing race.
 * - `client/canvas/loader.mjs`'s `getTexture()`/`TextureLoader#getCache()`
 *   resolve a real (non-`#`-prefixed) src via `PIXI.Assets.get(src)` /
 *   `PIXI.Assets.cache.has(src)` — a PUBLIC, documented low-level PixiJS Assets
 *   API, not a private Foundry internal. Pre-seeding `PIXI.Assets.cache` under
 *   the REAL src key (this module's approach) is therefore a legitimate use of
 *   PIXI's own public surface, not a monkey-patch of any Foundry method.
 *
 * THE ONE ASSUMPTION THIS MODULE COULDN'T VERIFY FROM SOURCE ALONE (PixiJS's
 * own source isn't vendored in this checkout) — **LIVE-CONFIRMED TRUE,
 * 2026-07-15**: whether `PIXI.Assets.load(src)` — what `loadSceneTextures()`'s
 * bulk loader actually calls — checks `Assets.cache` and skips a real fetch
 * when a valid entry already exists under that key, the same way
 * `getTexture()`/`getCache()` demonstrably do. Author's own residency report
 * on a real 12000×12000 two-floor scene: both floors resident at EXACTLY
 * 1024×1024 after arming and a scene switch. It works.
 *
 * SCOPE FOR THIS INCREMENT: Level backgrounds only (the highest-VRAM target,
 * and what `getActiveSceneFloors()` already enumerates). Tile documents are
 * Keyhole.md §4.3's other named target — the SAME `registerPixiProxy()`
 * mechanism applies to them mechanically; not wired in yet, a real, tracked
 * follow-up now that the core mechanism is live-confirmed.
 *
 * DEFAULT ON (author correction, 2026-07-15: "this V3 renderer is the main
 * rendering system and this isn't an optional feature... make it default
 * always on"). `src/boot.js` registers `registerFloorProxies()` unconditionally
 * from Foundry's own `canvasInit` hook — no toggle, no button. Registering a
 * proxy for a scene that's ALREADY drawn does nothing retroactively for that
 * scene; it takes effect from the NEXT scene load/switch onward, which in
 * practice means every scene after the module boots.
 *
 * @module foundry/pixi-proxy-textures
 */

/** Keyhole.md §4.3's own stated proxy ceiling. */
export const DEFAULT_MAX_PROXY_DIMENSION_PX = 1024;

/**
 * Pure: the proxy's output dimensions for a given source size, preserving
 * aspect ratio, never upscaling. `needed:false` means the source is already
 * small enough that proxying wouldn't help — skip it (let Foundry load the
 * real, already-small file; PIXI.Assets.cache pre-seeding a THIRD copy would
 * be pure overhead for zero benefit).
 *
 * @param {number} sourceWidth @param {number} sourceHeight
 * @param {number} [maxDimensionPx]
 * @returns {{width:number, height:number, needed:boolean}}
 */
export function computeProxyDimensions(sourceWidth, sourceHeight, maxDimensionPx = DEFAULT_MAX_PROXY_DIMENSION_PX) {
  const largest = Math.max(sourceWidth, sourceHeight);
  if (largest <= maxDimensionPx) {
    return { width: sourceWidth, height: sourceHeight, needed: false };
  }
  const scale = maxDimensionPx / largest;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    needed: true,
  };
}

/**
 * Generate a small proxy image from an ALREADY-DECODED source bitmap (reuses
 * `decode-pool.js`'s `getSourceBitmap()` cache — no new decode infrastructure)
 * and seed it into `PIXI.Assets.cache` under the REAL src key, so any Foundry
 * code path resolving that exact src — `getTexture()`, `TextureLoader
 * #getCache()`, and (per this file's header, the one unverified link)
 * `PIXI.Assets.load()` itself — finds our small proxy instead of ever
 * fetching/decoding the real file.
 *
 * MUST run at or before Foundry's own `canvasInit` hook to have any effect —
 * see this file's header. Browser-only (`OffscreenCanvas`, `createImageBitmap`,
 * the global `PIXI`) — not Node-testable; verify live via the debug panel.
 *
 * @param {string} realSrc - the exact src string the Level/Tile document uses
 *   (the same string Foundry's own code will look up).
 * @param {ImageBitmap} sourceBitmap - the full-resolution decoded source.
 * @param {object} [opts]
 * @param {number} [opts.maxDimensionPx]
 * @param {any} [opts.PIXI] - injected for testability; defaults to `globalThis.PIXI`.
 * @returns {Promise<{registered:boolean, reason?:string, realSrc?:string,
 *   proxyWidth?:number, proxyHeight?:number, sourceWidth?:number, sourceHeight?:number}>}
 */
export async function registerPixiProxy(realSrc, sourceBitmap, opts = {}) {
  const maxDimensionPx = opts.maxDimensionPx ?? DEFAULT_MAX_PROXY_DIMENSION_PX;
  const PIXI = opts.PIXI ?? globalThis.PIXI;
  if (!PIXI?.Assets?.cache) {
    return { registered: false, reason: 'PIXI.Assets.cache unavailable (not running inside Foundry?)' };
  }
  if (PIXI.Assets.cache.has(realSrc)) {
    return { registered: false, reason: 'already registered/cached under this src' };
  }

  const dims = computeProxyDimensions(sourceBitmap.width, sourceBitmap.height, maxDimensionPx);
  if (!dims.needed) {
    return { registered: false, reason: 'source already <= maxDimensionPx; proxying would not help' };
  }

  // Draw onto an OffscreenCanvas, then re-decode via createImageBitmap rather
  // than handing PIXI the canvas directly — ImageBitmap is the resource type
  // this codebase already knows PixiJS-adjacent and browser decode paths
  // accept reliably (same pattern as decode-pool.js's own edge-page
  // compositing), safer than assuming OffscreenCanvas itself is a supported
  // BaseTexture source across PixiJS versions.
  const canvas = new OffscreenCanvas(dims.width, dims.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceBitmap, 0, 0, dims.width, dims.height);
  const proxyBitmap = await createImageBitmap(canvas);

  // getCache()'s read path (client/canvas/loader.mjs) checks
  // `asset?.baseTexture?.valid` then unwraps `if (asset instanceof
  // PIXI.Texture) asset = asset.baseTexture` -- confirms Assets.cache is
  // expected to hold a PIXI.Texture (wrapping a BaseTexture), not a bare
  // BaseTexture. Match that shape exactly.
  const baseTexture = PIXI.BaseTexture.from(proxyBitmap);
  const texture = new PIXI.Texture(baseTexture);
  PIXI.Assets.cache.set(realSrc, texture);

  return {
    registered: true,
    realSrc,
    proxyWidth: dims.width,
    proxyHeight: dims.height,
    sourceWidth: sourceBitmap.width,
    sourceHeight: sourceBitmap.height,
  };
}

/**
 * Ground-truth diagnostic (not theory) — inspects PIXI's ACTUAL cache for a
 * list of srcs and reports what's really resident: dimensions + approximate
 * bytes. This is what distinguishes "the proxy took effect" (small dims
 * resident) from "PIXI.Assets.load() bypassed our seeded cache and fetched
 * for real anyway" (full source dims resident) — the one fact this file's
 * header says can't be confirmed from source alone. Run before AND after
 * toggling the proxy + reloading the scene to compare.
 *
 * @param {string[]} srcs
 * @param {any} [PIXIOverride] - injected for testability; defaults to `globalThis.PIXI`.
 * @returns {{available:boolean, reason?:string, entries?:Array<{src:string,
 *   resident:boolean, width:number|null, height:number|null, approxBytes:number|null}>}}
 */
export function getPixiResidencyReport(srcs, PIXIOverride) {
  const PIXI = PIXIOverride ?? globalThis.PIXI;
  if (!PIXI?.Assets?.cache) return { available: false, reason: 'PIXI.Assets.cache unavailable' };

  const entries = srcs.map((src) => {
    const resident = PIXI.Assets.cache.has(src);
    const asset = resident ? PIXI.Assets.get(src) : null;
    const baseTexture = asset?.baseTexture ?? asset;
    const width = baseTexture?.realWidth ?? baseTexture?.width ?? null;
    const height = baseTexture?.realHeight ?? baseTexture?.height ?? null;
    return {
      src,
      resident,
      width,
      height,
      approxBytes: width && height ? width * height * 4 : null,
    };
  });
  return { available: true, entries };
}
