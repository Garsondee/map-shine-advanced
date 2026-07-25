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
