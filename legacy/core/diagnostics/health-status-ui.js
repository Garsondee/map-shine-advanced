/**
 * @fileoverview Shared Breaker Box status colors, weights, and tooltip builders.
 * @module core/diagnostics/health-status-ui
 */

export const STATUS_WEIGHT = {
  unknown: 0,
  healthy: 1,
  degraded: 2,
  broken: 3,
  critical: 4,
};

/**
 * @param {string} status
 * @returns {string}
 */
export function colorForStatus(status) {
  if (status === 'critical') return '#ff3b30';
  if (status === 'broken') return '#ff453a';
  if (status === 'degraded') return '#ff9f0a';
  if (status === 'healthy') return '#30d158';
  return '#8e8e93';
}

/**
 * @param {object|null} snapshot
 * @returns {string}
 */
export function headlineHealthStatus(snapshot) {
  if (!snapshot) return 'unknown';
  const af = snapshot.activeFloorOverallStatus ?? snapshot.meta?.activeFloorOverallStatus;
  if (af && af !== 'unknown') return af;
  return snapshot.overallStatus || 'unknown';
}

/**
 * @param {object[]} checks
 * @returns {object[]}
 */
export function failedChecks(checks) {
  return (Array.isArray(checks) ? checks : []).filter((c) => c?.result === 'fail');
}

/**
 * @param {object} check
 * @returns {boolean}
 */
export function isMissingMaskCheck(check) {
  return String(check?.ruleId || '') === 'missingRequiredMask';
}

/**
 * @param {object|null} effectRow
 * @returns {object|null}
 */
export function firstMissingMaskCheckForEffect(effectRow) {
  for (const lvl of effectRow?.byLevel || []) {
    for (const c of lvl?.checks || []) {
      if (c?.result === 'fail' && isMissingMaskCheck(c)) return { levelKey: lvl.levelKey, ...c };
    }
  }
  return null;
}

/**
 * Collect missing-mask failures across snapshot effects (active floor preferred).
 * @param {object|null} snapshot
 * @returns {object[]}
 */
export function collectMissingMaskIssues(snapshot) {
  const activeKey = snapshot?.meta?.activeFloorKey ?? `floor:${snapshot?.runtime?.activeFloor ?? 0}`;
  /** @type {object[]} */
  const issues = [];
  for (const effect of snapshot?.effects || []) {
    for (const lvl of effect.byLevel || []) {
      if (lvl.levelKey !== activeKey && lvl.levelKey !== 'global:active' && lvl.levelKey !== 'global:scene') {
        continue;
      }
      for (const c of lvl.checks || []) {
        if (c?.result === 'fail' && isMissingMaskCheck(c)) {
          issues.push({
            effectId: effect.effectId,
            levelKey: lvl.levelKey,
            status: lvl.status,
            ...c,
          });
        }
      }
    }
  }
  issues.sort((a, b) => (STATUS_WEIGHT[b.severity === 'error' ? 'broken' : 'degraded'] || 0)
    - (STATUS_WEIGHT[a.severity === 'error' ? 'broken' : 'degraded'] || 0));
  return issues;
}

/**
 * @param {object|null} snapshot
 * @returns {string}
 */
export function headlineTooltip(snapshot) {
  const status = headlineHealthStatus(snapshot);
  if (status === 'healthy' || status === 'unknown') {
    return status === 'healthy' ? 'Map Shine: all tracked effects healthy' : 'Open Breaker Box';
  }
  const issues = collectMissingMaskIssues(snapshot);
  if (issues.length > 0) {
    const top = issues[0];
    const label = top.tooltip || top.message || 'Missing mask texture';
    if (issues.length === 1) return `Map Shine: ${label}`;
    return `Map Shine: ${label} (+${issues.length - 1} more — open Breaker Box)`;
  }
  const bad = (snapshot?.effects || []).find((e) => e.status === status || e.status === 'broken' || e.status === 'critical');
  if (bad) return `Map Shine: ${bad.effectId} is ${bad.status}`;
  return `Map Shine: ${status} — open Breaker Box`;
}

/**
 * @param {object|null} node
 * @param {object|null} snapshot
 * @returns {string}
 */
export function tooltipForGraphNode(node, snapshot) {
  if (!node) return '';
  const effect = (snapshot?.effects || []).find((e) => e.effectId === node.id);
  if (effect) {
    const miss = firstMissingMaskCheckForEffect(effect);
    if (miss) return miss.tooltip || miss.message || `${node.label} (${node.status})`;
    const fails = [];
    for (const lvl of effect.byLevel || []) {
      for (const c of lvl.checks || []) {
        if (c?.result === 'fail' && !String(c.ruleId || '').startsWith('propagated:')) {
          fails.push(c.message);
        }
      }
    }
    if (fails.length) return fails.slice(0, 3).join(' · ');
  }
  return `${node.label} (${node.status})`;
}

/**
 * @param {object|null} snapshot
 * @returns {string}
 */
export function missingMaskSummaryLine(snapshot) {
  const issues = collectMissingMaskIssues(snapshot);
  if (!issues.length) return '';
  const parts = issues.slice(0, 3).map((i) => i.message || i.tooltip);
  const tail = issues.length > 3 ? ` (+${issues.length - 3} more)` : '';
  return parts.join(' · ') + tail;
}
