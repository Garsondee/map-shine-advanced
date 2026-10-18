/**
 * ui/rooms/studio/studio-style.js — the Studio's whole stylesheet, in one place.
 *
 * Moved out of `shell.js` (where the first version was a ~60-line port of the
 * mock's room/rail/head rules) when the polish pass of 2026-10-18 turned it
 * into a small design system: a press/hover/focus model every control shares,
 * a real switch, slider fill, and the motion. One stylesheet means one place
 * to read what "a button in the Studio" does, instead of that knowledge being
 * scattered across inline `Object.assign(el.style, ...)` blocks in six
 * department files — inline styles cannot express `:hover`, `:active` or
 * `:focus-visible` at all, which is why nothing in the panel used to respond
 * to a press.
 *
 * ============================================================================
 * ⚠️ THE FOUNDRY PROBLEM THIS SHEET HAS TO WIN, ON PURPOSE
 * ============================================================================
 * This room lives inside Foundry's page, and Foundry's core stylesheet styles
 * every bare `button`, `input`, `select`, `h2`, `kbd` and `input[type=range]`.
 * Measured in the preview harness with the real `foundry2.css` loaded:
 *  - `button{height:2em; min-height:2em; transition:0.5s; padding:0 .5rem;
 *    border:1px solid <brown>; background:<translucent>}` — so a 28px switch
 *    rendered as a CIRCLE (min-height beat its 16px), every 24px header
 *    button was really 24×28, and every state change took half a second;
 *  - `button:hover{background:<orange-red>}` and `button:focus{outline+glow}` —
 *    hover turned unstyled buttons orange, and a plain mouse click left a
 *    glowing focus ring behind;
 *  - `h2` is set in a serif display face, the range input is a dark 4px track
 *    with no fill, and a checkbox is a Font Awesome glyph.
 * All of Foundry's rules sit inside `@layer`s; ANY unlayered rule beats ANY
 * layered one regardless of specificity, which is why this sheet can win with
 * plain class selectors and never needs `!important` against Foundry itself.
 * The few `!important`s below are against INLINE styles from `param-control.js`
 * (shared with the old debug panel, which relies on them as its fallback look),
 * and say so where they appear.
 *
 * ============================================================================
 * THE MOTION RULES (Emil Kowalski's design-engineering rules, applied)
 * ============================================================================
 *  - Frequency decides. Keyboard-opened things (the search palette) and things
 *    used hundreds of times a day (department switching, slider drags) do not
 *    animate; occasional things (opening the room, a pop-out, a switch) do.
 *  - Press feedback on everything pressable: `scale(.97)`, 160ms, ease-out.
 *  - Only `transform` and `opacity` move; colour changes are short (120ms).
 *    Never `transition: all`.
 *  - Strong custom curves (`--ease-out`, tokens.js), never the built-ins, and
 *    never ease-in on UI.
 *  - Enter slower than exit; popovers scale from where they came from; nothing
 *    scales from 0 (start at .96–.985 plus opacity).
 *  - Hover effects are gated behind `(hover:hover) and (pointer:fine)` so a tap
 *    on a touch screen never leaves a stuck hover state.
 *  - Reduced motion is handled once, globally, by `ui/tokens.js`'s BASE_CSS.
 *
 * @module ui/rooms/studio/studio-style
 */

/** Class on a detached pop-out window so the shared component rules reach it. */
export const POPOUT_CLASS = 'msa-studio-pop';

/**
 * @param {string} roomId - the room element's id (no `#`).
 * @param {string[]} accentVars - the distinct `--c-*` tokens the rail uses.
 * @returns {string} the full stylesheet text.
 */
export function studioCss(roomId, accentVars) {
  const R = `#${roomId}`;
  // Both the room and any detached pop-out window.
  const IN = `:is(${R}, .${POPOUT_CLASS})`;
  // Everything that is pressed — one reset, one focus ring, one press response.
  const PRESS = `${IN} :is(.msa-btn, .hbtn, .msa-chip, .msa-tile, .msa-switch, .msa-badge--action, .msa-link)`;
  const RAIL = `${R} .rail button`;

  return `
/* ---- the room ------------------------------------------------------------ */
${R}{top:44px; left:24px; width:1180px; height:800px;
  max-width:calc(100vw - 460px); max-height:calc(100vh - 60px);
  min-width:760px; min-height:520px; resize:both;
  position:fixed; z-index:100; background:var(--glass);
  backdrop-filter:blur(var(--glass-blur));
  border:1px solid var(--line); border-radius:var(--r-room);
  box-shadow:var(--shadow3); display:flex; flex-direction:column; overflow:hidden;
  font:12px/1.4 var(--font); color:var(--ink0); transform-origin:0 0}
/* Opened by a mouse click on the toolbar: an occasional action, so it gets a
   short entrance (ease-out, 200ms, from .985 — never from 0). Closing is
   instant: the system should be fastest when it is the one responding. */
${R}.msa-enter{animation:msaRoomIn 200ms var(--ease-out) both}
@keyframes msaRoomIn{from{opacity:0; transform:translateY(8px) scale(.985)}}
@keyframes msaPopIn{from{opacity:0; transform:scale(.96)}}
@keyframes msaFadeUp{from{opacity:0; transform:translateY(4px)}}

${R} .room-head{display:flex; align-items:center; gap:var(--sp2);
  padding:8px 14px; border-bottom:1px solid var(--line); cursor:grab; user-select:none; flex:none}
${R} .room-head:active{cursor:grabbing}
${R} .rtitle{font-weight:600; letter-spacing:.14em; font-size:.72rem;
  color:var(--ink1); text-transform:uppercase; display:flex; gap:8px; align-items:center}
${R} .rtitle .ico{color:var(--shine)}
${R} .spacer{flex:1}
${R} .frame{display:flex; flex:1; min-height:0}

/* ---- the press model: every pressable thing, one reset ------------------- */
${PRESS}, ${RAIL}{
  /* height:auto — Foundry's button rule is \`height:2em\`, i.e. twice THIS
     button's own font-size, which is a different height for every size of text
     we put in one. Components that need a fixed size set their own below. */
  box-sizing:border-box; height:auto; min-height:0; margin:0; font:inherit; line-height:1.2;
  letter-spacing:normal; text-transform:none; text-decoration:none; text-shadow:none;
  box-shadow:none; outline:none; cursor:pointer; pointer-events:auto; user-select:none;
  -webkit-tap-highlight-color:transparent; touch-action:manipulation;
  transition:transform 160ms var(--ease-out), background-color 120ms ease, border-color 120ms ease,
    color 120ms ease, opacity 120ms ease}
${PRESS}:focus-visible, ${RAIL}:focus-visible{outline:2px solid var(--shine); outline-offset:2px}
${PRESS}:active:not(:disabled), ${RAIL}:active:not(:disabled){transform:scale(.97)}
${PRESS}:disabled, ${RAIL}:disabled{cursor:default; opacity:.45}

/* icon-only tool button (header close, card tools, cue arrows) */
${IN} .hbtn{width:24px; height:24px; display:grid; place-items:center; padding:0;
  border:0; border-radius:6px; background:transparent; color:var(--ink2)}
${IN} .hbtn .ico{width:15px; height:15px}
${IN} .hbtn[aria-pressed="true"]{color:var(--acc, var(--shine))}
${IN} .hbtn.msa-planned{border:1px dashed var(--fail); color:var(--fail)}

/* labelled button */
${IN} .msa-btn{display:inline-flex; align-items:center; justify-content:center; gap:6px;
  padding:5px 11px; border-radius:var(--r-ctl); border:1px solid var(--line);
  background:var(--bg2); color:var(--ink1); font-size:.72rem; font-weight:600; white-space:nowrap; flex:none}
${IN} .msa-btn .ico{width:13px; height:13px}
${IN} .msa-btn-ico{display:inline-flex}
${IN} .msa-btn--sm{padding:3px 9px; font-size:.7rem}
${IN} .msa-btn--gold{border-color:var(--shine); background:color-mix(in oklab, var(--shine) 18%, var(--bg2)); color:var(--shine)}
${IN} .msa-btn.is-armed, ${IN} .msa-btn--danger{border-color:var(--fail); color:var(--fail);
  background:color-mix(in oklab, var(--fail) 14%, var(--bg2))}
${IN} .msa-btn.msa-planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}

/* filter chip — accent comes from the chip's own --acc */
${IN} .msa-chip{padding:4px 11px; border-radius:999px; border:1px solid var(--line);
  background:var(--bg2); color:var(--ink1); font-size:.72rem}
${IN} .msa-chip[aria-pressed="true"]{border-color:var(--acc, var(--shine));
  background:color-mix(in oklab, var(--acc, var(--shine)) 16%, transparent); color:var(--acc, var(--shine))}

/* inline text link ("Paint one") */
${IN} .msa-link{margin-left:auto; padding:2px 4px; border:0; background:none; color:inherit;
  text-decoration:underline; text-underline-offset:2px; font-size:inherit}

/* small status badge (health / tier / scope) */
${IN} .msa-badge{display:inline-flex; align-items:center; gap:3px; padding:1px 7px;
  border-radius:999px; font-size:10px; line-height:1.6; border:1px solid var(--line);
  background:transparent; color:var(--ink2); flex:none; white-space:nowrap}
${IN} .msa-badge--planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}
${IN} .msa-badge--warn{border-color:var(--warn); color:var(--warn)}

/* ---- the enable switch ---------------------------------------------------
   One real switch: a 30×18 track, a 12px thumb that SLIDES (translateX, the
   only property that moves) and a track that changes colour. The card re-
   renders on every toggle, so effects-department.js builds the new switch in
   its PREVIOUS state and flips it a frame later — that is what lets this
   transition run at all on a freshly built element. */
${IN} .msa-switch{position:relative; width:30px; height:18px; flex:none; padding:0;
  border-radius:999px; border:1px solid var(--line-strong); background:var(--bg3)}
${IN} .msa-switch::after{content:""; position:absolute; top:2px; left:2px; width:12px; height:12px;
  border-radius:50%; background:var(--ink2);
  transition:transform 200ms var(--ease-out), background-color 160ms ease}
${IN} .msa-switch[aria-checked="true"]{background:var(--ok); border-color:transparent}
${IN} .msa-switch[aria-checked="true"]::after{transform:translateX(12px); background:#0d1016}

/* the same switch, for a boolean PARAM (a native checkbox underneath, so
   keyboard, label-click and form semantics all stay the browser's). Foundry
   draws checkboxes as Font Awesome glyphs through ::before/::after — both are
   replaced outright here. */
${IN} input.msa-switch-input{-webkit-appearance:none; appearance:none; position:relative; flex:none;
  width:30px; height:18px; margin:0; padding:0; border-radius:999px;
  border:1px solid var(--line-strong); background:var(--bg3); cursor:pointer;
  transition:background-color 160ms ease, border-color 160ms ease}
${IN} input.msa-switch-input::before{content:""; position:absolute; top:2px; left:2px;
  width:12px; height:12px; border-radius:50%; background:var(--ink2); outline:0; font-size:0;
  transition:transform 200ms var(--ease-out), background-color 160ms ease}
${IN} input.msa-switch-input::after{content:none}
${IN} input.msa-switch-input:checked{background:var(--shine); border-color:transparent}
${IN} input.msa-switch-input:checked::before{transform:translateX(12px); background:var(--bg0)}
${IN} input.msa-switch-input:focus-visible{outline:2px solid var(--shine); outline-offset:2px}
/* a switch sits at the row's right edge, in line with the selects/sliders
   beside it, rather than hugging the end of its label */
${IN} .msa-row input.msa-switch-input{margin-left:auto}

/* ---- fields ---------------------------------------------------------------- */
/* width:auto — Foundry's own \`select{width:100%}\` otherwise makes every dropdown
   swallow its whole flex row (the cue row's fade-time select squeezed the cue's
   NAME to nothing). Rows that WANT a stretching field say so with flex:1. */
${IN} .msa-input, ${IN} .msa-select, ${IN} .msa-effect-preset-select{
  width:auto; max-width:100%; height:26px; padding:0 8px; background:var(--bg2); color:var(--ink0);
  border:1px solid var(--line); border-radius:var(--r-ctl); font:inherit; font-size:.72rem;
  outline:none; box-shadow:none; transition:border-color 120ms ease, box-shadow 120ms ease}
${IN} .msa-input{flex:1; min-width:0; cursor:text}
${IN} .msa-input::placeholder{color:var(--ink2)}
${IN} .msa-select, ${IN} .msa-effect-preset-select{cursor:pointer}
${IN} .msa-input:focus, ${IN} .msa-select:focus, ${IN} .msa-effect-preset-select:focus{
  border-color:var(--shine); box-shadow:0 0 0 3px var(--shine-soft)}
${IN} .msa-input[aria-invalid="true"]{border-color:var(--fail);
  box-shadow:0 0 0 3px color-mix(in oklab, var(--fail) 22%, transparent)}
/* param-control.js builds its own <select> with INLINE colours (the old debug
   panel's fallback look). !important is the contained way to re-skin it here
   without forking the widget the old panel still depends on. */
${IN} .msa-row .msa-select{background:var(--bg2) !important; color:var(--ink0) !important;
  border:1px solid var(--line) !important; border-radius:var(--r-ctl) !important;
  font:inherit !important; font-size:.72rem !important; padding:0 6px !important}
${IN} .msa-row .msa-select:focus{border-color:var(--shine) !important}
${IN} .msa-color{width:36px !important; height:20px !important; padding:0 !important;
  border:1px solid var(--line-strong) !important; border-radius:5px !important; background:none !important; cursor:pointer}
${IN} .msa-color::-webkit-color-swatch-wrapper{padding:0}
${IN} .msa-color::-webkit-color-swatch{border:0; border-radius:4px}

/* a search/filter field: the wrapper owns the border and the focus ring */
${IN} .msa-field{flex-basis:100%; display:flex; align-items:center; gap:6px; height:28px;
  padding:0 10px; background:var(--bg2); border:1px solid var(--line); border-radius:var(--r-ctl);
  transition:border-color 120ms ease, box-shadow 120ms ease}
${IN} .msa-field:focus-within{border-color:var(--shine); box-shadow:0 0 0 3px var(--shine-soft)}
${IN} .msa-field .ico{color:var(--ink2); width:12px; height:12px; flex:none}
${IN} .msa-field input{flex:1; min-width:0; height:auto; padding:0; background:none; border:none;
  outline:none; box-shadow:none; font:inherit; font-size:.74rem; line-height:1.4; color:var(--ink0)}

/* ---- parameter rows & sliders ----------------------------------------------
   Rows come from ui/widgets/param-control.js with inline styles that the old
   debug panel still relies on; the Studio sets its own type scale on top
   (!important beats inline) — slightly larger than the panel's 10.5px, and in
   the LANTERN face rather than the old panel's Signika. */
${IN} .msa-row{font-size:11.5px !important; font-family:inherit !important; line-height:1.3 !important; min-height:22px}
${IN} input.msa-range{-webkit-appearance:none; appearance:none; height:20px; margin:0; padding:0;
  border:0; background:transparent; cursor:pointer; --p:0}
/* The track is a gradient whose hard stop follows --p (0..1, written by
   param-control.js#paintFill) — offset by half a thumb each end so the fill
   meets the thumb's CENTRE at every value, not its edge. */
${IN} .msa-range::-webkit-slider-runnable-track{height:4px; border:0; border-radius:999px;
  box-shadow:inset 0 0 0 1px var(--line);
  background:linear-gradient(to right, var(--shine) calc(6px + (100% - 12px) * var(--p)),
    var(--bg3) calc(6px + (100% - 12px) * var(--p)))}
${IN} .msa-range::-webkit-slider-thumb{-webkit-appearance:none; appearance:none; box-sizing:border-box;
  width:12px; height:12px; margin-top:-4px; border-radius:50%; background:var(--ink0);
  border:2px solid var(--shine); box-shadow:0 1px 3px rgba(0,0,0,.45);
  transition:transform 120ms var(--ease-out), box-shadow 120ms ease}
${IN} .msa-range::-moz-range-track{height:4px; border:0; border-radius:999px; background:var(--bg3);
  box-shadow:inset 0 0 0 1px var(--line)}
${IN} .msa-range::-moz-range-progress{height:4px; border-radius:999px; background:var(--shine)}
${IN} .msa-range::-moz-range-thumb{box-sizing:border-box; width:12px; height:12px; border-radius:50%;
  background:var(--ink0); border:2px solid var(--shine); box-shadow:0 1px 3px rgba(0,0,0,.45)}
${IN} .msa-range:active::-webkit-slider-thumb{transform:scale(1.2)}
${IN} .msa-range:focus-visible{outline:none}
${IN} .msa-range:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px var(--shine-soft), 0 1px 3px rgba(0,0,0,.45)}

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
${IN} .msa-strip{display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px}
${IN} .msa-grid{display:grid; gap:12px; align-content:start; align-items:start;
  grid-template-columns:repeat(2, minmax(0, 1fr))}
${IN} .msa-empty{color:var(--ink2); font-size:.8rem; padding:20px}

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
${IN} .msa-adv{border:1px solid var(--line); border-radius:7px; background:var(--bg2)}
${IN} .msa-adv-sum{display:flex; align-items:center; gap:6px; padding:6px 9px; border-radius:7px;
  cursor:pointer; user-select:none; font-size:.7rem; font-weight:600; color:var(--ink1);
  transition:color 120ms ease, background-color 120ms ease}
${IN} .msa-adv[open] > .msa-adv-sum{border-bottom-left-radius:0; border-bottom-right-radius:0}
${IN} .msa-adv-body{display:flex; flex-direction:column; padding:2px 9px 9px;
  animation:msaFadeUp 180ms var(--ease-out) both}
${IN} .msa-adv-group{display:flex; flex-wrap:wrap; gap:4px}
${IN} .msa-sec{font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink2);
  font-weight:600; margin:9px 0 3px}

/* ---- pop-out windows ----------------------------------------------------------- */
.${POPOUT_CLASS}{position:fixed; width:360px; max-height:70vh; overflow-y:auto; z-index:400;
  padding:10px; background:var(--glass); backdrop-filter:blur(var(--glass-blur));
  border:1px solid var(--line-strong); border-radius:var(--r-room); box-shadow:var(--shadow3);
  font:12px/1.4 var(--font); color:var(--ink0); scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent;
  transform-origin:var(--ox, 0) var(--oy, 0); animation:msaPopIn 160ms var(--ease-out) both}
.${POPOUT_CLASS} .msa-pop-head{display:flex; align-items:center; gap:8px; margin-bottom:6px}
.${POPOUT_CLASS} .msa-pop-title{font-weight:700; font-size:.8rem; color:var(--ink0); flex:1}

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
@media (hover:hover) and (pointer:fine){
  ${IN} .hbtn:hover{background:var(--bg3); color:var(--ink0)}
  ${IN} .hbtn[aria-pressed="true"]:hover{color:var(--acc, var(--shine))}
  ${IN} .msa-btn:hover{background:var(--bg3); border-color:var(--line-strong); color:var(--ink0)}
  ${IN} .msa-btn--gold:hover{background:color-mix(in oklab, var(--shine) 28%, var(--bg2)); color:var(--shine)}
  ${IN} .msa-btn.is-armed:hover, ${IN} .msa-btn--danger:hover{border-color:var(--fail); color:var(--fail);
    background:color-mix(in oklab, var(--fail) 22%, var(--bg2))}
  ${IN} .msa-chip:hover{border-color:var(--line-strong); color:var(--ink0)}
  ${IN} .msa-chip[aria-pressed="true"]:hover{color:var(--acc, var(--shine))}
  ${IN} .msa-switch:hover{border-color:var(--ink2)}
  ${IN} input.msa-switch-input:hover{border-color:var(--ink2)}
  ${IN} .msa-select:hover, ${IN} .msa-effect-preset-select:hover, ${IN} .msa-input:hover{border-color:var(--line-strong)}
  ${IN} .msa-row .msa-select:hover{border-color:var(--line-strong) !important}
  ${IN} .msa-range:hover::-webkit-slider-thumb{transform:scale(1.15)}
  ${IN} .msa-range:active:hover::-webkit-slider-thumb{transform:scale(1.2)}
  ${IN} .msa-badge--action:hover{background:var(--bg3); color:var(--ink0)}
  ${IN} .msa-link:hover{opacity:.75}
  ${IN} .msa-adv-sum:hover{color:var(--ink0); background:var(--bg3)}
  ${IN} .msa-tile:hover{background:var(--bg2); border-color:var(--line-strong)}
  ${RAIL}:hover{background:var(--bg3); color:var(--ink0)}
  ${R} .rail button[aria-pressed="true"]:hover{background:color-mix(in oklab, currentColor 18%, transparent)}
}
`.trim();
}
