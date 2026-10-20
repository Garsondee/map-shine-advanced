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
const MAX_CLUSTERS_PER_FIRE = 96;
/** Flames of a split fire stand this close (in maxR) at their widest: close enough that neighbours overlap into one mass. */
const CLUSTER_SPACING = 0.95;
/** A burning mass's equivalent flame radius, as a fraction of its box's mean side (fitted to a single flame: 0.19). */
const MASS_FILL_PER_SIDE = 0.19;

/**
 * A big fire's flames stand taller: a burning roof is not a field of campfires. 1 for a single flame, rising with how much
 * wider the whole painted fire is than one flame can be (each doubling adds 40%), to at most 2x.
 *
 * @param {number} parentRadius the whole fire's radius (px) @param {number} maxRadius one flame's widest (px)
 */
export function infernoHeightGain(parentRadius, maxRadius) {
  const ratio = Math.max(1, (parentRadius || 0) / Math.max(1e-3, maxRadius || 1));
  return clamp(1 + 0.4 * Math.log2(ratio), 1, 2);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The virtual camera's height (world px) that the billows' perspective parallax uses, from the visible world rect.
 *
 * ⚠️ IT MUST RISE AS THE VIEW ZOOMS OUT. A real camera with a fixed field of view sits ~3 half-widths above what it sees; a
 * FIXED height (the first cut used 1000 px) made every flame far from the view centre lean radially outward by up to a
 * quarter of its distance from the centre when zoomed out to see a whole map: the real viewer showed a burning roof as a hail
 * of comets all streaking away from the middle of the screen. With the height tied to the view, a flame's lean outward is the
 * same small fraction of its height at every zoom.
 *
 * @param {{minX:number,maxX:number}} rect the visible world rect
 * @returns {number}
 */
export function viewCameraHeight(rect) {
  const halfW = Math.max(1, ((rect?.maxX ?? 0) - (rect?.minX ?? 0)) * 0.5);
  return Math.max(400, halfW * 3);
}

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
      out.push({
        fireIndex: j,
        id,
        x: f.x,
        y: f.y,
        radius: R,
        parentRadius: R,
        maxRadius: maxR,
        seed: baseSeed,
        points,
        count,
      });
      continue;
    }
    // a wide fire: greedy farthest-point sampling over its painted points -> centres about one maxR apart, so the flames
    // overlap into ONE burning mass (a roof of flames, not a tray of candles)
    const want = clamp(Math.ceil((R / maxR) * (R / maxR) * 1.8), 2, MAX_CLUSTERS_PER_FIRE);
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
      if (far < 0 || farD < maxR * CLUSTER_SPACING * (maxR * CLUSTER_SPACING)) break;
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
        radius: clamp(Math.max(spread * 0.9, maxR * 0.8), 6, maxR),
        parentRadius: R,
        maxRadius: maxR,
        seed: (baseSeed + Math.imul(c + 1, 0x9e3779b1)) | 0,
        points,
        count,
      });
    }
  }
  return out;
}

/**
 * Merge overlapping contour boxes into one box per burning mass.
 *
 * The contour pass reads the WHOLE field inside its box, so overlapping boxes would shade the same pixels twice (a doubled
 * edge) and a roof of 80 flames would cost 80 box-fulls of the heaviest shader in the effect. Boxes that overlap are joined
 * (union-find over the pairwise test: O(n^2) on at most `MAX_CLUSTERS_PER_FIRE` boxes, a few thousand comparisons) and a joined
 * group becomes its bounding box only if that box is not much emptier than the boxes it replaces: a diagonal row of separate
 * fires chains into one overlapping group whose bounding box is mostly empty, and is better left as the separate boxes it was.
 *
 * @param {number[]} boxes `[minX, minY, w, h]` per box
 * @param {number[]} fills one number per box (merged: the largest of the group)
 * @param {number} [maxWaste=1.7] the largest allowed (bounding box area) / (sum of the member boxes' areas)
 * @returns {{boxes:number[], fills:number[], members:number[]}} `members[i]` = how many boxes became box `i`
 */
export function mergeBoxes(boxes, fills, maxWaste = 1.7) {
  const n = Math.floor(boxes.length / 4);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let a = 0; a < n; a++) {
    const ax0 = boxes[a * 4];
    const ay0 = boxes[a * 4 + 1];
    const ax1 = ax0 + boxes[a * 4 + 2];
    const ay1 = ay0 + boxes[a * 4 + 3];
    for (let b = a + 1; b < n; b++) {
      const bx0 = boxes[b * 4];
      const by0 = boxes[b * 4 + 1];
      if (bx0 >= ax1 || by0 >= ay1 || bx0 + boxes[b * 4 + 2] <= ax0 || by0 + boxes[b * 4 + 3] <= ay0) continue;
      parent[find(b)] = find(a);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const outBoxes = [];
  const outFills = [];
  const members = [];
  for (const ids of groups.values()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let area = 0;
    let fill = 0;
    for (const i of ids) {
      x0 = Math.min(x0, boxes[i * 4]);
      y0 = Math.min(y0, boxes[i * 4 + 1]);
      x1 = Math.max(x1, boxes[i * 4] + boxes[i * 4 + 2]);
      y1 = Math.max(y1, boxes[i * 4 + 1] + boxes[i * 4 + 3]);
      area += boxes[i * 4 + 2] * boxes[i * 4 + 3];
      fill = Math.max(fill, fills[i] ?? 0);
    }
    if (ids.length === 1 || (x1 - x0) * (y1 - y0) <= maxWaste * area) {
      outBoxes.push(x0, y0, x1 - x0, y1 - y0);
      outFills.push(fill);
      members.push(ids.length);
    } else {
      // too empty to be one mass: keep the boxes it was
      for (const i of ids) {
        outBoxes.push(boxes[i * 4], boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3]);
        outFills.push(fills[i] ?? 0);
        members.push(1);
      }
    }
  }
  return { boxes: outBoxes, fills: outFills, members };
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
        cameraHeight: viewCameraHeight(rect),
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
      const inView = (c) => {
        const reach = c.radius * 7 + margin;
        return !(
          c.x + reach < rect.minX ||
          c.x - reach > rect.maxX ||
          c.y + reach < rect.minY ||
          c.y - reach > rect.maxY
        );
      };

      // THE LOBE BUDGET. What would every visible flame want at full quality? Past the buffer they ALL thin out together (a burning
      // roof of eighty flames is eighty simpler flames, not sixty flames and twenty holes).
      let need = 0;
      for (const c of clusters) if (inView(c)) need += maxLobesPerFire(c.radius, br.tune);
      const budgetQuality = need > fCap * 0.9 ? clamp((fCap * 0.9) / need, 0.3, 1) : 1;
      env.quality = clamp(env.quality * budgetQuality, 0.2, 1);

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
        if (!inView(c)) continue;
        const room = Math.ceil(maxLobesPerFire(c.radius, br.tune) * clamp(env.quality, 0.35, 1));
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
          heightGain: br.heightGain * infernoHeightGain(c.parentRadius, c.maxRadius),
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
      // ONE contour box per burning mass: flames whose boxes overlap are drawn as one (the contour reads the whole field, so
      // overlapping boxes would shade the same pixels twice). A mass covers more of the screen, so the bloom fills it more.
      const merged = mergeBoxes(boxes, fills);
      const mBoxes = merged.boxes;
      const mFills = merged.fills;
      for (let i = 0; i < mFills.length; i++) {
        if (merged.members[i] > 1) {
          const meanSide = 0.5 * (mBoxes[i * 4 + 2] + mBoxes[i * 4 + 3]);
          mFills[i] = Math.max(mFills[i], regionFill(MASS_FILL_PER_SIDE * meanSide * pxPerWorld));
        }
      }
      // (past what the renderer holds, the extras are folded into the last box)
      const maxBoxes = 64;
      let nBoxes = mBoxes.length / 4;
      if (nBoxes > maxBoxes) {
        const keep = mBoxes.slice(0, maxBoxes * 4);
        const keepFills = mFills.slice(0, maxBoxes);
        for (let b = maxBoxes; b < nBoxes; b++) {
          keepFills[maxBoxes - 1] = Math.max(keepFills[maxBoxes - 1], mFills[b]);
          const x0 = mBoxes[b * 4];
          const y0 = mBoxes[b * 4 + 1];
          const x1 = x0 + mBoxes[b * 4 + 2];
          const y1 = y0 + mBoxes[b * 4 + 3];
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
        renderer.setQuads(mBoxes, nBoxes, mFills);
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
        quality: +env.quality.toFixed(3),
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
