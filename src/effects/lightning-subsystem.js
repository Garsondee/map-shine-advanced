/**
 * LIGHTNING SUBSYSTEM — the CPU lifecycle owner: per-source burst scheduling,
 * spawn/reap of the fixed-capacity strand pool, and checksum-free (population-
 * driven) geometry rebuilds. Mirrors `door-graphics-subsystem.js`'s shape
 * exactly (`{scene, sync(nowMs), dispose()}`) plus one addition,
 * `activeStrands()`, the seam `point-light-pool.js` reads for the origin
 * flash light.
 *
 * This is genuinely new territory in `effects/` — nothing else here owns a
 * dynamic POPULATION with its own spawn/reap timers (candle's anchors are a
 * static, always-visible set; a door's leaves animate open/close but never
 * spawn/despawn). The rebuild discipline still follows the established
 * pattern exactly: the batched buffer is only rebuilt when the STRAND SET
 * actually changes (a burst spawns or a strand expires) — a quiet frame,
 * with strands mid-flight but nothing new happening, touches no GPU buffer,
 * only a few live uniform writes (candle's own "geometry on real change,
 * uniforms every frame" split, applied here to population instead of anchor
 * position/colour).
 *
 * @module effects/lightning-subsystem
 */

import { createLogger } from '../core/log.js';
import {
  groupLightningAnchorsIntoSources,
  generateBurst,
  nextBurstDelayMs,
  computeLightningStrandArrays,
  hexToRgb01,
  checkReturnStrokeTrigger,
  computeOutsideFlashSignal,
} from './lightning-geometry.js';
import { buildLightningMaterial, refillLightningGeometry } from './lightning-render.js';

const log = createLogger('Lightning');

/** V2's own pool sizing (`_maxActiveStrikes`/`_maxPointsPerStrike`) — a
 * "strand" here covers what V2 split across one strike-pool concept: a main
 * bolt OR a branch, both drawn from the same fixed-capacity budget. */
const LIGHTNING_MAX_ACTIVE_STRANDS = 24;
const LIGHTNING_MAX_POINTS_PER_STRAND = 96;

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** The shader-detail tier from the resolved effect tier (0..3, effects/
 * lightning.js's own ladder) — richer rungs ('flash' and up) also get the
 * core-static crackle detail; the earlier rungs ('strike'/'branching') skip
 * constructing it (Effects.md Law 4). No separate quality axis: one ladder
 * decides both which subsystems run and how much shader detail they carry. */
function qualityForTier(perfTier) {
  return num(perfTier, 0) >= 2 ? 2 : 0;
}

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported (the bloom split's rule).
 * @param {*} args.uGlobalTimeMs - the ONE shared animation-clock TSL uniform node.
 * @param {() => {enabled: boolean, params: object, perfTier?: number, anchors: Array<object>}} args.getLightningRenderState -
 *   boot's data seam. Default-off means an un-wired caller draws no bolts.
 * @returns {{scene:*, sync:(nowMs:number)=>void, dispose:()=>void, activeStrands:()=>Array<object>, droppedForCapacity:()=>number}}
 */
export function createLightningSubsystem({ THREE, uGlobalTimeMs, getLightningRenderState }) {
  const lightningScene = new THREE.Scene();
  let mesh = null;
  let geometry = null;
  let matBundle = null; // { material, uniforms }
  let materialQuality = null;

  /** Every currently-live strand (main strikes AND branches) — a plain array,
   * not a slot map: nothing needs per-slot identity across frames the way
   * point-light-pool.js's mesh reuse does, only "what's live right now". */
  let activeStrands = [];
  /** linkId -> {seed, burstIndex, nextBurstAtMs}. Deleted (not merely
   * paused) when a source's anchor pair disappears, so a re-added source
   * restarts its own stagger from burst 0 rather than resuming stale timing —
   * and, unlike V2's `_rebuildSources` (which wiped EVERY source's schedule
   * on any map-point change), only the source that actually changed loses
   * its timer; every other bolt keeps firing on its own clock undisturbed. */
  const schedules = new Map();
  let droppedForCapacity = 0;
  let dirty = false;

  /** The outside (screen-wide) flash's own attack/decay/flicker state — V2's
   * own `_flashStartMs`/`_flashPeak`/`_flashSeed`. `flashSeed` is drawn ONCE
   * here (mirrors V2's own one-time `initialize()`-time `Math.random()` call,
   * not a per-frame clock sample — the `time/one-clock` wall this project
   * enforces is about sampling the CURRENT time as a private clock, not about
   * seeding a stable phase offset once). */
  const outsideFlashState = { flashStartMs: -1, flashPeak: 0, flashSeed: Math.random() };
  let currentOutsideFlash01 = 0;

  function ensureMaterial(quality) {
    if (matBundle && materialQuality === quality) return;
    const prev = matBundle;
    matBundle = buildLightningMaterial({ THREE, uGlobalTimeMs, quality });
    materialQuality = quality;
    if (!mesh) {
      geometry = new THREE.BufferGeometry();
      mesh = new THREE.Mesh(geometry, matBundle.material);
      mesh.frustumCulled = false; // world-space, camera bounds vary per frame
      lightningScene.add(mesh);
    } else {
      mesh.material = matBundle.material;
    }
    prev?.material?.dispose(); // free the superseded material on a tier change
  }

  function pushUniforms(params) {
    const u = matBundle.uniforms;
    u.uWidth.value = num(params.width, 30);
    u.uTaper.value = num(params.taper, 0.08);
    u.uBrightness.value = num(params.brightness, 5);
    u.uGlowStrength.value = num(params.glowStrength, 5);
    u.uTextureScrollSpeed.value = num(params.textureScrollSpeed, 25);
    u.uCoreStaticAmount.value = num(params.coreStaticAmount, 1);
    u.uCoreStaticRange.value = num(params.coreStaticRange, 0.85);
    u.uWindDriftStrength.value = num(params.windDriftStrength, 0);
    u.uFlickerChance.value = clamp01(params.flickerChance);
    const outer = hexToRgb01(params.outerColor);
    u.uOuterColor.value.set(outer[0], outer[1], outer[2]);
    const core = hexToRgb01(params.coreColor);
    u.uCoreColor.value.set(core[0], core[1], core[2]);
  }

  function rebuildGeometryIfDirty() {
    if (!dirty || !geometry) return;
    const arrays = computeLightningStrandArrays(
      activeStrands,
      LIGHTNING_MAX_ACTIVE_STRANDS,
      LIGHTNING_MAX_POINTS_PER_STRAND
    );
    // refillLightningGeometry handles "attribute doesn't exist yet" (a fresh
    // BufferGeometry from ensureMaterial) the same as "attribute exists,
    // reuse or grow it" — one path, not a special-cased first build.
    refillLightningGeometry(THREE, geometry, arrays);
    dirty = false;
  }

  /** Advance every tracked source's schedule and spawn any bursts that are
   * due, dropping (and counting) spawns beyond the pool's fixed capacity —
   * matches V2's own `_allocStrike() === null` behaviour, plus a readout V2
   * never had. */
  function advanceSchedulesAndSpawn(sources, nowMs, params) {
    const liveLinkIds = new Set(sources.map((s) => s.linkId));
    for (const linkId of [...schedules.keys()]) {
      if (!liveLinkIds.has(linkId)) schedules.delete(linkId);
    }

    const minDelayMs = Math.max(0, num(params.minDelayMs, 0));
    const maxDelayMs = Math.max(0, num(params.maxDelayMs, 0));

    for (const source of sources) {
      let sched = schedules.get(source.linkId);
      if (!sched) {
        // A freshly-seen source staggers its FIRST burst across [0, maxDelayMs]
        // (V2's own `_rebuildSources` range for a source it has never fired
        // yet), not [minDelayMs, maxDelayMs] — so a scene full of bolts
        // doesn't all light up in lockstep the instant it loads.
        sched = {
          seed: source.seed,
          burstIndex: 0,
          nextBurstAtMs: nowMs + nextBurstDelayMs(source.seed, 0, 0, maxDelayMs),
        };
        schedules.set(source.linkId, sched);
      }
      if (nowMs < sched.nextBurstAtMs) continue;

      if (activeStrands.length >= LIGHTNING_MAX_ACTIVE_STRANDS) {
        droppedForCapacity++;
      } else {
        const { main, branches } = generateBurst({
          source,
          burstIndex: sched.burstIndex,
          spawnMs: nowMs,
          maxPointsPerStrand: LIGHTNING_MAX_POINTS_PER_STRAND,
          params,
        });
        activeStrands.push(main);
        dirty = true;
        for (const branch of branches) {
          if (activeStrands.length >= LIGHTNING_MAX_ACTIVE_STRANDS) {
            droppedForCapacity++;
            break;
          }
          activeStrands.push(branch);
        }
      }

      sched.burstIndex++;
      sched.nextBurstAtMs = nowMs + nextBurstDelayMs(source.seed, sched.burstIndex, minDelayMs, maxDelayMs);
    }
  }

  function reapExpired(nowMs) {
    const before = activeStrands.length;
    if (!before) return;
    activeStrands = activeStrands.filter((s) => nowMs < s.spawnMs + s.durationMs);
    if (activeStrands.length !== before) dirty = true;
  }

  /** Check every active main strand for a fresh return-stroke connect (each
   * fires at most once per lifetime — see checkReturnStrokeTrigger's own
   * header), feed the outside flash's attack/decay envelope, and recompute
   * this frame's published value. */
  function updateOutsideFlash(nowMs, params) {
    for (const strand of activeStrands) {
      const { triggered, intensity } = checkReturnStrokeTrigger(nowMs, strand);
      if (triggered) {
        outsideFlashState.flashStartMs = nowMs;
        outsideFlashState.flashPeak = Math.max(outsideFlashState.flashPeak, intensity);
      }
    }
    currentOutsideFlash01 = computeOutsideFlashSignal(nowMs, outsideFlashState, params);
  }

  function resetOutsideFlash() {
    outsideFlashState.flashStartMs = -1;
    outsideFlashState.flashPeak = 0;
    currentOutsideFlash01 = 0;
  }

  /** Per-frame: reconcile bolt sources from the served anchors, spawn/reap
   * strikes on the burst clock, and rebuild the batched buffer only when the
   * strand SET actually changed. Runs before `pointLights.update()` so the
   * origin-flash light reads this frame's fresh strand snapshot. */
  function syncLightning(nowMs) {
    const state = getLightningRenderState();
    const enabled = !!state?.enabled;
    const params = state?.params ?? {};

    if (!enabled) {
      if (activeStrands.length || schedules.size) {
        activeStrands = [];
        schedules.clear();
        dirty = true;
      }
      resetOutsideFlash();
      rebuildGeometryIfDirty();
      if (mesh) mesh.visible = false;
      return;
    }

    const anchors = Array.isArray(state.anchors) ? state.anchors : [];
    const { sources } = groupLightningAnchorsIntoSources(anchors);
    if (!sources.length) {
      if (activeStrands.length || schedules.size) {
        activeStrands = [];
        schedules.clear();
        dirty = true;
      }
      resetOutsideFlash();
      rebuildGeometryIfDirty();
      if (mesh) mesh.visible = false;
      return;
    }

    advanceSchedulesAndSpawn(sources, nowMs, params);
    reapExpired(nowMs);
    updateOutsideFlash(nowMs, params);

    ensureMaterial(qualityForTier(state.perfTier));
    pushUniforms(params);
    rebuildGeometryIfDirty();
    mesh.visible = activeStrands.length > 0;
  }

  /** Free the mesh's own GPU resources (its origin-flash lights live in the
   * shared point-light pool, freed by that pool's own dispose). Safe whether
   * or not anything was built. */
  function disposeLightning() {
    try {
      mesh?.geometry?.dispose();
      matBundle?.material?.dispose();
    } catch (err) {
      log.error('lightning dispose failed — GPU buffers may leak until renderer.dispose():', err);
    }
    mesh = null;
    geometry = null;
    matBundle = null;
    materialQuality = null;
    activeStrands = [];
    schedules.clear();
  }

  return {
    /** The strand mesh's own scene — the viewer draws THIS additively into
     * the currently-bound target, guarded exactly like the candle flame's
     * own draw (see that call site's own comment for why). */
    scene: lightningScene,
    sync: syncLightning,
    dispose: disposeLightning,
    /** Whether the strand mesh currently has anything worth drawing — the
     * viewer skips its draw call entirely when false, mirroring door-
     * graphics-subsystem.js's own `leafCount` readout (there: a count; here:
     * the mesh's own live visibility, since population size alone doesn't
     * capture "enabled but between bursts" the way a door's leaf-count would). */
    get hasContent() {
      return !!mesh && mesh.visible;
    },
    /** The frame's live strand snapshot (main strikes AND branches) —
     * `point-light-pool.js` filters to non-branch strands itself for the
     * origin flash, mirroring `buildLightningLightSources`' own gate. */
    activeStrands: () => activeStrands,
    /** This frame's published outside (screen-wide) flash value, 0..~
     * outsideFlashMaxClamp — V2's own `env.lightningFlash01`. No consumer
     * reads this yet (the `weather-lightning-flash-merge` deferred rung is
     * what would); published unconditionally regardless, same as V2 always
     * did. */
    outsideFlash01: () => currentOutsideFlash01,
    /** How many bursts/branches this session has dropped for lack of a free
     * pool slot — a debug-report readout V2 never had (it silently dropped
     * the same way, unreported). */
    droppedForCapacity: () => droppedForCapacity,
  };
}
