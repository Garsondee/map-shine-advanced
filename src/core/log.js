/**
 * @fileoverview THE ONE LOG DOOR — every line MSA says goes through here.
 *
 * ============================================================================
 * THIS FILE WAS ALREADY LOSING
 * ============================================================================
 *
 * On 2026-07-17 this module had **3 importers and 61 direct `console.*` calls**
 * standing against it (22 in `boot.js` alone). That is not a new problem: it is
 * `EffectComposer.js`'s 5-vs-92, `legacy/foundry/`'s 16%, and
 * `resolve-effect-enabled.js`'s "MUST call this" — the same mechanism, the
 * fourth time (memory: `v2-postmortem-the-failure-modes`). A good door that is
 * OPTIONAL loses, every time, because bypassing it is cheaper today and today is
 * when every line gets written.
 *
 * So the door is no longer optional. The `log/one-door` tripwire in
 * `tools/verify-structure.mjs` FAILS THE BUILD on `console.*` outside this file
 * and `diag/flight-recorder.js` (the module that patches console, and therefore
 * cannot be forbidden from touching it). The remaining bypasses are ratcheted:
 * they can shrink, never grow.
 *
 * ============================================================================
 * PRINTING AND RECORDING ARE DIFFERENT DIALS
 * ============================================================================
 *
 * `setLogLevel` controls what reaches the **console**. It does NOT control what
 * reaches the **flight recorder**: the sink gets every call, always, including
 * DEBUG. That decoupling is the whole point of a black box — you cannot ask
 * someone to reproduce a bug with verbose logging enabled *after* the bug has
 * already happened. The console stays readable; the recorder stays complete.
 *
 * @module core/log
 */

const PREFIX = 'Map Shine Advanced';

/**
 * Log levels — the PRINT threshold only (see this file's header).
 * @enum {number}
 */
const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

/** Which console method each level prints through. */
const CONSOLE_METHOD = Object.freeze({
  debug: 'log',
  info: 'log',
  warn: 'warn',
  error: 'error',
});

const LEVEL_VALUE = Object.freeze({
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
});

let currentLogLevel = LogLevel.INFO;

/** @type {((entry: {level: string, subsystem: string|null, message: string, data?: any}) => void)|null} */
let sink = null;
let sinkFailures = 0;

/**
 * Re-entrancy depth for {@link isLoggerPrinting}. A counter rather than a
 * boolean so a logger call made from inside a logger call (a `data` getter that
 * logs, say) cannot clear the flag early on its way out.
 */
let printDepth = 0;

/**
 * Install the flight recorder's sink. Every log call is forwarded here
 * regardless of the console print level.
 * @param {((entry: {level: string, subsystem: string|null, message: string, data?: any}) => void)|null} fn
 * @public
 */
export function setLogSink(fn) {
  sink = fn;
  sinkFailures = 0;
}

/**
 * True while this module is printing to the console.
 *
 * `diag/flight-recorder.js` patches `console` to catch FOREIGN traffic (Foundry
 * core, other modules, un-migrated call sites). Without this flag it would also
 * catch our own output and record every MSA line twice — once with structure
 * from the sink, once as a flattened string from the patch.
 * @returns {boolean}
 * @public
 */
export function isLoggerPrinting() {
  return printDepth > 0;
}

/**
 * Set the minimum level that reaches the CONSOLE. Does not affect what the
 * flight recorder captures — see this file's header.
 * @param {number} level - Log level from LogLevel enum
 * @public
 */
export function setLogLevel(level) {
  currentLogLevel = level;
}

/** @returns {number} the current console print threshold. @public */
export function getLogLevel() {
  return currentLogLevel;
}

/**
 * The one path every log takes. Records first, prints second — if printing
 * throws (a getter with an opinion, a detached console), the entry is already
 * safely in the box.
 *
 * @param {string} levelName
 * @param {string|null} subsystem
 * @param {string} message
 * @param {any[]} args
 */
function emit(levelName, subsystem, message, args) {
  if (sink) {
    try {
      sink({
        level: levelName,
        subsystem,
        message: String(message),
        ...(args.length ? { data: args.length === 1 ? args[0] : args } : {}),
      });
    } catch (err) {
      // Never silent (`no-silent-catch`), never repeated: a broken sink must not
      // become a broken app, and must not spam the console it broke. Reported
      // once, through the console door directly — this file IS that door.
      sinkFailures += 1;
      if (sinkFailures === 1) {
        console.error(`${PREFIX} | log sink threw — logs are NOT being recorded from here on:`, err);
      }
    }
  }

  if (currentLogLevel <= LEVEL_VALUE[levelName]) {
    const scoped = subsystem ? `${PREFIX} | ${subsystem}` : PREFIX;
    const tag = levelName === 'debug' ? `${scoped} | [DEBUG]` : scoped;
    printDepth += 1;
    try {
      console[CONSOLE_METHOD[levelName]](`${tag} ${message}`, ...args);
    } finally {
      // finally, not a trailing decrement: a console that throws must not leave
      // the flag stuck on, which would silently disable foreign capture forever.
      printDepth -= 1;
    }
  }
}

/**
 * Log debug message. Always recorded; printed only in verbose mode.
 * @param {string} message - Message to log
 * @param {...*} args - Additional arguments
 * @public
 */
export function debug(message, ...args) {
  emit('debug', null, message, args);
}

/**
 * Log informational message
 * @param {string} message - Message to log
 * @param {...*} args - Additional arguments
 * @public
 */
export function info(message, ...args) {
  emit('info', null, message, args);
}

/**
 * Log warning message
 * @param {string} message - Message to log
 * @param {...*} args - Additional arguments
 * @public
 */
export function warn(message, ...args) {
  emit('warn', null, message, args);
}

/**
 * Log error message
 * @param {string} message - Message to log
 * @param {...*} args - Additional arguments
 * @public
 */
export function error(message, ...args) {
  emit('error', null, message, args);
}

/**
 * Create a scoped logger for a specific subsystem.
 *
 * The subsystem is carried as STRUCTURE, not baked into the message string —
 * so the flight recorder can group and filter by it. A prefix glued onto text is
 * only a prefix; a field is a fact.
 *
 * @param {string} subsystem - Subsystem name (e.g., 'Renderer', 'Assets')
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}} Scoped logger instance
 * @public
 */
export function createLogger(subsystem) {
  return {
    debug: (message, ...args) => emit('debug', subsystem, message, args),
    info: (message, ...args) => emit('info', subsystem, message, args),
    warn: (message, ...args) => emit('warn', subsystem, message, args),
    error: (message, ...args) => emit('error', subsystem, message, args),
  };
}

export { LogLevel };
