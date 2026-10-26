/**
 * @fileoverview foundry/scene-activation-gate.js — a GM activating a scene waits
 * for the table to be ready (loading audit, 2026-10-25, phase 4; decision D3).
 *
 * `Scene#activate` is what a GM's "Activate" button calls. It is an update that the
 * server relays, after which EVERY client runs its own `view` (so each client's own
 * `scene-switch-gate.js` prepares locally). That is correct for each client alone and
 * wrong for the table: the clients finish at different times, so the slowest one
 * decides when everybody has a working screen.
 *
 * This wraps `activate` on the GM's client ONLY, before the update is sent. It hands
 * the scene to an injected `coordinate` function — which asks the players to prepare
 * and waits (`prepare-coordinator.js`) — and only when that returns calls the real
 * `activate`. Players therefore receive the activation having ALREADY warmed their
 * caches, and their own gates find the work done.
 *
 * Same rules as `scene-switch-gate.js`: it FAILS OPEN (a coordinate that throws, a
 * wrap that cannot install = activate immediately, as before), it leaves a changeless
 * call alone (a scene that is already active), and it only ever delays a switch.
 *
 * @module foundry/scene-activation-gate
 */

import { createLogger } from '../core/log.js';

const log = createLogger('scene-activation-gate');

const GATE_MARK = Symbol.for('map-shine-advanced.sceneActivationGate');

/**
 * Should this `activate` call be coordinated?
 * @param {{enabled: boolean, isGM: boolean, sceneActive: boolean}} state
 * @returns {{coordinate: boolean, reason: string}}
 */
export function classifyActivation({ enabled, isGM, sceneActive }) {
  if (!enabled) return { coordinate: false, reason: 'the prepare-before-switch setting is off' };
  if (!isGM) return { coordinate: false, reason: 'only a GM client sends the activation' };
  if (sceneActive) return { coordinate: false, reason: 'the scene is already active' };
  return { coordinate: true, reason: 'a different scene is being activated' };
}

/**
 * The orchestrator, dependencies injected.
 *
 * @param {object} deps
 * @param {(scene: object, options: object) => Promise<{cancelled?: boolean}|void>} deps.coordinate
 * @param {() => boolean} deps.isEnabled
 * @param {() => boolean} deps.isGM
 */
export function createActivationGate({ coordinate, isEnabled, isGM }) {
  /** @type {{key: string, promise: Promise<any>}|null} */
  let inflight = null;
  const stats = { passedThrough: 0, coordinated: 0, failedOpen: 0, cancelled: 0, joined: 0 };
  return {
    async run(scene, options, proceed) {
      let verdict;
      try {
        verdict = classifyActivation({ enabled: isEnabled(), isGM: isGM(), sceneActive: !!scene.active });
      } catch (err) {
        stats.failedOpen++;
        log.error('could not classify a Scene#activate call — activating without the gate:', err);
        return proceed(scene, options);
      }
      if (!verdict.coordinate) {
        stats.passedThrough++;
        return proceed(scene, options);
      }
      // A second click while the first is still waiting joins it rather than starting another wait.
      if (inflight && inflight.key === scene.id) {
        stats.joined++;
        return inflight.promise;
      }
      stats.coordinated++;
      const promise = (async () => {
        let outcome = null;
        try {
          outcome = (await coordinate(scene, options ?? {})) ?? null;
        } catch (err) {
          stats.failedOpen++;
          log.error('coordinating the scene activation threw — activating without waiting:', err);
        }
        if (outcome?.cancelled) {
          stats.cancelled++;
          return scene; // the GM changed their mind: the scene is NOT activated
        }
        return proceed(scene, options);
      })();
      inflight = { key: scene.id, promise };
      const clear = () => {
        if (inflight?.promise === promise) inflight = null;
      };
      promise.then(clear, clear);
      return promise;
    },
    getStatus: () => ({ ...stats, inflight: inflight ? inflight.key : null }),
  };
}

/**
 * Wrap `Scene#activate`. The only part that touches Foundry.
 *
 * @param {object} deps - see {@link createActivationGate}; plus:
 * @param {Function} [deps.getSceneClass] - defaults to `CONFIG.Scene.documentClass`.
 * @returns {{installed: boolean, reason: string|null, gate?: object}}
 */
export function installSceneActivationGate({ coordinate, isEnabled, isGM, getSceneClass } = {}) {
  const SceneClass = (getSceneClass ?? (() => globalThis.CONFIG?.Scene?.documentClass))();
  let proto = SceneClass?.prototype;
  if (!proto || typeof proto.activate !== 'function') {
    return { installed: false, reason: 'no Scene#activate to wrap — Foundry will activate immediately' };
  }
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'activate')) proto = Object.getPrototypeOf(proto);
  if (!proto) return { installed: false, reason: 'no prototype in the chain owns Scene#activate' };
  if (proto.activate[GATE_MARK]) return { installed: true, reason: 'already installed' };

  const original = proto.activate;
  const gate = createActivationGate({ coordinate, isEnabled, isGM });
  const gated = function gatedActivate(options) {
    return gate.run(this, options, (scene, opts) => original.call(scene, opts));
  };
  gated[GATE_MARK] = true;
  gated.original = original;
  try {
    proto.activate = gated;
  } catch (err) {
    return { installed: false, reason: `could not replace Scene#activate: ${err?.message ?? err}` };
  }
  return { installed: true, reason: null, gate };
}
