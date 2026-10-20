/**
 * FIRE — THE LIFECYCLE. Owns the billow engine (flame, coals, smoke, spit embers, and the fire's long life), the
 * spiralling-ember engine, the spawn cloud they share, and the light descriptors the viewer's existing point-light
 * pool merges.
 *
 * THREE is INJECTED and `vt/` is never imported — deps arrive as closures, the same shape `lightning-subsystem.js`
 * and `fluid-surface-subsystem.js` take.
 *
 * ============================================================================
 * WHAT THIS WAS, AND WHY IT IS NOT THAT ANY MORE (2026-10-20)
 * ============================================================================
 *
 * Until 2026-10-20 the flame and the smoke were two GPU particle engines (four soft bird's-eye sprite archetypes,
 * additive; grey soft sprites for smoke). Author, after living with it: "the vast majority of this effect doesn't
 * really feel like fire". The painted campfires on the author's own maps are the standard, and they are lobed, nested,
 * cel-shaded billows — not glow. So the flame is now a PLUME OF BILLOWS splatted into a density field and contoured
 * (`fire-billow-*.js`): the billows are closed-form functions of the clock (so nothing is integrated and nothing can be
 * flung away), the contour makes them one painted body, the coal bed glows through cracked cells, the smoke is soft
 * warm-white billows lit by the scene, heavy embers spit out and smoulder where they land, and each fire has a long
 * life — rain puts it out, the coals cool, the ash goes cold, and after a long dry spell it comes back.
 *
 * What did NOT change: the spiralling embers (the author's favourite: "really good upwards spiralling embers") are the
 * same GPU engine as before, fed the same way, except that a fire that is out sends none; the light is the same pool
 * entry, now following the flames' real life; the spawn cloud, the wind grid, the weather numbers.
 *
 * ⚠️ THE SPLAT IS NOT DRAWN HERE. `sync()` prepares the billows and a declarative job list (`takeFieldJobs()`), and
 * `vt-pan-viewer.js`'s `tickFireField` renders them into the field targets — `renderer-state/graph-only` walls
 * `setRenderTarget` to `vt/`, and `gpu/allocator-only` walls target allocation (`createTarget` is injected).
 *
 * @module effects/fire/fire-subsystem
 */
import {
  fireScaleChain,
  fireRuntimeFromParams,
  buildFireLightSources,
  createFireBrightnessSmoother,
  fireTierPlan,
  FIRE_DEFAULT_TIER,
} from './fire-geometry.js';
import { applyCohesion, dropIndoorSpawnPoints, SPAWN_POINT_STRIDE } from './fire-spawn-points.js';
import { createBillowEngine } from './fire-billow-engine.js';

/**
 * Map-wide capacity of the spiralling-ember engine (the one GPU particle engine left).
 *
 * ⚠️ DELIBERATELY SMALL. V2 ran ~95 embers per FLOOR; the budget is shared by every fire on the map.
 */
const EMBER_CAPACITY = 48;

/**
 * The world size V2's absolute sprite sizes implicitly assume. The ember engine still scales to the fire's own measured
 * diameter, exactly as before (a 42-55 px hearth must not get 150-195 px sprites); see `fire-particle-runtime.js`.
 */
const SPRITE_REFERENCE_DIAMETER_PX = 100;

/** Embers alive PER FIRE, which is the number that actually controls density (the budget above is map-wide). */
const PER_FIRE = Object.freeze({ ember: 10 });

/**
 * "Nothing painted on this floor" as a real, stable spawn-cloud value — see the spawn-sync block's own note in
 * `syncUnguarded` for why a null cloud must be pushed to every engine like any other change, not treated as nothing to
 * do. Signature `0` deliberately matches what `fireSpawnSignature`/`fireMaskSignature` already return for "no grid".
 */
const EMPTY_SPAWN_CLOUD = Object.freeze({ points: new Float32Array(0), count: 0, paintedTexels: 0, signature: 0 });

/**
 * The cohesion cache-staleness gap this closes: cohesion pulls every spawn point toward its NEAREST entry in `fires`
 * (`applyCohesion`), but the cache that decides WHETHER to re-run that pull only ever watched the SPAWN CLOUD's own
 * signature and the cohesion VALUE. `fires` — built by a different extraction over the same grid — was never part of the
 * invalidation. Mixing its content in means it can never fall behind `cloud` again. Indoor/outdoor flips decide which
 * points the ember engine keeps (`dropIndoorSpawnPoints`), so they re-push the cloud too — and so does a fire going OUT
 * (a put-out fire sends no sparks): the caller marks such a fire `outdoors01: 0` before asking.
 * @param {Array<{x:number,y:number}>} fires
 */
function fireListSignature(fires) {
  let hash = 2166136261 >>> 0;
  const mix = (v) => {
    hash ^= v | 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  mix(fires.length);
  for (const f of fires) {
    mix(Math.round(Number(f?.x) || 0));
    mix(Math.round(Number(f?.y) || 0));
    mix(Number.isFinite(f?.outdoors01) && f.outdoors01 < 0.5 ? 1 : 0);
  }
  return hash;
}

/**
 * How many spawn points stand in for each fire when its light is evaluated. The light is the MEAN of the flames'
 * brightness over these, so more points only smooth the answer across a fire that straddles a wall; 24 is plenty.
 */
const LIGHT_SAMPLES_PER_FIRE = 24;

/**
 * THE SPAWN POINTS OF EACH FIRE, WITH THE WIND GRID'S ANSWER AT EACH (2026-10-20, mmp-26u) — the CPU's stand-in for
 * "where the flame is born". The flame is built round these points, so the fire's light is evaluated over the same
 * places with the same two cell values (`windHandle.cpuAt` is the CPU twin of the grid lookup). Each point goes to its
 * nearest fire.
 *
 * Fires without an id get no entry (the light falls back to the fire's anchor). With no bake, openness and sky are 1:
 * the same "open sky, no wall" answer the GPU gives.
 *
 * @param {{points?: Float32Array, count?: number}|null} cloud
 * @param {Array<{id?:string,x:number,y:number}>} fires
 * @param {object|null} windHandle
 * @returns {Map<string, Array<{x:number,y:number,openness:number,sky:number}>>}
 */
function buildFireLightSamples(cloud, fires, windHandle) {
  const out = new Map();
  const n = cloud?.count ?? 0;
  const pts = cloud?.points;
  if (!(n > 0) || !pts || fires.length === 0) return out;
  const stride = SPAWN_POINT_STRIDE;
  const owned = fires.map(() => []);
  for (let i = 0; i < n; i++) {
    const x = pts[i * stride];
    const y = pts[i * stride + 1];
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < fires.length; j++) {
      const dx = x - fires[j].x;
      const dy = y - fires[j].y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best >= 0) owned[best].push(i);
  }
  const canAsk = windHandle?.hasBake && typeof windHandle.cpuAt === 'function';
  for (let j = 0; j < fires.length; j++) {
    const id = fires[j]?.id;
    const mine = owned[j];
    if (!id || mine.length === 0) continue;
    const take = Math.min(LIGHT_SAMPLES_PER_FIRE, mine.length);
    const step = mine.length / take;
    const samples = [];
    for (let k = 0; k < take; k++) {
      const i = mine[Math.floor(k * step)];
      const x = pts[i * stride];
      const y = pts[i * stride + 1];
      const cell = canAsk ? windHandle.cpuAt(x, y) : null;
      samples.push({
        x,
        y,
        openness: Number.isFinite(cell?.openness) ? cell.openness : 1,
        sky: Number.isFinite(cell?.sky) ? cell.sky : 1,
      });
    }
    out.set(String(id), samples);
  }
  return out;
}

/**
 * @param {object} deps
 * @param {*} deps.THREE - injected.
 * @param {() => object} deps.getFireRenderState - `{enabled, params, perfTier, fires[], spawnCloud, fireLabelGrid, mPerPx}`.
 *   ⚠️ REQUIRED, deliberately NOT defaulted — `feedback_seam_default_hides_unwired`: water shipped its render-state seam
 *   declared, defaulted and never passed, and the ONLY symptom was that every control silently did nothing while all
 *   4,137 tests passed. A missing seam here throws at construction instead.
 * @param {() => object} [deps.getWindHandle] - getter, not the handle: the viewer's binding is reassigned on every rebake
 *   and this is constructed before its first assignment (the same TDZ-safe pattern the light pool uses).
 * @param {() => number} [deps.getPxPerMeter]
 * @param {() => number} [deps.getPrecip01] - getter for the scene's EASED precipitation (0..1, the live weather axis the
 *   rain itself is drawn from). Rain douses an open-sky fire; omitted reads as dry.
 * @param {(engine: object) => void} [deps.createEngine] - the injected ember-engine factory (`createFireParticleEngine`).
 *   Injected rather than imported because `particles/allocator-only` keeps every `instancedArray` under
 *   `effects/particles/`, and this module has no business reaching for one.
 * @param {() => ({enabled?:boolean, params?:object}|null)} [deps.getBloomState] - the scene's live bloom
 *   (`getBloomRenderState()`). The flame paints the inverse of what that bloom will add back to it (fire-billow-bloom.js),
 *   so its painted colours survive; omitted reads as no bloom.
 * @param {(name:string, w:number, h:number) => *} [deps.createTarget] - the allocator, for the billow field targets
 *   (`gpu/allocator-only`). Omitted = no billow flame (only the embers and the light).
 * @param {(rt:*) => void} [deps.disposeTarget]
 * @param {(cfg:object) => object} [deps.createBillow] - the billow engine factory; injected so the orchestration can be
 *   tested without a GPU (the default is `createBillowEngine`).
 * @param {{illumTexNode?:*, colorationTexNode?:*}} [deps.lighting] - the scene's own light, which lights the smoke.
 * @param {*} [deps.profiler] - so `sync()` can bracket its own per-frame cost (`light.fireSync`).
 * @param {*} [deps.depthTexNode] - `buf:scene.depth`'s DEPTH attachment — the depth-authority occlusion gate every
 *   post-lit draw uses (mythica-machina-press#469). Omitted → the gates compile out.
 * @param {*} [deps.depthFlagsTexNode] - `buf:scene.depth`'s COLOUR attachment (the Tile "Restrict Lighting" flag).
 * @param {(elevation: number) => number} [deps.resolveExpectedDepth] - turns a raw world elevation into the tie-safe value
 *   the gate compares. Called ONCE per sync against a REPRESENTATIVE fire's elevation, not per billow.
 * @returns {{scene:*, sync:Function, takeFieldJobs:Function, lightSources:()=>Array<object>,
 *   hasContent:boolean, getStatus:()=>object, dispose:()=>void}}
 */
export function createFireSubsystem({
  THREE,
  getFireRenderState,
  getWindHandle = null,
  getPxPerMeter = null,
  getPrecip01 = null,
  getBloomState = null,
  createEngine = null,
  createTarget = null,
  disposeTarget = null,
  createBillow = createBillowEngine,
  lighting = null,
  profiler = null,
  depthTexNode = null,
  depthFlagsTexNode = null,
  resolveExpectedDepth = null,
}) {
  if (typeof getFireRenderState !== 'function') {
    throw new TypeError(
      'createFireSubsystem: `getFireRenderState` is required. A defaulted render-state seam is how ' +
        'water shipped every control inert with a green test suite (feedback_seam_default_hides_unwired).'
    );
  }

  const scene = new THREE.Scene();
  /** The spiralling-ember engine(s) — the particle engines left after the billow rebuild. @type {Array<{engine: object, kind: string}>} */
  const engines = [];
  /** The billow engine: flame, coals, smoke, spit embers, and the long life of each fire. */
  let billow = null;
  let currentLights = [];
  let hasContent = false;
  let lastSpawnSignature = null;
  /** Last `fireListSignature(fires)` the ember cloud cache was computed against. */
  let lastFiresSignature = null;
  /**
   * Last cohesion amount applied PER ENGINE — keyed by the engine object itself, NOT by `kind` (`kind` is not a unique
   * engine id; a `Map` keyed by the engine reference cannot collide however many engines share a `kind`).
   */
  const lastCohesionByEngine = new Map();
  let lastStatus = { engines: 0, fires: 0, lights: 0, spawnPoints: 0 };

  /** Light smoothing (`createFireBrightnessSmoother`): each fire light eases to the flames' brightness, never snaps. */
  const brightnessSmoother = createFireBrightnessSmoother();
  /** `buildFireLightSamples` result, kept until the cloud, the fire list or the wind bake changes. */
  let lightSampleMemo = { cloud: null, fires: null, version: -2, result: new Map() };
  /** Reused scratch for `renderer.getDrawingBufferSize` (allocated on first use). */
  let drawingBufferSize = null;

  /**
   * EACH FIRE'S WIND EXPOSURE, FROM THE WIND BAKE'S GEOMETRY (2026-10-07). `fires[].windExposure` arrives from `boot.js`
   * as a sample of the painted `_Outdoors` mask — a different answer to a different question ("is there a roof"), and
   * one the wind has not consulted since the 2026-07-22 rethink: "geometry decides where wind is, not paint". Replaced
   * with the bake's own openness at the fire's position (`windHandle.cpuAt`). `outdoors01` is left alone: it answers the
   * roof question (`fireIndoorParticleResponse`), which genuinely is the mask's.
   *
   * Memoised on the input array and the handle's version, so this allocates only when something moved. With no bake yet
   * the list is returned untouched — the painted-mask value stays as the fallback, never a silent "fully sealed".
   */
  let exposureMemo = { source: null, version: -1, result: null };
  function firesWithGeometricWindExposure(list, windHandle) {
    if (!windHandle?.hasBake || list.length === 0) return list;
    if (exposureMemo.source === list && exposureMemo.version === windHandle.version) return exposureMemo.result;
    const result = list.map((f) => ({ ...f, windExposure: windHandle.cpuAt(f.x, f.y).openness }));
    exposureMemo = { source: list, version: windHandle.version, result };
    return result;
  }

  /** Built lazily on the first sync that has something to burn, because a build-time input (the wind handle) only becomes real later. */
  function ensureEngines() {
    const windHandle = getWindHandle?.() ?? null;
    if (!billow && typeof createTarget === 'function') {
      billow = createBillow({
        THREE,
        createTarget,
        disposeTarget,
        getWindHandle,
        lighting,
        depthTexNode,
        depthFlagsTexNode,
      });
      scene.add(billow.scene);
    }
    if (engines.length || typeof createEngine !== 'function') return;
    const pxPerMeter = getPxPerMeter?.() ?? 100;
    const worldRect = { minX: 0, minY: 0, maxX: 1, maxY: 1 }; // real rect arrives per frame
    // The embers draw additive OVER the billow contour (renderOrder 1 vs the contour's 0).
    const engine = createEngine({
      THREE,
      kind: 'ember',
      archetype: null,
      system: { id: 'fire.ember', params: { capacity: EMBER_CAPACITY } },
      worldRect,
      renderOrder: 1,
      windHandle,
      pxPerMeter,
      depthTexNode,
      depthFlagsTexNode,
    });
    engines.push({ engine, kind: 'ember' });
    scene.add(engine.scene);
  }

  /**
   * One frame. Steps every fire's life, writes its billows, prepares the splat jobs, steps the ember kernel and refreshes
   * the lights.
   *
   * @param {*} renderer - REQUIRED; `renderer.compute()` has no other source.
   * @param {number} nowMs @param {number} dtSec
   * @param {object} [worldRect] - the visible rect.
   */
  function sync(renderer, nowMs, dtSec, worldRect) {
    profiler?.beginById('light.fireSync');
    try {
      syncUnguarded(renderer, nowMs, dtSec, worldRect);
    } finally {
      profiler?.endById('light.fireSync');
    }
  }

  /** A put-out fire (its flame is gone) is marked "indoors" for the ember engine's sake: its points are dropped, so it sends no sparks. */
  function firesMarkedForEmbers(fires, lifeByFire) {
    if (!lifeByFire || lifeByFire.size === 0) return fires;
    let any = false;
    const marked = fires.map((f) => {
      const lf = f?.id ? lifeByFire.get(String(f.id)) : null;
      if (lf && lf.vitality < 0.12) {
        any = true;
        return { ...f, outdoors01: 0 };
      }
      return f;
    });
    return any ? marked : fires;
  }

  /**
   * The real body of `sync()` — see `window-surface-subsystem.js#sync`'s identical split for why: a try/finally around the
   * whole function would force re-indenting every line, and a thrown error must still close the bracket regardless of
   * which of this function's several early returns would otherwise have skipped that.
   */
  function syncUnguarded(renderer, nowMs, dtSec, worldRect) {
    const state = getFireRenderState() ?? {};
    const windHandle = getWindHandle?.() ?? null;
    const fires = firesWithGeometricWindExposure(Array.isArray(state.fires) ? state.fires : [], windHandle);
    const cloud = state.spawnCloud ?? null;
    const hasPaint = (cloud?.count ?? 0) > 0;
    const labelGrid = state.fireLabelGrid ?? null;

    if (!state.enabled || !renderer || (!hasPaint && fires.length === 0)) {
      for (const { engine } of engines) engine.scene.visible = false;
      if (billow) billow.scene.visible = false;
      currentLights = [];
      // No lights this frame: forget every smoothed brightness, so a fire that comes back starts fresh.
      brightnessSmoother.begin(0);
      brightnessSmoother.end();
      hasContent = false;
      lastStatus = { engines: engines.length, fires: fires.length, lights: 0, spawnPoints: 0 };
      return;
    }

    ensureEngines();
    if (!engines.length && !billow) return;

    const params = state.params ?? {};
    const tier = Number.isFinite(state.perfTier) ? state.perfTier : FIRE_DEFAULT_TIER;
    const firePlan = fireTierPlan(tier);
    const mPerPx = Number.isFinite(state.mPerPx) && state.mPerPx > 0 ? state.mPerPx : 0.02;
    // The wind signal's own input: read straight off the SAME live uniform node the engines sample every frame
    // (`windHandle.ambient.speed01`), so the CPU numbers can never drift a frame behind the GPU-side push.
    const windSpeed01 = windHandle?.ambient?.speed01?.value;
    // RAIN: the scene's eased precipitation, read live like the wind speed above. The sky gate (does rain reach THIS
    // fire?) is per fire, from the wind grid's own sky channel, inside the billow engine.
    const precip01 = Math.max(0, Math.min(1, Number(getPrecip01?.()) || 0));
    // ⚠️ MAX ACROSS FIRES, DELIBERATELY, STILL HOLDS FOR `outdoor01` (2026-09-07): the ember engine's indoor suppression
    // answers "is there a ROOF over this fire" for a map-wide engine; taking the maximum biases a mixed floor toward
    // LESS suppression, the lesser evil (see `dropIndoorSpawnPoints`, which now does the per-fire part).
    const outdoor01 = fires.length
      ? fires.reduce((max, f) => Math.max(max, Number.isFinite(f?.outdoors01) ? f.outdoors01 : 1), 0)
      : 1;
    // ⚠️ `{ fuel: params?.fuel }` — without it `fireScaleChain` defaults to 'wood' regardless of the author's "Fuel".
    const runtime = fireRuntimeFromParams(
      params,
      fireScaleChain(fires[0]?.diameterPx ?? 100, mPerPx, { fuel: params?.fuel }),
      { speed01: windSpeed01, outdoor01, precip01 }
    );

    // THE DEPTH-AUTHORITY OCCLUSION GATE'S INPUT (mythica-machina-press#469) — ONE value per sync, from a representative
    // fire (a floor's fires overwhelmingly share one ground elevation), not per billow.
    const expectedDepth =
      typeof resolveExpectedDepth === 'function' ? resolveExpectedDepth(fires[0]?.elevation ?? 0) : 0;

    const effectiveCloud = cloud ?? EMPTY_SPAWN_CLOUD;
    const rect =
      worldRect ??
      (() => {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const f of fires) {
          const r = (f.diameterPx ?? 100) * 4;
          minX = Math.min(minX, f.x - r);
          maxX = Math.max(maxX, f.x + r);
          minY = Math.min(minY, f.y - r);
          maxY = Math.max(maxY, f.y + r);
        }
        return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      })();

    // THE BILLOW FLAME: weather at each fire, its life, its billows, the contour boxes, the splat jobs.
    let lifeByFire = null;
    if (billow) {
      // The field's resolution follows the drawing buffer's pixel density over the visible rect. (A renderer without
      // `getDrawingBufferSize`, or a THREE without `Vector2`, simply leaves it at 1 world px per pixel.)
      let pxPerWorld = 1;
      if (typeof renderer.getDrawingBufferSize === 'function' && typeof THREE.Vector2 === 'function') {
        drawingBufferSize ??= new THREE.Vector2();
        const size = renderer.getDrawingBufferSize(drawingBufferSize);
        const w = rect.maxX - rect.minX;
        if (size && w > 0 && Number.isFinite(size.x)) pxPerWorld = size.x / w;
      }
      const res = billow.update({
        nowMs,
        dtSec,
        rect,
        fires,
        cloud: effectiveCloud,
        labelGrid,
        params,
        runtime,
        precip01,
        pxPerWorld,
        bloom: getBloomState?.() ?? null,
        mPerPx,
        quality: firePlan.spriteCountScale,
        expectedDepth,
      });
      lifeByFire = res.lifeByFire;
    }

    // THE EMBER ENGINE's cloud is pushed only when it needs to change — a full buffer upload and a re-seed, not a
    // per-frame write. Two independent things force that: the paint (or which fires are alive) changing, or the
    // COHESION pull changing (`applyCohesion`, CPU-side).
    //
    // ⚠️ A NULL CLOUD MUST STILL BE PUSHED, NOT SKIPPED: a floor with fire ANCHORS but no painted `_Fire` region left every
    // engine holding a PREVIOUS floor's cloud after a floor switch that lost its paint. `EMPTY_SPAWN_CLOUD` gives
    // "nothing painted here" its own stable signature, so that state is pushed and tracked exactly like any other change.
    //
    // ⚠️ EMBERS SPAWN ONLY FROM OUTDOOR FIRES THAT ARE BURNING (2026-10-16 indoor rule; 2026-10-20 a put-out fire sends
    // none): such a fire's points are removed from the ember engine's cloud (`dropIndoorSpawnPoints`).
    const emberFires = firesMarkedForEmbers(fires, lifeByFire);
    const firesSignature = fireListSignature(emberFires);
    const cloudChanged = effectiveCloud.signature !== lastSpawnSignature || firesSignature !== lastFiresSignature;
    let emberCloud = null;
    for (const { engine, kind } of engines) {
      const cohesion = runtime.perKind?.[kind]?.cohesion ?? 0;
      if (cloudChanged || lastCohesionByEngine.get(engine) !== cohesion) {
        if (!emberCloud) emberCloud = dropIndoorSpawnPoints(effectiveCloud, emberFires, labelGrid);
        engine.setSpawnPoints(
          cloud && cohesion ? applyCohesion(emberCloud, emberFires, cohesion, labelGrid) : emberCloud
        );
        lastCohesionByEngine.set(engine, cohesion);
      }
    }
    lastSpawnSignature = effectiveCloud.signature;
    lastFiresSignature = firesSignature;

    // Embers scale to the fire they belong to (the MEDIAN diameter: one bonfire in a room of hearths should not inflate
    // every sprite on the map).
    const diameters = fires.map((f) => Number(f?.diameterPx)).filter((d) => Number.isFinite(d) && d > 0);
    const medianDiameter = diameters.length
      ? diameters.sort((a, b) => a - b)[Math.floor(diameters.length / 2)]
      : SPRITE_REFERENCE_DIAMETER_PX;
    const spriteScale = Math.max(0.3, Math.min(2.5, medianDiameter / SPRITE_REFERENCE_DIAMETER_PX));
    const fireCount = Math.max(1, fires.length);

    for (const { engine, kind } of engines) {
      engine.scene.visible = true;
      const tune = runtime.perKind?.[kind] ?? {};
      engine.setParams({
        ...tune,
        // ⚠️ `fireIntensity`, NOT `intensity` (`runtime.intensity` is the retired volumetric material's uniform).
        intensity: runtime.fireIntensity,
        cameraHeight: runtime.cameraHeight,
        motionSpeed: runtime.motionSpeed,
        windMotion01: runtime.windMotion01,
        windPushMotion01: runtime.windPushMotion01,
        // WEATHER STRESS (2026-10-19): rain reaching an open-sky fire and how much of the stress this fire feels.
        rain01: runtime.rain01,
        stressGain: runtime.stressGain,
        expectedDepth,
        hueShiftRad: runtime.hueShiftRad,
        posterizeAmount: runtime.posterize,
        bandCount: runtime.bands,
        tintMul: runtime.flameColorTintMul,
        sizeScale: (tune.sizeScale ?? 1) * spriteScale,
        // The control is PER FIRE; the engine budget is map-wide, so it scales by how many fires share it (and is
        // clamped to the arena inside `setParams`). `firePlan.spriteCountScale` is the tier's budget lever.
        activeCount: Math.max(
          0,
          (tune.activeCount ?? PER_FIRE[kind]) * Math.max(1, fireCount) * firePlan.spriteCountScale
        ),
      });
      engine.step(renderer, { dtSec, tMs: nowMs, worldRect });
    }

    // THE LIGHT IS THE FLAMES' OWN BRIGHTNESS (2026-10-20, mmp-26u), now scaled by each fire's LIFE: a fire the rain has
    // put out casts no flame light and its coals a faint glow, a fire coughing back to life brightens as its flame does.
    const bakeVersion = windHandle?.version ?? -1;
    if (
      lightSampleMemo.cloud !== effectiveCloud ||
      lightSampleMemo.fires !== fires ||
      lightSampleMemo.version !== bakeVersion
    ) {
      lightSampleMemo = {
        cloud: effectiveCloud,
        fires,
        version: bakeVersion,
        result: buildFireLightSamples(effectiveCloud, fires, windHandle),
      };
    }
    brightnessSmoother.begin(dtSec);
    currentLights = runtime.lightEnabled
      ? buildFireLightSources(fires, {
          tier,
          mPerPx,
          colorHex: runtime.lightColor,
          radiusScale: runtime.lightRadiusScale,
          weather: { windMotion01: runtime.windMotion01, rain01: runtime.rain01, stressGain: runtime.stressGain },
          samplesByFire: lightSampleMemo.result,
          gutterTimeSec: nowMs * 0.001 * runtime.motionSpeed,
          smoothBrightness: brightnessSmoother.smooth,
          lifeByFire,
        })
      : [];
    brightnessSmoother.end();

    hasContent = true;
    lastStatus = {
      engines: engines.length,
      fires: fires.length,
      lights: currentLights.length,
      spawnPoints: cloud?.count ?? 0,
      billow: billow ? billow.getStatus() : null,
    };
  }

  return {
    scene,
    sync,
    /**
     * The field splat jobs `sync` prepared this frame — `[{name, target, scene, camera, count}]`. The viewer renders them
     * (`tickFireField`) right after `sync()`, before any pass binds a target. Empty when nothing is visible.
     */
    takeFieldJobs: () => billow?.takeFieldJobs() ?? [],
    /** Merged by the viewer's point-light pool exactly like a Foundry light. */
    lightSources: () => currentLights,
    get hasContent() {
      return hasContent;
    },
    getStatus: () => ({
      ...lastStatus,
      perEngine: engines.map(({ engine }) => engine.debugState()),
      billow: billow ? billow.getStatus() : null,
    }),
    /**
     * Fan a rebake out to every engine's own `updateWind`. The ember engine holds its own wind-cell storage buffer (real
     * per-particle openness), so a wall/door edit after construction would otherwise leave that buffer's CONTENTS frozen at
     * whatever the first bake produced. (The billow engine asks the handle on the CPU each frame, so needs nothing.)
     * @param {object|null} nextHandle
     */
    updateWind(nextHandle) {
      for (const { engine } of engines) engine.updateWind?.(nextHandle);
    },
    /** The fires' lives, for the lab, the debug panel and tests (`{phase, wet, vitality, coal}` by fire id). */
    getLives: () => billow?.lives ?? null,
    dispose() {
      // ⚠️ There is no ember-engine dispose path — `ParticleArena` allocates once and never frees. Dropping the scene
      // reference is all this can honestly do; the billow engine releases its targets.
      for (const { engine } of engines) scene.remove(engine.scene);
      engines.length = 0;
      if (billow) {
        scene.remove(billow.scene);
        billow.dispose();
        billow = null;
      }
      currentLights = [];
      hasContent = false;
    },
  };
}
