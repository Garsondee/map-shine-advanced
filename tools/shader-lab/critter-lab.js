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
 *   • Paint with the left mouse button, erase with shift. The Paint selector picks which
 *     zone you are painting (flies' or fireflies').
 *   • Slide the sun below the horizon to hatch the fireflies; raise the rain to clear them.
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
import { createCritterSubsystem } from '../../src/effects/critters/critter-subsystem.js';
import { createCritterEngine, allocateCritterBuffers } from '../../src/effects/particles/critter-runtime.js';
import { createCritterZoneBuffer } from '../../src/effects/particles/critter-zone-buffer.js';
import { SMELLY_FLIES_PARAMS } from '../../src/effects/critters/smelly-flies.js';
import { FIREFLIES_PARAMS } from '../../src/effects/critters/fireflies.js';
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
    sky: { elevationDeg: 50, rising: false, precip01: 0, wind01: 0, cloud01: 0 },
    maskVersion: { flies: 1, fireflies: 1 },
    grids: { flies: makeGrid(), fireflies: makeGrid() },
    params: {
      smellyFlies: { ...defaultsOf(SMELLY_FLIES_PARAMS) },
      fireflies: { ...defaultsOf(FIREFLIES_PARAMS) },
    },
  };

  /** What `world/environment.js` would hand the subsystems this frame. */
  const makeEnv = () => ({
    sun: {
      elevationDeg: state.sky.elevationDeg,
      azimuthDeg: 200,
      rising: state.sky.rising,
      // the real curve (world/sun.js): eased across civil twilight to clear sun
      dayFactor01: smooth01((state.sky.elevationDeg + 6) / 16),
    },
    weather: { precip01: state.sky.precip01, cloudCover01: state.sky.cloud01 },
    wind: { speed01: state.sky.wind01 },
  });

  // ── the scene's lighting: one flat multiplier standing in for the illumination buffer ──
  const illumData = new Float32Array([1, 1, 1, 1]);
  const illumTex = new THREE.DataTexture(illumData, 1, 1, THREE.RGBAFormat, THREE.FloatType);
  illumTex.needsUpdate = true;
  const colorationTex = new THREE.DataTexture(new Float32Array([0, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  colorationTex.needsUpdate = true;
  const illumTexNode = texture(illumTex);
  const colorationTexNode = texture(colorationTex);

  // ── the two subsystems, exactly as the viewer builds them ───────────────────
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
  const make = (group, key, layer) =>
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
    });
  const subs = {
    smellyFlies: make('smellyFlies', 'smellyFlies', 'flies'),
    fireflies: make('fireflies', 'fireflies', 'fireflies'),
  };

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
  const paintTex = { flies: paintTexture(state.grids.flies), fireflies: paintTexture(state.grids.fireflies) };
  const worldUv = positionWorld.xy.div(vec2(W, H));
  const fliesPaint = texture(paintTex.flies, worldUv).r;
  const firefliesPaint = texture(paintTex.fireflies, worldUv).r;
  const ground = new THREE.NodeMaterial();
  const chk = mod(floor(positionWorld.x.div(48)).add(floor(positionWorld.y.div(48))), 2);
  const dayCol = mix(vec3(0.22, 0.19, 0.13), vec3(0.28, 0.24, 0.17), chk);
  const nightCol = mix(vec3(0.012, 0.02, 0.018), vec3(0.018, 0.028, 0.024), chk);
  const base = mix(dayCol, nightCol, uNight);
  // a faint wash, only a hint of where each zone is (warm for the flies', green for the fireflies')
  const tint = vec3(0.1, 0.045, 0.0)
    .mul(fliesPaint)
    .add(vec3(0.0, 0.07, 0.015).mul(firefliesPaint))
    .mul(uShowPaint)
    .mul(float(1).sub(uNight.mul(0.6)));
  ground.colorNode = sRGBTransferEOTF(base.add(tint));
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
    for (const [x, y, r] of [
      [900, 300, 190],
      [1040, 520, 100],
    ])
      paintDisc('fireflies', x, y, r);
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
    const key = layer === 'flies' ? 'smellyFlies' : 'fireflies';
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
  const heading = (t) => {
    const h = document.createElement('h4');
    h.textContent = t;
    panel.appendChild(h);
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
    panel.appendChild(row);
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
    panel.appendChild(row);
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
    panel.appendChild(row);
  };
  const button = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    panel.appendChild(b);
  };
  /** A fresh params object per change: the subsystem re-pushes uniforms when the object's identity moves. */
  const setParam = (group, patch) => {
    state.params[group] = { ...state.params[group], ...patch };
  };

  heading('Paint');
  select(
    'layer',
    ['flies', 'fireflies'],
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

  heading('Flies and maggots');
  const sf = (id) => () => state.params.smellyFlies[id];
  const setSf = (id) => (v) => setParam('smellyFlies', { [id]: v });
  slider('flies / swarm', 0, 80, 1, sf('fliesPerZone'), setSf('fliesPerZone'));
  slider('maggots / swarm', 0, 200, 1, sf('maggotsPerZone'), setSf('maggotsPerZone'));
  slider('fly size', 6, 80, 1, sf('size'), setSf('size'));
  slider('maggot size', 6, 80, 1, sf('maggotSize'), setSf('maggotSize'));
  slider('buzz', 200, 4000, 50, sf('buzz'), setSf('buzz'));
  slider('land chance /s', 0, 0.6, 0.01, sf('landChance'), setSf('landChance'));
  slider('take-off chance /s', 0, 0.6, 0.01, sf('takeoffChance'), setSf('takeoffChance'));
  slider('fly height', 5, 300, 5, sf('flyHeight'), setSf('flyHeight'));
  slider('wing blur', 0, 1, 0.05, sf('wingBlur'), setSf('wingBlur'));
  slider('maggot wriggle', 0, 3, 0.05, sf('maggotWriggle'), setSf('maggotWriggle'));
  slider('maggot clustering', 0, 1, 0.05, sf('maggotClustering'), setSf('maggotClustering'));
  slider('flies at night', 0, 1, 0.05, sf('nightActivity'), setSf('nightActivity'));
  select(
    'species',
    SMELLY_FLIES_PARAMS.species.values,
    () => state.params.smellyFlies.species,
    (v) => setParam('smellyFlies', { species: v })
  );

  heading('Fireflies');
  const ff = (id) => () => state.params.fireflies[id];
  const setFf = (id) => (v) => setParam('fireflies', { [id]: v });
  slider('fireflies / colony', 0, 120, 1, ff('countPerZone'), setFf('countPerZone'));
  slider('size', 3, 60, 1, ff('size'), setFf('size'));
  slider('glow strength', 0, 20, 0.5, ff('intensity'), setFf('intensity'));
  slider('glow radius', 2, 120, 1, ff('glowRadius'), setFf('glowRadius'));
  slider('flash period s', 1, 12, 0.1, ff('flashPeriod'), setFf('flashPeriod'));
  slider('synchrony', 0, 1, 0.05, ff('synchrony'), setFf('synchrony'));
  slider('drift speed', 5, 250, 1, ff('driftSpeed'), setFf('driftSpeed'));
  slider('roaming range', 0, 800, 10, ff('range'), setFf('range'));
  toggle('ignore time of day', ff('alwaysActive'), setFf('alwaysActive'));
  select(
    'flash style',
    FIREFLIES_PARAMS.flashStyle.values,
    () => state.params.fireflies.flashStyle,
    (v) => setParam('fireflies', { flashStyle: v })
  );

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
      note: 'setParam(group, patch) · setSky(patch) · setTier(n) · paint(layer,x,y,r,erase) · demo() · clear(layer?) · await advance(sec,hz?) · await capture(name?) · await samplerParity({layer?}) · status()',
    }),
    setParam,
    setSky(patch) {
      Object.assign(state.sky, patch);
    },
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
    status: () => ({
      frames,
      clockSec: clockMs / 1000,
      smellyFlies: subs.smellyFlies.getStatus(),
      fireflies: subs.fireflies.getStatus(),
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
      `frame ${s.frames}  t ${s.clockSec.toFixed(1)} s\n${line('flies', s.smellyFlies)}\n${line('fireflies', s.fireflies)}`
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
