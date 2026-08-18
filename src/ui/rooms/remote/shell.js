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
import { installCameraPathPopover } from './camera-path-popover.js';
import { renderAstrolabePanel } from './astrolabe-panel.js';
import { renderWeatherBoard } from './weather-board.js';
import { renderCueDeck } from './cue-deck.js';

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
  border-bottom:1px solid var(--line); flex:none}
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
#${ROOM_ID} .msa-astro-dial-host{position:relative; display:grid; place-items:center; padding:36px}
#${ROOM_ID} .msa-astro-dial-slot{position:relative; z-index:1}
#${ROOM_ID} .msa-corner{position:absolute; display:grid; grid-auto-flow:column; gap:4px; z-index:2}
#${ROOM_ID} .msa-corner-tl{top:0; left:0}
#${ROOM_ID} .msa-corner-tr{top:0; right:0}
#${ROOM_ID} .msa-corner-bl{bottom:0; left:0}
#${ROOM_ID} .msa-corner-br{bottom:0; right:0}
#${ROOM_ID} .msa-corner button{width:26px; height:26px; display:grid; place-items:center; border-radius:8px;
  color:var(--ink2); background:var(--bg2); border:1px solid var(--line); cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-corner button:hover{background:var(--bg3); color:var(--ink0)}
#${ROOM_ID} .msa-corner button.msa-planned{border-style:dashed; border-color:var(--fail); color:var(--fail)}
#${ROOM_ID} .msa-corner .ico{width:15px; height:15px}
#${ROOM_ID} .msa-ghost-slot{opacity:.5}
#${ROOM_ID} .msa-ghost-slot:hover{opacity:.85}
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
 *   weatherBoard?: object, onBaseline?: (overMs: number) => void, cueDeck?: object,
 *   impulses?: Array<import('../../../core/impulse-schema.js').ImpulseDecl>}} [opts]
 *   `weatherBoard`/`cueDeck`, when supplied, are passed straight through as
 *   `renderWeatherBoard`/`renderCueDeck`'s own `ctx` (weather-board.js,
 *   cue-deck.js) — this file never inspects their shape, only whether they
 *   exist. `impulses` (U7) is handed straight to `astrolabe-panel.js`'s own
 *   TR corner unchanged, same reasoning.
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

    renderAstrolabePanel(body, {
      mountAstrolabeDial: opts.mountAstrolabeDial ?? (() => {}),
      getPosture: opts.getPosture ?? (() => 'director'),
      isFlowPlaying: opts.isFlowPlaying ?? (() => false),
      onFlowToggle: opts.onFlowToggle ?? (() => {}),
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
  };
  room._msaRemoteController = controller;
  return controller;
}
