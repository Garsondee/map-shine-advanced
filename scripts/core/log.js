/**
 * @fileoverview Centralized logging utility for Map Shine Advanced
 * @module core/log
 */

const PREFIX = 'Map Shine Advanced';

/**
 * Log levels
 * @enum {number}
 */
const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

let currentLogLevel = LogLevel.INFO;

/**
 * Set the minimum log level
 * @param {number} level - Log level from LogLevel enum
 * @public
 */
export function setLogLevel(level) {
  currentLogLevel = level;
}

/**
 * Log debug message (verbose mode only)
 * @param {string} message - Message to log
 * @param {...*} args - Additional arguments
 * @public
 */
export function debug(message, ...args) {
  if (currentLogLevel <= LogLevel.DEBUG) {
    console.log(`${PREFIX} | [DEBUG] ${message}`, ...args);
  }
}

/**
 * Log informational message
 * @param {string} message - Message to log
 * @param {...*} args - Additional arguments
 * @public
 */
export function info(message, ...args) {
  if (currentLogLevel <= LogLevel.INFO) {
    console.log(`${PREFIX} | ${message}`, ...args);
  }
}

/**
 * Log warning message
 * @param {string} message - Message to log
 * @param {...*} args - Additional arguments
 * @public
 */
export function warn(message, ...args) {
  if (currentLogLevel <= LogLevel.WARN) {
    console.warn(`${PREFIX} | ${message}`, ...args);
  }
}

/**
 * Log error message
 * @param {string} message - Message to log
 * @param {...*} args - Additional arguments
 * @public
 */
export function error(message, ...args) {
  if (currentLogLevel <= LogLevel.ERROR) {
    console.error(`${PREFIX} | ${message}`, ...args);
  }
}

/**
 * Create a scoped logger for a specific subsystem
 * @param {string} subsystem - Subsystem name (e.g., 'Renderer', 'Assets')
 * @returns {Object} Scoped logger instance
 * @public
 */
export function createLogger(subsystem) {
  const scopedPrefix = `${PREFIX} | ${subsystem}`;
  
  return {
    debug: (message, ...args) => {
      if (currentLogLevel <= LogLevel.DEBUG) {
        console.log(`${scopedPrefix} | [DEBUG] ${message}`, ...args);
      }
    },
    info: (message, ...args) => {
      if (currentLogLevel <= LogLevel.INFO) {
        console.log(`${scopedPrefix} | ${message}`, ...args);
      }
    },
    warn: (message, ...args) => {
      if (currentLogLevel <= LogLevel.WARN) {
        console.warn(`${scopedPrefix} | ${message}`, ...args);
      }
    },
    error: (message, ...args) => {
      if (currentLogLevel <= LogLevel.ERROR) {
        console.error(`${scopedPrefix} | ${message}`, ...args);
      }
    }
  };
}

export { LogLevel };
