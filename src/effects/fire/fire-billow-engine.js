/**
 * FIRE — THE BILLOW ENGINE (2026-10-20). The per-frame orchestrator between the world (fires, painted spawn points,
 * wind, rain, the fire's slow life) and the billow model/renderer. THREE injected, no renderer-state calls: the splat
 * is returned as a job list for the viewer to run (see `fire-billow-render.js`).
 *
 * Each frame, for every fire:
 *   1. WEATHER AT THE FIRE — the wind bake's openness and sky at its own position (`windHandle.cpuAt`), the ambient
 *      wind's speed and direction, the scene's rain, folded into the numbers the model wants (local wind push, the one
 *      stress number, rain reaching it) with the SAME functions the light and the embers use, so they cannot disagree.
 *   2. ITS LIFE — `fire-billow-state.js` steps the fire's wetness, vitality and coals (rain puts it out, the coals
 *      smoulder, the ash goes cold, a long dry spell relights it).
 *   3. ITS BILLOWS — `emitFireLobes` writes the fire's lobes into the renderer's two buffers.
 * Then the contour boxes are fitted round the lobes and the field jobs are prepared.
 *
 * ⚠️ A BIG PAINTED REGION IS MANY FLAMES, NOT ONE HUGE ONE. A flame does not grow past a bonfire's however wide the
 * fuel is: `planClusters` splits a fire wider than `MAX_CLUSTER_RADIUS_M` into sub-fires spread over its painted
 * spawn points (greedy farthest-point, stable), each its own flame sharing the parent's life. That is the road to a
 * burning building: paint the roof, get a roof of flames.
 *
 * @module effects/fire/fire-billow-engine
 */
import { createBillowRenderer } from './fire-billow-render.js';
import { emitFireLobes, LOBE_STRIDE, maxLobesPerFire } from './fire-billow-geometry.js';
import { createFireLifeBook } from './fire-billow-state.js';
import { billowRuntimeFromParams } from './fire-billow-params.js';
import { bloomCounterParams, bloomCounterUniforms, regionFill } from './fire-billow-bloom.js';
import { fireScaleChain, fireWindMotion01, fireWeatherStress01, FIRE_FUELS, deriveFireSeed } from './fire-geometry.js';
import { SPAWN_POINT_STRIDE } from './fire-spawn-points.js';
import { buildDepthHeightGateNode } from '../lighting/point-light-illumination.js';
import { windFlowVector } from '../../world/index.js';

/** The widest a single flame gets, in metres of fuel: past this a painted region is split into several flames. */
export const MAX_CLUSTER_RADIUS_M = 0.9;
/** The most spawn points one cluster keeps (an even subsample): the model only needs a footprint, not every texel. */
const MAX_POINTS_PER_CLUSTER = 96;
/** Beyond this many sub-flames per fire the extras are dropped (a whole city block is not one fire). */
const MAX_CLUSTERS_PER_FIRE = 48;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Split the fires into flames. Pure and deterministic (Node-tested).
 *
 * @param {Array<{id?:string,x:number,y:number,diameterPx:number}>} fires
 * @param {{points?:Float32Array,count?:number}|null} cloud the painted spawn cloud (x, y, brightness, jitter per point)
 * @param {number} mPerPx world metres per px
 * @returns {Array<{fireIndex:number, id:string, x:number, y:number, radius:number, seed:number, points:Float32Array, count:number}>}
 */
export function planClusters(fires, cloud, mPerPx) {
  const out = [];
  const list = Array.isArray(fires) ? fires : [];
  const pts = cloud?.points ?? null;
  const n = cloud?.count ?? 0;
  const stride = SPAWN_POINT_STRIDE;
  const maxR = Math.max(24, MAX_CLUSTER_RADIUS_M / Math.max(1e-4, mPerPx));

  // 1. every painted point goes to its nearest fire
  const owned = list.map(() => []);
  if (pts && n > 0 && list.length) {
    for (let i = 0; i < n; i++) {
      const x = pts[i * stride];
      const y = pts[i * stride + 1];
      let best = 0;
      let bd = Infinity;
      for (let j = 0; j < list.length; j++) {
        const dx = x - list[j].x;
        const dy = y - list[j].y;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      owned[best].push(i);
    }
  }

  const pack = (indices) => {
    const take = Math.min(MAX_POINTS_PER_CLUSTER, indices.length);
    const arr = new Float32Array(take * stride);
    const step = indices.length / Math.max(1, take);
    for (let k = 0; k < take; k++) {
      const i = indices[Math.floor(k * step)];
      for (let c = 0; c < stride; c++) arr[k * stride + c] = pts[i * stride + c];
    }
    return { points: arr, count: take };
  };

  for (let j = 0; j < list.length; j++) {
    const f = list[j];
    const id = String(f.id ?? `fire@${Math.round(f.x)},${Math.round(f.y)}`);
    const R = Math.max(4, (Number(f.diameterPx) || 100) / 2);
    const baseSeed = deriveFireSeed(f.x, f.y) | 0;
    const mine = owned[j];
    if (R <= maxR * 1.15 || mine.length < 6) {
      const { points, count } = pack(mine);
      out.push({ fireIndex: j, id, x: f.x, y: f.y, radius: R, seed: baseSeed, points, count });
      continue;
    }
    // a wide fire: greedy farthest-point sampling over its painted points -> centres at least ~1.5 maxR apart
    const want = clamp(Math.ceil((R / maxR) * (R / maxR) * 0.9), 2, MAX_CLUSTERS_PER_FIRE);
    const centres = [];
    // start from the point nearest the fire's own centre, for a stable first pick
    let first = mine[0];
    let fd = Infinity;
    for (const i of mine) {
      const dx = pts[i * stride] - f.x;
      const dy = pts[i * stride + 1] - f.y;
      const d = dx * dx + dy * dy;
      if (d < fd) {
        fd = d;
        first = i;
      }
    }
    centres.push(first);
    const minDist2 = new Float64Array(mine.length).fill(Infinity);
    while (centres.length < want) {
      const last = centres[centres.length - 1];
      let far = -1;
      let farD = -1;
      for (let m = 0; m < mine.length; m++) {
        const i = mine[m];
        const dx = pts[i * stride] - pts[last * stride];
        const dy = pts[i * stride + 1] - pts[last * stride + 1];
        const d = dx * dx + dy * dy;
        if (d < minDist2[m]) minDist2[m] = d;
        if (minDist2[m] > farD) {
          farD = minDist2[m];
          far = i;
        }
      }
      if (far < 0 || farD < maxR * 1.3 * (maxR * 1.3)) break;
      centres.push(far);
    }
    const groups = centres.map(() => []);
    for (const i of mine) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const dx = pts[i * stride] - pts[centres[c] * stride];
        const dy = pts[i * stride + 1] - pts[centres[c] * stride + 1];
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      groups[best].push(i);
    }
    for (let c = 0; c < centres.length; c++) {
      const { points, count } = pack(groups[c]);
      // each flame is as wide as its own share of the paint, never wider than a bonfire
      let spread = 0;
      for (const i of groups[c]) {
        const dx = pts[i * stride] - pts[centres[c] * stride];
        const dy = pts[i * stride + 1] - pts[centres[c] * stride + 1];
        spread = Math.max(spread, Math.hypot(dx, dy));
      }
      out.push({
        fireIndex: j,
        id,
        x: pts[centres[c] * stride],
        y: pts[centres[c] * stride + 1],
        radius: clamp(Math.max(spread * 0.8, maxR * 0.55), 6, maxR),
        seed: (baseSeed + Math.imul(c + 1, 0x9e3779b1)) | 0,
        points,
        count,
      });
    }
  }
  return out;
}

/**
 * @param {object} deps
 * @param {*} deps.THREE
 * @param {(name:string,w:number,h:number)=>*} deps.createTarget the allocator (see `fire-billow-render.js`)
 * @param {(rt:*)=>void} [deps.disposeTarget]
 * @param {() => object|null} [deps.getWindHandle]
 * @param {object} [deps.lighting] `{illumTexNode, colorationTexNode}`
 * @param {*} [deps.depthTexNode] @param {*} [deps.depthFlagsTexNode]
 * @param {number} [deps.flameCapacity] @param {number} [deps.smokeCapacity]
 * @param {typeof createBillowRenderer} [deps.createRenderer] the renderer factory (injected so Node tests can run the whole
 *   CPU side — weather, life, lobes, boxes — against a fake that has no GPU behind it)
 */
export function createBillowEngine({
  THREE,
  createTarget,
  disposeTarget = null,
  getWindHandle = null,
  lighting = null,
  depthTexNode = null,
  depthFlagsTexNode = null,
  flameCapacity,
  smokeCapacity,
  createRenderer = createBillowRenderer,
}) {
  const buildGate = (TSL, { depthTexNode: dTex, depthFlagsTexNode: fTex, expectedDepth }) =>
    buildDepthHeightGateNode(TSL, {
      depthHere: dTex.sample(TSL.screenUV),
      flagsHere: fTex ? fTex.sample(TSL.screenUV) : null,
      uLightExpectedDepth: expectedDepth,
    });
  const renderer = createRenderer({
    THREE,
    createTarget,
    disposeTarget,
    flameCapacity,
    smokeCapacity,
    lighting,
    depth: depthTexNode ? { depthTexNode, depthFlagsTexNode, buildGate } : null,
  });
  const lives = createFireLifeBook();
  /** @type {{cloud:*, fires:*, mPerPx:number, clusters:Array<object>}} */
  let planMemo = { cloud: null, fires: null, mPerPx: -1, clusters: [] };
  let jobs = [];
  let status = { fires: 0, clusters: 0, flame: 0, smoke: 0, coal: 0, dropped: 0 };
  let runtimeMemo = { params: null, fuelKey: '', value: null };

  function brFor(params, fuel) {
    const fuelKey = String(fuel);
    if (runtimeMemo.params === params && runtimeMemo.fuelKey === fuelKey) return runtimeMemo.value;
    const f = FIRE_FUELS[fuel] ?? FIRE_FUELS.wood;
    const value = billowRuntimeFromParams(params, {
      sootGain: f.sootGain,
      smokeGain: f.smokeGain,
      heightGain: f.heightGain,
      hueShiftRad: ((f.hueShift ?? 0) + clamp(Number(params?.colorHueShift) || 0, -180, 180) / 360) * Math.PI * 2,
    });
    runtimeMemo = { params, fuelKey, value };
    return value;
  }

  return {
    /** The scene to draw into the frame, with the flame/smoke/coal contour. */
    scene: renderer.scene,
    renderer,
    lives,

    /**
     * One frame of CPU work. Writes the lobes and prepares the field jobs (fetch them with `takeFieldJobs`).
     *
     * @param {object} ctx
     * @param {number} ctx.nowMs @param {number} ctx.dtSec
     * @param {{minX:number,minY:number,maxX:number,maxY:number}} ctx.rect the visible world rect
     * @param {Array<object>} ctx.fires `getFireRenderState().fires` (with geometric `windExposure`)
     * @param {object|null} ctx.cloud the painted spawn cloud
     * @param {object} ctx.params the resolved FIRE_PARAMS values
     * @param {object} ctx.runtime `fireRuntimeFromParams(...)` — for the weather numbers it already folds
     * @param {number} ctx.precip01 the scene's eased precipitation
     * @param {number} ctx.pxPerWorld the drawing buffer's pixel density over the rect
     * @param {{enabled?:boolean, params?:object}|null} [ctx.bloom] the scene's live bloom (`getBloomRenderState()`): the flame
     *   paints the inverse of it so the painted colours survive (fire-billow-bloom.js). Absent = no bloom to counter.
     * @param {number} ctx.mPerPx
     * @param {number} [ctx.quality=1] the tier's lobe budget scale
     * @param {number} [ctx.expectedDepth=0]
     * @returns {{lifeByFire: Map<string,{vitality:number,coal:number,phase:string}>}}
     */
    update(ctx) {
      const { nowMs, dtSec, rect, fires, cloud, params, runtime } = ctx;
      const windHandle = getWindHandle?.() ?? null;
      const mPerPx = ctx.mPerPx > 0 ? ctx.mPerPx : 0.0102;
      const br = brFor(params, params?.fuel ?? 'wood');
      const timeSec = nowMs * 0.001 * br.motionSpeed;
      const pxPerWorld = ctx.pxPerWorld > 0 ? ctx.pxPerWorld : 1;

      // the scene's bloom adds its glow on top of the flame; the flame paints the inverse of it (see fire-billow-bloom.js).
      // Four uniforms, set every frame (the cascade can move the bloom at any time, and a uniform write costs nothing).
      const counter = bloomCounterParams(ctx.bloom);
      renderer.setBloomCounter?.(bloomCounterUniforms(counter, br.bloomMix));

      // the clusters (flames) are replanned only when the paint, the fires or the grid scale change
      if (planMemo.cloud !== cloud || planMemo.fires !== fires || planMemo.mPerPx !== mPerPx) {
        planMemo = { cloud, fires, mPerPx, clusters: planClusters(fires, cloud, mPerPx) };
      }
      const clusters = planMemo.clusters;

      const ambient = windHandle?.ambient ?? null;
      const windSpeed01 = Number.isFinite(ambient?.speed01?.value) ? ambient.speed01.value : 0;
      const windDirDeg = Number.isFinite(ambient?.directionDeg?.value) ? ambient.directionDeg.value : 0;
      const wdir = windFlowVector(windDirDeg);
      const canAsk = !!(windHandle?.hasBake && typeof windHandle.cpuAt === 'function');
      const snuffable = runtime?.canBeSnuffed !== false;
      const weatherResponse = clamp(Number(runtime?.weatherResponse ?? params?.weatherResponse ?? 1), 0, 1);
      const rainResponse = clamp(Number(runtime?.rainResponse ?? params?.rainResponse ?? 1), 0, 2);
      const stressGain = runtime?.stressGain ?? 1;
      const windGain = clamp(Number(params?.windResponse ?? 1), 0, 2);
      const precip = clamp(Number(ctx.precip01) || 0, 0, 1);
      const life = { ...br.life };
      if (!br.rekindle) life.rekindleDelaySec = 1e9;

      const cx = (rect.minX + rect.maxX) * 0.5;
      const cy = (rect.minY + rect.maxY) * 0.5;
      const env = {
        tSec: timeSec,
        camX: cx,
        camY: cy,
        cameraHeight: 1000,
        parallax: br.parallax,
        tilt: br.tilt,
        projection: 'top',
        quality: clamp((ctx.quality ?? 1) * br.quality, 0.2, 1),
      };

      const fCap = renderer.flameCapacity;
      const sCap = renderer.smokeCapacity;
      let nf = 0;
      let ns = 0;
      let dropped = 0;
      let coalTotal = 0;
      const boxes = [];
      /** per box: how much of the bloom a flame this big on screen gets */
      const fills = [];
      const lifeByFire = new Map();
      const stepped = new Set();
      const margin = 24;

      for (const c of clusters) {
        const f = fires[c.fireIndex] ?? {};
        const fuel = f.fuel ?? params?.fuel ?? 'wood';
        const chain = fireScaleChain((f.diameterPx ?? c.radius * 2) * 1, mPerPx, { fuel, intensity: f.intensity });
        // the weather AT this fire
        const cell = canAsk ? windHandle.cpuAt(c.x, c.y) : null;
        const openness = clamp(Number.isFinite(cell?.openness) ? cell.openness : 1, 0, 1);
        const sky = clamp(
          Number.isFinite(cell?.sky) ? cell.sky : Number.isFinite(f.outdoors01) ? f.outdoors01 : 1,
          0,
          1
        );
        const outdoor01 = clamp(0.5 * sky + 0.5 * openness, 0, 1);
        const push = fireWindMotion01({
          windSpeed01,
          windExposure01: openness,
          windResponseGain: windGain,
          weatherResponse01: 1,
          snuffWind: chain.snuffWind,
        });
        const gated = fireWindMotion01({
          windSpeed01,
          windExposure01: openness,
          windResponseGain: windGain,
          weatherResponse01: weatherResponse,
          snuffWind: chain.snuffWind,
        });
        const rainHere = precip * sky * weatherResponse;
        const stress01 = fireWeatherStress01({
          windMotion01: gated,
          rain01: Math.min(1, rainHere * rainResponse),
          gain: stressGain,
        });

        // its life (once per fire, however many flames it is split into)
        let lf = lifeByFire.get(c.id);
        if (!lf) {
          if (!stepped.has(c.id)) {
            stepped.add(c.id);
            lives.step(c.id, dtSec, { rain01: rainHere, snuffable, rainResponse, seed: c.seed, timeSec }, life);
          }
          const s = lives.get(c.id);
          lf = { vitality: s.vitality, coal: s.coal, phase: s.phase, wet: s.wet };
          lifeByFire.set(c.id, lf);
        }

        // visible? (the life has been stepped either way, so a fire out of view still goes out in the rain)
        const reach = c.radius * 7 + margin;
        if (c.x + reach < rect.minX || c.x - reach > rect.maxX || c.y + reach < rect.minY || c.y - reach > rect.maxY)
          continue;
        const room = maxLobesPerFire(c.radius);
        if (nf + room > fCap || ns + room > sCap) {
          dropped++;
          continue;
        }

        const desc = {
          x: c.x,
          y: c.y,
          radius: c.radius,
          seed: c.seed,
          intensity: clamp((f.intensity ?? 1) * clamp(Number(params?.intensity ?? 1), 0, 2), 0, 2),
          outdoor01,
          turb01: chain.turb01,
          puffHz: chain.puffHz,
          flickerAmp: chain.flickerAmp,
          heightGain: br.heightGain,
          windX: wdir.x,
          windY: wdir.y,
          windMotion01: push,
          stress01,
          vitality01: lf.vitality,
          coal01: lf.coal,
          rain01: rainHere,
          smokeMul: br.smokeMul,
          spitMul: br.spitMul,
          draft: br.drafts,
          spawn: c.points,
          spawnCount: c.count,
          spawnStride: SPAWN_POINT_STRIDE,
        };
        const f0 = nf;
        const s0 = ns;
        const res = emitFireLobes(renderer.flameLobes, nf, desc, env, br.tune, renderer.smokeLobes, ns);
        nf += res.count;
        ns += res.smoke;
        coalTotal += res.coal;

        // the contour box: round every lobe this flame wrote
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const grow = (buf, from, to) => {
          for (let i = from; i < to; i++) {
            const o = i * LOBE_STRIDE;
            const r = buf[o + 2] * Math.max(buf[o + 5], buf[o + 10], 1);
            if (buf[o] - r < minX) minX = buf[o] - r;
            if (buf[o] + r > maxX) maxX = buf[o] + r;
            if (buf[o + 1] - r < minY) minY = buf[o + 1] - r;
            if (buf[o + 1] + r > maxY) maxY = buf[o + 1] + r;
          }
        };
        grow(renderer.flameLobes, f0, nf);
        grow(renderer.smokeLobes, s0, ns);
        if (maxX > minX) {
          boxes.push(minX - margin, minY - margin, maxX - minX + margin * 2, maxY - minY + margin * 2);
          fills.push(regionFill(c.radius * pxPerWorld));
        }
      }

      renderer.setCounts(nf, ns);
      // one more than the renderer holds is merged into the last box
      const maxBoxes = 64;
      let nBoxes = boxes.length / 4;
      if (nBoxes > maxBoxes) {
        const keep = boxes.slice(0, maxBoxes * 4);
        const keepFills = fills.slice(0, maxBoxes);
        for (let b = maxBoxes; b < nBoxes; b++) {
          keepFills[maxBoxes - 1] = Math.max(keepFills[maxBoxes - 1], fills[b]);
          const x0 = boxes[b * 4];
          const y0 = boxes[b * 4 + 1];
          const x1 = x0 + boxes[b * 4 + 2];
          const y1 = y0 + boxes[b * 4 + 3];
          const lx0 = keep[(maxBoxes - 1) * 4];
          const ly0 = keep[(maxBoxes - 1) * 4 + 1];
          const lx1 = lx0 + keep[(maxBoxes - 1) * 4 + 2];
          const ly1 = ly0 + keep[(maxBoxes - 1) * 4 + 3];
          keep[(maxBoxes - 1) * 4] = Math.min(x0, lx0);
          keep[(maxBoxes - 1) * 4 + 1] = Math.min(y0, ly0);
          keep[(maxBoxes - 1) * 4 + 2] = Math.max(x1, lx1) - keep[(maxBoxes - 1) * 4];
          keep[(maxBoxes - 1) * 4 + 3] = Math.max(y1, ly1) - keep[(maxBoxes - 1) * 4 + 1];
        }
        renderer.setQuads(keep, maxBoxes, keepFills);
        nBoxes = maxBoxes;
      } else {
        renderer.setQuads(boxes, nBoxes, fills);
      }
      renderer.setLook({ ...br.look, hue: br.hueShiftRad, tint: br.tint });
      renderer.uniforms.expectedDepth.value = Number.isFinite(ctx.expectedDepth) ? ctx.expectedDepth : 0;
      jobs = nf + ns > 0 ? renderer.prepareField(rect, { pxPerWorld, timeSec }) : [];
      renderer.scene.visible = nf + ns > 0;
      status = {
        fires: fires.length,
        clusters: clusters.length,
        flame: nf,
        smoke: ns,
        coal: coalTotal,
        dropped,
        boxes: nBoxes,
        bloomCounter: counter ? `K ${counter.K.toFixed(2)} thr ${counter.threshold} mix ${br.bloomMix}` : 'off',
      };
      return { lifeByFire, clusters };
    },

    /** The splat jobs `update` prepared; the viewer's `tickFireField` renders them. Empty when nothing is visible. */
    takeFieldJobs() {
      const j = jobs;
      jobs = [];
      return j;
    },
    getStatus: () => ({ ...status, lives: lives.size(), lifeSummary: lives.snapshot(12) }),
    dispose() {
      renderer.dispose();
    },
  };
}
