/**
 * ui/rooms/room-style.js — the press / hover / focus model and the component
 * vocabulary every room shares: the Studio, the Remote, the Player room and the
 * popovers that hang off them.
 *
 * It began as the first half of `studio/studio-style.js` (the Studio polish pass
 * of 2026-10-18) and moved here when the Remote and Player room got the same
 * pass: one stylesheet function, scoped per room, so "what a button does in a
 * Map Shine room" is read in one place instead of three rooms drifting apart.
 * Each room calls {@link uiKitCss} with its own scope, adds its own pressables,
 * then writes only what is genuinely its own (layout, the astrolabe, the rail).
 *
 * ============================================================================
 * ⚠️ THE FOUNDRY PROBLEM THIS SHEET HAS TO WIN, ON PURPOSE
 * ============================================================================
 * These rooms live inside Foundry's page, and Foundry's core stylesheet styles
 * every bare `button`, `input`, `select`, `h2`, `kbd` and `input[type=range]`.
 * Measured in the preview harnesses with the real `foundry2.css` loaded
 * (`?foundry=`, tools/preview-shared/page-setup.js; `control-audit.js` lists it):
 *  - `button{height:2em; min-height:2em; transition:0.5s; padding:0 .5rem;
 *    border:1px solid <brown>; background:<translucent>}` — so a 28px switch
 *    rendered as a CIRCLE (min-height beat its 16px), every 26px header button
 *    was really 26×28, the debug accordion's 20px chevron 20×28, and every state
 *    change took half a second;
 *  - `button:hover{background:<orange-red>}` and `button:focus{outline+glow}` —
 *    hover turned unstyled buttons orange, and a plain mouse click left a
 *    glowing focus ring behind;
 *  - `h2`/`h4` are set in a serif display face, the range input is a dark 4px
 *    track with no fill, a checkbox is a Font Awesome glyph (an orange pair of
 *    boxes), and `select{width:100%; height:2rem}`.
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
 *  - Frequency decides. Keyboard-opened things and things used hundreds of
 *    times a day (department switching, slider drags, a fader) do not animate;
 *    occasional things (opening a room, a popover, a switch) do.
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
 * The press model itself (the reset, the focus ring, the press scale) is
 * `widgets/press-model.js#pressModelCss`, because the scale strip — a standalone
 * widget — needs it without a room; this file composes it with everything else.
 *
 * @module ui/rooms/room-style
 */

import { HOVER_GATE, pressModelCss } from '../widgets/press-model.js';

/** The at-rule every hover rule lives inside — hover only where hover exists. */
export { HOVER_GATE };

/**
 * The three entrance keyframes every room's motion is built from. A room
 * (`.msa-enter`), a popover or menu (`msaPopIn`, scaled out of its own trigger via
 * `transform-origin`) and a revealed section (`msaFadeUp`) — none starts from 0,
 * all are short, all use `--ease-out`. Defined once here because @keyframes names
 * are global to the page: three rooms each carrying their own copy is how two
 * copies drift.
 */
export const MOTION_KEYFRAMES = `@keyframes msaRoomIn{from{opacity:0; transform:translateY(8px) scale(.985)}}
@keyframes msaPopIn{from{opacity:0; transform:scale(.96)}}
@keyframes msaFadeUp{from{opacity:0; transform:translateY(4px)}}`;

/**
 * Restart the CSS animation a class starts (the room/popover entrance): drop the
 * class, force a reflow so the browser forgets the old run, add it back. Without the
 * reflow the second `add` is a no-op and the entrance only ever plays once.
 * @param {{classList: {add: (c: string) => void, remove: (c: string) => void}, offsetWidth: number}} el
 * @param {string} className
 */
export function replayClass(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

/**
 * The pressable classes the kit itself styles. A room adds its own through
 * `pressInside` (selectors relative to the room) or `pressAfter` (absolute).
 */
export const BASE_PRESSABLES = Object.freeze([
  '.msa-btn',
  '.hbtn',
  '.msa-chip',
  '.msa-tile',
  '.msa-switch',
  '.msa-badge--action',
  '.msa-link',
]);

/**
 * The shared component stylesheet: the press model, icon/labelled buttons,
 * chips, links, badges, both switches, fields, parameter rows and slider fill.
 * @param {string} IN - selector for "inside this room" — e.g. `:is(#msa-studio, .msa-studio-pop)`.
 *   Everything below is scoped under it.
 * @param {{pressInside?: string[], pressAfter?: string[]}} [opts]
 *   `pressInside` — extra pressable selectors RELATIVE to `IN` (they join the `:is(...)` list);
 *   `pressAfter` — extra pressable selectors that are already complete (the Studio's rail).
 * @returns {string}
 */
export function uiKitCss(IN, { pressInside = [], pressAfter = [] } = {}) {
  // Everything that is pressed — one reset, one focus ring, one press response.
  const PRESS = `${IN} :is(${[...BASE_PRESSABLES, ...pressInside].join(', ')})`;

  return `
${pressModelCss([PRESS, ...pressAfter])}

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
`.trim();
}

/**
 * The weather-style toggle chip: one pill per choice, lit when it IS the current
 * one, dashed while it is the one being faded TOWARD. Shared by the Remote's weather
 * board (and the GM's Player Lights board) and the Player room's carried-light
 * picker, which reuse one vocabulary rather than invent a third toggle language
 * (mythica-machina-press#77). Layout — padding, grid or flex, ellipsis — stays
 * with each room; this is only what a chip LOOKS like. Add the class to the
 * room's press group (`pressInside: ['.msa-wx-chip']`).
 * @param {string} R - the room's own selector (e.g. `#msa-remote`).
 * @returns {string}
 */
export function wxChipCss(R) {
  return `${R} .msa-wx-chip{border-radius:999px; border:1px solid var(--line); background:var(--bg2);
  color:var(--ink1); font-size:.68rem}
${R} .msa-wx-chip[aria-pressed="true"]{background:color-mix(in oklab, var(--shine) 18%, transparent);
  border-color:var(--shine); color:var(--shine)}
/* The fade TARGET, distinct from "this IS the sky" above (2026-08-18 — author: "mood
   buttons don't work yet"; the whole row went dark for the entire fade with no sign a
   click landed). Static: no animation, per the author's own "it's distracting" note. */
${R} .msa-wx-chip[data-pending="true"]{background:color-mix(in oklab, var(--shine) 8%, transparent);
  border-color:var(--shine); border-style:dashed; color:var(--ink0)}`;
}

/**
 * The chip's hover rules, for INSIDE the hover gate. A lit chip keeps its look under
 * the pointer (a slightly stronger tint, not a different colour), and a pending one
 * keeps its dashed tint.
 * @param {string} R
 * @returns {string}
 */
export function wxChipHoverCss(R) {
  return `  ${R} .msa-wx-chip:not([aria-pressed="true"]):not([data-pending="true"]):hover{background:var(--bg3)}
  ${R} .msa-wx-chip[aria-pressed="true"]:hover{background:color-mix(in oklab, var(--shine) 26%, transparent)}`;
}

/**
 * The kit's hover rules, to be placed INSIDE `@media (hover:hover) and (pointer:fine){ ... }`
 * (see {@link HOVER_GATE}) — never outside it, so a tap on a touch screen cannot leave
 * a stuck hover state.
 * @param {string} IN - the same room selector given to {@link uiKitCss}.
 * @returns {string}
 */
export function uiKitHoverCss(IN) {
  return `  ${IN} .hbtn:hover{background:var(--bg3); color:var(--ink0)}
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
  ${IN} .msa-link:hover{opacity:.75}`;
}
