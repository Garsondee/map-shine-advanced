/**
 * foundry/scene-controls-button.js — the scene-controls (left palette) entry
 * points for MSA's rooms: Anchor View, Studio, Remote, Player.
 *
 * legacy/module.js registered FOUR separate scene-controls buttons
 * (map-shine-config, map-shine-control, map-shine-graphics-options,
 * map-shine-player-light) — the same "many dialogues" disease UI.md and
 * Effects-UI.md diagnose everywhere else in V2, just one layer up. V3's own
 * FIRST answer (2026-07-20) was ONE toggle button for a single panel, whose
 * zones a permission filter picked between; that panel is gone now (UI
 * parity plan, phase 7b), superseded by the room split below — one toggle
 * per room (Studio/Remote/Player), same "no synthetic top-level control"
 * discipline this file has always used, just no longer funnelled through one
 * shared shell.
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

const ANCHOR_VIEW_TOOL_NAME = 'map-shine-anchor-view';
const STUDIO_TOOL_NAME = 'map-shine-studio';
const REMOTE_TOOL_NAME = 'map-shine-remote';
const PLAYER_TOOL_NAME = 'map-shine-player';

// `registerControlPanelButton`/`syncControlPanelButtonState` (the old
// `map-shine-advanced` toggle, `order: 100`) were deleted here in the UI
// parity plan's phase 7b, alongside the rest of the old panel
// (diag/debug-panel.js's own rail/zone shell) — registerStudioButton/
// registerRemoteButton/registerPlayerButton below are the surviving entry
// points. `order: 101` on Anchor View, just below, is a leftover of that old
// button's own `100` — kept as-is rather than renumbered, since scene-control
// tool order only has to be internally consistent, not start at any
// particular value.

/**
 * THE ANCHOR VIEW TOGGLE (author request, 2026-08-06) — opens
 * ui/anchor-view-mode.js: every candle/lightning anchor shown at once, on or
 * off, right-click to flip. A tool in the SAME `tokens.tools` record as
 * every other MSA toggle here, never a second top-level control (a synthetic
 * top-level control would steal "the active control" away from whatever
 * layer the user actually had selected).
 *
 * GM-ONLY visibility — turning off someone else's candles is a
 * scene-authoring action, not something a player should be able to reach
 * from their own toolbar. `visible` is read
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
 * toolbar button — the same "cached `active` must be mutated directly, then
 * force a re-render" technique every sync function in this file uses.
 * @param {boolean} active
 */
export function syncAnchorViewModeButtonState(active) {
  const tool = ui?.controls?.controls?.tokens?.tools?.[ANCHOR_VIEW_TOOL_NAME];
  if (!tool) return;
  tool.active = !!active;
  ui.controls.render(true);
}

/**
 * THE STUDIO TOGGLE (U1, docs/holy/UI-Testament.md §9) — a tool in the same
 * `tokens.tools` record as every other MSA toggle here (`order: 102`, right
 * after Anchor View's `101`).
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
      // "(new UI, in progress)" dropped (UI parity plan, phase 7c) — the old
      // panel it was qualifying itself against is gone; this IS the UI now.
      title: 'MSA Studio',
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
 * Close button) rather than via a click on this exact toolbar button — the
 * same "mutate the cached `active`, then force a re-render" technique every
 * sync function in this file uses.
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
      // "(new UI, in progress)" dropped (UI parity plan, phase 7c) — see
      // registerStudioButton's own comment.
      title: 'MSA Remote',
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
 * Close button) rather than via a click on this exact toolbar button — the
 * same "mutate the cached `active`, then force a re-render" technique every
 * sync function in this file uses.
 * @param {boolean} active
 */
export function syncRemoteButtonState(active) {
  const tool = ui?.controls?.controls?.tokens?.tools?.[REMOTE_TOOL_NAME];
  if (!tool) return;
  tool.active = !!active;
  ui.controls.render(true);
}

/**
 * THE PLAYER TOGGLE (U5, docs/holy/UI-Testament.md §5.5) — a tool in the
 * same `tokens.tools` record as every other MSA toggle here (`order: 104`,
 * right after the Remote's `103`).
 *
 * `visible: true`, unlike Anchor View/Studio/Remote's own GM-only gate — the
 * Player room's own content is never GM-only regardless of who opens it
 * (`ui/rooms/player-shell.js`'s own header explains why).
 * @param {{ isActive: () => boolean, onToggle: (nextActive: boolean) => void }} handlers
 */
export function registerPlayerButton({ isActive, onToggle }) {
  Hooks.on('getSceneControlButtons', (controls) => {
    const tokenControls = controls?.tokens;
    if (!tokenControls?.tools) return;
    if (Object.prototype.hasOwnProperty.call(tokenControls.tools, PLAYER_TOOL_NAME)) return;
    tokenControls.tools[PLAYER_TOOL_NAME] = {
      name: PLAYER_TOOL_NAME,
      // "(new UI, in progress)" dropped (UI parity plan, phase 7c) — see
      // registerStudioButton's own comment.
      title: 'Performance & Graphics',
      icon: 'fas fa-sliders',
      toggle: true,
      order: 104,
      visible: true,
      active: isActive(),
      onChange: (_event, active) => onToggle(active),
    };
  });
}

/** Re-sync this toggle's highlight when the Player room closes itself (its
 * own Close button) rather than via a click on this exact toolbar button —
 * the same "mutate the cached `active`, then force a re-render" technique
 * every sync function in this file uses.
 * @param {boolean} active
 */
export function syncPlayerButtonState(active) {
  const tool = ui?.controls?.controls?.tokens?.tools?.[PLAYER_TOOL_NAME];
  if (!tool) return;
  tool.active = !!active;
  ui.controls.render(true);
}
