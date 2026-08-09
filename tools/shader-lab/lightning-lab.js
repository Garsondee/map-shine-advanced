/**
 * Shader Lab driver — LIGHTNING. Imports the real production lifecycle
 * (`createLightningSubsystem`) and the real material/geometry builders it
 * calls internally, unmodified, from `src/effects/lightning-subsystem.js`
 * (which itself imports `lightning-render.js`) — same doctrine as `lab.js`'s
 * sun-shadow driver, see `docs/planning/Shader-Lab.md`.
 *
 * ============================================================================
 * WHY THIS IS A SEPARATE FILE, NOT A MODE ON THE `ShaderLab` CLASS
 * ============================================================================
 *
 * `lab.js`'s `ShaderLab` is built around a STATIC BAKE: one `QuadMesh` full-
 * screen pass, rendered OFFSCREEN, read back once per `refresh()` and manually
 * blitted to a plain 2D `<canvas>` via `putImageData`. That shape fits a
 * shadow FIELD (one value per world position, unchanging until a slider
 * moves) perfectly and fits lightning not at all: a bolt is a real MESH in a
 * real SCENE, animated continuously against `uGlobalTimeMs`, with its own
 * spawn/reap POPULATION lifecycle. This driver instead renders DIRECTLY to a
 * visible WebGPU canvas every animation frame — the same architecture
 * `vt-pan-viewer.js`/`boot.js` use in production — because that is what
 * actually watching a bolt fire, branch, flicker, and expire requires.
 *
 * Verification scope, stated plainly: this drives the REAL bolt mesh
 * (lightning-subsystem.js + lightning-render.js) end to end. It does NOT
 * render the origin-flash POINT LIGHT — that lives in `point-light-pool.js`,
 * which reads Foundry wall data and the shared light-mesh pool, neither of
 * which exists here (see that module's own header for why it has no Node
 * test either — the identical boundary applies to a browser-only lab). The
 * origin-flash light's math is still real and live here: `buildLightningLightSources`
 * (pure, from lightning-geometry.js) runs every readout tick and its
 * descriptor fields are surfaced numerically, so the DATA is verified even
 * though the actual point-light rendering is not.
 *
 * @module tools/shader-lab/lightning-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { createLightningSubsystem } from '../../src/effects/lightning-subsystem.js';
import { buildLightningLightSources } from '../../src/effects/lightning-geometry.js';
import { LIGHTNING_PARAMS } from '../../src/effects/lightning.js';

const statusEl = document.getElementById('lightningStatus');
const log = (msg) => {
  console.log('[lightning-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const DEFAULT_PARAMS = Object.fromEntries(Object.entries(LIGHTNING_PARAMS).map(([k, v]) => [k, v.default]));

/** A flat-colour marker dot (start/end anchor) — LAB-ONLY chrome, never
 * imported by src/. Built via the same TSL/NodeMaterial path as the real
 * shader (not a classic Material) since nothing in this vendored three.webgpu
 * build has ever been proven to load a classic-material pipeline. */
function buildMarkerMesh(color, radius = 10) {
  const { Fn, vec4, float } = THREE.TSL;
  const geometry = new THREE.CircleGeometry(radius, 20);
  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => vec4(float(color[0]), float(color[1]), float(color[2]), float(1)))();
  return new THREE.Mesh(geometry, material);
}

class LightningLab {
  constructor() {
    this.renderer = null;
    this.camera = null;
    this.sub = null; // createLightningSubsystem() result
    this.uGlobalTimeMs = null;
    this._rafId = null;
    this._active = true;
    this._queryRt = null;
    this._lastReadoutMs = 0;
    // A VIRTUAL clock, decoupled from real wall time — see advance()'s own
    // header for why this exists at all.
    this._virtualNowMs = 0;
    this._lastRafRealMs = null;

    this.state = {
      enabled: true,
      perfTier: 3,
      params: { ...DEFAULT_PARAMS },
      source: { startX: 500, startY: 800, endX: 560, endY: 120 }, // "sky" -> "ground"
    };
  }

  async init(canvas) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
    await this.renderer.init();
    log(`renderer backend: ${this.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
    this.renderer.setClearColor(0x05070c, 1);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.uGlobalTimeMs = THREE.TSL.uniform(THREE.TSL.float(0));
    this.sub = createLightningSubsystem({
      THREE,
      uGlobalTimeMs: this.uGlobalTimeMs,
      getLightningRenderState: () => this._renderState(),
    });

    this.startMarker = buildMarkerMesh([1, 0.35, 0.2]);
    this.endMarker = buildMarkerMesh([0.3, 1, 0.4]);
    this.sub.scene.add(this.startMarker);
    this.sub.scene.add(this.endMarker);
    this._syncMarkers();
    this._fitCamera();

    this._frame = this._frame.bind(this);
    this._rafId = requestAnimationFrame(this._frame);
  }

  // ── the ONE seam the real subsystem reads — mirrors boot.js's own
  // getLightningRenderState shape exactly (Anchors are a fixed synthetic
  // pair here rather than the anchor authority; everything downstream is the
  // real production path). ──────────────────────────────────────────────
  _renderState() {
    const { startX, startY, endX, endY } = this.state.source;
    return {
      enabled: this.state.enabled,
      params: this.state.params,
      perfTier: this.state.perfTier,
      anchors: [
        { id: 'lab-start', x: startX, y: startY, params: { role: 'start', linkId: 'lab:bolt', intensity: 1 } },
        { id: 'lab-end', x: endX, y: endY, params: { role: 'end', linkId: 'lab:bolt', intensity: 1 } },
      ],
    };
  }

  _syncMarkers() {
    const { startX, startY, endX, endY } = this.state.source;
    this.startMarker.position.set(startX, startY, 0.5);
    this.endMarker.position.set(endX, endY, 0.5);
  }

  /** Centres + sizes the orthographic frustum on the current bolt source,
   * generously padded for fractal displacement and branch spread. Refit on
   * source/shape changes only — not every frame, this is cosmetic framing,
   * not a per-frame cost worth paying. */
  _fitCamera() {
    const { startX, startY, endX, endY } = this.state.source;
    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const diag = Math.max(50, Math.hypot(maxX - minX, maxY - minY));
    // Branches can reach up to branchLengthMax (1.5x) off the main bolt, plus
    // macro/micro jitter — generous, not exact; a clipped branch tip is a
    // camera-framing nit, not a correctness bug.
    const half = Math.max(260, diag * 0.75 + Math.max(0, this.state.params.macroDisplacement || 0));

    this.camera.position.set(cx, cy, 100);
    this.camera.left = -half;
    this.camera.right = half;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.near = 0.1;
    this.camera.far = 1000;
    this.camera.lookAt(cx, cy, 0);
    this.camera.updateProjectionMatrix();
    this._viewRect = { minX: cx - half, maxX: cx + half, minY: cy - half, maxY: cy + half };
  }

  setSource(partial) {
    Object.assign(this.state.source, partial);
    this._syncMarkers();
    this._fitCamera();
  }

  setParams(partial) {
    Object.assign(this.state.params, partial);
  }

  setPerfTier(n) {
    this.state.perfTier = Math.max(0, Math.min(3, Math.round(Number(n) || 0)));
  }

  setEnabled(v) {
    this.state.enabled = !!v;
  }

  forceStrike() {
    this.sub.forceStrike();
  }

  /** Pause/resume the animation loop — the sun-shadow/specular panels and
   * this one share the page; no reason to keep driving a hidden canvas. */
  setActive(v) {
    this._active = !!v;
    if (!this._active) this._lastRafRealMs = null; // next activation starts clean, no giant catch-up jump
    if (this._active && this._rafId === null) {
      this._rafId = requestAnimationFrame(this._frame);
    }
  }

  /** THE ONE place time advances and the real subsystem gets driven — a
   * VIRTUAL clock, deliberately decoupled from real wall time.
   *
   * ⚠️ Confirmed live in this exact environment: `requestAnimationFrame` is
   * FULLY PAUSED (not merely throttled) whenever the Browser pane isn't the
   * actively-displayed/composited one (`document.hidden === true` — measured
   * 0 rAF ticks across 300ms while unwatched). A driver built to only
   * animate via rAF is therefore an instrument that silently does nothing
   * the moment nobody is looking at it — precisely the failure
   * `feedback_instruments_must_not_lie` (project memory) names. rAF below
   * remains a real, useful CONVENIENCE for watching the bolt animate live
   * when the pane genuinely is visible; it is never the only path. Every
   * javascript_tool-driven verification calls `advance()` directly instead,
   * which has zero dependency on any browser timer firing at all. */
  advance(deltaMs) {
    this._virtualNowMs += Math.max(0, Number(deltaMs) || 0);
    const nowMs = this._virtualNowMs;
    this.uGlobalTimeMs.value = nowMs;
    this.sub.sync(nowMs);
    this.renderer.render(this.sub.scene, this.camera);
    if (nowMs - this._lastReadoutMs > 200) {
      this._lastReadoutMs = nowMs;
      this._updateLegend(nowMs);
    }
    return this.readout(nowMs);
  }

  _frame(realMs) {
    if (this._active) {
      const delta = this._lastRafRealMs === null ? 16 : realMs - this._lastRafRealMs;
      this._lastRafRealMs = realMs;
      // Clamp a huge gap (e.g. resuming after the pane was hidden a while) to
      // one ordinary frame step, so resuming never dumps a giant time-jump on
      // the subsystem in one call.
      this.advance(Math.max(0, Math.min(250, delta)));
    }
    this._rafId = requestAnimationFrame(this._frame);
  }

  _updateLegend(nowMs) {
    const legend = document.getElementById('lightningLegend');
    if (!legend) return;
    const r = this.readout(nowMs);
    const tierNames = ['strike', 'branching', 'flash', 'originFlash'];
    legend.textContent =
      `tier=${r.perfTier} (${tierNames[r.perfTier]})  strands=${r.strandCount} (main=${r.mainCount} branch=${r.branchCount})  droppedForCapacity=${r.droppedForCapacity}\n` +
      `outsideFlash01=${r.outsideFlash01.toFixed(3)}\n` +
      (r.originFlash
        ? `originFlash[0]: radius=${r.originFlash.radius.toFixed(0)}px alpha01=${r.originFlash.alpha01.toFixed(3)} colour=${r.originFlash.color.map((c) => c.toFixed(2)).join(',')}`
        : 'originFlash: none active');
  }

  /** Plain-JS readout, no GPU readback — the subsystem's own live JS state
   * (strand population, schedule outcomes, the outside-flash signal) plus a
   * fresh call to the REAL `buildLightningLightSources` for the origin-flash
   * DATA (never rendered here — see this module's own header). Queryable via
   * `window.lightningLab.readout()` from javascript_tool with no screenshot
   * needed for numeric checks. */
  readout(nowMs = this._virtualNowMs) {
    const strands = this.sub.activeStrands();
    const mainCount = strands.filter((s) => !s.isBranch).length;
    const lights = buildLightningLightSources(strands, nowMs, this.state.params);
    return {
      perfTier: this.state.perfTier,
      strandCount: strands.length,
      mainCount,
      branchCount: strands.length - mainCount,
      droppedForCapacity: this.sub.droppedForCapacity(),
      outsideFlash01: this.sub.outsideFlash01(),
      originFlashCount: lights.length,
      originFlash: lights[0]
        ? { sourceId: lights[0].sourceId, radius: lights[0].radius, alpha01: lights[0].alpha01, color: lights[0].color }
        : null,
    };
  }

  /** On-demand pixel query — a ONE-OFF offscreen render into a small RT
   * (never the live on-screen loop), read back async. World->pixel row
   * orientation is UNCALIBRATED (no selfTest() equivalent yet, unlike
   * `lab.js`'s sun-shadow driver) — good enough for "is something bright near
   * here" sanity checks; treat an exact row/col as unverified until checked
   * live, same caution `feedback_y_flip_recurring_risk` names generally. */
  async samplePixel(worldX, worldY) {
    const dim = 256;
    if (!this._queryRt) {
      this._queryRt = new THREE.RenderTarget(dim, dim, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    }
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._queryRt);
    this.renderer.render(this.sub.scene, this.camera);
    this.renderer.setRenderTarget(prev);

    const r = this._viewRect;
    const u = (worldX - r.minX) / (r.maxX - r.minX);
    const v = (worldY - r.minY) / (r.maxY - r.minY);
    const px = Math.max(0, Math.min(dim - 1, Math.round(u * (dim - 1))));
    const py = Math.max(0, Math.min(dim - 1, Math.round((1 - v) * (dim - 1))));
    const buf = await this.renderer.readRenderTargetPixelsAsync(this._queryRt, px, py, 1, 1);
    const bytes = ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
    return { x: worldX, y: worldY, r: bytes[0] / 255, g: bytes[1] / 255, b: bytes[2] / 255, a: bytes[3] / 255 };
  }

  /** Max (r+g+b) found over a grid spanning the current camera view — a
   * bolt's fractal path can bow away from the start/end straight line by up
   * to `macroDisplacement` world units, so probing one guessed point risks a
   * false "nothing visible" miss. Scanning the whole framed view sidesteps
   * needing to know exactly where the path landed. Reuses `samplePixel`
   * verbatim (one offscreen render per grid cell — 256x256, cheap). */
  async sampleMaxBrightnessInView(gridN = 9) {
    const r = this._viewRect;
    let best = { sum: -1 };
    for (let iy = 0; iy < gridN; iy++) {
      for (let ix = 0; ix < gridN; ix++) {
        const wx = r.minX + ((ix + 0.5) / gridN) * (r.maxX - r.minX);
        const wy = r.minY + ((iy + 0.5) / gridN) * (r.maxY - r.minY);
        const px = await this.samplePixel(wx, wy);
        const sum = px.r + px.g + px.b;
        if (sum > best.sum) best = { ...px, sum };
      }
    }
    return best;
  }

  /**
   * ==========================================================================
   * DEPTH-AUTHORITY GATE — SYNTHETIC WIRING TEST (2026-08-05)
   * ==========================================================================
   * Builds a SELF-CONTAINED depth-pass render target + tiny scene, entirely
   * separate from `vt/scene-depth.js`'s own dedicated camera/projection
   * formula — this test does NOT re-verify `computeExpectedStoredDepth`'s
   * algebra (that file's own header already names it "NOT YET VERIFIED
   * AGAINST THE GPU'S OWN ACTUAL OUTPUT" and out of scope here) or the shared
   * `buildDepthHeightGateNode` function itself (already proven live for point
   * lights, `docs/planning/Depth-Buffer.md`). What IS new and unverified this
   * session is the WIRING: `lightning-render.js`'s own `depthTexNode`/
   * `depthFlagsTexNode` consumption, `lightning-subsystem.js`'s bake-once-
   * per-strand `expectedDepth`, and `lightning-geometry.js`'s per-vertex
   * write of it — all exercised end-to-end here with a REAL GPU-sampled depth
   * texture (never faked at the JS level), same "build the instrument"
   * discipline this session's NaN-bug investigation already required.
   *
   * `resolveExpectedDepth` here is a LAB STUB returning a fixed, directly-
   * controlled float — this test does not exercise `depthAuthority.
   * rankOfElevation`/`computeTieSafeExpectedDepth` either (pure JS, already
   * covered by Node tests); it exists only so the shader has SOME comparable
   * uniform to gate against.
   */
  async setupSyntheticDepthGate() {
    const dim = 64;
    this._depthRt = new THREE.RenderTarget(dim, dim, { depthBuffer: true });
    this._depthRt.depthTexture = new THREE.DepthTexture(dim, dim);
    this._depthRt.depthTexture.type = THREE.FloatType;

    this._depthCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    this._depthCamera.position.set(0, 0, 5);
    this._depthCamera.lookAt(0, 0, 0);
    this._depthScene = new THREE.Scene();

    // Flags texture: plain RGBA8, hand-authored, all-zero — floorIndex=0,
    // flags byte=0 (no restrictsLight/isTile bits), so the flags-gate half
    // of buildDepthHeightGateNode is a guaranteed no-op and this test isolates
    // the RANK comparison alone.
    const flagsData = new Uint8Array(4 * 4 * 4);
    this._flagsTex = new THREE.DataTexture(flagsData, 4, 4, THREE.RGBAFormat, THREE.UnsignedByteType);
    this._flagsTex.needsUpdate = true;

    const { texture, uniform, float } = THREE.TSL;
    this._syntheticExpectedDepth = uniform(float(0.5));

    this.sub.dispose();
    this.sub = createLightningSubsystem({
      THREE,
      uGlobalTimeMs: this.uGlobalTimeMs,
      getLightningRenderState: () => this._renderState(),
      depthTexNode: texture(this._depthRt.depthTexture),
      depthFlagsTexNode: texture(this._flagsTex),
      resolveExpectedDepth: () => this._syntheticExpectedDepth.value,
    });
    this.sub.scene.add(this.startMarker);
    this.sub.scene.add(this.endMarker);
    log('synthetic depth gate wired: construction OK, no throw.');
  }

  /** Clears the synthetic depth target to its default FAR value (1.0) only —
   * the "nothing occluding" case: `depthHere(1.0) < uLightExpectedDepth(0.5)`
   * is false, so `buildDepthHeightGateNode` must read OPEN (gate=1). */
  renderSyntheticDepthClear() {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._depthRt);
    this.renderer.clear(true, true, true);
    this.renderer.setRenderTarget(prev);
  }

  /** Renders a big plane very close to the depth camera — the "something
   * occluding" case: stored depth lands near 0, `0 < 0.5` is true, so the
   * gate must read CLOSED (gate=0) everywhere on screen. */
  renderSyntheticDepthNearPlane() {
    if (!this._nearPlaneMesh) {
      const geo = new THREE.PlaneGeometry(4, 4);
      const mat = new THREE.NodeMaterial();
      mat.fragmentNode = THREE.TSL.vec4(1, 1, 1, 1);
      this._nearPlaneMesh = new THREE.Mesh(geo, mat);
      this._nearPlaneMesh.position.set(0, 0, 4.9); // camera at z=5, near=0.01 -> stored depth near 0
      this._depthScene.add(this._nearPlaneMesh);
    }
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._depthRt);
    this.renderer.clear(true, true, true);
    this.renderer.render(this._depthScene, this._depthCamera);
    this.renderer.setRenderTarget(prev);
  }
}

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------
const lab = new LightningLab();
window.lightningLab = lab;

function wireRange(id, apply, decimals = 0) {
  const el = document.getElementById(id);
  if (!el) return;
  const valEl = document.getElementById(`${id}Val`);
  const show = () => {
    if (valEl) valEl.textContent = Number(el.value).toFixed(decimals);
  };
  show();
  el.addEventListener('input', () => {
    apply(Number(el.value));
    show();
  });
}
function wireColor(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => lab.setParams({ [key]: el.value }));
}

const canvas = document.getElementById('lightningView');
if (canvas) {
  lab
    .init(canvas)
    .then(() => log('Lightning Lab ready.'))
    .catch((err) => log(`INIT FAILED: ${err.stack || err.message}`));

  wireRange('boltStartX', (v) => lab.setSource({ startX: v }));
  wireRange('boltStartY', (v) => lab.setSource({ startY: v }));
  wireRange('boltEndX', (v) => lab.setSource({ endX: v }));
  wireRange('boltEndY', (v) => lab.setSource({ endY: v }));

  wireColor('outerColor', 'outerColor');
  wireColor('coreColor', 'coreColor');
  wireRange('brightness', (v) => lab.setParams({ brightness: v }), 1);
  wireRange('width', (v) => lab.setParams({ width: v }));
  wireRange('taper', (v) => lab.setParams({ taper: v }), 2);
  wireRange('glowStrength', (v) => lab.setParams({ glowStrength: v }), 1);

  wireRange('segments', (v) => lab.setParams({ segments: v }));
  wireRange('curveAmount', (v) => lab.setParams({ curveAmount: v }), 2);
  wireRange('macroDisplacement', (v) => {
    lab.setParams({ macroDisplacement: v });
    lab._fitCamera();
  });
  wireRange('microJitter', (v) => lab.setParams({ microJitter: v }));
  wireRange('branchChance', (v) => lab.setParams({ branchChance: v }), 2);
  wireRange('branchMax', (v) => lab.setParams({ branchMax: v }));
  wireRange('branchAngleDeg', (v) => lab.setParams({ branchAngleDeg: v }));

  wireRange('minDelayMs', (v) => lab.setParams({ minDelayMs: v }));
  wireRange('maxDelayMs', (v) => lab.setParams({ maxDelayMs: v }));
  wireRange('strikeDurationMs', (v) => lab.setParams({ strikeDurationMs: v }));
  wireRange('leaderFraction', (v) => lab.setParams({ leaderFraction: v }), 2);
  wireRange('flickerChance', (v) => lab.setParams({ flickerChance: v }), 2);
  wireRange('outsideFlashGain', (v) => lab.setParams({ outsideFlashGain: v }), 2);

  document.getElementById('lightningEnabled')?.addEventListener('change', (e) => lab.setEnabled(e.target.checked));
  document.getElementById('forceStrike')?.addEventListener('click', () => lab.forceStrike());
  document.querySelectorAll('#lightningControls button[data-ltier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      lab.setPerfTier(Number(btn.dataset.ltier));
      document
        .querySelectorAll('#lightningControls button[data-ltier]')
        .forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  document.querySelector(`#lightningControls button[data-ltier="${lab.state.perfTier}"]`)?.classList.add('active');

  // ── the effect switcher lives in lab.js (sun/specular), owned by that
  // session's own work — a SECOND, independent listener on the same <select>
  // rather than an edit to that file, so this never collides with it. Toggles
  // this driver's OWN left-column canvas + controls panel, and pauses its RAF
  // loop while another effect's panel is what's showing (lab.js's own
  // sun/specular panels have no continuous loop to pause — only this one does). ──
  const effectSelect = document.getElementById('effect');
  const lightningLeft = document.getElementById('lightningLeft');
  const lightningControlsPanel = document.getElementById('lightningControls');
  const applyEffectVisibility = (value) => {
    const isLightning = value === 'lightning';
    if (lightningLeft) lightningLeft.style.display = isLightning ? '' : 'none';
    if (lightningControlsPanel) lightningControlsPanel.style.display = isLightning ? '' : 'none';
    lab.setActive(isLightning);
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');
}
