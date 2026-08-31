/**
 * src/diag/debug-panel.js — THE DIAGNOSTIC REGISTRY, plus the Lab.
 *
 * WHAT THIS IS NOW (2026-08-27, UI parity plan phase 7b): NOT a floating
 * panel any more. The old Tier-0 shell — a four-zone icon rail (Bridge · Make
 * · Lab · Setup), its own header/drag/minimize/close chrome, its own perf
 * strip — is DELETED, along with the `map-shine-advanced` toolbar toggle
 * that opened it (foundry/scene-controls-button.js). Bridge/Make/Setup's
 * real functionality all has a live home in the new UI now (the Remote's
 * astrolabe + weather board, Studio's Effects department, Studio's/Player's
 * System department) — see docs/planning/UI-Parity-Gap-Analysis-2026-08-27.md
 * for the room-by-room accounting that justified the deletion.
 *
 * What SURVIVES here, and why: `registerReport`/`registerAction`/
 * `registerSelect`/`registerPanel` are the shared registry every diagnostic
 * in this codebase still registers into (vt/, graph/, foundry/, every effect
 * card's own probes) — deleting the registry would silently unwire dozens of
 * already-built diagnostics, not just the old panel's own chrome around
 * them. `renderLabBody()` (still real) is what Studio's own LAB department
 * (`ui/rooms/studio/lab-department.js`) mounts — the Lab's folders/quick-
 * reach row/Export-everything button are the one part of the old panel's
 * OWN rendering that lives on, now inside the new Studio rather than a
 * separate window. `buildEffectAttachments`/`buildActionButton` are the two
 * doors the new Remote/Studio UI reaches through to pull {effect}-scoped or
 * bare registered diagnostics into their OWN cards (Wind's Studio card,
 * debug-strip.js's perf-sweep button) — see each of those files' own header
 * for why.
 *
 * Routing is `routeEntry`: an entry declaring `{ effect }` renders inside
 * that effect's card (via `buildEffectAttachments`/`attachmentsFor`),
 * otherwise `zoneOf` decides whether it lands in the Lab (`renderLab`,
 * `zoneOf(...) === 'lab'`) — nothing else reads a non-Lab zone any more, so
 * an entry declaring `{ zone: 'bridge' }`/`'workshop'`/`'settings'` today
 * simply renders nowhere in THIS file (its real UI home, if any, is now a
 * Studio/Remote registration instead).
 *
 * PERMISSION IS A FILTER, NOT A FORK (Control-Panel.md §2, landed 2026-07-20)
 * — `isGM()` below still reads the one live fact (`game.user.isGM`), now
 * consumed by the new UI's own rooms rather than this file's own (deleted)
 * rail.
 *
 * A growing set of buttons, one per registered "report" — click one and its
 * output is copied to the clipboard as text, ready to paste back into chat.
 * This is the standing debugging protocol for the rest of the build: when
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
// The shared control builders + routing logic, split out 2026-07-25 — the
// size-ratchet god-object reversal; this file was 1,321 lines / a 1,249-line
// closure. `makeDraggable`/`ensurePanelStyle`/`createPerfStrip` (the old
// panel's own drag/stylesheet/perf-strip chrome) are no longer imported here
// — deleted along with the panel itself (UI parity plan, phase 7b); Studio/
// Remote each own their own drag+style+perf-readout now.
import {
  createControlBuilders,
  routeEntry,
  sortPanelsForZone,
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
    controls.set(id, {
      label,
      options,
      getValue,
      onChange,
      group: opts.group,
      primary: opts.primary,
      zone: opts.zone,
      effect: opts.effect,
    });
  }

  /**
   * Re-sync every registered select's DISPLAYED value against its live
   * `getValue()`, without waiting for the author to open the dropdown.
   *
   * WHY THIS EXISTS (2026-07-19, author-reported): a select's `fill()` (the
   * closure that reads `getValue()` and paints it) only ran at REGISTRATION
   * time and again on `mousedown` (see renderButtons' own comment: "re-read
   * on open"). Most controls — including "Renderer", whose `getValue()`
   * reads `foundryArtRenderable`, a scene-load-dependent fact — are
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
   *
   * A genuine no-op since the old panel it used to repaint was deleted (UI
   * parity plan, phase 7b) — kept as a real, callable function rather than
   * deleted outright so its dozen-plus call sites across boot.js (each
   * already just "a live value changed, tell the panel") don't all need
   * individually re-verifying as safe to remove. Studio/Remote each already
   * repaint themselves through their own, separate mechanisms.
   */
  function refreshControls() {}

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
   * @param {(ctx: {attachments: HTMLElement[]}) => HTMLElement} buildFn - receives
   *   every report/action/select that declared `{ effect: <this panel's effect> }`,
   *   already built as buttons, for the panel to mount wherever it likes. JS ignores
   *   extra arguments, so a `buildFn` written as `() => …` keeps working untouched.
   * @param {object} [opts]
   * @param {string} [opts.zone]
   * @param {string} [opts.effect] - WHICH EFFECT THIS PANEL IS. Not where it goes —
   *   that is `zone`. This is what lets a probe registered anywhere in boot.js find
   *   its way into the right card without this file importing the card renderer.
   * @param {number} [opts.order] - sort key within the zone; default 0, negatives pin
   *   to the top. Panel order used to be Map-insertion order.
   */
  function registerPanel(id, label, buildFn, opts = {}) {
    panels.set(id, {
      label,
      buildFn,
      group: opts.group,
      zone: opts.zone,
      effect: opts.effect,
      order: opts.order ?? 0,
    });
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
    reports.set(id, {
      label,
      fn,
      group: opts.group,
      primary: opts.primary,
      zone: opts.zone,
      effect: opts.effect,
    });
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
    actions.set(id, {
      label,
      fn,
      group: opts.group,
      primary: opts.primary,
      zone: opts.zone,
      effect: opts.effect,
    });
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
  // `panelEl` never gets assigned any more (the old panel it pointed at is
  // deleted, UI parity plan phase 7b) — kept as a permanently-null variable
  // rather than torn out of `setPanelVisible`'s own `if (panelEl)` guard
  // below, so that function's tested visibility-STATE behaviour (still real,
  // still used) stays byte-identical rather than rewritten around a removed
  // branch.
  const panelEl = null;
  // A REAL, always-valid, NEVER-ATTACHED sink — not `null` (2026-08-27 fix):
  // `attachmentsFor`'s buttons (Wind's Studio card, Water/Specular's own
  // `extra`/`extraAdvanced`) and `buildActionButton` (debug-strip.js's own
  // perf-sweep button) both render through THIS file's own top-level
  // `makeRunnable`/`makeControl` (below), which write status text into
  // whatever `getStatusEl()` returns on every click. Before phase 7b, the
  // old panel's own `buildUI()` ALWAYS ran during boot (attachPanel, called
  // unconditionally from bootHeartbeat) and assigned a real DOM node here —
  // so this was never actually null by the time a user could click anything,
  // even though nobody could see the OLD panel. Deleting that unconditional
  // boot-time build removed that accidental safety net: a `null` here would
  // throw the moment any of those buttons (all live in the NEW Studio/Remote
  // UI) were clicked. A real, if invisible, div keeps the report/action
  // itself (and its clipboard copy) working; only the little "Running…/✔
  // Copied" status text has nowhere visible to land.
  const statusEl = document.createElement('div');
  // Whole-panel visibility (used to be the scene-controls toolbar button +
  // the old panel's own Close button; now: `hideLiveUi`/`restoreLiveUi`'s
  // perf-measurement harness, and the astrolabe repaint's own "hidden for
  // measurement" gate, both in boot.js).
  //
  // ⚠️⚠️ REAL BUG, FOUND LIVE (2026-08-27, author: "the fun display of
  // landscape in the middle of the UI stopped rendering correctly") — this
  // used to start `null` on the theory that the FIRST real `setPanelVisible`
  // call would always apply, since the old panel's own `buildUI()` ALWAYS
  // called `setPanelVisible(isGM())` unconditionally during boot (phase 1's
  // auto-open). Deleting that panel (phase 7b) removed the ONLY thing that
  // ever moved this off `null` during normal play — `isPanelVisible()`
  // coerces with `!!`, so `null` and `false` are INDISTINGUISHABLE to every
  // caller, including boot.js's own astrolabe-repaint gate
  // (`hiddenForMeasurement = isPanelVisible() === false`), which therefore
  // read "hidden" from the very first frame, forever, with nothing left to
  // ever flip it back — the dial silently froze at its as-constructed
  // defaults (placeholder sky colours, unfilled-therefore-black terrain, an
  // unpositioned-therefore-off-screen sun) and never painted again. `true`
  // is the honest default now: nothing is hidden until `hidePanel()`
  // actually says so, which is exactly the "fails OPEN" doctrine
  // `hiddenForMeasurement`'s own comment in boot.js already states.
  let panelVisible = true;
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

  /** Show/hide state — genuinely just state now that the panel itself is
   * gone (UI parity plan, phase 7b); `if (panelEl)` below is permanently
   * false, so this never touches the DOM any more. Still real: it's what
   * `hideLiveUi`/`restoreLiveUi` (boot.js's perf-measurement harness) and the
   * astrolabe repaint's own throttle gate both key off, so a benchmark sweep
   * can still say "don't bother painting UI-adjacent things right now"
   * without a visible panel to actually hide. */
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
  // ("Export everything" is primary by construction; every other quick-reach
  // entry self-declares `{ primary: true }` at its registration site.)
  const FOLDERS = [
    { id: 'levers', title: 'Levers', icon: '🎚️', ids: [] }, // live selects default here
    {
      id: 'health',
      title: 'Health & baseline',
      icon: '📊',
      ids: ['stage-gate-baseline', 'pass-graph-health', 'environment', 'boot', 'console'],
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
    {
      // The old Tools zone, folded in here 2026-07-27. It held exactly two real
      // controls and six 🚧 placeholders; once the placeholders went, a whole rail
      // click led to a pair of buttons. These are GM utilities rather than dev
      // diagnostics, so they keep their own folder rather than dissolving into one.
      id: 'utilities',
      title: 'Scene utilities',
      icon: '🧰',
      ids: ['loading-screen-arm', 'loading-screen-state'],
    },
  ];
  const openFolders = new Set(); // folder ids the author has expanded; preserved across re-renders

  // ---- THE ZONES (docs/planning/Control-Panel.md) ---------------------------
  // The rail switches between them. An entry that declares `{ effect }` renders
  // in that effect's card and in NO zone (see routeEntry); everything else is
  // routed to exactly one zone here. Presentation-only config, exactly like
  // FOLDERS above — a mis-routed id still works, it just shows in the wrong zone.
  //
  // 'toolbox' WAS DELETED 2026-07-27, author's call. It housed two working
  // controls and six 🚧 placeholders; deleting the placeholders left a rail icon
  // leading to a pair of buttons. Its contents moved to the Lab's new "Scene
  // utilities" folder. Four zones, each with a reason to be clicked.
  // ZONE_ORDER/ZONE_META/visibleZones (the rail's own icon/tag/title table and
  // its GM-vs-player zone list) were deleted along with the rail itself (UI
  // parity plan, phase 7b). ZONES/zoneOf below stay — 'lab' is still a real,
  // rendered destination (renderLab, mounted by Studio's own LAB department);
  // an entry routed to any OTHER zone here simply renders nowhere in THIS
  // file any more (its real UI home, if it has one today, is a Studio/Remote
  // registration instead) — still fully reachable via
  // `MapShine.debug.runReport(id)`/the flight-recorder export either way.
  //
  // id → zone override, for the handful of controls that belong in a product
  // zone rather than the dev suite. A registration's own `{ zone }` beats this
  // table; `{ effect }` beats both and sends the entry into that effect's card.
  //
  // ⚠️ THIS TABLE IS NOT WHAT MADE THE LAB A JUNK DRAWER — the DEFAULT was. Every
  // diagnostic that declared nothing fell to 'lab', so the catch-all "More" drawer
  // grew to twelve entries, eight of which belonged to a named effect. Those eight
  // now declare `{ effect }` at their own registration site and the drawer is gone.
  // The fallback stays 'lab' deliberately: a control that lands somewhere
  // unexpected is recoverable, one that renders nowhere is invisible.
  //
  // ('anchors'/'live-markers-toggle' left for the candle card; 'candle-markers-once'
  // was deleted; the loading-screen pair came here from the retired Tools zone.)
  const ZONES = {
    // UI parity plan, phase 4a: reclassified to 'lab' now that
    // ui/rooms/studio/scene-department.js has a real, live Darkness-at-max
    // card calling the SAME getDarknessRealism/setDarknessRealism this
    // select always has -- Studio's LAB department still mounts this exact
    // registry, so the control stays reachable there too, just no longer
    // duplicated onto Bridge once Bridge itself goes away (phase 7b).
    'darkness-realism': 'lab',
    // UI parity plan, phase 4b: 'lab', not 'bridge' -- the Remote's own
    // header Renderer toggle now calls the SAME restoreFoundryArt/
    // applyArtSuppression this select always has (see that toggle's own
    // comment in boot.js). Same reasoning as darkness-realism just above.
    'render-compare': 'lab',
    'camera-path-open': 'bridge',
    paint: 'workshop',
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
    'loading-screen-arm': 'lab',
    'loading-screen-state': 'lab',
    // 'ui-shadow' (the bespoke On/Off select) is GONE — subsumed by the generic
    // per-effect row in the new graphics-settings panel (boot.js). Its status
    // readout is a technical diagnostic (how many windows detected/casting),
    // not a player option, so it belongs with the rest of the dev tools rather
    // than in the player-facing Settings zone — re-routed 2026-07-29, the same
    // day Settings became a real panel instead of two leftover controls.
    'ui-shadow-status': 'lab',
  };
  /** Which zone body an entry renders in, or `null` when it renders inside an
   * effect's card instead. Delegates to the pure `routeEntry` so the rule that
   * turned the Lab into a junk drawer is Node-tested rather than inline here. */
  const zoneOf = (id, entry) => {
    const r = routeEntry(id, entry, ZONES);
    return r.kind === 'zone' ? r.zone : null;
  };

  // ZONE_INTRO (a blurb paragraph per zone) and STUBS (21 inert 🚧 placeholders)
  // WERE DELETED 2026-07-27. The blurbs described which controls were real,
  // which is a fact the controls themselves now carry by simply existing; the
  // stubs advertised features that live in docs/planning, and two of them had
  // drifted into duplicating the working controls rendered immediately above
  // them. Both cost vertical space in a panel that has ten effect cards to fit.

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
  const { makeButton, makeRunnable, makeControl, folderOf } = createControlBuilders({
    runReport,
    copyToClipboard,
    getStatusEl: () => statusEl,
    FOLDERS,
  });

  // buildFooter/buildUI/buildRail/updateRail/updateZoneHead/selectZone/
  // renderBody — the old panel's own header/drag/minimize/close chrome, zone
  // rail, and top-level render dispatch — are all deleted (UI parity plan,
  // phase 7b). makeFolder/buildRoutedPanels/attachmentsFor/renderLab below
  // survive: they're what Studio's own LAB department actually mounts.

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
    for (const [id, entry] of sortPanelsForZone(panels, zone, ZONES)) {
      try {
        const built = entry.buildFn({ attachments: attachmentsFor(entry.effect) });
        if (built instanceof HTMLElement) out.push(built);
      } catch (err) {
        log.error(`panel "${id}" failed to build:`, err);
      }
    }
    return out;
  }

  /**
   * Every report/action/select that declared `{ effect: effectId }`, built as
   * buttons ready for that effect's card to mount.
   *
   * ⚠️ THIS IS WHAT KEEPS THE TWO MODULES APART. `debug-panel.js` does not import
   * `effect-controls.js`, and `effect-controls.js` does not import this file —
   * boot.js imports both, because boot.js is the composition root. So the panel
   * builds the DOM it knows how to build (skinned buttons, live selects) and hands
   * them over as opaque elements; the card mounts them without knowing what they
   * are. Exactly the contract `extra[]` already had.
   *
   * ⚠️ AND THE REPORTS/ACTIONS SPLIT KEEPS ITS TEETH. `{ effect }` changes only
   * WHERE a button is drawn. The entry stays in the same `reports`/`actions` Map,
   * so the flight recorder still runs every report on export and still never runs
   * an action. Moving a probe into a card must not make an export able to restart
   * the author's scene.
   *
   * @param {string|undefined} effectId
   * @returns {HTMLElement[]}
   */
  function attachmentsFor(effectId) {
    if (!effectId) return [];
    const out = [];
    for (const [id, e] of controls) if (e.effect === effectId) out.push(makeControl(id, e));
    for (const [id, e] of actions) if (e.effect === effectId) out.push(makeRunnable(id, e.label, ACTION_SKIN));
    for (const [id, e] of reports) if (e.effect === effectId) out.push(makeRunnable(id, e.label, REPORT_SKIN));
    return out;
  }

  // warnOrphanedAttachments (the old panel's own "a diagnostic declares an
  // {effect} no card claims" console warning) was only ever called from
  // renderBody, deleted above with it (UI parity plan, phase 7b). Every
  // {effect}-scoped diagnostic stays reachable regardless — via
  // `MapShine.debug.runReport(id)`, the flight-recorder export, and whatever
  // card actually claims that effect today — this only drops the console
  // warning for the (now purely hypothetical, since Studio's own effect
  // registry drives which cards exist) case of one that claims none.

  // ---- THE LAB — today's debug registry, behaviour unchanged ---------------
  // The "Export everything" button + quick-reach primaries + the accordion
  // folders. Only entries routed to the Lab (zoneOf === 'lab', the default)
  // render here — the handful routed to product zones show up there instead.
  /**
   * The Lab zone's whole body, built (never attached) — the Studio's own LAB
   * department mounts this same output (UI-Testament.md U1: "today's debug
   * panel registry mounted whole, dev-gated").
   *
   * `getStatusEl` defaults to this panel's own status bar, so the zero-arg
   * call `renderBody()` already makes (below) is byte-identical to before
   * this function returned instead of appending. A caller mounting this body
   * SOMEWHERE ELSE — a different room, a different status readout — passes
   * its own getter instead; `createControlBuilders` already takes one as a
   * parameter (debug-panel-controls.js), so a second, independently-scoped
   * builder set is a real call, not a workaround. `reports`/`actions`/
   * `controls`/`buildRoutedPanels`/`FOLDERS` stay shared on purpose — the
   * Studio's Lab shows the SAME registrations, not a second registry.
   * @param {{getStatusEl?: () => (HTMLElement|null)}} [opts]
   * @returns {HTMLElement}
   */
  function renderLab({ getStatusEl } = {}) {
    const root = document.createElement('div');
    const {
      makeButton: mb,
      makeRunnable: mr,
      makeControl: mc,
      folderOf: fo,
    } = getStatusEl
      ? createControlBuilders({ runReport, copyToClipboard, getStatusEl, FOLDERS })
      : { makeButton, makeRunnable, makeControl, folderOf };
    const readStatusEl = getStatusEl ?? (() => statusEl);

    const quick = document.createElement('div');
    Object.assign(quick.style, { display: 'flex', flexWrap: 'wrap', gap: '5px' });

    // THE ONE BUTTON — the author's ask: one click to export every log + report.
    if (typeof MapShine.flight?.export === 'function') {
      const exportBtn = mb('⬇  Export everything', { rgb: '167,255,196', flexBasis: '100%', weight: '700' });
      exportBtn.addEventListener('click', async () => {
        readStatusEl().textContent = 'Building the bundle — running every read-only report…';
        exportBtn.disabled = true;
        try {
          const r = await MapShine.flight.export();
          readStatusEl().textContent = r.ok
            ? `✔ Downloaded ${r.filename} — ${(r.bytes / 1024).toFixed(0)}KB, ${r.reports} reports` +
              `${r.failures ? `, ⚠ ${r.failures} report(s) threw (captured in the bundle)` : ''}.`
            : `✘ Bundle built but the download failed: ${r.error}`;
        } catch (e) {
          readStatusEl().textContent = `✘ Export threw: ${e?.message || e}`;
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
      const fid = fo(id, entry);
      const btn = mr(id, entry.label, skin);
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
    for (const [id, entry] of controls) if (zoneOf(id, entry) === 'lab') push(entry.group ?? 'levers', mc(id, entry));

    root.appendChild(quick);
    for (const el of buildRoutedPanels('lab')) root.appendChild(el);

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
      root.appendChild(makeFolder(fid, icon, title, items));
    }
    return root;
  }

  // renderPerformanceCenter (the perf strip's own "expand for tools" area,
  // fed by {zone:'performance'} registrations), renderProductZone (the
  // Bridge/Workshop/Settings body renderer), attachPanel, and updatePerfStrip
  // are all deleted (UI parity plan, phase 7b) — every one of them depended
  // on DOM this file no longer builds (perfStripWidget, bodyEl, the panel
  // element itself). {zone:'performance'} registrations (boot.js's perf-lab/
  // perf-hud panels, the Reckoning Report action, etc.) stay fully real and
  // exporter-covered; they simply have no dedicated UI surface drawing them
  // as a group any more — each is still reachable via
  // `MapShine.debug.runReport(id)`/`buildActionButton(id)`, the same as
  // every other registered report/action.

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
    // The Lab zone's body, built (never attached) — the Studio's own LAB
    // department mount point (ui/rooms/studio/lab-department.js). Same
    // registries as this panel's own Lab zone (reports/actions/controls/
    // panels), a fresh, independently-scoped set of control builders when
    // the caller passes its own getStatusEl (see renderLab's own doc).
    renderLabBody: (opts) => renderLab(opts),
    // UI parity plan, phase 5c — the SAME private mechanism the old panel's
    // own effect-scoped `registerPanel` buildFns already receive as
    // `{attachments}` (buildRoutedPanels, above), exposed publicly so a
    // Studio EffectCardModel can pull an effect's {effect}-scoped
    // reports/actions/selects into its own `extra` without a second
    // registry or a hand-duplicated button list — Wind's own card (boot.js)
    // is the first consumer, but this is generic for any future effect
    // whose whole UI lives in loose {effect}-scoped registrations.
    buildEffectAttachments: (effectId) => attachmentsFor(effectId),
    // UI parity plan, phase 5 follow-up (author, live-testing round: "prepare
    // this section so that it can open up and allow access to a library of
    // debug buttons eventually") — a SECOND, non-effect-scoped door onto the
    // exact same reports/actions registry + the SAME makeRunnable() every
    // other button in this file already renders through (status text,
    // clipboard copy, error handling, all for free). `ui/rooms/remote/
    // debug-strip.js`'s own accordion is the first consumer, wiring in
    // 'perf-run-full' specifically, but this works for any registered id.
    buildActionButton: (id) => {
      const entry = actions.get(id) ?? reports.get(id);
      if (!entry) return null;
      return makeRunnable(id, entry.label, actions.has(id) ? ACTION_SKIN : REPORT_SKIN);
    },
    // Whole-panel VISIBILITY STATE — see this file's own `panelVisible`
    // declaration for what still drives it now that there is no panel.
    showPanel,
    hidePanel,
    togglePanel,
    isPanelVisible,
    onVisibilityChange,
    // Exposed 2026-07-29 so a caller OUTSIDE diag/ (boot.js's graphics-settings
    // panel registration) can ask "is this user a GM" without duplicating the
    // `game.user.isGM` read itself — that read belongs to the two zones this
    // wall exempts (`foundry/`, `diag/`), and boot.js is neither. One function,
    // called through, rather than the same one-liner reappearing a second
    // place and permanently widening the `foundry/adapter-only` ratchet.
    isGM,
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
