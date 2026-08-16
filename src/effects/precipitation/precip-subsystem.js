/**
 * PRECIPITATION SUBSYSTEM — the lifecycle shell around the FALL runtime
 * (Precipitation.md §8).
 *
 * ============================================================================
 * WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT
 * ============================================================================
 *
 * It owns: which species engines exist, which one is live this frame (derived
 * from `env.weather.precipKind`), pushing the per-frame response scalars into
 * them, and the view rect. It is the mirror of `effects/fire/fire-subsystem.js`
 * — a thin coordinator whose runtime lives in `effects/particles/` because the
 * `particles/allocator-only` wall requires every `instancedArray` call to.
 *
 * ⚠️ TWO ENGINE FAMILIES PER SPECIES, NOT ONE (P2). The FALL
 * (`precip-runtime.js`) and the ARRIVAL (`precip-splash-runtime.js`) are
 * separate engines with separate arenas and separate scenes, coordinated here:
 * one resolved frame drives both, one sky-reach texture arms both, and the
 * `scenes` getter fixes their DRAW ORDER, which is the one thing neither
 * engine can settle for itself.
 *
 * ⚠️ ITS HEADER USED TO SAY *"it does not yet draw into the live frame"*. That
 * was true for exactly one slice and is now false in two ways — the gate
 * shipped, and so did the draw. Recorded rather than silently deleted because
 * a stale "not yet" is the most expensive comment in a codebase: it tells a
 * reader not to look (`feedback_plausible_diagnosis_rots`). What LAW 3 demanded
 * — *"rain indoors is unrepresentable, not discouraged"* — is now enforced by
 * `scene/sky-reach-access.js`'s bake, sampled by BOTH engines.
 *
 * @module effects/precipitation/precip-subsystem
 */
import { createPrecipEngine } from '../particles/precip-runtime.js';
import { createPrecipSplashEngine } from '../particles/precip-splash-runtime.js';
import { PRECIP_SPECIES, PRECIP_SPECIES_IDS, resolveSpeciesFrame, isBuiltSpecies } from './precip-species.js';
import { createLogger } from '../../core/log.js';

const log = createLogger('precip-subsystem');

/**
 * Which BUILT species a derived `precipKind` renders as.
 *
 * ⚠️ `sleet` MAPS TO A PAIR, NOT TO A ROW — it is a blend (Precipitation.md
 * §2.2), and the manager already hands us `precipMixWeight` telling us how much
 * of the COLD half is in it. P1 renders the dominant half and records the gap;
 * P5 splits the population per-particle by seed, which is the real answer.
 * Mapping it to `snow` outright would make a 0.49-weight sleet render as pure
 * rain and a 0.51 as pure snow — a hard flip in the middle of the band the
 * band exists to smooth.
 */
const KIND_TO_SPECIES = Object.freeze({
  rain: 'rain',
  snow: 'snow',
  sleet: null, // resolved by mix weight — see resolveActiveSpecies
  hail: null, // P5
  ash: null, // P6
  embers: null, // P6
});

/**
 * Which species should draw, given what the manager says is falling.
 * @param {string} precipKind @param {number} mixWeight
 * @returns {{speciesId: string|null, reason: string|null}}
 */
export function resolveActiveSpecies(precipKind, mixWeight = 0) {
  if (precipKind === 'sleet') {
    // The dominant half, until P5 can genuinely interleave both populations.
    return { speciesId: mixWeight >= 0.5 ? 'snow' : 'rain', reason: 'sleet renders as its dominant half until P5' };
  }
  const mapped = KIND_TO_SPECIES[precipKind];
  if (mapped && isBuiltSpecies(mapped)) return { speciesId: mapped, reason: null };
  if (Object.hasOwn(KIND_TO_SPECIES, precipKind)) {
    return { speciesId: null, reason: `'${precipKind}' is a real kind but its species is not built yet` };
  }
  return { speciesId: null, reason: `unknown precip kind '${precipKind}'` };
}

/**
 * @param {object} deps
 * @param {*} deps.THREE
 * @param {() => object} deps.getPrecipRenderState - the seam, mirroring
 *   `getFireRenderState`/`getLightningRenderState`: returns
 *   `{enabled, weather, worldRect, dayFactor01, tierScale}` each frame. A
 *   FUNCTION rather than a pushed object, so the subsystem never holds a stale
 *   snapshot and `boot.js` stays the composition root.
 * @param {object} [deps.windHandle]
 * @param {number} [deps.pxPerMeter]
 * @returns {object}
 */
export function createPrecipitationSubsystem({
  THREE,
  getPrecipRenderState,
  // ⚠️ GETTERS, NOT VALUES, AND THIS IS A TDZ FIX WITH A LIVE FAILURE BEHIND
  // IT. A first cut took `windHandle`/`pxPerMeter` as plain values. Both are
  // declared FURTHER DOWN `startVtPanViewer` than this factory is called, so
  // reading them here threw `ReferenceError: Cannot access 'windHandle' before
  // initialization` — the whole renderer failed to start and fell back to
  // Foundry's.
  //
  // ⚠️ 10,204 GREEN ASSERTIONS AND A CLEAN esbuild BUNDLE DID NOT SEE IT. That
  // is `feedback_bundling_does_not_prove_construction_order` exactly: bundling
  // proves the imports resolve, not that the declarations run in an order that
  // works. Only booting the real thing found it. Every sibling subsystem here
  // takes `getWindHandle`/`getPxPerMeter` closures for precisely this reason,
  // and the arrow is not invoked until an engine is first built.
  getWindHandle = () => null,
  getPxPerMeter = () => 100,
  openSkyTexture = null,
  renderOrder = 0,
}) {
  /** @type {Map<string, object>} speciesId → FALL engine, built lazily. */
  const engines = new Map();
  /**
   * @type {Map<string, object>} speciesId → ARRIVAL engine (P2), built lazily.
   *
   * ⚠️ A SECOND MAP, NOT A FIELD ON THE FALL ENGINE. The two are separate
   * engines with separate arenas (`precip-splash-runtime.js` argues why), and a
   * species that does not splash — snow — gets an entry that reports
   * `ok: false` and is never stepped, rather than no entry at all. That
   * distinction is what makes "snow has no splashes" a MEASUREMENT in
   * `getStatus()` instead of an absence somebody has to interpret
   * (`feedback_absent_zone_row_is_a_measurement`).
   */
  const splashEngines = new Map();
  let activeSpeciesId = null;
  let lastReason = null;
  const seededEngines = new Set();
  const seededSplashEngines = new Set();
  /** The floor's baked sky-reach texture + its world rect, held so an engine
   * built LATER (a species that first appears mid-session) still gets it. */
  let skyReach = { texture: null, rect: null };
  let lastTuning = null;

  /** Build one species' engine on first use — a clear map never allocates. */
  function engineFor(speciesId) {
    if (engines.has(speciesId)) return engines.get(speciesId);
    const engine = createPrecipEngine({
      THREE,
      speciesId,
      // Resolved HERE, at first engine build — long after `startVtPanViewer`
      // has finished declaring them. See the constructor's own TDZ note.
      windHandle: getWindHandle() ?? undefined,
      pxPerMeter: getPxPerMeter() ?? 100,
      renderOrder,
      openSkyTexture,
    });
    // ⚠️ A LATE-BUILT ENGINE MUST INHERIT THE CURRENT STATE. Engines are built
    // lazily (a clear map allocates nothing), so `snow` may first appear hours
    // into a session — long after the floor's sky-reach texture was baked and
    // the author moved the look dials. Replaying both here is what stops a
    // species switch from arriving ungated and untuned; the alternative is a
    // burst of rain through every roof for one frame, which is precisely the
    // kind of thing nobody reproduces on demand.
    if (skyReach.texture) engine.setSkyReachTexture(skyReach.texture, skyReach.rect);
    if (lastTuning) engine.setTuning(lastTuning);
    engines.set(speciesId, engine);
    log.info(`built '${speciesId}' engine (capacity ${engine.capacity})`);
    return engine;
  }

  /**
   * Build one species' ARRIVAL engine on first use.
   *
   * ⚠️ THE SAME REPLAY OF CURRENT STATE AS THE FALL, and it is not copy-paste
   * caution: the splash gate is the SAME sky-reach texture, and a splash
   * carpet arriving ungated for one frame puts water on the floor of every
   * building — a more obviously wrong picture than ungated rain, because
   * indoor floors are exactly where the eye is.
   */
  function splashEngineFor(speciesId) {
    if (splashEngines.has(speciesId)) return splashEngines.get(speciesId);
    const engine = createPrecipSplashEngine({
      THREE,
      speciesId,
      windHandle: getWindHandle() ?? undefined,
      // ⚠️ BEHIND the fall, deliberately. Splashes are ON the ground and the
      // rain is between them and the eye; drawing them after would put water
      // in front of the drops that caused it.
      renderOrder: renderOrder - 1,
      openSkyTexture,
    });
    if (skyReach.texture) engine.setSkyReachTexture(skyReach.texture, skyReach.rect);
    if (lastTuning) engine.setTuning(lastTuning);
    splashEngines.set(speciesId, engine);
    log.info(`built '${speciesId}' arrival engine (splashes: ${engine.ok}, capacity ${engine.capacity})`);
    return engine;
  }

  return {
    /**
     * Advance one frame. Safe to call every frame from the moment the viewer
     * exists — with `precip01 = 0` it allocates nothing, steps nothing and
     * draws nothing (LAW 5's teeth).
     * @param {*} renderer @param {number} dtRealSec @param {number} nowMs
     */
    sync(renderer, dtRealSec, nowMs, worldRect) {
      const st = getPrecipRenderState?.() ?? null;
      if (!st || st.enabled === false) {
        activeSpeciesId = null;
        return;
      }
      const weather = st.weather ?? {};
      const precip01 = Number.isFinite(weather.precip01) ? weather.precip01 : 0;

      // ⚠️ A JS `if`, never a uniform set to zero (Effects.md Law 4). A clear
      // day must not allocate an engine, dispatch a kernel or submit a draw.
      if (!(precip01 > 0)) {
        activeSpeciesId = null;
        return;
      }

      const { speciesId, reason } = resolveActiveSpecies(weather.precipKind ?? 'rain', weather.precipMixWeight ?? 0);
      lastReason = reason;
      activeSpeciesId = speciesId;
      if (!speciesId) return;

      const engine = engineFor(speciesId);
      // ⚠️ PER-ENGINE, not one shared flag. A single `seeded` boolean meant the
      // FIRST species to run consumed it and every later one drew from
      // uninitialised buffers — every body at the world origin, which reads as
      // "snow is broken" rather than as a missing seed call.
      if (!seededEngines.has(speciesId)) {
        engine.init(renderer);
        seededEngines.add(speciesId);
      }
      // The rect comes in as a per-frame ARGUMENT rather than off the render
      // state, because the viewer computes it inside its frame loop — see the
      // note at `getPrecipRenderState`'s own `worldRect` in vt-pan-viewer.js.
      const rect = worldRect ?? st.worldRect ?? null;
      if (rect) engine.setWorldRect(rect);
      // The SCENE's bounds, distinct from the view rect above — rain must not
      // fall in the void around the map (the author saw exactly that on the
      // Mansion). Pushed per frame because it is one uniform write and a scene
      // change would otherwise need its own invalidation path.
      if (st.sceneBounds !== undefined) engine.setSceneBounds(st.sceneBounds);
      // ⚠️ RESOLVED ONCE AND HANDED TO BOTH ENGINES. The splash rate is not a
      // second opinion about how much rain there is — it is THE SAME NUMBER
      // the drops are drawn from, so the carpet thins exactly as the curtain
      // does. A private curve here could disagree with what the player can see
      // falling, which is the `feedback_shared_field_two_meanings_two_
      // registries` shape wearing a raincoat.
      const frame = resolveSpeciesFrame(
        PRECIP_SPECIES[speciesId],
        {
          precip01,
          stormActivity01: weather.stormActivity01 ?? 0,
          dayFactor01: st.dayFactor01 ?? 1,
          flash01: st.flash01 ?? 0,
        },
        st.tierScale ?? 1
      );
      engine.setFrame(frame);
      // ⚠️ THE HANDLE IS RE-READ EVERY FRAME, not captured at engine build.
      // `vt-pan-viewer.js`'s `windHandle` is reassigned when the wind field
      // bakes, and these engines are built lazily — so a captured reference
      // goes dead silently and the rain stops leaning. See the runtime's
      // `uWindSpeed01` note.
      engine.step(renderer, dtRealSec, nowMs, getWindHandle());

      // ── THE ARRIVAL (P2) ──
      // ⚠️ BUILT ONLY FOR A SPECIES THAT ACTUALLY SPLASHES. `createPrecipSplash
      // Engine` refuses on `arrive.kind !== 'splash'` and reports `ok: false`,
      // so snow allocates an engine that draws nothing — cheap, once, and it
      // keeps "snow has no splashes" answerable from `getStatus()`.
      const splash = splashEngineFor(speciesId);
      if (splash.ok) {
        if (!seededSplashEngines.has(speciesId)) {
          splash.init(renderer);
          seededSplashEngines.add(speciesId);
        }
        if (rect) splash.setWorldRect(rect);
        if (st.sceneBounds !== undefined) splash.setSceneBounds(st.sceneBounds);
        splash.setFrame(frame);
        splash.step(renderer, dtRealSec, nowMs, getWindHandle());
      }
    },

    /**
     * The scenes the draw pass renders, IN ORDER, or an empty array when
     * nothing is falling.
     *
     * ⚠️ PLURAL, AND THE ORDER IS THE POINT. Splashes are on the ground and
     * the rain is between them and the eye. `renderOrder` alone cannot settle
     * it — these are two SCENES, and THREE sorts within a scene, never across
     * two `render()` calls. The order this array is built in IS the depth
     * order, which is why it lives here rather than at the call site.
     */
    get scenes() {
      if (!activeSpeciesId) return [];
      const out = [];
      const splash = splashEngines.get(activeSpeciesId);
      if (splash?.ok && splash.debugState().visible) out.push(splash.scene);
      const fall = engines.get(activeSpeciesId);
      if (fall?.debugState().visible) out.push(fall.scene);
      return out;
    },

    /** The FALL's scene alone — kept for the shader lab, which renders the
     * curtain in isolation to measure streak geometry. */
    get scene() {
      return activeSpeciesId ? (engines.get(activeSpeciesId)?.scene ?? null) : null;
    },

    /**
     * Is there anything to draw at all? The frame loop's guard, mirroring
     * `fireSubsystem.hasContent` — a clear day must not submit a draw call
     * (Effects.md Law 4), and checking here keeps that decision in the
     * subsystem that knows rather than duplicated at the call site.
     */
    get hasContent() {
      return this.scenes.length > 0;
    },

    /**
     * Hand this floor's baked sky-reach texture to every engine — LAW 3's
     * input. Cheap and idempotent; call on floor switch or when the mask
     * authority's products version moves, NEVER per frame.
     * @param {*} texture @param {object} rect
     */
    setSkyReachTexture(texture, rect) {
      skyReach = { texture: texture ?? null, rect: rect ?? null };
      const results = {};
      for (const [id, engine] of engines) results[id] = engine.setSkyReachTexture(texture, rect);
      // ⚠️ THE ARRIVAL ENGINES TOO. Both read the same mask and both would
      // otherwise be armed independently — a fall gated on this floor while
      // its splashes still used the last floor's bake is exactly the kind of
      // half-applied state that reads as "the gate is flaky".
      for (const [id, engine] of splashEngines) results[`${id}:arrive`] = engine.setSkyReachTexture(texture, rect);
      return results;
    },

    /** Live look tuning, for the debug panel and the console. Both engine
     * families read the same object; each picks out the keys it owns. */
    setTuning(t) {
      lastTuning = { ...(lastTuning ?? {}), ...(t ?? {}) };
      for (const engine of engines.values()) engine.setTuning(t);
      for (const engine of splashEngines.values()) engine.setTuning(t);
    },

    /**
     * What the debug panel and the perf report print. Every factor separately
     * (`feedback_count_silent_preconditions`) — "no rain is visible" has half a
     * dozen possible causes and a single boolean would name none of them.
     */
    getStatus() {
      const st = getPrecipRenderState?.() ?? null;
      const engine = activeSpeciesId ? engines.get(activeSpeciesId) : null;
      return {
        wired: true,
        // ⚠️ EVERY FACTOR, NOT ONE BOOLEAN. "No rain is visible" has half a
        // dozen causes — disabled, precip01 zero, an unbuilt species, the sky
        // gate covering the view, a zero live count — and a single flag names
        // none of them (`feedback_count_silent_preconditions`).
        skyGate: engine?.debugState().skyGate ?? null,
        hasContent: this.hasContent,
        enabled: st?.enabled !== false,
        precip01: st?.weather?.precip01 ?? null,
        precipKind: st?.weather?.precipKind ?? null,
        activeSpeciesId,
        reason: lastReason,
        builtEngines: [...engines.keys()],
        availableSpecies: PRECIP_SPECIES_IDS,
        engines: Object.fromEntries([...engines].map(([id, e]) => [id, e.debugState()])),
        /** ⭐ THE ARRIVAL, REPORTED SEPARATELY (P2). "No splashes" and "no
         * rain" are different failures with different causes, and one merged
         * block would name neither. */
        arrival: Object.fromEntries([...splashEngines].map(([id, e]) => [id, e.debugState()])),
      };
    },
  };
}
