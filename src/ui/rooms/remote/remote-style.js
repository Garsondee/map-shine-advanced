/**
 * ui/rooms/remote/remote-style.js — the Remote's whole stylesheet (the room, the
 * popovers that hang off it, and the tile-motion panel), in one place.
 *
 * Moved out of `shell.js` and `tile-motion-panel.js` when the Remote got the same
 * polish pass the Studio had (2026-10-18): it was ~400 lines of CSS inline in a
 * 1000-line shell file, plus popovers that were styled entirely with
 * `Object.assign(el.style, ...)` and `style.cssText` strings — which cannot say
 * `:hover`, `:active` or `:focus-visible`, so nothing in them responded to a press.
 * The press / hover / focus model, the switch, the fields and the motion rules
 * come from `../room-style.js` (read its header for the Foundry global-CSS bleed
 * and the motion rules); what is written here is genuinely the Remote's: its
 * layout, the astrolabe's corners, the weather board, the cue deck, the strip.
 *
 * ============================================================================
 * WHAT THE AUDIT FOUND, UNDER FOUNDRY'S REAL CSS (before this sheet)
 * ============================================================================
 * `tools/preview-shared/control-audit.js`, 77 controls in the Remote alone:
 *  - every pressable took 0.5s to change state (60 of 77 — Foundry's
 *    `transition:0.5s`; 59 of them `transition: all`), so a chip's lit state
 *    faded in half a second late;
 *  - a mouse click left Foundry's orange outline + glow behind (62 controls);
 *  - nothing had an :active response (75 of 77);
 *  - `min-height:2em` made 19 buttons taller than drawn: the header buttons
 *    26×28, the corner buttons and ghost slots 26×28 / 26×27, the debug
 *    accordion chevron 20×28 (+8px);
 *  - 63 native `title` tooltips, unthemed, each restarting its delay;
 *  - the `<select>`s stretched (`width:100%; height:2rem`) and every checkbox in
 *    the popovers drew as Foundry's orange pair-of-boxes glyph.
 *
 * ============================================================================
 * THE SPECIFICITY CONTRACT (why most pressables have ONE class)
 * ============================================================================
 * The kit's press group is `IN :is(.a, .b, ...)`; an `:is()` weighs as its MOST
 * specific argument, so one `.x button` (type selector) in the list would raise the
 * whole group above every `#room .chip{...}` rule in this file and the reset's
 * `font:inherit` would flatten their sizes. Every selector in {@link REMOTE_PRESSABLES}
 * is therefore a single class — which is why the code that builds segmented-pill
 * cells, corner buttons, menu rows and footer buttons gives them one.
 *
 * @module ui/rooms/remote/remote-style
 */

import { HOVER_GATE, MOTION_KEYFRAMES, uiKitCss, uiKitHoverCss, wxChipCss, wxChipHoverCss } from '../room-style.js';

export const REMOTE_ROOM_ID = 'msa-remote';
export const CAMERA_PATH_PANEL_ID = 'msa-remote-camera-path';
export const WIND_PANEL_ID = 'msa-remote-wind';
export const TILE_MOTION_ID = 'msa-tile-motion';

/** What the themed tooltip covers for the Remote and everything that hangs off it. */
export const REMOTE_TOOLTIP_SCOPE = `#${REMOTE_ROOM_ID}, #${CAMERA_PATH_PANEL_ID}, #${WIND_PANEL_ID}`;
export const TILE_MOTION_TOOLTIP_SCOPE = `#${TILE_MOTION_ID}`;

/**
 * The Remote's own pressables, joined to the kit's. All single classes (see the
 * specificity contract above); the cell/corner/menu classes are added by the code
 * that builds those buttons.
 */
export const REMOTE_PRESSABLES = Object.freeze([
  '.msa-seg', // a cell of a segmented pill: clock mode, fade time, Direct/Drift
  '.msa-corner-btn', // a button in one of the dial's four corner clusters
  '.msa-menu-item', // a row of the speed / jump menus
  '.msa-wx-chip',
  '.msa-wx-browse',
  '.msa-wx-pin',
  '.msa-astro-pill', // the date and wind pills on the dial
  '.msa-cue-go',
  '.msa-cue-listrow',
  '.msa-cue-listbtn',
  '.msa-debug-btn',
  '.msa-debug-more',
  '.msa-foot-btn', // the footer's buttons and links
]);

/**
 * @returns {string} the stylesheet for the Remote room, the camera-path and wind popovers.
 */
export function remoteCss() {
  const R = `#${REMOTE_ROOM_ID}`;
  const CP = `#${CAMERA_PATH_PANEL_ID}`;
  const WP = `#${WIND_PANEL_ID}`;
  // The room and the two popovers; every component rule of the kit is scoped under it.
  const IN = `:is(${R}, ${CP}, ${WP})`;

  return `
${MOTION_KEYFRAMES}

/* ---- the room ------------------------------------------------------------------
   THE CARD (2026-08-27 round 2, author: "the +/- UI is overlapping other parts of
   the ui... moved to the left till it sits on the outside of the panel"):
   everything the room used to put on its own root (background / border / radius /
   shadow, the overflow:hidden that clips head, body and foot's square inner
   corners to the room's rounded outer ones) lives on this inner wrapper. The
   root keeps ONLY position / size / z-index -- an unclipped box a child can escape
   to the left of, which the scale strip (a sibling of the card) does.
   The entrance plays on the CARD, never the root: the root carries the user's
   interface scale as an inline transform, and an animation on it would flatten
   that scale for 200ms every time the room opened. */
${R}{position:fixed; top:44px; right:24px; width:400px; max-width:calc(100vw - 48px);
  z-index:100; font:12px/1.4 var(--font); color:var(--ink0)}
${R} .msa-remote-card{width:100%; max-height:calc(100vh - 60px); background:var(--glass);
  backdrop-filter:blur(var(--glass-blur)); border:1px solid var(--line); border-radius:var(--r-room);
  box-shadow:var(--shadow3); display:flex; flex-direction:column; overflow:hidden; transform-origin:50% 0}
/* Opened by a mouse click on the toolbar: an occasional action, so a short entrance
   (ease-out, 200ms, from .985 — never from 0). Closing is instant. */
${R} .msa-remote-card.msa-enter{animation:msaRoomIn 200ms var(--ease-out) both}
${R}[data-minimized="true"] .msa-remote-body,
${R}[data-minimized="true"] .msa-remote-foot,
${R}[data-minimized="true"] .msa-renderer-row{display:none}

${uiKitCss(IN, { pressInside: REMOTE_PRESSABLES })}

/* ---- the header ---------------------------------------------------------------- */
${R} .msa-remote-head{display:flex; align-items:center; gap:var(--sp2); padding:8px 14px;
  border-bottom:1px solid var(--line); flex:none; cursor:grab; user-select:none}
${R} .msa-remote-head:active{cursor:grabbing}
${R} .msa-remote-title{font-weight:600; letter-spacing:.1em; font-size:.72rem; text-transform:uppercase;
  color:var(--ink1); display:flex; gap:8px; align-items:center}
${R} .msa-remote-title .ico{color:var(--shine)}
${R} .msa-spacer{flex:1}
/* the header's icon buttons are 26px (the kit's own is 24) */
${R} .hbtn{width:26px; height:26px; border-radius:6px}
/* The minimize chevron turns to point the way the room will go. It is a mouse
   action used a few times a session, so the turn is short and ease-out; the room
   itself collapses at once (a height animation would be the expensive kind). */
${R} .hbtn svg{transition:transform 160ms var(--ease-out)}
${R} .hbtn.msa-minimized svg{transform-box:fill-box; transform-origin:center; transform:rotate(-90deg)}
/* THE RENDERER ROW — a sibling of head / body / foot purely so it sits BETWEEN head
   and body; minimizes with the rest of the room (2026-08-27, author). The select
   takes the kit's field skin through its \`msa-select\` class; Foundry's own
   \`select{width:100%; height:2rem}\` is what stretched it across the row. */
${R} .msa-renderer-row{display:flex; align-items:center; gap:8px; padding:6px 14px;
  border-bottom:1px solid var(--line); flex:none}
${R} .msa-renderer-label{display:flex; align-items:center; gap:6px; font-size:.68rem;
  font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink2)}
${R} .msa-renderer-label .ico{color:var(--shine); width:13px; height:13px}
${R} .msa-renderer-select{margin-left:auto}
${R} .msa-select:disabled{opacity:.55; cursor:default}

/* ---- the body ----------------------------------------------------------------- */
${R} .msa-remote-body{flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:12px;
  scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent}
${R} .msa-now-playing{display:flex; align-items:center; gap:8px; padding:6px 10px;
  background:var(--bg2); border:1px solid var(--line); border-radius:999px; font-size:.74rem; color:var(--ink1)}
${R} .msa-now-playing .ico{color:var(--shine); width:16px; height:16px}
${R} .msa-astro-wrap{display:flex; flex-direction:column; gap:6px; align-items:center}

/* THE CLOCK-MODE PILL (2026-08-18) — a 3-way segmented control, the same family as
   weather-board.js's Direct/Drift pill, sized for the dial's ~340px column. */
${R} .msa-clock-mode{display:grid; grid-template-columns:repeat(3, 1fr); gap:2px;
  width:100%; background:var(--bg2); border:1px solid var(--line); border-radius:999px; padding:2px}
${R} .msa-clock-mode .msa-seg{padding:4px 6px; border-radius:999px; border:none; background:none;
  color:var(--ink2); font-size:.64rem; font-weight:600; letter-spacing:.04em}
${R} .msa-clock-mode .msa-seg[aria-pressed="true"]{background:var(--shine-soft); color:var(--shine)}

/* NO padding (2026-08-18) — the mock's own #astro has none: the four corner clusters
   are OF the 340px box, geometrically clear of the ring (see astrolabe-dial.js). */
${R} .msa-astro-dial-host{position:relative; display:grid; place-items:center}
${R} .msa-astro-dial-slot{position:relative; z-index:1}
/* The ring's keyboard focus. The ring is a circle cut with a \`mask\`, and a mask
   clips an element's own outline and shadow — so the ring is drawn on its square
   slot instead, as a round border, and only for keyboard focus. */
${R} .msa-astro-ring:focus-visible{outline:none}
${R} .msa-astro-dial-slot:has(.msa-astro-ring:focus-visible)::after{content:""; position:absolute; inset:-3px;
  border-radius:50%; border:2px solid var(--shine); pointer-events:none; z-index:3}
${R} .msa-astro-ring{position:absolute; inset:0; border-radius:50%;
  background:conic-gradient(from 0deg,
    #ffefc2 0deg,   #f7e3a0 30deg,  #f2c76e 68deg,  #e08a5a 83deg,
    #7a5a7c 105deg, #232a52 128deg, #1b2340 180deg, #232a52 232deg,
    #6a5a8c 262deg, #d99a6a 277deg, #f2c76e 292deg, #f7e3a0 330deg, #ffefc2 360deg);
  -webkit-mask:radial-gradient(closest-side, transparent 60%, #000 61%, #000 99%, transparent 100%);
          mask:radial-gradient(closest-side, transparent 60%, #000 61%, #000 99%, transparent 100%);
  box-shadow:0 0 30px rgba(231,195,104,.12); cursor:grab; touch-action:none}
${R} .msa-astro-ring:active{cursor:grabbing}
${R} .msa-astro-rimart{position:absolute; inset:0; pointer-events:none; overflow:visible; width:340px; height:340px}
${R} .msa-astro-rimart line{stroke:rgba(255,255,255,.3); stroke-width:1}
${R} .msa-astro-rimart line.major{stroke:rgba(255,255,255,.6); stroke-width:1.6}
${R} .msa-astro-rimart text{font-size:8px; font-family:var(--font); font-weight:700;
  letter-spacing:.13em; text-anchor:middle; dominant-baseline:middle;
  fill:rgba(255,255,255,.82); paint-order:stroke;
  stroke:rgba(6,9,20,.55); stroke-width:2.4; stroke-linejoin:round}
/* THE RING TIME-STOPS — each hit line sits exactly over its own visible tick with a
   fat transparent stroke as the real hit target (author: "we already have lines,
   let's make those lines clickable"). */
${R} .msa-astro-timestop-hit{stroke:transparent; stroke-width:11; cursor:pointer; pointer-events:auto;
  transition:stroke 120ms ease}
${R} .msa-astro-handle{filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))}
${R} .msa-astro-handle rect{fill:#fff; stroke:rgba(10,14,28,.65); stroke-width:1.4}
${R} .msa-astro-scene{position:absolute; inset:90px; border-radius:50%; overflow:hidden;
  border:1px solid rgba(255,255,255,.10);
  box-shadow:inset 0 0 18px rgba(0,0,0,.55), 0 0 0 4px var(--bg1)}
${R} .msa-astro-scene svg{width:100%; height:100%; display:block}
${R} .msa-astro-scenetopper{position:absolute; inset:90px; border-radius:50%; overflow:hidden; pointer-events:none}
${R} .msa-astro-clockpill{display:flex; align-items:baseline; gap:6px; margin-top:4px;
  padding:4px 12px; border-radius:999px; background:rgba(10,14,26,.55);
  backdrop-filter:blur(3px); border:1px solid rgba(255,255,255,.14)}
${R} .msa-astro-time{font-size:1.5rem; font-weight:700; letter-spacing:.01em;
  color:#fff; text-shadow:0 1px 3px rgba(0,0,0,.75), 0 0 12px rgba(0,0,0,.6)}
${R} .msa-astro-phase{font-size:.6rem; letter-spacing:.28em;
  color:rgba(255,255,255,.88); text-transform:uppercase; text-shadow:0 1px 3px rgba(0,0,0,.8)}
${R} .msa-astro-pill{display:flex; align-items:center; gap:5px;
  padding:3px 9px; border-radius:999px; background:rgba(10,14,26,.55);
  backdrop-filter:blur(3px); border:1px solid rgba(255,255,255,.14);
  color:rgba(255,255,255,.92); font-size:.68rem}

/* THE FOUR CORNERS (2026-08-18). Ported from the mock's own .cornerCluster rules:
   grid-template-areas encodes the L directly — the "." in each string IS the cell
   closest to the ring, and which physical cell that is changes per corner (see
   tools/ui-mock/index.html's own comment for the geometry proof). They anchor to
   .msa-astro-dial-host, which wraps the (also exactly 340x340) dial slot. */
${R} .msa-corner{position:absolute; display:grid; grid-template-columns:repeat(2, 26px);
  grid-template-rows:repeat(2, 26px); gap:4px; z-index:2}
${R} .msa-corner-tl{top:0; left:0; grid-template-areas:"a b" "c ."}
${R} .msa-corner-tr{top:0; right:0; grid-template-areas:"a b" ". c"}
${R} .msa-corner-bl{bottom:0; left:0; grid-template-areas:"a ." "b c"}
${R} .msa-corner-br{bottom:0; right:0; grid-template-areas:". a" "b c"}
/* "> :nth-child(N)", NOT "button:nth-child(N)" — TR's own children are
   buildImpulseButton()'s span.wrap (so the suppression badge can position:absolute
   against it), never bare buttons. */
${R} .msa-corner > :nth-child(1){grid-area:a}
${R} .msa-corner > :nth-child(2){grid-area:b}
${R} .msa-corner > :nth-child(3){grid-area:c}
${R} .msa-corner-btn{position:relative; width:26px; height:26px; display:grid; place-items:center;
  border-radius:8px; color:var(--ink2); background:var(--bg2); border:1px solid var(--line); padding:0;
  box-shadow:0 2px 6px rgba(0,0,0,.35)}
${R} .msa-corner-btn.msa-planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}
${R} .msa-corner-btn[aria-pressed="true"]{border-color:var(--shine-glow); color:var(--shine);
  background:var(--shine-soft)}
${R} .msa-corner .ico{width:13px; height:13px}
/* the TL speed badge — a "×N" TEXT tab, not a fourth icon (mock's own .tab.txt) */
${R} .msa-corner-btn.msa-corner-txt{font-size:.52rem; letter-spacing:.03em; color:var(--ink1); font-weight:600}
/* honest empty slots, not fake buttons — matches the mock's own .tab.ghost: transparent,
   dashed, no shadow, quieter than an assigned control but never disabled. */
${R} .msa-corner-btn.msa-ghost-slot{background:transparent; border-style:dashed;
  border-color:var(--line); color:var(--ink2); box-shadow:none; opacity:.5; font-size:.85rem; font-weight:300}
/* The speed and jump menus are CHILDREN of the corner button that opened them, so a
   press on a menu row is also a press on that button (:active climbs the tree) —
   which would scale the whole menu along with it. The menu row takes the press. */
${R} .msa-corner-btn:has(> .msa-jump-menu:active){transform:none}
/* A menu hangs from the corner of the button it opened from, so it grows out of
   that corner (a popover scales from its trigger; it never starts from nothing). */
${R} .msa-jump-menu{position:absolute; top:100%; left:0; margin-top:4px; display:flex; flex-direction:column;
  background:var(--glass); backdrop-filter:blur(var(--glass-blur)); border:1px solid var(--line-strong);
  border-radius:8px; box-shadow:var(--shadow2, var(--shadow3)); padding:4px; min-width:120px; z-index:10;
  transform-origin:0 0; animation:msaPopIn 160ms var(--ease-out) backwards}
${R} .msa-menu-item{width:100%; height:26px; display:flex; align-items:center; text-align:left; padding:0 8px;
  border-radius:5px; background:none; border:none; box-shadow:none; color:var(--ink0); font-size:.72rem}
${R} .msa-menu-item[aria-pressed="true"]{color:var(--shine)}
${R} .msa-astro-status{min-height:14px; font-size:.68rem; color:var(--ink2); text-align:center}
${R} .msa-remote-sep{height:1px; background:var(--line); margin:2px 0}

/* ---- the weather board -------------------------------------------------------------- */
${R} .msa-wx-host{display:flex; flex-direction:column; gap:12px}
/* THE BLOCK LABELS — one small header per weather-board section (Fade Time /
   Moods-Climates / Channels), ported from the mock's own .blocklabel. */
${R} .msa-wx-blocklabel{font-size:.64rem; letter-spacing:.22em; text-transform:uppercase;
  color:var(--ink2); display:flex; align-items:center; gap:6px; margin-bottom:6px}
${R} .msa-wx-blocklabel .ico{color:var(--shine); width:12px; height:12px; display:flex}
${R} .msa-wx-hint{margin-left:auto; letter-spacing:.02em; text-transform:none; color:var(--ink2); opacity:.8}
/* a hint that is its own full-width line, not the inline trailing caption */
${R} .msa-wx-hint--block{margin-left:0}
${R} .msa-fade-time{display:grid; grid-template-columns:repeat(6, 1fr); gap:4px}
${R} .msa-fade-time .msa-seg{padding:5px 4px; border-radius:7px; border:1px solid var(--line);
  background:var(--bg2); color:var(--ink2); font-size:.68rem}
${R} .msa-fade-time .msa-seg[aria-pressed="true"]{background:color-mix(in oklab, var(--shine) 16%, transparent);
  border-color:var(--shine); color:var(--shine)}
/* Browse + the Direct/Drift pill share the Moods blocklabel's own row (mock: #wxTitle +
   #wxBrowseBtn + .modeseg on one line). */
${R} .msa-wx-header-right{display:flex; align-items:center; gap:8px; margin-left:auto}
${R} .msa-wx-browse{display:inline-flex; align-items:center; gap:5px; padding:3px 9px;
  border-radius:999px; border:1px solid var(--line); background:var(--bg2); color:var(--ink2);
  font-size:.62rem; font-weight:600; letter-spacing:.04em}
${R} .msa-wx-browse svg{width:11px; height:11px}
${R} .msa-wx-browse-count{padding:0 6px; border-radius:999px; background:var(--bg3); color:var(--ink1);
  font-size:.6rem}
${R} .msa-wx-modeseg{display:inline-flex; background:var(--bg2);
  border:1px solid var(--line); border-radius:999px; padding:2px; gap:2px}
${R} .msa-wx-modeseg .msa-seg{padding:2px 10px; border-radius:999px; border:none; background:none;
  color:var(--ink2); font-size:.62rem; font-weight:600; letter-spacing:.1em; text-transform:uppercase}
${R} .msa-wx-modeseg .msa-seg[aria-pressed="true"]{background:var(--shine-soft); color:var(--shine)}
/* A real grid, not a wrapping flex row (2026-08-18): the old row left the LAST row of
   an odd count dangling half-empty. 4 columns matches the mock's own favourites layout. */
${R} .msa-wx-chips{display:grid; grid-template-columns:repeat(4, 1fr); gap:5px}
${wxChipCss(R)}
${R} .msa-wx-chip{padding:5px 6px; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
/* The Almanac forecast text (2026-08-18) -- a read-only caption; one line, with the
   full text as a tooltip only when it was actually cut off. */
${R} .msa-wx-forecast-text{font-size:.66rem; color:var(--ink2); padding:2px 0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
${R} .msa-wx-faders{display:flex; flex-direction:column; gap:6px}
/* The Channels rack (#626): two captioned groups ("Moods"/"Climate" | "By hand") split
   by a hairline; the faders flex so all seven share the room's width. The fader's own
   look (slot / fill / cap / ticks) lives with the widget (vertical-fader.js). */
${R} .msa-wx-fader-rack{display:flex; flex-direction:row; align-items:stretch; padding:2px 0}
${R} .msa-wx-fader-group{display:flex; flex-direction:column; min-width:0}
${R} .msa-wx-fader-caption{font-size:.56rem; letter-spacing:.18em; text-transform:uppercase;
  color:var(--ink2); text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  padding-bottom:3px; margin:0 2px 6px; border-bottom:1px solid var(--line)}
${R} .msa-wx-fader-row{display:flex; flex-direction:row; gap:4px; justify-content:center}
${R} .msa-wx-fader-divider{flex:0 0 1px; align-self:stretch; background:var(--line); margin:0 3px}
${R} .msa-wx-pin{flex:0 0 auto; padding:0 4px; font-size:.68rem; line-height:1;
  border:none; background:transparent; color:var(--shine)}
/* the GM's own carried-light picker, under the board's sliders */
${R} .msa-pl-carried{margin-top:.6rem}

/* ---- the cue deck --------------------------------------------------------------------- */
${R} .msa-cue-deck{display:flex; flex-direction:column; gap:6px}
${R} .msa-cue-label{font-size:.64rem; letter-spacing:.22em; text-transform:uppercase;
  color:var(--ink2); display:flex; align-items:center; gap:6px}
${R} .msa-cue-label .ico{color:var(--shine)}
${R} .msa-cue-listbtn{margin-left:auto; letter-spacing:.02em; text-transform:none;
  color:var(--ink2); background:none; border:none; font-size:.64rem; opacity:.8}
${R} .msa-cue-row{display:flex; gap:8px; align-items:stretch}
${R} .msa-cue-card{flex:1; background:var(--bg2); border:1px solid var(--line);
  border-radius:var(--r-card); padding:7px 10px; display:flex; flex-direction:column; gap:2px; min-width:0}
${R} .msa-cue-line{display:flex; align-items:baseline; gap:6px; min-width:0}
${R} .msa-cue-k{font-size:.6rem; letter-spacing:.16em; color:var(--ink2); text-transform:uppercase; flex:none}
${R} .msa-cue-name{font-weight:650; font-size:.8rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
${R} .msa-cue-meta{display:flex; gap:8px; align-items:center; color:var(--ink2); font-size:.68rem}
${R} .msa-cue-meta .ico{color:var(--c-atmos)}
/* GO (author, 2026-08-18: "throw away the current go button concept and just make
   something nicer. No animation... it's distracting"): the SAME flat, solid-fill
   language every other pill/card here uses — one tint, one border, no perpetual
   motion. It takes the same press response as everything else (scale, not the old
   1px nudge) so the one button used mid-scene feels like the rest. */
${R} .msa-cue-go{width:80px; border-radius:var(--r-card); border:1px solid var(--shine);
  background:color-mix(in oklab, var(--shine) 20%, var(--bg2));
  color:var(--shine); font-weight:800; letter-spacing:.14em; font-size:.92rem;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px}
${R} .msa-cue-go .ico{width:1.05em; height:1.05em; fill:currentColor; stroke:none}
${R} .msa-cue-go:disabled{opacity:.32; background:var(--bg2); border-color:var(--line); color:var(--ink2); cursor:default}
${R} .msa-cue-status{min-height:14px; font-size:.68rem; color:var(--fail); text-align:center}
${R} .msa-cue-list{display:none; flex-direction:column; gap:3px; border:1px solid var(--line);
  border-radius:var(--r-card); padding:6px; background:var(--bg1); max-height:150px; overflow-y:auto;
  scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent}
${R} .msa-cue-list.open{display:flex; animation:msaFadeUp 160ms var(--ease-out) backwards}
${R} .msa-cue-listrow{display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:7px;
  color:var(--ink1); font-size:.74rem; text-align:left; background:none; border:none; width:100%}
${R} .msa-cue-listrow.done{opacity:.45; text-decoration:line-through}
${R} .msa-cue-listrow.next{color:var(--shine)}
${R} .msa-cue-dur{margin-left:auto; color:var(--ink2); font-size:.66rem}

/* ---- the debug strip -------------------------------------------------------------------- */
/* THE DEBUG ROW (2026-08-18) — ported from the mock's own #debugStrip, "equipment, not
   product chrome" (dashed border, monospace, --c-system accent). It became an ACCORDION
   2026-08-27 (author live-testing: "prepare this section so it can open up... a library of
   debug buttons eventually"): a column wrapping the always-visible primary row (probe +
   perf sweep), the stats row, and a collapsible body for the occasional tools. */
${R} .msa-debug-strip{border:1px dashed color-mix(in oklab, var(--c-system) 45%, transparent);
  border-radius:10px; padding:5px 11px; display:flex; flex-direction:column; gap:6px;
  font-family:var(--mono); font-size:.65rem; color:var(--ink2)}
${R} .msa-debug-primary{display:flex; align-items:center; gap:11px; flex-wrap:wrap; row-gap:4px}
${R} .msa-debug-tag{color:var(--c-system); letter-spacing:.18em; font-weight:700;
  display:flex; gap:5px; align-items:center}
${R} .msa-debug-tag .ico{width:12px; height:12px}
${R} .msa-debug-stat b{color:var(--ink0); font-weight:600}
/* The probe and perf-sweep buttons come from the registered-action machinery
   (MapShine.debug.buildActionButton), whose mouseenter/mouseleave handlers keep writing an
   INLINE background — which would outrank this sheet from the first hover on. The two
   \`!important\`s below (the base and the lit fill) are the contained answer to that one inline
   style, rather than forking the widget the Studio's Lab department shares. */
${R} .msa-debug-btn{padding:2px 9px; border:1px solid var(--line); border-radius:6px;
  color:var(--ink1); background:none !important; font-family:var(--mono); font-size:.62rem}
${R} .msa-debug-btn.msa-planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}
${R} .msa-debug-btn[aria-pressed="true"]{border-color:var(--c-system);
  color:var(--ink0); background:color-mix(in oklab, var(--c-system) 16%, transparent) !important}
/* Host for the perf HUD's own embeddable element inside the accordion body. */
${R} .msa-debug-hud-host{width:100%}
/* The accordion's own chevron, pushed to the row's far end; it turns the way the header's
   minimize chevron does. 20×20: Foundry's \`min-height:2em\` had made it 20×28. */
${R} .msa-debug-more{margin-left:auto; width:20px; height:20px; display:grid; place-items:center;
  padding:0; border-radius:5px; color:var(--ink2); background:none; border:none}
${R} .msa-debug-more .ico{width:14px; height:14px}
${R} .msa-debug-more svg{transform-box:fill-box; transform-origin:center; transition:transform 160ms var(--ease-out)}
${R} .msa-debug-more[aria-expanded="true"] svg{transform:rotate(90deg)}
${R} .msa-debug-more-body{display:flex; flex-direction:column; gap:6px; padding-top:6px;
  border-top:1px solid color-mix(in oklab, var(--c-system) 30%, transparent);
  animation:msaFadeUp 160ms var(--ease-out) backwards}
${R} .msa-debug-stats-row, ${R} .msa-debug-more-btns{display:flex; align-items:center;
  gap:11px; flex-wrap:wrap; row-gap:4px}
${R} .msa-debug-spark{display:flex; align-items:flex-end; gap:1px; height:15px; width:52px; flex:none}
/* Each bar's colour is set inline by debug-strip.js's own fpsBlendColor (the author's
   explicit fps-threshold spec: a continuous blend has no fixed set of classes). */
${R} .msa-debug-spark i{flex:1; min-width:1px; height:20%; border-radius:1px 1px 0 0;
  background:var(--ok); transition:height 250ms ease, background-color 250ms ease}

/* ---- the footer -------------------------------------------------------------------------- */
/* Every footer item is a fixed 30px box with flex-centred content (author, two rounds:
   "the buttons at the bottom of the UI have different heights"): the glyphs are a genuine
   emoji mix whose fallback fonts differ in ascent, so a fixed height sidesteps glyph
   metrics for good. */
${R} .msa-remote-foot{display:flex; gap:8px; flex-wrap:wrap; padding:10px 14px; border-top:1px solid var(--line); flex:none}
${R} .msa-foot-btn{flex:1 1 auto; min-width:0; display:flex; align-items:center; justify-content:center;
  height:30px; padding:0 8px; border-radius:8px; border:1px solid var(--line); background:var(--bg2);
  color:var(--ink1); font-size:.68rem; font-weight:600; line-height:1; text-decoration:none;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
${R} .msa-foot-btn.msa-planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}
/* The Safety button while armed (the same two-click confirm every room uses). */
${R} .msa-foot-btn.is-armed{border-color:var(--fail); color:var(--fail);
  background:color-mix(in oklab, var(--fail) 16%, var(--bg2))}
${R} #msa-remote-patreon{background:linear-gradient(135deg, #ff8a5b, #ff6b74); color:#fff; border:none;
  transition:transform 160ms var(--ease-out), filter 120ms ease}

/* ---- the popovers (camera path, wind) --------------------------------------------------------
   Plain windows beside the room, built from classes now: they were inline styles, which
   cannot answer a hover or a press. They open scaled out of their own corner. */
${CP}, ${WP}{position:fixed; z-index:400; background:var(--glass); backdrop-filter:blur(var(--glass-blur));
  border:1px solid var(--line-strong); border-radius:var(--r-room, 14px); box-shadow:var(--shadow3);
  padding:10px; font:11px/1.4 var(--font); color:var(--ink0); transform-origin:100% 0;
  scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent}
${CP}{top:80px; right:20px; width:340px; max-height:80vh; overflow-y:auto}
${WP}{top:80px; right:20px; width:220px}
${CP}.msa-pop-enter, ${WP}.msa-pop-enter{animation:msaPopIn 160ms var(--ease-out) backwards}
/* A popover is shown and hidden by the \`hidden\` attribute, but the camera path's Play also
   sets an inline \`display\` to get it out of the shot — which outranks the browser's own
   \`[hidden]\`. Foundry's stylesheet happens to carry an \`!important\` one; do not depend on it. */
${R}[hidden], ${CP}[hidden], ${WP}[hidden]{display:none !important}
${IN} .msa-pop-head{display:flex; align-items:center; gap:8px; margin-bottom:8px}
${IN} .msa-pop-head .hbtn{margin-left:auto}
${IN} .msa-pop-row input.msa-switch-input{margin-left:auto}
${IN} .msa-pop-title{font-weight:700; font-size:.8rem; display:flex; gap:6px; align-items:center}
${IN} .msa-pop-row{display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap}
${IN} .msa-pop-label{font-size:.68rem; color:var(--ink2)}
${IN} .msa-pop-row .msa-select{flex:1 1 140px; min-width:0}
${IN} .msa-pop-kf{border:1px solid var(--line); border-radius:8px; padding:6px 8px; margin-bottom:6px; background:var(--bg2)}
${IN} .msa-pop-kf-title{font-size:.72rem; color:var(--ink0)}
${IN} .msa-pop-settings{margin-top:8px; border-top:1px solid var(--line); padding-top:8px}
${IN} .msa-pop-status{margin-top:6px; color:var(--ink2); font-size:.68rem}
${IN} .msa-pop-foot{display:flex; gap:6px; margin-top:8px; border-top:1px solid var(--line); padding-top:8px}
${IN} .msa-input--num{width:64px; flex:none; text-align:right}

/* ---- hover: only where hover exists ----------------------------------------------------------
   Every hover rule in the sheet is in this one block, so a tap on a touch screen never
   leaves a stuck hover state. A lit (aria-pressed) toggle keeps its look under the pointer:
   the plain hover rules exclude it, and it gets its own, slightly stronger, one. */
${HOVER_GATE}{
${uiKitHoverCss(IN)}
${wxChipHoverCss(R)}
  ${R} .msa-clock-mode .msa-seg:not([aria-pressed="true"]):hover,
  ${R} .msa-wx-modeseg .msa-seg:not([aria-pressed="true"]):hover{color:var(--ink0)}
  ${R} .msa-fade-time .msa-seg:not([aria-pressed="true"]):hover{background:var(--bg3); color:var(--ink0)}
  ${R} .msa-fade-time .msa-seg[aria-pressed="true"]:hover{background:color-mix(in oklab, var(--shine) 24%, transparent)}
  ${R} .msa-clock-mode .msa-seg[aria-pressed="true"]:hover,
  ${R} .msa-wx-modeseg .msa-seg[aria-pressed="true"]:hover{background:color-mix(in oklab, var(--shine) 26%, transparent)}
  ${R} .msa-astro-timestop-hit:hover{stroke:color-mix(in oklab, var(--shine) 22%, transparent)}
  ${R} .msa-astro-pill:hover{background:rgba(10,14,26,.75)}
  ${R} .msa-corner-btn:not([aria-pressed="true"]):not(.msa-ghost-slot):hover{border-color:var(--line-strong); color:var(--ink0)}
  ${R} .msa-corner-btn[aria-pressed="true"]:hover{background:color-mix(in oklab, var(--shine) 24%, transparent)}
  ${R} .msa-corner-btn.msa-planned:hover{border-color:var(--fail); color:var(--fail)}
  ${R} .msa-corner-btn.msa-ghost-slot:hover{opacity:.85; border-color:var(--line-strong)}
  ${R} .msa-menu-item:hover{background:var(--bg3)}
  ${R} .msa-wx-browse:hover{background:var(--bg3); color:var(--ink0); border-color:var(--shine-glow)}
  ${R} .msa-wx-pin:hover{opacity:.75}
  ${R} .msa-cue-listbtn:hover{opacity:1; color:var(--ink0)}
  ${R} .msa-cue-go:not(:disabled):hover{background:color-mix(in oklab, var(--shine) 30%, var(--bg2))}
  ${R} .msa-cue-listrow:hover{background:var(--bg2); color:var(--ink0)}
  ${R} .msa-debug-btn:not([aria-pressed="true"]):not(.msa-planned):hover{border-color:var(--c-system); color:var(--ink0)}
  ${R} .msa-debug-more:hover{background:var(--bg3); color:var(--ink0)}
  ${R} .msa-foot-btn:not(.is-armed):not(#msa-remote-patreon):hover{background:var(--bg3)}
  ${R} .msa-foot-btn.is-armed:hover{background:color-mix(in oklab, var(--fail) 24%, var(--bg2))}
  ${R} #msa-remote-patreon:hover{filter:brightness(1.08)}
}
`.trim();
}

/**
 * The tile-motion panel's stylesheet — its own, because the panel installs
 * independently (the Studio's Scene department and the astrolabe's BR corner both
 * open it) and may exist without the Remote. Same kit, same model.
 * @returns {string}
 */
export function tileMotionCss() {
  const TM = `#${TILE_MOTION_ID}`;
  const IN = `:is(${TM})`;
  return `
${MOTION_KEYFRAMES}

${TM}{position:fixed; top:80px; right:440px; width:320px; max-height:80vh;
  background:var(--glass); backdrop-filter:blur(var(--glass-blur)); border:1px solid var(--line);
  border-radius:var(--r-room); box-shadow:var(--shadow3); display:flex; flex-direction:column;
  overflow:hidden; z-index:400; font:11px/1.4 var(--font); color:var(--ink0); transform-origin:50% 0}
${TM}.msa-enter{animation:msaRoomIn 200ms var(--ease-out) both}
/* An author \`display\` outranks the browser's own \`[hidden]\`; Foundry's sheet carries an \`!important\`
   one, but a panel should not depend on that. */
${TM}[hidden]{display:none !important}
${TM}[data-minimized="true"] .msa-tm-body{display:none}

${uiKitCss(IN, { pressInside: ['.msa-tm-thumb'] })}

${TM} .msa-tm-head{display:flex; align-items:center; gap:8px; padding:8px 12px;
  border-bottom:1px solid var(--line); flex:none; cursor:grab; user-select:none}
${TM} .msa-tm-head:active{cursor:grabbing}
${TM} .msa-tm-title{font-weight:700; font-size:.8rem; display:flex; gap:6px; align-items:center; color:var(--ink0)}
${TM} .msa-tm-title .ico{color:var(--shine)}
${TM} .msa-tm-spacer{flex:1}
/* the header buttons are 22px here (the kit's own is 24) */
${TM} .hbtn{width:22px; height:22px; border-radius:5px}
${TM} .hbtn svg{transition:transform 160ms var(--ease-out)}
${TM} .hbtn.msa-minimized svg{transform-box:fill-box; transform-origin:center; transform:rotate(-90deg)}
${TM} .msa-tm-body{overflow-y:auto; padding:10px 12px; scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent}
${TM} .msa-tm-row{display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap; pointer-events:auto}
${TM} .msa-tm-row label{font-size:.68rem; color:var(--ink2)}
/* Foundry sets h4 in its serif display face; pinned back to the room's own. */
${TM} h4{margin:10px 0 6px; padding:8px 0 0; border:0; border-top:1px solid var(--line); font:600 .68rem/1.3 var(--font);
  color:var(--ink2); text-transform:uppercase; letter-spacing:.05em; text-shadow:none}
${TM} .msa-select{max-width:200px}
${TM} .msa-tm-status{font-size:.68rem; color:var(--ink2); margin:4px 0}
${TM} .msa-tm-thumbs{display:grid; grid-template-columns:repeat(auto-fill, 56px); gap:6px;
  max-height:220px; overflow-y:auto; padding:2px 2px 8px; margin-bottom:4px;
  scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent}
${TM} .msa-tm-thumb{width:56px; height:56px; border-radius:6px; border:1px solid var(--line);
  background:var(--bg2); color:var(--ink1); padding:0; display:grid; place-items:center; overflow:hidden}
${TM} .msa-tm-thumb canvas{display:block}
${TM} .msa-tm-thumb[aria-current="true"]{border-color:var(--shine); box-shadow:0 0 0 1px var(--shine)}

${HOVER_GATE}{
${uiKitHoverCss(IN)}
  ${TM} .msa-tm-thumb:hover{border-color:var(--shine-glow)}
}
`.trim();
}
