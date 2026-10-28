/**
 * DRIP LAB — the roof-drip engine on its own, top-down, over a synthetic
 * courtyard (2026-10-27, built for the drip rebuild).
 *
 * The REAL `createPrecipDripEngine` is fed by the REAL `extractDripEdges`, run
 * on a hand-built `coverAbove` grid (an L-shaped house and a round gazebo, so
 * straight, cornered and curved eaves are all on screen). Roofs draw OVER the
 * drips, as the overhead tiles do in the game; drag "Roof opacity" down to see
 * what they hide.
 *
 * Driving it: `window.dripLab` — `setRate(r)` jumps straight to an emission
 * rate (1 = full runoff, 0.02 = an occasional drip), `stopRain()` lets the
 * tail run (fast-forwarded by "Tail speed"), `capture(name)` saves a PNG under
 * `tools/shader-lab/runs/drip-lab/`.
 *
 * @module tools/shader-lab/drip-lab
 */

import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { createPrecipDripEngine } from '../../src/effects/particles/precip-drip-runtime.js';
import { extractDripEdges } from '../../src/effects/precipitation/drip-edges.js';
import { PRECIPITATION_PARAMS } from '../../src/effects/precipitation/precipitation.js';

const TSL = THREE.TSL;
const { texture, vec4, uniform } = TSL;

const W = 1280;
const H = 720;
const TEXEL = 16;
const GRID_W = W / TEXEL;
const GRID_H = H / TEXEL;

const statusEl = document.getElementById('status');
const say = (msg) => {
  console.log('[drip-lab]', msg);
  statusEl.textContent = msg;
};

/** The courtyard's roofs, world px (y down). */
const HOUSE = [
  { x0: 360, y0: 110, x1: 840, y1: 330 },
  { x0: 360, y0: 330, x1: 540, y1: 520 },
];
const GAZEBO = { cx: 1040, cy: 470, r: 95 };

const insideRoof = (x, y) =>
  HOUSE.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) ||
  (x - GAZEBO.cx) ** 2 + (y - GAZEBO.cy) ** 2 < GAZEBO.r ** 2;

/** `coverAbove` for the courtyard — row 0 = minY, like every MaskGrid. */
function makeCoverGrid() {
  const data = new Uint8Array(GRID_W * GRID_H);
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      if (insideRoof((gx + 0.5) * TEXEL, (gy + 0.5) * TEXEL)) data[gy * GRID_W + gx] = 255;
    }
  }
  return { spec: { x: 0, y: 0, width: W, height: H, w: GRID_W, h: GRID_H, texelW: TEXEL, texelH: TEXEL }, data };
}

/** A seeded random, so the courtyard looks the same every load. */
let rs = 12345;
const rnd = () => (rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296;

/** Grass, a pale flagstone apron round the house, a few bushes — in the
 * thick-outlined painted style of the author's own maps. */
function paintGround() {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#5d8c3c';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const l = 30 + rnd() * 22;
    g.fillStyle = `hsla(${88 + rnd() * 18}, 42%, ${l}%, 0.35)`;
    g.beginPath();
    g.ellipse(x, y, 6 + rnd() * 26, 4 + rnd() * 14, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // The apron: pale stone flags, outlined.
  const apron = (x0, y0, x1, y1) => {
    g.fillStyle = '#cbbd9c';
    g.strokeStyle = '#1b1712';
    g.lineWidth = 4;
    for (let y = y0; y < y1; y += 34) {
      const off = ((y - y0) / 34) % 2 ? 22 : 0;
      for (let x = x0 - off; x < x1; x += 46) {
        const cx = Math.max(x0, x);
        const cw = Math.min(x1, x + 46) - cx;
        if (cw <= 4) continue;
        g.beginPath();
        g.roundRect(cx + 2, y + 2, cw - 4, Math.min(34, y1 - y) - 4, 7);
        g.fill();
        g.stroke();
      }
    }
  };
  apron(300, 70, 900, 380);
  apron(300, 380, 600, 580);
  g.fillStyle = '#cbbd9c';
  g.beginPath();
  g.arc(GAZEBO.cx, GAZEBO.cy, GAZEBO.r + 46, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = '#1b1712';
  g.stroke();
  // Bushes.
  for (const [x, y, r] of [
    [180, 210, 70],
    [240, 560, 55],
    [990, 170, 80],
    [700, 560, 60],
  ]) {
    g.fillStyle = '#3f6e2a';
    g.strokeStyle = '#0f150b';
    g.lineWidth = 5;
    g.beginPath();
    for (let k = 0; k <= 96; k++) {
      const a = (k / 96) * Math.PI * 2;
      const rr = r * (0.86 + 0.1 * Math.abs(Math.sin(a * 6.5)) + 0.04 * Math.sin(a * 3));
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
    g.stroke();
  }
  return cv;
}

/** The roofs — what the drips fall off, drawn over them like overhead tiles. */
function paintRoofs() {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  const tiles = (path) => {
    g.save();
    path();
    g.clip();
    g.fillStyle = '#7b4b3a';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(30,14,10,0.55)';
    g.lineWidth = 2;
    for (let y = 0; y < H; y += 14) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
      for (let x = (y / 14) % 2 ? 0 : 12; x < W; x += 24) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y + 14);
        g.stroke();
      }
    }
    g.restore();
    g.lineWidth = 6;
    g.strokeStyle = '#140c08';
    path();
    g.stroke();
  };
  tiles(() => {
    g.beginPath();
    g.moveTo(360, 110);
    g.lineTo(840, 110);
    g.lineTo(840, 330);
    g.lineTo(540, 330);
    g.lineTo(540, 520);
    g.lineTo(360, 520);
    g.closePath();
  });
  tiles(() => {
    g.beginPath();
    g.arc(GAZEBO.cx, GAZEBO.cy, GAZEBO.r, 0, Math.PI * 2);
  });
  return cv;
}

function canvasTexture(cv) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  // y runs DOWN in the lab's world (camera top = 0), so canvas row 0 must sit
  // at the plane's low-y edge.
  t.flipY = false;
  return t;
}

function plane(tex, order, opacityNode = null) {
  const m = new THREE.NodeMaterial();
  m.colorNode = texture(tex).rgb;
  m.opacityNode = opacityNode ? texture(tex).a.mul(opacityNode) : texture(tex).a;
  m.transparent = true;
  m.depthTest = false;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), m);
  mesh.position.set(W / 2, H / 2, 0);
  mesh.renderOrder = order;
  return mesh;
}

const q = new URLSearchParams(location.search);

async function main() {
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(W, H, false);

  const world = new THREE.Scene();
  world.add(plane(canvasTexture(paintGround()), -10));
  const uRoofOpacity = uniform(Number(q.get('roof') ?? 1));
  world.add(plane(canvasTexture(paintRoofs()), 20, uRoofOpacity));
  const camera = new THREE.OrthographicCamera(0, W, 0, H, -10, 10);
  /** Zoom about a world point — the game's view at a closer zoom. The drip
   * engine's M(h) centre follows the view centre, as the subsystem pushes it. */
  const setView = (cx = W / 2, cy = H / 2, zoom = 1) => {
    const hw = W / 2 / zoom;
    const hh = H / 2 / zoom;
    Object.assign(camera, { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh });
    camera.updateProjectionMatrix();
    engine?.setCamera(cx, cy);
  };
  let engine = null;

  // ── the engine, exactly as the subsystem builds it ─────────────────────────
  engine = createPrecipDripEngine({ THREE });
  // The lab draws into a plain target, not the world pass's MRT.
  for (const m of engine.meshes) {
    m.material.mrtNode = null;
    world.add(m);
  }
  engine.setLayerOrder(5);
  const edges = extractDripEdges(makeCoverGrid());
  engine.setSpawnPoints(edges);
  setView(Number(q.get('cx') ?? W / 2), Number(q.get('cy') ?? H / 2), Number(q.get('zoom') ?? 1));

  const params = {};
  for (const [k, p] of Object.entries(PRECIPITATION_PARAMS)) params[k] = p.default;
  engine.setTuning(params);

  const state = {
    precip01: Number(q.get('rate') ?? 0.5),
    windSpeed01: Number(q.get('wind') ?? 0.35),
    windDirDeg: Number(q.get('bearing') ?? 110),
    gust01: Number(q.get('gust') ?? 0.4),
    tailSpeed: 20,
    paused: false,
  };
  const wind = {
    ambient: {
      speed01: { value: state.windSpeed01 },
      directionDeg: { value: state.windDirDeg },
      gustiness01: { value: state.gust01 },
    },
  };

  const hdr = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
  const ldr = new THREE.RenderTarget(W, H, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
  });
  const presentMaterial = new THREE.NodeMaterial();
  presentMaterial.fragmentNode = vec4(texture(hdr.texture).rgb, 1);
  const presentQuad = new THREE.QuadMesh(presentMaterial);

  let clockMs = 0;
  let tailMode = false;
  function tick(dt) {
    clockMs += dt * 1000;
    wind.ambient.speed01.value = state.windSpeed01;
    wind.ambient.directionDeg.value = state.windDirDeg;
    wind.ambient.gustiness01.value = state.gust01;
    // The tail is minutes long; fast-forward only ITS clock, not the drops'.
    engine.setFrame(tailMode ? dt * state.tailSpeed : dt, state.precip01, { alphaMul: 1, rgbMul: 1 });
    engine.step(renderer, dt, clockMs, wind);
    renderer.setRenderTarget(hdr);
    renderer.render(world, camera);
    renderer.setRenderTarget(null);
    presentQuad.render(renderer);
  }

  let last = performance.now();
  let lastReport = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!state.paused) tick(dt);
    if (now - lastReport > 400) {
      lastReport = now;
      const d = engine.debugState();
      say(
        `points ${d.spawnCount} (normals: ${edges.normals ? 'yes' : 'no'}, spacing ${edges.spacingPx}px) · live ${d.liveCount}/${d.capacity}\n` +
          `rate ${d.tail.rate.toFixed(3)} · tail ${d.tail.tail01.toFixed(3)}${tailMode ? ` (×${state.tailSpeed})` : ''}\n` +
          `cadence: flow ${d.cadence.flow01.toFixed(2)} · hang ${d.cadence.hangSec.toFixed(2)}s · rest ${d.cadence.restSec.toFixed(2)}s`
      );
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  async function capture(name = 'drips') {
    const grab = new THREE.NodeMaterial();
    grab.fragmentNode = vec4(TSL.sRGBTransferOETF(texture(hdr.texture).rgb), 1);
    const quad = new THREE.QuadMesh(grab);
    renderer.setRenderTarget(ldr);
    quad.render(renderer);
    renderer.setRenderTarget(null);
    const buf = await renderer.readRenderTargetPixelsAsync(ldr, 0, 0, W, H);
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W, H);
    const src = buf instanceof Uint8Array || buf instanceof Uint8ClampedArray ? buf : Uint8ClampedArray.from(buf);
    if (src.length === W * H * 4) img.data.set(src);
    else {
      const stride = Math.ceil((W * 4) / 256) * 256;
      for (let y = 0; y < H; y++) img.data.set(src.subarray(y * stride, y * stride + W * 4), y * W * 4);
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    const file = `${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.png`;
    const r = await fetch(`/__lab/artifact?run=drip-lab&file=${file}`, { method: 'POST', body: blob });
    return r.json();
  }

  // ── the panel ──────────────────────────────────────────────────────────────
  const panel = document.getElementById('panel');
  const heading = (t) => {
    const h = document.createElement('h4');
    h.textContent = t;
    panel.appendChild(h);
  };
  const sliders = {};
  const slider = (key, { label, min, max, step, value, title }, onInput) => {
    const wrap = document.createElement('label');
    if (title) wrap.title = title;
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min, max, step, value });
    const val = document.createElement('span');
    val.textContent = String(value);
    val.style.color = '#8f8';
    input.addEventListener('input', () => {
      val.textContent = input.value;
      onInput(Number(input.value));
    });
    wrap.append(name, input, val);
    panel.appendChild(wrap);
    sliders[key] = { input, val };
  };
  const button = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    panel.appendChild(b);
  };
  const setSlider = (key, v) => {
    if (!sliders[key]) return;
    sliders[key].input.value = String(v);
    sliders[key].val.textContent = String(v);
  };

  heading('Weather');
  const setRate = (r) => {
    tailMode = false;
    // Straight to this rate: drop whatever runoff the last setting left.
    engine.setTailLevel(0);
    state.precip01 = r;
    setSlider('precip01', r);
  };
  const stopRain = () => {
    state.precip01 = 0;
    setSlider('precip01', 0);
    tailMode = true;
  };
  button('Runoff 1', () => setRate(1));
  button('0.5', () => setRate(0.5));
  button('0.15', () => setRate(0.15));
  button('0.04', () => setRate(0.04));
  button('0.01', () => setRate(0.01));
  button('Stop rain (tail)', stopRain);
  slider('precip01', { label: 'Rain', min: 0, max: 1, step: 0.005, value: state.precip01 }, (v) => {
    tailMode = false;
    state.precip01 = v;
  });
  slider('tailSpeed', { label: 'Tail speed ×', min: 1, max: 120, step: 1, value: state.tailSpeed }, (v) => {
    state.tailSpeed = v;
  });
  slider('windSpeed01', { label: 'Wind', min: 0, max: 1, step: 0.01, value: state.windSpeed01 }, (v) => {
    state.windSpeed01 = v;
  });
  slider('windDirDeg', { label: 'Wind bearing', min: 0, max: 359, step: 1, value: state.windDirDeg }, (v) => {
    state.windDirDeg = v;
  });
  slider('gust01', { label: 'Gustiness', min: 0, max: 1, step: 0.01, value: state.gust01 }, (v) => {
    state.gust01 = v;
  });
  slider('roof', { label: 'Roof opacity', min: 0, max: 1, step: 0.01, value: uRoofOpacity.value }, (v) => {
    uRoofOpacity.value = v;
  });
  button('Pause', (e) => {
    state.paused = !state.paused;
    e.target.textContent = state.paused ? 'Play' : 'Pause';
    last = performance.now();
  });

  heading('Drip dials (PRECIPITATION_PARAMS)');
  for (const [k, p] of Object.entries(PRECIPITATION_PARAMS)) {
    if (p.type !== 'float' || !(k.startsWith('drip') || k === 'windAirSpeedPxS' || k === 'cameraHeight')) continue;
    slider(k, { label: p.label, min: p.min, max: p.max, step: p.step, value: p.default, title: p.help }, (v) => {
      params[k] = v;
      engine.setTuning(params);
    });
  }

  window.dripLab = {
    engine,
    edges,
    state,
    params,
    setRate,
    stopRain,
    capture,
    setView,
    /** Step the world by hand, `seconds` at 60 Hz — what an automated run uses
     * when the pane is hidden and requestAnimationFrame stalls. */
    async advance(seconds = 1) {
      const n = Math.max(1, Math.round(seconds * 60));
      for (let k = 0; k < n; k++) {
        tick(1 / 60);
        if (k % 20 === 19) await renderer.backend.device.queue.onSubmittedWorkDone();
      }
      return engine.debugState();
    },
    setWind(speed01, bearingDeg, gust01) {
      if (Number.isFinite(speed01)) setSlider('windSpeed01', (state.windSpeed01 = speed01));
      if (Number.isFinite(bearingDeg)) setSlider('windDirDeg', (state.windDirDeg = bearingDeg));
      if (Number.isFinite(gust01)) setSlider('gust01', (state.gust01 = gust01));
    },
    setRoofOpacity(v) {
      uRoofOpacity.value = v;
      setSlider('roof', v);
    },
    setParam(k, v) {
      params[k] = v;
      engine.setTuning(params);
      setSlider(k, v);
    },
  };
  say(`ready — ${edges.count} roofline points`);
}

main().catch((err) => {
  say(`FAILED: ${err?.stack ?? err}`);
  throw err;
});
