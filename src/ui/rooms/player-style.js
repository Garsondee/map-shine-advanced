/**
 * ui/rooms/player-style.js — the Player room's stylesheet ("Performance &
 * Graphics": a small, calm window for every connected client), on the shared kit.
 *
 * Until 2026-10-18 this room carried ~30 lines of its own and nothing else — and its
 * body is the SAME generated component tree the Studio's System department shows
 * (`system-panel.js`), which in the Studio gets its switches, selects and type scale
 * from the Studio's stylesheet. Here none of that existed, so under Foundry's real
 * stylesheet a player saw Foundry's own form controls instead: every boolean (even the
 * master "Map Shine Advanced" switch) drawn as an orange pair-of-boxes glyph, every
 * dropdown stretched to the window's width at Foundry's 2rem height, the Close button
 * 26×28, every state change on a 0.5s transition and a click leaving a glowing focus ring.
 * It now uses `room-style.js` — the same press / hover / focus model, switch and field
 * skin as the Studio and the Remote — so the one tree looks and feels the same wherever
 * it renders.
 *
 * @module ui/rooms/player-style
 */

import { HOVER_GATE, MOTION_KEYFRAMES, uiKitCss, uiKitHoverCss, wxChipCss, wxChipHoverCss } from './room-style.js';

export const PLAYER_ROOM_ID = 'msa-player';
/** What the themed tooltip covers for the Player room. */
export const PLAYER_TOOLTIP_SCOPE = `#${PLAYER_ROOM_ID}`;

/** @returns {string} the stylesheet for the Player room. */
export function playerCss() {
  const R = `#${PLAYER_ROOM_ID}`;
  const IN = `:is(${R})`;

  return `
${MOTION_KEYFRAMES}

${R}{position:fixed; top:44px; right:24px; width:360px; max-width:calc(100vw - 48px);
  max-height:calc(100vh - 60px); background:var(--glass); backdrop-filter:blur(var(--glass-blur));
  border:1px solid var(--line); border-radius:var(--r-room); box-shadow:var(--shadow3);
  display:flex; flex-direction:column; overflow:hidden; z-index:100; font:12px/1.4 var(--font); color:var(--ink0);
  transform-origin:100% 0}
/* An author \`display\` outranks the browser's own \`[hidden]\`; Foundry's sheet happens to carry an
   \`!important\` one, but a room should not depend on that. */
${R}[hidden]{display:none !important}
/* Opened by a mouse click: an occasional action, so a short entrance (ease-out, 200ms, from
   .985 — never from 0). Closing is instant. */
${R}.msa-enter{animation:msaRoomIn 200ms var(--ease-out) both}

${uiKitCss(IN, { pressInside: ['.msa-wx-chip'] })}

${R} .msa-player-head{display:flex; align-items:center; gap:var(--sp2); padding:8px 14px;
  border-bottom:1px solid var(--line); flex:none; cursor:grab; user-select:none}
${R} .msa-player-head:active{cursor:grabbing}
${R} .msa-player-title{font-weight:600; letter-spacing:.1em; font-size:.72rem; text-transform:uppercase;
  color:var(--ink1); display:flex; gap:8px; align-items:center}
${R} .msa-player-title .ico{color:var(--shine)}
${R} .msa-spacer{flex:1}
/* the header's icon button is 26px (the kit's own is 24) — the same size as the Remote's */
${R} .hbtn{width:26px; height:26px; border-radius:6px}
${R} .msa-player-body{flex:1; overflow-y:auto; padding:14px;
  scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent}

/* THE CARRIED-LIGHT PICKER (mythica-machina-press#77) — its own sibling section, above the
   scrollable settings body, same DOM position every other room's own fixed-header-strip lives
   at. Reuses the Remote's own .msa-wx-* chip/label vocabulary (weather-board.js's own idiom)
   rather than a third toggle language — the chip's look is the kit's wxChipCss; only its layout
   (a wrapping row of pills here, a 4-column grid in the Remote) is this room's own. */
${R} .msa-player-light-host{flex:none; padding:10px 14px 0 14px}
${R} .msa-wx-blocklabel{font-size:.64rem; letter-spacing:.22em; text-transform:uppercase;
  color:var(--ink2); display:flex; align-items:center; gap:6px; margin-bottom:6px}
${R} .msa-wx-hint{letter-spacing:.02em; text-transform:none; color:var(--ink2); opacity:.8; font-size:.68rem}
/* a note that is its own full-width line under the chips (the same class the Remote's board uses) */
${R} .msa-wx-hint--block{margin-left:0}
${R} .msa-wx-chips{display:flex; flex-wrap:wrap; gap:5px; margin-top:6px}
${wxChipCss(R)}
${R} .msa-wx-chip{padding:5px 8px}

${HOVER_GATE}{
${uiKitHoverCss(IN)}
${wxChipHoverCss(R)}
}
`.trim();
}
