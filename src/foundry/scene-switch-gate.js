/**
 * @fileoverview foundry/scene-switch-gate.js — PREPARE, THEN LET FOUNDRY DRAW
 * (loading audit, 2026-10-25; decision D1).
 *
 * ============================================================================
 * THE PROBLEM THIS EXISTS FOR
 * ============================================================================
 * A level change IS a full scene redraw in v14 (`Scene#view` → `canvas.draw`,
 * `F:documents/scene.mjs:259-291`), and Foundry does not wait for anything a
 * module does: `Hooks.call`/`callAll` drop what a handler returns
 * (`F:helpers/hooks.mjs:114-168`). So MSA's own preparation could only ever start
 * AFTER Foundry's draw was under way — snapshot up, `root` hidden, then revealed
 * with the NEW level's chrome while MSA was still holding the OLD floor's art
 * ("the held-floor mismatch", `boot.js#switchToPreparedFloor`). Whatever order MSA
 * does its work in, Foundry's reveal does not wait for it.
 *
 * The only place a module can stand BEFORE the draw is `Scene#view` itself (and,
 * for activation, `Scene#activate` — `scene-activation-gate.js`). This wraps it
 * once, in one file: classify the request, and if it will cause a redraw, run
 * the injected `prepare` to completion and only then call the real method. While
 * it runs, Foundry has not started anything: the old floor is fully live and
 * interactive, which is the whole point.
 *
 * ============================================================================
 * THE RULES IT KEEPS
 * ============================================================================
 *  - FAILS OPEN. A prepare that throws, or a wrap that cannot be installed,
 *    means Foundry draws immediately — the behaviour before this existed. It can
 *    delay a switch; it can never prevent one (the safety slide).
 *  - NEVER BLOCKS WHAT FOUNDRY WOULD REFUSE. While `canvas.loading`, Foundry's
 *    own `view` warns "You cannot switch Scenes until resources finish loading";
 *    the gate passes that straight through so the player sees the real message.
 *  - LAST REQUEST WINS. A newer request supersedes an older one still preparing
 *    (the older call resolves without drawing); an identical request already
 *    preparing is joined, not duplicated.
 *  - A CHANGELESS CALL IS UNTOUCHED. `Scene#view` is also called to re-render
 *    collections; if neither scene nor level changes there is nothing to prepare.
 *  - IT DOES NOT KNOW WHAT "PREPARE" MEANS. `prepare(request, control)` is
 *    injected by the composition root (boot.js), which owns the viewer.
 *
 * Pure decision parts (`classifyViewRequest`, `createViewGate`) are Node-tested
 * with fakes; `installSceneSwitchGate` is the only part that touches Foundry.
 *
 * @module foundry/scene-switch-gate
 */

import { createLogger } from '../core/log.js';
import { perfNowMs } from '../core/frame-clock.js';

const log = createLogger('scene-switch-gate');

/** Marks a wrapped `view`, so a second install (hot reload, a double boot) never double-wraps. */
const GATE_MARK = Symbol.for('map-shine-advanced.sceneSwitchGate');

/**
 * What would this `Scene#view` call do?
 *
 * @param {{
 *   currentSceneId: string|null, currentLevelId: string|null, hasCurrentScene: boolean,
 *   canvasInitialized: boolean, canvasLoading: boolean
 * }} state - the canvas as it is RIGHT NOW.
 * @param {{sceneId: string, levelId?: string|undefined}} target - the call's own target.
 * @returns {{kind: 'none'|'blocked'|'cold'|'scene'|'level', reason?: string, sceneId?: string, levelId?: string|null}}
 *   - `none`    — nothing would be redrawn (collection re-render only).
 *   - `blocked` — Foundry will refuse it itself; leave it alone.
 *   - `cold`    — the first draw (nothing drawn yet, or the canvas was blank).
 *   - `scene`   — a different scene.
 *   - `level`   — the same scene, a different level.
 */
export function classifyViewRequest(state, target) {
  if (state.canvasLoading) {
    return { kind: 'blocked', reason: 'canvas is still loading — Foundry refuses this view itself' };
  }
  if (!state.canvasInitialized) return { kind: 'none', reason: 'canvas not initialised — view() will not draw' };
  const sceneChanged = state.currentSceneId !== target.sceneId;
  // Exactly Foundry's own test (`scene.mjs:272-273`): an explicit level that differs from the viewed one.
  const levelChanged = target.levelId !== undefined && target.levelId !== state.currentLevelId;
  if (!sceneChanged && !levelChanged) return { kind: 'none', reason: 'same scene and level' };
  const base = { sceneId: target.sceneId, levelId: target.levelId ?? null };
  if (!state.hasCurrentScene) return { kind: 'cold', ...base };
  return { kind: sceneChanged ? 'scene' : 'level', ...base };
}

/**
 * The orchestrator, with every dependency injected.
 *
 * @param {object} deps
 * @param {(request: object, control: {isCancelled: () => boolean}) => Promise<{ok?: boolean, cancelled?: boolean, reason?: string}|void>} deps.prepare
 * @param {() => boolean} deps.isEnabled - the GM's world setting.
 * @param {() => object} deps.readState - the canvas as it is now (see `classifyViewRequest`).
 * @param {(event: string, detail?: object) => void} [deps.onEvent] - told what the gate is doing, for the
 *   floor-change timeline (`diag/floor-timeline.js`). Its own failures never reach the switch.
 * @returns {{
 *   run: (scene: {id: string}, options: object, proceed: (scene: object, options: object) => Promise<any>) => Promise<any>,
 *   getStatus: () => object
 * }}
 */
export function createViewGate({ prepare, isEnabled, readState, onEvent }) {
  const emit = (event, detail) => {
    try {
      onEvent?.(event, detail);
    } catch (err) {
      log.error(`the gate's "${event}" observer threw — ignored, the switch continues:`, err);
    }
  };
  let generation = 0;
  /** @type {{key: string, promise: Promise<any>}|null} */
  let inflight = null;
  const stats = { passedThrough: 0, gated: 0, superseded: 0, failedOpen: 0, cancelled: 0, joined: 0, last: null };

  return {
    async run(scene, options, proceed) {
      const opts = options ?? {};
      if (!isEnabled()) {
        stats.passedThrough++;
        return proceed(scene, opts);
      }
      let request;
      try {
        request = classifyViewRequest(readState(), { sceneId: scene.id, levelId: opts.level });
      } catch (err) {
        // The gate's OWN code failing must never stand between a user and a switch.
        stats.failedOpen++;
        log.error('could not classify a Scene#view request — viewing without the gate:', err);
        return proceed(scene, opts);
      }
      if (request.kind === 'none' || request.kind === 'blocked') {
        stats.passedThrough++;
        return proceed(scene, opts);
      }

      const key = `${request.kind}:${request.sceneId}:${request.levelId ?? ''}`;
      if (inflight && inflight.key === key) {
        stats.joined++;
        return inflight.promise;
      }

      const myGeneration = ++generation;
      stats.gated++;
      stats.last = { ...request, atMs: perfNowMs() };
      const control = { isCancelled: () => myGeneration !== generation };
      emit('request', { kind: request.kind, sceneId: request.sceneId, levelId: request.levelId });

      const promise = (async () => {
        let outcome = null;
        emit('prepare-start');
        try {
          outcome = (await prepare({ ...request, scene }, control)) ?? null;
          emit('prepare-end', { outcome: outcome?.cancelled ? 'cancelled' : outcome?.ok === false ? 'not-ok' : 'ok' });
        } catch (err) {
          // Fail OPEN: a prepare that cannot run must not stop the switch.
          stats.failedOpen++;
          log.error(`preparing the ${request.kind} switch threw — switching without it:`, err);
          emit('failed-open');
        }
        if (myGeneration !== generation) {
          stats.superseded++;
          emit('superseded');
          return scene; // a newer request owns the switch
        }
        if (outcome?.cancelled) {
          stats.cancelled++;
          emit('cancelled');
          return scene; // the user said no: stay where they are
        }
        emit('view-called');
        return proceed(scene, opts);
      })();

      inflight = { key, promise };
      promise.then(
        () => {
          if (inflight?.promise === promise) inflight = null;
        },
        () => {
          if (inflight?.promise === promise) inflight = null;
        }
      );
      return promise;
    },
    getStatus: () => ({ ...stats, inflight: inflight ? inflight.key : null }),
  };
}

/**
 * Wrap `Scene#view`. The ONLY part that touches Foundry.
 *
 * @param {object} deps - see {@link createViewGate} (`readState` defaults to the live canvas).
 * @param {Function} [deps.getSceneClass] - defaults to `CONFIG.Scene.documentClass`.
 * @returns {{installed: boolean, reason: string|null, gate?: object}}
 */
export function installSceneSwitchGate({
  prepare,
  isEnabled,
  readState = readLiveCanvasState,
  getSceneClass,
  onEvent,
} = {}) {
  const SceneClass = (getSceneClass ?? (() => globalThis.CONFIG?.Scene?.documentClass))();
  let proto = SceneClass?.prototype;
  if (!proto || typeof proto.view !== 'function') {
    return {
      installed: false,
      reason: 'no CONFIG.Scene.documentClass.prototype.view to wrap — Foundry will draw immediately',
    };
  }
  // Wrap the prototype that OWNS `view`, not the configured subclass: assigning on
  // a subclass that merely inherits it would shadow the method for that class only,
  // leaving every other path to the core Scene unguarded.
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'view')) proto = Object.getPrototypeOf(proto);
  if (!proto) return { installed: false, reason: 'no prototype in the chain owns Scene#view' };
  if (proto.view[GATE_MARK]) return { installed: true, reason: 'already installed' };

  const original = proto.view;
  const gate = createViewGate({ prepare, isEnabled, readState, onEvent });
  const gated = function gatedView(options) {
    // `this` is the Scene document. Every failure of the gate's own code is
    // handled INSIDE `run` (and falls through to `proceed`); an error from
    // Foundry's real `view` is Foundry's and must reach its caller once, not be
    // answered by a second draw.
    return gate.run(this, options, (scene, opts) => original.call(scene, opts));
  };
  gated[GATE_MARK] = true;
  gated.original = original;
  try {
    proto.view = gated;
  } catch (err) {
    return { installed: false, reason: `could not replace Scene#view: ${err?.message ?? err}` };
  }
  return { installed: true, reason: null, gate };
}

/** The live canvas, as `classifyViewRequest` wants it. */
function readLiveCanvasState() {
  const c = globalThis.canvas;
  return {
    currentSceneId: c?.scene?.id ?? null,
    currentLevelId: c?.level?.id ?? null,
    hasCurrentScene: !!c?.scene,
    canvasInitialized: !!c?.initialized,
    canvasLoading: !!c?.loading,
  };
}
