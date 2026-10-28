/**
 * diag/crash-guard.js — THE ADAPTER BEHIND THE CRASH LADDER (2026-10-27, epic mmp-fpu).
 *
 * `core/safe-mode.js` decides; this file remembers. It keeps one small JSON
 * record in `localStorage` describing the load in progress, and turns three
 * events into reducer calls:
 *
 *   - a load BEGINS      → write `booting`, start a heartbeat, ask the policy
 *                          which rung to run at;
 *   - a load SURVIVES    → after `STABLE_AFTER_MS` with no loss, write `stable`;
 *   - the device DIES    → write `lost` plus the shaders that were compiling.
 *
 * ## The breadcrumbs
 *
 * The crash this was built for kills the GPU process, and a dead GPU process
 * takes the evidence with it: the console shows 45 `Instance dropped in
 * popErrorScope` lines and no shader name. Every pipeline the compile governor
 * (`vt/pipeline-governor.js`) starts is therefore noted here BEFORE it starts
 * and written straight to storage; the next boot reads the list back and logs
 * "the previous load died while compiling: …". A hang stops being a guess.
 *
 * ## What counts as a crash — and what must not
 *
 * Reloading an impatient 40-second load is not a crash. A clean `pagehide`
 * writes `interrupted`, and a tab that is merely still booting keeps pulsing, so
 * a second tab opened mid-load does not read the first as dead. Only a `lost`
 * record, or a `booting` record whose pulse went quiet, is evidence.
 *
 * Storage can be missing, full, or blocked (private windows, quota, policy). It
 * is wrapped everywhere: with no storage the guard degrades to "no memory", never
 * to an exception in the boot path.
 *
 * @module diag/crash-guard
 */

import { createLogger } from '../core/log.js';
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_RECORDED_PIPELINES,
  STABLE_AFTER_MS,
  beginBoot,
  decideBoot,
  describeDecision,
  emptyRecord,
  markInterrupted,
  markLost,
  markStable,
  pulse,
  safeProfileForLevel,
  sanitizeRecord,
  withInFlight,
} from '../core/safe-mode.js';

const log = createLogger('crash-guard');

/** localStorage key. Bump the suffix if the record's shape ever changes incompatibly. */
export const CRASH_GUARD_KEY = 'msa.crashGuard.v1';

/**
 * @typedef {object} CrashGuardDeps
 * @property {{getItem:(k:string)=>string|null, setItem:(k:string,v:string)=>void, removeItem:(k:string)=>void}|null} [storage]
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => any} [setTimer] - setInterval-like.
 * @property {(h: any) => void} [clearTimer]
 * @property {(fn: () => void, ms: number) => any} [setOnce] - setTimeout-like.
 * @property {(h: any) => void} [clearOnce]
 * @property {{addEventListener:(t:string, fn:()=>void)=>void}|null} [win]
 */

/**
 * @param {CrashGuardDeps} [deps]
 */
export function createCrashGuard(deps = {}) {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => globalThis.clearInterval(h));
  const setOnce = deps.setOnce ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearOnce = deps.clearOnce ?? ((h) => globalThis.clearTimeout(h));
  const win = deps.win === undefined ? (typeof window !== 'undefined' ? window : null) : deps.win;

  /** The record as last written (also the in-memory truth when storage is absent). */
  let record = readRecord();
  /** @type {Map<string, {label: string, chars: number, startedAt: number}>} */
  const inFlight = new Map();
  let heartbeat = null;
  let stableTimer = null;
  let unloadHooked = false;
  let lastDecision = null;
  /** True once this page has recorded a loss — later events must not overwrite it. */
  let lostThisPage = false;

  function defaultStorage() {
    try {
      // Touching `localStorage` itself can throw (blocked cookies / sandboxed frames).
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (err) {
      log.warn('localStorage is unavailable — the crash guard will not remember across loads:', err);
      return null;
    }
  }

  function readRecord() {
    if (!storage) return emptyRecord();
    try {
      const text = storage.getItem(CRASH_GUARD_KEY);
      return text ? sanitizeRecord(JSON.parse(text)) : emptyRecord();
    } catch (err) {
      log.warn('the crash-guard record is unreadable — starting from an empty one:', err);
      return emptyRecord();
    }
  }

  function write(next) {
    record = next;
    if (!storage) return;
    try {
      storage.setItem(CRASH_GUARD_KEY, JSON.stringify(record));
    } catch (err) {
      // Quota or a blocked store. The in-memory record still drives this page.
      log.warn('could not persist the crash-guard record:', err);
    }
  }

  const snapshotInFlight = () =>
    [...inFlight.values()]
      .sort((a, b) => b.chars - a.chars)
      .slice(0, MAX_RECORDED_PIPELINES)
      .map((p) => ({ label: p.label, chars: p.chars, startedAt: p.startedAt }));

  function stopTimers() {
    if (heartbeat !== null) clearTimer(heartbeat);
    if (stableTimer !== null) clearOnce(stableTimer);
    heartbeat = null;
    stableTimer = null;
  }

  function hookUnload() {
    if (unloadHooked || !win) return;
    unloadHooked = true;
    // `pagehide` fires on reload, close and navigation but NOT when the process
    // is killed — exactly the line between "the user left" and "it died".
    win.addEventListener('pagehide', () => {
      if (lostThisPage) return;
      write(markInterrupted(record, now()));
    });
  }

  /**
   * What rung WOULD a load run at right now? Read-only — writes nothing, arms
   * nothing. `boot.js` asks this at `init`, before any shader exists, so the level
   * is in force for everything built before the first scene starts; `start()`
   * then makes the same decision for real.
   * @param {{mode?: string, build?: string}} [ctx]
   */
  function peek({ mode = 'auto', build = '' } = {}) {
    const decision = decideBoot(readRecord(), { mode, build, nowMs: now() });
    return { ...decision, profile: safeProfileForLevel(decision.level), message: describeDecision(decision) };
  }

  /**
   * A load is about to begin. Decides the rung and records `booting`.
   * @param {{mode?: string, build?: string, scene?: string|null}} [ctx]
   * @returns {import('../core/safe-mode.js').BootDecision & {profile: ReturnType<typeof safeProfileForLevel>, message: string}}
   */
  function start({ mode = 'auto', build = '', scene = null } = {}) {
    stopTimers();
    inFlight.clear();
    lostThisPage = false;
    const nowMs = now();
    const stored = readRecord();
    const decision = decideBoot(stored, { mode, build, nowMs });
    const profile = safeProfileForLevel(decision.level);
    if (decision.evidence) {
      const names = decision.evidence.inFlight.map((p) => `${p.label} (${p.chars} chars)`).join('; ');
      log.warn(
        `the previous load did not finish — ${decision.evidence.message}. ` +
          (names ? `Shaders compiling at that moment: ${names}.` : 'No compile was in flight, or none was recorded.'),
        { kind: decision.evidence.kind, inFlight: decision.evidence.inFlight }
      );
    }
    if (decision.changed || decision.reason === 'crash') {
      log.warn(`safe mode: starting at level ${decision.level} (${profile.name}) — ${decision.reason}`);
    }
    lastDecision = decision;

    if (!profile.startMsa) {
      // MSA is not going to run, so there is no load to crash. Remember the rung
      // as a settled fact (`stable`) so the next boot carries it instead of
      // reading a dead `booting` record and climbing past the top.
      write({ ...beginBoot(stored, decision, { nowMs, scene, build }), state: 'stable' });
    } else {
      write(beginBoot(stored, decision, { nowMs, scene, build }));
      heartbeat = setTimer(() => write(pulse(record, now())), HEARTBEAT_INTERVAL_MS);
    }
    hookUnload();
    return { ...decision, profile, message: describeDecision(decision) };
  }

  /**
   * The load revealed. If nothing dies for `STABLE_AFTER_MS`, remember this rung as good.
   * @param {number} [delayMs]
   */
  function armStable(delayMs = STABLE_AFTER_MS) {
    if (record.state !== 'booting') return;
    if (stableTimer !== null) clearOnce(stableTimer);
    stableTimer = setOnce(() => {
      stableTimer = null;
      if (lostThisPage) return;
      stopTimers();
      write(markStable(record, now()));
      log.info(`load stable at safe-mode level ${record.level} — remembered.`);
    }, delayMs);
  }

  /**
   * A compile is about to start. Written to storage immediately: if the GPU
   * process dies in the middle of it, this line is the only evidence.
   * @param {string} id - unique per compile.
   * @param {string} label @param {number} chars
   */
  function noteCompileStart(id, label, chars) {
    inFlight.set(id, { label, chars, startedAt: now() });
    if (record.state === 'booting' || record.state === 'stable') write(withInFlight(record, snapshotInFlight()));
  }

  /** @param {string} id */
  function noteCompileEnd(id) {
    if (!inFlight.delete(id)) return;
    if (record.state === 'booting' || record.state === 'stable') write(withInFlight(record, snapshotInFlight()));
  }

  /**
   * The GPU device was lost. Persist it with whatever was compiling.
   * @param {{message?: string, reason?: string}} [info]
   */
  function recordLoss(info = {}) {
    lostThisPage = true;
    stopTimers();
    write(markLost(withInFlight(record, snapshotInFlight()), { nowMs: now(), ...info }));
    log.error(
      `device loss recorded at safe-mode level ${record.level}; the next load starts one rung higher. ` +
        `Compiling at that moment: ${
          snapshotInFlight()
            .map((p) => p.label)
            .join('; ') || 'nothing recorded'
        }`
    );
  }

  /** Forget everything: the next load starts at full quality. */
  function reset() {
    stopTimers();
    inFlight.clear();
    write(emptyRecord());
    if (storage) {
      try {
        storage.removeItem(CRASH_GUARD_KEY);
      } catch (err) {
        log.warn('could not clear the crash-guard record:', err);
      }
    }
  }

  return {
    peek,
    start,
    armStable,
    noteCompileStart,
    noteCompileEnd,
    recordLoss,
    reset,
    /** @returns {{record: object, decision: object|null, inFlight: object[]}} for the console / bug reports. */
    status: () => ({ record: { ...record }, decision: lastDecision, inFlight: snapshotInFlight() }),
  };
}
