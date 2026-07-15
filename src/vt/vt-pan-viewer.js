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
  // { capture: true } MUST match the addEventListener call exactly — the two
  // are treated as distinct registrations otherwise, and removal silently no-ops.
  try { window.removeEventListener('keydown', _active.onKeyDown, { capture: true }); } catch (_) {}
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

    // preserveDrawingBuffer:true -- WITHOUT this, the browser is free to clear
    // the drawing buffer immediately after each frame composites, so
    // gl.readPixels() called later from a button click (not from inside the
    // render callback itself) can legitimately read back (0,0,0,0) regardless
    // of what was actually drawn -- confirmed live 2026-07-15: the
    // 'renderedPixels' diagnostic read all-zero even though the indirection
    // buffer (plain JS state, unaffected by this) showed correct, non-degenerate
    // data. A real WebGL behavior, not a rendering bug -- but it made the
    // diagnostic itself unreliable. Trivial perf cost for a debug canvas this size.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
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
    let lastFramedUV = null; // set by reframeQuad(), exposed in diagnostics for ground-truth debugging

    /** Ground truth, not theory: actual rendered canvas pixels + actual indirection buffer contents. */
    function sampleDiagnostics(entry) {
      const out = {};
      try {
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        const points = {
          center: [Math.floor(canvasPx / 2), Math.floor(canvasPx / 2)],
          topLeft: [4, canvasPx - 4], // GL readPixels Y is bottom-up; this is visual top-left
          bottomRight: [canvasPx - 4, 4],
        };
        out.renderedPixels = {};
        for (const [label, [x, y]] of Object.entries(points)) {
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          out.renderedPixels[label] = [px[0], px[1], px[2], px[3]];
        }
      } catch (err) {
        out.renderedPixelsError = String(err?.message || err);
      }
      if (entry) {
        let nonZeroTexels = 0;
        const distinctSlots = new Set();
        for (let i = 0; i < entry.buf.length; i += 4) {
          if (entry.buf[i + 3] > 0) {
            nonZeroTexels++;
            distinctSlots.add(entry.buf[i] | (entry.buf[i + 1] << 8));
          }
        }
        out.indirectionBuffer = {
          totalTexels: entry.buf.length / 4,
          residentTexels: nonZeroTexels,
          distinctSlotCount: distinctSlots.size,
          distinctSlotsSample: Array.from(distinctSlots).slice(0, 10),
        };
      }
      out.framedWorldUV = lastFramedUV;
      return out;
    }

    function renderFrame(t) {
      const t0 = performance.now();
      renderer.render(scene, camera);
      frameTimes.push(performance.now() - t0);
      if (frameTimes.length > 120) frameTimes.shift();
    }

    // Captured ONCE, before any reframe — the TRUE base UV (PlaneGeometry's
    // original 0/1 corners), never touched again. THE ACTUAL BUG (found live
    // 2026-07-15, after resetState()/preserveDrawingBuffer turned out to be
    // real but insufficient fixes): reframeQuad() used to read the geometry's
    // CURRENT (already-remapped) uv attribute as its "base" and remap THAT —
    // so every call compounded onto the PREVIOUS call's already-narrow range
    // instead of the fixed original span. Two calls (initial load, then one
    // pan) was enough to collapse the whole quad's UV range by ~17x toward a
    // single point — exactly matching the symptom: correct on first load,
    // solid-color after the very first pan, regardless of direction. The
    // smoke test never hit this because it only ever reframed once.
    const baseUV = (() => {
      const uvAttr = quadGeometry.getAttribute('uv');
      const out = [];
      for (let i = 0; i < uvAttr.count; i++) out.push([uvAttr.getX(i), uvAttr.getY(i)]);
      return out;
    })();

    function reframeQuad(uvMin, uvMax) {
      const uvAttr = quadGeometry.getAttribute('uv');
      for (let i = 0; i < uvAttr.count; i++) {
        const [u, v] = baseUV[i]; // ALWAYS the true original corner, never the live buffer
        // Same v-flip as the smoke test (live-verified 2026-07-15): v=1 (local
        // +Y, NDC top) must map to the SMALLER world-Y (the top of the source
        // image), so uvMax - v*(uvMax-uvMin), never uvMin + v*(...).
        uvAttr.setXY(i, uvMin.x + u * (uvMax.x - uvMin.x), uvMax.y - v * (uvMax.y - uvMin.y));
      }
      uvAttr.needsUpdate = true;
      lastFramedUV = { uvMin, uvMax };
    }

    let lastFloorIndex = null;

    async function updateResidency() {
      if (lastFloorIndex !== null && lastFloorIndex !== view.floorIndex) {
        // Leaving a floor: its pages are no longer being viewed. Unpin them
        // all (never evict directly — PageCache's own LRU decides that under
        // real pressure, so switching back shortly is still cheap: still
        // resident, just re-pinned, no re-decode). Without this, every
        // floor's pages stayed pinned FOREVER, undetected until enough floor
        // switches finally exhausted the cache.
        const prevEntry = floors.get(lastFloorIndex);
        if (prevEntry) {
          for (const key of prevEntry.residentViewKeys) cache.unpin(key);
          prevEntry.residentViewKeys = new Set();
        }
      }
      lastFloorIndex = view.floorIndex;

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

      // TWO PASSES ON PURPOSE (confirmed live 2026-07-15 — the actual cause of
      // "no texture bound to target" errors on every pan/zoom): unlike the
      // smoke test (which rendered ONCE, only after all uploads finished),
      // this viewer's renderer.setAnimationLoop() runs CONTINUOUSLY — a
      // render() call can land in the middle of an `await`-interleaved
      // decode-then-upload loop and disturb the WebGLRenderer's internal
      // texture-unit binding state that copyTextureToTexture()/
      // setTexture2DArray() depend on, corrupting the atlas's binding for
      // every upload after the first interleaved frame. Pass 1 does all the
      // (genuinely async, GL-free) decoding — the render loop MAY interleave
      // here, harmlessly, since no GL upload is in flight yet. Pass 2 uploads
      // everything already-decoded in one tight SYNCHRONOUS loop — no
      // `await` between GL calls, so the render loop cannot interleave
      // mid-sequence.
      const decodedForUpload = [];
      for (const page of diff.toRequest) {
        const alreadyInCache = cache.isResident(page.key);
        const { resident, slot } = cache.request(page.key, { pin: 'view' });
        if (!resident) continue; // cache full — a structural miss, not a crash; stays magenta
        if (!alreadyInCache) {
          try {
            const worldRectPage = pageWorldRect(entry.table, 0, page.px, page.py);
            const decoded = await decodePage(entry.sourceBitmap, worldRectPage);
            decodedForUpload.push({ slot, decoded });
          } catch (err) {
            lastError = `decode failed for ${page.key}: ${err?.message || err}`;
            console.error('[vt-pan-viewer]', lastError);
          }
        }
      }
      if (decodedForUpload.length > 0) {
        // Pausing the render loop during the upload batch (kept — cheap,
        // harmless, and avoids wasting a render on a half-updated state) was
        // NOT the actual fix for "no texture bound to target": that error
        // persisted even with rendering provably paused (a synchronous JS
        // block genuinely cannot be interleaved), which disproved the
        // interleaving theory outright. The REAL cause and fix are in
        // atlas.js's prepareForUploadBatch() — THREE's own texture-unit
        // binding CACHE (not a timing race) goes stale after a render() call,
        // and copyTextureToTexture's fast path trusts it anyway.
        renderer.setAnimationLoop(null);
        atlas.prepareForUploadBatch();
        for (const { slot, decoded } of decodedForUpload) {
          const srcTex = new THREE.Texture(decoded);
          srcTex.flipY = false;
          srcTex.generateMipmaps = false;
          srcTex.needsUpdate = true;
          atlas.uploadPage(slot, srcTex);
          srcTex.dispose();
          decoded.close?.();
        }
        renderer.setAnimationLoop(renderFrame);
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
      // Foundry's own KeyboardManager binds arrow keys to core.panUp/Left/Down/Right
      // (repeat:true, always active — confirmed live 2026-07-15 by tracing
      // foundryvttsourcecode_v14/.../client-keybindings.mjs) and digit keys can
      // trigger hotbar slots — both listen on `window` in the bubble phase, same
      // as this handler was. Registered in the CAPTURE phase (below) so this
      // handler ALWAYS runs first regardless of registration order, and
      // stopImmediatePropagation() here stops Foundry's own handler (and
      // anyone else's) from also acting on a key this viewer has claimed —
      // without this, arrow-key presses were panning Foundry's own canvas
      // instead of (or as well as) this viewer's view, and the view state
      // never actually changed.
      e.stopImmediatePropagation();
      e.preventDefault();
      applyKeyAndUpdate(e.key).catch((err) => console.error('[vt-pan-viewer] updateResidency failed:', err));
    }

    // First floor load determines the initial view's world size.
    const firstEntry = await ensureFloorLoaded(0);
    view = createInitialViewState({ worldSizePx: firstEntry.table.worldSizePx, floorIndex: 0 });
    view.__lastWorldSizePx = firstEntry.table.worldSizePx;
    await updateResidency();

    renderer.setAnimationLoop(renderFrame);

    // capture:true — see onKeyDown's comment. Must run before Foundry's own
    // window-level keydown listener (registered at Foundry boot, bubble phase).
    window.addEventListener('keydown', onKeyDown, { capture: true });

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
          ...sampleDiagnostics(floors.get(view.floorIndex)),
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
