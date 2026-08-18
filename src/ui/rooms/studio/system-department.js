/**
 * ui/rooms/studio/system-department.js — the Studio's own door onto THE
 * SYSTEM PANEL (U5, docs/holy/UI-Testament.md §5.5): a thin wrapper, all the
 * real content lives in `ui/rooms/system-panel.js`, the "one generated
 * surface, two renderings" component both this department and the Player
 * room mount. `isGM` here reads `ctx.debugPanel.isGM()` — the SAME source
 * LAB's own dev-gate already reads (`shell.js`'s own `render()`) — never a
 * second isGM path.
 *
 * ⚠️ `ctx.getSystemPanelCtx` IS A FUNCTION, NOT A PLAIN OBJECT — called fresh
 * on every render, never cached, matching `registerEffectCard`'s own rule
 * for the identical reason: `effectRows`/`profiles`/`enableChoices` are
 * built from module-level consts declared FAR below `installStudio()`'s own
 * eager call site in boot.js (the settings-panel registration, ~8,000 lines
 * later) — a plain object literal at that call site would hit a temporal-
 * dead-zone `ReferenceError` the instant `install()` ran. A getter defers
 * every read to actual render time, well after `install()` has finished
 * once — the same deferral `mountAstrolabeDial`/`weatherBoard` already rely
 * on for their own later-declared closure state.
 *
 * @module ui/rooms/studio/system-department
 */

import { renderSystemPanel } from '../system-panel.js';

/**
 * @param {HTMLElement} container
 * @param {{debugPanel?: {isGM?: () => boolean}, getSystemPanelCtx?: () => object}} ctx
 * @returns {string} department subtitle.
 */
export function renderSystemDepartment(container, ctx) {
  if (typeof ctx.getSystemPanelCtx !== 'function') {
    container.innerHTML =
      '<div style="color:var(--ink2); font-size:.8rem; padding:20px">System settings are not available.</div>';
    return "profile, per-effect enables, and this table's own defaults";
  }
  return renderSystemPanel(container, {
    isGM: () => ctx.debugPanel?.isGM?.() ?? false,
    ...ctx.getSystemPanelCtx(),
  });
}
