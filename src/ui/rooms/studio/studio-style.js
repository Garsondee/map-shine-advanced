/**
 * ui/rooms/studio/studio-style.js — the Studio's stylesheet: its room chrome,
 * department rail and the layouts of its departments, on top of the shared kit.
 *
 * Moved out of `shell.js` (where the first version was a ~60-line port of the
 * mock's room/rail/head rules) when the polish pass of 2026-10-18 turned it
 * into a small design system, and the generic half of it — the press / hover /
 * focus model, buttons, chips, switches, fields, parameter rows, slider fill —
 * moved on to `../room-style.js` when the Remote and Player room got the same
 * pass. The motion rules, and the Foundry global-CSS bleed this sheet has to
 * win back (button `height:2em`, `transition:0.5s`, an orange hover, a focus
 * glow, a serif `h2`, `select{width:100%}`), are explained at the top of that
 * file; what stays here is genuinely the Studio's own.
 *
 * Inline styles cannot express `:hover`, `:active` or `:focus-visible` at all,
 * which is why nothing in the panel used to respond to a press.
 *
 * @module ui/rooms/studio/studio-style
 */

import { HOVER_GATE, MOTION_KEYFRAMES, uiKitCss, uiKitHoverCss } from '../room-style.js';

/**
 * @param {string} roomId - the room element's id (no `#`).
 * @param {string[]} accentVars - the distinct `--c-*` tokens the rail uses.
 * @returns {string} the full stylesheet text.
 */
export function studioCss(roomId, accentVars) {
  const R = `#${roomId}`;
  // Everything the shared kit styles lives inside the room. (It also reached a
  // detached pop-out card window until the Effects library replaced those.)
  const IN = R;
  const RAIL = `${R} .rail button`;

  return `
/* ---- the room ------------------------------------------------------------ */
${R}{top:44px; left:24px; width:620px; height:800px;
  max-width:calc(100vw - 460px); max-height:calc(100vh - 60px);
  min-width:500px; min-height:520px; resize:both;
  position:fixed; z-index:100; background:var(--glass);
  backdrop-filter:blur(var(--glass-blur));
  border:1px solid var(--line); border-radius:var(--r-room);
  box-shadow:var(--shadow3); display:flex; flex-direction:column; overflow:hidden;
  font:12px/1.4 var(--font); color:var(--ink0); transform-origin:0 0}
/* Opened by a mouse click on the toolbar: an occasional action, so it gets a
   short entrance (ease-out, 200ms, from .985 — never from 0). Closing is
   instant: the system should be fastest when it is the one responding. */
${R}.msa-enter{animation:msaRoomIn 200ms var(--ease-out) both}
${MOTION_KEYFRAMES}

${R} .room-head{display:flex; align-items:center; gap:var(--sp2);
  padding:8px 14px; border-bottom:1px solid var(--line); cursor:grab; user-select:none; flex:none}
${R} .room-head:active{cursor:grabbing}
${R} .rtitle{font-weight:600; letter-spacing:.14em; font-size:.72rem;
  color:var(--ink1); text-transform:uppercase; display:flex; gap:8px; align-items:center}
${R} .rtitle .ico{color:var(--shine)}
${R} .spacer{flex:1}
${R} .frame{display:flex; flex:1; min-height:0}

${uiKitCss(IN, { pressAfter: [RAIL] })}

/* ---- the department rail ---------------------------------------------------- */
${R} .rail{width:58px; flex:none; border-right:1px solid var(--line); display:flex;
  flex-direction:column; align-items:center; padding:10px 0; gap:4px}
${RAIL}{position:relative; width:42px; height:42px; display:grid; place-items:center; padding:0;
  border:0; border-radius:11px; color:var(--ink2); background:transparent}
${R} .rail button .ico{width:19px; height:19px}
/* The active-department bar. It exists on EVERY button and just scales/fades
   in on the pressed one, so switching reads as the bar handing over from one
   department to the next (no layout maths, no sliding element to keep in
   sync with a resizable rail). Short and ease-out: this is used all day. */
${RAIL}::before{content:""; position:absolute; left:-9px; top:9px; bottom:9px; width:3px; border-radius:2px;
  background:var(--ink2); opacity:0; transform:scaleY(.35);
  transition:transform 180ms var(--ease-out), opacity 120ms ease}
${RAIL}[aria-pressed="true"]::before{opacity:1; transform:scaleY(1)}
${accentVars
  .map(
    (v) => `${RAIL}[data-acc="${v}"]::before{background:var(${v})}
${RAIL}[aria-pressed="true"][data-acc="${v}"]{color:var(${v}); background:color-mix(in oklab, var(${v}) 14%, transparent)}`
  )
  .join('\n')}
${RAIL}[disabled]{opacity:.4; cursor:default}
${R} .railspacer{flex:1}
${R} .devtag{font-size:.56rem; color:var(--ink2); letter-spacing:.12em; margin-top:2px}

/* ---- department body --------------------------------------------------------- */
${R} .deptBody{flex:1; min-width:0; display:flex; flex-direction:column}
${R} .depthead{flex:none; display:flex; align-items:center; gap:10px; padding:12px 18px 10px;
  border-bottom:1px solid var(--line)}
/* Foundry sets h2 in a serif display face — the one place the panel left the
   LANTERN face. Pinned back to the room's own. */
${R} .depthead h2{font:650 .95rem/1.2 var(--font); display:flex; gap:9px; align-items:center;
  margin:0; padding:0; border:0; color:var(--ink0); letter-spacing:normal; text-shadow:none}
${R} .depthead h2 .ico{width:1.15em; height:1.15em}
${R} .depthead h2{flex:none}
/* One line, ellipsis — a long subtitle used to wrap to two and make the header
   taller than every other department's. The full text is the tooltip. */
${R} .depthead .sub{color:var(--ink2); font-size:.72rem; min-width:0; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap}
${R} #studioSearchBox{display:flex; align-items:center; gap:6px; height:30px; width:250px; padding:0 12px;
  background:var(--bg2); border:1px solid var(--line); border-radius:999px; cursor:text;
  transition:border-color 120ms ease, box-shadow 120ms ease}
${R} #studioSearchBox:focus-within{border-color:var(--shine); box-shadow:0 0 0 3px var(--shine-soft)}
${R} #studioSearchBox input{width:100%; height:auto; padding:0; background:none; border:none; outline:none;
  box-shadow:none; font:inherit; font-size:.76rem; line-height:1.4; color:var(--ink0)}
${R} #studioSearchBox .ico{color:var(--ink2)}
${R} #studioSearchBox kbd{height:auto; min-height:0; margin:0; font:inherit; font-size:.6rem; line-height:1.3;
  background:var(--bg3); border:1px solid var(--line); border-radius:4px; padding:1px 5px; color:var(--ink2)}
${R} .deptscroll{flex:1; overflow-y:auto; overflow-x:hidden; padding:16px 18px 24px;
  scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent}
${R} .stagePlaceholder{margin:auto; text-align:center; color:var(--ink2); font-size:.85rem; max-width:360px}
${R} .stagePlaceholder b{color:var(--ink1); display:block; margin-bottom:6px; font-size:1rem}
${R} summary{list-style:none}
${R} summary::-webkit-details-marker{display:none}
${IN} .msa-chev{display:inline-block; transition:transform 160ms var(--ease-out); opacity:.55}
/* \`> summary >\` and not a descendant selector — same trap diag/debug-panel-
   controls.js already documents: a descendant rule would rotate a NESTED
   details' own chevron just because an ANCESTOR details is open. */
${IN} details[open] > summary .msa-chev{transform:rotate(90deg)}

/* ---- effects department ------------------------------------------------------ */
/* The library: grouped tiles, every effect on one screen. */
${IN} .msa-libbar{display:flex; align-items:center; gap:8px; margin-bottom:4px}
${IN} .msa-libbar .msa-field{flex:1 1 auto}
${IN} .msa-lib{display:flex; flex-direction:column; gap:14px; margin:10px 0 18px}
${IN} .msa-libhead{display:flex; align-items:center; gap:7px; margin-bottom:6px;
  font-size:.7rem; font-weight:600; color:var(--ink1)}
${IN} .msa-libhead .ico{width:14px; height:14px; color:var(--acc, var(--ink2))}
${IN} .msa-libhead-count{margin-left:auto; font-weight:400; color:var(--ink2)}
${IN} .msa-libgrid{display:grid; gap:6px; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr))}
${IN} .msa-etile{display:flex; align-items:center; gap:6px; min-width:0; padding:0 8px 0 0;
  background:var(--bg1); border:1px solid var(--line); border-left:3px solid var(--acc, var(--shine));
  border-radius:var(--r-ctl); transition:border-color 120ms ease, background-color 120ms ease}
${IN} .msa-etile-open{flex:1; min-width:0; display:flex; align-items:center; justify-content:flex-start; gap:7px;
  height:32px; min-height:0; margin:0; padding:0 4px 0 8px; text-align:left; font:inherit; font-size:.76rem;
  color:var(--ink0); background:none; border:0; box-shadow:none; cursor:pointer}
${IN} .msa-etile-open:focus-visible{outline:2px solid var(--shine); outline-offset:-2px; border-radius:var(--r-ctl)}
${IN} .msa-etile-ico{display:inline-flex; flex:none; color:var(--acc, var(--shine))}
${IN} .msa-etile-ico .ico{width:14px; height:14px}
${IN} .msa-etile-name{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
${IN} .msa-etile-warn{display:inline-flex; flex:none; color:var(--warn)}
${IN} .msa-etile-warn .ico{width:13px; height:13px}
/* An off effect reads quieter, but its switch stays at full strength. */
${IN} .msa-etile[data-enabled="false"] .msa-etile-open{color:var(--ink2)}
${IN} .msa-etile[data-enabled="false"] .msa-etile-ico{opacity:.5}
${IN} .msa-resetall{display:flex; align-items:center; gap:10px; flex-wrap:wrap;
  padding:10px 12px; background:var(--bg1);
  border:1px solid var(--line); border-radius:var(--r-card)}
${IN} .msa-resetall .msa-btn{font-weight:600}
${IN} .msa-resetall-note{color:var(--ink2); font-size:.72rem}
${IN} .msa-empty{color:var(--ink2); font-size:.8rem; padding:20px}

/* The one open effect. The jump bar sticks to the top of the scroll area
   (which has 16px of padding, hence -16px) so every section is one press away. */
${IN} .msa-card--open{border-left-width:1px; border-top:3px solid var(--acc, var(--shine))}
${IN} .msa-card-crumb{color:var(--ink2); font-size:.64rem; letter-spacing:.06em}
${IN} .msa-back .ico{transform:rotate(180deg)}
${IN} .msa-prev .ico{transform:rotate(-90deg)}
${IN} .msa-next .ico{transform:rotate(90deg)}
${IN} .msa-jump{position:sticky; top:-16px; z-index:2; display:flex; flex-wrap:wrap; gap:5px;
  margin:0 -14px 0 -16px; padding:7px 14px 7px 16px; background:var(--bg1);
  border-top:1px solid var(--line); border-bottom:1px solid var(--line)}
${IN} .msa-jump .msa-chip{padding:2px 9px; font-size:.68rem}
${IN} .msa-section{scroll-margin-top:52px}
${IN} .msa-section-body{display:flex; flex-wrap:wrap; gap:4px}

${IN} .msa-card{position:relative; display:flex; flex-direction:column; gap:8px;
  padding:12px 14px 12px 16px; background:var(--bg1); border:1px solid var(--line);
  border-left:3px solid var(--acc, var(--shine)); border-radius:var(--r-card)}
/* A disabled effect dims its BODY, not its header: the switch that turns it
   back on must stay the loudest thing on the card. */
${IN} .msa-card > :not(.msa-card-head){transition:opacity 200ms ease}
${IN} .msa-card[data-enabled="false"] > :not(.msa-card-head){opacity:.55}
${IN} .msa-card-names{transition:opacity 200ms ease}
${IN} .msa-card[data-enabled="false"] .msa-card-names{opacity:.65}
${IN} .msa-card-head{display:flex; flex-direction:column; gap:5px}
${IN} .msa-card-top{display:flex; align-items:center; gap:8px}
${IN} .msa-card-ico{flex:0 0 auto; color:var(--acc, var(--shine)); display:inline-flex}
${IN} .msa-card-names{display:flex; flex-direction:column; line-height:1.2; min-width:0; flex:1 1 auto; overflow:hidden}
${IN} .msa-card-title{font-weight:700; font-size:.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
${IN} .msa-card-status{color:var(--ink2); font-size:.68rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
${IN} .msa-card-meta{display:flex; align-items:center; gap:6px; flex-wrap:wrap}
${IN} .msa-grow{flex:1}
${IN} .msa-maskrow{display:flex; align-items:center; gap:6px; font-size:.7rem; padding:5px 9px;
  border-radius:6px; color:var(--ok); background:color-mix(in oklab, var(--ok) 12%, transparent)}
${IN} .msa-maskrow[data-found="false"]{color:var(--fail); background:color-mix(in oklab, var(--fail) 10%, transparent)}
${IN} .msa-maskrow code{padding:0; border:0; background:none; font-family:var(--mono); font-size:.95em; color:inherit}
${IN} .msa-foh{display:flex; flex-wrap:wrap; gap:4px}
${IN} .msa-presetwrap{flex-basis:100%; display:flex; flex-direction:column; gap:6px}
${IN} .msa-presetrow{display:flex; gap:4px; align-items:center}
${IN} .msa-presetrow .msa-select{flex:1; min-width:0}
${IN} .msa-presetlist{display:flex; flex-direction:column; gap:2px; padding:4px; background:var(--bg2);
  border:1px solid var(--line); border-radius:var(--r-ctl); animation:msaFadeUp 160ms var(--ease-out) both}
${IN} .msa-presetitem{display:flex; align-items:center; gap:6px; padding:0 2px 0 6px; font-size:.72rem; color:var(--ink1)}
${IN} .msa-presetitem-name{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
/* A few rules above set \`display\` on things that also get the \`hidden\`
   attribute (search-filtered cards, a collapsed preset list, an empty status
   line); an author \`display\` beats the browser's own \`[hidden]\`, so say it again. */
${IN} [hidden]{display:none !important}
/* An armed (two-click confirm) icon button grows to fit its short label. */
${IN} .hbtn.is-armed{display:inline-flex; align-items:center; gap:5px; width:auto; padding:0 8px;
  font-size:.7rem; font-weight:600; color:var(--fail); background:color-mix(in oklab, var(--fail) 14%, transparent)}
${IN} .hbtn .msa-btn-ico{display:inline-flex}
/* copy button: three stacked icons that cross-fade (with a touch of blur, so
   two overlapping glyphs read as ONE thing changing) — fixed 15px box, so the
   button never changes width and nothing beside it moves */
${IN} .msa-swap{position:relative; display:grid; width:15px; height:15px}
${IN} .msa-swap-i{grid-area:1/1; display:grid; place-items:center; opacity:0; transform:scale(.25); filter:blur(4px);
  transition:opacity 200ms ease, transform 200ms var(--ease-out), filter 200ms ease}
${IN} .msa-copy[data-state="idle"] [data-for="idle"], ${IN} .msa-copy[data-state="done"] [data-for="done"],
${IN} .msa-copy[data-state="fail"] [data-for="fail"]{opacity:1; transform:none; filter:none}
${IN} .msa-copy[data-state="done"]{color:var(--ok)}
${IN} .msa-copy[data-state="fail"]{color:var(--fail)}
${IN} .msa-compose{display:flex; gap:6px; align-items:center; flex:1; min-width:0;
  animation:msaFadeUp 160ms var(--ease-out) both}
${IN} .msa-sec{font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink2);
  font-weight:600; margin:9px 0 3px}

/* ---- scene / painter / cues / lab -------------------------------------------- */
${IN} .msa-panel{display:flex; flex-direction:column; gap:8px; padding:11px 13px;
  background:var(--bg1); border:1px solid var(--line); border-radius:var(--r-card)}
${IN} .msa-panel--planned{border-style:dashed; border-color:var(--fail)}
${IN} .msa-panel-title{display:flex; align-items:center; gap:7px; margin:0; padding:0; border:0;
  font:600 .74rem/1.3 var(--font); letter-spacing:.1em; text-transform:uppercase; color:var(--ink2); text-shadow:none}
${IN} .msa-panel-tag{margin-left:auto; color:var(--fail); font-size:.68rem; font-weight:400;
  letter-spacing:0; text-transform:none}
${IN} .msa-note{margin:0; font-size:.72rem; line-height:1.45; color:var(--ink2)}
${IN} .msa-status{margin:0; min-height:1.4em; font-size:.7rem; color:var(--ink2); transition:color 160ms ease}
${IN} .msa-status[data-tone="ok"]{color:var(--ok)}
${IN} .msa-status[data-tone="fail"]{color:var(--fail)}
${IN} .msa-status[data-tone="warn"]{color:var(--warn)}
${IN} .msa-row-flex{display:flex; align-items:center; gap:6px}
${IN} .msa-masklist{display:flex; flex-wrap:wrap; gap:6px; font-size:.7rem}
${IN} .msa-masklist code{padding:0; border:0; background:none; font-family:var(--mono); color:inherit}

${IN} .msa-notice{background:var(--bg1); border:1px solid var(--line); border-radius:var(--r-card);
  padding:10px 12px; font-size:.74rem; line-height:1.5; color:var(--ink2)}
${IN} .msa-notice b{color:var(--ink1)}
${IN} .msa-notice b.warn{color:var(--warn)}
${IN} .msa-tile{display:flex; flex-direction:column; align-items:flex-start; justify-content:flex-start;
  gap:6px; height:auto; text-align:left; padding:12px 14px; background:var(--bg1);
  border:1px solid var(--line); border-radius:var(--r-card); color:var(--ink0)}
${IN} .msa-tile-head{display:flex; align-items:center; gap:8px; font-weight:650; font-size:.86rem}
${IN} .msa-tile-suffix{font-size:.7rem; color:var(--ink2)}
${IN} .msa-tile-reach{font-size:.68rem; line-height:1.4; color:var(--warn)}
${IN} .msa-tile-reach[data-reach="renders"]{color:var(--ink1)}
${IN} .msa-tile-status{display:flex; align-items:center; gap:5px; font-size:.68rem; color:var(--ink2)}
${IN} .msa-tile-status[data-tone="ok"]{color:var(--ok)}
${IN} .msa-tile-status[data-tone="warn"]{color:var(--warn)}

${IN} .msa-cues{display:flex; flex-direction:column; gap:10px; max-width:760px}
${IN} .msa-cue{display:flex; align-items:center; gap:10px; padding:8px 12px; background:var(--bg1);
  border:1px solid var(--line); border-radius:var(--r-card)}
${IN} .msa-cue-order{display:flex; flex-direction:column; gap:1px; flex:none}
${IN} .msa-cue-order .hbtn{width:22px; height:18px}
${IN} .msa-cue-order .hbtn .ico{width:12px; height:12px}
${IN} .msa-cue-up .ico{transform:rotate(-90deg)}
${IN} .msa-cue-down .ico{transform:rotate(90deg)}
${IN} .msa-cue-num{width:26px; height:26px; border-radius:50%; background:var(--bg2); display:grid;
  place-items:center; font-size:.72rem; color:var(--ink2); flex:none}
${IN} .msa-cue-info{flex:1; min-width:0}
${IN} .msa-cue .msa-select{flex:none}
${IN} .msa-cue-name{display:block; font-weight:600; font-size:.8rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
${IN} .msa-cue-glyphs{display:flex; align-items:center; gap:5px; color:var(--ink2); margin-top:2px}
${IN} .msa-cue-warn{color:var(--fail); font-size:.78rem}
${IN} .msa-cue-curve{font-size:.66rem; color:var(--ink2); flex:none}
${IN} .msa-testbar{display:flex; align-items:center; gap:8px; padding:6px 10px; font-size:.72rem;
  color:var(--ink1); background:var(--bg2); border:1px solid var(--shine); border-radius:8px}
${IN} .msa-testbar .ico{color:var(--shine)}
${IN} .msa-sep{border-top:1px solid var(--line); margin:4px 0}
${IN} .msa-eyebrow{margin-top:4px; font-size:.68rem; letter-spacing:.1em; text-transform:uppercase; color:var(--ink2)}
${IN} .msa-banner{display:flex; gap:8px; align-items:center; padding:8px 10px; margin-bottom:10px;
  background:var(--bg2); border:1px solid var(--line); border-radius:var(--r-card); font-size:.72rem; color:var(--ink1)}
${IN} .msa-banner--quiet{padding:6px 10px; color:var(--ink2)}
${IN} .msa-system{display:flex; flex-direction:column; gap:9px; max-width:520px}
${IN} .msa-sechead{margin-top:6px; font-size:.64rem; letter-spacing:.14em; text-transform:uppercase; color:var(--ink2)}
${IN} .msa-pending{display:flex; align-items:center; gap:8px; font-size:.72rem; color:var(--ink1)}
${IN} .msa-pending span{flex:1}

/* ---- hover: only where hover exists --------------------------------------------
   Gated so a tap on a touch screen never leaves a stuck hover state. */
${HOVER_GATE}{
${uiKitHoverCss(IN)}
  ${IN} .msa-etile:hover{background:var(--bg2); border-color:var(--line-strong)}
  ${IN} .msa-tile:hover{background:var(--bg2); border-color:var(--line-strong)}
  ${RAIL}:hover{background:var(--bg3); color:var(--ink0)}
  ${R} .rail button[aria-pressed="true"]:hover{background:color-mix(in oklab, currentColor 18%, transparent)}
}
`.trim();
}
