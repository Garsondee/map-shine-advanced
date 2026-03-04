/**
 * @fileoverview Legacy circuit breaker panel (decommissioned).
 * @module ui/circuit-breaker-panel
 */

export async function openCircuitBreakerPanel() {
  const msg = 'Circuit Breaker has been removed. V2 compositor paths now run without kill switches.';
  globalThis.ui?.notifications?.info?.(msg);
}
