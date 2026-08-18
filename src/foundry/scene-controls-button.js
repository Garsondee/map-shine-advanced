/**
 * foundry/scene-controls-button.js — the ONE scene-controls (left palette)
 * entry point for opening the MSA control panel (docs/planning/Control-Panel.md).
 *
 * legacy/module.js registered FOUR separate scene-controls buttons
 * (map-shine-config, map-shine-control, map-shine-graphics-options,
 * map-shine-player-light) — the same "many dialogues" disease UI.md and
 * Effects-UI.md diagnose everywhere else in V2, just one layer up. V3 gets
 * ONE toggle button; WHICH zones it opens into is decided INSIDE the panel
 * by permission (Control-Panel.md §2: "permission is a FILTER over one
 * layout, not a fork"), not by which button was clicked.
 *
 * Injects a TOGGLE tool into Foundry's existing 'tokens' scene-control set,
 * matching legacy's own `ensureTool` pattern (a button/toggle tool added to
 * an existing layer's tool list) rather than registering a whole new
 * top-level control. A synthetic top-level control would become "the active
 * control" on click, deactivating whatever real layer (tokens, walls,
 * lighting…) the user had selected, just to show a dialog — a side effect
 * a tool tucked into an existing control's flyout does not have.
 *
 * Verified against the real v14 source (foundryvttsourcecode_v14/resources/app/
 * client/applications/ui/scene-controls.mjs): `getSceneControlButtons` receives
 * a plain `Record<string, SceneControl>`, each `SceneControl.tools` is itself a
 * `Record<string, SceneControlTool>` (v14 dropped the array shape legacy's code
 * still juggled for older versions) — so this file targets the record shape only.
 */

const TOOL_NAME = 'map-shine-advanced';
const ANCHOR_VIEW_TOOL_NAME = 'map-shine-anchor-view';
const STUDIO_TOOL_NAME = 'map-shine-studio';
const REMOTE_TOOL_NAME = 'map-shine-remote';

/**
 * @param {{ isActive: () => boolean, onToggle: (nextActive: boolean) => void }} handlers
 */
export function registerControlPanelButton({ isActive, onToggle }) {
  Hooks.on('getSceneControlButtons', (controls) => {
    const tokenControls = controls?.tokens;
    if (!tokenControls?.tools) return;
    if (Object.prototype.hasOwnProperty.call(tokenControls.tools, TOOL_NAME)) return;
    tokenControls.tools[TOOL_NAME] = {
      name: TOOL_NAME,
      title: 'Map Shine Advanced',
      icon: 'fas fa-key',
      toggle: true,
      order: 100,
      visible: true, // both GM and player see the ONE button; the panel filters its OWN content
      active: isActive(),
      onChange: (_event, active) => onToggle(active),
    };
  });
}

/**
 * Re-sync the toolbar tool's active/inactive highlight after the panel's OWN
 * state changes for a reason other than clicking this exact toolbar button
 * (its in-panel Close button, or a GM's default-open on boot) — the same
 * technique legacy/module.js used (`_setToolActiveStateOnSceneControls` +
 * a forced re-render), because SceneControls only re-derives its `tools`
 * record on a full prepare; a plain re-render just re-paints what is already
 * cached, so the cached `active` flag must be mutated directly first.
 * @param {boolean} active
 */
export function syncControlPanelButtonState(active) {
  const tool = ui?.controls?.controls?.tokens?.tools?.[TOOL_NAME];
  if (!tool) return; // scene controls have not prepared yet — their own next natural render carries the real state via isActive()
  tool.active = !!active;
  ui.controls.render(true);
}

/**
 * THE ANCHOR VIEW TOGGLE (author request, 2026-08-06) — "a button just below
 * the MSA button" that opens ui/anchor-view-mode.js: every candle/lightning
 * anchor shown at once, on or off, right-click to flip. A SECOND tool in the
 * SAME `tokens.tools` record as the MSA button above (never a second
 * top-level control, for the identical reason `registerControlPanelButton`'s
 * own header gives — a synthetic top-level control would steal "the active
 * control" away from whatever layer the user actually had selected); `order:
 * 101` sorts it immediately after the MSA button's own `order: 100`.
 *
 * GM-ONLY visibility, unlike the MSA button's own `visible: true` — turning
 * off someone else's candles is a scene-authoring action, not something a
 * player should be able to reach from their own toolbar. `visible` is read
 * ONCE per `getSceneControlButtons` firing (verified against the real v14
 * source, scene-controls.mjs: `if (tool.visible === false) delete
 * control.tools[toolId]`, evaluated inline, not a live binding) — reading
 * `game.user.isGM` at that moment is correct because each client only ever
 * sees its own `game.user`.
 *
 * @param {{ isActive: () => boolean, onToggle: (nextActive: boolean) => void }} handlers
 */
export function registerAnchorViewModeButton({ isActive, onToggle }) {
  Hooks.on('getSceneControlButtons', (controls) => {
    const tokenControls = controls?.tokens;
    if (!tokenControls?.tools) return;
    if (Object.prototype.hasOwnProperty.call(tokenControls.tools, ANCHOR_VIEW_TOOL_NAME)) return;
    tokenControls.tools[ANCHOR_VIEW_TOOL_NAME] = {
      name: ANCHOR_VIEW_TOOL_NAME,
      title: 'MSA Anchor View — see & toggle candle/lightning anchors',
      icon: 'fas fa-map-pin',
      toggle: true,
      order: 101,
      visible: game.user?.isGM === true,
      active: isActive(),
      onChange: (_event, active) => onToggle(active),
    };
  });
}

/** Re-sync this toggle's highlight when the view mode ends itself (its own
 * in-canvas Done button, or Escape) rather than via a click on this exact
 * toolbar button — mirrors `syncControlPanelButtonState` exactly.
 * @param {boolean} active
 */
export function syncAnchorViewModeButtonState(active) {
  const tool = ui?.controls?.controls?.tokens?.tools?.[ANCHOR_VIEW_TOOL_NAME];
  if (!tool) return;
  tool.active = !!active;
  ui.controls.render(true);
}

/**
 * THE STUDIO TOGGLE (U1, docs/holy/UI-Testament.md §9) — a THIRD tool in the
 * same `tokens.tools` record, the identical low-risk mechanism proven twice
 * already above (`order: 102`, right after Anchor View's `101`). This is the
 * side-by-side rollout switch: the old panel's own button stays exactly as
 * it is, this one opens the new Studio next to it, and nothing about either
 * button's own behaviour changes based on the other existing.
 *
 * GM-ONLY, matching Anchor View's own reasoning: the Studio is an authoring
 * surface (EFFECTS/PAINTER/SCENE/CUES/LAB) with no player-facing content of
 * its own yet — SYSTEM (U5), "restyled, IS the player face" per the
 * Testament, is a separate, later surface, not a reason to show a GM-only
 * shell's toggle to a non-GM today.
 * @param {{ isActive: () => boolean, onToggle: (nextActive: boolean) => void }} handlers
 */
export function registerStudioButton({ isActive, onToggle }) {
  Hooks.on('getSceneControlButtons', (controls) => {
    const tokenControls = controls?.tokens;
    if (!tokenControls?.tools) return;
    if (Object.prototype.hasOwnProperty.call(tokenControls.tools, STUDIO_TOOL_NAME)) return;
    tokenControls.tools[STUDIO_TOOL_NAME] = {
      name: STUDIO_TOOL_NAME,
      title: 'MSA Studio (new UI, in progress)',
      icon: 'fas fa-palette',
      toggle: true,
      order: 102,
      visible: game.user?.isGM === true,
      active: isActive(),
      onChange: (_event, active) => onToggle(active),
    };
  });
}

/** Re-sync this toggle's highlight when the Studio closes itself (its own
 * Close button) rather than via a click on this exact toolbar button —
 * mirrors `syncControlPanelButtonState` exactly.
 * @param {boolean} active
 */
export function syncStudioButtonState(active) {
  const tool = ui?.controls?.controls?.tokens?.tools?.[STUDIO_TOOL_NAME];
  if (!tool) return;
  tool.active = !!active;
  ui.controls.render(true);
}

/**
 * THE REMOTE TOGGLE (U2, docs/holy/UI-Testament.md §4, §9) — a FOURTH tool
 * in the same `tokens.tools` record, the identical mechanism proven three
 * times over above (`order:103`, right after the Studio's `102`).
 *
 * GM-ONLY for this checkpoint: every piece the Remote renders today (the
 * astrolabe corners, camera path, Now Playing) is GM-facing session control,
 * same reasoning as the Studio's own gate. This is NOT yet the Testament's
 * eventual Player face (§5.5, U5) — that is a separate, later surface this
 * button does not open, not a reason to widen visibility here early.
 * @param {{ isActive: () => boolean, onToggle: (nextActive: boolean) => void }} handlers
 */
export function registerRemoteButton({ isActive, onToggle }) {
  Hooks.on('getSceneControlButtons', (controls) => {
    const tokenControls = controls?.tokens;
    if (!tokenControls?.tools) return;
    if (Object.prototype.hasOwnProperty.call(tokenControls.tools, REMOTE_TOOL_NAME)) return;
    tokenControls.tools[REMOTE_TOOL_NAME] = {
      name: REMOTE_TOOL_NAME,
      title: 'MSA Remote (new UI, in progress)',
      icon: 'fas fa-satellite-dish',
      toggle: true,
      order: 103,
      visible: game.user?.isGM === true,
      active: isActive(),
      onChange: (_event, active) => onToggle(active),
    };
  });
}

/** Re-sync this toggle's highlight when the Remote closes itself (its own
 * Close button) rather than via a click on this exact toolbar button —
 * mirrors `syncStudioButtonState` exactly.
 * @param {boolean} active
 */
export function syncRemoteButtonState(active) {
  const tool = ui?.controls?.controls?.tokens?.tools?.[REMOTE_TOOL_NAME];
  if (!tool) return;
  tool.active = !!active;
  ui.controls.render(true);
}
