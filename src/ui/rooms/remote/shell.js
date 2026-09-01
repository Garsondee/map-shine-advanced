/**
 * ui/rooms/remote/shell.js — the Remote's own room chrome (U2, docs/holy/
 * UI-Testament.md §4, §9). Ported from the mock's `#remote` shell —
 * provenance for every element below is the mock-mapping research filed in
 * Petition P11, not re-derived here. `#mockStrip` (the Remote/Studio/Player
 * tab switcher, theme picker) is explicitly scaffolding the mock's OWN CSS
 * comment disowns ("nobody mistakes surface-switching... for product UI")
 * and is correctly NOT ported — Foundry's scene-controls toggle is this
 * room's real open/close door, same as Studio's.
 *
 * ⚠️ SAFETY STILL SHIPS `status:'planned'` (Baseline is real as of U2
 * checkpoint 3 — see below). `diag/render-fallback.js#engageFoundryFallback`
 * is a real, ONE-WAY action within a session (no `clearFoundryFallback`
 * counterpart resurrects a torn-down canvas — a reload is the only way
 * back) — exactly the kind of hard-to-reverse action this project's own
 * safety posture says to wire carefully and deliberately, not alongside
 * everything else in a single pass. Marked, not silently faked or silently
 * skipped. See Petitions P11/P13.
 *
 * @module ui/rooms/remote/shell
 */

import { installTokens } from '../../tokens.js';
import { installIconSprite, iconMarkup } from '../../widgets/icon-sprite.js';
import { makeDraggable } from '../../widgets/draggable.js';
import { installScaleControl } from '../../widgets/scale-control.js';
import { installCameraPathPopover } from './camera-path-popover.js';
import { installWindPopover } from './wind-popover.js';
import { renderAstrolabePanel } from './astrolabe-panel.js';
import { renderWeatherBoard } from './weather-board.js';
import { renderCueDeck } from './cue-deck.js';
import { renderDebugStrip } from './debug-strip.js';

const ROOM_ID = 'msa-remote';
const STYLE_ID = 'msa-remote-style';

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
#${ROOM_ID}{position:fixed; top:44px; right:24px; width:400px; max-width:calc(100vw - 48px);
  z-index:100; font:12px/1.4 var(--font); color:var(--ink0)}
/* THE CARD (2026-08-27 round 2, author: "the +/- UI is overlapping other
   parts of the ui... moved to the left till it sits on the outside of the
   panel") -- everything the room used to put directly on its own root
   (background/border/radius/shadow, the overflow:hidden that clips head/
   body/foot's own square inner corners to the room's rounded outer ones)
   moves to this inner wrapper instead. The room's own root keeps ONLY
   position/size/z-index -- an unclipped box a child can escape to the left
   of, which #${ROOM_ID} .msa-scale-strip (below, appended as room's own
   second child, a sibling of this card) now does. */
#${ROOM_ID} .msa-remote-card{width:100%; max-height:calc(100vh - 60px); background:var(--glass);
  backdrop-filter:blur(var(--glass-blur)); border:1px solid var(--line); border-radius:var(--r-room);
  box-shadow:var(--shadow3); display:flex; flex-direction:column; overflow:hidden}
#${ROOM_ID}[data-minimized="true"] .msa-remote-body,
#${ROOM_ID}[data-minimized="true"] .msa-remote-foot,
#${ROOM_ID}[data-minimized="true"] .msa-renderer-row{display:none}
#${ROOM_ID} .msa-remote-head{display:flex; align-items:center; gap:var(--sp2); padding:8px 14px;
  border-bottom:1px solid var(--line); flex:none; cursor:grab; user-select:none}
#${ROOM_ID} .msa-remote-head:active{cursor:grabbing}
#${ROOM_ID} .msa-remote-title{font-weight:600; letter-spacing:.1em; font-size:.72rem; text-transform:uppercase;
  color:var(--ink1); display:flex; gap:8px; align-items:center}
#${ROOM_ID} .msa-remote-title .ico{color:var(--shine)}
#${ROOM_ID} .msa-spacer{flex:1}
#${ROOM_ID} .hbtn{width:26px; height:26px; display:grid; place-items:center; border-radius:6px;
  color:var(--ink2); background:none; border:none; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .hbtn:hover{background:var(--bg3); color:var(--ink0)}
#${ROOM_ID} .hbtn.msa-planned{border:1px dashed var(--fail); color:var(--fail)}
#${ROOM_ID} .hbtn.msa-minimized svg{transform-box:fill-box; transform-origin:center; transform:rotate(-90deg)}
/* THE RENDERER ROW (UI parity plan, phase 4b round 2) -- sibling to head/
   body/foot, not inside .msa-remote-body, purely so it can sit BETWEEN head
   and body in DOM/paint order. Minimizes with the rest of the room (2026-08-27
   fix, author: "when I minimise I can still see the dropdown for renderer,
   but this too should become minimised") -- the round-2 "always reachable
   safety lever" reasoning is superseded by that direct correction; the
   selector above now covers it exactly like .msa-remote-body/.msa-remote-foot. */
#${ROOM_ID} .msa-renderer-row{display:flex; align-items:center; gap:8px; padding:6px 14px;
  border-bottom:1px solid var(--line); flex:none}
#${ROOM_ID} .msa-renderer-label{display:flex; align-items:center; gap:6px; font-size:.68rem;
  font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink2)}
#${ROOM_ID} .msa-renderer-label .ico{color:var(--shine); width:13px; height:13px}
#${ROOM_ID} .msa-renderer-select{margin-left:auto; background:var(--bg2); color:var(--ink0);
  border:1px solid var(--line); border-radius:6px; padding:3px 7px; font:inherit; font-size:.72rem;
  cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-remote-body{flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:12px}
#${ROOM_ID} .msa-now-playing{display:flex; align-items:center; gap:8px; padding:6px 10px;
  background:var(--bg2); border:1px solid var(--line); border-radius:999px; font-size:.74rem; color:var(--ink1)}
#${ROOM_ID} .msa-now-playing .ico{color:var(--shine); width:16px; height:16px}
#${ROOM_ID} .msa-astro-wrap{display:flex; flex-direction:column; gap:6px; align-items:center}
/* THE CLOCK-MODE PILL (2026-08-18 fix) — a real gap-audit finding: the old
   astrolabe.js has a live Aesthetic/Follow/Almanac <select> the new Remote
   never ported at all. Full-width 3-way segmented control, same visual
   family as weather-board.js's own Direct/Drift pill but sized for the
   dial's own ~340px column rather than sharing a label row. */
#${ROOM_ID} .msa-clock-mode{display:grid; grid-template-columns:repeat(3, 1fr); gap:2px;
  width:100%; background:var(--bg2); border:1px solid var(--line); border-radius:999px; padding:2px}
#${ROOM_ID} .msa-clock-mode button{padding:4px 6px; border-radius:999px; border:none; background:none;
  color:var(--ink2); font-size:.64rem; font-weight:600; letter-spacing:.04em; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-clock-mode button:hover{color:var(--ink0)}
#${ROOM_ID} .msa-clock-mode button[aria-pressed="true"]{background:var(--shine-soft); color:var(--shine)}
/* NO padding (2026-08-18 fix) — the mock's own #astro has none: the four
   corner clusters are OF the 340px box, geometrically confirmed clear of
   the ring itself (see astrolabe-dial.js's own header), not a margin
   outside it. The old 36px padding pushed all four corners flush against
   the ROOM's own edge instead of tucking them into the dial's own empty
   corners, a second, smaller mismatch from the approved design found
   alongside the dial's own visual rebuild. */
#${ROOM_ID} .msa-astro-dial-host{position:relative; display:grid; place-items:center}
#${ROOM_ID} .msa-astro-dial-slot{position:relative; z-index:1}
/* THE DIAL ITSELF (2026-08-18 fix) — ported from tools/ui-mock/index.html's
   own #astro/.ring/.rimArt/.scene/.sceneText/.sceneTopper rules, verbatim
   where the author already hand-tuned exact colours/shadows/positions.
   See ui/rooms/remote/astrolabe-dial.js's own header for why this exists:
   the U2 re-home used ui/astrolabe.js's OWN pre-LANTERN styling unchanged. */
#${ROOM_ID} .msa-astro-ring{position:absolute; inset:0; border-radius:50%;
  background:conic-gradient(from 0deg,
    #ffefc2 0deg,   #f7e3a0 30deg,  #f2c76e 68deg,  #e08a5a 83deg,
    #7a5a7c 105deg, #232a52 128deg, #1b2340 180deg, #232a52 232deg,
    #6a5a8c 262deg, #d99a6a 277deg, #f2c76e 292deg, #f7e3a0 330deg, #ffefc2 360deg);
  -webkit-mask:radial-gradient(closest-side, transparent 60%, #000 61%, #000 99%, transparent 100%);
          mask:radial-gradient(closest-side, transparent 60%, #000 61%, #000 99%, transparent 100%);
  box-shadow:0 0 30px rgba(231,195,104,.12); cursor:grab; touch-action:none}
#${ROOM_ID} .msa-astro-ring:active{cursor:grabbing}
#${ROOM_ID} .msa-astro-rimart{position:absolute; inset:0; pointer-events:none; overflow:visible; width:340px; height:340px}
#${ROOM_ID} .msa-astro-rimart line{stroke:rgba(255,255,255,.3); stroke-width:1}
#${ROOM_ID} .msa-astro-rimart line.major{stroke:rgba(255,255,255,.6); stroke-width:1.6}
#${ROOM_ID} .msa-astro-rimart text{font-size:8px; font-family:var(--font); font-weight:700;
  letter-spacing:.13em; text-anchor:middle; dominant-baseline:middle;
  fill:rgba(255,255,255,.82); paint-order:stroke;
  stroke:rgba(6,9,20,.55); stroke-width:2.4; stroke-linejoin:round}
/* THE RING TIME-STOPS (UI parity plan, phase 6b round 2) -- author feedback:
   a separate dot overlay clashed with the NOON/MIDNIGHT/DAWN/DUSK labels;
   "we already have lines, let's make those lines clickable" instead. Each
   hit line sits exactly over its own visible tick (astrolabe-dial.js) with
   a fat transparent stroke as the real hit target, pointer-events:auto
   against the SVG's own pointer-events:none default. */
#${ROOM_ID} .msa-astro-timestop-hit{stroke:transparent; stroke-width:11; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-astro-timestop-hit:hover{stroke:color-mix(in oklab, var(--shine) 22%, transparent)}
#${ROOM_ID} .msa-astro-handle{filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))}
#${ROOM_ID} .msa-astro-handle rect{fill:#fff; stroke:rgba(10,14,28,.65); stroke-width:1.4}
#${ROOM_ID} .msa-astro-scene{position:absolute; inset:90px; border-radius:50%; overflow:hidden;
  border:1px solid rgba(255,255,255,.10);
  box-shadow:inset 0 0 18px rgba(0,0,0,.55), 0 0 0 4px var(--bg1)}
#${ROOM_ID} .msa-astro-scene svg{width:100%; height:100%; display:block}
#${ROOM_ID} .msa-astro-scenetopper{position:absolute; inset:90px; border-radius:50%; overflow:hidden; pointer-events:none}
#${ROOM_ID} .msa-astro-clockpill{display:flex; align-items:baseline; gap:6px; margin-top:4px;
  padding:4px 12px; border-radius:999px; background:rgba(10,14,26,.55);
  backdrop-filter:blur(3px); border:1px solid rgba(255,255,255,.14)}
#${ROOM_ID} .msa-astro-time{font-size:1.5rem; font-weight:700; letter-spacing:.01em;
  color:#fff; text-shadow:0 1px 3px rgba(0,0,0,.75), 0 0 12px rgba(0,0,0,.6)}
#${ROOM_ID} .msa-astro-phase{font-size:.6rem; letter-spacing:.28em;
  color:rgba(255,255,255,.88); text-transform:uppercase; text-shadow:0 1px 3px rgba(0,0,0,.8)}
#${ROOM_ID} .msa-astro-pill{display:flex; align-items:center; gap:5px;
  padding:3px 9px; border-radius:999px; background:rgba(10,14,26,.55);
  backdrop-filter:blur(3px); border:1px solid rgba(255,255,255,.14);
  color:rgba(255,255,255,.92); font-size:.68rem; transition:background var(--t-micro);
  cursor:pointer}
#${ROOM_ID} .msa-astro-pill:hover{background:rgba(10,14,26,.75)}
/* THE FOUR CORNERS (2026-08-18 fix, same author report as astrolabe-dial.js's
   own header: "the buttons around the astrolabe are wrongly positioned").
   Ported from the mock's own .cornerCluster rules verbatim, not re-derived —
   the ORIGINAL port here was grid-auto-flow:column, which has no template
   at all and just auto-places each button into a new implicit column: a
   flat 1x3 strip roughly 86px wide, not the mock's compact 56x56 2x2 L-shape
   tucked into the dial's own empty corner triangle. grid-template-areas
   encodes the L directly — the "." in each string IS the cell closest to
   the ring, and which physical cell that is changes per corner (top-right's
   inner column is its LEFT one, not its right) — see tools/ui-mock/
   index.html's own comment on this same rule for the geometry proof
   (49.8px diagonal clearance at 340px/radius170, comfortably past a 3x26px
   L's ~56px reach). #astro in the mock is exactly the 340x340 box these
   corners anchor to directly; here they anchor to .msa-astro-dial-host,
   which wraps the (also exactly 340x340) dial slot with zero extra sizing
   of its own, so the same absolute top:0/left:0 etc. lands in the same
   place. */
#${ROOM_ID} .msa-corner{position:absolute; display:grid; grid-template-columns:repeat(2, 26px);
  grid-template-rows:repeat(2, 26px); gap:4px; z-index:2}
#${ROOM_ID} .msa-corner-tl{top:0; left:0; grid-template-areas:"a b" "c ."}
#${ROOM_ID} .msa-corner-tr{top:0; right:0; grid-template-areas:"a b" ". c"}
#${ROOM_ID} .msa-corner-bl{bottom:0; left:0; grid-template-areas:"a ." "b c"}
#${ROOM_ID} .msa-corner-br{bottom:0; right:0; grid-template-areas:". a" "b c"}
/* "> :nth-child(N)", NOT "button:nth-child(N)" (2026-08-18 fix; author
   report: "top right section of three buttons isn't currently correct") —
   TR's own children are buildImpulseButton()'s span.wrap (needed so the
   suppression badge can position:absolute against it), never bare buttons.
   The old selector required the CHILD ITSELF to be a button element, so it
   silently never matched TR at all — its three items fell through to the
   grid's own auto-placement instead, which fills cells in DOM order
   INCLUDING the area's own "." gap, landing the 3rd item (wind) at
   bottom-LEFT instead of the intended bottom-right. TL/BL/BR never showed
   this bug because every button there is built directly via iconBtn() —
   confirmed live (getComputedStyle(el).gridArea read back "auto" on every
   TR child, not a/b/c), not assumed from the CSS alone. */
#${ROOM_ID} .msa-corner > :nth-child(1){grid-area:a}
#${ROOM_ID} .msa-corner > :nth-child(2){grid-area:b}
#${ROOM_ID} .msa-corner > :nth-child(3){grid-area:c}
#${ROOM_ID} .msa-corner button{position:relative; width:26px; height:26px; display:grid; place-items:center;
  border-radius:8px; color:var(--ink2); background:var(--bg2); border:1px solid var(--line); cursor:pointer;
  pointer-events:auto; box-shadow:0 2px 6px rgba(0,0,0,.35)}
#${ROOM_ID} .msa-corner button:hover{border-color:var(--line-strong); color:var(--ink0)}
#${ROOM_ID} .msa-corner button.msa-planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}
#${ROOM_ID} .msa-corner button[aria-pressed="true"]{border-color:var(--shine-glow); color:var(--shine);
  background:var(--shine-soft)}
#${ROOM_ID} .msa-corner .ico{width:13px; height:13px}
/* the TL speed badge — a "×N" TEXT tab, not a fourth icon (mock's own
   .tab.txt); still a .msa-corner button in every other respect (size,
   grid-area placement, hover/pressed states) so it needs no separate rule
   for those. */
#${ROOM_ID} .msa-corner button.msa-corner-txt{font-size:.52rem; letter-spacing:.03em; color:var(--ink1);
  font-weight:600}
/* honest empty slots, not fake buttons — matches the mock's own .tab.ghost:
   transparent, dashed, no shadow, quieter than an assigned control but
   never disabled. */
#${ROOM_ID} .msa-corner button.msa-ghost-slot{background:transparent; border-style:dashed;
  border-color:var(--line); color:var(--ink2); box-shadow:none; opacity:.5; font-size:.85rem; font-weight:300}
#${ROOM_ID} .msa-corner button.msa-ghost-slot:hover{opacity:.85; border-color:var(--line-strong)}
#${ROOM_ID} .msa-jump-menu{position:absolute; top:100%; left:0; margin-top:4px; display:flex; flex-direction:column;
  background:var(--glass); backdrop-filter:blur(var(--glass-blur)); border:1px solid var(--line-strong);
  border-radius:8px; box-shadow:var(--shadow2, var(--shadow3)); padding:4px; min-width:120px; z-index:10}
#${ROOM_ID} .msa-jump-menu button{width:100%; text-align:left; padding:5px 8px; border-radius:5px;
  background:none; border:none; color:var(--ink0); cursor:pointer; font-size:.72rem}
#${ROOM_ID} .msa-jump-menu button:hover{background:var(--bg3)}
#${ROOM_ID} .msa-astro-status{min-height:14px; font-size:.68rem; color:var(--ink2); text-align:center}
#${ROOM_ID} .msa-remote-sep{height:1px; background:var(--line); margin:2px 0}
#${ROOM_ID} .msa-wx-host{display:flex; flex-direction:column; gap:12px}
/* THE BLOCK LABELS (2026-08-18 fix; author report: "Fade time isn't added
   yet" / "lots of UI elements aren't in place yet") — ported from the
   mock's own .blocklabel, one small header per weather-board section
   (Fade Time / Moods-Climates / Channels), matching its exact DOM order:
   Fade Time first, THEN Moods, THEN Channels (production had Moods first —
   a real ordering miss, not just missing labels). */
#${ROOM_ID} .msa-wx-blocklabel{font-size:.64rem; letter-spacing:.22em; text-transform:uppercase;
  color:var(--ink2); display:flex; align-items:center; gap:6px; margin-bottom:6px}
#${ROOM_ID} .msa-wx-blocklabel .ico{color:var(--shine); width:12px; height:12px; display:flex}
#${ROOM_ID} .msa-wx-hint{margin-left:auto; letter-spacing:.02em; text-transform:none; color:var(--ink2); opacity:.8}
#${ROOM_ID} .msa-fade-time{display:grid; grid-template-columns:repeat(6, 1fr); gap:4px}
#${ROOM_ID} .msa-fade-time button{padding:5px 4px; border-radius:7px; border:1px solid var(--line);
  background:var(--bg2); color:var(--ink2); font-size:.68rem; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-fade-time button:hover{background:var(--bg3); color:var(--ink0)}
#${ROOM_ID} .msa-fade-time button[aria-pressed="true"]{background:color-mix(in oklab, var(--shine) 16%, transparent);
  border-color:var(--shine); color:var(--shine)}
/* Now INLINE in the Moods/Climates blocklabel row (mock: #wxTitle +
   #wxBrowseBtn + .modeseg share one line), not its own full-width row above
   the chips — a compact pill, not two equal-width buttons filling the room.
   msa-wx-header-right (2026-08-18 fix — author: "Climate buttons need to
   be better organised. We need the extra opening room of climate choices.")
   is the flex group blockLabel's own single trailing-slot now holds
   Browse + the mode pill together; the auto-margin that used to sit
   directly on msa-wx-modeseg moved up to this wrapper. */
#${ROOM_ID} .msa-wx-header-right{display:flex; align-items:center; gap:8px; margin-left:auto}
#${ROOM_ID} .msa-wx-browse{display:inline-flex; align-items:center; gap:5px; padding:3px 9px;
  border-radius:999px; border:1px solid var(--line); background:var(--bg2); color:var(--ink2);
  font-size:.62rem; font-weight:600; letter-spacing:.04em; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-wx-browse svg{width:11px; height:11px}
#${ROOM_ID} .msa-wx-browse:hover{background:var(--bg3); color:var(--ink0); border-color:var(--shine-glow)}
#${ROOM_ID} .msa-wx-browse-count{padding:0 6px; border-radius:999px; background:var(--bg3); color:var(--ink1);
  font-size:.6rem}
#${ROOM_ID} .msa-wx-modeseg{display:inline-flex; background:var(--bg2);
  border:1px solid var(--line); border-radius:999px; padding:2px; gap:2px}
#${ROOM_ID} .msa-wx-modeseg button{padding:2px 10px; border-radius:999px; border:none; background:none;
  color:var(--ink2); font-size:.62rem; font-weight:600; letter-spacing:.1em; text-transform:uppercase;
  cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-wx-modeseg button[aria-pressed="true"]{background:var(--shine-soft); color:var(--shine)}
/* A real grid, not a wrapping flex row (2026-08-18 fix, same author report
   as the header-right change above — the old flex-wrap row left the LAST
   row of an odd count dangling half-empty, reading as unorganised). 4
   columns matches the mock's own favourites layout; the favourites subset
   (weather-board.js's FAVOURITE_ARCHETYPE_IDS/FAVOURITE_BIOME_IDS, 8/6
   items) fills it evenly rather than wrapping raggedly the way all 16/10
   used to. */
#${ROOM_ID} .msa-wx-chips{display:grid; grid-template-columns:repeat(4, 1fr); gap:5px}
#${ROOM_ID} .msa-wx-chip{padding:5px 6px; border-radius:999px; border:1px solid var(--line); background:var(--bg2);
  color:var(--ink1); font-size:.68rem; cursor:pointer; pointer-events:auto; text-align:center;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
#${ROOM_ID} .msa-wx-chip:hover{background:var(--bg3)}
#${ROOM_ID} .msa-wx-chip[aria-pressed="true"]{background:color-mix(in oklab, var(--shine) 18%, transparent);
  border-color:var(--shine); color:var(--shine)}
/* The fade TARGET, distinct from "this IS the sky" above (2026-08-18 fix —
   author: "mood buttons don't work yet"; root cause was the whole row going
   dark for the entire fade with no sign a click landed). Static — no
   animation, matching the author's own separate "no animation, it's
   distracting" note applied here too, not just at the GO button. */
#${ROOM_ID} .msa-wx-chip[data-pending="true"]{background:color-mix(in oklab, var(--shine) 8%, transparent);
  border-color:var(--shine); border-style:dashed; color:var(--ink0)}
/* The Almanac forecast text (2026-08-18 fix) -- a read-only caption, same
   typography weight as .msa-wx-bracket just below it. Its own "surprise me"
   toggle sits right under it as a normal buildParamControl bool row (see
   weather-board.js), not styled here -- that widget owns its own look. */
#${ROOM_ID} .msa-wx-forecast-text{font-size:.66rem; color:var(--ink2); padding:2px 0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
#${ROOM_ID} .msa-wx-faders{display:flex; flex-direction:column; gap:6px}
/* The Channels rack (2026-08-19 fix -- author: "Ideally the vertical
   sliders would appear soon"). A horizontal row of ui/widgets/vertical-
   fader.js's own faders, replacing buildParamControl's stacked horizontal
   rows for LIVE_CHANNELS/ENV_CHANNELS specifically -- Scene-override stays
   a normal row below the rack (a bool control, not a slider). Wraps as a
   defensive safety net, not because 5 faders at their own width need it at
   any real containment size (measured: well under the Remote's own budget). */
#${ROOM_ID} .msa-wx-fader-rack{display:flex; flex-direction:row; flex-wrap:wrap;
  gap:8px; justify-content:center; padding:2px 0}
/* The track pseudo-elements ui/widgets/vertical-fader.js itself can't reach
   (inline styles don't address pseudo-elements) -- accent-color alone only
   paints the filled portion + thumb, leaving the unfilled groove at the
   browser default, which reads as a near-invisible hairline on a dark theme
   (author screenshot, 2026-08-19: thumbs read fine, the channel they sit in
   didn't). --line-strong rather than a new rgba: it's already themed
   across all 4 LANTERN modes -- including the high-contrast one, where it
   jumps to .6 alpha -- and already covered by the U0 contrast-gate test, so
   this groove inherits that guarantee instead of inventing an unchecked value. */
#${ROOM_ID} .msa-vfader-input::-webkit-slider-runnable-track{background:var(--line-strong); border-radius:3px}
#${ROOM_ID} .msa-vfader-input::-moz-range-track{background:var(--line-strong); border-radius:3px}
/* THE THUMB (2026-08-27 fix, author report: "the handles on the vertical
   sliders are ugly and offset to the right of where they should be"). No
   thumb rule existed at all -- WebKit/Gecko fall back to each browser's own
   UA-default thumb geometry (sized for a normal ~horizontal slider), which
   does not match this input's own 8px track once rotated into
   writing-mode:vertical-lr, and visibly overhangs to one side rather than
   centring on the thin groove. Sized explicitly + shifted to centre on the
   track (half the size difference, 4px) -- accent-color still supplies the
   fill colour, only the geometry is being constrained here. */
#${ROOM_ID} .msa-vfader-input::-webkit-slider-thumb{width:16px; height:16px; margin-left:-4px}
#${ROOM_ID} .msa-vfader-input::-moz-range-thumb{width:16px; height:16px}
/* Both were an INLINE addition beside a horizontal row's label+value before
   this fix; now they stack as ordinary block children below a vertical
   fader's own label, where the old margin-left just nudges them slightly
   off the column's own centred axis -- dropped, not replaced with
   anything, since the parent's own align-items:center already centres them. */
#${ROOM_ID} .msa-wx-bracket{font-size:.6rem; color:var(--ink2); white-space:nowrap}
#${ROOM_ID} .msa-wx-pin{flex:0 0 auto; padding:0 4px; font-size:.68rem; line-height:1;
  cursor:pointer; border:none; background:transparent; color:var(--shine)}
#${ROOM_ID} .msa-cue-deck{display:flex; flex-direction:column; gap:6px}
#${ROOM_ID} .msa-cue-label{font-size:.64rem; letter-spacing:.22em; text-transform:uppercase;
  color:var(--ink2); display:flex; align-items:center; gap:6px}
#${ROOM_ID} .msa-cue-label .ico{color:var(--shine)}
#${ROOM_ID} .msa-cue-listbtn{margin-left:auto; letter-spacing:.02em; text-transform:none;
  color:var(--ink2); opacity:.8; background:none; border:none; cursor:pointer; pointer-events:auto; font-size:.64rem}
#${ROOM_ID} .msa-cue-listbtn:hover{opacity:1; color:var(--ink0)}
#${ROOM_ID} .msa-cue-row{display:flex; gap:8px; align-items:stretch}
#${ROOM_ID} .msa-cue-card{flex:1; background:var(--bg2); border:1px solid var(--line);
  border-radius:var(--r-card); padding:7px 10px; display:flex; flex-direction:column; gap:2px; min-width:0}
#${ROOM_ID} .msa-cue-line{display:flex; align-items:baseline; gap:6px; min-width:0}
#${ROOM_ID} .msa-cue-k{font-size:.6rem; letter-spacing:.16em; color:var(--ink2); text-transform:uppercase; flex:none}
#${ROOM_ID} .msa-cue-name{font-weight:650; font-size:.8rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
#${ROOM_ID} .msa-cue-meta{display:flex; gap:8px; align-items:center; color:var(--ink2); font-size:.68rem}
#${ROOM_ID} .msa-cue-meta .ico{color:var(--c-atmos)}
/* Redesigned 2026-08-18 (author, verbatim: "throw away the current go
   button concept and just make something nicer. No animation... it's
   distracting"). The old design was a domed-transport-key skeuomorph —
   six stacked box-shadow layers plus an after-element sheen sliding across
   it on an infinite 4.6s loop, the single most V2-throwback-heavy surface
   in an otherwise flat LANTERN room. Replaced with the SAME flat,
   solid-fill language every other pill/card here already uses (the mode
   pill, a cue list row) — one solid tint, one border, no gradients stacked
   on gradients, no perpetual motion. */
#${ROOM_ID} .msa-cue-go{width:80px; border-radius:var(--r-card); border:1px solid var(--shine);
  background:color-mix(in oklab, var(--shine) 20%, var(--bg2));
  color:var(--shine); font-weight:800; letter-spacing:.14em; font-size:.92rem;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px;
  transition:background var(--t-micro), transform var(--t-micro);
  cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-cue-go .ico{width:1.05em; height:1.05em; fill:currentColor; stroke:none}
#${ROOM_ID} .msa-cue-go:hover{background:color-mix(in oklab, var(--shine) 30%, var(--bg2))}
#${ROOM_ID} .msa-cue-go:active{transform:translateY(1px)}
#${ROOM_ID} .msa-cue-go:disabled{opacity:.32; background:var(--bg2); border-color:var(--line); color:var(--ink2); cursor:default}
#${ROOM_ID} .msa-cue-status{min-height:14px; font-size:.68rem; color:var(--fail); text-align:center}
#${ROOM_ID} .msa-cue-list{display:none; flex-direction:column; gap:3px; border:1px solid var(--line);
  border-radius:var(--r-card); padding:6px; background:var(--bg1); max-height:150px; overflow-y:auto}
#${ROOM_ID} .msa-cue-list.open{display:flex}
#${ROOM_ID} .msa-cue-listrow{display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:7px;
  color:var(--ink1); font-size:.74rem; text-align:left; background:none; border:none; cursor:pointer;
  pointer-events:auto; width:100%}
#${ROOM_ID} .msa-cue-listrow:hover{background:var(--bg2); color:var(--ink0)}
#${ROOM_ID} .msa-cue-listrow.done{opacity:.45; text-decoration:line-through}
#${ROOM_ID} .msa-cue-listrow.next{color:var(--shine)}
#${ROOM_ID} .msa-cue-dur{margin-left:auto; color:var(--ink2); font-size:.66rem}
/* THE DEBUG ROW (2026-08-18 fix) — ported from the mock's own #debugStrip,
   "equipment, not product chrome" (dashed border, monospace, --c-system
   accent), same visual family as debug-panel.js's own .dbg class. */
/* THE DEBUG ACCORDION (2026-08-27 fix, author live-testing round: "prepare
   this section so it can open up... a library of debug buttons
   eventually"). .msa-debug-strip is now a COLUMN wrapping two rows: the
   always-visible primary row (probe + perf sweep) and a collapsible body
   holding everything the strip used to show unconditionally. */
#${ROOM_ID} .msa-debug-strip{border:1px dashed color-mix(in oklab, var(--c-system) 45%, transparent);
  border-radius:10px; padding:5px 11px; display:flex; flex-direction:column; gap:6px;
  font-family:var(--mono); font-size:.65rem; color:var(--ink2)}
#${ROOM_ID} .msa-debug-primary{display:flex; align-items:center; gap:11px; flex-wrap:wrap; row-gap:4px}
#${ROOM_ID} .msa-debug-tag{color:var(--c-system); letter-spacing:.18em; font-weight:700;
  display:flex; gap:5px; align-items:center}
#${ROOM_ID} .msa-debug-tag .ico{width:12px; height:12px}
#${ROOM_ID} .msa-debug-stat b{color:var(--ink0); font-weight:600}
#${ROOM_ID} .msa-debug-btn{padding:2px 9px; border:1px solid var(--line); border-radius:6px;
  color:var(--ink1); background:none; font-family:var(--mono); font-size:.62rem; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-debug-btn:hover{border-color:var(--c-system); color:var(--ink0)}
#${ROOM_ID} .msa-debug-btn.msa-planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}
#${ROOM_ID} .msa-debug-btn[aria-pressed="true"]{border-color:var(--c-system);
  color:var(--ink0); background:color-mix(in oklab, var(--c-system) 16%, transparent)}
/* Host for the perf HUD's own embeddable element inside the accordion body,
   filled in and revealed by the HUD button (mythica-machina-press#173 fix)
   -- perf-hud.js sets its own width:100%/background/border inline, this
   just gives it breathing room in the strip's flex column. */
#${ROOM_ID} .msa-debug-hud-host{width:100%}
/* The accordion's own chevron toggle -- pushed to the row's far end,
   rotates open/closed the SAME way the header's own minimize chevron
   already does (transform-box:fill-box, see .hbtn.msa-minimized above). */
#${ROOM_ID} .msa-debug-more{margin-left:auto; width:20px; height:20px; display:grid; place-items:center;
  border-radius:5px; color:var(--ink2); background:none; border:none; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-debug-more:hover{background:var(--bg3); color:var(--ink0)}
#${ROOM_ID} .msa-debug-more svg{transform-box:fill-box; transform-origin:center; transition:transform var(--t-micro)}
#${ROOM_ID} .msa-debug-more[aria-expanded="true"] svg{transform:rotate(90deg)}
#${ROOM_ID} .msa-debug-more-body{display:flex; flex-direction:column; gap:6px; padding-top:6px;
  border-top:1px solid color-mix(in oklab, var(--c-system) 30%, transparent)}
#${ROOM_ID} .msa-debug-stats-row, #${ROOM_ID} .msa-debug-more-btns{display:flex; align-items:center;
  gap:11px; flex-wrap:wrap; row-gap:4px}
#${ROOM_ID} .msa-debug-spark{display:flex; align-items:flex-end; gap:1px; height:15px; width:52px; flex:none}
/* Background is set per-bar, inline, by debug-strip.js's own fpsBlendColor
   (2026-08-18 fix, author's explicit fps-threshold spec) -- a continuous
   blend has no fixed set of classes to define here; the background colour
   rule below is only the pre-first-update default. */
#${ROOM_ID} .msa-debug-spark i{flex:1; min-width:1px; height:20%; border-radius:1px 1px 0 0;
  background:var(--ok); transition:height .25s ease, background .25s ease}
#${ROOM_ID} .msa-remote-foot{display:flex; gap:8px; flex-wrap:wrap; padding:10px 14px; border-top:1px solid var(--line); flex:none}
/* font/margin/box-sizing reset (2026-08-18/27 fixes, author report both
   rounds: "the buttons at the bottom of the UI have different heights") --
   TWO separate causes stacked here. First: a <button> carries its own
   UA-stylesheet font-family/line-height/margin that an <a> never does (an
   anchor just inherits the room's own font naturally) -- font:inherit fixed
   that pass but a height gap persisted. Second, found on re-report: these
   glyphs are a genuine emoji mix (Bug/Patreon/Maps vs Baseline/Safety), and
   different emoji fall back to different font metrics -- some render from a
   colour-emoji face with taller ascent/descent than the room's own --font
   stack, inflating that button's line box even with an identical authored
   line-height, since line-height caps the MINIMUM box, not a glyph that
   overflows it. A fixed height + flex-centred content sidesteps glyph
   metrics entirely: the box is a constant size regardless of what font any
   single character resolves to, so this can't reopen with some FUTURE icon
   choice either. */
#${ROOM_ID} .msa-remote-foot a, #${ROOM_ID} .msa-remote-foot button{flex:1 1 auto; min-width:0;
  display:flex; align-items:center; justify-content:center; height:30px;
  padding:0 8px; border-radius:8px; border:1px solid var(--line); background:var(--bg2); color:var(--ink1);
  font:inherit; font-size:.68rem; font-weight:600; margin:0; box-sizing:border-box; line-height:1;
  cursor:pointer; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
#${ROOM_ID} .msa-remote-foot a:hover, #${ROOM_ID} .msa-remote-foot button:hover{background:var(--bg3)}
#${ROOM_ID} .msa-remote-foot button.msa-planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}
#${ROOM_ID} .msa-remote-foot button.msa-danger{border-color:var(--fail); color:var(--fail);
  background:color-mix(in oklab, var(--fail) 16%, var(--bg2))}
#${ROOM_ID} #msa-remote-patreon{background:linear-gradient(135deg, #ff8a5b, #ff6b74); color:#fff; border:none}
`.trim();
  document.head.appendChild(el);
}

function headerBtn(icon, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hbtn';
  btn.title = title;
  btn.innerHTML = iconMarkup(icon);
  btn.addEventListener('click', onClick);
  return btn;
}

function plannedHeaderBtn(icon, title, plannedReason) {
  const btn = headerBtn(icon, `${title} — ${plannedReason}`, () => {});
  btn.classList.add('msa-planned');
  return btn;
}

function footerLink(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = text;
  return a;
}

function plannedFooterBtn(text, plannedReason) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msa-planned';
  btn.textContent = text;
  btn.title = plannedReason;
  return btn;
}

/**
 * A footer button for a genuinely irreversible action (UI parity plan,
 * phase 4b — the Safety button, wired to `diag/render-fallback.js#
 * engageFoundryFallback`, which physically tears down MSA's canvas with no
 * way back except a reload). Arms on the first click (re-labels itself,
 * `.msa-danger` styling), fires `onConfirmed` only on a SECOND click within
 * `armMs` — a deliberate two-click confirm in place rather than a native
 * `confirm()` dialog (blocks the whole tab, breaks this room's own LANTERN
 * chrome) or a popover (overkill for one binary "are you sure").
 * Auto-disarms if the second click never comes.
 * @param {string} text @param {string} tooltip @param {() => void} onConfirmed @param {number} [armMs]
 */
function dangerFooterBtn(text, tooltip, onConfirmed, armMs = 4000) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  btn.title = tooltip;
  let armed = false;
  let armTimer = null;
  function disarm() {
    armed = false;
    clearTimeout(armTimer);
    btn.textContent = text;
    btn.classList.remove('msa-danger');
    btn.title = tooltip;
  }
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.textContent = 'Click again to confirm';
      btn.title = 'One-way — MSA stops rendering until you reload. Click again within a few seconds to proceed.';
      btn.classList.add('msa-danger');
      armTimer = setTimeout(disarm, armMs);
      return;
    }
    disarm();
    onConfirmed();
  });
  return btn;
}

/**
 * @param {{debugPanel?: object,
 *   mountAstrolabeDial: (el: HTMLElement, dialCtx: {onLockedAttempt: () => void}) => void,
 *   getPosture: () => string, onSetMode?: (mode: string) => void,
 *   isFlowPlaying: () => boolean, onFlowToggle: () => void,
 *   getFlowRate?: () => number, onSetFlowRate?: (rate: number) => void,
 *   weatherBoard?: object, onBaseline?: (overMs: number) => void, cueDeck?: object,
 *   debugStrip?: object,
 *   getRendererOverride?: () => 'msa'|'foundry', onRendererOverrideChange?: (v: 'msa'|'foundry') => Promise<void>,
 *   onEngageSafety?: () => void,
 *   windPopover?: {getDirectionDeg?: () => number,
 *     onCommit?: (v: {directionDeg?: number}) => void},
 *   onOpenTileMotion?: () => void,
 *   impulses?: Array<import('../../../core/impulse-schema.js').ImpulseDecl>}} [opts]
 *   `weatherBoard`/`cueDeck`/`debugStrip`, when supplied, are passed straight
 *   through as `renderWeatherBoard`/`renderCueDeck`/`renderDebugStrip`'s own
 *   `ctx` (weather-board.js, cue-deck.js, debug-strip.js) — this file never
 *   inspects their shape, only whether they
 *   exist. `impulses` (U7) is handed straight to `astrolabe-panel.js`'s own
 *   TR corner unchanged, same reasoning. `getFlowRate`/`onSetFlowRate`
 *   (2026-08-18 fix) back the TL corner's real speed popover — see
 *   astrolabe-panel.js's own header for why this replaced a silently-dead
 *   `onScrollToRateControl` callback.
 */
export function installRemote(opts = {}) {
  installTokens();
  installIconSprite();
  injectStyle();

  if (document.getElementById(ROOM_ID)) return document.getElementById(ROOM_ID)._msaRemoteController;

  const state = { open: false, minimized: false };
  const room = document.createElement('section');
  room.id = ROOM_ID;
  room.setAttribute('aria-label', 'Map Shine Remote');
  room.hidden = true;

  // ---- header --------------------------------------------------------
  const head = document.createElement('header');
  head.className = 'msa-remote-head';
  const title = document.createElement('span');
  title.className = 'msa-remote-title';
  title.innerHTML = `${iconMarkup('candle')}Map Shine Advanced`;
  const headSpacer = document.createElement('span');
  headSpacer.className = 'msa-spacer';

  const camPath = installCameraPathPopover();
  const camPathBtn = headerBtn('camera', 'Camera path', () => camPath.toggle());
  // Tile Motion's own header button is GONE (2026-08-27, author: "remove
  // the current header button and use the one at the bottom right of the
  // astrolabe" instead) — see ui/rooms/remote/tile-motion-panel.js and
  // astrolabe-panel.js's own BR corner, which now opens it.
  // THE WIND POPOVER (UI parity plan, phase 6a) — opened from the dial's
  // own wind pill (astrolabe-dial.js's windBtn), not a header icon, so it
  // is instantiated here but has no header button of its own.
  const windPopover = installWindPopover({
    getDirectionDeg: opts.windPopover?.getDirectionDeg,
    onCommit: (v) => opts.windPopover?.onCommit?.(v),
  });
  const dirBtn = plannedHeaderBtn('clap', 'Director', 'Cutscene mode lands in a later stage (U9) — not built yet.');
  const healthBtn = plannedHeaderBtn(
    'health',
    'Scene health',
    'Aggregating every mask/effect readiness into one glance is still an open design question — not built yet.'
  );
  const minimizeBtn = headerBtn('chev', 'Minimize', () => controller.toggleMinimize());
  const closeBtn = headerBtn('x', 'Close Remote', () => controller.close());

  head.append(title, headSpacer, dirBtn, camPathBtn, healthBtn, minimizeBtn, closeBtn);

  // THE RENDERER DROPDOWN (UI parity plan, phase 4b, round 2) — author
  // redesign of the header toggle button: "I'd rather have a dropdown...
  // this is the GM's master override which should make all users connected
  // to the world use one or the other... part of the safety slide." A
  // world-scoped Foundry setting now, not a per-client function call (see
  // GLOBAL_SETTING_KEYS.rendererOverride's own doc in effects/effect-
  // settings.js) — this dropdown only ever reads/writes that ONE value,
  // through opts.getRendererOverride/onRendererOverrideChange.
  //
  // Its own strip, sibling to `body`/`foot` (not inside either), purely for
  // DOM position between head and body. Minimizes along with the rest of
  // the room (2026-08-27 fix, author: "when I minimise I can still see the
  // dropdown for renderer, but this too should become minimised") — see the
  // CSS rule's own comment for the superseded "always reachable" reasoning.
  const rendererRow = document.createElement('div');
  rendererRow.className = 'msa-renderer-row';
  const rendererLabel = document.createElement('span');
  rendererLabel.className = 'msa-renderer-label';
  rendererLabel.innerHTML = `${iconMarkup('shield')}Renderer`;
  const rendererSelect = document.createElement('select');
  rendererSelect.className = 'msa-renderer-select';
  rendererSelect.append(new Option('MSA', 'msa'), new Option('Foundry (safety fallback)', 'foundry'));
  rendererSelect.title =
    'Which renderer draws the map for EVERYONE at this table — a GM-only, table-wide setting. Switch to Foundry if MSA is causing problems mid-session.';
  rendererSelect.addEventListener('change', async () => {
    rendererSelect.disabled = true;
    try {
      await opts.onRendererOverrideChange?.(rendererSelect.value);
    } catch (err) {
      rendererSelect.title = `Renderer switch failed — ${err?.message ?? err}`;
    } finally {
      rendererSelect.disabled = false;
    }
  });
  rendererRow.append(rendererLabel, rendererSelect);

  /** Paint the dropdown's selected value from a live fact (never assumed) —
   * called by boot.js's own syncInterfaceSeam whenever the underlying
   * WORLD setting changes (this client's own edit, a second GM's edit, a
   * scene load) — the exact same "instrument must not lie" contract the
   * old select's refreshControls() already kept, now over a world value
   * instead of a per-client one.
   *
   * ⚠️ NOT called eagerly here at installRemote() time — `opts.
   * getRendererOverride` reads `game.settings.get`, which THROWS before
   * Foundry's `init` hook has registered the setting, and installRemote()
   * runs at install()'s own eager, pre-init point (this file's own header
   * explains why every other live-state read here is deferred the same
   * way). The `<select>`'s own first `<option>` (MSA) already matches the
   * setting's registered default, so leaving it at that natural default
   * until the first real syncInterfaceSeam call — which always lands well
   * after `init`, at the first scene load — is correct, not a placeholder. */
  function paintRendererSelect(isFoundry) {
    rendererSelect.value = isFoundry ? 'foundry' : 'msa';
  }

  // ---- body ------------------------------------------------------------
  // ⚠️ CONTENT IS BUILT LAZILY, ON FIRST open() — NOT here at installRemote()
  // call time. boot.js calls installRemote() at the same eager point it
  // calls installStudio(), long before the astrolabe's own closure state
  // (windDirectionDeg, the astrolabe/skyScope lets, editSky) is declared
  // further down install()'s body — mountAstrolabeDial calling
  // buildAstrolabeOptions() at THAT point would hit a temporal-dead-zone
  // ReferenceError. Deferring to first open() (well after install() has
  // finished running once) sidesteps it entirely, and matches Studio's own
  // shell.js, which defers its department body the identical way.
  const body = document.createElement('div');
  body.className = 'msa-remote-body';
  let bodyBuilt = false;
  let npGlyph = null;
  let npLabel = null;
  /** @type {{getFadeOverMs: () => number, refresh: () => void}|null} */
  let weatherBoardHandle = null;
  /** @type {{refresh: () => void}|null} */
  let cueDeckHandle = null;
  /** @type {{syncFlowState: () => void}|null} */
  let astrolabePanelHandle = null;
  /** @type {{update: () => void}|null} */
  let debugStripHandle = null;

  function buildBody() {
    if (bodyBuilt) return;
    bodyBuilt = true;

    // The renderer dropdown's own first REAL paint — safe here (first
    // open() always runs well after Foundry's `init`), unlike at
    // installRemote() construction time (see paintRendererSelect's own
    // doc). Covers the narrow gap between boot and the first
    // syncInterfaceSeam call for a GM who opens the Remote immediately.
    paintRendererSelect(opts.getRendererOverride?.() === 'foundry');

    const nowPlaying = document.createElement('div');
    nowPlaying.className = 'msa-now-playing';
    npGlyph = document.createElement('span');
    npGlyph.innerHTML = iconMarkup('sun');
    npLabel = document.createElement('span');
    npLabel.textContent = 'Steady';
    nowPlaying.append(npGlyph, npLabel);
    // Now Playing sits ABOVE the astrolabe in the grammar (§4.1's own row
    // order).
    body.appendChild(nowPlaying);

    astrolabePanelHandle = renderAstrolabePanel(body, {
      mountAstrolabeDial: opts.mountAstrolabeDial ?? (() => {}),
      getPosture: opts.getPosture ?? (() => 'director'),
      onSetMode: opts.onSetMode ?? (() => {}),
      isFlowPlaying: opts.isFlowPlaying ?? (() => false),
      onFlowToggle: opts.onFlowToggle ?? (() => {}),
      getFlowRate: opts.getFlowRate ?? (() => 0),
      onSetFlowRate: opts.onSetFlowRate ?? (() => {}),
      impulses: opts.impulses ?? [],
      // UI parity plan, phase 6a: this file owns the wind popover instance
      // (same "a sibling-imported sub-widget this file owns outright"
      // shape camPath already has above), astrolabe-panel.js just forwards
      // the click straight through to it. Phase 6b's onTimeStop needs no
      // equivalent field here — boot.js's own mountAstrolabeDial wires the
      // real engine call directly, matching onTimeChange's own precedent
      // (see that function's own comment).
      onWindClick: () => windPopover.toggle(),
      // The BR corner's own Tile Motion button (2026-08-27) — unlike
      // camPath/windPopover, this file does NOT own the tile-motion panel
      // instance (boot.js does, shared with Studio's Scene department and
      // the Lab action) — straight pass-through of whatever opts supplies.
      onOpenTileMotion: () => opts.onOpenTileMotion?.(),
    });

    if (opts.weatherBoard) {
      const sep2 = document.createElement('div');
      sep2.className = 'msa-remote-sep';
      const wxHost = document.createElement('div');
      wxHost.className = 'msa-wx-host';
      body.append(sep2, wxHost);
      weatherBoardHandle = renderWeatherBoard(wxHost, opts.weatherBoard);
    }

    if (opts.cueDeck) {
      const sep3 = document.createElement('div');
      sep3.className = 'msa-remote-sep';
      const cueHost = document.createElement('div');
      body.append(sep3, cueHost);
      cueDeckHandle = renderCueDeck(cueHost, opts.cueDeck);
    }

    if (opts.debugStrip) {
      // 2026-08-18 fix (author report: "buttons/sections are touching each
      // other") — weather/cues both get their own .msa-remote-sep divider
      // above; the debug strip never did, so it visually ran into the cues
      // section above it despite body's own gap.
      const sep4 = document.createElement('div');
      sep4.className = 'msa-remote-sep';
      const debugHost = document.createElement('div');
      body.append(sep4, debugHost);
      debugStripHandle = renderDebugStrip(debugHost, opts.debugStrip);
    }
  }

  // ---- footer ------------------------------------------------------------
  const foot = document.createElement('div');
  foot.className = 'msa-remote-foot';
  const baselineBtn = opts.onBaseline
    ? (() => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '⟲ Baseline';
        btn.title = "Fade back to the scene's authored resting look, over the current Fade Time.";
        btn.addEventListener('click', () => opts.onBaseline(weatherBoardHandle?.getFadeOverMs() ?? 0));
        return btn;
      })()
    : plannedFooterBtn('⟲ Baseline', 'Fading back to the authored resting look needs the Fade Engine — not built yet.');
  // THE SAFETY BUTTON (UI parity plan, phase 4b) — real as of this round,
  // deliberately SEPARATE from the Renderer toggle above (see that button's
  // own header comment). opts.onEngageSafety is expected to call
  // diag/render-fallback.js#engageFoundryFallback directly; omitted keeps
  // the old honest-stub behaviour rather than wiring a button to nothing.
  const safetyBtn = opts.onEngageSafety
    ? dangerFooterBtn(
        '⛑ Safety',
        'One-way: stops MSA and hands the canvas back to Foundry. Only a reload brings MSA back — use only when something is genuinely wrong.',
        () => opts.onEngageSafety()
      )
    : plannedFooterBtn(
        '⛑ Safety',
        'The MSA→Foundry safety slide is a real, one-way mechanism (diag/render-fallback.js) not yet wired to a manual button.'
      );
  foot.append(
    baselineBtn,
    safetyBtn,
    footerLink('https://github.com/Garsondee/map-shine-advanced/issues', '🐛 Bug'),
    (() => {
      const a = footerLink('https://www.patreon.com/c/MythicaMachina', '❤ Patreon');
      a.id = 'msa-remote-patreon';
      return a;
    })(),
    footerLink('https://www.foundryvtt.store/creators/mythica-machina', '🗺 Maps')
  );

  // THE CARD (2026-08-27 round 2) — see this file's own CSS comment on
  // .msa-remote-card for why head/rendererRow/body/foot mount into a wrapper
  // now instead of directly onto `room`.
  const card = document.createElement('div');
  card.className = 'msa-remote-card';
  card.append(head, rendererRow, body, foot);
  room.appendChild(card);
  document.body.appendChild(room);
  makeDraggable(head, room);
  // THE SCALE STRIP (2026-08-27, author: "a scaling button on the side of
  // the UI... generally helpful for people worried about screen real
  // estate"; round 2, author: "moved to the left till it sits on the
  // outside of the panel") — a sibling of `card`, not a child of it, so it
  // is never clipped by the card's own overflow:hidden.
  room.appendChild(installScaleControl(room, { storageKey: 'msa-remote-scale' }).root);

  const openChangeListeners = new Set();
  const controller = {
    open() {
      buildBody();
      state.open = true;
      room.hidden = false;
      for (const fn of openChangeListeners) fn(true);
    },
    close() {
      state.open = false;
      room.hidden = true;
      camPath.close();
      windPopover.close();
      for (const fn of openChangeListeners) fn(false);
    },
    toggle() {
      if (state.open) controller.close();
      else controller.open();
    },
    toggleMinimize() {
      state.minimized = !state.minimized;
      room.dataset.minimized = String(state.minimized);
      minimizeBtn.classList.toggle('msa-minimized', state.minimized);
      minimizeBtn.title = state.minimized ? 'Expand' : 'Minimize';
    },
    isOpen: () => state.open,
    onOpenChange(fn) {
      openChangeListeners.add(fn);
    },
    /** Boot.js's own per-frame pump can push a fresh Now Playing readout in
     * without this file ever polling anything itself. */
    updateNowPlaying({ glyph, label }) {
      if (!bodyBuilt) return;
      if (glyph) npGlyph.innerHTML = iconMarkup(glyph);
      if (label) npLabel.textContent = label;
    },
    /** Re-sync the weather board's chip/mode highlighting — boot.js calls
     * this when a fade completes (the archetype label only becomes "true"
     * once arrived) and whenever another client's own edit reaches this one
     * (watchSceneSky/watchFadeState), matching "one writer, many derivers":
     * this file never polls, it's told when to repaint. No-op before the
     * body exists or when no weather board was supplied. */
    refreshWeatherBoard() {
      weatherBoardHandle?.refresh();
    },
    /** Re-paint the cue deck's next-cue card and jump list — boot.js calls
     * this whenever the scene's own cue stack changes (a capture, another
     * GM's edit, a scene switch), matching refreshWeatherBoard's own
     * "never polls, it's told" shape. No-op before the body exists or when
     * no cue deck was supplied. */
    refreshCueDeck() {
      cueDeckHandle?.refresh();
    },
    /** Re-sync the TL corner's flow/speed buttons (icon, aria-pressed, "×N"
     * label) against the live rate — boot.js's pumpAstrolabe calls this every
     * tick, matching refreshWeatherBoard/refreshCueDeck's own "never polls,
     * it's told" shape, so the buttons can't go stale when the rate changes
     * from elsewhere (the old panel's own rate slider, another client). */
    syncAstrolabePanel() {
      astrolabePanelHandle?.syncFlowState();
    },
    /** Re-paint the DEBUG row's fps/ms/vram/sparkline — boot.js's own
     * heartbeat calls this every ~250ms with a fresh snapshot (the old
     * panel's own equivalent, `MapShine.debug.updatePerfStrip`, was deleted
     * along with that panel — UI parity plan, phase 7b; this is the sole
     * surviving display now). No-op before the body exists or when no debug strip was supplied
     * (opts.debugStrip).
     * @param {object} snapshot */
    updateDebugStrip(snapshot) {
      debugStripHandle?.update(snapshot);
    },
    /** Re-sync the Renderer header button against reality — boot.js's own
     * syncInterfaceSeam calls this every time the underlying state can
     * change (scene load, floor switch, a toggle from this button itself),
     * matching the old panel's own refreshControls() contract: this button
     * must never keep showing what was true when the Remote first opened.
     * Safe to call before the room has ever been opened (updates the same
     * button element either way — it's built at installRemote() time, not
     * lazily with the rest of the body).
     * @param {boolean} isFoundryRendering */
    updateRendererState(isFoundryRendering) {
      paintRendererSelect(isFoundryRendering);
    },
    /** The Fade Time currently selected on the weather board, in ms — read
     * by boot.js's own astrolabe time-stop handler (2026-08-27 fix, author:
     * "I select 10s transition time... it happens instantly") so a discrete
     * hour jump eases over the SAME duration a weather fade would, instead
     * of day-clock.js's own fixed default. A pull, not a push, unlike every
     * other controller method here: boot.js's onTimeStop lives inside the
     * mountAstrolabeDial factory, a different closure than this file's own
     * weatherBoardHandle, with no shared scope to thread a callback through
     * — MapShine.__remote is the one thing both sides already reach through.
     * `0` (weatherBoardHandle not built yet, or no weather board supplied)
     * reads as "Now," matching that value's own honest "cut instantly"
     * meaning elsewhere in this file.
     * @returns {number} */
    getFadeOverMs() {
      return weatherBoardHandle?.getFadeOverMs() ?? 0;
    },
  };
  room._msaRemoteController = controller;
  return controller;
}
