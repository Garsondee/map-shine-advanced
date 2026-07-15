/**
 * Map Shine Advanced 0.6.0 — "Keyhole"
 * =====================================
 * src/boot.js — the ONE entry point of the V3 rebirth (docs/planning/Keyhole.md §3).
 *
 * `module.json`'s `esmodules` points at this file and NOTHING else. Everything the
 * module does in the new architecture is reached from here: init/ready hooks, the
 * virtual-texture core (src/vt/), the frame graph (src/graph/), the Foundry adapter
 * (src/foundry/), and the effects. None of it exists yet — this is Stage 0.
 *
 * THE DOCTRINE (Keyhole §0), enforced from the first line:
 *   1. One path per behavior. No fallback that routes through legacy code.
 *   2. `legacy/` is frozen and quarantined — src/ NEVER imports from legacy/.
 *   3. Nothing is ever allocated at world resolution (enforced later in the allocator).
 *   4. The hard case ships first (the torture scene is Stage 0's fixture).
 *
 * STAGE 0 (Keyhole §8) proved the new tree is wired and the new Three boots —
 * a colored triangle. STAGE 1 ("the law, running") is now underway: the
 * allocator's world-res law, the page-cache/table/residency core, and the
 * physical GPU atlas are built and Node/mock-verified (src/graph/, src/vt/) —
 * but nothing is wired into a real render pass yet, so the boot heartbeat
 * below is still the only thing on screen. Real map rendering returns once
 * Stage 1's geometry pass lands. That is the plan working, not breaking.
 *
 * This file also hosts the temporary Keyhole DEBUG PANEL (src/diag/debug-panel.js)
 * in the same corner box as the heartbeat — a growing set of one-click reports
 * for the author to copy/paste back during development. Every future stage can
 * register its own report via `MapShine.debug.registerReport(...)`.
 */

import * as THREE from './vendor/three/three.module.js';
import { installSoak } from './diag/soak.js';
import { installDebugPanel } from './diag/debug-panel.js';
import { runVtSelfTest } from './vt/vt-selftest-report.js';
import { runVtLiveDecodeTest } from './vt/vt-live-decode-report.js';
import { runVtSmokeTest, stopVtSmokeTest } from './vt/vt-smoke-test.js';
import { startVtPanViewer, stopVtPanViewer, getVtPanViewerDiagnostics, soakPanStep, soakSwitchFloorStep } from './vt/vt-pan-viewer.js';

const MODULE_ID = 'map-shine-advanced';
const VERSION = '0.6.0-dev.0';
const CODENAME = 'Keyhole';
const STAGE = 'Stage 1 · the law, running';

const TAG = `[MSA ${VERSION} ${CODENAME}]`;

// ---------------------------------------------------------------------------
// Namespace. Legacy is disconnected, so there is no live `window.MapShine` to
// collide with — but we still create-if-absent and stamp our own fields so the
// V3 tree owns this namespace cleanly.
// ---------------------------------------------------------------------------
const MapShine = (globalThis.MapShine = globalThis.MapShine || {});
MapShine.version = VERSION;
MapShine.codename = CODENAME;
MapShine.__stage = STAGE;
MapShine.THREE = THREE; // single Three instance for the whole V3 tree

/** Guard against double-boot (Foundry hot-reload, duplicate module load). */
if (MapShine.__keyholeBooted) {
  console.warn(`${TAG} already booted; skipping re-entry.`);
} else {
  MapShine.__keyholeBooted = true;
  install();
}

function install() {
  installSoak(MapShine); // exposes MapShine.soak(n) — the stage-gate soak harness
  installDebugPanel(MapShine); // starts console capture NOW, as early as possible
  MapShine.debug.registerReport('vt-selftest', 'VT Self-Test', () => ({
    report: 'vt-selftest',
    generatedAt: new Date().toISOString(),
    ...runVtSelfTest(),
  }));
  MapShine.debug.registerReport('vt-live-decode', 'VT Live Decode Test', async () => ({
    report: 'vt-live-decode',
    generatedAt: new Date().toISOString(),
    ...(await runVtLiveDecodeTest(`modules/${MODULE_ID}/assets/torture/torture_floor0.png`)),
  }));
  MapShine.debug.registerReport('vt-smoke-test', 'VT Smoke Test: Render (bottom-left canvas)', async () => ({
    report: 'vt-smoke-test',
    generatedAt: new Date().toISOString(),
    ...(await runVtSmokeTest({ THREE, imageUrl: `modules/${MODULE_ID}/assets/torture/torture_floor0.png` })),
  }));
  MapShine.debug.registerReport('vt-smoke-test-stop', 'VT Smoke Test: Stop/Clear', () => ({
    report: 'vt-smoke-test-stop',
    generatedAt: new Date().toISOString(),
    ...stopVtSmokeTest(),
  }));

  const TORTURE_FLOOR_COUNT = 3;
  const tortureImageUrl = (floorIndex) => `modules/${MODULE_ID}/assets/torture/torture_floor${floorIndex}.png`;

  MapShine.debug.registerReport('vt-pan-viewer-start', 'VT Pan Viewer: Start (bottom-left canvas)', async () => ({
    report: 'vt-pan-viewer-start',
    generatedAt: new Date().toISOString(),
    ...(await startVtPanViewer({ THREE, imageUrlForFloor: tortureImageUrl, floorCount: TORTURE_FLOOR_COUNT })),
  }));
  MapShine.debug.registerReport('vt-pan-viewer-diagnostics', 'VT Pan Viewer: Diagnostics', () => ({
    report: 'vt-pan-viewer-diagnostics',
    generatedAt: new Date().toISOString(),
    ...getVtPanViewerDiagnostics(),
  }));
  MapShine.debug.registerReport('vt-pan-viewer-stop', 'VT Pan Viewer: Stop/Clear', () => ({
    report: 'vt-pan-viewer-stop',
    generatedAt: new Date().toISOString(),
    ...stopVtPanViewer(),
  }));

  // MapShine.soak(n) now drives something real (Stage 1 part 4b) instead of
  // reporting stub drivers — load ensures the pan viewer is running, pan/
  // switchFloor go through the EXACT same applyKeyAndUpdate() path a real
  // keypress uses.
  MapShine.soakHooks.load = async () => {
    if (!getVtPanViewerDiagnostics().active) {
      await startVtPanViewer({ THREE, imageUrlForFloor: tortureImageUrl, floorCount: TORTURE_FLOOR_COUNT });
    }
  };
  MapShine.soakHooks.pan = (i) => soakPanStep(i);
  MapShine.soakHooks.switchFloor = (i) => soakSwitchFloorStep(i);

  console.log(
    `%c${TAG}%c ${STAGE} — new tree live, legacy quarantined. Three r${THREE.REVISION} / WebGL2.` +
      ` Soak harness ready: MapShine.soak(n).`,
    'color:#8fd6ff;font-weight:bold',
    'color:inherit'
  );

  // Foundry defines its globals before loading module esmodules, so `Hooks` is
  // available here. If we are somehow loaded outside Foundry, fall back to the
  // window load event so the boot proof still renders.
  if (typeof Hooks !== 'undefined') {
    Hooks.once('init', () => console.log(`${TAG} init — ${MODULE_ID}`));
    Hooks.once('ready', () => bootHeartbeat());
  } else {
    console.warn(`${TAG} no Foundry Hooks found; booting on window load.`);
    if (document.readyState === 'complete') bootHeartbeat();
    else window.addEventListener('load', () => bootHeartbeat(), { once: true });
  }
}

/**
 * Stage 0 proof-of-life: a dedicated MSA overlay canvas rendering a slowly
 * spinning, vertex-colored triangle through the new Three. It sits bottom-right,
 * click-through (`pointer-events:none`), so Foundry's UI stays fully usable while
 * the author imports the torture fixture and runs the soak harness.
 *
 * Deliberately its OWN canvas, not Foundry's — entangling with Foundry's canvas is
 * the adapter's job (src/foundry/), which lands in Stage 2+. Stage 0 only proves
 * the renderer boots.
 */
function bootHeartbeat() {
  if (MapShine.__heartbeat) return; // idempotent
  try {
    const host = document.createElement('div');
    host.id = 'msa-keyhole-boot';
    Object.assign(host.style, {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      width: '320px',
      zIndex: '90', // above Foundry board, below its notifications
      pointerEvents: 'none',
      fontFamily: 'Signika, sans-serif',
      color: '#cfe8ff',
      textShadow: '0 1px 2px #000',
      userSelect: 'none',
    });

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      display: 'block',
      width: '320px',
      height: '200px',
      borderRadius: '8px',
      border: '1px solid rgba(143,214,255,0.35)',
      boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
      background: 'rgba(6,10,18,0.72)',
    });

    const caption = document.createElement('div');
    Object.assign(caption.style, {
      marginTop: '6px',
      fontSize: '11px',
      lineHeight: '1.35',
      textAlign: 'center',
      letterSpacing: '0.02em',
    });
    caption.innerHTML =
      `<strong>Map Shine Advanced ${VERSION}</strong> &middot; ${CODENAME}<br>` +
      `${STAGE} &mdash; new Three r${THREE.REVISION} / WebGL2`;

    host.appendChild(canvas);
    host.appendChild(caption);
    document.body.appendChild(host);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.setSize(320, 200, false);
    renderer.setClearColor(0x000000, 0); // transparent → CSS background shows

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 320 / 200, 0.1, 100);
    camera.position.set(0, 0, 3.2);

    // A single triangle with red/green/blue vertex colors — the canonical
    // "hello, GPU" that exercises buffers, a shader, transforms and rasterization.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 1.1, 0, -1.05, -0.85, 0, 1.05, -0.85, 0], 3)
    );
    geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute([1, 0.25, 0.25, 0.25, 1, 0.4, 0.35, 0.55, 1], 3)
    );
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const triangle = new THREE.Mesh(geometry, material);
    scene.add(triangle);

    renderer.setAnimationLoop((t) => {
      triangle.rotation.y = t * 0.0009; // gentle spin — proves the loop is alive
      renderer.render(scene, camera);
    });

    MapShine.__heartbeat = { host, renderer, scene, camera, triangle };
    MapShine.__soakWatch?.(canvas); // count any WebGL context loss on the boot canvas
    MapShine.debug?.attachPanel(host); // the debug panel lives in the same corner box
    console.log(`${TAG} boot heartbeat rendering. Gate "boot renders" ✔`);
  } catch (err) {
    // Doctrine #1: fail LOUD, never silently. No V2 fallback exists to hide behind.
    console.error(`${TAG} boot heartbeat FAILED — the new renderer did not come up:`, err);
    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      padding: '10px 14px',
      zIndex: '90',
      pointerEvents: 'none',
      background: 'rgba(60,0,0,0.85)',
      color: '#ffd9d9',
      font: '12px/1.4 Signika, sans-serif',
      borderRadius: '8px',
      border: '1px solid rgba(255,120,120,0.5)',
    });
    banner.textContent = `${TAG} renderer failed to boot — see console.`;
    document.body.appendChild(banner);
  }
}
