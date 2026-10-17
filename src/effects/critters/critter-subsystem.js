/**
 * CRITTER SUBSYSTEM — the lifecycle around the engines: what a painted zone turns
 * into, how many agents live in it right now, and what the sky says about them.
 *
 * ONE factory, two groups (`smellyFlies`: maggots under flies, over one painted
 * `_Flies` zone; `fireflies`: a colony over `_Fireflies`). A group is a table row —
 * which engines it owns, which param sizes each, which activity law thins each — so
 * a fourth kind of critter is a row and a body, never a copy of this file. THREE and
 * every GPU allocator are INJECTED (the fire subsystem's own shape): this module
 * imports no `vt/` code and allocates no buffer itself, so it is Node-testable with
 * stub engines, which is how its sync logic is tested.
 *
 * ============================================================================
 * THE FOUR THINGS IT DOES ABOUT EVERY FRAME, IN THE ORDER IT DOES THEM
 * ============================================================================
 *
 * 1. PERCEPTION. When the painted mask (or the sensitivity slider) changes, the
 *    grid is turned into a zone field (`critter-zone.js`): signed distance to the
 *    rim, inward gradient, connected components. Debounced and signature-gated —
 *    the transform is a few tens of milliseconds on a huge zone and would otherwise
 *    run on every brush stroke.
 * 2. POPULATION. `perZone` agents per zone (scaled by the tier's `countScale`, and
 *    by each zone's area), each given a HOME point. A population change rewrites
 *    the shared zone buffer in place — storage buffers cannot be freed or grown.
 * 3. ACTIVITY. The sky decides what fraction of the population shows
 *    (`critter-activity.js`: daylight and weather for flies, the sun's twilight
 *    window for fireflies), eased over seconds so a GM dragging the clock from
 *    noon to dusk hatches a colony, one firefly at a time, instead of popping it.
 * 4. THE STEP. Push the params, dispatch the compute kernel. Nothing here touches
 *    a position: the agents steer themselves (`fly-brain.js` etc.).
 *
 * ⚠️ NOTHING HERE IS SYNCHRONISED BETWEEN CLIENTS AND NOTHING IS GAMEPLAY. Every
 * client rolls its own dice (`Math.random()` salts the kernels), the activity is a
 * pure function of the shared sky, and no result of any of this is ever read back.
 *
 * ⚠️ A SWARM MAY NEVER TAKE THE FRAME DOWN. `sync` runs inside the viewer's sims block, which has no
 * try/catch of its own: a throw from here would abort the whole frame, every frame, for a cosmetic
 * effect. So a throw is caught at this boundary, said once per distinct message (loudly: the error
 * log, the flight recorder, `getStatus().fault`), the swarm hides, and the subsystem stands down for
 * a few seconds before it tries again. It never goes quiet about it, and it never freezes the map.
 *
 * @module effects/critters/critter-subsystem
 */
import { createLogger } from '../../core/log.js';
import {
  buildZoneField,
  allocateZonePopulation,
  pickSlotHomes,
  zoneGridSignature,
  createSlotStamper,
} from './critter-zone.js';
import { flyActivity, fireflyActivity, approach, activeSlotCount } from './critter-activity.js';
import {
  critterTierPlan,
  critterRefAreaPx2,
  critterMarginPx,
  CRITTER_CAPACITY,
  CRITTER_DEFAULT_TIER,
  ZONE_MAX_CELLS,
  FLY_LOOKS,
  FIREFLY_FLASH_STYLES,
} from './critter-species.js';
import { createShadowHandle } from '../shadow-access.js';
import { hexToRgb01 } from '../candle-flame-geometry.js';

const log = createLogger('critter-subsystem');

/** Never rebuild a zone field more often than this: a brush stroke bumps the mask version every few frames. */
const MIN_FIELD_REBUILD_MS = 250;
/** After a frame throws, how long the swarm stays hidden before the subsystem tries again. */
const FAULT_RETRY_MS = 5000;

/**
 * What an ENGINE of each kind is, as data: its tier family, its slot budget, where it sorts
 * among the group's draws, which param sets its head-count, and the law that decides how much
 * of it is showing. `activity` receives the frame's env and the group's params.
 */
const ENGINE_SPECS = Object.freeze({
  fly: Object.freeze({
    family: 'fly',
    capacity: CRITTER_CAPACITY.fly,
    renderOrder: 10,
    perZoneParam: 'fliesPerZone',
    tauSec: 2.5,
    activity: (env, p) => flyActivity(env, { nightActivity: p.nightActivity, weatherResponse: p.weatherResponse }),
  }),
  maggot: Object.freeze({
    family: 'fly',
    capacity: CRITTER_CAPACITY.maggot,
    renderOrder: 0,
    perZoneParam: 'maggotsPerZone',
    tauSec: 1,
    // Maggots live IN the thing; neither dusk nor rain sends them anywhere.
    activity: () => 1,
  }),
  firefly: Object.freeze({
    family: 'firefly',
    capacity: CRITTER_CAPACITY.firefly,
    renderOrder: 20,
    perZoneParam: 'countPerZone',
    tauSec: 3,
    activity: (env, p) =>
      fireflyActivity(env, {
        alwaysActive: p.alwaysActive,
        dusk: p.dusk,
        dawn: p.dawn,
        appearBelowDeg: p.appearBelowDeg,
        fullBelowDeg: p.fullBelowDeg,
        fadeByDeg: p.fadeByDeg,
        nightResidual: p.nightResidual,
        weatherResponse: p.weatherResponse,
      }),
  }),
});

/** Which engines each group owns, in the order their homes are packed into the shared zone buffer. */
const GROUPS = Object.freeze({
  smellyFlies: Object.freeze({ engines: Object.freeze(['fly', 'maggot']), syncZone: 'light.smellyFliesSync' }),
  fireflies: Object.freeze({ engines: Object.freeze(['firefly']), syncZone: 'light.firefliesSync' }),
});

/**
 * GPU allocations that outlive a subsystem. A storage buffer cannot be freed
 * (`particle-arena.js`), and the zone buffer is 4 MB: a viewer that is rebuilt on every
 * scene change and allocated a fresh one each time would leak 8 MB a scene. So the first
 * subsystem for a given THREE allocates, and every later one is handed the same buffers.
 *
 * @type {WeakMap<object, Map<string, *>>}
 */
const SHARED = new WeakMap();

function shared(THREE, key, make) {
  let bucket = SHARED.get(THREE);
  if (!bucket) {
    bucket = new Map();
    SHARED.set(THREE, bucket);
  }
  if (!bucket.has(key)) bucket.set(key, make());
  return bucket.get(key);
}

/**
 * Turn one engine's author params (plus the sky) into the uniform values its kernels read.
 * The bank ignores any name it does not declare, so passing the whole params object is safe —
 * this only has to do the conversions a uniform cannot: colours, enum indices, the shadow.
 *
 * @param {'fly'|'maggot'|'firefly'} kind
 * @param {Record<string, *>} params
 * @param {{shadowShift?: number[], shadowSoft?: number, shadowAmount?: number}|null} [shadow]
 * @returns {Record<string, number|number[]>}
 */
export function critterUniformValues(kind, params, shadow = null) {
  const out = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (typeof value === 'number') out[name] = value;
  }
  if (kind === 'fly') {
    out.tint = hexToRgb01(params?.tint ?? '#ffffff');
    out.lookIndex = Math.max(0, FLY_LOOKS.indexOf(params?.species));
    if (shadow) {
      out.shadowShift = shadow.shadowShift;
      out.shadowSoft = shadow.shadowSoft;
      out.shadowAmount = shadow.shadowAmount;
    }
  } else if (kind === 'maggot') {
    out.maggotColor = hexToRgb01(params?.maggotColor ?? '#e6dcb8');
  } else if (kind === 'firefly') {
    out.color = hexToRgb01(params?.color ?? '#b8ff3a');
    out.flashStyleIndex = Math.max(0, FIREFLY_FLASH_STYLES.indexOf(params?.flashStyle));
  }
  return out;
}

/**
 * The fly's shadow for this sky: how far a fly's shadow slides per px of height, how soft it is,
 * and how dark. Resolved through the SHARED sky handle, so a fly's shadow agrees with the
 * trees' about where the sun is and adds no light-direction knob of its own.
 *
 * @param {object|null} env @param {{flyHeight?: number, shadowStrength?: number}} params
 * @returns {{shadowShift: number[], shadowSoft: number, shadowAmount: number}}
 */
export function flyShadowFromSky(env, params) {
  const height = Number.isFinite(params?.flyHeight) && params.flyHeight > 0 ? params.flyHeight : 80;
  const cast = createShadowHandle({ sun: env?.sun ?? null, weather: env?.weather ?? null }).forCaster({
    heightPx: height,
    strength01: Number.isFinite(params?.shadowStrength) ? params.shadowStrength : 0.45,
  });
  return {
    shadowShift: [cast.offsetX / height, cast.offsetY / height],
    shadowSoft: cast.penumbraPx,
    shadowAmount: cast.strength01,
  };
}

/**
 * @param {object} deps
 * @param {*} deps.THREE - injected.
 * @param {'smellyFlies'|'fireflies'} deps.group
 * @param {() => object} deps.getRenderState - `{enabled, params, perfTier, floorIndex, elevation,
 *   gridPx, maskGrid, maskVersion}`. REQUIRED and deliberately not defaulted: a defaulted
 *   render-state seam is how water shipped every control inert with a green test suite.
 * @param {(a: object) => object} deps.createEngine - `createCritterEngine`, injected because the
 *   `particles/allocator-only` wall keeps every `instancedArray` under `effects/particles/`.
 * @param {(THREE: *, capacity: number) => object} deps.allocateBuffers - `allocateCritterBuffers`.
 * @param {(a: object) => object} deps.createZoneBuffer - `createCritterZoneBuffer`.
 * @param {*} [deps.profiler] - `beginById`/`endById`, so `sync()` brackets its own cost.
 * @param {*} [deps.illumTexNode] @param {*} [deps.colorationTexNode] - the scene's illumination (the `lit` rung).
 * @param {*} [deps.depthTexNode] @param {*} [deps.depthFlagsTexNode] - the depth-authority occlusion gate.
 * @param {(elevation: number) => number} [deps.resolveExpectedDepth]
 * @param {() => number} [deps.random] - the engines' salt source (a lab injects a seeded one).
 * @returns {{scene: *, sync: Function, hasContent: boolean, getStatus: () => object, dispose: () => void}}
 */
export function createCritterSubsystem({
  THREE,
  group,
  getRenderState,
  createEngine,
  allocateBuffers,
  createZoneBuffer,
  profiler = null,
  illumTexNode = null,
  colorationTexNode = null,
  depthTexNode = null,
  depthFlagsTexNode = null,
  resolveExpectedDepth = null,
  random = Math.random,
}) {
  const groupDef = GROUPS[group];
  if (!groupDef)
    throw new TypeError(
      `createCritterSubsystem: unknown group '${group}' (expected ${Object.keys(GROUPS).join(', ')})`
    );
  if (typeof getRenderState !== 'function') {
    throw new TypeError(
      'createCritterSubsystem: `getRenderState` is required. A defaulted render-state seam is how water shipped ' +
        'every control inert with a green test suite (feedback_seam_default_hides_unwired).'
    );
  }
  for (const [name, fn] of Object.entries({ createEngine, allocateBuffers, createZoneBuffer })) {
    if (typeof fn !== 'function')
      throw new TypeError(`createCritterSubsystem: \`${name}\` is required (the GPU allocators are injected)`);
  }

  const scene = new THREE.Scene();
  const specs = groupDef.engines.map((kind) => ({ kind, ...ENGINE_SPECS[kind] }));
  const homeCapacities = specs.map((s) => s.capacity);

  /** @type {{node:*, write:Function, sectionOffsets:number[]}|null} */
  let zoneBuffer = null;
  /** The zone field and what it was built from. */
  const zone = {
    field: null,
    key: '',
    signature: 0,
    builtAtMs: -Infinity,
    builds: 0,
    skips: 0,
    truncated: false,
  };
  /** One record per engine kind, built lazily the first time its population is non-zero. */
  const slots = new Map();
  let hasContent = false;
  let lastStatus = { group, zones: 0, engines: [] };
  /** The last frame that threw: what it said, how many have, and when the subsystem will try again. */
  let fault = null;
  let lastFaultMessage = '';
  let lastShadowKey = '';
  let shadowValues = null;
  /** Bumped whenever the shared zone buffer must be rewritten (a field or ANY engine's homes changed). */
  let zoneDirty = false;

  function hideAll() {
    for (const s of slots.values()) {
      s.engine?.setActive(0);
    }
    scene.visible = false;
    hasContent = false;
  }

  function ensureZoneBuffer() {
    if (zoneBuffer) return zoneBuffer;
    zoneBuffer = shared(THREE, `zone:${group}`, () =>
      createZoneBuffer({ THREE, maxCells: ZONE_MAX_CELLS, homeCapacities })
    );
    return zoneBuffer;
  }

  /**
   * Keep the zone field current. Returns the field (possibly null: nothing painted).
   *
   * The cheap key (floor, mask version, sensitivity) is checked every frame; only a CHANGE pays for the
   * content hash, and only a change of CONTENT pays for the distance transform — and that one waits out
   * `MIN_FIELD_REBUILD_MS`, so a stroke in progress costs one rebuild a quarter-second, not one a frame.
   */
  function syncZone(state, nowMs) {
    const grid = state.maskGrid ?? null;
    const threshold = Number.isFinite(state.params?.maskSensitivity) ? state.params.maskSensitivity : 0.15;
    const marginPx = critterMarginPx(state.gridPx);
    const key = `${state.floorIndex ?? 0}|${state.maskVersion ?? 0}|${threshold}|${marginPx}|${grid ? 1 : 0}`;
    if (key === zone.key) return zone.field;
    const floorChanged = !zone.key.startsWith(`${state.floorIndex ?? 0}|`);
    if (!floorChanged && nowMs - zone.builtAtMs < MIN_FIELD_REBUILD_MS) return zone.field;

    zone.key = key;
    zone.builtAtMs = nowMs;
    if (!grid) {
      zone.skips += 1;
      if (zone.field) zoneDirty = true;
      zone.field = null;
      zone.signature = 0;
      return null;
    }
    const signature =
      zoneGridSignature(grid) ^ Math.imul(Math.round(threshold * 1000) + 1, 2654435761) ^ (marginPx | 0);
    if (signature === zone.signature && zone.field) {
      zone.skips += 1;
      return zone.field;
    }
    const field = buildZoneField(grid, { threshold, marginPx });
    zone.builds += 1;
    zone.signature = signature;
    zone.field = field ? { ...field, signature } : null;
    zone.truncated = false;
    zoneDirty = true;
    if (field) {
      log.info(
        `${group}: floor ${state.floorIndex ?? 0} painted zone → ${field.zones.length} zone(s), ` +
          `${field.cols}×${field.rows} cells`
      );
    }
    return zone.field;
  }

  /** Build (or rebuild, on a tier change) one engine, reusing its arena. */
  function ensureEngine(spec, tier) {
    let slot = slots.get(spec.kind);
    if (!slot) {
      slot = {
        kind: spec.kind,
        spec,
        memory: shared(THREE, `mem:${spec.kind}`, () => allocateBuffers(THREE, spec.capacity)),
        engine: null,
        tier: null,
        population: null,
        homes: null,
        stamper: createSlotStamper(spec.capacity),
        populationKey: '',
        activity: null,
        lastParams: null,
        lastShadow: null,
        lastDepth: null,
        pushed: false,
        placed: false,
      };
      slots.set(spec.kind, slot);
    }
    if (slot.engine && slot.tier === tier) return slot;
    // A tier change rebuilds the kernels and materials (a rung changes which shader nodes exist) around the
    // SAME arena: the successor carries on from the swarm the old engine left in it rather than reseeding, and
    // the old engine gives back what the renderer holds for it (geometry, materials, pipelines).
    const resume = slot.engine?.resumeToken?.() ?? null;
    if (slot.engine) {
      scene.remove(slot.engine.scene);
      slot.engine.dispose?.();
    }
    const plan = critterTierPlan(spec.family, tier);
    slot.engine = createEngine({
      THREE,
      kind: spec.kind,
      memory: slot.memory,
      zoneBuffer: ensureZoneBuffer(),
      plan,
      renderOrder: spec.renderOrder,
      illumTexNode,
      colorationTexNode,
      depthTexNode,
      depthFlagsTexNode,
      random,
      resume,
    });
    slot.plan = plan;
    slot.tier = tier;
    slot.placed = false; // a new engine has to be told where the zone is
    slot.pushed = false; // ...and what its params are
    scene.add(slot.engine.scene);
    return slot;
  }

  /** Deal this engine's agents across the zones and write their homes, when the inputs changed. */
  function syncPopulation(slot, field, params, gridPx) {
    const { spec } = slot;
    const perZone = Math.max(0, Number(params[spec.perZoneParam]) || 0) * slot.plan.countScale;
    const areaScaling = Number.isFinite(params.areaScaling) ? params.areaScaling : 0.5;
    const key = `${field.signature}|${perZone}|${areaScaling}|${gridPx}|${slot.tier}`;
    if (key === slot.populationKey && slot.homes) return false;
    slot.population = allocateZonePopulation(field.zones, {
      perZone,
      areaScaling,
      refAreaPx2: critterRefAreaPx2(gridPx),
      capacity: spec.capacity,
      minPerZone: 1,
    });
    // Every slot whose zone changed in this deal gets a new stamp, and respawns itself at its new home.
    const { stamps, changed } = slot.stamper.stamp(slot.population);
    slot.restamped = changed;
    slot.homes = pickSlotHomes(field, slot.population, stamps);
    slot.populationKey = key;
    slot.placed = false;
    return true;
  }

  /** Rewrite the shared zone buffer (field + every engine's homes) and re-point each engine at it. */
  function placeAll(field) {
    const buffer = ensureZoneBuffer();
    const sections = specs.map((s) => slots.get(s.kind)?.homes ?? null);
    const result = buffer.write(field, sections);
    if (result?.truncated) {
      zone.truncated = true;
      log.warn(
        `${group}: zone field is larger than the shared buffer — nothing will draw (this should be unreachable)`
      );
    }
    specs.forEach((s, i) => {
      const slot = slots.get(s.kind);
      if (!slot?.engine) return;
      slot.engine.setZone({
        field: result?.truncated ? null : field,
        homesOffset: buffer.sectionOffsets[i],
        population: slot.population?.total ?? 0,
      });
      slot.placed = true;
    });
    zoneDirty = false;
  }

  /**
   * One frame.
   *
   * @param {*} renderer - REQUIRED; `renderer.compute()` has no other source.
   * @param {number} nowMs @param {number} dtSec - REAL seconds (flies are presentation, not world time).
   * @param {object} [worldRect] - the visible rect, for the perspective centre.
   * @param {object|null} [env] - the frame's env snapshot (`world/environment.js`).
   */
  function sync(renderer, nowMs, dtSec, worldRect, env = null) {
    // Standing down after a fault: the swarm is hidden and the frame goes on without it.
    if (fault && nowMs < fault.untilMs) return;
    profiler?.beginById(groupDef.syncZone);
    try {
      syncUnguarded(renderer, nowMs, dtSec, worldRect, env);
    } catch (err) {
      const message = String(err?.message ?? err);
      fault = { message, count: (fault?.count ?? 0) + 1, untilMs: nowMs + FAULT_RETRY_MS };
      hideAll();
      lastStatus = { group, zones: 0, engines: [] };
      // Once per distinct failure: a persistent one would otherwise print every few seconds forever.
      if (message !== lastFaultMessage) {
        lastFaultMessage = message;
        log.error(
          `${group}: ${message} — the swarm is hidden for ${FAULT_RETRY_MS / 1000} s, then it tries again`,
          err
        );
      }
    } finally {
      profiler?.endById(groupDef.syncZone);
    }
  }

  function syncUnguarded(renderer, nowMs, dtSec, worldRect, env) {
    const state = getRenderState() ?? {};
    const params = state.params ?? {};
    const wantsAny = specs.some((s) => (Number(params[s.perZoneParam]) || 0) > 0);
    if (!state.enabled || !renderer || !wantsAny) {
      hideAll();
      return;
    }
    const field = syncZone(state, nowMs);
    if (!field || zone.truncated) {
      hideAll();
      lastStatus = { group, zones: 0, engines: [] };
      return;
    }
    const tier = Number.isFinite(state.perfTier) ? state.perfTier : CRITTER_DEFAULT_TIER;
    const gridPx = Number.isFinite(state.gridPx) && state.gridPx > 0 ? state.gridPx : 100;

    // ── build / re-population ──
    for (const spec of specs) {
      const wants = (Number(params[spec.perZoneParam]) || 0) > 0;
      if (!wants && !slots.get(spec.kind)?.engine) continue;
      const slot = ensureEngine(spec, tier);
      if (syncPopulation(slot, field, params, gridPx)) zoneDirty = true;
    }
    // A fresh engine, a new field or a changed head-count all land here: ONE write, then every engine re-pointed.
    if (zoneDirty || [...slots.values()].some((s) => s.engine && !s.placed)) placeAll(field);

    // ── sky-dependent values, only when they moved ──
    let shadow = null;
    if (group === 'smellyFlies') {
      const key = [
        env?.sun?.elevationDeg?.toFixed?.(2),
        env?.sun?.azimuthDeg?.toFixed?.(2),
        env?.sun?.dayFactor01?.toFixed?.(3),
        env?.weather?.cloudCover01?.toFixed?.(2),
        params.flyHeight,
        params.shadowStrength,
      ].join('|');
      if (key !== lastShadowKey) {
        lastShadowKey = key;
        shadowValues = flyShadowFromSky(env, params);
      }
      shadow = shadowValues;
    }
    const expectedDepth =
      typeof resolveExpectedDepth === 'function' ? resolveExpectedDepth(Number(state.elevation) || 0) : 0;

    // ── activity, params, step ──
    let any = false;
    const engines = [];
    for (const spec of specs) {
      const slot = slots.get(spec.kind);
      if (!slot?.engine || !slot.population || slot.population.total === 0) {
        slot?.engine?.setActive(0);
        continue;
      }
      const target = spec.activity(env, params);
      // Born at its target: a scene that loads at dusk opens with its colony, not an empty field that fills.
      slot.activity = slot.activity === null ? target : approach(slot.activity, target, dtSec, spec.tauSec);
      slot.engine.setActive(activeSlotCount(slot.activity, slot.population.total));

      if (
        params !== slot.lastParams ||
        shadow !== slot.lastShadow ||
        expectedDepth !== slot.lastDepth ||
        !slot.pushed
      ) {
        const values = critterUniformValues(spec.kind, params, shadow);
        values.expectedDepth = expectedDepth;
        slot.engine.setParams(values);
        slot.lastParams = params;
        slot.lastShadow = shadow;
        slot.lastDepth = expectedDepth;
        slot.pushed = true;
      }
      slot.engine.step(renderer, { dtSec, tMs: nowMs, worldRect });
      any = any || slot.engine.hasContent;
      engines.push({
        kind: spec.kind,
        tier: slot.tier,
        population: slot.population.total,
        activity: Number(slot.activity.toFixed(3)),
        // how many slots the last deal moved to another zone (each respawned itself at its new home)
        restamped: slot.restamped ?? 0,
      });
    }
    scene.visible = any;
    hasContent = any;
    lastStatus = {
      group,
      zones: field.zones.length,
      fieldCells: field.cols * field.rows,
      fieldBuilds: zone.builds,
      fieldSkips: zone.skips,
      engines,
    };
  }

  return {
    scene,
    sync,
    get hasContent() {
      return hasContent;
    },
    getStatus: () => ({
      ...lastStatus,
      fault: fault ? { message: fault.message, count: fault.count } : null,
      perEngine: [...slots.values()].map((s) => s.engine?.debugState?.() ?? null),
    }),
    dispose() {
      // The ARENA is not freed — a storage buffer cannot be (`particle-arena.js`), and the shared pool is kept
      // on purpose so the next viewer reuses it — but everything the renderer holds for an engine is.
      for (const s of slots.values()) {
        if (!s.engine) continue;
        scene.remove(s.engine.scene);
        s.engine.dispose?.();
      }
      slots.clear();
      zone.field = null;
      zone.key = '';
      hasContent = false;
    },
  };
}
