/**
 * ui/rooms/player-shell.js — THE PLAYER ROOM (U5, docs/holy/UI-Testament.md
 * §5.5): a single, small, titled window ("Performance & Graphics") showing
 * EXACTLY the same generated component tree the Studio's own SYSTEM
 * department shows a GM (`ui/rooms/system-panel.js`), scoped to client-only
 * — no rail, no departments, no GM section, ever. Deliberately the smallest,
 * calmest room this project builds (§5.5: "deliberately small, friendly,
 * and theirs").
 *
 * ⚠️ `isGM` IS HARD-CODED `false` HERE, NEVER READ FROM THE CURRENT USER.
 * This room's whole purpose is "what a player sees" — even a GM who opens
 * it (to check what their table sees) sees the PLAYER view, not their own
 * GM section. Structurally this also means `system-panel.js`'s own
 * `if (isGM())` branch NEVER RUNS inside this room — Law 10 held by
 * construction, not a CSS `display:none` on GM-only DOM that still exists.
 *
 * ⚠️ SAFE TO CONSTRUCT UNCONDITIONALLY, UNLIKE THE STUDIO. Studio/Remote's
 * own DOM trees carry real GM-authoring surfaces (EFFECTS/PAINTER/CUES/LAB)
 * regardless of who they're built for — a pre-existing Law 10 tension named
 * in Petition P17, not fixed here. This room carries none of that: its
 * content is never GM-only no matter who opens it, so eagerly installing it
 * for every client (matching Studio/Remote's own eager call site) poses no
 * equivalent risk.
 *
 * @module ui/rooms/player-shell
 */

import { installTokens } from '../tokens.js';
import { installIconSprite, iconMarkup } from '../widgets/icon-sprite.js';
import { renderSystemPanel } from './system-panel.js';

const ROOM_ID = 'msa-player';
const STYLE_ID = 'msa-player-style';

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
#${ROOM_ID}{position:fixed; top:44px; right:24px; width:360px; max-width:calc(100vw - 48px);
  max-height:calc(100vh - 60px); background:var(--glass); backdrop-filter:blur(var(--glass-blur));
  border:1px solid var(--line); border-radius:var(--r-room); box-shadow:var(--shadow3);
  display:flex; flex-direction:column; overflow:hidden; z-index:100; font:12px/1.4 var(--font); color:var(--ink0)}
#${ROOM_ID} .msa-player-head{display:flex; align-items:center; gap:var(--sp2); padding:8px 14px;
  border-bottom:1px solid var(--line); flex:none}
#${ROOM_ID} .msa-player-title{font-weight:600; letter-spacing:.1em; font-size:.72rem; text-transform:uppercase;
  color:var(--ink1); display:flex; gap:8px; align-items:center}
#${ROOM_ID} .msa-player-title .ico{color:var(--shine)}
#${ROOM_ID} .msa-spacer{flex:1}
#${ROOM_ID} .hbtn{width:26px; height:26px; display:grid; place-items:center; border-radius:6px;
  color:var(--ink2); background:none; border:none; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .hbtn:hover{background:var(--bg3); color:var(--ink0)}
#${ROOM_ID} .msa-player-body{flex:1; overflow-y:auto; padding:14px}
`.trim();
  document.head.appendChild(el);
}

/**
 * @param {{getSystemPanelCtx?: () => object}} [opts] — `getSystemPanelCtx`,
 *   called fresh every time this room (re)paints, returns what's spread
 *   straight into `renderSystemPanel`'s own `ctx` (minus `isGM`, always
 *   `false` here) — a FUNCTION rather than a plain object for the same
 *   temporal-dead-zone reason `system-department.js`'s own header explains:
 *   `installPlayer(...)` is called eagerly, long before the module-level
 *   `PROFILE_CHOICE_LIST`/`ENABLE_CHOICE_LIST` consts it ultimately reads
 *   exist. This file never inspects `getSystemPanelCtx`'s return shape.
 * @returns {{open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean, onOpenChange: (fn: (open: boolean) => void) => void, refresh: () => void}}
 */
export function installPlayer(opts = {}) {
  installTokens();
  installIconSprite();
  injectStyle();

  if (document.getElementById(ROOM_ID)) return document.getElementById(ROOM_ID)._msaPlayerController;

  const state = { open: false };
  const room = document.createElement('section');
  room.id = ROOM_ID;
  room.setAttribute('aria-label', 'Performance & Graphics');
  room.hidden = true;

  const head = document.createElement('header');
  head.className = 'msa-player-head';
  const title = document.createElement('span');
  title.className = 'msa-player-title';
  title.innerHTML = `${iconMarkup('gauge')}Performance & Graphics`;
  const headSpacer = document.createElement('span');
  headSpacer.className = 'msa-spacer';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'hbtn';
  closeBtn.title = 'Close';
  closeBtn.innerHTML = iconMarkup('x');
  closeBtn.addEventListener('click', () => controller.close());
  head.append(title, headSpacer, closeBtn);

  const body = document.createElement('div');
  body.className = 'msa-player-body';
  let bodyBuilt = false;

  function paint() {
    if (typeof opts.getSystemPanelCtx === 'function') {
      renderSystemPanel(body, { isGM: () => false, ...opts.getSystemPanelCtx() });
    } else {
      body.innerHTML = '<div style="color:var(--ink2); font-size:.8rem">Settings are not available.</div>';
    }
  }

  room.append(head, body);
  document.body.appendChild(room);

  const openChangeListeners = new Set();
  const controller = {
    open() {
      if (!bodyBuilt) {
        bodyBuilt = true;
        paint();
      }
      state.open = true;
      room.hidden = false;
      for (const fn of openChangeListeners) fn(true);
    },
    close() {
      state.open = false;
      room.hidden = true;
      for (const fn of openChangeListeners) fn(false);
    },
    toggle() {
      if (state.open) controller.close();
      else controller.open();
    },
    isOpen: () => state.open,
    onOpenChange(fn) {
      openChangeListeners.add(fn);
    },
    /** Re-paint if a setting changed elsewhere (another client, the console,
     * Foundry's own native Settings dialog) while this room happens to be
     * open — mirrors `refreshWeatherBoard`'s own "never polls, it's told"
     * shape. No-op before the body exists. */
    refresh() {
      if (bodyBuilt) paint();
    },
  };
  room._msaPlayerController = controller;
  return controller;
}
