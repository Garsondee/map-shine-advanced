/**
 * ui/rooms/studio/lab-department.js — "today's debug panel registry, whole"
 * (U1, docs/holy/UI-Testament.md §5.1, §9). Mounts `MapShine.debug`'s real
 * reports/actions/controls/panels — the SAME registries the old panel's own
 * Lab zone reads, never a second registry — via `renderLabBody()`
 * (diag/debug-panel.js), which was refactored to return a detached root
 * instead of appending into the old panel's own body. This module gives
 * that returned body its own status readout, so a report/action triggered
 * from the Studio shows its result HERE, not in the old panel's footer
 * (which may not even be open during side-by-side rollout).
 *
 * Dev-gated: the shell only renders this department's rail button reachable
 * when `MapShine.debug.isGM()` is true (see shell.js) — the OLD panel's own
 * current real gate, not yet the fuller "debug dress" flag the Testament
 * describes (unbuilt anywhere in src/ today; see Petition P10).
 *
 * @module ui/rooms/studio/lab-department
 */

/**
 * @param {HTMLElement} container
 * @param {{debugPanel?: object}} ctx - `debugPanel` is `MapShine.debug`,
 *   threaded through by shell.js (never read off a global — see shell.js's
 *   own `installStudio` doc).
 * @returns {string} department subtitle.
 */
export function renderLabDepartment(container, { debugPanel } = {}) {
  container.innerHTML = '';

  if (typeof debugPanel?.renderLabBody !== 'function') {
    const notice = document.createElement('div');
    notice.className = 'msa-empty';
    notice.textContent = 'The debug panel has not installed yet — the Lab has nothing to mount.';
    container.append(notice);
    return 'dev-gated — customers never wander in';
  }

  const banner = document.createElement('div');
  banner.className = 'msa-banner';
  banner.textContent =
    'The same reports, actions, and tools the old panel’s Lab zone has always had — mounted here, not duplicated.';

  const statusEl = document.createElement('div');
  statusEl.className = 'msa-banner msa-banner--quiet';
  statusEl.setAttribute('role', 'status');
  statusEl.textContent = 'Output copies to your clipboard.';

  const body = debugPanel.renderLabBody({ getStatusEl: () => statusEl });

  container.append(banner, statusEl, body);
  return 'dev-gated — customers never wander in';
}
