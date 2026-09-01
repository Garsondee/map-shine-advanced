/**
 * ui/rooms/studio/shell.js — the Studio's own room chrome (U1, docs/holy/
 * UI-Testament.md §5, §9): department rail (EFFECTS·PAINTER·SCENE·CUES·
 * SYSTEM·LAB), room header, department switching. Ported from the mock's
 * `#studio` shell (`tools/ui-mock/index.html`) — same DOM shape, same CSS
 * class names (`.room`, `.room-head`, `#rail`, `#deptBody`, `.depthead`,
 * `.deptscroll`), so LANTERN's existing rules in `ui/tokens.js`'s consumers
 * apply unchanged; the mock's `--t-room` token is declared but never actually
 * used by any mock rule either — ported faithfully, not invented into a
 * transition that was never really there.
 *
 * ⚠️ WHY THIS FILE DOES NOT IMPORT `effects/` OR TALK TO `effectRegistry`
 * DIRECTLY. `effectRegistry` is a single instance created inside boot.js's
 * own `install()` closure (`const effectRegistry = createEffectRegistry()`)
 * — it is not, and should not become, an importable module-level singleton.
 * The existing pattern (`diag/debug-panel.js`'s `registerPanel`) is that
 * boot.js, which already HAS each effect's resolved data in scope, hands a
 * plain view-model to whichever UI surface wants to render it. This shell
 * follows the identical shape: `registerEffectCard(id, modelFactory)` is the
 * door boot.js calls through, once per effect, at the same place it already
 * calls `registerPanel(...)` for the old panel — never a second door into
 * the registry itself.
 *
 * @module ui/rooms/studio/shell
 */

import { installTokens } from '../../tokens.js';
import { installIconSprite, iconMarkup } from '../../widgets/icon-sprite.js';
import { makeDraggable } from '../../widgets/draggable.js';
import { renderEffectsDepartment, closeAllPopouts } from './effects-department.js';
import { renderPainterDepartment } from './painter-department.js';
import { renderSceneDepartment } from './scene-department.js';
import { renderCuesDepartment } from './cues-department.js';
import { renderSystemDepartment } from './system-department.js';
import { renderLabDepartment } from './lab-department.js';
import { installSearchPalette, buildSearchIndex } from './search-palette.js';

const ROOM_ID = 'msa-studio';
const STYLE_ID = 'msa-studio-style';

/**
 * The six departments, fixed set (Law 9). `dev:true` marks LAB — gated on
 * `isGM()` for U1 (the OLD panel's own current real gate; the fuller "debug
 * dress" flag the Testament describes is later work, not yet built anywhere
 * in `src/` — see Petition P10). Every department now has a real `render` —
 * U1 shipped three ("lands in a later stage") placeholders, since filled in
 * by CUES (U3), PAINTER (U4), and SYSTEM (U5) — but the `render: null` /
 * `stage` fallback path (below, in `render()`) stays: it's what the NEXT new
 * department (a future Law-9 amendment) would show before its own stage
 * lands, not a one-time U1 scaffold to delete.
 * @type {ReadonlyArray<{id: string, label: string, icon: string, accVar: string, dev?: boolean, render: (Function|null), stage?: string}>}
 */
const DEPTS = Object.freeze([
  { id: 'effects', label: 'Effects', icon: 'water', accVar: '--shine', render: renderEffectsDepartment },
  { id: 'painter', label: 'Painter', icon: 'brush', accVar: '--c-particles', render: renderPainterDepartment },
  { id: 'scene', label: 'Scene', icon: 'map', accVar: '--c-atmos', render: renderSceneDepartment },
  { id: 'cues', label: 'Cues', icon: 'clap', accVar: '--c-post', render: renderCuesDepartment },
  { id: 'system', label: 'System', icon: 'gear', accVar: '--c-system', render: renderSystemDepartment },
  { id: 'lab', label: 'Lab', icon: 'flask', accVar: '--c-system', dev: true, render: renderLabDepartment },
]);

/**
 * The distinct accent tokens DEPTS actually uses, deduplicated.
 *
 * WHY THIS IS A SET OF STYLESHEET RULES, NOT A `--dept-acc` CUSTOM PROPERTY.
 * The first version set `--dept-acc: var(--shine)` inline (one indirection)
 * and read it back via `color: var(--dept-acc, var(--shine))` in a
 * STYLESHEET rule (a second indirection). Live-testing that in the preview
 * harness, the rail button's colour appeared frozen after a theme switch —
 * but the actual cause was NOT the indirection: `.rail button` carries
 * `transition:all`, and this automated browser pane never composites frames
 * while backgrounded (`document.hidden === true`, the same limitation as
 * [[feedback_sandboxed_browser_pane_lacks_os_focus]]), so the `color`/
 * `background-color` transitions froze at `currentTime:0` and
 * `getComputedStyle` kept reporting the transition's START value. Confirmed
 * by forcing the stuck animations to complete (`el.getAnimations().forEach(a
 * => a.finish())`) — the colour snapped to the correct, live `var(--shine)`
 * value immediately, proving the two-level chain was resolving correctly the
 * whole time; this was a pane artifact, not a CSS bug. Kept the one-level
 * version anyway, not as a bugfix but because it's a real simplification —
 * one fewer indirection, same shape already proven live in ui/widgets/
 * param-control.js's ACCENT/MUTED constants — and there's no reason to carry
 * the extra hop once the simpler version is already written and tested.
 * @type {string[]}
 */
const ACCENT_VARS = [...new Set(DEPTS.map((d) => d.accVar))];

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  // Ported verbatim from the mock's own #studio/#rail/#deptBody/.depthead/
  // .deptscroll rules (tools/ui-mock/index.html) — geometry, rail button
  // shape, the --dept-acc active-indicator mechanism, dev-gating via a
  // `.dbg` class the mock ties to a `data-debug` attribute this file does
  // not yet set (see the class doc comment on DEPTS above).
  el.textContent = `
#${ROOM_ID}{top:44px; left:24px; width:1180px; height:800px;
  max-width:calc(100vw - 460px); max-height:calc(100vh - 60px);
  min-width:760px; min-height:520px; resize:both;
  position:fixed; z-index:100; background:var(--glass);
  backdrop-filter:blur(var(--glass-blur));
  border:1px solid var(--line); border-radius:var(--r-room);
  box-shadow:var(--shadow3); display:flex; flex-direction:column; overflow:hidden}
#${ROOM_ID} .room-head{display:flex; align-items:center; gap:var(--sp2);
  padding:8px 14px; border-bottom:1px solid var(--line); cursor:grab; user-select:none; flex:none}
#${ROOM_ID} .room-head:active{cursor:grabbing}
#${ROOM_ID} .rtitle{font-weight:600; letter-spacing:.14em; font-size:.72rem;
  color:var(--ink1); text-transform:uppercase; display:flex; gap:8px; align-items:center}
#${ROOM_ID} .rtitle .ico{color:var(--shine)}
#${ROOM_ID} .spacer{flex:1}
#${ROOM_ID} .hbtn{width:24px; height:24px; display:grid; place-items:center; border-radius:6px;
  color:var(--ink2); pointer-events:auto}
#${ROOM_ID} .hbtn:hover{background:var(--bg3); color:var(--ink0)}
#${ROOM_ID} .frame{display:flex; flex:1; min-height:0}
#${ROOM_ID} .rail{width:58px; flex:none; border-right:1px solid var(--line); display:flex;
  flex-direction:column; align-items:center; padding:10px 0; gap:4px}
#${ROOM_ID} .rail button{width:42px; height:42px; display:grid; place-items:center; border-radius:11px;
  color:var(--ink2); position:relative; transition:all var(--t-micro); pointer-events:auto}
#${ROOM_ID} .rail button .ico{width:19px; height:19px}
#${ROOM_ID} .rail button:hover{background:var(--bg3); color:var(--ink0)}
${ACCENT_VARS.map(
  (v) => `#${ROOM_ID} .rail button[aria-pressed="true"][data-acc="${v}"]{color:var(${v});
  background:color-mix(in oklab, var(${v}) 14%, transparent)}
#${ROOM_ID} .rail button[aria-pressed="true"][data-acc="${v}"]::before{content:""; position:absolute; left:-9px; top:9px;
  bottom:9px; width:3px; border-radius:2px; background:var(${v})}`
).join('\n')}
#${ROOM_ID} .rail button[disabled]{opacity:.4; cursor:default}
#${ROOM_ID} .railspacer{flex:1}
#${ROOM_ID} .devtag{font-size:.56rem; color:var(--ink2); letter-spacing:.12em; margin-top:2px}
#${ROOM_ID} .deptBody{flex:1; min-width:0; display:flex; flex-direction:column}
#${ROOM_ID} .depthead{flex:none; display:flex; align-items:center; gap:10px; padding:12px 18px 10px;
  border-bottom:1px solid var(--line)}
#${ROOM_ID} .depthead h2{font-size:.95rem; font-weight:650; display:flex; gap:9px; align-items:center; margin:0}
#${ROOM_ID} .depthead h2 .ico{width:1.15em; height:1.15em}
#${ROOM_ID} .depthead .sub{color:var(--ink2); font-size:.72rem}
#${ROOM_ID} #studioSearchBox{display:flex; align-items:center; gap:6px; background:var(--bg2);
  border:1px solid var(--line); border-radius:999px; padding:5px 12px; width:250px; pointer-events:auto}
#${ROOM_ID} #studioSearchBox input{background:none; border:none; width:100%; font-size:.76rem; color:var(--ink0)}
#${ROOM_ID} #studioSearchBox .ico{color:var(--ink2)}
#${ROOM_ID} #studioSearchBox kbd{font-size:.6rem; background:var(--bg3); border:1px solid var(--line);
  border-radius:4px; padding:1px 5px; color:var(--ink2)}
#${ROOM_ID} .deptscroll{flex:1; overflow-y:auto; overflow-x:hidden; padding:16px 18px 24px; scrollbar-width:thin}
#${ROOM_ID} .stagePlaceholder{margin:auto; text-align:center; color:var(--ink2); font-size:.85rem; max-width:360px}
#${ROOM_ID} .stagePlaceholder b{color:var(--ink1); display:block; margin-bottom:6px; font-size:1rem}
#${ROOM_ID} summary{list-style:none}
#${ROOM_ID} summary::-webkit-details-marker{display:none}
#${ROOM_ID} .msa-chev{display:inline-block; transition:transform var(--t-micro); opacity:.55}
/* \`> summary >\` and not a descendant selector — same trap diag/debug-panel-
   controls.js already documents: a descendant rule would rotate a NESTED
   details' own chevron just because an ANCESTOR details is open. */
#${ROOM_ID} details[open] > summary .msa-chev{transform:rotate(90deg)}
`.trim();
  document.head.appendChild(el);
}

function deptHead(dept, subtitle, onSearchInput) {
  const head = document.createElement('div');
  head.className = 'depthead';
  const h2 = document.createElement('h2');
  h2.innerHTML = iconMarkup(dept.icon);
  // Direct, single-level var() as an INLINE style — the shape proven live
  // (ACCENT_VARS's own doc comment on this file has the full account of why
  // NOT to route this through an intermediate --dept-acc custom property).
  h2.querySelector('.ico').style.color = `var(${dept.accVar})`;
  h2.append(dept.label);
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = subtitle;
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const box = document.createElement('div');
  box.id = 'studioSearchBox';
  box.innerHTML = `${iconMarkup('search')}<input placeholder="Search every control…" aria-label="Search"><kbd>/</kbd>`;
  const input = box.querySelector('input');
  input.addEventListener('focus', () => onSearchInput(input.value));
  input.addEventListener('input', () => onSearchInput(input.value));
  head.append(h2, sub, spacer, box);
  return head;
}

/**
 * Install the Studio room, once. Returns a controller boot.js uses to
 * register effect view-models and open/close the room.
 *
 * `debugPanel` is `MapShine.debug` — passed explicitly, not read off a
 * global (`MapShine` is not a declared ESLint global anywhere in this
 * codebase; the established pattern, `diag/debug-panel.js#installDebugPanel
 * (MapShine)`, is dependency injection, not an ambient reference). Optional:
 * without it, LAB gates closed (no isGM to check) and shows an honest
 * "not installed" notice instead of throwing. Everything else in `opts`
 * (e.g. `getMaskBoard` for the SCENE department) passes straight through to
 * every department's own `ctx` unchanged — this shell doesn't enumerate or
 * understand per-department context, it just carries it.
 * @param {{debugPanel?: object, [key: string]: unknown}} [opts]
 * @returns {{
 *   open: () => void, close: () => void, toggle: () => void,
 *   registerEffectCard: (id: string, modelFactory: () => object) => void,
 *   isOpen: () => boolean,
 * }}
 */
export function installStudio({ debugPanel, ...roomCtx } = {}) {
  // Studio is the GM-only control room (docs/holy/UI-Testament.md's own safety
  // law: "never built into a player client's DOM at all", not merely hidden
  // after the fact) — so a non-GM client gets no DOM here at all, not even the
  // shared token/icon-sprite/stylesheet installs below (player-shell.js already
  // calls those independently, so Player is unaffected either way). Mirrors the
  // SAME debugPanel.isGM() gate the LAB department below already uses — one
  // fact, read the same way twice in this file. Every MapShine.__studio
  // consumer elsewhere already reaches through optional chaining, so
  // returning undefined here for a non-GM client is safe.
  if (typeof debugPanel?.isGM === 'function' && !debugPanel.isGM()) return undefined;

  installTokens();
  installIconSprite();
  injectStyle();

  if (document.getElementById(ROOM_ID)) return document.getElementById(ROOM_ID)._msaStudioController;

  /** id -> () => cardViewModel, populated by boot.js via registerEffectCard. */
  const effectCardFactories = new Map();
  const state = { dept: 'effects', open: false };

  const room = document.createElement('section');
  room.id = ROOM_ID;
  room.setAttribute('aria-label', 'Map Shine Studio');
  room.hidden = true;

  const head = document.createElement('header');
  head.className = 'room-head';
  const title = document.createElement('span');
  title.className = 'rtitle';
  title.innerHTML = `${iconMarkup('brush')}Studio`;
  const headSpacer = document.createElement('span');
  headSpacer.className = 'spacer';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'hbtn';
  closeBtn.title = 'Close Studio';
  closeBtn.innerHTML = iconMarkup('x');
  closeBtn.addEventListener('click', () => controller.close());
  head.append(title, headSpacer, closeBtn);

  const frame = document.createElement('div');
  frame.className = 'frame';
  const rail = document.createElement('nav');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Departments');
  const deptBody = document.createElement('div');
  deptBody.className = 'deptBody';
  frame.append(rail, deptBody);

  room.append(head, frame);
  document.body.appendChild(room);
  // 2026-08-18 fix: .room-head already carried the mock's own cursor:grab
  // CSS (line ~105) with no listener behind it — looked draggable, silently
  // did nothing. Wired for real now, shared with the Remote/Player rooms.
  makeDraggable(head, room);

  const railButtons = new Map();
  for (const dept of DEPTS) {
    if (dept.dev) rail.append(Object.assign(document.createElement('div'), { className: 'railspacer' }));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = iconMarkup(dept.icon);
    btn.title = dept.label + (dept.dev ? ' (dev-gated)' : '') + (dept.stage ? ` — lands in ${dept.stage}` : '');
    btn.dataset.acc = dept.accVar;
    btn.setAttribute('aria-pressed', String(dept.id === state.dept));
    if (dept.dev) btn.classList.add('dbg');
    // Straight through switchDepartment — the dev gate used to live HERE,
    // duplicated, which meant the rail was locked and every programmatic
    // caller of `ctx.switchDepartment` (effects-department.js's
    // `onOpenHealthReport`, the search palette) walked past it into LAB
    // unchecked. Two doors, one lock. Now there is one door.
    btn.addEventListener('click', () => switchDepartment(dept.id));
    rail.append(btn);
    if (dept.dev)
      rail.append(Object.assign(document.createElement('div'), { className: 'devtag', textContent: 'DEV' }));
    railButtons.set(dept.id, btn);
  }

  /**
   * Switch the active department and re-render — the ONE place `state.dept`
   * changes (the rail's own click handler, the search palette's `onOpenCard`,
   * and U6's health-badge deep-link all call this rather than each keeping
   * their own copy of the "update state + sync rail aria-pressed + render()"
   * dance) and, since 2026-08-31, the ONE place the dev gate is enforced.
   *
   * LAB is gated on isGM() -- the OLD panel's own current real gate (Agent
   * finding: no separate "debug dress" flag exists in src/ yet; see Petition
   * P10 for why this is parity, not a shortfall). The gate lives HERE and not
   * on the rail button because this function is exported into every
   * department's `ctx`, so a programmatic caller (effects-department.js's
   * `onOpenHealthReport` is a live one) reached LAB without ever passing the
   * button that carried the only check. Polarity is unchanged from that
   * button's version, deliberately: no `debugPanel` at all still ALLOWS the
   * switch, and `renderLabDepartment` shows its own honest "not installed"
   * notice (see this function's caller doc on `installStudio`).
   * @param {string} id - a DEPTS entry's id (e.g. `'lab'`).
   */
  function switchDepartment(id) {
    const dept = DEPTS.find((d) => d.id === id);
    if (!dept) return;
    if (dept.dev && typeof debugPanel?.isGM === 'function' && !debugPanel.isGM()) return;
    state.dept = id;
    for (const [bid, b] of railButtons) b.setAttribute('aria-pressed', String(bid === state.dept));
    render();
  }

  function render() {
    deptBody.innerHTML = '';
    const dept = DEPTS.find((d) => d.id === state.dept);
    if (!dept.render) {
      deptBody.append(
        deptHead(dept, `lands in ${dept.stage} — not built yet`, (q) => palette?.open(q)),
        Object.assign(document.createElement('div'), {
          className: 'deptscroll',
          innerHTML: `<div class="stagePlaceholder"><b>${dept.label} lands in ${dept.stage}</b>This department's own migration stage hasn't landed yet — the rail slot is here because the Studio's department set is fixed from day one (Law 9), not because there is anything to show.</div>`,
        })
      );
      return;
    }
    const scroll = document.createElement('div');
    scroll.className = 'deptscroll';
    const subtitle = dept.render(scroll, {
      effectCardFactories,
      openCardById: (effectId, paramId) => palette?.flashParam(effectId, paramId),
      switchDepartment,
      debugPanel,
      ...roomCtx,
    });
    deptBody.append(
      deptHead(dept, subtitle ?? '', (q) => palette?.open(q)),
      scroll
    );
  }

  const openChangeListeners = new Set();
  const controller = {
    open() {
      state.open = true;
      room.hidden = false;
      render();
      for (const fn of openChangeListeners) fn(true);
    },
    close() {
      state.open = false;
      room.hidden = true;
      // "Pop-outs are views — closing the Studio closes its children."
      closeAllPopouts();
      for (const fn of openChangeListeners) fn(false);
    },
    toggle() {
      if (state.open) controller.close();
      else controller.open();
    },
    isOpen: () => state.open,
    /** Re-sync a toolbar toggle when the room opens/closes for a reason
     * other than that exact button — same shape as `MapShine.debug.
     * onVisibilityChange` (diag/debug-panel.js), so boot.js's own wiring
     * for this button matches the other two scene-controls tools exactly. */
    onOpenChange(fn) {
      openChangeListeners.add(fn);
    },
    /**
     * boot.js's own door into this room — one call per effect, at the same
     * place it already calls registerPanel() for the old panel. `modelFactory`
     * is called FRESH on every render (never cached), matching `panels/no-
     * captured-readout`'s rule for the identical reason: a cached view-model
     * would export whatever was true when the Studio last opened, not what
     * is true now.
     * @param {string} id @param {() => object} modelFactory
     */
    registerEffectCard(id, modelFactory) {
      effectCardFactories.set(id, modelFactory);
      if (state.open && state.dept === 'effects') render();
    },
  };
  room._msaStudioController = controller;

  const palette = installSearchPalette({
    buildIndex: () => buildSearchIndex(effectCardFactories),
    onOpenCard: (_effectId) => {
      controller.open();
      switchDepartment('effects');
    },
  });

  document.addEventListener('keydown', (e) => {
    // `e.target` is an Element for every REAL keypress (at minimum
    // document.body), but not guaranteed for a synthetically dispatched
    // event (`document.dispatchEvent(...)` with no explicit target sets
    // `e.target` to `document` itself, which has no `.matches()` — found
    // live driving this exact check from a preview harness). Guard rather
    // than assume every caller of this document-level listener is a real
    // keyboard event.
    if (e.key === '/' && state.open && !(e.target instanceof Element && e.target.matches('input,select,textarea'))) {
      e.preventDefault();
      palette.open();
    }
  });

  return controller;
}
