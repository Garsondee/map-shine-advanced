/**
 * ui/rooms/guide/guide-style.js — the Guide room's stylesheet.
 *
 * Built on the shared room kit (room-style.js) like the Remote and the Studio, and
 * held to the same battery (ui/__tests__/room-style.test.mjs). The reading surface
 * is tuned for one thing first: readability (Ingram 2026-11-07, "focus on
 * readability"). Body text is 15px at 1.62 line height in a ~68-character column;
 * headings are short and strong; images run to the column's full width.
 *
 * Two widths: a compact side panel (Quick Fixes in a session — the map stays in
 * view beside it) and a wide reading view (Learn, with large map images).
 *
 * @module ui/rooms/guide/guide-style
 */

import { HOVER_GATE, MOTION_KEYFRAMES, uiKitCss, uiKitHoverCss } from '../room-style.js';

export const GUIDE_ROOM_ID = 'msa-guide';
export const GUIDE_TOOLTIP_SCOPE = `#${GUIDE_ROOM_ID}`;

/** The Guide's own pressables (single classes — the room kit's specificity contract). */
export const GUIDE_PRESSABLES = Object.freeze([
  '.g-half', // Quick Fixes / Learn
  '.g-card', // a tile on a hub page
  '.g-act', // a page's action button
  '.g-undo', // a result's Undo
  '.g-nav-btn', // back / previous / next
  '.g-hit', // a search result
  '.g-toc-link', // the wide view's page list
  '.g-look', // a Look button
]);

/** @returns {string} */
export function guideCss() {
  const R = `#${GUIDE_ROOM_ID}`;
  const IN = R;
  return `
${MOTION_KEYFRAMES}

/* ---- the room: a panel on the right, the map stays in view on the left ---------- */
${R}{position:fixed; top:16px; right:16px; bottom:16px; width:min(620px, calc(100vw - 32px));
  z-index:100; font:14px/1.5 var(--font); color:var(--ink0); display:flex}
${R}[data-wide="true"]{width:min(1240px, calc(100vw - 32px))}
/* an author display outranks the browser's own [hidden] rule, so the root says it itself */
${R}[hidden]{display:none !important}
${R} .g-scroll, ${R} .g-toc{scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent}
${R} .g-card-room{flex:1; min-width:0; display:flex; flex-direction:column; overflow:hidden;
  background:var(--bg1); border:1px solid var(--line-strong); border-radius:var(--r-room); box-shadow:var(--shadow3)}
${R} .g-card-room.msa-enter{animation:msaRoomIn 200ms var(--ease-out) both}

${uiKitCss(IN, { pressInside: GUIDE_PRESSABLES })}

/* ---- header ------------------------------------------------------------------- */
${R} .g-head{display:flex; align-items:center; gap:10px; padding:10px 12px 10px 16px;
  background:var(--bg0); border-bottom:1px solid var(--line)}
${R} .g-brand{display:flex; align-items:center; gap:8px; font-weight:700; font-size:15px; letter-spacing:.01em; white-space:nowrap}
${R} .g-brand .ico{width:20px; height:20px; color:var(--shine)}
${R} .g-brand small{font-weight:500; color:var(--ink2); font-size:12px}
${R} .g-spacer{flex:1}
${R} .g-search{width:180px; padding:6px 10px; border-radius:999px; border:1px solid var(--line-strong);
  background:var(--bg2); color:var(--ink0); font:13px var(--font)}
${R} .g-search::placeholder{color:var(--ink2)}
${R}[data-wide="false"] .g-search{width:130px}

/* the two halves — big, obvious, one tap */
${R} .g-halves{display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:10px 12px; background:var(--bg0);
  border-bottom:1px solid var(--line)}
${R} .g-half{display:flex; align-items:center; gap:10px; padding:10px 14px; border-radius:12px; text-align:left;
  border:1px solid var(--line); background:var(--bg2); color:var(--ink1); cursor:pointer}
${R} .g-half .ico{width:22px; height:22px; flex:none}
${R} .g-half b{display:block; font-size:15px; color:var(--ink0)}
${R} .g-half span span{display:block; font-size:12px; color:var(--ink2); line-height:1.3}
${R} .g-half[aria-pressed="true"]{border-color:var(--shine); background:var(--shine-soft); color:var(--shine)}
${R} .g-half[data-half="fixes"] .ico{color:#ff9e5e}
${R} .g-half[data-half="learn"] .ico{color:#7cc4ff}

/* breadcrumb strip */
${R} .g-crumbs{display:flex; align-items:center; gap:8px; padding:8px 16px; border-bottom:1px solid var(--line);
  font-size:12.5px; color:var(--ink2); min-height:38px}
${R} .g-crumbs[hidden]{display:none}
${R} .g-nav-btn{display:inline-flex; align-items:center; gap:6px; padding:5px 10px; border-radius:999px;
  border:1px solid var(--line); background:var(--bg2); color:var(--ink1); font:600 12px var(--font); cursor:pointer}
${R} .g-nav-btn .ico{width:13px; height:13px}
${R} .g-nav-btn.g-back .ico{transform:rotate(180deg)}
${R} .g-crumb-here{color:var(--ink0); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}

/* ---- body: a reading column, plus a page list in the wide view -------------------- */
${R} .g-body{flex:1; min-height:0; display:flex}
${R} .g-toc{display:none; width:250px; flex:none; overflow:auto; padding:14px 10px; border-right:1px solid var(--line); background:var(--bg0)}
${R}[data-wide="true"] .g-toc{display:block}
${R} .g-toc h4{margin:14px 8px 6px; font:700 11px var(--font); letter-spacing:.08em; text-transform:uppercase; color:var(--ink2)}
${R} .g-toc-link{display:flex; gap:8px; align-items:center; justify-content:flex-start; width:100%; text-align:left; padding:6px 8px; border-radius:8px;
  border:0; background:transparent; color:var(--ink1); font:13px/1.3 var(--font); cursor:pointer}
${R} .g-toc-link .ico{width:14px; height:14px; color:var(--ink2)}
${R} .g-toc-link[aria-current="page"]{background:var(--shine-soft); color:var(--ink0)}
${R} .g-toc-link[aria-current="page"] .ico{color:var(--shine)}
${R} .g-scroll{flex:1; min-width:0; overflow:auto; scroll-behavior:smooth}
${R} .g-page{max-width:760px; margin:0 auto; padding:22px 28px 40px}
${R}[data-wide="false"] .g-page{padding:18px 20px 32px}

/* ---- the article ---------------------------------------------------------------- */
${R} .g-page{font-size:15px; line-height:1.62; color:var(--ink0)}
${R} .g-page h2{font:800 26px/1.2 var(--font); margin:4px 0 6px; letter-spacing:-.01em; color:var(--ink0)}
${R} .g-page h3{font:750 18px/1.3 var(--font); margin:28px 0 8px; color:var(--ink0)}
${R} .g-page h4{font:700 15px/1.35 var(--font); margin:20px 0 6px; color:var(--shine)}
${R} .g-page p{margin:0 0 12px; color:var(--ink1)}
${R} .g-page p strong, ${R} .g-page li strong{color:var(--ink0)}
${R} .g-page .g-lead{font-size:16.5px; color:var(--ink1); margin-bottom:18px}
${R} .g-page ul, ${R} .g-page ol{margin:0 0 14px; padding-left:22px; color:var(--ink1)}
${R} .g-page li{margin:4px 0}
${R} .g-page li::marker{color:var(--shine)}
${R} .g-page code{font:13px var(--mono); padding:1px 6px; border-radius:5px; background:var(--bg3); color:var(--ink0); white-space:nowrap}
${R} .g-page hr{border:0; border-top:1px solid var(--line); margin:24px 0}
${R} .g-link{color:var(--info); text-decoration:none; border-bottom:1px solid transparent; cursor:pointer}
${R} .g-bad{color:var(--fail); font-size:13px}

/* figures: full column width, a quiet caption that names the map */
${R} .g-fig, ${R} .g-compare{margin:14px 0 18px}
${R} .g-fig img{display:block; width:100%; height:auto; border-radius:10px; border:1px solid var(--line); background:var(--bg0)}
${R} figcaption{margin-top:7px; font-size:12.5px; line-height:1.45; color:var(--ink2)}
${R} figcaption strong{color:var(--ink1)}
${R} .g-gallery{display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin:14px 0 18px}
${R} .g-gallery .g-fig{margin:0}

/* the compare slider: drag across to see the plain art and Map Shine on the same spot */
${R} .g-compare-frame{position:relative; border-radius:10px; overflow:hidden; border:1px solid var(--line); background:var(--bg0)}
${R} .g-compare-b{display:block; width:100%; height:auto}
${R} .g-compare-a{position:absolute; inset:0; clip-path:inset(0 calc(100% - var(--split)) 0 0)}
${R} .g-compare-a img{display:block; width:100%; height:100%; object-fit:cover}
${R} .g-compare-handle{position:absolute; top:0; bottom:0; left:var(--split); width:2px; margin-left:-1px; background:#fff;
  box-shadow:0 0 0 1px rgba(0,0,0,.35); pointer-events:none}
${R} .g-compare-handle::after{content:"⟷"; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
  width:34px; height:34px; border-radius:50%; display:grid; place-items:center; background:#fff; color:#222;
  font:700 16px/1 var(--font); box-shadow:var(--shadow2)}
${R} .g-compare-range{position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:ew-resize; margin:0}
${R} .g-compare-tag{position:absolute; top:10px; padding:3px 9px; border-radius:999px; font:700 11px var(--font);
  letter-spacing:.04em; text-transform:uppercase; background:rgba(0,0,0,.62); color:#fff; pointer-events:none}
${R} .g-compare-tag-a{left:10px}
${R} .g-compare-tag-b{right:10px}

/* callouts */
${R} .g-callout{margin:16px 0; padding:12px 14px 12px 16px; border-radius:10px; border:1px solid var(--line);
  border-left:4px solid var(--info); background:var(--bg2)}
${R} .g-callout p{margin:0; color:var(--ink1)}
${R} .g-callout-title{display:block; font:800 11px var(--font); letter-spacing:.08em; text-transform:uppercase; margin-bottom:4px; color:var(--info)}
${R} .g-callout-tip{border-left-color:var(--ok)}
${R} .g-callout-tip .g-callout-title{color:var(--ok)}
${R} .g-callout-warn{border-left-color:var(--warn)}
${R} .g-callout-warn .g-callout-title{color:var(--warn)}
${R} .g-callout-try{border-left-color:var(--shine)}
${R} .g-callout-try .g-callout-title{color:var(--shine)}

/* tables */
${R} .g-table-wrap{overflow-x:auto; margin:12px 0 18px; border:1px solid var(--line); border-radius:10px}
${R} .g-table{width:100%; border-collapse:collapse; font-size:13.5px; line-height:1.45}
${R} .g-table th{text-align:left; padding:8px 12px; background:var(--bg3); color:var(--ink0); font-weight:700; white-space:nowrap}
${R} .g-table td{padding:8px 12px; border-top:1px solid var(--line); color:var(--ink1); vertical-align:top}
${R} .g-table td:first-child{white-space:nowrap; color:var(--ink0)}

/* ---- hub tiles ------------------------------------------------------------------ */
${R} .g-cards{display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:12px; margin:14px 0 22px}
${R} .g-card{display:flex; flex-direction:column; align-items:stretch; text-align:left; padding:0; overflow:hidden; cursor:pointer;
  border:1px solid var(--line); border-radius:12px; background:var(--bg2); color:var(--ink0)}
${R} .g-card-thumb{display:block; width:100%; aspect-ratio:16/8; object-fit:cover; background:var(--bg0); border-bottom:1px solid var(--line)}
${R} .g-card-text{display:flex; gap:12px; align-items:flex-start; justify-content:flex-start; padding:12px 14px 14px}
${R} .g-card-ico{flex:none; width:36px; height:36px; border-radius:10px; display:grid; place-items:center; background:var(--bg3); color:var(--shine)}
${R} .g-card-ico .ico{width:20px; height:20px}
${R} .g-card b{display:block; font-size:15px; line-height:1.3; margin-bottom:3px}
${R} .g-card small{display:block; font-size:13px; line-height:1.4; color:var(--ink2)}
${R} .g-card[data-tone="fixes"] .g-card-ico{color:#ff9e5e}

/* ---- action buttons and what they did ---------------------------------------------- */
${R} .g-actions{display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 6px}
${R} .g-act{display:inline-flex; align-items:center; gap:8px; padding:9px 15px; border-radius:999px; cursor:pointer;
  border:1px solid color-mix(in srgb, var(--shine) 55%, transparent); background:var(--shine-soft); color:var(--ink0);
  font:700 13.5px var(--font)}
${R} .g-act .ico{width:16px; height:16px; color:var(--shine)}
${R} .g-act[data-busy="true"]{opacity:.6}
${R} .g-act[disabled]{opacity:.45; cursor:default}
${R} .g-results{display:flex; flex-direction:column; gap:6px; margin:4px 0 14px}
${R} .g-result{display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; padding:8px 12px; border-radius:10px;
  border:1px solid var(--line); background:var(--bg2); font-size:13px; color:var(--ink1);
  animation:msaPopIn 160ms var(--ease-out) both}
${R} .g-result[data-ok="false"]{border-color:color-mix(in srgb, var(--fail) 60%, transparent); color:var(--fail)}
${R} .g-result .g-chg{color:var(--ink0); font-weight:600}
${R} .g-result .g-chg i{font-style:normal; color:var(--ink2); font-weight:500}
${R} .g-result .g-where{color:var(--ink2); font-size:12px}
${R} .g-result[data-undone="true"]{opacity:.6}
${R} .g-undo{margin-left:auto; padding:4px 11px; border-radius:999px; border:1px solid var(--line-strong);
  background:transparent; color:var(--ink0); font:700 12px var(--font); cursor:pointer}
${R} .g-note-gm{font-size:12.5px; color:var(--warn)}

/* the Looks block */
${R} .g-looks{display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 16px}
${R} .g-look{padding:8px 14px; border-radius:10px; border:1px solid var(--line); background:var(--bg2); color:var(--ink0);
  font:600 13px var(--font); cursor:pointer}

/* ---- search results ------------------------------------------------------------- */
${R} .g-hits{display:flex; flex-direction:column; gap:8px}
${R} .g-hit{display:block; width:100%; text-align:left; padding:10px 14px; border-radius:10px; cursor:pointer;
  border:1px solid var(--line); background:var(--bg2); color:var(--ink0); font:14px/1.4 var(--font)}
${R} .g-hit small{display:block; color:var(--ink2); font-size:12.5px; margin-top:2px}
${R} .g-hit mark{background:var(--shine-soft); color:var(--ink0); border-radius:3px; padding:0 2px}

/* ---- footer: previous / next ------------------------------------------------------- */
${R} .g-foot{display:flex; gap:8px; align-items:center; padding:10px 16px; border-top:1px solid var(--line); background:var(--bg0)}
${R} .g-foot[hidden]{display:none}
${R} .g-foot .g-nav-btn{max-width:48%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
${R} .g-foot .g-next{margin-left:auto}
${R} .g-foot .g-prev .ico{transform:rotate(180deg)}

${HOVER_GATE}{
${uiKitHoverCss(IN)}
  ${R} .g-half:not([aria-pressed="true"]):hover{border-color:var(--line-strong); color:var(--ink0)}
  ${R} .g-card:hover{border-color:var(--shine); box-shadow:var(--shadow1)}
  ${R} .g-act:hover{border-color:var(--shine); background:color-mix(in srgb, var(--shine) 24%, transparent)}
  ${R} .g-undo:hover{border-color:var(--shine); color:var(--shine)}
  ${R} .g-nav-btn:hover{color:var(--ink0); border-color:var(--line-strong)}
  ${R} .g-toc-link:not([aria-current="page"]):hover{background:var(--bg2); color:var(--ink0)}
  ${R} .g-hit:hover{border-color:var(--shine)}
  ${R} .g-look:hover{border-color:var(--shine)}
  ${R} .g-link:hover{border-bottom-color:currentColor}
}
`;
}
