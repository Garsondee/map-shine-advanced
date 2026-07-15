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
 * MULTI-MIP (the single-mip cut is gone — this is Stage 1's coarse-fallback
 * increment). On floor load, every floor pins its COARSE set (the top few mip
 * levels, residency.coarseTopMipsForCap) as 'coarse' — permanently resident,
 * so the whole world always renders soft and floor switches are instant. Each
 * residency update chooses a mip analytically (residency.planResidency /
 * chooseMip — top-down camera, no GPU feedback), requests the fine set + a
 * coarser prefetch set at THEIR real mips, and the shader (vt-sample.glsl.js)
 * walks requested→coarsest and samples the finest-resident level. Zooming out
 * now serves coarser mips (bounded working set) instead of piling up mip-0
 * pages; a still-streaming texel resolves through the coarse pins as blur,
 * never black, never magenta.
 *
 * Uses the REAL Keyhole Q2 default atlas (512 MB, 2048-page capacity) — the
 * smoke test's small test atlas already proved the concept; this is the step
 * toward the actual Stage 1 gate (torture scene pans at 60fps, 20-cycle soak,
 * zero context loss on the 3070).
 *
 * @module vt/vt-pan-viewer
 */

import { PageCache } from './page-cache.js';
import { PageTable, computeIndirectionAtlasLayout } from './page-table.js';
import { computeAtlasLayout, PageAtlas } from './atlas.js';
import { getSourceBitmap, decodePage, pageWorldRect } from './decode-pool.js';
import { VT_SAMPLE_GLSL, VT_MAX_MIPS } from './vt-sample.glsl.js';
import { createInitialViewState, applyKey, viewToWorldRect } from './view-state.js';
import { planResidency, coarsePinSet, coarseTopMipsForCap, diffResidency } from './residency.js';
import { stopVtSmokeTest } from './vt-smoke-test.js'; // the two share screen space; starting one stops the other

/**
 * Where to mount the VT canvas so it BECOMES the scene display (author request,
 * 2026-07-15: "make this the only display... fill the scene viewing space so we
 * don't have PIXI and threejs alongside each other"). We mount into Foundry's
 * own `canvas#board` container and sit at a z-index ABOVE the board
 * (`--z-index-canvas: 0`, verified in foundry2.css) but BELOW Foundry's UI
 * (`--z-index-ui: 60`) — so the VT view opaquely OCCLUDES the PIXI canvas while
 * every Foundry UI panel (and the debug panel at z-index 90) stays clickable on
 * top. This is the VISUAL half of Stage 2's severance; the VRAM half (stopping
 * Foundry from decoding full-res duplicates into PIXI at all) is the separate
 * proxy-texture-interception step. Falls back to a full-window overlay on
 * document.body if the board isn't in the DOM yet (e.g. no scene active).
 *
 * @returns {{host: HTMLElement, fill: boolean}}
 */
function resolveMountHost() {
  const board = document.getElementById('board');
  if (board?.parentElement) return { host: board.parentElement, fill: true };
  return { host: document.body, fill: true };
}

/** The scene-area size to render at, from the mount host's live client box. */
function measureHost(host) {
  const w = Math.max(1, host.clientWidth || window.innerWidth);
  const h = Math.max(1, host.clientHeight || window.innerHeight);
  return { width: w, height: h };
}

let _active = null;

function disposeActive() {
  if (!_active) return;
  // { capture: true } MUST match the addEventListener call exactly — the two
  // are treated as distinct registrations otherwise, and removal silently no-ops.
  try {
    window.removeEventListener('keydown', _active.onKeyDown, { capture: true });
  } catch (_) {}
  try {
    if (_active.onResize) window.removeEventListener('resize', _active.onResize);
  } catch (_) {}
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
  for (const entry of _active.floors.values()) {
    try {
      entry.indirectionTexture.dispose();
    } catch (_) {}
  }
  try {
    _active.canvas.remove();
  } catch (_) {}
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

    const mount = resolveMountHost();
    let canvasW = measureHost(mount.host).width;
    let canvasH = measureHost(mount.host).height;
    const canvas = document.createElement('canvas');
    canvas.id = 'msa-vt-pan-viewer-canvas';
    canvas.width = canvasW;
    canvas.height = canvasH;
    Object.assign(canvas.style, {
      // Fill the mount host (the board container) exactly, occluding the PIXI
      // canvas beneath. z-index 5: above board (0) + hud (1), below Foundry UI
      // (60) and the debug panel (90). pointer-events:auto so the view is a
      // solid display (clicks don't secretly drive the hidden Foundry canvas);
      // Foundry UI still gets its clicks because it paints above this.
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '5',
      display: 'block',
      background: '#000',
      pointerEvents: 'auto',
    });
    mount.host.appendChild(canvas);

    // preserveDrawingBuffer:true -- WITHOUT this, the browser is free to clear
    // the drawing buffer immediately after each frame composites, so
    // gl.readPixels() called later from a button click (not from inside the
    // render callback itself) can legitimately read back (0,0,0,0) regardless
    // of what was actually drawn -- confirmed live 2026-07-15: the
    // 'renderedPixels' diagnostic read all-zero even though the indirection
    // buffer (plain JS state, unaffected by this) showed correct, non-degenerate
    // data. A real WebGL behavior, not a rendering bug -- but it made the
    // diagnostic itself unreliable. Kept for the diagnostics to stay trustworthy.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(canvasW, canvasH, false);

    const atlas = new PageAtlas({ THREE, layout, renderer });
    const floors = new Map(); // floorIndex -> floor entry (see ensureFloorLoaded)
    let loopActive = false; // tracks whether the render loop is running (batch uploads pause/restore it)

    async function ensureFloorLoaded(floorIndex) {
      if (floors.has(floorIndex)) return floors.get(floorIndex);
      const sourceBitmap = await getSourceBitmap(imageUrlForFloor(floorIndex));

      // NON-SQUARE WORLDS AREN'T SUPPORTED YET — fail loud, never silently
      // mis-render (Keyhole doctrine #1). PageTable takes ONE worldSizePx (the
      // page grid is square by construction, see page-table.js); passing a
      // rectangular image's width here would silently ignore its real height,
      // corrupting every page crop along that axis rather than erroring. The
      // torture fixture is square by construction so this never trips on it;
      // it exists for real scene art (Stage 2B — src/foundry/active-scene-source.js),
      // where Foundry's own default scene dimensions (4000x3000,
      // common/documents/scene.mjs) are the norm, not the exception. Rectangular
      // world support is real, scoped follow-up work (page-table.js/residency.js/
      // the shader's uWorldSizePx/uMipPagesPerAxis all currently assume square),
      // not silently dropped — tracked, not built here.
      if (sourceBitmap.width !== sourceBitmap.height) {
        throw new Error(
          `vt-pan-viewer: non-square world images aren't supported yet (floor ${floorIndex}'s image is ` +
            `${sourceBitmap.width}x${sourceBitmap.height}, not square) — PageTable's page grid assumes a ` +
            `square world. A square asset (e.g. 12000x12000) works today; rectangular scenes need the ` +
            `page-table/residency/shader rectangular-world support this increment deliberately deferred.`
        );
      }

      const table = new PageTable({ id: `panviewer:floor${floorIndex}`, worldSizePx: sourceBitmap.width });

      // The indirection is a flattened mip pyramid (all mips in one small
      // texture) — see page-table.js's computeIndirectionAtlasLayout + the
      // shader header. buf/texture are sized to the packed pyramid, not just mip 0.
      const indirectionLayout = computeIndirectionAtlasLayout(table);
      const { width, height } = indirectionLayout;
      const buf = new Uint8Array(width * height * 4); // all-zero = not resident everywhere, initially
      const indirectionTexture = new THREE.DataTexture(buf, width, height, THREE.RGBAFormat);
      indirectionTexture.flipY = false;
      indirectionTexture.generateMipmaps = false;
      indirectionTexture.minFilter = THREE.NearestFilter;
      indirectionTexture.magFilter = THREE.NearestFilter;

      // Per-mip uniform arrays (flat, fixed VT_MAX_MIPS length; unused tail
      // stays 0 and is never indexed — the shader only touches [reqMip,maxMip]).
      const mipOriginArr = new Int32Array(VT_MAX_MIPS * 2);
      const mipPagesArr = new Int32Array(VT_MAX_MIPS);
      for (let m = 0; m < indirectionLayout.origins.length; m++) {
        mipOriginArr[m * 2] = indirectionLayout.origins[m].x;
        mipOriginArr[m * 2 + 1] = indirectionLayout.origins[m].y;
        mipPagesArr[m] = indirectionLayout.origins[m].pagesPerAxis;
      }

      // COARSE PINS (§4.1): the top few mip levels of THIS floor, pinned
      // permanently so the whole floor always renders (soft) and floor switches
      // are instant. Decode + upload + pin them once, now.
      const topMips = coarseTopMipsForCap(table);
      const coarsePages = coarsePinSet(table, { topMips });
      const coarseKeySet = new Set(coarsePages.map((p) => p.key));

      const entry = {
        table,
        sourceBitmap,
        indirectionTexture,
        buf,
        width,
        height,
        indirectionLayout,
        mipOriginArr,
        mipPagesArr,
        coarsePages,
        coarseKeySet,
        coarseTopMips: topMips,
        residentViewKeys: new Set(),
      };
      floors.set(floorIndex, entry);

      await requestDecodeUpload(entry, coarsePages, 'coarse');
      return entry;
    }

    // The quad + shader: IDENTICAL pattern to the proven smoke test (same
    // vertex shader, same uniform names, same v-flip in the UV remap) — see
    // that file's comments for why each piece is shaped the way it is.
    const quadGeometry = new THREE.PlaneGeometry(2, 2);
    const quadMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPageAtlas: { value: atlas.texture },
        uPageTable: { value: null }, // set per-floor in updateResidency()
        uPagesPerAxis: { value: layout.pagesPerAxis },
        uPagesPerLayer: { value: layout.pagesPerLayer },
        uPageSizePx: { value: layout.pageSizePx },
        uBorderPx: { value: 4 },
        uAtlasSizePx: { value: layout.atlasSizePx },
        uWorldSizePx: { value: 0 }, // set per-floor in updateResidency()
        // Multi-mip: the finest mip to TRY (analytic, per view) + the coarsest,
        // and the flattened-pyramid per-mip layout the shader walks. uMipOrigin
        // is a flat Int32Array (ivec2[VT_MAX_MIPS] == 2 ints/level) — THREE
        // uploads it via gl.uniform2iv directly; uMipPagesPerAxis via uniform1iv.
        // Both are replaced with the current floor's arrays on floor bind.
        uRequestedMip: { value: 0 },
        uMaxMip: { value: 0 },
        uMipOrigin: { value: new Int32Array(VT_MAX_MIPS * 2) },
        uMipPagesPerAxis: { value: new Int32Array(VT_MAX_MIPS) },
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
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(quadGeometry, quadMaterial));
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); // matches fullscreen-present.js's convention

    let view = null; // set once the first floor is loaded (needs its worldSizePx)
    const frameTimes = [];
    let lastError = null;
    let lastFramedUV = null; // set by reframeQuad(), exposed in diagnostics for ground-truth debugging

    /** Ground truth, not theory: actual rendered canvas pixels + actual indirection buffer contents. */
    function sampleDiagnostics(entry) {
      const out = {};
      try {
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        const points = {
          center: [Math.floor(canvasW / 2), Math.floor(canvasH / 2)],
          topLeft: [4, canvasH - 4], // GL readPixels Y is bottom-up; this is visual top-left
          bottomRight: [canvasW - 4, 4],
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

    function renderFrame() {
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

    /**
     * Decode + upload a set of pages (at each page's OWN mip) and pin them with
     * `pinClass`. Shared by the coarse-pin load and the per-view residency
     * update so there is exactly ONE decode/upload path.
     *
     * TWO PASSES ON PURPOSE (confirmed live 2026-07-15 — the actual cause of
     * "no texture bound to target" on every pan/zoom): the render loop runs
     * CONTINUOUSLY, so a render() can land between two separate upload calls
     * and desync THREE's texture-unit binding cache. Pass 1 does all the
     * (async, GL-free) decoding — safe to interleave. Pass 2 uploads
     * everything already-decoded in one tight SYNCHRONOUS loop (no `await`
     * between GL calls), with the loop paused and atlas.prepareForUploadBatch()
     * resetting the stale binding cache first (see atlas.js for the full root cause).
     */
    async function requestDecodeUpload(entry, pages, pinClass) {
      const decodedForUpload = [];
      for (const page of pages) {
        const alreadyInCache = cache.isResident(page.key);
        const { resident, slot } = cache.request(page.key, { pin: pinClass });
        if (!resident) continue; // cache full — a structural miss, not a crash; coarse fallback covers it
        if (!alreadyInCache) {
          try {
            const worldRectPage = pageWorldRect(entry.table, page.mip, page.px, page.py);
            const decoded = await decodePage(entry.sourceBitmap, worldRectPage);
            decodedForUpload.push({ slot, decoded });
          } catch (err) {
            lastError = `decode failed for ${page.key}: ${err?.message || err}`;
            console.error('[vt-pan-viewer]', lastError);
          }
        }
      }
      if (decodedForUpload.length > 0) {
        const wasActive = loopActive;
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
        if (wasActive) renderer.setAnimationLoop(renderFrame); // restore (never start prematurely at first load)
      }
    }

    /** Write one page's current cache slot into the flattened-pyramid indirection buffer. */
    function writeIndirection(entry, page) {
      const slot = cache.slotOf(page.key);
      if (slot === null) return;
      const o = entry.indirectionLayout.origins[page.mip];
      const x = o.x + page.px;
      const y = o.y + page.py;
      const i = (y * entry.width + x) * 4;
      entry.buf[i] = slot & 0xff;
      entry.buf[i + 1] = (slot >> 8) & 0xff;
      entry.buf[i + 2] = 0;
      entry.buf[i + 3] = 255;
    }

    let lastFloorIndex = null;

    async function updateResidency() {
      if (lastFloorIndex !== null && lastFloorIndex !== view.floorIndex) {
        // Leaving a floor: unpin its VIEW pages only (never its coarse pins —
        // those stay resident for every floor so a switch back renders
        // instantly, §4.1/§4.5). Unpin never evicts directly — PageCache's LRU
        // decides that under real pressure — so a quick switch-and-back is free.
        const prevEntry = floors.get(lastFloorIndex);
        if (prevEntry) {
          for (const key of prevEntry.residentViewKeys) cache.unpin(key);
          prevEntry.residentViewKeys = new Set();
        }
      }
      lastFloorIndex = view.floorIndex;

      const entry = await ensureFloorLoaded(view.floorIndex);
      if (quadMaterial.uniforms.uPageTable.value !== entry.indirectionTexture) {
        // Floor bind: point every per-floor uniform at THIS floor's data.
        // Assigning fresh array references (per entry) guarantees THREE
        // re-uploads them; within a floor they're constant.
        quadMaterial.uniforms.uPageTable.value = entry.indirectionTexture;
        quadMaterial.uniforms.uWorldSizePx.value = entry.table.worldSizePx;
        quadMaterial.uniforms.uMaxMip.value = entry.table.maxMip;
        quadMaterial.uniforms.uMipOrigin.value = entry.mipOriginArr;
        quadMaterial.uniforms.uMipPagesPerAxis.value = entry.mipPagesArr;
      }

      // Aspect-correct framing: the canvas now fills the (non-square) scene
      // area, so the world rect must match the canvas aspect or the map
      // stretches (view-state.js's aspect param). halfSpanPx is the vertical
      // zoom; horizontal widens by width/height.
      const aspect = canvasW / canvasH;
      const worldRect = viewToWorldRect(view, aspect);
      // Analytic mip selection (§4.1 — top-down camera, no GPU feedback): pick
      // the finest mip that resolves for this zoom, plus a coarser prefetch set.
      // Use the LARGER canvas axis for a conservative (sharper) mip choice.
      const plan = planResidency(entry.table, worldRect, Math.max(canvasW, canvasH), { guardPages: 1 });
      quadMaterial.uniforms.uRequestedMip.value = plan.mip;

      // The view's needed pages = fine + coarser prefetch, EXCLUDING any page
      // already held by this floor's permanent coarse pins (never downgrade a
      // 'coarse' pin to 'view' — that would let a floor switch unpin it).
      const neededViewPages = [...plan.fine, ...plan.prefetchCoarser].filter((p) => !entry.coarseKeySet.has(p.key));
      const diff = diffResidency(entry.residentViewKeys, neededViewPages);

      await requestDecodeUpload(entry, diff.toRequest, 'view');
      for (const key of diff.toUnpin) cache.unpin(key);
      entry.residentViewKeys = diff.nextKeys;

      // Rebuild the indirection buffer FRESH from the cache's own current slot
      // mapping every time (never a separately-tracked copy) — this is what
      // keeps it correct across evictions: an evicted-and-reassigned page must
      // never leave a stale pointer. Both the always-resident coarse pins AND
      // the current view pages are written, so the shader's coarse-fallback
      // walk always finds SOMETHING resident (blur, never magenta).
      entry.buf.fill(0);
      for (const page of entry.coarsePages) writeIndirection(entry, page);
      for (const page of neededViewPages) writeIndirection(entry, page);
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
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable))
        return;
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

    // The scene area resizes (window resize, sidebar collapse, Foundry
    // relayout). Re-measure the host, resize the drawing buffer to match, and
    // recompute residency at the new aspect so the map never stretches. Debounced
    // to a rAF-ish microtask via a simple in-flight guard is overkill here — the
    // handler is cheap and resize events are coarse.
    let resizePending = false;
    function onResize() {
      if (resizePending || !_active) return;
      resizePending = true;
      queueMicrotask(async () => {
        resizePending = false;
        if (!_active) return;
        const { width, height } = measureHost(mount.host);
        if (width === canvasW && height === canvasH) return;
        canvasW = width;
        canvasH = height;
        renderer.setSize(canvasW, canvasH, false);
        await updateResidency().catch((err) => console.error('[vt-pan-viewer] resize residency failed:', err));
      });
    }

    // First floor load determines the initial view's world size. Frame a
    // generous chunk of the world initially (quarter-world half-span → ~half the
    // map vertically) so it immediately reads as "the map fills the display,"
    // not a tiny zoomed-in patch — this view is served largely by coarse pins,
    // so it's instant. '-'/'+' zoom and arrows/WASD pan from there.
    const firstEntry = await ensureFloorLoaded(0);
    view = createInitialViewState({
      worldSizePx: firstEntry.table.worldSizePx,
      floorIndex: 0,
      halfSpanPx: firstEntry.table.worldSizePx * 0.25,
    });
    view.__lastWorldSizePx = firstEntry.table.worldSizePx;
    await updateResidency();

    loopActive = true;
    renderer.setAnimationLoop(renderFrame);

    // Background prewarm (non-blocking, best-effort): stream every OTHER floor's
    // coarse pins so a floor switch is instant (§4.5 — coarse pins for every
    // floor always resident). Fire-and-forget so it never delays floor 0's
    // first paint; a fetch failure on one floor can't take the viewer down.
    for (let f = 1; f < floorCount; f++) {
      ensureFloorLoaded(f).catch((err) => console.warn(`[vt-pan-viewer] prewarm floor ${f} failed:`, err));
    }

    // capture:true — see onKeyDown's comment. Must run before Foundry's own
    // window-level keydown listener (registered at Foundry boot, bubble phase).
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('resize', onResize);

    _active = {
      THREE,
      renderer,
      atlas,
      canvas,
      onResize,
      quadMaterial,
      quadGeometry,
      floors,
      cache,
      layout,
      onKeyDown,
      floorCount,
      getView: () => view,
      applyKeyAndUpdate, // exposed so MapShine.soakHooks.pan drives the EXACT same path a real keypress does
      getDiagnostics() {
        const avgMs = frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0;
        const entry = floors.get(view.floorIndex);
        return {
          view,
          layout,
          canvasSizePx: { width: canvasW, height: canvasH },
          mountedInBoard: mount.fill && mount.host !== document.body,
          cacheStats: cache.stats(),
          floorsLoaded: Array.from(floors.keys()),
          currentFloorResidentCount: entry?.residentViewKeys.size ?? 0,
          // Multi-mip state (coarse-fallback gate evidence): the finest mip
          // being tried this view, the floor's top-level, its coarse-pin depth
          // + page count, and the packed-pyramid indirection dimensions.
          mip: {
            requested: quadMaterial.uniforms.uRequestedMip.value,
            max: quadMaterial.uniforms.uMaxMip.value,
            coarseTopMips: entry?.coarseTopMips ?? null,
            coarsePinnedPages: entry?.coarsePages.length ?? null,
            indirectionPyramid: entry ? `${entry.width}x${entry.height}` : null,
          },
          renderMsAvgLast120: Math.round(avgMs * 100) / 100,
          lastError,
          ...sampleDiagnostics(entry),
          controls: 'Arrow keys/WASD pan, +/- zoom, 0-2 or Tab floor-switch (keys work anywhere, not in a text field).',
        };
      },
    };

    console.log(
      '[vt-pan-viewer] started — filling the scene area (PIXI occluded). Arrow keys/WASD pan, +/- zoom, 0-2/Tab floor-switch.'
    );
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
