/**
 * ui/rooms/remote/shell.js — the Remote's room chrome (U2), rebuilt 2026-11-01
 * as a TABBED device for one job: changing the mood of a scene, before a session
 * or in the middle of one, quickly and with some joy in it.
 *
 * ============================================================================
 * THE SHAPE (author, 2026-11-01: "Tabs is preferred"; critique of the old
 * single scroll: ~1,950px of content in a 709px window, GO at the very bottom)
 * ============================================================================
 *
 *  HEADER — the scene's name; the SCOPE chip (do my changes hit this scene or
 *    every scene? — decided before anything is touched, so it sits above every
 *    tab); a heart (Patreon, quiet but always there); ⋯ (renderer, the emergency
 *    stop, camera path, size, links); minimise; close.
 *  PLAY — everything touched with players watching, sized to fit with no scroll:
 *    Now Playing (with a progress line and Snap), the dial (smaller, with a
 *    labelled transport), the LOOKS grid with the Fade Time beside it, the effect
 *    pads (Strike, Gust, next-scene transition), and the running order with GO.
 *  MIX — the faders: weather presets (Set / Wander) and the mixer, Night included.
 *  PREP — set-once things: the clock's two modes, sun path, default transition,
 *    player-light rules, the Looks library, scene tools, other modules' sections,
 *    developer tools (off unless switched on in ⋯), and the support card.
 *
 * ONE Fade Time serves Play and Mix: the control is a single element that moves
 * into whichever tab is showing, so the two can never disagree.
 *
 * Every controller method boot.js already calls is kept, so boot's per-frame pump
 * and its "you've changed, repaint" calls reach the new layout unchanged.
 *
 * @module ui/rooms/remote/shell
 */

import { installTokens } from '../../tokens.js';
import { installIconSprite, iconMarkup } from '../../widgets/icon-sprite.js';
import { makeDraggable } from '../../widgets/draggable.js';
import { installScaleControl } from '../../widgets/scale-control.js';
import { installTooltips, setTip } from '../../widgets/tooltip.js';
import { replayClass } from '../room-style.js';
import { REMOTE_ROOM_ID, REMOTE_TOOLTIP_SCOPE, remoteCss } from './remote-style.js';
import { installCameraPathPopover } from './camera-path-popover.js';
import { installWindPopover } from './wind-popover.js';
import { renderAstrolabePanel } from './astrolabe-panel.js';
import { renderWeatherBoard } from './weather-board.js';
import { renderDebugStrip } from './debug-strip.js';
import { createFadeTimeControl } from './fade-time.js';
import { renderLooksBoard, renderRunningOrder } from './looks-board.js';
import { renderPlayPads } from './play-pads.js';
import { renderPrepBoard } from './prep-board.js';
import { installMoreMenu, PATREON_URL } from './more-menu.js';
import { createReadinessCard } from './readiness-card.js';
import { installGuide, configureGuide } from '../guide/guide-room.js';
import { listRemoteSections, onRemoteSectionsChanged, buildRemoteKit } from './extension-sections.js';
import { createLogger } from '../../../core/log.js';
import { raiseRoom, raiseRoomOnPress } from '../room-stack.js';

const log = createLogger('Remote');

const ROOM_ID = REMOTE_ROOM_ID;
const STYLE_ID = 'msa-remote-style';
const POSITION_STORAGE_KEY = 'msa-remote-position';
const TAB_STORAGE_KEY = 'msa-remote-tab';
const DEVTOOLS_STORAGE_KEY = 'msa-remote-devtools';

/** The tabs, in order. */
export const REMOTE_TABS = Object.freeze([
  { id: 'play', label: 'Play', title: 'Everything you reach for mid-session: Looks, time, effects, GO.' },
  { id: 'mix', label: 'Mix', title: 'The weather and the mixer — every fader.' },
  {
    id: 'prep',
    label: 'Config',
    title:
      'Options you change now and then, not every minute: the clock, transitions, player lights, your Looks library.',
  },
]);

// THE REMOTE'S DEFAULT PLACEMENT — vertically centred on the left, clear of
// Foundry's own left toolbar (measured live; see the TOOLBAR_* notes in git
// history for why the gap is larger than it looks like it needs to be: the scale
// strip used to hang off the room's left edge — it now lives in the ⋯ menu, but
// the gap still keeps the Remote "just slightly away from the other controls").
const TOOLBAR_GAP = 24;
const TOOLBAR_CLEAR_FALLBACK = 112;

function computeDefaultPosition(rect) {
  const toolbar = document.getElementById('ui-left-column-1');
  const left = toolbar ? toolbar.getBoundingClientRect().right + TOOLBAR_GAP : TOOLBAR_CLEAR_FALLBACK;
  const top = Math.max(8, (window.innerHeight - rect.height) / 2);
  return { left, top };
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
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

function readLocal(key, fallback) {
  try {
    return window.localStorage?.getItem(key) ?? fallback;
  } catch (_) {
    return fallback; // storage blocked — the default just applies each load
  }
}
function writeLocal(key, value) {
  try {
    window.localStorage?.setItem(key, value);
  } catch (_) {
    // storage blocked — the choice simply isn't remembered
  }
}

/**
 * @param {object} [opts] — boot.js's wiring. The boards' own ctx objects
 *   (`weatherBoard`, `playerLight`, `transitionBoard`, `looks`, `debugStrip`)
 *   are passed straight through to the files that render them; this file reads
 *   only `weatherBoard.getSceneOverride/onSceneOverrideCommit` (the header's
 *   scope chip) itself.
 */
export function installRemote(opts = {}) {
  // GM-only, the same debugPanel.isGM() gate as installStudio's own.
  if (typeof opts.debugPanel?.isGM === 'function' && !opts.debugPanel.isGM()) return undefined;

  installTokens();
  installIconSprite();
  injectStyle();

  if (document.getElementById(ROOM_ID)) return document.getElementById(ROOM_ID)._msaRemoteController;

  const state = { open: false, minimized: false, tab: readLocal(TAB_STORAGE_KEY, 'play') };
  if (!REMOTE_TABS.some((t) => t.id === state.tab)) state.tab = 'play';
  let devTools = readLocal(DEVTOOLS_STORAGE_KEY, 'off') === 'on';

  const room = document.createElement('section');
  room.id = ROOM_ID;
  room.setAttribute('aria-label', 'Map Shine Remote');
  room.hidden = true;

  const card = document.createElement('div');
  card.className = 'msa-remote-card';

  // ---- header --------------------------------------------------------------
  const head = document.createElement('header');
  head.className = 'msa-remote-head';
  const title = document.createElement('span');
  title.className = 'msa-remote-title';
  const titleIcon = document.createElement('span');
  titleIcon.className = 'msa-remote-title-ico';
  titleIcon.innerHTML = iconMarkup('candle');
  const sceneName = document.createElement('span');
  sceneName.className = 'msa-remote-scene';
  title.append(titleIcon, sceneName);

  const scopeBtn = document.createElement('button');
  scopeBtn.type = 'button';
  scopeBtn.className = 'msa-scope';
  function paintScope() {
    const wb = opts.weatherBoard;
    if (typeof wb?.getSceneOverride !== 'function') {
      scopeBtn.hidden = true;
      return;
    }
    const sceneOnly = wb.getSceneOverride() === true;
    scopeBtn.innerHTML = `<span>${sceneOnly ? 'This scene' : 'All scenes'}</span>`;
    scopeBtn.dataset.scope = sceneOnly ? 'scene' : 'world';
    setTip(
      scopeBtn,
      sceneOnly
        ? 'Sky changes affect only this scene. Click to make them change the shared sky every scene uses.'
        : 'Sky changes affect every scene that uses the shared sky. Click to give this scene its own.'
    );
  }
  scopeBtn.addEventListener('click', async () => {
    const wb = opts.weatherBoard;
    scopeBtn.disabled = true;
    try {
      await wb?.onSceneOverrideCommit?.(!(wb.getSceneOverride?.() === true));
    } finally {
      scopeBtn.disabled = false;
      paintScope();
    }
  });

  const heart = document.createElement('a');
  heart.className = 'hbtn msa-heart';
  heart.href = PATREON_URL;
  heart.target = '_blank';
  heart.rel = 'noopener noreferrer';
  heart.title = 'Map Shine is made by Mythica Machina — support it on Patreon';
  heart.innerHTML = iconMarkup('heart');

  // THE HELP BUTTON (2026-11-07, Ingram: "openable from the MSA remote as a very bold
  // and obvious help button") — opens the Map Shine Guide: Quick Fixes for right now,
  // Learn for making maps. The guide gets the Remote's own closures, so its buttons
  // change the weather, the clock and the Looks exactly as the Remote does.
  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'msa-help-btn';
  helpBtn.innerHTML = `${iconMarkup('help')}<span>Help</span>`;
  helpBtn.title = 'The Map Shine Guide: quick fixes for right now, and how to make your maps shine';
  let guide = null;
  // Set now (the room itself is built on first open), so the painter's Masks list and the
  // Studio's effect cards can open the guide with working buttons too (openGuide).
  const guideCtx = {
    remote: {
      weatherBoard: opts.weatherBoard,
      onSweepToHour: opts.onSweepToHour,
      getFadeOverMs: () => fadeTime.getOverMs(),
      looks: opts.looks,
      getRendererOverride: opts.getRendererOverride,
      onRendererOverrideChange: opts.onRendererOverrideChange,
    },
    effectSetter: (name) => opts.guide?.effectSetter?.(name) ?? null,
    getHour: () => opts.guide?.getHour?.(),
    openTool: (target) => {
      if (target === 'painter' && opts.guide?.openPainter) return void opts.guide.openPainter();
      if (target === 'studio' && opts.guide?.openStudio) return void opts.guide.openStudio();
      if (target === 'remote-mix') return void controller.showTab('mix');
      return false;
    },
  };
  configureGuide(guideCtx);
  function getGuide() {
    if (guide) return guide;
    guide = installGuide(guideCtx);
    guide.onOpenChange((open) => helpBtn.setAttribute('aria-pressed', String(open)));
    return guide;
  }
  helpBtn.addEventListener('click', () => getGuide().toggle());

  const moreBtn = headerBtn('dots', 'More: renderer, camera path, size, links', () => more.toggle());
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('aria-expanded', 'false');
  const minimizeBtn = headerBtn('chev', 'Minimize', () => controller.toggleMinimize());
  const closeBtn = headerBtn('x', 'Close Remote', () => controller.close());
  const headSpacer = document.createElement('span');
  headSpacer.className = 'msa-spacer';
  head.append(title, headSpacer, helpBtn, scopeBtn, heart, moreBtn, minimizeBtn, closeBtn);

  function paintSceneName() {
    let name = '';
    try {
      name = opts.getSceneName?.() ?? '';
    } catch (_) {
      name = '';
    }
    sceneName.textContent = name || 'Map Shine';
    sceneName.title = name ? `${name} — Map Shine Remote` : 'Map Shine Remote';
  }
  paintSceneName();

  // ---- tabs ------------------------------------------------------------------
  const tabBar = document.createElement('div');
  tabBar.className = 'msa-tabs';
  tabBar.setAttribute('role', 'tablist');
  const tabButtons = new Map();
  for (const t of REMOTE_TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'msa-tab';
    b.textContent = t.label;
    b.title = t.title;
    b.setAttribute('role', 'tab');
    b.id = `msa-remote-tab-${t.id}`;
    b.addEventListener('click', () => showTab(t.id));
    tabButtons.set(t.id, b);
    tabBar.appendChild(b);
  }

  // ---- body: one pane per tab ----------------------------------------------------
  const body = document.createElement('div');
  body.className = 'msa-remote-body';
  const panes = new Map();
  for (const t of REMOTE_TABS) {
    const pane = document.createElement('div');
    pane.className = `msa-pane msa-pane-${t.id}`;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', `msa-remote-tab-${t.id}`);
    panes.set(t.id, pane);
    body.appendChild(pane);
  }

  // The one status line every board reports into (a refused GO, a saved Look, a
  // Jump that moved game time). Clears itself after a while.
  const status = document.createElement('div');
  status.className = 'msa-status';
  status.setAttribute('aria-live', 'polite');
  let statusTimer = null;
  function onStatus(text) {
    status.textContent = text ?? '';
    status.hidden = !text;
    if (statusTimer) clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => onStatus(''), 7000);
  }
  onStatus('');

  // THE SCENE READINESS CARD (MSA Ready, 2026-11-01) — above the tabs, on every
  // tab, only while the scene is not ready; boot.js feeds it (`setReadiness`).
  const readinessHost = document.createElement('section');
  const readiness = createReadinessCard(readinessHost);
  let lastReadiness = null;
  let lastReadinessActions = {};

  card.append(head, readinessHost, tabBar, body, status);

  // ---- the shared Fade Time ------------------------------------------------------
  const fadeTime = createFadeTimeControl(1);
  const fadeEnv = { getFadeOverMs: fadeTime.getOverMs, getFadeLabel: fadeTime.getLabel, onStatus };
  /** tab id -> the slot the Fade Time control moves into on that tab. */
  const fadeSlots = new Map();

  // ---- popovers + the ⋯ menu ---------------------------------------------------------
  const camPath = installCameraPathPopover({
    getAnchorRect: () => (room.hidden ? null : room.getBoundingClientRect()),
  });
  const windPopover = installWindPopover({
    getDirectionDeg: opts.windPopover?.getDirectionDeg,
    onCommit: (v) => opts.windPopover?.onCommit?.(v),
    getAnchorRect: () => (room.hidden ? null : room.getBoundingClientRect()),
  });
  const scale = installScaleControl(room, { storageKey: 'msa-remote-scale', transformOrigin: 'top left' });
  const more = installMoreMenu(moreBtn, card, {
    getRendererOverride: opts.getRendererOverride,
    onRendererOverrideChange: opts.onRendererOverrideChange,
    onEngageSafety: opts.onEngageSafety,
    onCameraPath: () => camPath.toggle(),
    scaleStrip: scale.root,
    getDevTools: () => devTools,
    onDevTools: (on) => {
      devTools = on;
      writeLocal(DEVTOOLS_STORAGE_KEY, on ? 'on' : 'off');
      prep?.setDevTools(on);
      if (on) showTab('prep');
    },
  });

  // ---- lazily built content (first open(), after boot's closures exist) -------------
  let bodyBuilt = false;
  let npLabel = null;
  let npBar = null;
  let npSnap = null;
  let astrolabe = null;
  let astroHome = null;
  let playMixerHandle = null;
  let mixAstroAnchor = null;
  let looksBoard = null;
  let runningOrder = null;
  let pads = null;
  let weatherBoardHandle = null;
  let prep = null;
  let debugStripHandle = null;
  let extensionHost = null;
  /** @type {Array<{destroy?: () => void, refresh?: () => void}|null>} */
  let extensionHandles = [];

  /**
   * SECTIONS OTHER MODULES REGISTERED (extension-sections.js), drawn in Prep, each
   * under its own title. One that throws is replaced by a note, never allowed to
   * take the rest of the Remote down with it.
   */
  function renderExtensionSections() {
    if (!extensionHost) return;
    for (const handle of extensionHandles) {
      try {
        handle?.destroy?.();
      } catch (err) {
        log.error('a Remote section failed to clean up:', err);
      }
    }
    extensionHandles = [];
    extensionHost.replaceChildren();
    const kit = buildRemoteKit(document);
    for (const section of listRemoteSections({ isGM: true })) {
      const host = document.createElement('div');
      host.className = 'msa-wx-host msa-prep-sec';
      const content = document.createElement('div');
      content.className = 'msa-ext-content';
      host.append(kit.label(section.title), content);
      extensionHost.append(host);
      try {
        extensionHandles.push(section.render(content, { kit, isGM: true }) ?? null);
      } catch (err) {
        log.error(`the Remote section "${section.id}" failed to render:`, err);
        content.append(kit.note(`${section.title} could not be shown (see the console).`));
      }
    }
  }

  /** Strike lights the whole card for a blink — the pad answers back. */
  function flash() {
    card.classList.add('msa-flash');
    setTimeout(() => card.classList.remove('msa-flash'), 90);
  }

  function buildBody() {
    if (bodyBuilt) return;
    bodyBuilt = true;
    try {
      more.paintRenderer(opts.getRendererOverride?.() === 'foundry');
    } catch (_) {
      // read before Foundry's init — the menu repaints when opened
    }

    // ---- PLAY ----
    const play = panes.get('play');
    const np = document.createElement('div');
    np.className = 'msa-now-playing';
    const npIcon = document.createElement('span');
    npIcon.innerHTML = iconMarkup('sun');
    npLabel = document.createElement('span');
    npLabel.className = 'msa-np-label';
    npLabel.textContent = 'Steady';
    npSnap = document.createElement('button');
    npSnap.type = 'button';
    npSnap.className = 'msa-np-snap';
    npSnap.textContent = 'Finish now';
    npSnap.title = 'Land every fade in flight right now';
    npSnap.hidden = true;
    npSnap.addEventListener('click', () => {
      const any = opts.onSnapFades?.();
      onStatus(any ? '' : 'Nothing was fading.');
    });
    npBar = document.createElement('span');
    npBar.className = 'msa-np-bar';
    np.append(npIcon, npLabel, npSnap, npBar);
    play.appendChild(np);

    astrolabe = renderAstrolabePanel(play, {
      compact: true,
      mountAstrolabeDial: opts.mountAstrolabeDial ?? (() => {}),
      getPosture: opts.getPosture ?? (() => 'aesthetic'),
      onSetMode: opts.onSetMode ?? (() => {}),
      isFlowPlaying: opts.isFlowPlaying ?? (() => false),
      onFlowToggle: opts.onFlowToggle ?? (() => {}),
      getFlowRate: opts.getFlowRate ?? (() => 0),
      onSetFlowRate: opts.onSetFlowRate ?? (() => {}),
      onSweepToHour: (hour) => opts.onSweepToHour?.(hour, fadeTime.getOverMs()),
      onWindClick: () => windPopover.toggle(),
    });

    // The astrolabe is one dial that mounts once: it lives under Play's Now Playing bar and
    // travels to the top of Mix (showTab) so the clock is in reach while mixing weather.
    if (astrolabe?.root) {
      astroHome = document.createComment('astrolabe-home');
      astrolabe.root.after(astroHome);
    }

    // The faders, in a closed accordion under the astrolabe: a second, faders-only weather
    // board, so Play can nudge rain/cloud/wind without a trip to Mix.
    if (opts.weatherBoard && astroHome) {
      const acc = document.createElement('details');
      acc.className = 'msa-acc';
      const sum = document.createElement('summary');
      sum.innerHTML = `${iconMarkup('gauge')}<span>Sliders</span>`;
      const accBody = document.createElement('div');
      accBody.className = 'msa-acc-body msa-wx-host';
      acc.append(sum, accBody);
      astroHome.after(acc);
      playMixerHandle = renderWeatherBoard(accBody, {
        ...opts.weatherBoard,
        externalFade: fadeTime,
        scopeInHeader: true,
        hideSunLatitude: true,
        mixerOnly: true,
      });
    }

    if (opts.looks) {
      looksBoard = renderLooksBoard(play, opts.looks, fadeEnv);
      fadeSlots.set('play', looksBoard.fadeSlot);
    }
    pads = renderPlayPads(play, {
      impulses: opts.impulses ?? [],
      transitionBoard: opts.transitionBoard,
      onStatus,
      onFlash: flash,
    });
    if (opts.looks) runningOrder = renderRunningOrder(play, opts.looks, fadeEnv);

    // ---- MIX ----
    const mix = panes.get('mix');
    const mixHead = document.createElement('div');
    mixHead.className = 'msa-section-head';
    const mixTitle = document.createElement('span');
    mixTitle.className = 'msa-section-title';
    mixTitle.innerHTML = `${iconMarkup('clock')}<span>Changes ease over</span>`;
    const mixFadeSlot = document.createElement('div');
    mixFadeSlot.className = 'msa-fade-slot';
    mixHead.append(mixTitle, mixFadeSlot);
    mix.appendChild(mixHead);
    mixAstroAnchor = mixHead;
    fadeSlots.set('mix', mixFadeSlot);
    if (opts.weatherBoard) {
      const wxHost = document.createElement('div');
      wxHost.className = 'msa-wx-host';
      mix.appendChild(wxHost);
      weatherBoardHandle = renderWeatherBoard(wxHost, {
        ...opts.weatherBoard,
        externalFade: fadeTime,
        scopeInHeader: true,
        hideSunLatitude: true,
      });
    }

    // ---- PREP ----
    prep = renderPrepBoard(panes.get('prep'), {
      getPosture: opts.getPosture,
      onSetMode: opts.onSetMode,
      onClockModeChanged: () => astrolabe?.syncFlowState(),
      getSunLatitude: opts.weatherBoard?.getSunLatitude,
      onSunLatitudeCommit: opts.weatherBoard?.onSunLatitudeCommit,
      transitionBoard: opts.transitionBoard,
      playerLight: opts.playerLight,
      looks: opts.looks,
      onCameraPath: () => camPath.toggle(),
      onOpenTileMotion: opts.onOpenTileMotion,
    });
    extensionHost = prep.extensionHost;
    renderExtensionSections();
    onRemoteSectionsChanged(renderExtensionSections);
    if (opts.debugStrip) debugStripHandle = renderDebugStrip(prep.debugHost, opts.debugStrip);
    prep.setDevTools(devTools);

    showTab(state.tab);
  }

  function showTab(id) {
    state.tab = id;
    writeLocal(TAB_STORAGE_KEY, id);
    for (const [tid, b] of tabButtons) {
      b.setAttribute('aria-selected', String(tid === id));
      b.tabIndex = tid === id ? 0 : -1;
    }
    for (const [tid, pane] of panes) pane.hidden = tid !== id;
    if (astrolabe?.root && astroHome?.parentNode && mixAstroAnchor) {
      if (id === 'mix') {
        if (astrolabe.root.previousSibling !== mixAstroAnchor) mixAstroAnchor.after(astrolabe.root);
      } else if (astroHome.previousSibling !== astrolabe.root) {
        astroHome.before(astrolabe.root);
      }
    }
    const slot = fadeSlots.get(id);
    if (slot && fadeTime.root.parentElement !== slot) slot.appendChild(fadeTime.root);
    body.scrollTop = 0;
  }
  // Arrow keys move between tabs (the tablist pattern).
  tabBar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const ix = REMOTE_TABS.findIndex((t) => t.id === state.tab);
    const next = REMOTE_TABS[(ix + (e.key === 'ArrowRight' ? 1 : REMOTE_TABS.length - 1)) % REMOTE_TABS.length];
    showTab(next.id);
    tabButtons.get(next.id)?.focus();
    e.preventDefault();
  });
  // A Fade Time pick repaints whatever names it (the running order's "fades over 10s").
  fadeTime.root.addEventListener('click', () => runningOrder?.refresh());

  room.appendChild(card);
  document.body.appendChild(room);
  raiseRoomOnPress(room);
  const positioning = makeDraggable(head, room, {
    storageKey: POSITION_STORAGE_KEY,
    getDefaultPosition: computeDefaultPosition,
  });
  card.addEventListener('animationend', (e) => {
    if (e.target === card) card.classList.remove('msa-enter');
  });
  installTooltips({ scope: REMOTE_TOOLTIP_SCOPE });

  const openChangeListeners = new Set();
  const controller = {
    open() {
      buildBody();
      const wasOpen = state.open;
      state.open = true;
      room.hidden = false;
      raiseRoom(room);
      paintSceneName();
      paintScope();
      positioning.ensurePositioned();
      if (!wasOpen) replayClass(card, 'msa-enter');
      for (const fn of openChangeListeners) fn(true);
    },
    close() {
      state.open = false;
      room.hidden = true;
      camPath.close();
      windPopover.close();
      more.close();
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
      if (state.minimized) more.close();
    },
    isOpen: () => state.open,
    onOpenChange(fn) {
      openChangeListeners.add(fn);
    },
    /** Which tab is showing. */
    getTab: () => state.tab,
    /** Show a tab ('play' | 'mix' | 'prep'). */
    showTab(id) {
      if (REMOTE_TABS.some((t) => t.id === id)) {
        buildBody();
        showTab(id);
      }
    },
    /** boot.js's per-frame pump: the Now Playing text and how far the fade has got
     * (`progress01` null = nothing in flight). */
    updateNowPlaying({ label, progress01 } = {}) {
      if (!bodyBuilt) return;
      if (label && npLabel.textContent !== label) {
        npLabel.textContent = label;
        npLabel.title = label;
      }
      const fading = Number.isFinite(progress01);
      if (npSnap.hidden === fading) npSnap.hidden = !fading;
      npBar.style.setProperty('--p', fading ? String(Math.max(0, Math.min(1, progress01))) : '0');
      npBar.dataset.on = String(fading);
      looksBoard?.syncFading();
    },
    /** The weather board, the scope chip and the scene name (a fade landed, a
     * second client's edit, a scene switch). */
    refreshWeatherBoard() {
      weatherBoardHandle?.refresh();
      playMixerHandle?.refresh();
      paintScope();
      paintSceneName();
    },
    refreshPlayerLightBoard() {
      prep?.playerLight?.refresh();
    },
    refreshTransitionBoard() {
      prep?.refreshTransitions();
      pads?.refresh();
    },
    refreshCarriedLightPicker() {
      prep?.playerLight?.refreshCarried?.();
    },
    updateLiveWeatherAxisValues(values) {
      weatherBoardHandle?.updateLiveAxisValues?.(values);
      playMixerHandle?.updateLiveAxisValues?.(values);
    },
    /** The Looks grid, the running order, the library list and the scene name. */
    refreshLooks() {
      looksBoard?.refresh();
      runningOrder?.refresh();
      prep?.refreshLooks();
      paintSceneName();
    },
    /** The old cue deck's repaint call — the running order replaced it. */
    refreshCueDeck() {
      controller.refreshLooks();
    },
    syncAstrolabePanel() {
      astrolabe?.syncFlowState();
      prep?.refreshClock();
    },
    updateDebugStrip(snapshot) {
      debugStripHandle?.update(snapshot);
    },
    updateRendererState(isFoundryRendering) {
      more.paintRenderer(isFoundryRendering);
    },
    /** The shared Fade Time, in ms (`0` = Cut). Pulled by boot.js's dial handlers. */
    getFadeOverMs() {
      return fadeTime.getOverMs();
    },
    /** MSA Ready: show (or clear) the Scene readiness card. `model` is
     * scene/scene-readiness.js#buildSceneReadiness's result; `actions` its buttons. */
    setReadiness(model, actions) {
      lastReadiness = model ?? null;
      if (actions) lastReadinessActions = actions;
      readiness.render(lastReadiness, { ...lastReadinessActions, onGuide: (page) => getGuide().open(page) });
    },
    /** Repaint the card with the last model (e.g. the painter opened or closed). */
    refreshReadiness(patch = {}) {
      lastReadinessActions = { ...lastReadinessActions, ...patch };
      readiness.render(lastReadiness, { ...lastReadinessActions, onGuide: (page) => getGuide().open(page) });
    },
  };
  room._msaRemoteController = controller;
  return controller;
}
