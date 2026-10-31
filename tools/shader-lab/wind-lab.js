/**
 * WIND LAB — the shared wind field, its debug overlay and the Wind Trails
 * effect on their own, top-down over an open 100 px / 5 ft grid (2026-10-27,
 * built for the "tie everything to the gusts" pass).
 *
 * Everything drawn is production code: the handle (`world/wind-access.js`)
 * wraps `sampleWind`; the heatmap + arrows are `diag/wind-field-overlay.js`'s
 * own materials; the trails are `createGustEngine` built from
 * `buildWindTrailsSystem`. No bake (no walls), so this is the open-air field —
 * gust fronts, turbulence and real-speed travel, which is what the timing
 * questions are about.
 *
 * Driving it: `window.windLab` — `set({ wind, bearing, gust, heat, arrows,
 * trails })`, `capture(name)` saves a PNG under `tools/shader-lab/runs/wind-lab/`,
 * `exposure(name, seconds)` saves a long exposure of the trails (whole paths),
 * `stepSeconds(s)` advances the clock without waiting for real time.
 *
 * @module tools/shader-lab/wind-lab
 */

import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { createWindHandle, WIND_DEFAULT_GUSTINESS01, describeWindSpeed01 } from '../../src/world/index.js';
import {
  computeWindOverlayGrid,
  buildWindOverlayGeometry,
  buildWindArrowMaterial,
  buildWindHeatmapMaterial,
} from '../../src/diag/wind-field-overlay.js';
import { createGustEngine } from '../../src/effects/particles/particle-engine.js';
import { buildWindTrailsSystem, windTrailsLook } from '../../src/effects/wind-trails.js';
import { buildWindowWeatherGainNode, WINDOW_WEATHER_DEFAULTS } from '../../src/effects/window/window-weather.js';
import { buildCandleFlameGeometry, buildCandleFlameMaterial } from '../../src/effects/candle-flame-render.js';

const TSL = THREE.TSL;
const { texture, uniform, float } = TSL;

const W = 1280;
const H = 720;
const GRID = 100;

const statusEl = document.getElementById('status');
const say = (msg) => {
  statusEl.textContent = msg;
};

/** Painted grass with a 5 ft grid on it — what a map looks like. */
function paintGround() {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#4f7a35';
  g.fillRect(0, 0, W, H);
  let rs = 7;
  const rnd = () => (rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 2200; i++) {
    g.fillStyle = `hsla(${86 + rnd() * 20}, 40%, ${26 + rnd() * 20}%, 0.35)`;
    g.beginPath();
    g.ellipse(rnd() * W, rnd() * H, 6 + rnd() * 24, 4 + rnd() * 12, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(0,0,0,0.28)';
  g.lineWidth = 1;
  for (let x = 0; x <= W; x += GRID) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, H);
    g.stroke();
  }
  for (let y = 0; y <= H; y += GRID) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(W, y + 0.5);
    g.stroke();
  }
  return cv;
}

const q = new URLSearchParams(location.search);

async function main() {
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setSize(W, H, false);

  const camera = new THREE.OrthographicCamera(0, W, 0, H, -10, 10);
  const world = new THREE.Scene();
  const groundTex = new THREE.CanvasTexture(paintGround());
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.flipY = false;
  const gm = new THREE.NodeMaterial();
  gm.colorNode = texture(groundTex).rgb;
  gm.side = THREE.DoubleSide;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, H), gm);
  ground.position.set(W / 2, H / 2, -1);
  world.add(ground);

  const state = {
    wind: Number(q.get('wind') ?? 0.5),
    bearing: Number(q.get('bearing') ?? 100),
    gust: Number(q.get('gust') ?? WIND_DEFAULT_GUSTINESS01),
    heat: q.get('heat') !== '0',
    arrows: q.get('arrows') !== '0',
    trails: q.get('trails') !== '0',
    // WINDOW WEATHER view: a white "window" sheet × the real weather gain.
    win: q.get('win') === '1',
    overcast: Number(q.get('overcast') ?? 0.9),
    rain: Number(q.get('rain') ?? 0),
    // CANDLES: a row of real flames in the same gusty wind (gutter → out → slow regrowth).
    candles: q.get('candles') === '1',
    paused: false,
  };

  const uTimeMs = uniform(float(0));
  const ambient = {
    directionDeg: uniform(float(state.bearing)),
    speed01: uniform(float(state.wind)),
    gustiness01: uniform(float(state.gust)),
    pixelsPerMetre: uniform(float(GRID / (5 * 0.3048))),
  };
  const windHandle = createWindHandle({ ambientWind: ambient });

  // ── the overlay, exactly as the viewer builds it ──
  const { points } = computeWindOverlayGrid({ minX: 0, minY: 0, maxX: W, maxY: H, spacingPx: GRID });
  const cellPoints = points.map((p) => ({ x: p.x + GRID / 2, y: p.y + GRID / 2 }));
  const heat = new THREE.Mesh(
    buildWindOverlayGeometry(THREE, cellPoints, { sizePx: GRID }).geometry,
    buildWindHeatmapMaterial({ THREE, uGlobalTimeMs: uTimeMs, windHandle }).material
  );
  heat.renderOrder = 5;
  const arrows = new THREE.Mesh(
    buildWindOverlayGeometry(THREE, cellPoints, { sizePx: GRID * 0.95 }).geometry,
    buildWindArrowMaterial({ THREE, uGlobalTimeMs: uTimeMs, windHandle }).material
  );
  arrows.renderOrder = 6;
  world.add(heat);
  world.add(arrows);

  // ── the window weather gain, exactly as the viewer builds it ──
  const uOvercast = uniform(float(state.overcast));
  const uRain = uniform(float(state.rain));
  const uCloudOffset = uniform(new THREE.Vector2(0, 0));
  const winMat = new THREE.NodeMaterial();
  const gain = buildWindowWeatherGainNode(TSL, {
    worldXY: TSL.positionWorld.xy,
    timeMs: uTimeMs,
    wind: ambient,
    cloudOffset: uCloudOffset,
    overcast01: uOvercast,
    rain01: uRain,
    pixelsPerMetre: ambient.pixelsPerMetre,
    dials: {
      breakFill: float(WINDOW_WEATHER_DEFAULTS.breakFill),
      breakSizeM: float(WINDOW_WEATHER_DEFAULTS.breakSizeM),
      stormDarken: float(WINDOW_WEATHER_DEFAULTS.stormDarken),
    },
  });
  winMat.colorNode = TSL.vec3(1, 0.96, 0.85).mul(gain);
  winMat.side = THREE.DoubleSide;
  const winSheet = new THREE.Mesh(new THREE.PlaneGeometry(W, H), winMat);
  winSheet.position.set(W / 2, H / 2, 0);
  winSheet.renderOrder = 4;
  world.add(winSheet);

  // ── a row of candles, exactly as the viewer builds them ──
  const candleAnchors = [];
  for (let k = 0; k < 10; k++) {
    candleAnchors.push({
      id: `lab:c${k}`,
      x: 100 + k * 120,
      y: 360,
      windExposure: 1,
      params: { intensity: 1, useCustomSize: true, customSizePx: 60 },
    });
  }
  const candleBuilt = buildCandleFlameMaterial({ THREE, uGlobalTimeMs: uTimeMs, quality: 2, windHandle });
  candleBuilt.uWindResponse.value = 1;
  const candles = new THREE.Mesh(
    buildCandleFlameGeometry(THREE, candleAnchors, { sizePx: 60, colorHex: '#ff9a3c' }).geometry,
    candleBuilt.material
  );
  candles.frustumCulled = false;
  candles.renderOrder = 8;
  world.add(candles);

  // ── the trails, exactly as the viewer builds them ──
  const trails = createGustEngine({
    THREE,
    system: buildWindTrailsSystem({}),
    worldRect: { minX: 0, minY: 0, maxX: W, maxY: H },
    windHandle,
  });
  trails.scene.children[0].renderOrder = 7;

  let clockMs = 0;
  // `draw` false = advance the sim only (the long exposure draws for itself).
  function tick(dt, draw = true) {
    clockMs += dt * 1000;
    uTimeMs.value = clockMs;
    ambient.speed01.value = state.wind;
    ambient.directionDeg.value = state.bearing;
    ambient.gustiness01.value = state.gust;
    heat.visible = state.heat;
    winSheet.visible = state.win;
    candles.visible = state.candles;
    uOvercast.value = state.overcast;
    uRain.value = state.rain;
    // The cloud deck drifts downwind at half the wind (the viewer's own drift
    // has its own speed model; this only needs to move).
    {
      const rad = (state.bearing * Math.PI) / 180;
      const pxs = state.wind * 70 * ambient.pixelsPerMetre.value * 0.5;
      uCloudOffset.value.x += Math.sin(rad) * pxs * dt;
      uCloudOffset.value.y += -Math.cos(rad) * pxs * dt;
    }
    arrows.visible = state.arrows;
    if (state.trails)
      trails.step(renderer, { dtSec: dt, tMs: clockMs, worldRect: { minX: 0, minY: 0, maxX: W, maxY: H } });
    if (!draw) return;
    renderer.autoClear = true;
    renderer.render(world, camera);
    if (state.trails) {
      renderer.autoClear = false;
      renderer.render(trails.scene, camera);
      renderer.autoClear = true;
    }
  }

  let last = performance.now();
  let lastReport = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!state.paused) tick(dt);
    if (now - lastReport > 400) {
      lastReport = now;
      const d = describeWindSpeed01(state.wind);
      const pxs = d.metresPerSecond * ambient.pixelsPerMetre.value;
      say(
        `wind ${Math.round(state.wind * 100)}% = ${d.metresPerSecond.toFixed(1)} m/s (${d.name}) · ` +
          `${(pxs / GRID).toFixed(1)} squares/s · trails active ${trails.debugState().activeTrails}`
      );
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  async function capture(name = 'wind') {
    const rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    renderer.setRenderTarget(rt);
    renderer.autoClear = true;
    renderer.render(world, camera);
    if (state.trails) {
      renderer.autoClear = false;
      renderer.render(trails.scene, camera);
      renderer.autoClear = true;
    }
    renderer.setRenderTarget(null);
    return saveTarget(rt, name);
  }

  /**
   * LONG EXPOSURE: the map once, then the trails drawn every `everyN` frames for
   * `seconds` without clearing — each trail's whole path (run in, loop, run out)
   * piles up as one stroke. A single frame only shows the last `lengthSec`.
   */
  async function exposure(name = 'exposure', seconds = 2, everyN = 2) {
    const rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    renderer.setRenderTarget(rt);
    renderer.autoClear = true;
    renderer.render(world, camera);
    renderer.autoClear = false;
    const n = Math.round(seconds * 60);
    for (let k = 0; k < n; k++) {
      tick(1 / 60, false);
      renderer.setRenderTarget(rt);
      if (k % everyN === 0) renderer.render(trails.scene, camera);
      if (k % 20 === 19) await renderer.backend.device.queue.onSubmittedWorkDone();
    }
    renderer.autoClear = true;
    renderer.setRenderTarget(null);
    return saveTarget(rt, name);
  }

  async function saveTarget(rt, name) {
    const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
    rt.dispose();
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
    // The target holds LINEAR values; encode to sRGB like the canvas does.
    const lut = new Uint8ClampedArray(256);
    for (let k = 0; k < 256; k++) {
      const c = k / 255;
      lut[k] = Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
    }
    for (let k = 0; k < img.data.length; k += 4) {
      img.data[k] = lut[img.data[k]];
      img.data[k + 1] = lut[img.data[k + 1]];
      img.data[k + 2] = lut[img.data[k + 2]];
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    const file = `${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.png`;
    const r = await fetch(`/__lab/artifact?run=wind-lab&file=${file}`, { method: 'POST', body: blob });
    return r.json();
  }

  // ── the panel ──
  const panel = document.getElementById('panel');
  const slider = (key, label, min, max, step) => {
    const wrap = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min, max, step, value: state[key] });
    const out = document.createElement('span');
    out.textContent = state[key];
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      out.textContent = input.value;
    });
    wrap.append(name, input, out);
    panel.appendChild(wrap);
  };
  const toggle = (key, label) => {
    const wrap = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'checkbox', checked: state[key] });
    input.addEventListener('change', () => (state[key] = input.checked));
    wrap.append(name, input, document.createElement('span'));
    panel.appendChild(wrap);
  };
  const h = document.createElement('h4');
  h.textContent = 'Wind';
  panel.appendChild(h);
  slider('wind', 'Wind (dial)', 0, 1, 0.01);
  slider('bearing', 'Toward (°)', 0, 359, 1);
  slider('gust', 'Gustiness', 0, 1, 0.01);
  toggle('heat', 'Heatmap');
  toggle('arrows', 'Arrows');
  toggle('trails', 'Wind trails');
  toggle('win', 'Window weather');
  toggle('candles', 'Candles');
  slider('overcast', 'Overcast', 0, 1, 0.01);
  slider('rain', 'Rain', 0, 1, 0.01);
  toggle('paused', 'Paused');

  window.windLab = {
    state,
    set(patch = {}) {
      Object.assign(state, patch);
    },
    setTrailLook(params) {
      trails.setLook(windTrailsLook(params));
    },
    /** Advance the sim by `s` seconds at 60 Hz without waiting for real time. */
    async stepSeconds(s = 1) {
      const n = Math.round(s * 60);
      for (let k = 0; k < n; k++) {
        tick(1 / 60);
        if (k % 20 === 19) await renderer.backend.device.queue.onSubmittedWorkDone();
      }
    },
    capture,
    exposure,
  };
  say('ready');
}

main().catch((err) => {
  console.error(err);
  say(`FAILED: ${err?.stack ?? err}`);
});
