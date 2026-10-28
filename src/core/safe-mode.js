/**
 * core/safe-mode.js — THE CRASH LADDER (2026-10-27, epic mmp-fpu).
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * A cold load can lose the whole GPU: Chrome's GPU process stalls on a burst of
 * very large shader compiles, the watchdog kills it (`RESULT_CODE_HUNG`), and
 * every context on the page dies with "A valid external Instance reference no
 * longer exists". It happened three times in one day on one machine, and the
 * fix for each cause has been "make that shader smaller" — which is right and
 * will never be enough on its own: shaders and systems keep growing, and a
 * player on weaker hardware crosses the line first.
 *
 * So the module needs a reflex, not just a diagnosis: **a load that died must
 * never be repeated unchanged.** This file is that reflex's brain. It is PURE —
 * no Foundry, no storage, no clock of its own — so it is Node-tested, and the
 * thin adapter that touches localStorage (`diag/crash-guard.js`) cannot get the
 * policy wrong.
 *
 * ============================================================================
 * THE LADDER
 * ============================================================================
 *   0 full     — everything.
 *   1 careful  — the heaviest optional shader work is not built (candle wind
 *                memory). Looks the same to a glance; one fewer 14-tap loop in
 *                every candle shader.
 *   2 minimal  — also fewer turbulence octaves, lights and flames stop sampling
 *                the wind field, and the performance profile is forced to `low`.
 *   3 foundry  — MSA does not start; Foundry draws the scene. The last rung of
 *                the safety slide, reached only after the three above each died.
 *
 * Each crash moves ONE rung up. A load that reaches "stable" stays where it
 * is — we know that rung works on this machine — until the player resets it,
 * switches the setting, or a NEW BUILD ships (a fix deserves a fresh chance).
 * We never auto-probe a lower rung: the one thing worse than a safe mode is a
 * safe mode that crashes every fifth load to find out if it still needs to be.
 *
 * Every flag below is a JS-time BUILD decision (Effects.md Law 4): a feature
 * that is off is never constructed, so the shader genuinely shrinks.
 *
 * @module core/safe-mode
 */

/** The values of the `safeMode` setting. `auto` is the shipped default. */
export const SAFE_MODE_SETTING_VALUES = Object.freeze(['auto', 'off', 'careful', 'minimal']);

/** Rungs of the ladder. */
export const SAFE_LEVEL = Object.freeze({ FULL: 0, CAREFUL: 1, MINIMAL: 2, FOUNDRY: 3 });
export const MAX_SAFE_LEVEL = SAFE_LEVEL.FOUNDRY;

/**
 * @typedef {object} SafeProfile
 * @property {number} level
 * @property {'full'|'careful'|'minimal'|'foundry'} name
 * @property {boolean} startMsa - false at the last rung: Foundry draws the scene.
 * @property {boolean} candleMemory - build the 14-tap wind look-back into candle flames and candle lights.
 * @property {number} windTurbulenceOctaves - octaves of the wind turbulence stack.
 * @property {boolean} lightWind - candle flames and lights sample the wind field at all.
 * @property {string|null} forcePerformanceProfile - overrides the player's profile (not their stored setting).
 * @property {string} summary - one player-readable line saying what is reduced.
 */

/** @type {ReadonlyArray<Readonly<SafeProfile>>} */
const PROFILES = Object.freeze([
  Object.freeze({
    level: 0,
    name: 'full',
    startMsa: true,
    candleMemory: true,
    windTurbulenceOctaves: 4,
    lightWind: true,
    forcePerformanceProfile: null,
    summary: 'Full quality.',
  }),
  Object.freeze({
    level: 1,
    name: 'careful',
    startMsa: true,
    candleMemory: false,
    windTurbulenceOctaves: 4,
    lightWind: true,
    forcePerformanceProfile: null,
    summary: 'Candles forget past gusts (they still gutter and go out in wind).',
  }),
  Object.freeze({
    level: 2,
    name: 'minimal',
    startMsa: true,
    candleMemory: false,
    windTurbulenceOctaves: 2,
    lightWind: false,
    forcePerformanceProfile: 'low',
    summary: 'Low performance profile; calmer wind on candles and lights; simpler wind turbulence.',
  }),
  Object.freeze({
    level: 3,
    name: 'foundry',
    startMsa: false,
    candleMemory: false,
    windTurbulenceOctaves: 2,
    lightWind: false,
    forcePerformanceProfile: 'low',
    summary: "Map Shine is paused; Foundry's own renderer draws the scene.",
  }),
]);

/**
 * @param {number} level
 * @returns {Readonly<SafeProfile>}
 */
export function safeProfileForLevel(level) {
  const n = Number.isFinite(level) ? Math.round(level) : 0;
  return PROFILES[Math.min(MAX_SAFE_LEVEL, Math.max(0, n))];
}

// ── THE LIVE LEVEL ──────────────────────────────────────────────────────────
// Module state on purpose: shader builders deep in the tree consult it at
// graph-build time and must not have a parameter threaded through forty
// signatures. It is written once per load, by `boot.js`, before any viewer
// starts.
let current = PROFILES[0];

/** @param {number} level @returns {Readonly<SafeProfile>} the profile now in force. */
export function setSafeLevel(level) {
  current = safeProfileForLevel(level);
  return current;
}

/** @returns {Readonly<SafeProfile>} */
export function getSafeProfile() {
  return current;
}

// ── THE PERSISTED RECORD ────────────────────────────────────────────────────

/** A tab that is still booting pulses at least this often (see crash-guard). */
export const HEARTBEAT_INTERVAL_MS = 2_000;
/** A `booting` record whose pulse is older than this belongs to a tab that died. */
export const HEARTBEAT_STALE_MS = 10_000;
/** How long a load must survive after the reveal before it counts as stable. */
export const STABLE_AFTER_MS = 12_000;
/** Most pipelines named in a record — it lives in localStorage, keep it small. */
export const MAX_RECORDED_PIPELINES = 12;

/**
 * @typedef {object} InFlightPipeline
 * @property {string} label
 * @property {number} chars - generated WGSL size (vertex + fragment), a complexity proxy.
 * @property {number} [startedAt]
 *
 * @typedef {object} GuardRecord
 * @property {1} v
 * @property {'idle'|'booting'|'stable'|'interrupted'|'lost'} state
 * @property {number} level - the rung the LAST load ran at.
 * @property {number} consecutive - loads in a row that did not reach `stable`.
 * @property {string} build - build id the record was written under.
 * @property {number} at - last transition (ms).
 * @property {number} heartbeatAt - a booting tab's last pulse (ms).
 * @property {string|null} scene
 * @property {InFlightPipeline[]} inFlight - compiles in flight at the last flush.
 * @property {{at:number, message:string, reason:string, level:number, inFlight:InFlightPipeline[]}|null} lastLoss
 */

const STATES = Object.freeze(['idle', 'booting', 'stable', 'interrupted', 'lost']);

/** @returns {GuardRecord} */
export function emptyRecord() {
  return {
    v: 1,
    state: 'idle',
    level: 0,
    consecutive: 0,
    build: '',
    at: 0,
    heartbeatAt: 0,
    scene: null,
    inFlight: [],
    lastLoss: null,
  };
}

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

/** @param {unknown} list @returns {InFlightPipeline[]} */
function cleanInFlight(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p === 'object')
    .slice(0, MAX_RECORDED_PIPELINES)
    .map((p) => ({
      label: String(p.label ?? '?').slice(0, 120),
      chars: Math.max(0, Math.round(num(p.chars))),
      startedAt: num(p.startedAt),
    }));
}

/**
 * Make anything read from storage into a well-formed record. Total: garbage in,
 * an empty record out — a corrupt entry must never be able to crash the boot
 * that is trying to protect against crashes.
 * @param {unknown} raw @returns {GuardRecord}
 */
export function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return emptyRecord();
  const r = /** @type {Record<string, any>} */ (raw);
  const loss = r.lastLoss && typeof r.lastLoss === 'object' ? r.lastLoss : null;
  return {
    v: 1,
    state: STATES.includes(r.state) ? r.state : 'idle',
    level: Math.min(MAX_SAFE_LEVEL, Math.max(0, Math.round(num(r.level)))),
    consecutive: Math.max(0, Math.round(num(r.consecutive))),
    build: typeof r.build === 'string' ? r.build.slice(0, 80) : '',
    at: num(r.at),
    heartbeatAt: num(r.heartbeatAt),
    scene: typeof r.scene === 'string' ? r.scene.slice(0, 80) : null,
    inFlight: cleanInFlight(r.inFlight),
    lastLoss: loss
      ? {
          at: num(loss.at),
          message: String(loss.message ?? '').slice(0, 300),
          reason: String(loss.reason ?? '').slice(0, 80),
          level: Math.min(MAX_SAFE_LEVEL, Math.max(0, Math.round(num(loss.level)))),
          inFlight: cleanInFlight(loss.inFlight),
        }
      : null,
  };
}

/**
 * Did the previous load die? Two kinds of evidence, nothing else:
 *   - the page lived long enough to hear the device was lost (`lost`);
 *   - the tab died while booting — a `booting` record whose heartbeat went
 *     quiet. A RECENT heartbeat is another live tab mid-load, not a crash, and
 *     a clean `pagehide` (reload, close, navigate) writes `interrupted` instead.
 * @param {GuardRecord} record @param {number} nowMs
 * @returns {{kind: 'device-lost'|'died-while-booting', inFlight: InFlightPipeline[], message: string}|null}
 */
export function crashEvidence(record, nowMs) {
  if (record.state === 'lost') {
    return {
      kind: 'device-lost',
      inFlight: record.lastLoss?.inFlight ?? record.inFlight,
      message: record.lastLoss?.message ?? 'the GPU device was lost',
    };
  }
  if (record.state === 'booting' && nowMs - record.heartbeatAt > HEARTBEAT_STALE_MS) {
    return { kind: 'died-while-booting', inFlight: record.inFlight, message: 'the page stopped responding mid-load' };
  }
  return null;
}

/**
 * @typedef {object} BootDecision
 * @property {number} level
 * @property {number} consecutive
 * @property {'guard-off'|'forced'|'new-build'|'crash'|'carried'|'fresh'} reason
 * @property {ReturnType<typeof crashEvidence>} evidence
 * @property {boolean} changed - the level differs from what the player would otherwise get (worth telling them).
 */

/**
 * THE POLICY. What rung does this load run at?
 *
 * @param {unknown} rawRecord - whatever storage held (may be garbage).
 * @param {{mode?: string, build?: string, nowMs: number}} ctx
 * @returns {BootDecision}
 */
export function decideBoot(rawRecord, { mode = 'auto', build = '', nowMs }) {
  const r = sanitizeRecord(rawRecord);
  if (mode === 'off') return { level: 0, consecutive: 0, reason: 'guard-off', evidence: null, changed: false };
  if (mode === 'careful' || mode === 'minimal') {
    const level = mode === 'careful' ? SAFE_LEVEL.CAREFUL : SAFE_LEVEL.MINIMAL;
    return { level, consecutive: r.consecutive, reason: 'forced', evidence: null, changed: true };
  }
  // `auto`. A new build gets a fresh chance: the thing that crashed may be fixed.
  if (build && r.build && r.build !== build) {
    return { level: 0, consecutive: 0, reason: 'new-build', evidence: null, changed: false };
  }
  const evidence = crashEvidence(r, nowMs);
  if (evidence) {
    const level = Math.min(MAX_SAFE_LEVEL, r.level + 1);
    return { level, consecutive: r.consecutive + 1, reason: 'crash', evidence, changed: true };
  }
  if (r.level > 0) {
    return { level: r.level, consecutive: r.consecutive, reason: 'carried', evidence: null, changed: true };
  }
  return { level: 0, consecutive: r.consecutive, reason: 'fresh', evidence: null, changed: false };
}

// ── REDUCERS — pure, one per event ──────────────────────────────────────────

/**
 * A load begins at the rung `decision` chose.
 * @param {GuardRecord} record @param {BootDecision} decision
 * @param {{nowMs: number, scene?: string|null, build?: string}} ctx @returns {GuardRecord}
 */
export function beginBoot(record, decision, { nowMs, scene = null, build = '' }) {
  return {
    ...sanitizeRecord(record),
    state: 'booting',
    level: decision.level,
    consecutive: decision.consecutive,
    build: build || record.build || '',
    at: nowMs,
    heartbeatAt: nowMs,
    scene,
    inFlight: [],
  };
}

/** @param {GuardRecord} record @param {number} nowMs @returns {GuardRecord} */
export function pulse(record, nowMs) {
  return record.state === 'booting' ? { ...record, heartbeatAt: nowMs } : record;
}

/**
 * The load survived: remember that this rung is good.
 * @param {GuardRecord} record @param {number} nowMs @returns {GuardRecord}
 */
export function markStable(record, nowMs) {
  if (record.state === 'lost') return record; // a loss is not undone by a late timer
  return { ...record, state: 'stable', consecutive: 0, at: nowMs, heartbeatAt: nowMs, inFlight: [] };
}

/**
 * The page is going away cleanly (reload, close, navigation): NOT a crash.
 * @param {GuardRecord} record @param {number} nowMs @returns {GuardRecord}
 */
export function markInterrupted(record, nowMs) {
  return record.state === 'booting' ? { ...record, state: 'interrupted', at: nowMs, inFlight: [] } : record;
}

/**
 * The page heard the device die.
 * @param {GuardRecord} record
 * @param {{nowMs: number, message?: string, reason?: string}} info @returns {GuardRecord}
 */
export function markLost(record, { nowMs, message = '', reason = '' }) {
  return {
    ...record,
    state: 'lost',
    at: nowMs,
    lastLoss: {
      at: nowMs,
      message: String(message).slice(0, 300),
      reason: String(reason).slice(0, 80),
      level: record.level,
      inFlight: cleanInFlight(record.inFlight),
    },
  };
}

/** @param {GuardRecord} record @param {InFlightPipeline[]} inFlight @returns {GuardRecord} */
export function withInFlight(record, inFlight) {
  return { ...record, inFlight: cleanInFlight(inFlight) };
}

/**
 * One player-readable line about why this load is not at full quality.
 * @param {BootDecision} decision @returns {string}
 */
export function describeDecision(decision) {
  const p = safeProfileForLevel(decision.level);
  if (decision.reason === 'forced') return `Map Shine is in ${p.name} mode (set in your settings). ${p.summary}`;
  if (decision.reason === 'crash') {
    const what =
      decision.evidence?.kind === 'device-lost'
        ? 'the graphics card stopped responding'
        : 'the page stopped responding while loading';
    return `The last Map Shine load ended because ${what}, so this load runs in ${p.name} mode. ${p.summary}`;
  }
  if (decision.reason === 'carried') {
    return `Map Shine is staying in ${p.name} mode because an earlier load on this computer failed. ${p.summary}`;
  }
  return '';
}
