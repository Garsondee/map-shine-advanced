/**
 * @fileoverview diag/presentation-monitor.js — catches "two floors on screen at once" with a
 * log line instead of by eye (loading audit §6.7, 2026-10-25).
 *
 * ============================================================================
 * THE BUG CLASS THIS EXISTS FOR
 * ============================================================================
 * Going up a floor, the lower floor's specular shine stayed on screen for a while: the
 * viewer had moved to floor 1, one effect had not caught up, and nothing anywhere noticed
 * because every individual part was behaving as written. The audit found four more of the
 * same shape (P-03, P-05, P-06, P-08) — each a consumer of "which floor is being viewed"
 * that lagged the flip by a frame, a second or never. They were all found by someone looking
 * at the screen.
 *
 * The invariant is one sentence: **after a floor change, every per-floor consumer that is
 * showing anything is showing the floor that is presented.** This module checks it, once per
 * frame, for as long as it is armed.
 *
 * ============================================================================
 * WHAT IT DOES AND DELIBERATELY DOES NOT DO
 * ============================================================================
 *  - It REPORTS. It logs the first sighting of each (consumer, floor) pair, keeps counts and a
 *    short list of examples, and shows up in the debug report. It does NOT hide the offender
 *    (the audit sketched that): a wrong hide would itself be a visible bug, and this was
 *    written without a live Foundry to watch it. Promote it to an action once the reports
 *    have shown it is never wrong.
 *  - It is ARMED, not always on. A floor change arms it for a few seconds of frames (the
 *    window in which a lagging consumer can show), after which `checkFrame` returns at once.
 *    The probes allocate a small object each; that is fine for 120 frames, not for a session.
 *  - A consumer that is not showing anything is never a violation, whatever floor it last
 *    synced. A consumer that cannot say which floor it is showing (`floor` not a finite
 *    number) is counted as `unreported`, not as a violation: an instrument that guesses is
 *    the thing this project's instruments are forbidden to be.
 *
 * Pure: no DOM, no clock (frames are counted), the logger is injected. Node-tested.
 *
 * @module diag/presentation-monitor
 */

/** Frames to keep checking after a floor change: ~2 s at 60 fps, long enough for a late mask. */
export const DEFAULT_ARM_FRAMES = 120;
/** How many distinct examples a report keeps. */
export const MAX_EXAMPLES = 16;

/**
 * What a probe reports. `floor` is the floor whose content is on screen, `visible` whether any is.
 * @typedef {{visible: boolean, floor: number|null|undefined}} PresentationSample
 */

const NO_VIOLATIONS = Object.freeze([]);

/**
 * THE INVARIANT, pure: which of these consumers are showing a floor other than the presented one?
 * @param {number} presentedFloor
 * @param {Array<{name: string} & PresentationSample>} samples
 * @returns {{violations: Array<{name: string, floor: number}>, unreported: string[]}}
 */
export function findMixedState(presentedFloor, samples) {
  const violations = [];
  const unreported = [];
  for (const s of samples ?? []) {
    if (!s || s.visible !== true) continue; // showing nothing cannot be on the wrong floor
    if (!Number.isFinite(s.floor)) {
      unreported.push(s.name);
      continue;
    }
    if (s.floor !== presentedFloor) violations.push({ name: s.name, floor: s.floor });
  }
  return { violations, unreported };
}

/**
 * @param {object} [opts]
 * @param {{warn: Function, error: Function}|null} [opts.log]
 * @param {number} [opts.defaultArmFrames]
 * @returns {{
 *   register: (name: string, probe: () => PresentationSample) => void,
 *   arm: (reason: string, frames?: number) => void,
 *   checkFrame: (presentedFloor: number) => ReadonlyArray<{name: string, floor: number}>,
 *   isArmed: () => boolean,
 *   getReport: () => object,
 * }}
 */
export function createPresentationMonitor({ log = null, defaultArmFrames = DEFAULT_ARM_FRAMES } = {}) {
  /** @type {Map<string, () => PresentationSample>} */
  const probes = new Map();
  let framesLeft = 0;
  let armReason = null;
  let armCount = 0;
  let framesChecked = 0;
  let framesWithMixedState = 0;
  let frameSinceArm = 0;
  let probeErrors = 0;
  /** name -> {frames, lastFloor, lastPresented, firstFrameSinceArm} */
  const perConsumer = new Map();
  /** "name|floor|presented" seen since the last arm — log once, not once per frame. */
  const loggedThisWindow = new Set();
  /** @type {Array<{reason: string|null, frameSinceArm: number, presented: number, name: string, floor: number}>} */
  const examples = [];
  const unreportedNames = new Set();
  const erroredProbes = new Set();

  return {
    register(name, probe) {
      if (typeof name !== 'string' || !name || typeof probe !== 'function') return;
      probes.set(name, probe);
    },

    /** Start (or extend) a checking window. Call it from the one place the floor is committed. */
    arm(reason, frames = defaultArmFrames) {
      armReason = reason ?? null;
      framesLeft = Math.max(framesLeft, Math.max(0, Math.floor(frames)));
      frameSinceArm = 0;
      armCount++;
      loggedThisWindow.clear();
    },

    isArmed: () => framesLeft > 0,

    /**
     * Call once per rendered frame, AFTER every consumer has synced. Costs a comparison when not armed.
     * @param {number} presentedFloor the floor the viewer says it is presenting
     * @returns {ReadonlyArray<{name: string, floor: number}>} this frame's violations (usually none)
     */
    checkFrame(presentedFloor) {
      if (framesLeft <= 0) return NO_VIOLATIONS;
      framesLeft--;
      frameSinceArm++;
      framesChecked++;
      const samples = [];
      for (const [name, probe] of probes) {
        try {
          const s = probe();
          samples.push({ name, visible: s?.visible === true, floor: s?.floor });
        } catch (err) {
          // A broken probe must never take a frame down, and must never pass for a clean result.
          probeErrors++;
          if (!erroredProbes.has(name)) {
            erroredProbes.add(name);
            log?.error?.(`presentation monitor: the "${name}" probe threw — it is not being checked:`, err);
          }
        }
      }
      const { violations, unreported } = findMixedState(presentedFloor, samples);
      for (const name of unreported) unreportedNames.add(name);
      if (violations.length === 0) return NO_VIOLATIONS;

      framesWithMixedState++;
      for (const v of violations) {
        let row = perConsumer.get(v.name);
        if (!row) {
          row = { frames: 0, lastFloor: v.floor, lastPresented: presentedFloor, firstFrameSinceArm: frameSinceArm };
          perConsumer.set(v.name, row);
        }
        row.frames++;
        row.lastFloor = v.floor;
        row.lastPresented = presentedFloor;
        const key = `${v.name}|${v.floor}|${presentedFloor}`;
        if (!loggedThisWindow.has(key)) {
          loggedThisWindow.add(key);
          log?.warn?.(
            `MIXED FLOORS ON SCREEN: "${v.name}" is showing floor ${v.floor} while floor ${presentedFloor} is presented ` +
              `(frame ${frameSinceArm} after "${armReason ?? 'arm'}").`
          );
          if (examples.length < MAX_EXAMPLES) {
            examples.push({
              reason: armReason,
              frameSinceArm,
              presented: presentedFloor,
              name: v.name,
              floor: v.floor,
            });
          }
        }
      }
      return violations;
    },

    getReport() {
      return {
        consumers: [...probes.keys()],
        armed: framesLeft > 0,
        framesLeft,
        lastArmReason: armReason,
        armCount,
        framesChecked,
        framesWithMixedState,
        // THE NUMBER THE PLAN'S ACCEPTANCE RESTS ON: 0 after N scripted flips means no frame
        // ever showed two floors. It is only meaningful if `framesChecked` is not also 0.
        verdict: framesChecked === 0 ? 'never-armed' : framesWithMixedState === 0 ? 'clean' : 'mixed-floors-seen',
        perConsumer: Object.fromEntries(perConsumer),
        examples: [...examples],
        unreportedConsumers: [...unreportedNames],
        probeErrors,
      };
    },
  };
}
