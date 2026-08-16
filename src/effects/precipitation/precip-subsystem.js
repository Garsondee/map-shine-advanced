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
import { createMantleRuntime } from './mantle-runtime.js';
import { createPrecipCurtain } from './curtain-render.js';
import { createPrecipDripEngine } from '../particles/precip-drip-runtime.js';
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
  hail: 'hail', // P5 — §4.4's phase machine
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
  // ── THE MANTLE (P3) ──
  /** The ALLOCATOR DOOR for the mantle's ping-pong pair, injected exactly as
   * `effects/fluid` takes `createSimRenderTarget`. Absent ⇒ no mantle, and the
   * subsystem says so in `getStatus()` rather than half-building one. */
  createMantleTarget = null,
  disposeMantleTarget = null,
  /**
   * `(quad, target) => void` — the viewer's own bind/render/restore for the
   * mantle's integrator. Injected for the same reason the target factory is:
   * `renderer-state/graph-only` walls `effects/` from renderer state, because
   * a zone that binds a target owes every other zone a restore it cannot be
   * trusted to make.
   */
  renderMantleStep = null,
  /**
   * Called ONCE with the mantle's two overlay meshes, so the caller can add
   * them to the WORLD scene.
   *
   * ⚠️ THE SUBSYSTEM DOES NOT REACH INTO THE SCENE ITSELF. The mantle has to
   * draw INSIDE the world's flat sort (over ground art, under tokens — see
   * `mantle-runtime.js`'s `renderOrder` note), and only the viewer owns that
   * list. A subsystem that grabbed `scene` would be a second authority over
   * draw order.
   */
  onMantleMeshes = null,
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
  /** @type {Map<string, object>} speciesId → IMPRESSION curtain (P4). */
  const curtains = new Map();
  let activeSpeciesId = null;
  /**
   * ⭐ THE ZOOM GATE (P4, §3.4 job 1 + Effects.md Law 7). False when bodies are
   * smaller than the species' `zoomSleepPxPerBody` on screen — the specimen
   * tier then SLEEPS and the curtain carries the picture alone.
   */
  let specimenAwake = true;
  let lastZoom = null;
  let lastReason = null;
  const seededEngines = new Set();
  const seededSplashEngines = new Set();
  /** The floor's baked sky-reach texture + its world rect, held so an engine
   * built LATER (a species that first appears mid-session) still gets it. */
  let skyReach = { texture: null, rect: null };
  let fireMask = { texture: null, rect: null };
  let lastTuning = null;
  /** ONE mantle, for the floor currently in view. Built lazily on the first
   * frame that has real scene bounds — the buffer is sized from them, so
   * building earlier would size it from a placeholder. */
  let mantle = null;
  /** Set by `notifyFloorChanged`, consumed by the next `stepMantle` — see that
   * method for why the seed cannot run at the call site. */
  let pendingReseed = null;
  /** Which floor's mask the gate currently holds — `null` until a bake says. */
  let gateFloorIndex = null;
  /** ⭐ THE ROOFLINE (P5). ONE engine — unlike the fall/splash/curtain there is
   * nothing species-specific about a drip: water off an eave is water off an
   * eave whether the sky is sending rain or sleet. Snow does not drip (it
   * settles), which the rate below expresses by reading `precip01` only while a
   * LIQUID species is falling. */
  let drips = null;
  let dripReason = 'no roofline supplied yet';
  let mantleReason =
    createMantleTarget && renderMantleStep
      ? 'not built yet — waiting for scene bounds'
      : 'no target allocator or render step injected';

  /**
   * ⭐ Build one species' curtain on first use. Sized from the SCENE bounds, so
   * like the mantle it waits for them rather than being built against a
   * placeholder rect it would then have to rebuild.
   */
  function curtainFor(speciesId, sceneBounds) {
    if (curtains.has(speciesId)) return curtains.get(speciesId);
    if (!sceneBounds || !(sceneBounds.maxX > sceneBounds.minX)) return null;
    const curtain = createPrecipCurtain({
      THREE,
      speciesId,
      worldRect: sceneBounds,
      // BETWEEN the splashes (renderOrder-1) and the falling bodies
      // (renderOrder): the curtain is the FAR rain, the bodies are the NEAR
      // rain. See its own header.
      renderOrder: renderOrder - 0.5,
      openSkyTexture,
    });
    if (skyReach.texture) curtain.setSkyReachTexture(skyReach.texture, skyReach.rect);
    if (lastTuning) curtain.setTuning(lastTuning);
    curtains.set(speciesId, curtain);
    log.info(`built '${speciesId}' curtain over the scene rect`);
    return curtain;
  }

  /**
   * ⭐ THE ZOOM GATE — is a body big enough on screen to be worth drawing?
   *
   * §3.4 job 1: zoomed out until drops are sub-pixel, the specimen tier sleeps
   * and the curtain alone says *"raining over there"*. This is what makes that
   * a JS `if` rather than a uniform set to zero (Effects.md Law 7), and it is
   * what kills zoom-out mush BY DESIGN: what you see at distance was never made
   * of dots.
   *
   * ⚠️ FAILS **AWAKE**. With no viewport width reported there is no way to
   * know how big a body is, and the honest answer to "should I stop drawing the
   * rain" without evidence is NO — an absent measurement must not silently
   * delete the weather.
   */
  function updateZoomGate(species, viewRect, viewportWidthPx) {
    if (!species || !viewRect || !(viewportWidthPx > 0)) {
      specimenAwake = true;
      lastZoom = null;
      return;
    }
    const worldPxPerScreenPx = Math.max(1e-6, (viewRect.maxX - viewRect.minX) / viewportWidthPx);
    // The body's WIDEST dimension — `zoomSleepPxPerBody` is calibrated against
    // sub-pixel widths (rain 0.6, snow 1.2), which is why a streak's LENGTH is
    // deliberately not what is measured: a streak stays legible as a line long
    // after its width has vanished, and it is the width that aliases.
    const screenPxPerBody = species.body.sizePx[1] / worldPxPerScreenPx;
    specimenAwake = screenPxPerBody >= species.zoomSleepPxPerBody;
    lastZoom = { worldPxPerScreenPx, screenPxPerBody, threshold: species.zoomSleepPxPerBody, awake: specimenAwake };
  }

  /**
   * The frame's response scalars — ONE resolve, every consumer.
   *
   * ⚠️ THE CURTAIN READS THE SAME ONE, which is what keeps `veil01` and the
   * body count describing the same weather. Two resolves is two opinions about
   * how hard it is raining, free to disagree by a frame.
   */
  function frameFor(species, weather, st, precip01) {
    return resolveSpeciesFrame(
      species,
      {
        precip01,
        stormActivity01: weather.stormActivity01 ?? 0,
        dayFactor01: st.dayFactor01 ?? 1,
        flash01: st.flash01 ?? 0,
      },
      st.tierScale ?? 1
    );
  }

  /** Advance the roofline. Cheap when there is no roofline and no tail. */
  function stepDrips(renderer, dtRealSec, nowMs, precip01, st, weather, viewRect) {
    if (!drips) return;
    // ⚠️ THE CAMERA CENTRE, EVERY FRAME. M(h) magnifies ABOUT it, so a stale
    // centre makes every drip converge on where the camera used to be — the
    // same push the fall engine already gets from `setWorldRect`.
    if (viewRect) drips.setCamera((viewRect.minX + viewRect.maxX) / 2, (viewRect.minY + viewRect.maxY) / 2);
    const species = PRECIP_SPECIES.rain;
    drips.setFrame(dtRealSec, precip01, frameFor(species, weather, st, Math.max(precip01, 0.001)));
    if (!drips.hasContent) return;
    drips.step(renderer, dtRealSec, nowMs, getWindHandle());
  }

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

  /**
   * Build the mantle on the first frame that has real scene bounds, then step
   * it. Called EVERY frame; the runtime's own cadence decides when work
   * actually happens.
   */
  function stepMantle(dtRealSec, st, weather, precip01) {
    if (!createMantleTarget || !renderMantleStep) return;
    const bounds = st.sceneBounds ?? null;
    if (!mantle) {
      if (!bounds || !(bounds.maxX > bounds.minX)) {
        mantleReason = 'waiting for scene bounds';
        return;
      }
      mantle = createMantleRuntime({
        THREE,
        createTarget: createMantleTarget,
        disposeTarget: disposeMantleTarget,
        renderStep: renderMantleStep,
        worldRect: bounds,
        openSkyTexture,
      });
      mantle.setMasks({ skyReach, fireMask });
      if (lastTuning) mantle.setTuning(lastTuning);
      onMantleMeshes?.(mantle.meshes);
      mantleReason = null;
      log.info(`built the mantle (${mantle.texW}×${mantle.texH} texels over the scene rect)`);
    }

    // A floor change queued a re-derive — run it now that a render step is in
    // hand. See `notifyFloorChanged`.
    if (pendingReseed) {
      mantle.seed({ ...pendingReseed });
      log.info(`mantle re-seeded for floor ${pendingReseed.floorIndex}`);
      pendingReseed = null;
    }

    // ⚠️ THE **DERIVED** SPECIES DECIDES WHAT ACCUMULATES, not the falling
    // engine — which is why this resolves the kind again rather than reading
    // `activeSpeciesId`. On a clear day nothing is falling and `activeSpeciesId`
    // is null, but the mantle still needs a `stay` of null to keep melting; and
    // during a thaw the ground remembers snow while rain is what is falling.
    const kind = resolveActiveSpecies(weather.precipKind ?? 'rain', weather.precipMixWeight ?? 0);
    const stay = precip01 > 0 && kind.speciesId ? (PRECIP_SPECIES[kind.speciesId].stay ?? null) : null;
    mantle.setSurface(stay);
    mantle.step(dtRealSec, st.todHour, {
      stay,
      precip01,
      temperature01: weather.temperature01 ?? 0.55,
      cloudCover01: weather.cloudCover01 ?? 0,
    });
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

      // ⭐ THE MANTLE STEPS FIRST, AND **BEFORE** THE CLEAR-DAY EARLY-OUT BELOW.
      //
      // ⚠️ THAT ORDER IS LOAD-BEARING. Everything else in this subsystem is
      // allowed to stop dead when `precip01` hits zero — that is LAW 5, and a
      // clear day must cost nothing. The mantle is the exception, because its
      // whole subject is what happens AFTER the weather: snow melts, puddles
      // dry, footprints heal. Returning early would freeze the world's memory
      // at whatever the last rainy frame left, and a scene would carry its
      // snow through a summer.
      stepMantle(dtRealSec, st, weather, precip01);

      // ⭐ THE DRIPS STEP **BEFORE** THE CLEAR-DAY EARLY-OUT, like the mantle and
      // for the same reason: their whole character is the TAIL that outlives the
      // rain by minutes. Returning early on `precip01 === 0` would silence the
      // roofline the instant the sky cleared, which is precisely the signal
      // §4.3 says is the cheapest "the world is wet" cue there is.
      //
      // ⚠️ LIQUID ONLY. Snow settles on a roof, it does not run off it, so the
      // tail is fed by rain and sleet and never by a blizzard.
      const liquid = (weather.precipKind ?? 'rain') !== 'snow';
      stepDrips(renderer, dtRealSec, nowMs, liquid ? precip01 : 0, st, weather, worldRect ?? st.worldRect ?? null);

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

      const species = PRECIP_SPECIES[speciesId];
      const rectForZoom = worldRect ?? st.worldRect ?? null;
      updateZoomGate(species, rectForZoom, st.viewportWidthPx);

      // ⭐ THE CURTAIN (P4) — stepped whether or not the specimens are awake,
      // because it is what carries the picture when they are not.
      const curtain = curtainFor(speciesId, st.sceneBounds ?? null);
      if (curtain) {
        curtain.setFrame(frameFor(species, weather, st, precip01));
        curtain.step(nowMs, getWindHandle());
      }

      // ⚠️ THE SPECIMEN TIER SLEEPS AS A JS `if` — no engine built, no kernel
      // dispatched, no draw submitted (Effects.md Law 7). A uniform set to zero
      // would still pay the dispatch and the fill, which is exactly the cost
      // the zoom gate exists to avoid.
      if (!specimenAwake) return;

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
      // ⚠️ RESOLVED ONCE AND HANDED TO EVERY CONSUMER. The splash rate is not a
      // second opinion about how much rain there is — it is THE SAME NUMBER
      // the drops are drawn from, so the carpet thins exactly as the curtain
      // does. A private curve here could disagree with what the player can see
      // falling, which is the `feedback_shared_field_two_meanings_two_
      // registries` shape wearing a raincoat.
      const frame = frameFor(species, weather, st, precip01);
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
      const out = [];
      // ⚠️ THE DRIPS ARE CHECKED EVEN WITH NO ACTIVE SPECIES. A first cut
      // early-returned here on `!activeSpeciesId`, which is TRUE the moment the
      // rain stops — and that is exactly when the tail is the only thing left
      // to draw. The one layer whose whole purpose is outliving the weather
      // cannot be gated on the weather.
      if (!activeSpeciesId) {
        if (drips?.hasContent) out.push(drips.scene);
        return out;
      }
      // GROUND → FAR AIR → NEAR AIR. Splashes lie on the map; the curtain is
      // the rain in the distance; the bodies are the rain in front of you.
      const splash = splashEngines.get(activeSpeciesId);
      if (splash?.ok && splash.debugState().visible) out.push(splash.scene);
      const curtain = curtains.get(activeSpeciesId);
      if (curtain?.hasContent) out.push(curtain.scene);
      const fall = engines.get(activeSpeciesId);
      if (fall?.debugState().visible) out.push(fall.scene);
      // ⭐ THE ROOFLINE LAST — nearest the eye. A drip hangs off an edge that is
      // ABOVE the viewed floor, so it is in front of the rain falling past it,
      // and it must keep drawing when nothing else does (the tail).
      if (drips?.hasContent) out.push(drips.scene);
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
    setSkyReachTexture(texture, rect, floorIndex = null) {
      skyReach = { texture: texture ?? null, rect: rect ?? null };
      if (floorIndex !== null) gateFloorIndex = floorIndex;
      const results = {};
      for (const [id, engine] of engines) results[id] = engine.setSkyReachTexture(texture, rect);
      // ⚠️ THE ARRIVAL ENGINES TOO. Both read the same mask and both would
      // otherwise be armed independently — a fall gated on this floor while
      // its splashes still used the last floor's bake is exactly the kind of
      // half-applied state that reads as "the gate is flaky".
      for (const [id, engine] of splashEngines) results[`${id}:arrive`] = engine.setSkyReachTexture(texture, rect);
      // The mantle gates ACCUMULATION on the same mask — snow must not pile up
      // under a roof any more than it may fall through one.
      if (mantle) results.mantle = mantle.setMasks({ skyReach, fireMask });
      // The curtain gates on the same mask — a veil over a hall is rain the
      // player can see indoors just as surely as a drop is.
      for (const [id, c] of curtains) results[`${id}:curtain`] = c.setSkyReachTexture(texture, rect);
      return results;
    },

    /**
     * ⭐ THE FIRE MASK — the mantle's melt halo (§5.2). Nothing else in
     * precipitation reads it.
     *
     * ⚠️ THE HALO COSTS NOTHING TO AUTHOR: the fire mask's own falloff IS the
     * halo's shape, so a hearth clears its own ring of snow and nobody draws
     * one. Disarming leaves NO fire anywhere, which is the fail-open direction
     * here — absent data must not melt a map.
     */
    setFireMaskTexture(texture, rect) {
      fireMask = { texture: texture ?? null, rect: rect ?? null };
      return mantle ? mantle.setMasks({ skyReach, fireMask }) : { sky: false, fire: false };
    },

    /**
     * ⭐ THE ROOFLINE, from `drip-edges.js#extractDripEdges`. Call on floor
     * change or when the mask authority's products version moves; NEVER per
     * frame. Handing `null` or an empty set silences the drips, which is the
     * correct answer for a floor with nothing overhead — a rooftop's eaves are
     * below you, not above.
     */
    setDripEdges(edges) {
      if (!edges || !(edges.count > 0)) {
        dripReason = 'no roof edges on this floor';
        drips?.setSpawnPoints({ points: new Float32Array(0), count: 0 });
        return { count: 0, reason: dripReason };
      }
      if (!drips) {
        drips = createPrecipDripEngine({ THREE, renderOrder: renderOrder + 1 });
        if (lastTuning) drips.setTuning(lastTuning);
      }
      dripReason = null;
      return drips.setSpawnPoints(edges);
    },

    /**
     * ⭐ THE VIEWED FLOOR CHANGED — re-derive everything that belongs to a floor.
     *
     * ⚠️ THE MANTLE IS THE ONLY THING HERE THAT HOLDS FLOOR-SPECIFIC STATE.
     * The fall, the splashes and the curtain are stateless with respect to the
     * floor: they re-read the sky-reach texture the viewer just re-baked and
     * are correct on the next frame. The mantle is a BUFFER — its texels are
     * this floor's snow — so without this the roof would wear the courtyard's
     * drifts.
     *
     * Re-seeding rather than clearing, because §5.5's derive-from-weather IS
     * the mantle's normal load path (it is deliberately never serialized), so a
     * floor change lands on a floor whose snow already looks like the weather
     * that has been falling on it.
     */
    notifyFloorChanged(floorIndex) {
      if (!mantle) return { reseeded: false, reason: 'no mantle built yet' };
      const st = getPrecipRenderState?.() ?? null;
      const weather = st?.weather ?? {};
      const precip01 = Number.isFinite(weather.precip01) ? weather.precip01 : 0;
      const kind = resolveActiveSpecies(weather.precipKind ?? 'rain', weather.precipMixWeight ?? 0);
      const stay = precip01 > 0 && kind.speciesId ? (PRECIP_SPECIES[kind.speciesId].stay ?? null) : null;
      // ⚠️ THE SEED IS DEFERRED TO THE NEXT `sync`, NOT RUN HERE. This is
      // called from the viewer's mask-rebake chokepoint, which is not inside a
      // render pass — and the seed needs the injected render step. Flagging it
      // keeps the renderer-state discipline intact instead of reaching for a
      // renderer this zone is walled from.
      pendingReseed = { floorIndex, stay, precip01, temperature01: weather.temperature01 ?? 0.55 };
      return { reseeded: 'pending', floorIndex };
    },

    /** Live look tuning, for the debug panel and the console. Both engine
     * families read the same object; each picks out the keys it owns. */
    setTuning(t) {
      lastTuning = { ...(lastTuning ?? {}), ...(t ?? {}) };
      for (const engine of engines.values()) engine.setTuning(t);
      for (const engine of splashEngines.values()) engine.setTuning(t);
      mantle?.setTuning(t);
      drips?.setTuning(t);
      for (const curtain of curtains.values()) curtain.setTuning(t);
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
        /** ⭐ THE STAY (P3), reported separately again — the mantle runs on a
         * clear day when both the other families are switched off entirely, so
         * folding it into their status would make "nothing is falling" look
         * like "nothing is happening". */
        mantle: mantle ? mantle.debugState() : { built: false, reason: mantleReason },
        /** ⭐ THE IMPRESSION TIER (P4), reported separately — the whole point of
         * the zoom gate is that the specimen and impression tiers are live at
         * DIFFERENT times, so one merged "is precipitation visible" would hide
         * which one is carrying the picture. */
        curtain: Object.fromEntries([...curtains].map(([id, c]) => [id, c.debugState()])),
        zoom: lastZoom ? { ...lastZoom } : { awake: specimenAwake, reason: 'no viewport width reported — fails awake' },
        /** ⭐ WHICH FLOOR THE LAW 3 GATE IS ACTUALLY ON. Reported because its
         * ABSENCE is what let a stale gate survive three slices: every status
         * field said "armed", none said "armed against WHAT", and a mask baked
         * for the ground floor looks identical to a correct one from here
         * (`feedback_instruments_must_not_lie`). */
        gateFloor: gateFloorIndex,
        /** ⭐ THE ROOFLINE (P5), reported separately — it is the one layer that
         * runs when everything else is off, so folding it into the rest would
         * make "still dripping four minutes after the rain" look like "the
         * precipitation axis is stuck". */
        drips: drips ? drips.debugState() : { built: false, reason: dripReason },
      };
    },
  };
}
