/**
 * TEMPERATURE LAB — Temperature Effects on the real present material
 * (2026-10-27, built for the Temperature Effects card).
 *
 * A painted test map (grass, flagstones, a roofed building, a gazebo) is drawn
 * into a linear target and shown through the REAL `buildGradePresentMaterial`,
 * driven each frame by the REAL `createTemperatureFxStepper` — the same two
 * pieces the game runs, so what is on screen here is what the game draws. The
 * building and gazebo are INDOORS in the lab's outdoors mask, so the heat
 * ripple should stay out of them while the grade's indoor share softens the
 * cold / warm look inside.
 *
 * Driving it: `window.tempLab` — `setTemperature(t)`, `growFrost()` (skip the
 * wait), `advance(seconds)`, `setParams({...})`, `capture(name)` (PNG under
 * `tools/shader-lab/runs/temperature-lab/`), `compiled()`.
 *
 * @module tools/shader-lab/temperature-lab
 */

import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { buildGradePresentMaterial } from '../../src/effects/grade/grade-present.js';
import { TEMPERATURE_EFFECTS_PARAMS } from '../../src/effects/temperature/temperature.js';
import { applyTemperatureGrade, createTemperatureFxStepper } from '../../src/effects/temperature/temperature-model.js';
import { buildTemperatureNoiseData } from '../../src/effects/temperature/temperature-noise.js';

const TSL = THREE.TSL;
const { texture, uniform } = TSL;

const W = 1280;
const H = 720;
const MASK_TEXEL = 16;
const MASK_W = W / MASK_TEXEL;
const MASK_H = H / MASK_TEXEL;

const statusEl = document.getElementById('status');
const say = (msg) => {
  console.log('[temperature-lab]', msg);
  statusEl.textContent = msg;
};

const HOUSE = [
  { x0: 360, y0: 110, x1: 840, y1: 330 },
  { x0: 360, y0: 330, x1: 540, y1: 520 },
];
const GAZEBO = { cx: 1040, cy: 470, r: 95 };
const insideRoof = (x, y) =>
  HOUSE.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) ||
  (x - GAZEBO.cx) ** 2 + (y - GAZEBO.cy) ** 2 < GAZEBO.r ** 2;

let rs = 12345;
const rnd = () => (rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296;

function paintMap() {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#5d8c3c';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `hsla(${88 + rnd() * 18}, 42%, ${30 + rnd() * 22}%, 0.35)`;
    g.beginPath();
    g.ellipse(rnd() * W, rnd() * H, 6 + rnd() * 26, 4 + rnd() * 14, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
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
  for (const [x, y, r] of [
    [180, 210, 70],
    [240, 560, 55],
    [990, 170, 80],
    [700, 600, 60],
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
  // Roofs, drawn flat into the same picture (the lab has no tile layer).
  const roof = (path) => {
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
    }
    g.restore();
    g.lineWidth = 6;
    g.strokeStyle = '#140c08';
    path();
    g.stroke();
  };
  roof(() => {
    g.beginPath();
    g.moveTo(360, 110);
    g.lineTo(840, 110);
    g.lineTo(840, 330);
    g.lineTo(540, 330);
    g.lineTo(540, 520);
    g.lineTo(360, 520);
    g.closePath();
  });
  roof(() => {
    g.beginPath();
    g.arc(GAZEBO.cx, GAZEBO.cy, GAZEBO.r, 0, Math.PI * 2);
  });
  return cv;
}

/** `_Outdoors` for the lab map — 1 outside, 0 under a roof; row 0 = minY. */
function makeOutdoorsMask() {
  const data = new Uint8Array(MASK_W * MASK_H * 4);
  for (let gy = 0; gy < MASK_H; gy++) {
    for (let gx = 0; gx < MASK_W; gx++) {
      const v = insideRoof((gx + 0.5) * MASK_TEXEL, (gy + 0.5) * MASK_TEXEL) ? 0 : 255;
      data.set([v, v, v, 255], (gy * MASK_W + gx) * 4);
    }
  }
  const t = new THREE.DataTexture(data, MASK_W, MASK_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

async function main() {
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(W, H, false);

  const mapTex = new THREE.CanvasTexture(paintMap());
  mapTex.colorSpace = THREE.SRGBColorSpace;
  mapTex.flipY = false;
  const world = new THREE.Scene();
  const mapMat = new THREE.NodeMaterial();
  const uDim = uniform(1);
  mapMat.colorNode = texture(mapTex).rgb.mul(uDim);
  mapMat.depthTest = false;
  mapMat.depthWrite = false;
  mapMat.side = THREE.DoubleSide;
  const mapMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mapMat);
  mapMesh.position.set(W / 2, H / 2, 0);
  world.add(mapMesh);
  const camera = new THREE.OrthographicCamera(0, W, 0, H, -10, 10);

  const lit = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
  const ldr = new THREE.RenderTarget(W, H, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
  });

  const uViewRect = uniform(new THREE.Vector4(0, 0, W, H));
  const uOutdoorsRect = uniform(new THREE.Vector4(0, 0, W, H));
  const outdoorsTexNode = texture(makeOutdoorsMask());
  const noiseTex = (() => {
    const { data, size } = buildTemperatureNoiseData();
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  })();
  const gradePresent = buildGradePresentMaterial({
    THREE,
    litTexture: lit.texture,
    outdoorsTexNode,
    uViewRect,
    uOutdoorsRect,
    temperatureNoiseTexture: noiseTex,
  });
  const presentQuad = new THREE.QuadMesh(gradePresent.material);

  const q = new URLSearchParams(location.search);
  const params = {};
  for (const [k, p] of Object.entries(TEMPERATURE_EFFECTS_PARAMS)) params[k] = p.default;
  const state = {
    temperature01: Number(q.get('temp') ?? 0.55),
    darkness01: Number(q.get('dark') ?? 0),
    zoom: Number(q.get('zoom') ?? 1),
    enabled: true,
    paused: false,
  };
  const stepper = createTemperatureFxStepper();
  let lastInfo = null;

  const setView = () => {
    const hw = W / 2 / state.zoom;
    const hh = H / 2 / state.zoom;
    const cx = W / 2;
    const cy = H / 2;
    Object.assign(camera, { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh });
    camera.updateProjectionMatrix();
    uViewRect.value.set(cx - hw, cy - hh, cx + hw, cy + hh);
  };
  setView();

  function tick(dt) {
    const frame = stepper.step({
      enabled: state.enabled,
      params,
      temperature01: state.temperature01,
      realDtSec: dt,
      worldDtSec: dt,
      darkness01: state.darkness01,
      screenW: W,
      screenH: H,
      worldPerScreenPx: 1 / state.zoom,
    });
    // The viewer's own two grade pushes: the outdoor-gated env grade carries
    // the share that does not reach indoors, the artistic grade the rest.
    gradePresent.setArtGrade(applyTemperatureGrade({}, frame.grade, frame.indoorShare), {
      toneMapping: 'none',
      lutStrength: 0,
    });
    gradePresent.setEnvGrade(applyTemperatureGrade({}, frame.grade, 1 - frame.indoorShare));
    gradePresent.setTemperatureEffects(frame.warp);
    lastInfo = { ...frame.info, compiled: gradePresent.temperatureCompiled() };
    // A dim scene darkens the picture itself, like the game's ambient.
    uDim.value = 1 - 0.75 * state.darkness01;
    renderer.setRenderTarget(lit);
    renderer.render(world, camera);
    renderer.setRenderTarget(null);
    presentQuad.render(renderer);
  }

  /** The present's current picture as 8-bit RGBA (row 0 = top) — for numeric checks. */
  async function pixels() {
    renderer.setRenderTarget(ldr);
    presentQuad.render(renderer);
    renderer.setRenderTarget(null);
    const buf = await renderer.readRenderTargetPixelsAsync(ldr, 0, 0, W, H);
    const src = buf instanceof Uint8Array || buf instanceof Uint8ClampedArray ? buf : Uint8ClampedArray.from(buf);
    if (src.length === W * H * 4) return { w: W, h: H, data: Uint8ClampedArray.from(src) };
    const out = new Uint8ClampedArray(W * H * 4);
    const stride = Math.ceil((W * 4) / 256) * 256;
    for (let y = 0; y < H; y++) out.set(src.subarray(y * stride, y * stride + W * 4), y * W * 4);
    return { w: W, h: H, data: out };
  }

  async function capture(name = 'temperature') {
    // Render the PRESENT (the thing under test) to the LDR target.
    renderer.setRenderTarget(ldr);
    presentQuad.render(renderer);
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
    const r = await fetch(`/__lab/artifact?run=temperature-lab&file=${file}`, { method: 'POST', body: blob });
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
    val.style.color = '#8cf';
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

  const setTemperature = (t) => {
    state.temperature01 = t;
    setSlider('temperature01', t);
  };
  const growFrost = () => {
    stepper.setFrost01(1);
  };

  heading('Scene');
  slider('temperature01', { label: 'Temperature', min: 0, max: 1, step: 0.01, value: state.temperature01 }, (v) => {
    state.temperature01 = v;
  });
  for (const [label, t] of [
    ['0%', 0],
    ['5%', 0.05],
    ['10%', 0.1],
    ['25% (snow tick)', 0.25],
    ['55% mild', 0.55],
    ['75%', 0.75],
    ['90%', 0.9],
    ['100%', 1],
  ]) {
    button(label, () => setTemperature(t));
  }
  button('Skip frost growth', growFrost);
  slider('darkness01', { label: 'Darkness', min: 0, max: 1, step: 0.01, value: state.darkness01 }, (v) => {
    state.darkness01 = v;
  });
  slider('zoom', { label: 'Zoom', min: 0.4, max: 4, step: 0.05, value: state.zoom }, (v) => {
    state.zoom = v;
    setView();
  });
  button('Pause', (e) => {
    state.paused = !state.paused;
    e.target.textContent = state.paused ? 'Play' : 'Pause';
    last = performance.now();
  });

  let lastCategory = '';
  for (const [k, p] of Object.entries(TEMPERATURE_EFFECTS_PARAMS)) {
    if (p.category !== lastCategory) {
      heading(p.category);
      lastCategory = p.category;
    }
    if (p.type === 'float') {
      slider(k, { label: p.label, min: p.min, max: p.max, step: p.step, value: p.default, title: p.help }, (v) => {
        params[k] = v;
      });
    } else if (p.type === 'bool') {
      const wrap = document.createElement('label');
      wrap.title = p.help;
      const name = document.createElement('span');
      name.textContent = p.label;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = p.default;
      input.addEventListener('input', () => {
        params[k] = input.checked;
      });
      wrap.append(name, input);
      panel.appendChild(wrap);
    } else if (p.type === 'color') {
      const wrap = document.createElement('label');
      wrap.title = p.help;
      const name = document.createElement('span');
      name.textContent = p.label;
      const input = document.createElement('input');
      input.type = 'color';
      input.value = p.default;
      input.addEventListener('input', () => {
        params[k] = input.value;
      });
      wrap.append(name, input);
      panel.appendChild(wrap);
    }
  }

  let last = performance.now();
  let lastReport = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!state.paused) tick(dt);
    if (now - lastReport > 400 && lastInfo) {
      lastReport = now;
      const i = lastInfo;
      say(
        `temperature ${i.temperature01.toFixed(2)} · cold ${i.cold01.toFixed(2)} · warm ${i.warm01.toFixed(2)}\n` +
          `frost ${i.frost01.toFixed(3)} → target ${i.frostTarget01.toFixed(2)} · heat ${i.heat01.toFixed(2)} · ripple ${i.ripplePx.toFixed(2)} px\n` +
          `compiled in: frost ${i.compiled.frost} · heat ripple ${i.compiled.heatRipple}`
      );
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  window.tempLab = {
    renderer,
    state,
    params,
    setTemperature,
    growFrost,
    capture,
    setParams: (p) => Object.assign(params, p),
    setFrost: (v) => stepper.setFrost01(v),
    /** Milliseconds per present draw over `n` draws, synced to the GPU — the
     * cost of whatever is currently compiled in. */
    async bench(n = 300) {
      const device = renderer.backend.device;
      for (let k = 0; k < 20; k++) presentQuad.render(renderer);
      await device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      for (let k = 0; k < n; k++) {
        presentQuad.render(renderer);
        if (k % 50 === 49) await device.queue.onSubmittedWorkDone();
      }
      await device.queue.onSubmittedWorkDone();
      return +((performance.now() - t0) / n).toFixed(4);
    },
    pixels,
    compiled: () => gradePresent.temperatureCompiled(),
    info: () => lastInfo,
    /** Step by hand, `seconds` at 60 Hz — for automated runs where the pane
     * is hidden and requestAnimationFrame stalls. */
    async advance(seconds = 1) {
      const n = Math.max(1, Math.round(seconds * 60));
      for (let k = 0; k < n; k++) {
        tick(1 / 60);
        if (k % 20 === 19) await renderer.backend.device.queue.onSubmittedWorkDone();
      }
      return lastInfo;
    },
  };
  say('ready — window.tempLab');
}

main().catch((err) => {
  console.error(err);
  say(`FAILED: ${err?.stack ?? err}`);
});
