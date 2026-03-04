/**
 * @fileoverview Legacy circuit breaker compatibility shim.
 * Kill switches are decommissioned; this API now always reports effects enabled.
 * @module core/circuit-breaker
 */

export class CircuitBreaker {
  getState() {
    return { version: 1, disabled: {} };
  }

  /** @returns {false} */
  isDisabled(_effectId) {
    return false;
  }

  setDisabled(_effectId, _disabled) {
    // no-op: kill switches removed
  }

  clear(_effectId) {
    // no-op: kill switches removed
  }

  clearAll() {
    // no-op: kill switches removed
  }

  ensureKnown(_defs) {
    // no-op: kill switches removed
  }
}

/** @type {CircuitBreaker|null} */
let _singleton = null;

export function getCircuitBreaker() {
  if (!_singleton) _singleton = new CircuitBreaker();
  return _singleton;
}

export const CIRCUIT_BREAKER_EFFECTS = Object.freeze([]);
