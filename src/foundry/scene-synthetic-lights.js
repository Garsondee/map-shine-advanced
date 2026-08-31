/**
 * THE DOOR-REVEAL GAP — MSA's candles and fires light a room for MSA's OWN
 * renderer only. Foundry's native door-icon reveal (`DoorControl#isVisible`
 * → `canvas.visibility.testVisibility` → `DetectionModeLightPerception` →
 * `canvas.effects.testInsideLight`) never samples MSA's render at all — it
 * walks `canvas.effects.lightSources`, a live Foundry Collection populated
 * ONLY from real `AmbientLight`/token-light documents
 * (`foundry/scene-lights.js#readActiveLightSources` READS that collection,
 * it never writes to it). A room lit entirely by candles/fireplaces is
 * therefore pitch dark as far as Foundry's own vision math is concerned, so
 * a token standing beside a lit candle still can't see the door beside it —
 * reported live, confirmed even at point-blank range (author, 2026-08-31).
 *
 * THE FIX: mirror each candle/fire light descriptor MSA already computes
 * (`effects/candle-flame-geometry.js#buildCandleLightSources`,
 * `effects/fire/fire-subsystem.js`'s own `lightSources()`) into a REAL
 * `PointLightSource`, registered into `canvas.effects.lightSources` the
 * exact way a real `AmbientLight` does
 * (`client/canvas/placeables/light.mjs#initializeLightSource`:
 * `new sourceClass({sourceId, object}); source.initialize(data); source.add();`)
 * — except `object` is optional (`BaseEffectSource`'s own constructor:
 * `this.object = options.object ?? null`), so no fake placeable wrapper is
 * needed, and `.add()` is just `canvas.effects.lightSources.set(sourceId,
 * this)` (`base-effect-source.mjs`). This is FOUNDRY'S OWN documented
 * extension point, not a hack.
 *
 * CLIENT-LOCAL, NEVER PERSISTED — same authority shape as
 * [[keyhole-darkness-writeback-reversal]] (`canvas.environment.initialize`,
 * never `scene.update()`): every connected client independently computes the
 * SAME deterministic descriptors from the SAME anchor/fire-mask data, so
 * nothing is written to the saved scene, no `AmbientLightDocument` is
 * created, and no multiplayer feedback loop is possible. This is deliberate,
 * not a shortcut — light PLACEMENT is GM-authored world content
 * ([[keyhole-input-model-decision]], "Foundry owns ALL input"); this module
 * never touches it. It adds a RUNTIME-ONLY perception fact, the same
 * category of thing a token's own carried-torch light already is.
 *
 * NEVER VISUALLY DOUBLE-DRAWN — confirmed against
 * `foundry/canvas-compositing.js`: MSA sets `canvas.effects.renderable =
 * false` whenever it owns the frame, so Foundry's OWN PIXI lighting layer
 * (which would otherwise draw a mesh for every entry in
 * `canvas.effects.lightSources`, including these) never paints anything.
 * These sources exist purely as DATA for `testPoint()`/`testInsideLight()` —
 * geometry, never a draw call.
 *
 * DOUBLED RADIUS FOR DETECTION, VISUAL GLOW UNCHANGED — Foundry's detection
 * gate is a pure point-in-polygon test against a light's `dim`/`bright`
 * radius (`PointLightSource.testPoint`), NOT a brightness threshold
 * (verified against `detection-mode/light-perception.mjs` +
 * `groups/effects.mjs#testInsideLight`) — so "reaches far enough" is the
 * whole ask. `bright` is set to the candle/fire's own already-scaled visual
 * radius (matches what the player sees as lit); `dim` is
 * `DETECTION_RADIUS_MULTIPLIER` (2) times that — the author's own explicit
 * "up to double the normal radius" ask (2026-08-31) — for detection only.
 * `PointLightSource._initialize` sets its shape radius to `max(dim,bright)`,
 * so the door-reveal reach is exactly 2×; nothing about the rendered glow
 * (a completely separate number, in `point-light-pool.js`) moves at all.
 *
 * PIXELS, NOT GRID UNITS — verified against `light.mjs#_getLightSourceData`:
 * an AmbientLight placeable passes `dim: this.dimRadius, bright:
 * this.brightRadius` into `source.initialize()`, and those getters ALREADY
 * convert the authored grid-unit fields to pixels before a source ever sees
 * them (`foundry/scene-lights.js`'s own header confirms the inverse: a LIVE
 * source's `.radius` is pixel-ready). MSA's own descriptors
 * (`buildCandleLightSources`/`buildFireLightSources`) are pixel radii from
 * the start (`fireCirclePolygon`/`candleCirclePolygon`), so no grid-size
 * conversion belongs in this file at all — passing them straight through as
 * `dim`/`bright` is the CORRECT unit, not a shortcut past one.
 *
 * THROTTLED ON WALL TIME, NEVER SIM TIME — same mechanical bug this project
 * already paid for once
 * ([[keyhole-darkness-writeback-reversal]]'s "THROTTLE ON THE WRONG CLOCK"):
 * a throttle keyed on `env.time.tMs` (sim, freezes when Foundry pauses)
 * would latch shut forever the moment someone paused. `sync(nowMs)` must be
 * handed `env.time.realMs` by its caller — this module never reads a clock
 * itself (`core/frame-clock.js` is the one sanctioned door, and this is not
 * it — `tools/verify-structure.mjs`'s `time/one-clock` tripwire would fail
 * the build on a direct `performance.now()`/`Date.now()` here).
 *
 * Split pure-vs-live the same way every other `foundry/scene-*.js` reader
 * does: `buildVisionLightData`/`diffVisionLightState` are pure and
 * Node-tested; `createSceneSyntheticLights`'s returned `sync`/`dispose`
 * touch the live `canvas` global, guarded to a no-op wherever it is absent
 * (Node, or a frame before the canvas exists) and wrapped so a failure here
 * can never be what breaks the render loop.
 *
 * @module foundry/scene-synthetic-lights
 */

/** Namespaced so a synthetic id can never collide with a real Foundry
 * source's own `sourceId` format (`AmbientLight.<documentId>` etc.) or the
 * reserved `'globalLight'` id `scene-lights.js` already excludes. */
const SOURCE_ID_PREFIX = 'msa-vision:';

/**
 * How much further than the candle/fire's own visual radius its DETECTION
 * reach extends, for Foundry's own vision/door-reveal math only. The
 * author's own explicit ask (2026-08-31): "up to double the normal light
 * radius." A named constant, not a new FOH slider — nobody asked for a
 * second knob, they asked for the gap closed.
 */
export const DETECTION_RADIUS_MULTIPLIER = 2;

/** Wall-clock floor between syncs. Matches `DARKNESS_PUBLISH_MIN_INTERVAL_MS`'s
 * own reasoning (`foundry/scene-environment.js`): a door's revealed-ness has
 * no need of frame-perfect precision, and `canvas.perception.update()` is
 * real, measured cost this project already had to throttle once elsewhere. */
export const MIN_SYNC_INTERVAL_MS = 300;

/**
 * Build ONE synthetic light's Foundry-facing data from an MSA light
 * descriptor (candle or fire — both share this shape:
 * `{sourceId, x, y, elevation, radius}`, pixels). Pure.
 *
 * @param {object} descriptor
 * @returns {{sourceId:string, x:number, y:number, elevation:number, dim:number, bright:number}|null}
 *   `null` for anything not worth registering — no id, non-finite geometry,
 *   or a radius that resolves to zero/negative (a candle authored with no
 *   light, `buildCandleLightSources`' own "radius ≤0 emits nothing" rule).
 */
export function buildVisionLightData(descriptor) {
  if (!descriptor || typeof descriptor.sourceId !== 'string' || !descriptor.sourceId) return null;
  const x = Number(descriptor.x);
  const y = Number(descriptor.y);
  const radiusPx = Number(descriptor.radius);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radiusPx) || radiusPx <= 0) return null;
  const elevationRaw = Number(descriptor.elevation);
  const elevation = Number.isFinite(elevationRaw) ? elevationRaw : 0;
  return {
    sourceId: SOURCE_ID_PREFIX + descriptor.sourceId,
    x,
    y,
    elevation,
    bright: radiusPx,
    dim: radiusPx * DETECTION_RADIUS_MULTIPLIER,
  };
}

/**
 * Diff this frame's built descriptors against what was last actually
 * applied to a live source. Pure — `appliedById` is plain data (a `Map` or
 * plain object of `sourceId -> {x,y,elevation,dim,bright}`), never a live
 * `PointLightSource`, so this is fully Node-testable.
 *
 * @param {Array<object>} currentDescriptors - `buildVisionLightData` output, pre-filtered of `null`.
 * @param {Map<string,object>|Record<string,object>} appliedById
 * @returns {{toApply:Array<object>, toRemoveIds:string[], changed:boolean}}
 */
export function diffVisionLightState(currentDescriptors, appliedById) {
  const applied = appliedById instanceof Map ? appliedById : new Map(Object.entries(appliedById || {}));
  const currentIds = new Set();
  const toApply = [];
  for (const d of Array.isArray(currentDescriptors) ? currentDescriptors : []) {
    if (!d || typeof d.sourceId !== 'string' || currentIds.has(d.sourceId)) continue; // defensive dedupe, first wins
    currentIds.add(d.sourceId);
    const prev = applied.get(d.sourceId);
    const unchanged =
      prev &&
      prev.x === d.x &&
      prev.y === d.y &&
      prev.elevation === d.elevation &&
      prev.dim === d.dim &&
      prev.bright === d.bright;
    if (!unchanged) toApply.push(d);
  }
  const toRemoveIds = [];
  for (const id of applied.keys()) {
    if (!currentIds.has(id)) toRemoveIds.push(id);
  }
  return { toApply, toRemoveIds, changed: toApply.length > 0 || toRemoveIds.length > 0 };
}

/**
 * The live bridge. Call `sync(realMs)` once per frame (it throttles itself);
 * call `dispose()` on scene teardown / MSA shutdown so no synthetic source
 * outlives the session.
 *
 * @param {object} args
 * @param {() => Array<object>} [args.getCandleDescriptors] - e.g. `() => buildCandleLightSources(getCandleRenderState().anchors, {...})`.
 * @param {() => Array<object>} [args.getFireDescriptors] - e.g. `() => fireSubsystem.lightSources()`.
 * @param {number} [args.minIntervalMs]
 * @returns {{sync:(realMs:number)=>object, dispose:()=>void}}
 */
export function createSceneSyntheticLights({
  getCandleDescriptors,
  getFireDescriptors,
  minIntervalMs = MIN_SYNC_INTERVAL_MS,
} = {}) {
  /** Last data actually pushed into a live source, keyed by (prefixed) sourceId — plain data, mirrors `diffVisionLightState`'s expectations. */
  const applied = new Map();
  /** The live `PointLightSource` instances this bridge owns, same keys as `applied`. */
  const liveSources = new Map();
  let lastSyncMs = -Infinity;

  function gatherCurrent() {
    const out = [];
    const candles = typeof getCandleDescriptors === 'function' ? getCandleDescriptors() : null;
    const fires = typeof getFireDescriptors === 'function' ? getFireDescriptors() : null;
    for (const d of Array.isArray(candles) ? candles : []) {
      const built = buildVisionLightData(d);
      if (built) out.push(built);
    }
    for (const d of Array.isArray(fires) ? fires : []) {
      const built = buildVisionLightData(d);
      if (built) out.push(built);
    }
    return out;
  }

  /** Create-or-reinitialize ONE live source. Browser-only. */
  function applyOne(data) {
    let source = liveSources.get(data.sourceId);
    if (!source) {
      const sourceClass = CONFIG?.Canvas?.lightSourceClass;
      if (!sourceClass) return;
      source = new sourceClass({ sourceId: data.sourceId, object: null });
      liveSources.set(data.sourceId, source);
    }
    source.initialize({
      x: data.x,
      y: data.y,
      elevation: data.elevation,
      dim: data.dim,
      bright: data.bright,
      // Respect real geometry, exactly like an authored light — a candle
      // must not reveal a door through a wall just because this bridge
      // exists (PointLightSource's own ClockwiseSweepPolygon handles this).
      walls: true,
      // NOT a vision source (Foundry's separate `testVisibility`/darkvision
      // mechanic) — this module closes the light-PERCEPTION gap only.
      vision: false,
      angle: 360,
      rotation: 0,
      disabled: false,
    });
    source.add();
    applied.set(data.sourceId, { x: data.x, y: data.y, elevation: data.elevation, dim: data.dim, bright: data.bright });
  }

  /** Remove-and-destroy ONE live source. Browser-only. */
  function removeOne(sourceId) {
    const source = liveSources.get(sourceId);
    if (source) {
      source.remove();
      source.destroy();
      liveSources.delete(sourceId);
    }
    applied.delete(sourceId);
  }

  /**
   * @param {number} realMs - WALL time (`env.time.realMs`), never sim time. See this module's own header.
   * @returns {{synced:boolean, reason?:string, changed?:boolean, applied?:number, removed?:number}}
   */
  function sync(realMs) {
    try {
      if (typeof canvas === 'undefined' || !canvas?.effects?.lightSources || !canvas?.perception?.update) {
        return { synced: false, reason: 'no canvas' };
      }
      const n = Number(realMs);
      if (Number.isFinite(n) && Number.isFinite(lastSyncMs) && n - lastSyncMs < minIntervalMs) {
        return { synced: false, reason: 'throttled' };
      }
      lastSyncMs = Number.isFinite(n) ? n : lastSyncMs;

      const current = gatherCurrent();
      const { toApply, toRemoveIds, changed } = diffVisionLightState(current, applied);
      if (!changed) return { synced: true, changed: false };

      for (const id of toRemoveIds) removeOne(id);
      for (const data of toApply) applyOne(data);

      // ONE batched refresh for the whole tick's worth of changes — never
      // per-light, same "batch, don't spam" posture as
      // `AmbientLight#initializeLightSource`'s own single call per update.
      canvas.perception.update({ refreshLighting: true, refreshVision: true });
      return { synced: true, changed: true, applied: toApply.length, removed: toRemoveIds.length };
    } catch (err) {
      // The bridge must never be what breaks the render loop — same posture
      // `ui/loading-screen.js`'s own teardown holds for the exact same reason.
      return { synced: false, reason: `threw: ${err?.message ?? err}` };
    }
  }

  /** Remove every tracked source (scene teardown / MSA disable). */
  function dispose() {
    if (!liveSources.size) return;
    for (const id of Array.from(liveSources.keys())) removeOne(id);
    try {
      if (typeof canvas !== 'undefined' && canvas?.perception?.update)
        canvas.perception.update({ refreshLighting: true, refreshVision: true });
    } catch (_) {
      // Teardown must never throw.
    }
  }

  return { sync, dispose };
}
