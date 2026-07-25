/**
 * src/diag/debug-panel.js — the Map Shine Advanced control panel (Tier 0 shell).
 *
 * WHAT THIS IS NOW (2026-07-20): the single control surface from
 * docs/planning/Control-Panel.md — a SHELL with a five-zone icon rail:
 * Bridge · Workshop · Toolbox · Lab · Settings. Only the LAB is fully built —
 * it is the debug registry described below, unchanged. The other four zones show
 * their few already-working controls beside 🚧 stubs: the scaffold for working
 * out the final arrangement before the real (Effects-UI / astrolabe) renderers
 * land. The public API (registerReport/registerAction/registerSelect) is
 * unchanged; an entry is routed to a zone by the ZONES map (default: Lab), so
 * every existing registration keeps working with no change at the call site.
 * A FOURTH primitive, `registerPanel` (2026-07-22), renders a rich composite
 * DOM block instead of a button/dropdown — an effect's whole FOH/ROH config
 * card (`diag/effect-controls.js`), so registering one is still one call.
 *
 * PERMISSION IS A FILTER, NOT A FORK (Control-Panel.md §2, landed 2026-07-20):
 * `isGM()` below reads the one live fact (`game.user.isGM`); a non-GM sees only
 * the Settings icon (the whole rail hides itself when there is nothing to
 * choose between) and the panel opens straight into it. A GM sees all five —
 * this file has exactly ONE render path for both, never a duplicated layout.
 * Opening/closing is driven by the scene-controls toolbar button
 * (foundry/scene-controls-button.js) via `showPanel`/`hidePanel`/`togglePanel`;
 * the panel itself decides its OWN default (open for a GM, closed for a
 * player) the moment it attaches, per the author's standing directive to keep
 * that GM auto-open until the module ships and it becomes a real setting.
 *
 * Lives in the same corner box as the boot heartbeat. A growing set of
 * buttons, one per registered "report" — click one and its output is copied
 * to the clipboard as text, ready to paste back into chat. This is the
 * standing debugging protocol for the rest of the Keyhole build: when
 * something breaks, the fix comes with "run report X (and Y)" instead of "can
 * you paste your console" — structured, consistent, and it survives across
 * stages because any future module can register its own report.
 *
 * Extensible on purpose: `MapShine.debug.registerReport(id, label, fn)` is
 * public — vt/, graph/, foundry/ etc. each add their own reports as they're
 * built, without editing this file again.
 *
 * ============================================================================
 * REPORTS vs ACTIONS — a split with teeth, added 2026-07-17
 * ============================================================================
 *
 * Every button used to be a "report". Ten of the twenty were not: `soak` ran 3
 * full cycles, `vt-pan-viewer-start` launched the torture fixture,
 * `vt-pan-viewer-stop` tore down the live viewer, the zoom-thrash pair each
 * hammered the camera for ~4 seconds, and `loading-screen-arm` mutated the
 * curtain's memory. They shared one registry with genuinely passive readouts
 * like `tokens` and `interface-seam`.
 *
 * That was survivable while every button was pressed by hand, one at a time. It
 * stopped being survivable the moment the flight recorder wanted to run "every
 * report" on one click to build its export: that click would have restarted the
 * user's scene and run a soak.
 *
 * So the two kinds are now two registries:
 *   - {@link registerReport} — a PURE READOUT. Reads state, returns data,
 *     changes nothing. The flight recorder runs all of these, automatically,
 *     forever, with nobody maintaining a list.
 *   - {@link registerAction} — DOES something. Never run by the exporter.
 *
 * The contract is the load-bearing part: if a side-effecting thing is registered
 * as a report, the exporter will run it. Register actions as actions.
 *
 * Console capture used to live here (warn/error only, 200 entries). It moved to
 * `diag/flight-recorder.js`, which captures every level from every source — the
 * old buffer kept the complaints and threw away the plot.
 */

import { createLogger } from '../core/log.js';
// The panel's reusable DOM vocabulary (drag, stylesheet, the shared control
// builders, the Tier-0 zone scaffold), split out 2026-07-25 — the size-ratchet
// god-object reversal; this file was 1,321 lines / a 1,249-line closure.
import {
  makeDraggable,
  ensurePanelStyle,
  sectionLabel,
  zoneIntro,
  createControlBuilders,
  REPORT_SKIN,
  ACTION_SKIN,
} from './debug-panel-controls.js';

export function installDebugPanel(MapShine) {
  if (MapShine.debug) return MapShine.debug; // idempotent

  // core/log.js (log/one-door): this file's OWN pre-existing console.* calls
  // are pre-2026-07-22 ratcheted debt (tools/verify-structure.mjs names this
  // file in that ratchet's backlog comment) — not this change's to clean up.
  // NEW call sites (registerPanel's build-failure guard) go through the door.
  const log = createLogger('debug-panel');

  const reports = new Map(); // id -> { label, fn } — PURE READOUTS. The exporter runs these.
  const actions = new Map(); // id -> { label, fn } — side effects. The exporter never runs these.
  const controls = new Map(); // id -> { label, options, getValue, onChange } — live controls, rendered first
  const panels = new Map(); // id -> { label, buildFn } — a rich composite DOM block (Effects-UI.md FOH/ROH cards); see registerPanel

  function envelope(id, payload) {
    return {
      report: id,
      generatedAt: new Date().toISOString(),
      msaVersion: MapShine.version,
      codename: MapShine.codename,
      ...payload,
    };
  }

  /**
   * @param {string} id - stable slug, becomes the button's data attribute.
   * @param {string} label - button text.
   * @param {() => (object|string|Promise<object|string>)} fn - report body.
   *   Return an object (auto-JSON-formatted) or a preformatted string.
   */
  /**
   * A LIVE CONTROL, not a report: a labelled dropdown that DOES the thing on change.
   *
   * Exists because the bisect ladder grew into twelve buttons that each needed a
   * SECOND button pressed afterwards, which the author rightly called out: "There's
   * no good reason to press two buttons if the next action would automatically and
   * always be to press another button, that's not good design." If an action always
   * follows, it is part of the action -- so onChange performs it.
   *
   * @param {string} id
   * @param {string} label
   * @param {Array<{value: string, label: string}> | (() => Array<{value: string, label: string}>)} options
   *   A fixed list, or a THUNK re-read every time the dropdown is opened. The thunk
   *   form exists for controls whose choices don't exist yet at registration and
   *   change as the session runs -- e.g. "isolate one draw item", whose items only
   *   appear once a scene loads and change whenever it does. A baked-in array there
   *   would render an empty, permanently-wrong menu.
   * @param {() => string} getValue - the current value, so the control reflects REAL
   *   state (including state restored from a previous page load) rather than assuming
   *   it starts at the first option.
   * @param {(value: string) => any} onChange
   */
  function registerSelect(id, label, options, getValue, onChange, opts = {}) {
    controls.set(id, { label, options, getValue, onChange, group: opts.group });
    if (bodyEl) renderBody();
  }

  /**
   * Re-sync every registered select's DISPLAYED value against its live
   * `getValue()`, without waiting for the author to open the dropdown.
   *
   * WHY THIS EXISTS (2026-07-19, author-reported): a select's `fill()` (the
   * closure that reads `getValue()` and paints it) only ran at REGISTRATION
   * time and again on `mousedown` (see renderButtons' own comment: "re-read
   * on open"). Most controls — including "Renderer", whose `getValue()`
   * reads `environmentRenderable`, a scene-load-dependent fact — are
   * registered during boot, BEFORE the interface seam / art suppression has
   * actually settled. So the panel's FIRST paint showed whatever was true at
   * that early instant (often "Foundry", since MSA hadn't suppressed PIXI's
   * art yet), and nothing ever repainted it — the label went stale the
   * moment reality changed underneath it, exactly the "instrument that lies"
   * class this project treats as a real bug (feedback_instruments_must_not_
   * lie), not a cosmetic one. Call this after any event that could change a
   * control's underlying state (scene load, floor switch, a lever toggled
   * via console) — `syncInterfaceSeam` in boot.js calls it after every
   * `applyArtSuppression()`/`restoreFoundryArt()` attempt, seam settled or not.
   */
  function refreshControls() {
    if (bodyEl) renderBody();
  }

  /**
   * A RICH PANEL — a composite DOM block a report/action/select cannot
   * express (Effects-UI.md's FOH/ROH effect card: sliders, a colour swatch,
   * an "Advanced" disclosure, together). Exists so registering an effect's
   * config UI is `registerPanel(id, label, () => buildEffectCard({...}))` —
   * ONE line, same velocity-test spirit as the registry's own "one manifest +
   * one schema + one registry line" (Effect-Registration.md §6) — rather than
   * hand-laying-out a card in this file per effect, which is exactly the
   * hand-wiring disease this whole panel exists to avoid.
   *
   * `buildFn` is called FRESH on every render (same contract as `makeControl`/
   * `makeRunnable` below) and must return a plain `HTMLElement` — this file
   * never inspects or mutates it, it only mounts it. A panel that needs to
   * reflect state changed elsewhere calls `MapShine.debug.refreshControls()`,
   * the same "instrument must not lie" mechanism every other live control uses.
   *
   * @param {string} id
   * @param {string} label - shown nowhere yet (panels render unlabelled, full-width); kept for parity with the other three registries and future use (e.g. an index/search).
   * @param {() => HTMLElement} buildFn
   */
  function registerPanel(id, label, buildFn, opts = {}) {
    panels.set(id, { label, buildFn, group: opts.group, zone: opts.zone });
    if (bodyEl) renderBody();
  }

  /**
   * A PURE READOUT. Reads state, returns data, **changes nothing**.
   *
   * ⚠ THE CONTRACT, and it is load-bearing: the flight recorder runs EVERY
   * registered report, automatically, whenever the author exports a bundle. That
   * is what makes the export cover the whole system without anyone maintaining a
   * list of what to include — and it is only safe because a report is passive.
   *
   * If the thing you are registering starts, stops, resets, cycles, thrashes or
   * otherwise DOES something, it is an {@link registerAction}, not a report.
   * Registering it here means it fires on every export.
   *
   * @param {string} id - stable slug, becomes the button's data attribute.
   * @param {string} label - button text.
   * @param {() => (object|string|Promise<object|string>)} fn - report body.
   *   Return an object (auto-JSON-formatted) or a preformatted string.
   */
  function registerReport(id, label, fn, opts = {}) {
    reports.set(id, { label, fn, group: opts.group, primary: opts.primary });
    if (bodyEl) renderBody();
  }

  /**
   * A BUTTON THAT DOES SOMETHING — starts the viewer, runs a soak, thrashes the
   * zoom, resets a memory. Rendered like a report and still returns its result to
   * the clipboard, but the flight recorder NEVER runs it: an export must not
   * restart the author's scene.
   *
   * @param {string} id
   * @param {string} label
   * @param {() => (object|string|Promise<object|string>)} fn
   */
  function registerAction(id, label, fn, opts = {}) {
    actions.set(id, { label, fn, group: opts.group, primary: opts.primary });
    if (bodyEl) renderBody();
  }

  /**
   * Run a registered report OR action by id.
   * @param {string} id
   * @returns {Promise<string>}
   */
  async function runReport(id) {
    const entry = reports.get(id) ?? actions.get(id);
    if (!entry) throw new Error(`debug-panel: unknown report or action "${id}"`);
    const result = await entry.fn();
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return text;
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        /* fall through */
      }
    }
    // Fallback for contexts where the async Clipboard API is unavailable.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  // ---- UI ------------------------------------------------------------------
  let panelEl = null;
  let statusEl = null;
  let bodyEl = null; // the ACTIVE zone's content — re-rendered on zone switch and on every registration
  let railEl = null; // the zone rail (built once); its highlight updates on zone switch
  let shellRowEl = null; // rail + body; hidden when the panel is collapsed
  let zoneHeadEl = null; // the active zone's title/subtitle strip
  let footerEl = null;
  let collapsed = false;
  // The shell opens on the Bridge for a GM (the design's home per
  // docs/planning/Control-Panel.md) or Settings for a player — set for real in
  // buildUI(), once game.user is readable. The Lab (today's debug registry) is
  // one rail-click away for a GM, never reachable for a player.
  let activeZone = 'bridge';
  // Whole-panel visibility (the scene-controls toolbar button + its own Close
  // button both drive this) — SEPARATE from `collapsed`, which only shrinks it
  // to its header bar. A closed panel is not in the document flow at all.
  // Starts `null` (not `false`) so the FIRST setPanelVisible call always
  // applies its CSS — the panel's own base style defaults to visible, and a
  // real write is what actually hides it for a player.
  let panelVisible = null;
  let visibilityListener = null; // notified on every showPanel/hidePanel/togglePanel — see onVisibilityChange

  /**
   * The one live fact permission is filtered on (Control-Panel.md §2). Reads
   * `game.user.isGM` directly — `diag/` is one of the two zones the
   * `foundry/adapter-only` wall exempts, exactly for live reads like this one.
   * Falls back to true outside a Foundry context (Node harnesses, no `game`
   * global) so nothing here becomes untestable.
   */
  function isGM() {
    return typeof game !== 'undefined' ? !!game.user?.isGM : true;
  }

  /** Show/hide the whole panel (not the heartbeat/FPS strip above it — that
   * stays up independently) and tell whoever is listening (the scene-controls
   * toolbar button) so its highlight never drifts from what's actually on
   * screen — the same "don't let a control lie about live state" rule as
   * `refreshControls` above, applied to visibility instead of a dropdown. */
  function setPanelVisible(next) {
    if (panelVisible === next) return;
    panelVisible = next;
    if (panelEl) panelEl.style.display = panelVisible ? 'flex' : 'none';
    visibilityListener?.(panelVisible);
  }
  function showPanel() {
    setPanelVisible(true);
  }
  function hidePanel() {
    setPanelVisible(false);
  }
  function togglePanel() {
    setPanelVisible(!panelVisible);
  }
  function isPanelVisible() {
    return !!panelVisible;
  }
  /** @param {(visible: boolean) => void} fn */
  function onVisibilityChange(fn) {
    visibilityListener = fn;
  }

  // Accordion layout — PRESENTATION ONLY (media ladder L4, cosmetic). A
  // mis-grouped button still works; it just lands visibly in "More". Nothing
  // load-bearing rides this map, so it is deliberately NOT the health-wiring
  // anti-pattern the postmortem warns about (a hand-maintained id->behaviour
  // table that fails SILENTLY). A registration MAY self-declare `{ group }` /
  // `{ primary }` to override these defaults; unlisted ids fall into "More",
  // never a wrong folder. Array order here IS the on-screen folder order.
  const PRIMARY = new Set(['pixel-probe']); // quick-reach; "Export everything" is primary by construction
  const FOLDERS = [
    { id: 'levers', title: 'Levers', icon: '🎚️', ids: [] }, // live selects default here
    {
      id: 'health',
      title: 'Health & baseline',
      icon: '📊',
      ids: ['stage-gate-baseline', 'pass-graph-health', 'environment', 'boot', 'console', 'loading-screen-state'],
    },
    {
      id: 'scene',
      title: 'Scene & masks',
      icon: '🎨',
      ids: [
        'vt-pan-viewer-diagnostics',
        'vt-pan-viewer-layers',
        'vt-canvas-census',
        'mask-authority',
        'pixi-residency-report',
      ],
    },
    {
      id: 'foundry',
      title: 'Foundry parity',
      icon: '🪟',
      ids: ['interface-seam', 'interface-preview-leak', 'fog-of-war-census', 'tokens'],
    },
    {
      id: 'run',
      title: 'Run & stress',
      icon: '▶️',
      ids: [
        'vt-pan-viewer-start-real-scene',
        'vt-pan-viewer-stop',
        'vt-zoom-thrash-active',
        'vt-live-decode',
        'orientation-self-test',
        'soak',
      ],
    },
  ];
  const openFolders = new Set(); // folder ids the author has expanded; preserved across re-renders

  // ---- THE FIVE ZONES (docs/planning/Control-Panel.md) ---------------------
  // The rail switches between them; every registered report/action/select is
  // routed to exactly ONE zone. This is presentation-only config, exactly like
  // FOLDERS above — a mis-routed id still works, it just shows in the wrong
  // zone. The DEFAULT zone is 'lab' (the dev suite = the debug registry), so a
  // newly-registered diagnostic needs no entry here. Only the Lab is fully
  // built; the four product zones are 🚧-stubbed scaffolds for now.
  const ZONE_ORDER = ['bridge', 'workshop', 'toolbox', 'lab', 'settings'];
  const ZONE_META = {
    bridge: { icon: '🧭', tag: 'Bridge', title: 'The Bridge', sub: 'live world control' },
    workshop: { icon: '🔥', tag: 'Make', title: 'The Workshop', sub: 'add & author effects' },
    toolbox: { icon: '🧰', tag: 'Tools', title: 'The Toolbox', sub: 'occasional utilities' },
    lab: { icon: '🔬', tag: 'Lab', title: 'The Lab', sub: 'diagnostics & dev tools', dev: true },
    settings: { icon: '⚙️', tag: 'Setup', title: 'Settings', sub: 'graphics & performance' },
  };
  /** The permission filter (Control-Panel.md §2): a GM gets all five zones; a
   * player gets exactly one. Everything downstream (the rail, the default
   * zone, whether the rail even renders) reads THIS, never `isGM()` directly —
   * one seam if the player's set ever grows past Settings alone. */
  const visibleZones = () => (isGM() ? ZONE_ORDER : ['settings']);
  // id → zone override; unlisted ids default to 'lab'. These are the handful of
  // already-working controls that belong in a product zone, not the dev suite —
  // so each product zone shows at least one real control beside its stubs.
  const ZONES = {
    'darkness-realism': 'bridge',
    'render-compare': 'bridge',
    'camera-path-open': 'bridge',
    paint: 'workshop',
    anchors: 'workshop',
    'live-markers-toggle': 'workshop',
    'candle-markers-once': 'workshop',
    'wind-overlay-toggle': 'workshop',
    'wind-overlay-resolution': 'workshop',
    'wind-particles-toggle': 'workshop',
    // ('wind-ambient-direction'/'wind-ambient-speed' were routed here until
    // 2026-07-23; the astrolabe replaced both and they are deleted, not moved.)
    astrolabe: 'bridge',
    'wind-rebake': 'workshop',
    'wind-test-gust': 'workshop',
    'wind-force-thaw': 'workshop',
    'wind-sim-status': 'workshop',
    'loading-screen-arm': 'toolbox',
    'loading-screen-state': 'toolbox',
    'ui-shadow': 'settings',
    'ui-shadow-status': 'settings',
  };
  const zoneOf = (id, entry) => entry.zone ?? ZONES[id] ?? 'lab';

  const ZONE_INTRO = {
    bridge:
      'Steer the world live. The <b style="color:#cfe0f5">astrolabe</b> (time &amp; wind) is the hero here; a couple of real world levers work today.',
    workshop:
      'Add an effect and paint it where it belongs. <b style="color:#cfe0f5">Painting masks works today</b>; the effect gallery + “need fire” flow are planned.',
    toolbox:
      'Occasional GM utilities. The loading-screen tools work today; the rest are planned (confirm-first where heavy).',
    settings:
      'Graphics &amp; performance — the player-facing face. <b style="color:#cfe0f5">Window shadows work today</b>; the profile + per-effect rows are planned.',
  };
  // The 🚧 stub scaffold per product zone — labels the author is arranging, not
  // wired to anything. See renderProductZone.
  const STUBS = {
    bridge: { quick: ['Toggle darkness', 'Recall camera', 'Floor ▸', 'Streaming minimap'] },
    // Candles graduated from stub to a real registered panel (boot.js) — no
    // longer listed here; every other entry is still 🚧 planned.
    workshop: { gallery: ['Fire', 'Water', 'Fog', 'Dust', 'Lightning', 'Smoke', 'Puddles', 'Glow'] },
    toolbox: {
      items: [
        'Texture Manager',
        'Effect Stack',
        'Apply look to all scenes…',
        'Package-readiness check',
        'Scene Reset',
        'Scene Recovery',
      ],
    },
    settings: {
      profile: ['Low', 'Performance', 'Standard', 'Quality', 'Extreme'],
      effects: ['Fire', 'Water', 'Lightning'],
    },
  };

  /**
   * Make `handle` drag whatever `getHost()` returns.
   *
   * Two details that matter more than the dragging itself:
   *
   * 1. **Anchor swap.** The host is positioned with `right`/`bottom`. Writing
   *    `left`/`top` while those are still set pins BOTH edges, which stretches the
   *    element instead of moving it. On the first drag we read the live rect and
   *    switch to `left`/`top` anchoring, so the box moves rather than resizes.
   * 2. **Clamped to the viewport.** A panel dragged off-screen cannot be dragged
   *    back — the handle goes with it. Clamping keeps a grabbable strip on screen
   *    always, so this can't become an unrecoverable state.
   *
   * @param {HTMLElement} handle
   * @param {() => HTMLElement|null|undefined} getHost
   * @returns {() => number} total pointer travel of the last gesture (for the
   *   click-vs-drag test).
   */
  // The shared control builders, bound to this panel's registries. `statusEl`
  // is passed as a GETTER, not a value: it does not exist until buildUI runs.
  const { makeButton, makeRunnable, makeControl, folderOf, stubRow, stubGallery, stubSegmented } =
    createControlBuilders({
      runReport,
      copyToClipboard,
      getStatusEl: () => statusEl,
      PRIMARY,
      FOLDERS,
    });

  function buildFooter() {
    const foot = document.createElement('div');
    Object.assign(foot.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      flexWrap: 'wrap',
      marginTop: '8px',
      paddingTop: '6px',
      borderTop: '1px solid rgba(143,214,255,0.16)',
      fontSize: '10px',
    });
    const link = (href, text, color) => {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = text;
      Object.assign(a.style, { color, textDecoration: 'none', pointerEvents: 'auto', fontWeight: '600' });
      a.addEventListener('mouseenter', () => (a.style.textDecoration = 'underline'));
      a.addEventListener('mouseleave', () => (a.style.textDecoration = 'none'));
      return a;
    };
    foot.appendChild(link('https://www.patreon.com/c/MythicaMachina', '❤ Patreon', '#ff6b74'));
    foot.appendChild(link('https://github.com/Garsondee/map-shine-advanced/issues', '🐛 Report a bug', '#8fd6ff'));
    const cred = document.createElement('span');
    cred.textContent = MapShine.codename ? `“${MapShine.codename}”` : 'Mythica Machina';
    Object.assign(cred.style, { marginLeft: 'auto', opacity: '0.4' });
    foot.appendChild(cred);
    return foot;
  }

  function buildUI() {
    ensurePanelStyle();
    // The permission-appropriate home zone (Control-Panel.md §2) — decided once,
    // here, because this is the first point game.user is reliably readable
    // (attachPanel runs on Foundry's 'ready' hook).
    activeZone = visibleZones()[0];
    const panel = document.createElement('div');
    panelEl = panel;
    panel.id = 'msa-debug-panel';
    Object.assign(panel.style, {
      pointerEvents: 'auto',
      marginTop: '6px',
      background: 'rgba(12,16,26,0.93)',
      border: '1px solid rgba(143,214,255,0.28)',
      borderRadius: '10px',
      font: '11px/1.35 Signika, sans-serif',
      color: '#dcecff',
      width: '498px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
      backdropFilter: 'blur(7px)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
    });

    // Brand header — the product surface's title bar, and still the drag handle
    // (author-reported, 2026-07-16: the panel sits under Foundry's right-hand
    // sidebar; the whole HOST moves as one unit — heartbeat strip + panel).
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      cursor: 'grab',
      padding: '8px 10px',
      borderBottom: '1px solid rgba(143,214,255,0.16)',
      touchAction: 'none', // let pointermove reach us instead of becoming a scroll gesture
    });
    const ver = MapShine.version ? ` v${MapShine.version}` : '';
    const brand = document.createElement('span');
    Object.assign(brand.style, { display: 'flex', alignItems: 'center', gap: '8px' });
    brand.innerHTML =
      '<span style="font-size:15px">🗝️</span>' +
      '<span><span style="font-weight:700;letter-spacing:.2px">Map Shine Advanced</span>' +
      `<span style="opacity:.5;font-size:9px;display:block;margin-top:-1px">control panel${ver}</span></span>`;

    makeDraggable(header, () => panelEl?.parentElement);

    // MINIMIZE / CLOSE — two explicit buttons (author, 2026-07-20: "we also
    // need a button to close this dialogue as well as minimise it"), replacing
    // the old implicit "click anywhere on the header" gesture that was easy to
    // confuse with the drag it shares a hit area with. Minimize shrinks to just
    // this header bar (the panel is still "open" — the toolbar stays lit).
    // Close hides the whole panel and dims the toolbar button; reopen from
    // there (foundry/scene-controls-button.js).
    const headerBtn = (glyph, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = glyph;
      b.title = title;
      Object.assign(b.style, {
        pointerEvents: 'auto',
        background: 'transparent',
        border: '1px solid rgba(143,214,255,0.22)',
        borderRadius: '5px',
        color: '#9fb6d8',
        font: '11px/1 Signika, sans-serif',
        width: '20px',
        height: '20px',
        cursor: 'pointer',
      });
      b.addEventListener('mouseenter', () => {
        b.style.background = 'rgba(143,214,255,0.14)';
        b.style.color = '#eaf4ff';
      });
      b.addEventListener('mouseleave', () => {
        b.style.background = 'transparent';
        b.style.color = '#9fb6d8';
      });
      // The header's own pointerdown starts a drag (setPointerCapture) — without
      // this, that capture swallows the button's matching pointerup and the
      // click event never fires at all, not just "sometimes".
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      return b;
    };
    const minimizeBtn = headerBtn('▾', 'Minimize');
    minimizeBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      shellRowEl.style.display = collapsed ? 'none' : 'flex';
      minimizeBtn.textContent = collapsed ? '▸' : '▾';
    });
    const closeBtn = headerBtn('✕', 'Close (reopen from the scene-controls toolbar)');
    closeBtn.addEventListener('click', hidePanel);

    const btnRow = document.createElement('span');
    Object.assign(btnRow.style, { display: 'flex', alignItems: 'center', gap: '4px' });
    btnRow.append(minimizeBtn, closeBtn);

    header.append(brand, btnRow);

    // The shell row: the zone rail (left) + the active zone (right).
    shellRowEl = document.createElement('div');
    Object.assign(shellRowEl.style, { display: 'flex', alignItems: 'stretch' });

    railEl = buildRail();
    // A rail with one icon is chrome for a choice that doesn't exist — a player
    // has exactly one zone (Settings), so it opens straight into it instead.
    if (visibleZones().length <= 1) railEl.style.display = 'none';

    const main = document.createElement('div');
    Object.assign(main.style, { display: 'flex', flexDirection: 'column', flex: '1', minWidth: '0' });

    zoneHeadEl = document.createElement('div');
    Object.assign(zoneHeadEl.style, { padding: '9px 12px 8px', borderBottom: '1px solid rgba(143,214,255,0.10)' });

    bodyEl = document.createElement('div');
    Object.assign(bodyEl.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '11px 12px',
      maxHeight: '60vh',
      overflowY: 'auto',
    });

    statusEl = document.createElement('div');
    Object.assign(statusEl.style, {
      margin: '0 12px',
      color: '#9fdcc0',
      minHeight: '14px',
      fontSize: '10px',
      wordBreak: 'break-word',
    });
    statusEl.textContent = 'Pick a tool — its output copies to your clipboard, ready to paste back.';

    footerEl = buildFooter();
    footerEl.style.margin = '6px 12px 8px';

    main.appendChild(zoneHeadEl);
    main.appendChild(bodyEl);
    main.appendChild(statusEl);
    main.appendChild(footerEl);

    shellRowEl.appendChild(railEl);
    shellRowEl.appendChild(main);

    panel.appendChild(header);
    panel.appendChild(shellRowEl);
    updateZoneHead();
    // "Always opens for the GM at the moment" (author, 2026-07-20) — a
    // temporary default kept until the module ships and this becomes a real
    // per-user setting. A player starts closed and reaches Settings via the
    // scene-controls toolbar button (foundry/scene-controls-button.js).
    setPanelVisible(isGM());
    return panel;
  }

  // ---- the zone rail -------------------------------------------------------

  function buildRail() {
    const rail = document.createElement('div');
    Object.assign(rail.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      padding: '9px 6px',
      background: 'rgba(6,10,20,0.5)',
      borderRight: '1px solid rgba(143,214,255,0.12)',
    });
    for (const z of visibleZones()) {
      const m = ZONE_META[z];
      const b = document.createElement('button');
      b.dataset.zone = z;
      b.type = 'button';
      b.innerHTML =
        `<span style="font-size:16px;line-height:1">${m.icon}</span>` +
        `<span style="font-size:8px;letter-spacing:.3px;opacity:.9">${m.tag}</span>`;
      Object.assign(b.style, {
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '2px',
        width: '46px',
        padding: '7px 2px 5px',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: '8px',
        color: '#9fb6d8',
        cursor: 'pointer',
      });
      if (m.dev) b.title = 'Developer tools (dev-gated in the real shell)';
      b.addEventListener('mouseenter', () => {
        if (b.dataset.zone !== activeZone) b.style.background = 'rgba(143,214,255,0.08)';
      });
      b.addEventListener('mouseleave', () => updateRail());
      b.addEventListener('click', () => selectZone(z));
      rail.appendChild(b);
    }
    return rail;
  }

  function updateRail() {
    if (!railEl) return;
    for (const b of railEl.children) {
      const on = b.dataset.zone === activeZone;
      b.style.background = on ? 'rgba(143,214,255,0.14)' : 'transparent';
      b.style.borderColor = on ? 'rgba(143,214,255,0.30)' : 'transparent';
      b.style.color = on ? '#eaf4ff' : '#9fb6d8';
    }
  }

  function updateZoneHead() {
    if (!zoneHeadEl) return;
    const m = ZONE_META[activeZone];
    zoneHeadEl.innerHTML =
      `<span style="font-weight:700;font-size:12.5px;color:#eaf4ff">${m.title}</span>` +
      `<span style="opacity:.5;font-size:9px;margin-left:7px">${m.sub}</span>`;
  }

  function selectZone(z) {
    activeZone = z;
    updateRail();
    updateZoneHead();
    renderBody();
  }

  // ---- rendering: dispatch to the active zone ------------------------------

  function renderBody() {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    updateRail();
    if (activeZone === 'lab') renderLab();
    else renderProductZone(activeZone);
  }

  // A collapsed-by-default accordion folder; open/closed state remembered across
  // re-renders via openFolders.
  function makeFolder(fid, icon, title, items) {
    const details = document.createElement('details');
    details.open = openFolders.has(fid);
    Object.assign(details.style, {
      border: '1px solid rgba(143,214,255,0.14)',
      borderRadius: '8px',
      background: 'rgba(143,214,255,0.04)',
    });
    const summary = document.createElement('summary');
    Object.assign(summary.style, {
      cursor: 'pointer',
      listStyle: 'none',
      padding: '6px 9px',
      fontWeight: '600',
      display: 'flex',
      alignItems: 'center',
      gap: '7px',
      userSelect: 'none',
    });
    summary.innerHTML =
      '<span class="msa-chev">▸</span>' +
      `<span>${icon}</span><span>${title}</span>` +
      `<span style="margin-left:auto;opacity:.4;font-weight:400">${items.length}</span>`;
    const body = document.createElement('div');
    Object.assign(body.style, { display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '0 9px 9px' });
    for (const el of items) body.appendChild(el);
    details.addEventListener('toggle', () => {
      if (details.open) openFolders.add(fid);
      else openFolders.delete(fid);
    });
    details.appendChild(summary);
    details.appendChild(body);
    return details;
  }

  /**
   * Build every registered panel routed to `zone`, as plain DOM elements ready
   * to mount — shared by `renderLab` and `renderProductZone` so a panel is
   * genuinely zone-agnostic (registerPanel's own doc). A panel that throws
   * while building is logged and skipped — one broken card must not blank the
   * rest of the zone (the same "a failure degrades, never crashes the host"
   * stance every other report/action already gets via runReport's try/catch).
   * @param {string} zone
   * @returns {HTMLElement[]}
   */
  function buildRoutedPanels(zone) {
    const out = [];
    for (const [id, entry] of panels) {
      if (zoneOf(id, entry) !== zone) continue;
      try {
        const built = entry.buildFn();
        if (built instanceof HTMLElement) out.push(built);
      } catch (err) {
        log.error(`panel "${id}" failed to build:`, err);
      }
    }
    return out;
  }

  // ---- THE LAB — today's debug registry, behaviour unchanged ---------------
  // The "Export everything" button + quick-reach primaries + the accordion
  // folders. Only entries routed to the Lab (zoneOf === 'lab', the default)
  // render here — the handful routed to product zones show up there instead.
  function renderLab() {
    const quick = document.createElement('div');
    Object.assign(quick.style, { display: 'flex', flexWrap: 'wrap', gap: '5px' });

    // THE ONE BUTTON — the author's ask: one click to export every log + report.
    if (typeof MapShine.flight?.export === 'function') {
      const exportBtn = makeButton('⬇  Export everything', { rgb: '167,255,196', flexBasis: '100%', weight: '700' });
      exportBtn.addEventListener('click', async () => {
        statusEl.textContent = 'Building the bundle — running every read-only report…';
        exportBtn.disabled = true;
        try {
          const r = await MapShine.flight.export();
          statusEl.textContent = r.ok
            ? `✔ Downloaded ${r.filename} — ${(r.bytes / 1024).toFixed(0)}KB, ${r.reports} reports` +
              `${r.failures ? `, ⚠ ${r.failures} report(s) threw (captured in the bundle)` : ''}.`
            : `✘ Bundle built but the download failed: ${r.error}`;
        } catch (e) {
          statusEl.textContent = `✘ Export threw: ${e?.message || e}`;
        } finally {
          // An export that fails must not leave the button dead — the recovery
          // path would be "reload Foundry", which wipes the very session being
          // reported.
          exportBtn.disabled = false;
        }
      });
      quick.appendChild(exportBtn);
    }

    const buckets = new Map();
    const push = (fid, el) => {
      if (!buckets.has(fid)) buckets.set(fid, []);
      buckets.get(fid).push(el);
    };
    const place = (id, entry, skin) => {
      const fid = folderOf(id, entry);
      const btn = makeRunnable(id, entry.label, skin);
      if (fid === '__primary__') {
        // Vital tools (Pixel Probe, Performance) sit in the quick-reach row.
        btn.style.flexGrow = '1';
        btn.style.flexBasis = 'calc(50% - 3px)';
        quick.appendChild(btn);
      } else {
        push(fid, btn);
      }
    };
    for (const [id, entry] of reports) if (zoneOf(id, entry) === 'lab') place(id, entry, REPORT_SKIN);
    for (const [id, entry] of actions) if (zoneOf(id, entry) === 'lab') place(id, entry, ACTION_SKIN);
    for (const [id, entry] of controls)
      if (zoneOf(id, entry) === 'lab') push(entry.group ?? 'levers', makeControl(id, entry));

    bodyEl.appendChild(quick);
    for (const el of buildRoutedPanels('lab')) bodyEl.appendChild(el);

    const order = FOLDERS.map((f) => f.id);
    for (const fid of buckets.keys()) if (!order.includes(fid) && fid !== '__more__') order.push(fid);
    order.push('__more__');
    const metaOf = (fid) =>
      FOLDERS.find((f) => f.id === fid) ??
      (fid === '__more__' ? { title: 'More', icon: '🗂️' } : { title: fid, icon: '📁' });

    for (const fid of order) {
      const items = buckets.get(fid);
      if (!items || !items.length) continue;
      const { title, icon } = metaOf(fid);
      bodyEl.appendChild(makeFolder(fid, icon, title, items));
    }
  }

  // ---- THE PRODUCT ZONES — Tier 0 scaffold ---------------------------------
  // Each shows (a) whatever already-working controls are routed to it, then
  // (b) a 🚧 stub scaffold of what's planned — so the final arrangement can be
  // judged before the real (Effects-UI / astrolabe) renderers exist. Nothing
  // here is load-bearing; it is the skeleton of docs/planning/Control-Panel.md.

  function renderProductZone(z) {
    bodyEl.appendChild(zoneIntro(ZONE_INTRO[z]));

    // (a) real controls routed to this zone
    const realReports = [...reports].filter(([id, e]) => zoneOf(id, e) === z);
    const realActions = [...actions].filter(([id, e]) => zoneOf(id, e) === z);
    const realControls = [...controls].filter(([id, e]) => zoneOf(id, e) === z);
    if (realReports.length || realActions.length || realControls.length) {
      bodyEl.appendChild(sectionLabel('Working now'));
      const real = document.createElement('div');
      Object.assign(real.style, { display: 'flex', flexWrap: 'wrap', gap: '5px' });
      for (const [id, e] of realControls) real.appendChild(makeControl(id, e));
      for (const [id, e] of realActions) real.appendChild(makeRunnable(id, e.label, ACTION_SKIN));
      for (const [id, e] of realReports) real.appendChild(makeRunnable(id, e.label, REPORT_SKIN));
      bodyEl.appendChild(real);
    }

    // (b) rich panels routed to this zone (Effects-UI.md FOH/ROH cards) — each
    // is its own full-width block, never squeezed into the small-control row.
    for (const el of buildRoutedPanels(z)) bodyEl.appendChild(el);

    // (c) the planned scaffold, per zone
    bodyEl.appendChild(sectionLabel('Planned'));
    if (z === 'bridge') {
      // The dashed "🧭 Astrolabe — time & wind hero dial" placeholder that
      // stood here is GONE (2026-07-23): the real dial is a registered panel
      // (`ui/astrolabe.js`, boot.js) and renders above, via buildRoutedPanels.
      // A stub left beside the thing it was standing in for is a dead control.
      bodyEl.appendChild(stubRow(STUBS.bridge.quick));
    } else if (z === 'workshop') {
      bodyEl.appendChild(stubGallery(STUBS.workshop.gallery));
    } else if (z === 'toolbox') {
      bodyEl.appendChild(stubRow(STUBS.toolbox.items));
    } else if (z === 'settings') {
      bodyEl.appendChild(sectionLabel('Performance profile'));
      bodyEl.appendChild(stubSegmented(STUBS.settings.profile));
      bodyEl.appendChild(sectionLabel('Per-effect enable'));
      bodyEl.appendChild(stubRow(STUBS.settings.effects.map((e) => `${e} · enable`)));
    }
  }

  /** Call once the boot heartbeat box exists in the DOM. Idempotent. */
  function attachPanel(panelHost) {
    if (panelEl) return panelEl;
    panelEl = buildUI();
    panelHost.appendChild(panelEl);
    renderBody();
    return panelEl;
  }

  // ---- baseline reports every stage benefits from --------------------------
  registerReport('boot', 'Boot', () =>
    envelope('boot', {
      stage: MapShine.__stage || 'unknown',
      threeRevision: MapShine.THREE?.REVISION,
      heartbeatRendering: !!MapShine.__heartbeat,
      hasFoundryHooks: typeof Hooks !== 'undefined',
      hasGame: typeof game !== 'undefined',
      userAgent: navigator.userAgent,
      url: location.href,
    })
  );

  registerReport('environment', 'Environment/GPU', () => {
    // WEBGPU-AWARE since the TSL port. This used to do
    // `canvas.getContext('webgl2') || renderer.getContext()` and then call
    // `gl.getExtension(...)` — which threw "gl.getExtension is not a function" the
    // moment the heartbeat became a WebGPURenderer, because getContext() then
    // returns a GPUCanvasContext. A WebGL assumption that outlived WebGL.
    const r = MapShine.__heartbeat?.renderer;
    const backend = r?.backend?.isWebGPUBackend ? 'webgpu' : r?.backend ? 'webgl2' : 'unknown';
    const out = { rendererBackend: backend, webgpuAvailable: !!navigator.gpu };

    if (backend === 'webgpu') {
      // WebGPU exposes far less about the GPU than WEBGL_debug_renderer_info did —
      // deliberately, for fingerprinting reasons. Report what it DOES give rather
      // than pretending the old fields exist.
      const dev = r?.backend?.device;
      out.adapterInfo = r?.backend?.adapter?.info
        ? {
            vendor: r.backend.adapter.info.vendor ?? null,
            architecture: r.backend.adapter.info.architecture ?? null,
            device: r.backend.adapter.info.device ?? null,
            description: r.backend.adapter.info.description ?? null,
          }
        : null;
      out.limits = dev?.limits
        ? {
            maxTextureDimension2D: dev.limits.maxTextureDimension2D,
            maxTextureArrayLayers: dev.limits.maxTextureArrayLayers,
            maxBufferSize: dev.limits.maxBufferSize,
            maxBindGroups: dev.limits.maxBindGroups,
          }
        : null;
      out.features = dev?.features ? Array.from(dev.features) : [];
      out.note =
        'WebGPU intentionally exposes less GPU detail than WEBGL_debug_renderer_info did. ' +
        'maxTextureArrayLayers is the one to watch: the page atlas is a layered texture.';
      return out;
    }

    // WebGL2 path — still real when the backend falls back.
    const canvas = r?.domElement || document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl || typeof gl.getExtension !== 'function') {
      out.note = 'no WebGL2 context available to interrogate';
      return out;
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    out.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out.maxArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    out.extensions = gl.getSupportedExtensions?.() ?? [];
    return out;
  });

  // The session log, from the flight recorder. This used to be a private
  // warn/error ring living in this file — it kept the complaints and threw away
  // the plot, and it could not see `info`, which is where the load story is told.
  registerReport('console', 'Session log (all levels, all sources)', () => {
    const snap = MapShine.flight?.snapshot?.();
    if (!snap) {
      return envelope('console', {
        available: false,
        why: 'the flight recorder is not installed — installFlightRecorder(MapShine) must run first in boot.',
      });
    }
    return envelope('console', {
      ...snap.log,
      // The full ring is in the exported bundle; this clipboard report is meant
      // to be pasted, so it carries the tail. It says which it is, because a
      // truncated log presenting itself as complete is the whole bug class.
      items: snap.log.items.slice(-120),
      showing: `the most recent ${Math.min(120, snap.log.items.length)} of ${snap.log.items.length} held entries`,
      note: 'Use "Export everything" for the complete log plus every other report.',
    });
  });

  if (typeof MapShine.soak === 'function') {
    // An ACTION: it runs three real cycles. It shared a registry with passive
    // readouts until 2026-07-17, which is precisely why the export could not
    // simply "run every report" — it would have run this.
    registerAction('soak', 'Soak (3 cycles)', async () => {
      const result = await MapShine.soak(3);
      return envelope('soak', { result });
    });
  }

  MapShine.debug = {
    registerReport,
    registerAction,
    registerSelect,
    registerPanel,
    refreshControls,
    runReport,
    copyToClipboard,
    attachPanel,
    // Whole-panel visibility — driven by the scene-controls toolbar button
    // (foundry/scene-controls-button.js) and the panel's own Close button.
    showPanel,
    hidePanel,
    togglePanel,
    isPanelVisible,
    onVisibilityChange,
    /** Pure readouts. The flight recorder runs all of these on export. */
    get reports() {
      return reports;
    },
    /** Side-effecting buttons. The flight recorder never runs these. */
    get actions() {
      return actions;
    },
  };
  return MapShine.debug;
}
