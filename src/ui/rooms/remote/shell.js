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
import { installTooltips, setTip } from '../../widgets/tooltip.js';
import { buildArmButton } from '../../widgets/inline-actions.js';
import { replayClass } from '../room-style.js';
import { REMOTE_ROOM_ID, REMOTE_TOOLTIP_SCOPE, remoteCss } from './remote-style.js';
import { installCameraPathPopover } from './camera-path-popover.js';
import { installWindPopover } from './wind-popover.js';
import { renderAstrolabePanel } from './astrolabe-panel.js';
import { renderWeatherBoard } from './weather-board.js';
import { renderPlayerLightBoard } from './player-light-board.js';
import { renderCueDeck } from './cue-deck.js';
import { renderDebugStrip } from './debug-strip.js';
import { raiseRoom, raiseRoomOnPress } from '../room-stack.js';

const ROOM_ID = REMOTE_ROOM_ID;
const STYLE_ID = 'msa-remote-style';
const POSITION_STORAGE_KEY = 'msa-remote-position';

// THE REMOTE'S DEFAULT PLACEMENT — vertically centred on the left side of
// the screen, clear of Foundry's own left toolbar (author: wants it "just
// slightly away from the other controls", never draggable somewhere it
// can't be reached back from). #ui-left-column-1 (client/templates/views/
// game.hbs) is the toolbar's own tight-fitting column — measured live
// rather than baked in as a constant so a future Foundry toolbar-width
// change can't silently put the Remote back underneath it; TOOLBAR_CLEAR_FALLBACK
// (16px #ui-left padding + 72px of a 2-column, 32px control-size toolbar,
// foundry client/public/less2/views/game.less) is only the guess used on the
// rare chance that element isn't found.
//
// TOOLBAR_GAP is bigger than it looks like it needs to be: the scale strip
// (installScaleControl below) hangs off the room's OWN left edge, further
// left again by its own ~38px width plus its 8px inset — measuring only the
// room itself here would read as "clear of the toolbar" while the strip
// still overlapped it. The gap actually visible between toolbar and strip
// is TOOLBAR_GAP minus that ~46px, i.e. still just the "slightly away" the
// author asked for.
//
// Left un-saved to localStorage on its own (see readStored/writeStored in
// draggable.js) — only an actual drag commits a position, so this
// recomputes fresh each reload until the user moves it once.
const TOOLBAR_GAP = 64;
const TOOLBAR_CLEAR_FALLBACK = 152;

function computeDefaultPosition(rect) {
  const toolbar = document.getElementById('ui-left-column-1');
  const left = toolbar ? toolbar.getBoundingClientRect().right + TOOLBAR_GAP : TOOLBAR_CLEAR_FALLBACK;
  const top = (window.innerHeight - rect.height) / 2;
  return { left, top };
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  // The whole stylesheet lives in ./remote-style.js (the press / hover / focus model
  // from ../room-style.js, the weather board, the astrolabe's corners, the cue deck,
  // the popovers) — it grew past what belongs inline in a shell file, and the popovers
  // it now covers were inline styles that could not answer a hover or a press.
  el.textContent = remoteCss();
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
  a.className = 'msa-foot-btn';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = text;
  return a;
}

function plannedFooterBtn(text, plannedReason) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msa-foot-btn msa-planned';
  btn.textContent = text;
  btn.title = plannedReason;
  return btn;
}

/**
 * A footer button for a genuinely irreversible action (UI parity plan, phase 4b — the
 * Safety button, wired to `diag/render-fallback.js#engageFoundryFallback`, which
 * physically tears down MSA's canvas with no way back except a reload). It is the
 * shared two-click confirm (`widgets/inline-actions.js#buildArmButton`, the same one the
 * Studio's destructive buttons use, so every room agrees on what "are you sure" looks
 * like): the first click arms it (it relabels and turns red), a second click within a few
 * seconds fires, and clicking anywhere else cancels. A native `confirm()` would block the
 * whole tab — and the live map with it — behind a grey OS box that ignores the theme.
 * (This room used to carry its own copy of that machine; the Studio's widget was written
 * from it, so the copy is gone rather than kept beside it.)
 * @param {string} text @param {string} tooltip @param {() => void} onConfirmed
 */
function dangerFooterBtn(text, tooltip, onConfirmed) {
  return buildArmButton({
    label: text,
    armedLabel: 'Click again to confirm',
    title: tooltip,
    armedTitle: 'One-way — MSA stops rendering until you reload. Click again within a few seconds to proceed.',
    className: 'msa-foot-btn',
    onConfirm: onConfirmed,
  });
}

/**
 * @param {{debugPanel?: object,
 *   mountAstrolabeDial: (el: HTMLElement, dialCtx: {onLockedAttempt: () => void}) => void,
 *   getPosture: () => string, onSetMode?: (mode: string) => void,
 *   isFlowPlaying: () => boolean, onFlowToggle: () => void,
 *   getFlowRate?: () => number, onSetFlowRate?: (rate: number) => void,
 *   weatherBoard?: object, onBaseline?: (overMs: number) => void, cueDeck?: object,
 *   playerLight?: object,
 *   debugStrip?: object,
 *   getRendererOverride?: () => 'msa'|'foundry', onRendererOverrideChange?: (v: 'msa'|'foundry') => Promise<void>,
 *   onEngageSafety?: () => void,
 *   windPopover?: {getDirectionDeg?: () => number,
 *     onCommit?: (v: {directionDeg?: number}) => void},
 *   onOpenTileMotion?: () => void,
 *   impulses?: Array<import('../../../core/impulse-schema.js').ImpulseDecl>}} [opts]
 *   `weatherBoard`/`playerLight`/`cueDeck`/`debugStrip`, when supplied, are
 *   passed straight through as `renderWeatherBoard`/`renderPlayerLightBoard`/
 *   `renderCueDeck`/`renderDebugStrip`'s own `ctx` (weather-board.js,
 *   player-light-board.js, cue-deck.js, debug-strip.js) — this file never
 *   inspects their shape, only whether they
 *   exist. `impulses` (U7) is handed straight to `astrolabe-panel.js`'s own
 *   TR corner unchanged, same reasoning. `getFlowRate`/`onSetFlowRate`
 *   (2026-08-18 fix) back the TL corner's real speed popover — see
 *   astrolabe-panel.js's own header for why this replaced a silently-dead
 *   `onScrollToRateControl` callback.
 */
export function installRemote(opts = {}) {
  // Remote is the GM-only control room — same safety law and the same
  // debugPanel.isGM() gate as installStudio's own (ui/rooms/studio/shell.js),
  // reusing whatever it reports rather than a second isGM source of truth. A
  // non-GM client gets no DOM here at all, not even the shared token/icon-
  // sprite/stylesheet installs below (player-shell.js already calls those
  // independently, so Player is unaffected either way).
  if (typeof opts.debugPanel?.isGM === 'function' && !opts.debugPanel.isGM()) return undefined;

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
    getAnchorRect: () => (room.hidden ? null : room.getBoundingClientRect()),
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
  rendererSelect.className = 'msa-renderer-select msa-select';
  rendererSelect.append(new Option('MSA', 'msa'), new Option('Foundry (safety fallback)', 'foundry'));
  rendererSelect.title =
    'Which renderer draws the map for EVERYONE at this table — a GM-only, table-wide setting. Switch to Foundry if MSA is causing problems mid-session.';
  rendererSelect.addEventListener('change', async () => {
    rendererSelect.disabled = true;
    try {
      await opts.onRendererOverrideChange?.(rendererSelect.value);
    } catch (err) {
      setTip(rendererSelect, `Renderer switch failed — ${err?.message ?? err}`);
      // Snap back to what is actually stored — the dropdown must not keep
      // showing a renderer nobody is running (UI test pass, 2026-09-26).
      try {
        paintRendererSelect(opts.getRendererOverride?.() === 'foundry');
      } catch (_) {
        // the setting itself is unreadable; the title above already says why
      }
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
  /** @type {{refresh: () => void}|null} */
  let playerLightBoardHandle = null;
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

    if (opts.playerLight) {
      const sepPl = document.createElement('div');
      sepPl.className = 'msa-remote-sep';
      const plHost = document.createElement('div');
      plHost.className = 'msa-wx-host';
      body.append(sepPl, plHost);
      playerLightBoardHandle = renderPlayerLightBoard(plHost, opts.playerLight);
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
        btn.className = 'msa-foot-btn';
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
  raiseRoomOnPress(room);
  const positioning = makeDraggable(head, room, {
    storageKey: POSITION_STORAGE_KEY,
    getDefaultPosition: computeDefaultPosition,
  });
  // THE SCALE STRIP (2026-08-27, author: "a scaling button on the side of
  // the UI... generally helpful for people worried about screen real
  // estate"; round 2, author: "moved to the left till it sits on the
  // outside of the panel") — a sibling of `card`, not a child of it, so it
  // is never clipped by the card's own overflow:hidden.
  //
  // transformOrigin:'top left', NOT installScaleControl's own 'top right'
  // default (2026-09-07, Remote position-memory work) — that default exists
  // to pivot from whichever edge the room is actually pinned to (see its own
  // doc), and the Remote now pins by `left` (computeDefaultPosition above,
  // or a dragged/restored position), not `right`. Pivoting from the wrong
  // corner would scale this very strip AWAY from the toolbar gap it's meant
  // to sit in — at max scale (1.5x) it drifts on the order of 150-200px
  // further left, which is exactly the "off in the scenery, hard to reach"
  // failure this whole change is trying to close, and it's the strip's own
  // +/- buttons a stuck-oversized user would need to click to undo it.
  room.appendChild(installScaleControl(room, { storageKey: 'msa-remote-scale', transformOrigin: 'top left' }).root);
  // `animationend` bubbles, and cards inside the room run their own short animations —
  // only the card's OWN entrance may clear the class.
  card.addEventListener('animationend', (e) => {
    if (e.target === card) card.classList.remove('msa-enter');
  });
  // Themed tooltips for every control in the room and the popovers that hang off it (a
  // no-op on touch-first devices) — see ui/widgets/tooltip.js. Added to the Studio's, not
  // a second tooltip.
  installTooltips({ scope: REMOTE_TOOLTIP_SCOPE });

  const openChangeListeners = new Set();
  const controller = {
    open() {
      buildBody();
      // `open()` is also called while ALREADY open — that must not replay the entrance.
      const wasOpen = state.open;
      state.open = true;
      room.hidden = false;
      raiseRoom(room);
      // Rect is only real once un-hidden — see makeDraggable's own doc for
      // why this has to be called here rather than right after it's built.
      positioning.ensurePositioned();
      // A short entrance (remote-style.js), replayed on every open: drop the class, force a
      // reflow so the animation restarts, add it back; it removes itself when it ends. On the
      // CARD, not the room — the room carries the interface scale as an inline transform.
      if (!wasOpen) replayClass(card, 'msa-enter');
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
      setTip(minimizeBtn, state.minimized ? 'Expand' : 'Minimize');
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
    /** Re-sync the player-light board's mode chips/master toggle/darkness
     * slider — boot.js calls this whenever the scene's own permissions flag
     * changes (this client's own edit echoing back, a second GM's edit, a
     * scene switch), matching refreshWeatherBoard's own "never polls, it's
     * told" shape. No-op before the body exists or when no player-light
     * board was supplied. */
    refreshPlayerLightBoard() {
      playerLightBoardHandle?.refresh();
    },
    /** Repaint just the GM's "Carried Light" picker (their token selection
     * changed, or a token's light flag did) without rebuilding the board's
     * sliders. No-op before the body exists or with no player-light board. */
    refreshCarriedLightPicker() {
      playerLightBoardHandle?.refreshCarried?.();
    },
    /** Push a live weather value into the board's own fader mid-fade
     * (2026-09-10 fix) — boot.js's pumpAstrolabe calls this every tick
     * alongside syncAstrolabePanel/updateNowPlaying below, matching their
     * own "never polls, it's told" shape. No-op before the body exists or
     * when no weather board was supplied. */
    updateLiveWeatherAxisValues(values) {
      weatherBoardHandle?.updateLiveAxisValues?.(values);
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
