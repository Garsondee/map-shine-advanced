/**
 * @fileoverview vt/vt-pan-viewer.js — Keyhole Stage 1 part 4b: the real
 * residency-driven streaming loop, keyboard pan/zoom/floor-switch.
 *
 * Builds directly on the smoke test's now-PROVEN atlas + indirection + vtSample
 * pipeline (Stage 1 part 4a, three live-tested fixes: Y-flip, coordinate-space
 * mismatch, clamp-bound conflation) — reuses the EXACT same UV-remap formula
 * rather than inventing a new one, specifically to avoid re-debugging
 * orientation/coordinate issues that are already solved. What's NEW here is
 * making residency dynamic: pan/zoom/floor-switch recompute the needed page
 * set every time the view changes, diff against what's currently resident,
 * decode+upload only what's newly needed, and unpin what fell out of view.
 *
 * SINGLE-MIP CUT (same limitation as vt-sample.glsl.js, inherited on purpose):
 * only mip 0 is ever requested/served. Zooming out asks for more mip-0 pages
 * (not a coarser mip — that machinery doesn't exist yet), which is honest
 * about the current limitation (documented, not hidden) rather than silently
 * wrong. A real coarse-mip fallback is Stage 1's next real increment after
 * this is confirmed working.
 *
 * Uses the REAL Keyhole Q2 default atlas (512 MB, 2048-page capacity) — the
 * smoke test's small test atlas already proved the concept; this is the step
 * toward the actual Stage 1 gate (torture scene pans at 60fps, 20-cycle soak,
 * zero context loss on the 3070).
 *
 * @module vt/vt-pan-viewer
 */

import { PageCache } from './page-cache.js';
import { PageTable } from './page-table.js';
import { computeAtlasLayout, PageAtlas } from './atlas.js';
import { getSourceBitmap, decodePage, pageWorldRect } from './decode-pool.js';
import { VT_SAMPLE_GLSL } from './vt-sample.glsl.js';
import { createInitialViewState, applyKey, viewToWorldRect } from './view-state.js';
import { computeVisiblePages, diffResidency } from './residency.js';
import { stopVtSmokeTest } from './vt-smoke-test.js'; // the two share screen space; starting one stops the other

/**
 * The canvas fills nearly the whole viewport (not a "tiny window" — flagged
 * live 2026-07-15) while staying SQUARE: the view-state/world-rect math uses
 * one halfSpanPx for both axes (view-state.js), so a non-square canvas would
 * visibly STRETCH the render — a new bug class this session doesn't need on
 * top of the three coordinate bugs already chased down. Sized to the smaller
 * of (viewport width minus room for the debug panel, viewport height minus margin).
 */
function computeCanvasSizePx() {
  const margin = 24;
  const debugPanelReserve = 360; // keeps the corner debug panel/heartbeat box clickable
  const maxW = window.innerWidth - margin * 2 - debugPanelReserve;
  const maxH = window.innerHeight - margin * 2;
  return Math.max(320, Math.min(maxW, maxH));
}

let _active = null;

function disposeActive() {
  if (!_active) return;
  try { window.removeEventListener('keydown', _active.onKeyDown); } catch (_) {}
  try { _active.renderer.setAnimationLoop(null); } catch (_) {}
  try { _active.atlas.dispose(); } catch (_) {}
  try { _active.quadMaterial.dispose(); } catch (_) {}
  try { _active.quadGeometry.dispose(); } catch (_) {}
  for (const entry of _active.floors.values()) { try { entry.indirectionTexture.dispose(); } catch (_) {} }
  try { _active.canvas.remove(); } catch (_) {}
  _active = null;
}

export function stopVtPanViewer() {
  disposeActive();
  return { stopped: true, at: new Date().toISOString() };
}

/**
 * @param {object} options
 * @param {any} options.THREE
 * @param {(floorIndex:number) => string} options.imageUrlForFloor
 * @param {number} options.floorCount
 * @returns {Promise<object>} initial diagnostics (see getDiagnostics() for the shape).
 */
export async function startVtPanViewer({ THREE, imageUrlForFloor, floorCount }) {
  disposeActive();
  stopVtSmokeTest(); // avoid two renderers fighting over the same corner of the screen

  const diag0 = { errors: [] };
  try {
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 }); // Keyhole Q2 default
    const cache = new PageCache({ budgetBytes: 512 * 1024 * 1024 });

    const canvasPx = computeCanvasSizePx();
    const canvas = document.createElement('canvas');
    canvas.id = 'msa-vt-pan-viewer-canvas';
    canvas.width = canvasPx;
    canvas.height = canvasPx;
    Object.assign(canvas.style, {
      position: 'fixed', left: '24px', top: '24px', width: `${canvasPx}px`, height: `${canvasPx}px`,
      zIndex: '89', borderRadius: '8px', border: '1px solid rgba(143,214,255,0.35)',
      boxShadow: '0 6px 24px rgba(0,0,0,0.5)', background: '#000', cursor: 'crosshair',
    });
    document.body.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(canvasPx, canvasPx, false);

    const atlas = new PageAtlas({ THREE, layout, renderer });
    const floors = new Map(); // floorIndex -> { table, sourceBitmap, indirectionTexture, buf, n, residentViewKeys }

    async function ensureFloorLoaded(floorIndex) {
      if (floors.has(floorIndex)) return floors.get(floorIndex);
      const sourceBitmap = await getSourceBitmap(imageUrlForFloor(floorIndex));
      const table = new PageTable({ id: `panviewer:floor${floorIndex}`, worldSizePx: sourceBitmap.width });
      const n = table.pagesPerAxis(0);
      const buf = new Uint8Array(n * n * 4); // all-zero = not resident everywhere, initially
      const indirectionTexture = new THREE.DataTexture(buf, n, n, THREE.RGBAFormat);
      indirectionTexture.flipY = false;
      indirectionTexture.generateMipmaps = false;
      indirectionTexture.minFilter = THREE.NearestFilter;
      indirectionTexture.magFilter = THREE.NearestFilter;
      const entry = { table, sourceBitmap, indirectionTexture, buf, n, residentViewKeys: new Set() };
      floors.set(floorIndex, entry);
      return entry;
    }

    // The quad + shader: IDENTICAL pattern to the proven smoke test (same
    // vertex shader, same uniform names, same v-flip in the UV remap) — see
    // that file's comments for why each piece is shaped the way it is.
    const quadGeometry = new THREE.PlaneGeometry(2, 2);
    const quadMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPageAtlas: { value: atlas.texture },
        uPageTable: { value: null }, // set per-floor in render()
        uPagesPerAxis: { value: layout.pagesPerAxis },
        uPagesPerLayer: { value: layout.pagesPerLayer },
        uPageSizePx: { value: layout.pageSizePx },
        uBorderPx: { value: 4 },
        uAtlasSizePx: { value: layout.atlasSizePx },
        uWorldSizePx: { value: 0 }, // set per-floor in render()
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        precision highp sampler2DArray;
        varying vec2 vUv;
        ${VT_SAMPLE_GLSL}
        void main() {
          gl_FragColor = vtSample(vUv);
        }
      `,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(quadGeometry, quadMaterial));
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); // matches FullscreenPresent.js's convention

    let view = null; // set once the first floor is loaded (needs its worldSizePx)
    let frameTimes = [];
    let lastError = null;

    function reframeQuad(uvMin, uvMax) {
      const uvAttr = quadGeometry.getAttribute('uv');
      for (let i = 0; i < uvAttr.count; i++) {
        const u = uvAttr.getX(i), v = uvAttr.getY(i);
        // Same v-flip as the smoke test (live-verified 2026-07-15): v=1 (local
        // +Y, NDC top) must map to the SMALLER world-Y (the top of the source
        // image), so uvMax - v*(uvMax-uvMin), never uvMin + v*(...).
        uvAttr.setXY(i, uvMin.x + u * (uvMax.x - uvMin.x), uvMax.y - v * (uvMax.y - uvMin.y));
      }
      uvAttr.needsUpdate = true;
    }

    async function updateResidency() {
      const entry = await ensureFloorLoaded(view.floorIndex);
      if (quadMaterial.uniforms.uPageTable.value !== entry.indirectionTexture) {
        quadMaterial.uniforms.uPageTable.value = entry.indirectionTexture;
        quadMaterial.uniforms.uWorldSizePx.value = entry.table.worldSizePx;
      }

      const worldRect = viewToWorldRect(view);
      // Single-mip cut (see file header): always mip 0, never a coarser
      // fallback yet — zooming out means more mip-0 pages requested, not a
      // coarser mip served.
      const neededPages = computeVisiblePages(entry.table, worldRect, { mip: 0, guardPages: 1 });
      const diff = diffResidency(entry.residentViewKeys, neededPages);

      for (const page of diff.toRequest) {
        const alreadyInCache = cache.isResident(page.key);
        const { resident, slot } = cache.request(page.key, { pin: 'view' });
        if (!resident) continue; // cache full — a structural miss, not a crash; stays magenta
        if (!alreadyInCache) {
          try {
            const worldRectPage = pageWorldRect(entry.table, 0, page.px, page.py);
            const decoded = await decodePage(entry.sourceBitmap, worldRectPage);
            const srcTex = new THREE.Texture(decoded);
            srcTex.flipY = false;
            srcTex.generateMipmaps = false;
            srcTex.needsUpdate = true;
            atlas.uploadPage(slot, srcTex);
            // Safe to release immediately: copyTextureToTexture's GL upload
            // consumes the source synchronously (the driver has already read
            // the pixels by the time the call returns) — no need to keep
            // these around like the (bounded, 9-page) smoke test did.
            srcTex.dispose();
            decoded.close?.();
          } catch (err) {
            lastError = `decode/upload failed for ${page.key}: ${err?.message || err}`;
            console.error('[vt-pan-viewer]', lastError);
          }
        }
      }
      for (const key of diff.toUnpin) cache.unpin(key);
      entry.residentViewKeys = diff.nextKeys;

      // Rebuild the indirection buffer FRESH from the cache's own current
      // slot mapping (never from a separately-tracked copy) — this is what
      // keeps it correct across evictions: a page that got evicted and
      // reassigned to someone else must never leave a stale pointer behind.
      entry.buf.fill(0);
      for (const page of neededPages) {
        const slot = cache.slotOf(page.key);
        if (slot === null) continue;
        const i = (page.py * entry.n + page.px) * 4;
        entry.buf[i] = slot & 0xff; entry.buf[i + 1] = (slot >> 8) & 0xff; entry.buf[i + 2] = 0; entry.buf[i + 3] = 255;
      }
      entry.indirectionTexture.needsUpdate = true;

      const worldSizePx = entry.table.worldSizePx;
      reframeQuad(
        { x: worldRect.minX / worldSizePx, y: worldRect.minY / worldSizePx },
        { x: worldRect.maxX / worldSizePx, y: worldRect.maxY / worldSizePx }
      );
    }

    // Shared by the real keydown handler AND the soak harness (MapShine.soakHooks.pan)
    // — one code path applies a key, so a soak run exercises exactly what a real
    // user's keypress would, not a separate simulated approximation of it.
    async function applyKeyAndUpdate(key) {
      const ctx = { worldSizePx: view.__lastWorldSizePx || 12000, floorCount };
      const next = applyKey(view, key, ctx);
      if (next === view) return false;
      view = next;
      view.__lastWorldSizePx = ctx.worldSizePx;
      await updateResidency();
      return true;
    }

    function onKeyDown(e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
      // Decide SYNCHRONOUSLY whether this key does anything (applyKey itself is
      // pure/sync) so preventDefault() fires before the event finishes — calling
      // it after the async residency update below would be too late for the
      // browser to actually suppress e.g. arrow-key page scroll.
      const ctx = { worldSizePx: view.__lastWorldSizePx || 12000, floorCount };
      if (applyKey(view, e.key, ctx) === view) return; // no-op key, let the browser handle it normally
      e.preventDefault();
      applyKeyAndUpdate(e.key).catch((err) => console.error('[vt-pan-viewer] updateResidency failed:', err));
    }

    // First floor load determines the initial view's world size.
    const firstEntry = await ensureFloorLoaded(0);
    view = createInitialViewState({ worldSizePx: firstEntry.table.worldSizePx, floorIndex: 0 });
    view.__lastWorldSizePx = firstEntry.table.worldSizePx;
    await updateResidency();

    renderer.setAnimationLoop((t) => {
      const t0 = performance.now();
      renderer.render(scene, camera);
      frameTimes.push(performance.now() - t0);
      if (frameTimes.length > 120) frameTimes.shift();
    });

    window.addEventListener('keydown', onKeyDown);

    _active = {
      THREE, renderer, atlas, canvas, quadMaterial, quadGeometry, floors, cache, layout, onKeyDown, floorCount,
      getView: () => view,
      applyKeyAndUpdate, // exposed so MapShine.soakHooks.pan drives the EXACT same path a real keypress does
      getDiagnostics() {
        const avgMs = frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0;
        return {
          view,
          layout,
          canvasSizePx: canvasPx,
          cacheStats: cache.stats(),
          floorsLoaded: Array.from(floors.keys()),
          currentFloorResidentCount: floors.get(view.floorIndex)?.residentViewKeys.size ?? 0,
          renderMsAvgLast120: Math.round(avgMs * 100) / 100,
          lastError,
          controls: 'Arrow keys/WASD pan, +/- zoom, 0-2 or Tab floor-switch (click the canvas first).',
        };
      },
    };

    console.log('[vt-pan-viewer] started — click the canvas, then arrow keys/WASD pan, +/- zoom, 0-2/Tab floor-switch.');
    return { ok: true, ..._active.getDiagnostics() };
  } catch (err) {
    diag0.ok = false;
    diag0.fatalError = `${err?.message || err}\n${err?.stack || ''}`;
    console.error('[vt-pan-viewer] fatal error:', err);
    return diag0;
  }
}

/** For the debug panel: current diagnostics without restarting anything. */
export function getVtPanViewerDiagnostics() {
  if (!_active) return { active: false };
  return { active: true, ..._active.getDiagnostics() };
}

const SOAK_PAN_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];

/**
 * MapShine.soakHooks.pan driver — cycles through the four pan directions so a
 * soak run actually exercises decode/upload/evict repeatedly, via the EXACT
 * same applyKeyAndUpdate() path a real keypress uses. No-op (not an error) if
 * the viewer was never started — `soak()` reports honestly which drivers ran.
 * @param {number} i - the soak cycle index.
 */
export async function soakPanStep(i) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const key = SOAK_PAN_KEYS[i % SOAK_PAN_KEYS.length];
  await _active.applyKeyAndUpdate(key);
  return { key, ..._active.getDiagnostics() };
}

/** MapShine.soakHooks.switchFloor driver — cycles floors 0,1,2,0,1,2,... */
export async function soakSwitchFloorStep(i) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const floorIndex = i % _active.floorCount;
  await _active.applyKeyAndUpdate(String(floorIndex));
  return { floorIndex, ..._active.getDiagnostics() };
}
