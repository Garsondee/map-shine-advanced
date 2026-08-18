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
import { installCameraPathPopover } from './camera-path-popover.js';
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
  max-height:calc(100vh - 60px); background:var(--glass); backdrop-filter:blur(var(--glass-blur));
  border:1px solid var(--line); border-radius:var(--r-room); box-shadow:var(--shadow3);
  display:flex; flex-direction:column; overflow:hidden; z-index:100; font:12px/1.4 var(--font); color:var(--ink0)}
#${ROOM_ID}[data-minimized="true"] .msa-remote-body,
#${ROOM_ID}[data-minimized="true"] .msa-remote-foot{display:none}
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
#${ROOM_ID} .msa-remote-body{flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:12px}
#${ROOM_ID} .msa-now-playing{display:flex; align-items:center; gap:8px; padding:6px 10px;
  background:var(--bg2); border:1px solid var(--line); border-radius:999px; font-size:.74rem; color:var(--ink1)}
#${ROOM_ID} .msa-now-playing .ico{color:var(--shine); width:16px; height:16px}
#${ROOM_ID} .msa-astro-wrap{display:flex; flex-direction:column; gap:6px; align-items:center}
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
#${ROOM_ID} .msa-corner button:nth-child(1){grid-area:a}
#${ROOM_ID} .msa-corner button:nth-child(2){grid-area:b}
#${ROOM_ID} .msa-corner button:nth-child(3){grid-area:c}
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
#${ROOM_ID} .msa-wx-host{display:flex; flex-direction:column; gap:10px}
#${ROOM_ID} .msa-fade-time{display:grid; grid-template-columns:repeat(6, 1fr); gap:4px}
#${ROOM_ID} .msa-fade-time button{padding:5px 4px; border-radius:7px; border:1px solid var(--line);
  background:var(--bg2); color:var(--ink2); font-size:.68rem; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-fade-time button:hover{background:var(--bg3); color:var(--ink0)}
#${ROOM_ID} .msa-fade-time button[aria-pressed="true"]{background:color-mix(in oklab, var(--shine) 16%, transparent);
  border-color:var(--shine); color:var(--shine)}
#${ROOM_ID} .msa-wx-modeseg{display:grid; grid-template-columns:1fr 1fr; gap:4px}
#${ROOM_ID} .msa-wx-modeseg button{padding:6px; border-radius:7px; border:1px solid var(--line); background:var(--bg2);
  color:var(--ink2); font-size:.72rem; font-weight:600; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-wx-modeseg button[aria-pressed="true"]{background:color-mix(in oklab, var(--c-atmos) 18%, transparent);
  border-color:var(--c-atmos); color:var(--c-atmos)}
#${ROOM_ID} .msa-wx-chips{display:flex; flex-wrap:wrap; gap:5px}
#${ROOM_ID} .msa-wx-chip{padding:5px 9px; border-radius:999px; border:1px solid var(--line); background:var(--bg2);
  color:var(--ink1); font-size:.7rem; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-wx-chip:hover{background:var(--bg3)}
#${ROOM_ID} .msa-wx-chip[aria-pressed="true"]{background:color-mix(in oklab, var(--shine) 18%, transparent);
  border-color:var(--shine); color:var(--shine)}
#${ROOM_ID} .msa-wx-faders{display:flex; flex-direction:column; gap:6px}
#${ROOM_ID} .msa-wx-bracket{font-size:.62rem; color:var(--ink2); margin-left:6px; white-space:nowrap}
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
#${ROOM_ID} .msa-cue-go{width:80px; border-radius:12px; position:relative; overflow:hidden; isolation:isolate;
  border:1px solid color-mix(in oklab, var(--shine) 58%, transparent);
  background:
    radial-gradient(115% 75% at 50% -8%, color-mix(in oklab, var(--shine) 46%, transparent), transparent 72%),
    linear-gradient(180deg, color-mix(in oklab, var(--shine) 20%, var(--bg3)) 0%,
                            var(--bg2) 72%, color-mix(in oklab, var(--shine) 7%, var(--bg1)) 100%);
  color:var(--shine); font-weight:900; letter-spacing:.22em; font-size:1.02rem;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px;
  text-shadow:0 0 14px var(--shine-glow), 0 1px 0 rgba(0,0,0,.45);
  transition:transform var(--t-micro), box-shadow var(--t-micro), filter var(--t-micro);
  cursor:pointer; pointer-events:auto;
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, var(--shine) 52%, transparent),
    inset 0 -10px 16px -10px color-mix(in oklab, var(--shine) 55%, transparent),
    inset 0 0 0 1px rgba(255,255,255,.04),
    0 3px 0 -1px color-mix(in oklab, var(--shine) 22%, var(--bg0)),
    0 5px 14px color-mix(in oklab, var(--shine) 20%, transparent),
    0 0 calc(20px * var(--glow-on)) var(--shine-soft)}
#${ROOM_ID} .msa-cue-go::after{content:""; position:absolute; inset:-40% -120%; z-index:-1;
  background:linear-gradient(74deg, transparent 42%,
    color-mix(in oklab, var(--shine) 30%, transparent) 50%, transparent 58%);
  animation:msaGoSheen 4.6s ease-in-out infinite}
@keyframes msaGoSheen{0%,72%{transform:translateX(-58%)}100%{transform:translateX(58%)}}
#${ROOM_ID} .msa-cue-go .ico{width:1.15em; height:1.15em; fill:currentColor; stroke:none; opacity:.92}
#${ROOM_ID} .msa-cue-go:hover{filter:brightness(1.09);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, var(--shine) 62%, transparent),
    inset 0 -10px 16px -10px color-mix(in oklab, var(--shine) 65%, transparent),
    0 3px 0 -1px color-mix(in oklab, var(--shine) 26%, var(--bg0)),
    0 6px 18px color-mix(in oklab, var(--shine) 26%, transparent),
    0 0 calc(30px * var(--glow-on)) var(--shine-glow)}
#${ROOM_ID} .msa-cue-go:active{transform:translateY(2px);
  box-shadow:
    inset 0 2px 6px rgba(0,0,0,.45),
    inset 0 0 0 1px color-mix(in oklab, var(--shine) 30%, transparent),
    0 1px 0 -1px color-mix(in oklab, var(--shine) 18%, var(--bg0))}
#${ROOM_ID} .msa-cue-go:disabled{opacity:.32; filter:saturate(.4); box-shadow:none; cursor:default}
#${ROOM_ID} .msa-cue-go:disabled::after{display:none}
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
#${ROOM_ID} .msa-debug-strip{border:1px dashed color-mix(in oklab, var(--c-system) 45%, transparent);
  border-radius:10px; padding:5px 11px; display:flex; align-items:center; gap:11px; flex-wrap:wrap;
  row-gap:4px; font-family:var(--mono); font-size:.65rem; color:var(--ink2)}
#${ROOM_ID} .msa-debug-tag{color:var(--c-system); letter-spacing:.18em; font-weight:700;
  display:flex; gap:5px; align-items:center}
#${ROOM_ID} .msa-debug-tag .ico{width:12px; height:12px}
#${ROOM_ID} .msa-debug-stat b{color:var(--ink0); font-weight:600}
#${ROOM_ID} .msa-debug-spacer{flex:1}
#${ROOM_ID} .msa-debug-btn{padding:2px 9px; border:1px solid var(--line); border-radius:6px;
  color:var(--ink1); background:none; font-family:var(--mono); font-size:.62rem; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-debug-btn:hover{border-color:var(--c-system); color:var(--ink0)}
#${ROOM_ID} .msa-debug-btn.msa-planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}
#${ROOM_ID} .msa-debug-spark{display:flex; align-items:flex-end; gap:1px; height:15px; width:52px; flex:none}
#${ROOM_ID} .msa-debug-spark i{flex:1; min-width:1px; height:20%; border-radius:1px 1px 0 0;
  background:var(--ok); transition:height .25s ease, background .25s ease}
#${ROOM_ID} .msa-debug-spark i.warn{background:var(--warn)}
#${ROOM_ID} .msa-debug-spark i.bad{background:var(--fail)}
#${ROOM_ID} .msa-remote-foot{display:flex; gap:8px; flex-wrap:wrap; padding:10px 14px; border-top:1px solid var(--line); flex:none}
#${ROOM_ID} .msa-remote-foot a, #${ROOM_ID} .msa-remote-foot button{flex:1 1 auto; min-width:0; text-align:center;
  padding:6px 8px; border-radius:8px; border:1px solid var(--line); background:var(--bg2); color:var(--ink1);
  font-size:.68rem; font-weight:600; cursor:pointer; text-decoration:none; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap}
#${ROOM_ID} .msa-remote-foot a:hover, #${ROOM_ID} .msa-remote-foot button:hover{background:var(--bg3)}
#${ROOM_ID} .msa-remote-foot button.msa-planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}
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
 * @param {{debugPanel?: object, mountAstrolabeDial: (el: HTMLElement) => void,
 *   getPosture: () => string, isFlowPlaying: () => boolean, onFlowToggle: () => void,
 *   getFlowRate?: () => number, onSetFlowRate?: (rate: number) => void,
 *   weatherBoard?: object, onBaseline?: (overMs: number) => void, cueDeck?: object,
 *   debugStrip?: object,
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
  const dirBtn = plannedHeaderBtn('clap', 'Director', 'Cutscene mode lands in a later stage (U9) — not built yet.');
  const healthBtn = plannedHeaderBtn(
    'health',
    'Scene health',
    'Aggregating every mask/effect readiness into one glance is still an open design question — not built yet.'
  );
  const minimizeBtn = headerBtn('chev', 'Minimize', () => controller.toggleMinimize());
  const closeBtn = headerBtn('x', 'Close Remote', () => controller.close());

  head.append(title, headSpacer, dirBtn, camPathBtn, healthBtn, minimizeBtn, closeBtn);

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
      isFlowPlaying: opts.isFlowPlaying ?? (() => false),
      onFlowToggle: opts.onFlowToggle ?? (() => {}),
      getFlowRate: opts.getFlowRate ?? (() => 0),
      onSetFlowRate: opts.onSetFlowRate ?? (() => {}),
      impulses: opts.impulses ?? [],
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
      const debugHost = document.createElement('div');
      body.append(debugHost);
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
  foot.append(
    baselineBtn,
    plannedFooterBtn(
      '⛑ Safety',
      'The MSA→Foundry safety slide is a real, one-way mechanism (diag/render-fallback.js) not yet wired to a manual button — see Petition P11.'
    ),
    footerLink('https://github.com/Garsondee/map-shine-advanced/issues', '🐛 Bug'),
    (() => {
      const a = footerLink('https://www.patreon.com/c/MythicaMachina', '❤ Patreon');
      a.id = 'msa-remote-patreon';
      return a;
    })(),
    footerLink('https://www.foundryvtt.store/creators/mythica-machina', '🗺 Maps')
  );

  room.append(head, body, foot);
  document.body.appendChild(room);
  makeDraggable(head, room);

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
     * heartbeat calls this every ~250ms with a fresh snapshot, right
     * alongside the identical, pre-existing `MapShine.debug.updatePerfStrip`
     * call the old panel's own strip already gets (same dual-dispatch shape
     * `remoteAstrolabe.update` already uses next to `astrolabe.update`).
     * No-op before the body exists or when no debug strip was supplied
     * (opts.debugStrip).
     * @param {object} snapshot */
    updateDebugStrip(snapshot) {
      debugStripHandle?.update(snapshot);
    },
  };
  room._msaRemoteController = controller;
  return controller;
}
