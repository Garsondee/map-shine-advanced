/**
 * @fileoverview vt/vt-smoke-test.js — Stage 1 part 4: prove atlas + indirection
 * + vtSample render REAL pixels correctly, before adding residency-driven
 * streaming or camera controls on top of an unproven base.
 *
 * Deliberately narrow: decodes and uploads a static 3x3 block of pages (9
 * pages, all mip 0) around the torture fixture's center, builds their
 * indirection texel entries, and renders exactly that world rect filling a
 * dedicated canvas. No panning, no residency loop, no eviction — those are
 * part 4b, built on top of this once it's visually confirmed correct. A 3x3
 * block (not just 1 page) is the point: it exercises multiple distinct atlas
 * slots/positions AND the border-safe stitching between adjacent pages — if
 * borders were wrong, the grid lines in the torture fixture would visibly
 * misalign at the seams between tiles, which is exactly what that fixture
 * was built to make obvious (Keyhole.md §8 Stage 0).
 *
 * @module vt/vt-smoke-test
 */

import { PageCache } from './page-cache.js';
import { PageTable } from './page-table.js';
import { computeAtlasLayout, PageAtlas } from './atlas.js';
import { getSourceBitmap, decodePage, pageWorldRect } from './decode-pool.js';
import { VT_SAMPLE_GLSL, VT_MAX_MIPS } from './vt-sample.glsl.js';

/**
 * @param {number} slot @param {boolean} resident
 * @returns {[number,number,number,number]} RGBA8 bytes matching vt-sample.glsl.js's decode exactly.
 */
export function encodeIndirectionTexel(slot, resident) {
  if (!resident) return [0, 0, 0, 0];
  return [slot & 0xff, (slot >> 8) & 0xff, 0, 255];
}

let _active = null; // singleton — one smoke test at a time, so repeated clicks don't leak GPU resources

function disposeActive() {
  if (!_active) return;
  try {
    _active.renderer.setAnimationLoop(null);
  } catch (_) {}
  try {
    _active.atlas.dispose();
  } catch (_) {}
  try {
    _active.quadMaterial.dispose();
  } catch (_) {}
  try {
    _active.quadGeometry.dispose();
  } catch (_) {}
  try {
    _active.indirectionTexture.dispose();
  } catch (_) {}
  for (const t of _active.pageTextures) {
    try {
      t.dispose();
    } catch (_) {}
  }
  try {
    _active.canvas.remove();
  } catch (_) {}
  _active = null;
}

/**
 * @param {object} options
 * @param {any} options.THREE
 * @param {string} options.imageUrl - module-relative torture fixture URL.
 * @returns {Promise<object>} diagnostics — everything needed to verify
 *   correctness remotely without seeing the canvas (attach to a debug-panel report).
 */
export async function runVtSmokeTest({ THREE, imageUrl }) {
  disposeActive(); // one at a time; a re-click restarts cleanly rather than piling up canvases

  const diag = { imageUrl, errors: [], startedAt: new Date().toISOString() };

  try {
    // A small, cheap atlas — this smoke test needs 9 pages, not the full
    // Q2 512MB budget. 1024px atlas / 256px pages = 4x4=16 pages/layer,
    // sized so 1 layer holds exactly 16 pages (4MB) — comfortable headroom
    // over the 9 we'll actually use.
    const layout = computeAtlasLayout({ budgetBytes: 4 * 1024 * 1024, atlasSizePx: 1024 });
    diag.layout = layout;

    const cache = new PageCache({ budgetBytes: 4 * 1024 * 1024 });
    diag.cacheCapacityPages = cache.capacityPages;

    const sourceBitmap = await getSourceBitmap(imageUrl);
    diag.sourceImageDimensions = { width: sourceBitmap.width, height: sourceBitmap.height };

    const table = new PageTable({ id: 'smoke:floor0', worldSizePx: sourceBitmap.width });
    diag.pagesPerAxisAtMip0 = table.pagesPerAxis(0);

    // Canvas — a fresh overlay, separate from the boot heartbeat box (that
    // one stays the control panel; this one is the actual render preview).
    const canvas = document.createElement('canvas');
    canvas.id = 'msa-vt-smoke-canvas';
    canvas.width = 480;
    canvas.height = 480;
    Object.assign(canvas.style, {
      position: 'fixed',
      left: '12px',
      bottom: '12px',
      width: '480px',
      height: '480px',
      zIndex: '89',
      borderRadius: '8px',
      border: '1px solid rgba(143,214,255,0.35)',
      boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
      background: '#000',
    });
    document.body.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setPixelRatio(1); // exact-texel comparison matters more than DPR sharpness here
    renderer.setSize(480, 480, false);

    const atlas = new PageAtlas({ THREE, layout, renderer });

    // The 3x3 block, centered — clamped so it never walks off the world edge
    // on a smaller test image, though the torture fixture (49x49 at mip0)
    // has huge margin around the center.
    const centerAxis = Math.floor(table.pagesPerAxis(0) / 2);
    const blockPages = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = Math.min(table.pagesPerAxis(0) - 1, Math.max(0, centerAxis + dx));
        const py = Math.min(table.pagesPerAxis(0) - 1, Math.max(0, centerAxis + dy));
        blockPages.push({ px, py });
      }
    }

    const pageTextures = [];
    const residentPages = [];
    for (const { px, py } of blockPages) {
      const key = table.pageKey(0, px, py);
      const worldRect = pageWorldRect(table, 0, px, py);
      const decoded = await decodePage(sourceBitmap, worldRect);
      const srcTex = new THREE.Texture(decoded);
      srcTex.flipY = false;
      srcTex.generateMipmaps = false;
      srcTex.needsUpdate = true;
      pageTextures.push(srcTex);

      const { resident, slot } = cache.request(key, { pin: 'view' });
      if (!resident) {
        diag.errors.push(`cache miss for ${key} — budget too small for the 9-page block`);
        continue;
      }
      atlas.uploadPage(slot, srcTex);
      table.setSlot(0, px, py, slot);
      residentPages.push({ px, py, slot, worldRect });
    }
    diag.residentPages = residentPages;
    diag.cacheStats = cache.stats();

    // Build the indirection texture: dense, sized to the FULL mip-0 grid
    // (49x49 for the torture fixture) even though only 9 texels are set —
    // matches what the real system will do (one texture per virtual texture,
    // not per visible block).
    const n = table.pagesPerAxis(0);
    const buf = new Uint8Array(n * n * 4); // defaults to all-zero = not resident everywhere
    for (const { px, py, slot } of residentPages) {
      const [r, g, b, a] = encodeIndirectionTexel(slot, true);
      const i = (py * n + px) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
    const indirectionTexture = new THREE.DataTexture(buf, n, n, THREE.RGBAFormat);
    indirectionTexture.flipY = false;
    indirectionTexture.generateMipmaps = false;
    indirectionTexture.minFilter = THREE.NearestFilter;
    indirectionTexture.magFilter = THREE.NearestFilter;
    indirectionTexture.needsUpdate = true;

    // The quad: an orthographic camera framing EXACTLY the 3x3 block's world
    // rect, so what's on screen is precisely what vtSample resolves for that
    // rect — no extra transform to reason about when checking correctness.
    const blockWorldMinPx = (centerAxis - 1) * table.payloadPx;
    const blockWorldMaxPx = (centerAxis + 2) * table.payloadPx;
    const uvMin = blockWorldMinPx / table.worldSizePx;
    const uvMax = blockWorldMaxPx / table.worldSizePx;
    diag.framedWorldUV = { uvMin, uvMax };

    const quadGeometry = new THREE.PlaneGeometry(2, 2);
    // Remap the plane's default 0..1 UV to the framed world-UV range.
    const uvAttr = quadGeometry.getAttribute('uv');
    for (let i = 0; i < uvAttr.count; i++) {
      const u = uvAttr.getX(i),
        v = uvAttr.getY(i);
      // V IS INVERTED HERE ON PURPOSE — confirmed live 2026-07-15 (rendered
      // upside-down without this). PlaneGeometry's v=1 is local +Y, and the
      // vertex shader below passes position.xy straight to gl_Position, so
      // local +Y lands at NDC +Y == the TOP of the viewport. World-Y here is
      // plain image-pixel space (increases DOWNWARD — decodePage() crops
      // straight off worldRect.minY as an image row, no flip anywhere in the
      // atlas/indirection upload path either: verified DataArrayTexture
      // defaults flipY:false and copyTextureToTexture reads the DESTINATION's
      // flipY, not the source's, so nothing flips during upload). Screen-top
      // must therefore show the SMALLER world-Y (the top of the source
      // image) — i.e. v=1 -> uvMin, not uvMax.
      uvAttr.setXY(i, uvMin + u * (uvMax - uvMin), uvMax - v * (uvMax - uvMin));
    }
    uvAttr.needsUpdate = true;

    // The smoke test is single-mip by construction (one mip-0 indirection
    // texture, n×n) — i.e. the DEGENERATE case of vt-sample.glsl.js's multi-mip
    // walk: uMaxMip=0 so the loop only ever visits mip 0, uMipOrigin[0]=(0,0)
    // (its indirection texture IS the mip-0 grid at the origin), and
    // uMipPagesPerAxis[0]=n. This exercises the exact same shader the pan viewer
    // uses, with the coarse-fallback loop collapsing to one iteration.
    const smokeMipOrigin = new Int32Array(VT_MAX_MIPS * 2); // all zero == mip 0 at (0,0)
    const smokeMipPages = new Int32Array(VT_MAX_MIPS);
    smokeMipPages[0] = table.pagesPerAxis(0);

    const quadMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPageAtlas: { value: atlas.texture },
        uPageTable: { value: indirectionTexture },
        uPagesPerAxis: { value: layout.pagesPerAxis },
        uPagesPerLayer: { value: layout.pagesPerLayer },
        uPageSizePx: { value: layout.pageSizePx },
        uBorderPx: { value: 4 },
        uAtlasSizePx: { value: layout.atlasSizePx },
        uWorldSizePx: { value: table.worldSizePx },
        uRequestedMip: { value: 0 },
        // Smooth mip blending (2026-07-16, see vt-sample.glsl.js): supplied
        // explicitly rather than relying on an unset-uniform defaulting to 0
        // on every driver — this project's whole crash campaign was about
        // exactly the weak/aging GPU class where that kind of assumption
        // isn't safe. uMaxMip:0 below means mipHi==mipLo in the shader (the
        // degenerate top-of-pyramid case), so this value is never actually
        // read by the blend math here — supplied anyway for explicitness.
        uRequestedMipFrac: { value: 0 },
        uMaxMip: { value: 0 },
        uMipOrigin: { value: smokeMipOrigin },
        uMipPagesPerAxis: { value: smokeMipPages },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler2DArray;
        varying vec2 vUv;
        ${VT_SAMPLE_GLSL}
        void main() {
          gl_FragColor = vtSample(vUv);
        }
      `,
    });
    // No glslVersion:GLSL3 here on purpose — verified against the vendored
    // r170 source (WebGLProgram's shader-building code): a plain
    // THREE.ShaderMaterial (non-Raw) ALREADY compiles under `#version 300 es`
    // unconditionally (so sampler2DArray/texelFetch/textureSize all work),
    // and THREE auto-injects the `gl_FragColor` -> `pc_fragColor` shim
    // precisely BECAUSE glslVersion isn't set to GLSL3. Setting GLSL3
    // explicitly only matters for MRT (multiple named/located outputs, per
    // docs/planning/v3/B0-1's attribute-buffer material) — not needed for
    // this single-output smoke test, and dropping it means one fewer manual
    // `out vec4` declaration to get wrong.

    const scene = new THREE.Scene();
    const quad = new THREE.Mesh(quadGeometry, quadMaterial);
    scene.add(quad);
    // Matches the established fullscreen-quad convention already in this
    // codebase (src/graph/fullscreen-present.js) rather than inventing a new one.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    renderer.render(scene, camera);

    _active = { renderer, atlas, canvas, quadMaterial, quadGeometry, indirectionTexture, pageTextures };
    diag.ok = diag.errors.length === 0;
    diag.finishedAt = new Date().toISOString();
    diag.note = diag.ok
      ? 'Rendered a static 3x3 page block (real fetch -> decode -> atlas upload -> indirection -> vtSample shader) into a new canvas, bottom-left. Look at it: the labeled grid should be continuous across all 9 tiles with no seams, no magenta, no black holes.'
      : 'One or more pages failed to become resident or decode — see errors[].';
    return diag;
  } catch (err) {
    diag.ok = false;
    diag.fatalError = `${err?.message || err}\n${err?.stack || ''}`;
    console.error('[vt-smoke-test] fatal error:', err);
    return diag;
  }
}

export function stopVtSmokeTest() {
  disposeActive();
  return { stopped: true, at: new Date().toISOString() };
}
