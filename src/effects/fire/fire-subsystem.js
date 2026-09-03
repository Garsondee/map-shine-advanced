/**
 * FIRE — THE LIFECYCLE. Owns the three particle engines (flame, ember, smoke),
 * the spawn cloud they share, and the light descriptors the viewer's existing
 * point-light pool merges.
 *
 * THREE is INJECTED and `vt/` is never imported — deps arrive as closures, the
 * same shape `lightning-subsystem.js` and `fluid-surface-subsystem.js` take.
 *
 * ============================================================================
 * WHAT THIS USED TO BE, AND WHY IT IS NOT THAT ANY MORE
 * ============================================================================
 *
 * Until 2026-08-09 this owned a VOLUMETRIC slab-integral material: a per-size-
 * class cache of compiled shaders, a coverage rung with hysteresis, and a
 * batched quad per class. All of it worked, all of it was tested, and after five
 * rounds of live feedback it could not stop looking like a circle — because its
 * silhouette was a radial distance field perturbed by noise, which *is* a
 * circle. Author: *"It's a circle, why is it a circle?"*
 *
 * The rebuild follows V2's actual architecture (memory:
 * `reference_v2_fire_look_autopsy`): sparse, huge, mostly-STATIONARY sprites
 * whose shapes are authored bird's-eye archetypes, not derived from physics.
 * The size-class cache, the coverage rung and the slab plan are all gone with
 * the material they served.
 *
 * ⚠️ `sync()` NOW TAKES THE RENDERER, because a compute kernel cannot be
 * dispatched without one. That is the only change to this module's contract
 * with the viewer — the scene it hands back is still drawn by the same guarded
 * additive call, unchanged.
 *
 * @module effects/fire/fire-subsystem
 */
import {
  fireScaleChain,
  fireRuntimeFromParams,
  buildFireLightSources,
  fireTierPlan,
  FIRE_DEFAULT_TIER,
} from './fire-geometry.js';
import { FLAME_ARCHETYPES } from './fire-sprite.js';
import { applyCohesion } from './fire-spawn-points.js';

/**
 * Map-wide particle budgets, split across every fire on the map.
 *
 * ⚠️ THESE ARE DELIBERATELY SMALL, AND RAISING THEM MAKES THE FIRE WORSE.
 * V2 ran ~285 particles per FLOOR (51 flame / 95 ember / 139 smoke) with sprites
 * 150-195 world units across — about one grid square each. The look is SPARSE
 * and HUGE.
 *
 * ⚠️ THE FIRST LIVE RUN SHIPPED 128/256/256 AND PROVED THE AUTOPSY'S WARNING
 * EXACTLY. Author, 2026-08-09: *"the flames are all dots which are wobbling
 * around, they all have the same shape."* Both halves of that were this table:
 *   • The "dots, all the same shape" were the EMBERS — 7-26 px soft radial dots
 *     with no archetype and the only layer that fully moves. At 256 of them on
 *     one hearth they were the loudest thing on screen, so they read as *the
 *     fire* while the actual flames were invisible behind them.
 *   • The flames were not missing, they were WASHED OUT: 128 sprites of 150-195
 *     units stacked on a ~50 px painted region cannot show an individual
 *     silhouette — they sum to the "solid glowing blob" the autopsy names in so
 *     many words. Five times V2's whole-floor density on a single fire.
 * Cut back toward V2's real numbers. Smoke is left near its old count because
 * the author called it out as the part that already works.
 */
const FLAME_CAPACITY = 224;
const EMBER_CAPACITY = 48;
const SMOKE_CAPACITY = 192;

/**
 * The world size V2's absolute sprite sizes implicitly assume.
 *
 * ⚠️ V2's SPRITE SIZES ARE ABSOLUTE AND THE AUTHOR'S FIRES ARE SMALL. A flame
 * sprite is 150-195 world units no matter what it was spawned from, while a real
 * painted hearth on this map measures 42-55 px across — so every sprite is
 * three to four times the whole fire, and a stack of them is a featureless
 * wash with no relationship to the thing that is burning. Scaling the sprite to
 * the fire's own measured diameter is what lets a small hearth read as a small
 * fire instead of a big smudge, and it costs nothing: `extractFiresFromMask`
 * already measures every region's width for the light radius.
 */
const SPRITE_REFERENCE_DIAMETER_PX = 100;

/**
 * Particles alive PER FIRE, which is the number that actually controls density.
 *
 * ⚠️ FLAME RAISED 3 → 12 PER ARCHETYPE (so 48 per fire across the four).
 * Author, 2026-08-09: *"very dispersed, very few of them."* The previous 3 was
 * an overcorrection from the opposite failure two rounds earlier, where 128
 * flames on one hearth washed into a featureless blob — but that blob was
 * caused by per-sprite BRIGHTNESS summing, not by count, and it was fixed at
 * the brightness end. With emission now sized so a stack stays coloured, the
 * count can go back up to something that actually reads as a body of fire.
 *
 * ⚠️ CAPACITY IS MAP-WIDE; THIS IS NOT. The capacities above are a constant
 * ceiling for the whole map (that is the performance argument for this design),
 * but spending all of it on a scene with one hearth is what produced the
 * author's *"flames are all dots"*. V2's ~285 per floor were divided among every
 * fire on that floor, so the per-fire figure — not the total — is the one to
 * match. These are that division, rounded to what a single hearth should show.
 */
const PER_FIRE = Object.freeze({ flame: 12, ember: 10, smoke: 24 });

/**
 * "Nothing painted on this floor" as a real, stable spawn-cloud value — see
 * the spawn-sync block's own note in `syncUnguarded` for why a null cloud
 * must be pushed to every engine like any other change, not treated as
 * nothing to do. Signature `0` deliberately matches what
 * `fireSpawnSignature`/`fireMaskSignature` (fire-mask.js/fire-spawn-points.js)
 * already return for "no grid", so this is the existing "no paint" fact, not
 * a second one invented here.
 */
const EMPTY_SPAWN_CLOUD = Object.freeze({ points: new Float32Array(0), count: 0, paintedTexels: 0, signature: 0 });

/**
 * ⚠️ THE COHESION CACHE-STALENESS GAP THIS CLOSES. Cohesion pulls every spawn
 * point toward its NEAREST entry in `fires` (`applyCohesion`, fire-spawn-
 * points.js) — but the cache below that decides WHETHER to re-run that pull
 * only ever watched the SPAWN CLOUD's own signature (`fireSpawnSignature`,
 * built from `_Fire`'s SPAWN_THRESHOLD=0.18 reading of the grid) and the
 * cohesion VALUE. `fires` itself — built by a DIFFERENT extraction
 * (`extractFiresFromMask`, PAINT_THRESHOLD=0.25, chamfer ridge-walk,
 * peak-separation) over the SAME grid — was never part of that
 * invalidation. Both are sampled hashes over the same data and USUALLY
 * settle together, but nothing enforces that: if `fires` finishes
 * (re-)deriving even one tick later than `cloud` — a real possibility during
 * progressive mask streaming, or any future path that recomputes one without
 * touching the other — cohesion's next push bakes in whatever `fires` list
 * existed at that moment, correct or not, and then never gets asked to check
 * again until the SPAWN CLOUD changes or the slider itself moves. A fire
 * genuinely missing from that stale list is not "not pulled" — every one of
 * its own spawn points still runs the SAME nearest-search, against a list
 * that no longer contains itself, and gets assigned to whichever real fire
 * IS in the list, however far away. This mixes `fires`' own content into the
 * same staleness check so it can never fall behind `cloud` again.
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
  }
  return hash;
}

/**
 * @param {object} deps
 * @param {*} deps.THREE - injected.
 * @param {() => object} deps.getFireRenderState - `{enabled, params, perfTier,
 *   fires[], spawnCloud, fireLabelGrid}`. `fireLabelGrid` (optional, `null` if
 *   unwired) feeds `applyCohesion`'s label-scoped grouping — see that
 *   function's own header.
 *   ⚠️ REQUIRED, deliberately NOT defaulted — `feedback_seam_default_hides_unwired`:
 *   water shipped its render-state seam declared, defaulted and never passed,
 *   and the ONLY symptom was that every control silently did nothing while all
 *   4,137 tests passed. A missing seam here throws at construction instead.
 * @param {() => object} [deps.getWindHandle] - getter, not the handle: the
 *   viewer's binding is reassigned on every rebake and this is constructed
 *   before its first assignment (the same TDZ-safe pattern the light pool uses).
 * @param {() => number} [deps.getPxPerMeter]
 * @param {(engine: object) => void} [deps.createEngine] - the injected factory
 *   (`createFireParticleEngine`). Injected rather than imported because
 *   `particles/allocator-only` keeps every `instancedArray` under
 *   `effects/particles/`, and this module has no business reaching for one.
 * @param {*} [deps.profiler] - so `sync()` can bracket its own per-frame cost
 *   (`light.fireSync` — perf-instrumentation-audit-2026-08-12: `src/effects/
 *   fire/` shipped with zero profiler coverage anywhere, unlike every other
 *   authored-light source in this pool — candles/lightning both have their
 *   own sync zone). Covers the per-engine `engine.step()` loop too, so a
 *   compute-dispatch cost hiding inside it is no longer invisible the way
 *   candles' own point-light cost was before `light.drawPointLights` was
 *   read closely (Performance-Insights.md §5B/§5C). `beginById`/`endById`
 *   (string form) — same reasoning as `specular-surface-subsystem.js`'s own
 *   `profiler` param: this subsystem is constructed independently of
 *   vt-pan-viewer.js's pre-resolved `Z` index table.
 * @param {*} [deps.depthTexNode] - `buf:scene.depth`'s DEPTH attachment,
 *   forwarded straight into `createEngine` — the SAME depth-authority
 *   occlusion gate candle/lightning already use (mythica-machina-press#469).
 *   Omitted → every engine's gate compiles out, byte-identical to before it
 *   existed.
 * @param {*} [deps.depthFlagsTexNode] - `buf:scene.depth`'s COLOUR attachment
 *   (the Tile "Restrict Lighting" flag). Also forwarded straight through.
 * @param {(elevation: number) => number} [deps.resolveExpectedDepth] - turns a
 *   raw world elevation into the tie-safe value the gate compares (`rank` +
 *   `computeTieSafeExpectedDepth`, the SAME two-step split lightning's own
 *   injected copy uses — vt-pan-viewer.js constructs both). Called ONCE per
 *   sync against a REPRESENTATIVE fire's elevation (see `syncUnguarded`'s own
 *   note), not per particle. Omitted → every engine's `expectedDepth` stays 0.
 * @returns {{scene:*, sync:Function, lightSources:()=>Array<object>,
 *   hasContent:boolean, getStatus:()=>object, dispose:()=>void}}
 */
export function createFireSubsystem({
  THREE,
  getFireRenderState,
  getWindHandle = null,
  getPxPerMeter = null,
  createEngine = null,
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
  /** @type {Array<{engine: object, kind: string}>} */
  const engines = [];
  let currentLights = [];
  let hasContent = false;
  let lastSpawnSignature = null;
  /** Last `fireListSignature(fires)` the cohesion cache was computed against
   * — see that function's own header for the staleness gap this closes. */
  let lastFiresSignature = null;
  /**
   * Last cohesion amount applied PER ENGINE — keyed by the engine object itself,
   * NOT by `kind`.
   *
   * ⚠️ THIS WAS THE BUG. `kind` is not a unique engine id: flame alone is FOUR
   * engines (one per archetype) all reporting `kind: 'flame'`. Keying this map
   * by `kind` meant the FIRST flame engine the loop reached updated the shared
   * flag to the new value, and the other three then read "already up to date"
   * and were skipped — permanently, since nothing ever un-matches the flag
   * again. Three quarters of the flame population never received a cohesion
   * push after the very first slider move, which is exactly the author's
   * report: *"Cohesion makes them appear far away from each other at both ends
   * of the slider... they just spawn apart."* A `Map` keyed by the engine
   * reference cannot collide no matter how many engines share a `kind`.
   */
  const lastCohesionByEngine = new Map();
  let lastStatus = { engines: 0, fires: 0, lights: 0, spawnPoints: 0 };

  /** Built lazily on the first sync that has something to burn — the same
   * deferred-construction posture the wind engines use, and for the same
   * reason: a build-time input (the wind handle) only becomes real later. */
  function ensureEngines() {
    if (engines.length || typeof createEngine !== 'function') return;
    const windHandle = getWindHandle?.() ?? null;
    const pxPerMeter = getPxPerMeter?.() ?? 100;
    const worldRect = { minX: 0, minY: 0, maxX: 1, maxY: 1 }; // real rect arrives per frame
    const add = (kind, archetype, capacity) => {
      // ⚠️ SMOKE DRAWS LAST. It is the only NORMAL-blended layer, so it must
      // composite over the additive flame and embers rather than under them —
      // smoke sits above the fire and genuinely hides what is beneath it, which
      // is the whole reason it is not additive.
      //
      // ⚠️ MUST BE A CONSTRUCTOR PARAM, NOT `engine.scene.renderOrder` SET
      // AFTER THE FACT — THREE reads `renderOrder` off the RENDERABLE OBJECT
      // (the mesh), never off an ancestor container, and `engine.scene` is
      // just a wrapper this factory hands back, with no geometry of its own.
      // Setting it here used to be a silent no-op: smoke's "draws last"
      // guarantee rested entirely on scene-graph insertion order (this loop
      // happens to add smoke last) rather than on any explicit ordering, which
      // would have broken the moment that insertion order ever changed.
      const renderOrder = kind === 'smoke' ? 2 : kind === 'ember' ? 1 : 0;
      const engine = createEngine({
        THREE,
        kind,
        archetype,
        system: { id: `fire.${kind}`, params: { capacity } },
        worldRect,
        renderOrder,
        windHandle,
        pxPerMeter,
        depthTexNode,
        depthFlagsTexNode,
      });
      engines.push({ engine, kind });
      scene.add(engine.scene);
    };
    // One flame engine per archetype: the shape is baked into the material, so
    // variety costs an engine rather than a per-fragment branch over all four.
    const per = Math.max(1, Math.floor(FLAME_CAPACITY / FLAME_ARCHETYPES.length));
    for (const archetype of FLAME_ARCHETYPES) add('flame', archetype, per);
    add('ember', null, EMBER_CAPACITY);
    add('smoke', null, SMOKE_CAPACITY);
  }

  /**
   * One frame. Steps every engine's compute kernel and refreshes the lights.
   *
   * @param {*} renderer - REQUIRED; `renderer.compute()` has no other source.
   * @param {number} nowMs @param {number} dtSec
   * @param {object} [worldRect] - the visible rect, for the engines' own bounds.
   */
  function sync(renderer, nowMs, dtSec, worldRect) {
    profiler?.beginById('light.fireSync');
    try {
      syncUnguarded(renderer, nowMs, dtSec, worldRect);
    } finally {
      profiler?.endById('light.fireSync');
    }
  }

  /** The real body of `sync()` — see `window-surface-subsystem.js#sync`'s
   * identical split for why: a try/finally around the whole function would
   * force re-indenting every line, and a thrown error must still close the
   * bracket regardless of which of this function's several early returns
   * would otherwise have skipped that. */
  function syncUnguarded(renderer, nowMs, dtSec, worldRect) {
    const state = getFireRenderState() ?? {};
    const fires = Array.isArray(state.fires) ? state.fires : [];
    const cloud = state.spawnCloud ?? null;
    const hasPaint = (cloud?.count ?? 0) > 0;
    // `applyCohesion`'s label-scoped grouping (2026-08-16) — see that
    // function's own header. `null` (a floor with no mask-derived fires at
    // all, or the seam simply unwired) falls back to its legacy nearest-of-
    // all behaviour, unchanged.
    const labelGrid = state.fireLabelGrid ?? null;

    if (!state.enabled || !renderer || (!hasPaint && fires.length === 0)) {
      for (const { engine } of engines) engine.scene.visible = false;
      currentLights = [];
      hasContent = false;
      lastStatus = { engines: engines.length, fires: fires.length, lights: 0, spawnPoints: 0 };
      return;
    }

    ensureEngines();
    if (!engines.length) return;

    const params = state.params ?? {};
    const tier = Number.isFinite(state.perfTier) ? state.perfTier : FIRE_DEFAULT_TIER;
    // THE THIRD LEVER (2026-08-30) — `.clusterFactor` already reaches
    // `buildFireLightSources` below via its own `{tier}` argument;
    // `.spriteCountScale` is read directly here since `activeCount` (the
    // per-fire particle budget) is computed inline in THIS function, not
    // routed through fire-geometry.js the way the light-merge lever is.
    const firePlan = fireTierPlan(tier);
    const mPerPx = Number.isFinite(state.mPerPx) && state.mPerPx > 0 ? state.mPerPx : 0.02;
    // THE WIND SIGNAL'S OWN INPUT (mythica-machina-press#475/#485 follow-up,
    // 2026-09-03) — read straight off the SAME live uniform node the particle
    // kernel itself samples every frame (`windHandle.ambient.speed01`), not a
    // separate `env.wind` snapshot, so the CPU-computed suppression/lifespan
    // curves below (particles AND, since 2026-09-04, the cast light's own
    // dimming) can never drift a frame behind the GPU-side push. This is the
    // established idiom this codebase already uses whenever a particle/render
    // system needs that live number on the CPU too — `precip-runtime.js`,
    // `curtain-render.js` and the two precip splash/drip runtimes all read
    // `wind.ambient.speed01?.value` rather than a separate snapshot, for the
    // same reason. `getEnvironment` is gone (2026-09-04) — its one live
    // consumer, `buildFireLightSources`' old `fireWeatherResponse(chain,
    // env, ...)` call, is gone too; see that function's own orphan note.
    const windHandle = getWindHandle?.() ?? null;
    const windSpeed01 = windHandle?.ambient?.speed01?.value;
    // ⚠️ NOT `fires[0]?.windExposure` (2026-09-04, a real live bug) —
    // `fires[0]` is `extractFiresFromMask`'s WIDEST painted blob on the whole
    // floor (`fire-mask.js`'s own sort, widest-ridge-first), which has no
    // relationship to WHERE that fire sits. Author, live, on a map with more
    // than one fire: an outdoor fire "isn't reacting to wind" while
    // vegetation on the same scene reacts fine. Root cause: a wider INDOOR
    // fire elsewhere on the floor was landing at `fires[0]`, and its own
    // correctly-low `windExposure` (sampled per-fire from the real
    // `_Outdoors` mask, `boot.js#sampleWindExposureAt` — the data itself was
    // never wrong) was being broadcast to the WHOLE map's shared particle
    // engines, silencing the outdoor fire's wind response too. Unlike
    // vegetation (`vt-pan-viewer.js`'s own wind sample, LIVE per clump
    // position off geometry-derived openness — never funnelled through one
    // representative anything), every flame/ember/smoke engine here is
    // genuinely map-wide, so there is no way to give an indoor and an
    // outdoor fire independently correct wind without per-particle exposure
    // data the arena has no spare storage for (`fire-particle-runtime.js`'s
    // own header). The best available fix short of that restructure: take
    // the MAXIMUM windExposure across every fire on the floor, not an
    // arbitrary one's. A floor with any genuinely outdoor fire on it now
    // engages wind for its shared particles; a purely indoor floor stays
    // calm exactly as before — this can only ever make the particles MORE
    // wind-aware than the old single-fire read, never less.
    const windExposure01 = fires.length
      ? fires.reduce((max, f) => Math.max(max, Number.isFinite(f?.windExposure) ? f.windExposure : 1), 0)
      : 1;
    // ⚠️ `{ fuel: params?.fuel }` ADDED 2026-08-30 — without it, `fireScaleChain`
    // defaults to 'wood' regardless of the author's actual "Fuel" selection, so
    // `chain.hueShift` (magical fuel's own built-in 180° shift) would resolve
    // to 0 here even after the new colorHueShift wiring below — a fix that
    // passes its own Node tests (which pass `fuel` directly to `fireScaleChain`)
    // while silently doing nothing through this real call site. `fireScaleChain`
    // already defaults/validates internally, so an undefined/invalid value here
    // is safe.
    const runtime = fireRuntimeFromParams(
      params,
      fireScaleChain(fires[0]?.diameterPx ?? 100, mPerPx, { fuel: params?.fuel }),
      { speed01: windSpeed01, exposure01: windExposure01 }
    );

    // THE DEPTH-AUTHORITY OCCLUSION GATE'S INPUT (mythica-machina-press#469) —
    // ONE value per sync, from the SAME representative fire the line above
    // already reads for sprite scale, not per particle. This is a deliberate,
    // honestly-labelled simplification: a floor's fires overwhelmingly share
    // one ground elevation (mirrors lightning's own per-bolt-not-per-vertex
    // gate), so the common case is exactly right; an anchor fire deliberately
    // raised above its floor's other fires is a real, narrower edge case this
    // does not separately solve — that would need a per-particle elevation
    // channel, and the spawn-point buffer (fire-spawn-points.js#packSpawnPoints)
    // has no spare one (`vec4` = x, y, brightness, jitter-radius already).
    const expectedDepth =
      typeof resolveExpectedDepth === 'function' ? resolveExpectedDepth(fires[0]?.elevation ?? 0) : 0;

    // The spawn cloud is pushed only when it actually needs to change — a full
    // buffer upload and a re-seed, not a per-frame write. Two independent
    // things force that: the paint changing (every engine), or — per ENGINE —
    // the COHESION pull changing (`applyCohesion`, CPU-side). Without the
    // per-engine tracking every engine gets its own push whenever cohesion
    // moves, a cohesion slider drag would sit inert on most of the flame
    // population until the next mask edit (see `lastCohesionByEngine`'s note).
    //
    // The transform itself is memoized per KIND for this one sync — flame's
    // four archetype engines all want the identical cohesed cloud, and
    // `applyCohesion` is a deterministic function of (cloud, fires, cohesion),
    // so there is no reason to recompute it four times in the same frame.
    //
    // ⚠️ A NULL CLOUD MUST STILL BE PUSHED, NOT SKIPPED. This block used to be
    // gated on `if (cloud)`, so a floor with fire ANCHORS but no painted
    // `_Fire` region (`cloud` is null; the early-return above only fires when
    // BOTH paint and fires are empty) left every engine holding whatever
    // spawn cloud it saw last — including a PREVIOUS floor's, after a floor
    // switch that lost its paint but kept an anchor. `EMPTY_SPAWN_CLOUD` gives
    // "nothing painted here" its own stable signature (0, the same value
    // `fireSpawnSignature`/`fireMaskSignature` already return for "no grid"),
    // so that state is pushed and tracked exactly like any other paint change.
    //
    // ⚠️ `fires` GETS ITS OWN SIGNATURE TOO, MIXED INTO THE SAME CHECK — see
    // `fireListSignature`'s own header. `cloud`'s signature alone is not
    // sufficient: `fires` (cohesion's pull TARGETS) is built by a completely
    // different extraction over the same grid and can settle a tick later
    // than `cloud` does. Missing that meant a stale `fires` list — one
    // genuinely missing a fire that had already finished extracting — could
    // get baked into `applyCohesion`'s result and then never be asked to
    // recompute again until the paint itself changed or the slider moved,
    // even though the CORRECT list was available the entire time.
    const effectiveCloud = cloud ?? EMPTY_SPAWN_CLOUD;
    const firesSignature = fireListSignature(fires);
    const cloudChanged = effectiveCloud.signature !== lastSpawnSignature || firesSignature !== lastFiresSignature;
    const transformedByKind = new Map();
    for (const { engine, kind } of engines) {
      const cohesion = runtime.perKind?.[kind]?.cohesion ?? 0;
      if (cloudChanged || lastCohesionByEngine.get(engine) !== cohesion) {
        if (!transformedByKind.has(kind)) {
          transformedByKind.set(
            kind,
            cloud && cohesion ? applyCohesion(cloud, fires, cohesion, labelGrid) : effectiveCloud
          );
        }
        engine.setSpawnPoints(transformedByKind.get(kind));
        lastCohesionByEngine.set(engine, cohesion);
      }
    }
    lastSpawnSignature = effectiveCloud.signature;
    lastFiresSignature = firesSignature;

    // ⚠️ SPRITES SCALE TO THE FIRE THEY BELONG TO — see
    // SPRITE_REFERENCE_DIAMETER_PX. The MEDIAN, not the mean: one bonfire in a
    // room of hearths should not inflate every sprite on the map, and the median
    // is the one summary that a single outlier cannot drag.
    const diameters = fires.map((f) => Number(f?.diameterPx)).filter((d) => Number.isFinite(d) && d > 0);
    const medianDiameter = diameters.length
      ? diameters.sort((a, b) => a - b)[Math.floor(diameters.length / 2)]
      : SPRITE_REFERENCE_DIAMETER_PX;
    const spriteScale = Math.max(0.3, Math.min(2.5, medianDiameter / SPRITE_REFERENCE_DIAMETER_PX));
    // How many distinct fires the budget is being divided among. A painted
    // region with no extracted fire still burns (the spawn cloud is what the
    // kernels read), so this floors at one rather than at zero.
    const fireCount = Math.max(1, fires.length);

    for (const { engine, kind } of engines) {
      engine.scene.visible = true;
      const tune = runtime.perKind?.[kind] ?? {};
      engine.setParams({
        ...tune,
        // ⚠️ `fireIntensity`, NOT `intensity`. `fireRuntimeFromParams` returns
        // BOTH: `intensity` is `p.brightness` ("Flame brightness", Look) — a
        // volumetric-material uniform that only ever reached the orphaned
        // `fire-render.js` — while `fireIntensity` is `p.intensity` ("Fire
        // intensity", Presence, "how hard everything burns"), the control an
        // author actually reaches for. This engine's own `setParams` takes an
        // `intensity` key (feeds `uIntensity`, the live shader's real
        // brightness uniform) — reading `runtime.intensity` here silently
        // wired the WRONG source param to it: moving "Fire intensity" did
        // nothing to the live particle fire, and "Flame brightness" (whose own
        // help text describes banding/posterize failure modes that don't
        // exist in this shader) was the one that happened to work, by
        // coincidence of a shared field name (`feedback_shared_field_two_meanings_two_registries`).
        intensity: runtime.fireIntensity,
        cameraHeight: runtime.cameraHeight,
        motionSpeed: runtime.motionSpeed,
        // GLOBAL, like motionSpeed above — every engine (flame/ember/smoke)
        // reads this so ember and smoke inherit the same gust push flame
        // does, and the particle kernel can fade flame's own calm-air
        // upward drift as wind rises. See fire-geometry.js#fireWindMotion01.
        windMotion01: runtime.windMotion01,
        expectedDepth,
        // ⚠️ FIXED ALONGSIDE THE ABOVE (2026-08-30) — `hueShiftRad`/
        // `posterizeAmount`/`bandCount`/`tintMul` were the other three
        // `fireRuntimeFromParams` fields nothing ever read: computed every
        // frame, forwarded to nobody. See fire.js's "Look" category header
        // for the full account. Global like `motionSpeed` above — every
        // engine (flame/ember/smoke) needs `hueShiftRad` so a recoloured
        // fire reads as one object; the other three sit inert on ember/smoke
        // engines exactly the way `colorAge` already does.
        hueShiftRad: runtime.hueShiftRad,
        posterizeAmount: runtime.posterize,
        bandCount: runtime.bands,
        tintMul: runtime.flameColorTintMul,
        // Smoke keeps V2's absolute sizing: it is the layer the author reports
        // already reads correctly, and it SHOULD outgrow its fire — a plume is
        // wider than the fuel that made it.
        sizeScale: (tune.sizeScale ?? 1) * (kind === 'smoke' ? 1 : spriteScale),
        // ⚠️ PER FIRE, not per map — see PER_FIRE. `flame` is counted per
        // ARCHETYPE engine (there are four of them), so the per-fire flame total
        // is four times this.
        // The control is PER FIRE; the engine budget is map-wide, so it scales
        // by how many fires are sharing it (and is clamped to the arena inside
        // `setParams`). Falls back to the shipped PER_FIRE default.
        //
        // ⚠️ `firePlan.spriteCountScale` ADDED 2026-08-30 — fire's 3rd real
        // tier lever (fire-geometry.js#FIRE_TIER_PLANS's own header has the
        // full account). 1.0 at `standard`+, so this multiply is a genuine
        // no-op there — byte-identical to before this lever existed. ONLY
        // an author's explicit `tune.activeCount` override bypasses it
        // (matches how `tune.sizeScale` above is multiplied INTO the tier
        // term rather than replaced by it — an author dialing "more
        // particles" should still get fewer of them at `low`, not opt
        // fully out of the gradient by accident).
        activeCount: Math.max(
          0,
          (tune.activeCount ?? PER_FIRE[kind]) * Math.max(1, fireCount) * firePlan.spriteCountScale
        ),
      });
      engine.step(renderer, { dtSec, tMs: nowMs, worldRect });
    }

    currentLights = runtime.lightEnabled
      ? buildFireLightSources(fires, {
          tier,
          mPerPx,
          colorHex: runtime.lightColor,
          radiusScale: runtime.lightRadiusScale,
          // Same three dials feeding the particles' own windMotion01 above —
          // see buildFireLightSources' own note on why alive01 now comes
          // from the SAME per-cluster fireWindParticleResponse call instead
          // of a second, independent wind curve.
          windSpeed01,
          windResponseGain: runtime.windResponse,
          weatherResponse01: runtime.weatherResponse,
          canBeSnuffed: runtime.canBeSnuffed,
        })
      : [];

    hasContent = true;
    lastStatus = {
      engines: engines.length,
      fires: fires.length,
      lights: currentLights.length,
      spawnPoints: cloud?.count ?? 0,
    };
  }

  return {
    scene,
    sync,
    /** Merged by the viewer's point-light pool exactly like a Foundry light. */
    lightSources: () => currentLights,
    get hasContent() {
      return hasContent;
    },
    getStatus: () => ({ ...lastStatus, perEngine: engines.map(({ engine }) => engine.debugState()) }),
    /**
     * Fan a rebake out to every engine's own `updateWind` (2026-09-04) — until
     * now NOTHING called this at all: `vt-pan-viewer.js`'s rebake dispatch
     * refreshed the dust-mote and gust engines (`particleEngine?.updateWind`/
     * `gustEngine?.updateWind`) but had no equivalent call for fire, whose
     * own per-engine `updateWind` methods existed but were dead code. Harmless
     * before 2026-09-04 (fire read only the live ambient direction/speed
     * nodes, which need no refresh), but now that each engine also holds its
     * own wind-cell storage buffer (real per-particle openness — see
     * `fire-particle-runtime.js`'s own header), a wall/door edit after
     * construction would otherwise leave that buffer's CONTENTS frozen at
     * whatever the first bake produced forever. `engines` holds 6 live
     * engines (4 flame archetypes + ember + smoke); each gets the identical
     * handle, same as `sync()` already hands every one of them at
     * construction.
     * @param {object|null} nextHandle
     */
    updateWind(nextHandle) {
      for (const { engine } of engines) engine.updateWind?.(nextHandle);
    },
    dispose() {
      // ⚠️ There is no engine dispose path — `ParticleArena` allocates once and
      // never frees (`reference_bufferattribute_no_dispose_trap`: BufferAttribute
      // has no dispose(), and a rebuild-on-toggle would leak worse). Dropping
      // the scene reference is all this can honestly do.
      for (const { engine } of engines) scene.remove(engine.scene);
      engines.length = 0;
      currentLights = [];
      hasContent = false;
    },
  };
}
