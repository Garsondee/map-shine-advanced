/**
 * SHADER LAB — THE CRITTER LAB (flies, maggots, fireflies).
 *
 * Imports the REAL production subsystems from `src/` and runs them on a real WebGPU
 * device against a synthetic scene: a ground plane, a sky you steer with sliders, and a
 * zone you PAINT with the mouse. Nothing here is a transcription — `createCritterSubsystem`,
 * `createCritterEngine`, the brains, the bodies and the zone field are the modules Foundry
 * runs; the lab supplies only what Foundry would (a mask grid, an env snapshot, the scene's
 * illumination).
 *
 *   • Paint with the left mouse button, erase with shift. The Paint selector picks which of the three
 *     zones you are painting (flies', maggots' or fireflies' — three effects, three masks).
 *   • Slide the sun below the horizon to hatch the fireflies; raise the rain, snow, wind or cold to see
 *     each population respond in its own way (the same sliders the game's weather drives).
 *   • `window.critterLab` is the scripted door (describe / setParam / setSky / paint /
 *     advance / capture / status / samplerParity), for an agent or the console.
 *   • `samplerParity()` is the one check a Node test cannot make: it runs the GPU zone sampler (the
 *     kernels' only window on the world) over a few hundred points and compares each answer with its CPU
 *     twin, `sampleZoneField`. They are two transcriptions of one formula, and any disagreement is a bug.
 *
 * ⚠️ WHAT THIS DOES NOT PROVE. There is no bloom here, so the fireflies' HDR glow looks
 * tighter and less hazy than it will in the game; the scene's lighting is one flat
 * multiplier, not the real illumination buffer; and the zone comes from a brush, not the
 * mask authority. It answers "what do the agents and bodies do, and do they look right",
 * on whatever GPU opened this page. Lab-green is BUILT (unverified); only the author, on a
 * real scene, says LIVE.
 *
 * @module tools/shader-lab/critter-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { createCritterSubsystem, moteSkyFromEnv } from '../../src/effects/critters/critter-subsystem.js';
import {
  createCritterEngine,
  allocateCritterBuffers,
  allocateWindCells,
} from '../../src/effects/particles/critter-runtime.js';
import { createWindHandle } from '../../src/world/index.js';
import { createCritterZoneBuffer } from '../../src/effects/particles/critter-zone-buffer.js';
import { SMELLY_FLIES_PARAMS } from '../../src/effects/critters/smelly-flies.js';
import { MAGGOTS_PARAMS } from '../../src/effects/critters/maggots.js';
import { FIREFLIES_PARAMS } from '../../src/effects/critters/fireflies.js';
import { DUST_PARAMS } from '../../src/effects/critters/dust.js';
import { buildZoneField, sampleZoneField } from '../../src/effects/critters/critter-zone.js';
import { buildZoneSampler } from '../../src/effects/critters/critter-zone-sample.js';
import { createUniformBank } from '../../src/effects/critters/critter-uniforms.js';
import { ZONE_MAX_CELLS, critterMarginPx } from '../../src/effects/critters/critter-species.js';

const TSL = THREE.TSL;
const { texture, vec2, vec3, vec4, float, positionWorld, sRGBTransferEOTF, floor, mod, mix, uniform } = TSL;

const W = 1280;
const H = 720;
/** Grid cells of the painted zones: 4 world px each (a 320×180 grid over the 1280×720 world). */
const GRID_W = 320;
const GRID_H = 180;
const TEXEL = W / GRID_W;

const statusEl = document.getElementById('status');
const say = (msg) => {
  if (statusEl) statusEl.textContent = msg;
};

/** The defaults of a schema, as the plain object the render-state seam serves. */
const defaultsOf = (schema) => Object.fromEntries(Object.entries(schema).map(([id, def]) => [id, def.default]));

/** A blank MaskGrid over the lab's world. */
function makeGrid() {
  return {
    spec: { x: 0, y: 0, width: W, height: H, w: GRID_W, h: GRID_H, texelW: TEXEL, texelH: TEXEL },
    data: new Uint8Array(GRID_W * GRID_H),
  };
}

const q = new URLSearchParams(location.search);
/**
 * `?present=0` renders everything into the lab's own targets and never touches the on-screen canvas —
 * what an automated run wants: a software WebGPU adapter in a headless browser has no surface to
 * present to, and drawing to the swap chain there takes the whole device down. A person opening the
 * page in a real browser gets the default (present on).
 */
const PRESENT = q.get('present') !== '0';
let seedState = Number(q.get('seed') ?? 0) >>> 0;
/** A seeded `random` when `?seed=N` is given (deterministic runs); otherwise the game's own `Math.random`. */
const random = seedState
  ? () => (seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0) / 4294967296
  : Math.random;

async function main() {
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(W, H, false);

  // ── the lab's world ────────────────────────────────────────────────────────
  const state = {
    tier: Number(q.get('tier') ?? 2),
    ground: q.get('ground') ?? 'day',
    ambient: 1,
    paintLayer: 'flies',
    brush: 46,
    sky: {
      elevationDeg: 50,
      rising: false,
      precip01: 0,
      precipKind: 'rain',
      wind01: 0,
      gust01: 0,
      windDirectionDeg: 90,
      temperature01: 0.55,
      cloud01: 0,
    },
    maskVersion: { flies: 1, maggots: 1, fireflies: 1, dust: 1 },
    grids: { flies: makeGrid(), maggots: makeGrid(), fireflies: makeGrid(), dust: makeGrid() },
    params: {
      smellyFlies: { ...defaultsOf(SMELLY_FLIES_PARAMS) },
      maggots: { ...defaultsOf(MAGGOTS_PARAMS) },
      fireflies: { ...defaultsOf(FIREFLIES_PARAMS) },
      dust: { ...defaultsOf(DUST_PARAMS) },
    },
    // The window-lit floor the dust is lit by (`?window=1`, or `setWindowLight`): the lab's stand-in for the
    // `_Window` effect's contribution to `scene.illum`.
    window: { enabled: q.get('window') === '1', strength: 1, cloud: 0, indoor: 0.22 },
  };

  /** What `world/environment.js` would hand the subsystems this frame. */
  const makeEnv = () => ({
    sun: {
      elevationDeg: state.sky.elevationDeg,
      azimuthDeg: 200,
      rising: state.sky.rising,
      // the real curve (world/sun.js): eased across civil twilight to clear sun
      dayFactor01: smooth01((state.sky.elevationDeg + 6) / 16),
      golden01: smooth01((20 - state.sky.elevationDeg) / 14) * smooth01((state.sky.elevationDeg + 4) / 6),
    },
    weather: {
      precip01: state.sky.precip01,
      precipKind: state.sky.precipKind,
      cloudCover01: state.sky.cloud01,
      temperature01: state.sky.temperature01,
    },
    wind: { speed01: state.sky.wind01, gustiness01: state.sky.gust01, directionDeg: state.sky.windDirectionDeg },
  });

  // ── the scene's lighting: one flat multiplier standing in for the illumination buffer ──
  const illumData = new Float32Array([1, 1, 1, 1]);
  const illumTex = new THREE.DataTexture(illumData, 1, 1, THREE.RGBAFormat, THREE.FloatType);
  illumTex.needsUpdate = true;
  const colorationTex = new THREE.DataTexture(new Float32Array([0, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  colorationTex.needsUpdate = true;
  const illumTexNode = texture(illumTex);
  const colorationTexNode = texture(colorationTex);

  // ── THE WINDOW-LIT FLOOR: what `scene.illum` holds in a room with a window ──
  // `illum = indoor + fill · (target − indoor)`, exactly the window effect's own blend (signed, so a dim
  // sky darkens the room). `fill` comes from panes cast onto the floor along the SAME sun slant the dust
  // uses (`moteSkyFromEnv`), so a mote's `P + sunShift · height` lookup finds the patch its ray crosses.
  const LIGHT_W = 640;
  const LIGHT_H = 360;
  const lightData = new Float32Array(LIGHT_W * LIGHT_H * 4);
  const lightTex = new THREE.DataTexture(lightData, LIGHT_W, LIGHT_H, THREE.RGBAFormat, THREE.FloatType);
  lightTex.minFilter = lightTex.magFilter = THREE.NearestFilter;
  lightTex.needsUpdate = true;
  const windowLightNode = texture(lightTex);
  const uWindowFloor = uniform(0);
  /** The light outside, by sun elevation: white at noon, gold in the golden hour, blue at dusk, cold moon after. */
  function outdoorRgb() {
    const e = state.sky.elevationDeg;
    const golden = smooth01((20 - e) / 14) * smooth01((e + 4) / 6);
    const dusk = smooth01((4 - e) / 10);
    const day = [1, 0.98, 0.94];
    const gold = [1, 0.6, 0.28];
    const blue = [0.2, 0.27, 0.5];
    const moon = [0.1, 0.14, 0.26];
    const night = smooth01((-6 - e) / 10);
    const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    let c = lerp3(day, gold, golden * (1 - dusk));
    c = lerp3(c, blue, dusk * (1 - night));
    c = lerp3(c, moon, night);
    const k = (1 - 0.8 * night) * (1 - 0.35 * dusk);
    return c.map((v) => v * k);
  }
  /** What the window lets in: the clear-sky light, shaded by the cloud overhead (the window's own term). */
  function windowTargetRgb() {
    const k = (1 - 0.75 * state.sky.cloud01) * state.window.strength;
    return outdoorRgb().map((v) => v * k);
  }
  /** The room's own ambient follows the hour, like the real ambient fill the window's `indoor` term reads. */
  function indoorRgb() {
    const e = state.sky.elevationDeg;
    const v = state.window.indoor * (1 - 0.9 * smooth01((-2 - e) / 12)) * (1 - 0.4 * smooth01((6 - e) / 10));
    return [v, v, v * 1.04];
  }
  const WINDOWS = [
    [260, 360],
    [430, 530],
    [600, 700],
  ];
  let lightKey = '';
  function rebuildWindowLight() {
    const env = makeEnv();
    const { sunShift } = moteSkyFromEnv(env);
    const sy = Math.abs(sunShift[1]) < 0.05 ? (sunShift[1] < 0 ? -0.05 : 0.05) : sunShift[1];
    const key = [
      sunShift[0].toFixed(3),
      sy.toFixed(3),
      windowTargetRgb()
        .map((v) => v.toFixed(3))
        .join(),
      state.window.enabled,
    ].join('|');
    if (key === lightKey) return;
    lightKey = key;
    const wallY = sy > 0 ? 150 : 620;
    const H0 = 50;
    const H1 = 210;
    const indoor = indoorRgb();
    const target = windowTargetRgb();
    const edge = (v, w) => smooth01(v / w);
    for (let ty = 0; ty < LIGHT_H; ty++) {
      const py = ((ty + 0.5) / LIGHT_H) * H;
      const h = (py - wallY) / sy;
      for (let tx = 0; tx < LIGHT_W; tx++) {
        const px = ((tx + 0.5) / LIGHT_W) * W;
        let fill = 0;
        if (state.window.enabled && h > H0 - 12 && h < H1 + 12) {
          const xw = px - sunShift[0] * h;
          for (const [x0, x1] of WINDOWS) {
            let f = edge(xw - x0, 6) * edge(x1 - xw, 6) * edge(h - H0, 10) * edge(H1 - h, 10);
            const pane = (x1 - x0) / 3;
            const m = Math.abs(((xw - x0) % pane) - 0);
            f *= 1 - 0.95 * (1 - smooth01((Math.min(m, pane - m) - 1.5) / 3));
            f *= 1 - 0.95 * (1 - smooth01((Math.abs(h - (H0 + H1) / 2) - 3) / 4));
            fill = Math.max(fill, f);
          }
        }
        const i = (ty * LIGHT_W + tx) * 4;
        lightData[i] = indoor[0] + fill * (target[0] - indoor[0]);
        lightData[i + 1] = indoor[1] + fill * (target[1] - indoor[1]);
        lightData[i + 2] = indoor[2] + fill * (target[2] - indoor[2]);
        lightData[i + 3] = 1;
      }
    }
    lightTex.needsUpdate = true;
  }

  // ── THE WIND GRID: a sealed room with one doorway, the real `windHandle.kernel` path ──
  const WIND_CELL = 40;
  const WIND_COLS = Math.ceil(W / WIND_CELL);
  const WIND_ROWS = Math.ceil(H / WIND_CELL);
  const windOpenness = new Float32Array(WIND_COLS * WIND_ROWS).fill(1);
  for (let cy = 0; cy < WIND_ROWS; cy++) {
    for (let cx = 0; cx < WIND_COLS; cx++) {
      const x = (cx + 0.5) * WIND_CELL;
      const y = (cy + 0.5) * WIND_CELL;
      const inRoom = x > 200 && x < 780 && y > 140 && y < 640;
      const doorway = x > 740 && x < 800 && y > 360 && y < 440;
      windOpenness[cy * WIND_COLS + cx] = doorway ? 0.85 : inRoom ? 0.04 : 1;
    }
  }
  const windAmbient = { directionDeg: uniform(90), speed01: uniform(0) };
  const windHandle = createWindHandle({
    version: 1,
    ambientWind: windAmbient,
    grid: { originX: 0, originY: 0, cellSize: WIND_CELL, cols: WIND_COLS, rows: WIND_ROWS },
    cells: { openness: windOpenness },
  });

  // ── the three subsystems (one per effect), exactly as the viewer builds them ───────────────────
  const renderState = (key, layer) => () => ({
    enabled: true,
    params: state.params[key],
    perfTier: state.tier,
    floorIndex: 0,
    elevation: 0,
    gridPx: 100,
    maskGrid: state.grids[layer],
    maskVersion: state.maskVersion[layer],
  });
  const make = (group, key, layer, extra = {}) =>
    createCritterSubsystem({
      THREE,
      group,
      getRenderState: renderState(key, layer),
      createEngine: createCritterEngine,
      allocateBuffers: allocateCritterBuffers,
      createZoneBuffer: createCritterZoneBuffer,
      illumTexNode,
      colorationTexNode,
      random,
      ...extra,
    });
  const subs = {
    smellyFlies: make('smellyFlies', 'smellyFlies', 'flies'),
    maggots: make('maggots', 'maggots', 'maggots'),
    fireflies: make('fireflies', 'fireflies', 'fireflies'),
    // The dust reads its OWN lighting buffer (the window-lit floor), so the flies' flat one stays flat.
    dust: make('dust', 'dust', 'dust', {
      illumTexNode: windowLightNode,
      getWindHandle: () => windHandle,
      allocateWindCells,
      getIndoorLightRgb: indoorRgb,
      getOutdoorLightRgb: outdoorRgb,
    }),
  };
  /** The effect (params group) each paint layer feeds. */
  const LAYER_GROUP = { flies: 'smellyFlies', maggots: 'maggots', fireflies: 'fireflies', dust: 'dust' };

  // ── drawing ────────────────────────────────────────────────────────────────
  const uNight = uniform(0);
  const uShowPaint = uniform(1);
  // The painted zones, as textures, so the author can SEE what they painted (row 0 = minY, like a MaskGrid).
  const paintTexture = (grid) => {
    const tex = new THREE.DataTexture(grid.data, GRID_W, GRID_H, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  };
  const paintTex = {
    flies: paintTexture(state.grids.flies),
    maggots: paintTexture(state.grids.maggots),
    fireflies: paintTexture(state.grids.fireflies),
    dust: paintTexture(state.grids.dust),
  };
  const worldUv = positionWorld.xy.div(vec2(W, H));
  const fliesPaint = texture(paintTex.flies, worldUv).r;
  const maggotsPaint = texture(paintTex.maggots, worldUv).r;
  const firefliesPaint = texture(paintTex.fireflies, worldUv).r;
  const ground = new THREE.NodeMaterial();
  const chk = mod(floor(positionWorld.x.div(48)).add(floor(positionWorld.y.div(48))), 2);
  const dayCol = mix(vec3(0.22, 0.19, 0.13), vec3(0.28, 0.24, 0.17), chk);
  const nightCol = mix(vec3(0.012, 0.02, 0.018), vec3(0.018, 0.028, 0.024), chk);
  const base = mix(dayCol, nightCol, uNight);
  // a faint wash, only a hint of where each zone is (warm for the flies', tan for the maggots', green for the fireflies')
  const tint = vec3(0.1, 0.045, 0.0)
    .mul(fliesPaint)
    .add(vec3(0.07, 0.07, 0.0).mul(maggotsPaint))
    .add(vec3(0.0, 0.07, 0.015).mul(firefliesPaint))
    .mul(uShowPaint)
    .mul(float(1).sub(uNight.mul(0.6)));
  // with the window light on, the floor is lit by the same map the dust reads (the room dim, the patches bright)
  const lit = mix(vec3(1, 1, 1), windowLightNode.sample(worldUv).rgb.mul(2.6), uWindowFloor);
  ground.colorNode = sRGBTransferEOTF(base.add(tint).mul(lit));
  ground.depthTest = false;
  ground.side = THREE.DoubleSide;
  const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), ground);
  groundMesh.position.set(W / 2, H / 2, 0);
  groundMesh.renderOrder = -10;
  const world = new THREE.Scene();
  world.add(groundMesh);
  // y runs DOWN, like the game's world; the lab's mouse maths relies on it
  const camera = new THREE.OrthographicCamera(0, W, 0, H, -10, 10);
  const worldRect = { minX: 0, minY: 0, maxX: W, maxY: H };

  const hdr = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
  const ldr = new THREE.RenderTarget(W, H, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
  });
  const hdrTex = texture(hdr.texture);
  const presentMaterial = new THREE.NodeMaterial();
  const c = hdrTex.rgb;
  // a soft shoulder so a glow of 5 reads as hot, not clipped
  presentMaterial.fragmentNode = vec4(c.div(c.mul(0.15).add(1)), 1);
  const presentQuad = new THREE.QuadMesh(presentMaterial);
  function applyLook() {
    const night = state.ground === 'night' ? 1 : 0;
    uNight.value = night;
    uWindowFloor.value = state.window.enabled ? 1 : 0;
    illumData[0] = illumData[1] = illumData[2] = state.ambient;
    illumTex.needsUpdate = true;
  }
  applyLook();

  let clockMs = 0;
  let lastReal = performance.now();
  let frames = 0;

  /** One frame of the lab. `dtSec` is REAL seconds, the way the viewer feeds the subsystems. */
  function tick(dtSec) {
    clockMs += dtSec * 1000;
    const env = makeEnv();
    windAmbient.speed01.value = state.sky.wind01;
    windAmbient.directionDeg.value = state.sky.windDirectionDeg;
    rebuildWindowLight();
    for (const sub of Object.values(subs)) sub.sync(renderer, clockMs, dtSec, worldRect, env);
    renderer.setRenderTarget(hdr);
    renderer.autoClear = true;
    renderer.render(world, camera);
    renderer.autoClear = false;
    for (const sub of Object.values(subs)) if (sub.hasContent) renderer.render(sub.scene, camera);
    renderer.autoClear = true;
    renderer.setRenderTarget(null);
    if (PRESENT) presentQuad.render(renderer);
    frames += 1;
  }

  function loop() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastReal) / 1000);
    lastReal = now;
    if (!paused) tick(dt);
    requestAnimationFrame(loop);
  }
  /** `?paused=1` stops the display-rate loop: an automated run steps the world itself, with `advance`. */
  let paused = q.get('paused') === '1';

  // ── painting ───────────────────────────────────────────────────────────────
  function paintDisc(layer, x, y, radius, erase = false) {
    const grid = state.grids[layer];
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor((x - radius) / TEXEL));
    const x1 = Math.min(GRID_W - 1, Math.ceil((x + radius) / TEXEL));
    const y0 = Math.max(0, Math.floor((y - radius) / TEXEL));
    const y1 = Math.min(GRID_H - 1, Math.ceil((y + radius) / TEXEL));
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const d2 = ((gx + 0.5) * TEXEL - x) ** 2 + ((gy + 0.5) * TEXEL - y) ** 2;
        if (d2 > r2) continue;
        // a soft brush: full in the middle, fading toward the edge, like the Studio's
        const v = Math.round(255 * Math.min(1, (1 - d2 / r2) * 3));
        const i = gy * GRID_W + gx;
        grid.data[i] = erase ? Math.min(grid.data[i], 255 - v) : Math.max(grid.data[i], v);
      }
    }
    state.maskVersion[layer] += 1;
    paintTex[layer].needsUpdate = true;
  }

  function clear(layer) {
    for (const l of layer ? [layer] : Object.keys(state.grids)) {
      state.grids[l].data.fill(0);
      state.maskVersion[l] += 1;
      paintTex[l].needsUpdate = true;
    }
  }

  function demo() {
    clear();
    for (const [x, y, r] of [
      [300, 380, 150],
      [470, 330, 90],
    ])
      paintDisc('flies', x, y, r);
    // the maggots sit in the heart of the first fly zone (a corpse draws both) and in a patch of their own
    for (const [x, y, r] of [
      [300, 390, 70],
      [640, 560, 60],
    ])
      paintDisc('maggots', x, y, r);
    for (const [x, y, r] of [
      [900, 300, 190],
      [1040, 520, 100],
    ])
      paintDisc('fireflies', x, y, r);
    paintRect('dust', 230, 170, 760, 610);
  }

  /** A solid rectangle of paint (a whole room): the dust is painted over the room, not the beam. */
  function paintRect(layer, x0, y0, x1, y1) {
    const grid = state.grids[layer];
    for (let gy = Math.max(0, Math.floor(y0 / TEXEL)); gy <= Math.min(GRID_H - 1, Math.ceil(y1 / TEXEL)); gy++) {
      for (let gx = Math.max(0, Math.floor(x0 / TEXEL)); gx <= Math.min(GRID_W - 1, Math.ceil(x1 / TEXEL)); gx++) {
        grid.data[gy * GRID_W + gx] = 255;
      }
    }
    state.maskVersion[layer] += 1;
    paintTex[layer].needsUpdate = true;
  }

  let painting = null;
  const toWorld = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return [((ev.clientX - rect.left) / rect.width) * W, ((ev.clientY - rect.top) / rect.height) * H];
  };
  canvas.addEventListener('pointerdown', (ev) => {
    painting = { erase: ev.shiftKey };
    canvas.setPointerCapture(ev.pointerId);
    const [x, y] = toWorld(ev);
    paintDisc(state.paintLayer, x, y, state.brush, painting.erase);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!painting) return;
    const [x, y] = toWorld(ev);
    paintDisc(state.paintLayer, x, y, state.brush, painting.erase);
  });
  canvas.addEventListener('pointerup', () => {
    painting = null;
  });

  // ── capture: render the present pass into 8 bits and read it back ───────────
  async function capture(name = 'critters') {
    // A throwaway material and texture node per capture, like `candle-lab.js#capture`: the shared
    // `hdrTex` node belongs to the on-screen present pass, and a second material built on the same
    // node was the one thing that took the software adapter's device down.
    const grab = new THREE.NodeMaterial();
    const cc = texture(hdr.texture).rgb;
    grab.fragmentNode = vec4(TSL.sRGBTransferOETF(cc.div(cc.mul(0.15).add(1))), 1);
    const captureQuad = new THREE.QuadMesh(grab);
    renderer.setRenderTarget(ldr);
    captureQuad.render(renderer);
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
      // WebGPU pads each readback row to a multiple of 256 bytes; strip it.
      const stride = Math.ceil((W * 4) / 256) * 256;
      for (let y = 0; y < H; y++) img.data.set(src.subarray(y * stride, y * stride + W * 4), y * W * 4);
    }
    ctx.putImageData(img, 0, 0);
    grab.dispose();
    return { name, dataUrl: cv.toDataURL('image/png') };
  }

  // ── the zone sampler, GPU against CPU ──────────────────────────────────────
  // Built on first use and kept: a storage buffer can never be freed, so the lab owns exactly one pair.
  let parityRig = null;
  const PARITY_POINTS = 1024;
  function makeParityRig() {
    const zoneBuffer = createCritterZoneBuffer({ THREE, maxCells: ZONE_MAX_CELLS, homeCapacities: [] });
    // The throwaway arena is the sanctioned door to storage memory: `position` carries the points in,
    // `custom` (a vec4) carries (coverage, distance, gradX, gradY) out.
    const memory = allocateCritterBuffers(THREE, PARITY_POINTS);
    const bank = createUniformBank(TSL);
    const sampler = buildZoneSampler(TSL, { buffer: zoneBuffer.node, u: bank.get });
    const { Fn, instanceIndex } = TSL;
    const kernel = Fn(() => {
      const r = sampler.sample(memory.buffers.position.element(instanceIndex));
      memory.buffers.custom.element(instanceIndex).assign(vec4(r.coverage, r.distance, r.grad.x, r.grad.y));
    })().compute(PARITY_POINTS);
    return { zoneBuffer, memory, bank, kernel };
  }
  /**
   * Run the TSL zone sampler and `sampleZoneField` over the same points — inside the field, across its
   * edge, and well beyond it (where the overshoot term takes over) — and report the worst disagreement.
   * Float32 against float64, so the tolerances are a few ulps, not zero.
   */
  async function samplerParity({ layer = 'flies' } = {}) {
    const key = LAYER_GROUP[layer];
    const field = buildZoneField(state.grids[layer], {
      threshold: state.params[key].maskSensitivity,
      marginPx: critterMarginPx(100),
    });
    if (!field) return { ok: false, why: `nothing is painted on the ${layer} layer — paint a zone first` };
    parityRig ??= makeParityRig();
    const { zoneBuffer, memory, bank, kernel } = parityRig;
    zoneBuffer.write(field, []);
    bank.setMany({
      zoneOrigin: [field.originX, field.originY],
      zoneCell: [field.cellW, field.cellH],
      zoneDims: [field.cols, field.rows],
      homesOffset: 0,
    });
    // a fixed spread: random points over the field's rectangle widened by half its size, plus the exact cell centres of the first row
    const spanX = field.cols * field.cellW;
    const spanY = field.rows * field.cellH;
    let rng = 12345;
    const next = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296;
    const points = [];
    for (let i = 0; i < PARITY_POINTS; i++) {
      if (i < field.cols && i < 64) {
        points.push([field.originX + (i + 0.5) * field.cellW, field.originY + (field.rows >> 1) * field.cellH]);
      } else {
        points.push([field.originX + (next() * 2 - 0.5) * spanX, field.originY + (next() * 2 - 0.5) * spanY]);
      }
    }
    const input = memory.buffers.position.value;
    for (let i = 0; i < PARITY_POINTS; i++) {
      input.array[i * 2] = points[i][0];
      input.array[i * 2 + 1] = points[i][1];
    }
    input.needsUpdate = true;
    renderer.compute(kernel);
    const out = new Float32Array(await renderer.getArrayBufferAsync(memory.buffers.custom.value));
    let coverageErr = 0;
    let distanceErr = 0;
    let gradErr = 0;
    let beyond = 0;
    let worst = null;
    for (let i = 0; i < PARITY_POINTS; i++) {
      const [x, y] = points[i];
      const cpu = sampleZoneField(field, x, y);
      const dc = Math.abs(out[i * 4] - cpu.coverage);
      const dd = Math.abs(out[i * 4 + 1] - cpu.distance);
      const dg = Math.hypot(out[i * 4 + 2] - cpu.gradX, out[i * 4 + 3] - cpu.gradY);
      if (x < field.originX || y < field.originY || x > field.originX + spanX || y > field.originY + spanY) beyond++;
      coverageErr = Math.max(coverageErr, dc);
      gradErr = Math.max(gradErr, dg);
      if (dd > distanceErr) {
        distanceErr = dd;
        worst = { x, y, gpu: Array.from(out.subarray(i * 4, i * 4 + 4)), cpu };
      }
    }
    return {
      ok: coverageErr < 1e-4 && distanceErr < 0.05 && gradErr < 1e-3,
      samples: PARITY_POINTS,
      beyondTheField: beyond,
      maxCoverageError: coverageErr,
      maxDistanceErrorPx: distanceErr,
      maxGradientError: gradErr,
      worst,
    };
  }

  // ── the panel ──────────────────────────────────────────────────────────────
  const panel = document.getElementById('panel');
  /** Where the next widget is appended: the panel itself, or the effect block being built. */
  let host = panel;
  const heading = (t) => {
    const h = document.createElement('h4');
    h.textContent = t;
    host.appendChild(h);
  };
  const slider = (label, min, max, step, get, set) => {
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(get());
    const val = document.createElement('span');
    val.textContent = String(get());
    input.addEventListener('input', () => {
      set(Number(input.value));
      val.textContent = input.value;
    });
    row.append(name, input, val);
    host.appendChild(row);
  };
  const select = (label, options, get, set) => {
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = label;
    const sel = document.createElement('select');
    for (const o of options) sel.add(new Option(String(o), String(o)));
    sel.value = String(get());
    sel.addEventListener('change', () => set(sel.value));
    row.append(name, sel, document.createElement('span'));
    host.appendChild(row);
  };
  const toggle = (label, get, set) => {
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = label;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!get();
    box.addEventListener('change', () => set(box.checked));
    row.append(name, box, document.createElement('span'));
    host.appendChild(row);
  };
  const button = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    host.appendChild(b);
  };
  /** A fresh params object per change: the subsystem re-pushes uniforms when the object's identity moves. */
  const setParam = (group, patch) => {
    state.params[group] = { ...state.params[group], ...patch };
  };

  heading('Paint');
  select(
    'layer',
    ['flies', 'maggots', 'fireflies', 'dust'],
    () => state.paintLayer,
    (v) => (state.paintLayer = v)
  );
  slider(
    'brush',
    10,
    140,
    2,
    () => state.brush,
    (v) => (state.brush = v)
  );
  toggle(
    'show paint',
    () => uShowPaint.value > 0.5,
    (v) => (uShowPaint.value = v ? 1 : 0)
  );
  button('demo zones', demo);
  button('clear', () => clear());

  heading('Sky and light');
  slider(
    'sun elevation °',
    -30,
    60,
    1,
    () => state.sky.elevationDeg,
    (v) => (state.sky.elevationDeg = v)
  );
  toggle(
    'sun rising (dawn)',
    () => state.sky.rising,
    (v) => (state.sky.rising = v)
  );
  slider(
    'rain',
    0,
    1,
    0.05,
    () => state.sky.precip01,
    (v) => (state.sky.precip01 = v)
  );
  slider(
    'wind',
    0,
    1,
    0.05,
    () => state.sky.wind01,
    (v) => (state.sky.wind01 = v)
  );
  slider(
    'gustiness',
    0,
    1,
    0.05,
    () => state.sky.gust01,
    (v) => (state.sky.gust01 = v)
  );
  slider(
    'wind direction °',
    0,
    360,
    5,
    () => state.sky.windDirectionDeg,
    (v) => (state.sky.windDirectionDeg = v)
  );
  select(
    'precipitation',
    ['rain', 'snow', 'sleet', 'ash'],
    () => state.sky.precipKind,
    (v) => (state.sky.precipKind = v)
  );
  slider(
    'temperature (0 = freezing)',
    0,
    1,
    0.05,
    () => state.sky.temperature01,
    (v) => (state.sky.temperature01 = v)
  );
  slider(
    'scene light',
    0.05,
    1.5,
    0.05,
    () => state.ambient,
    (v) => {
      state.ambient = v;
      applyLook();
    }
  );
  toggle(
    'window light (dust)',
    () => state.window.enabled,
    (v) => {
      state.window.enabled = v;
      applyLook();
    }
  );
  slider(
    'window strength',
    0,
    2,
    0.05,
    () => state.window.strength,
    (v) => (state.window.strength = v)
  );
  slider(
    'cloud cover',
    0,
    1,
    0.05,
    () => state.sky.cloud01,
    (v) => (state.sky.cloud01 = v)
  );
  select(
    'ground',
    ['day', 'night'],
    () => state.ground,
    (v) => {
      state.ground = v;
      applyLook();
    }
  );
  select(
    'tier',
    [0, 1, 2, 3, 4],
    () => state.tier,
    (v) => (state.tier = Number(v))
  );

  // The three effects' controls are GENERATED from their schemas — the same declarations the Studio's cards are
  // built from — so the lab can never offer a slider the effect no longer has, or miss one it has gained.
  const colorInput = (label, get, set) => {
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = get();
    input.addEventListener('input', () => set(input.value));
    row.append(name, input, document.createElement('span'));
    host.appendChild(row);
  };
  /** One collapsible block per effect, a sub-heading per category, a control per param. */
  function schemaSection(title, group, schema) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = title;
    det.appendChild(sum);
    panel.appendChild(det);
    host = det;
    try {
      const byCategory = new Map();
      for (const [id, def] of Object.entries(schema)) {
        if (!byCategory.has(def.category)) byCategory.set(def.category, []);
        byCategory.get(def.category).push([id, def]);
      }
      for (const [category, entries] of byCategory) {
        const h = document.createElement('h5');
        h.textContent = category;
        host.appendChild(h);
        for (const [id, def] of entries) {
          const get = () => state.params[group][id];
          const set = (v) => setParam(group, { [id]: v });
          if (def.type === 'bool') toggle(def.label, get, set);
          else if (def.type === 'enum') select(def.label, def.values, get, set);
          else if (def.type === 'color') colorInput(def.label, get, set);
          else slider(def.label, def.min, def.max, def.step ?? (def.type === 'int' ? 1 : 0.01), get, set);
        }
      }
    } finally {
      host = panel;
    }
    return det;
  }
  heading('Effects (three masks, three cards)');
  schemaSection('Smelly flies', 'smellyFlies', SMELLY_FLIES_PARAMS).open = true;
  schemaSection('Maggots', 'maggots', MAGGOTS_PARAMS);
  schemaSection('Fireflies', 'fireflies', FIREFLIES_PARAMS);
  schemaSection('Dust', 'dust', DUST_PARAMS);

  // ── the scripted door ──────────────────────────────────────────────────────
  const lab = {
    THREE,
    state,
    subs,
    describe: () => ({
      layers: Object.keys(state.grids),
      groups: Object.keys(state.params),
      sky: { ...state.sky },
      tier: state.tier,
      note: 'groups: smellyFlies · maggots · fireflies · dust — setWindowLight(patch) · setParam(group, patch) · setSky(patch) · setTier(n) · paint(layer,x,y,r,erase) · demo() · clear(layer?) · await advance(sec,hz?) · await capture(name?) · await samplerParity({layer?}) · status()',
    }),
    setParam,
    setSky(patch) {
      Object.assign(state.sky, patch);
    },
    /** `setWindowLight({ enabled: true, strength: 1 })` — the dust's lit floor (and the ground it lights). */
    setWindowLight(patch) {
      Object.assign(state.window, patch);
      applyLook();
    },
    paintRect,
    setTier(n) {
      state.tier = Math.max(0, Math.min(4, Math.floor(n)));
    },
    setGround(g, ambient = state.ambient) {
      state.ground = g;
      state.ambient = ambient;
      applyLook();
    },
    paint: paintDisc,
    demo,
    clear,
    /**
     * Run `seconds` of simulation at `hz` WITHOUT waiting on the display: a deterministic fast-forward.
     *
     * Async, and every few frames it WAITS FOR THE GPU TO CATCH UP (`onSubmittedWorkDone`). A burst of
     * submits that outruns the device builds a queue seconds deep; on a software adapter the browser's
     * GPU watchdog then reads "still busy" as "hung" and takes the whole device down, which surfaced
     * as a baffling "no longer exists" error at the next readback. A real GPU never notices; the wait
     * costs nothing there.
     */
    async advance(seconds, hz = 30) {
      const dt = 1 / hz;
      const n = Math.max(1, Math.round(seconds * hz));
      const queue = renderer.backend?.device?.queue;
      for (let i = 0; i < n; i++) {
        tick(dt);
        if (i % 4 === 3) {
          if (queue?.onSubmittedWorkDone) await queue.onSubmittedWorkDone();
          else await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      return n;
    },
    pause(on = true) {
      paused = on;
    },
    capture,
    samplerParity,
    /**
     * Read the dust back and report how it moves, by region: the sealed room's interior, the doorway, and the rest.
     * The wind grid in this lab is a sealed room (openness 0.04) with one doorway on its east wall (0.85).
     */
    async windStats(boxes = null) {
      const engine = subs.dust.debugEngines()[0];
      if (!engine) return { ok: false, why: 'no dust engine yet — paint a zone and advance' };
      const r = await engine.readback(renderer);
      // `boxes`: { name: [x0, y0, x1, y1] } in world px; the default is the sealed room and its doorway.
      const named = boxes ?? { interior: [260, 200, 680, 580], doorway: [745, 365, 800, 435] };
      const regions = Object.fromEntries(
        Object.entries(named).map(([name, [x0, y0, x1, y1]]) => [name, (x, y) => x > x0 && x < x1 && y > y0 && y < y1])
      );
      const out = {};
      for (const name of Object.keys(regions)) out[name] = { n: 0, speed: 0, vx: 0, vy: 0 };
      for (let i = 0; i < r.position.length / r.positionStride; i++) {
        const x = r.position[i * r.positionStride];
        const y = r.position[i * r.positionStride + 1];
        const vx = r.velocity[i * r.velocityStride];
        const vy = r.velocity[i * r.velocityStride + 1];
        for (const [name, inside] of Object.entries(regions)) {
          if (!inside(x, y)) continue;
          const o = out[name];
          o.n += 1;
          o.speed += Math.hypot(vx, vy);
          o.vx += vx;
          o.vy += vy;
        }
      }
      for (const o of Object.values(out)) {
        if (o.n) {
          o.speed /= o.n;
          o.vx /= o.n;
          o.vy /= o.n;
        }
      }
      return { ok: true, ...out };
    },
    status: () => ({
      frames,
      clockSec: clockMs / 1000,
      smellyFlies: subs.smellyFlies.getStatus(),
      maggots: subs.maggots.getStatus(),
      fireflies: subs.fireflies.getStatus(),
      dust: subs.dust.getStatus(),
    }),
  };
  window.critterLab = lab;

  demo();
  requestAnimationFrame(loop);
  window.setInterval(() => {
    const s = lab.status();
    const line = (name, st) =>
      `${name}: zones ${st.zones ?? 0}, engines ${(st.engines ?? [])
        .map((e) => `${e.kind} ${e.population} @${e.activity}`)
        .join(', ')}`;
    say(
      `frame ${s.frames}  t ${s.clockSec.toFixed(1)} s\n${line('flies', s.smellyFlies)}\n${line('maggots', s.maggots)}\n${line('fireflies', s.fireflies)}\n${line('dust', s.dust)}`
    );
  }, 250);
  return lab;
}

/** Hermite smoothstep on 0..1. */
function smooth01(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

main().catch((err) => {
  say(`FAILED: ${err?.stack ?? err}`);
  window.critterLabError = String(err?.stack ?? err);
});
