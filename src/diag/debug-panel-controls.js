/**
 * @fileoverview DEBUG PANEL — the reusable DOM vocabulary. Drag behaviour, the
 * injected stylesheet, the shared control builders every zone renders through
 * (buttons, runnable report/action rows, live selects), and the pure routing
 * functions that decide where a registered entry renders.
 *
 * Split out of debug-panel.js on 2026-07-25 (the size-ratchet god-object
 * reversal): that file was 1,321 lines with a 1,249-line `installDebugPanel`
 * closure. Bodies moved VERBATIM with ONE mechanical exception, called out
 * because it is the only line-level change: `statusEl` is a mutable binding in
 * debug-panel.js that is not assigned until `buildUI` runs, so the seven
 * `statusEl.textContent = …` writes below read it through a `getStatusEl()`
 * getter instead. Everything else is byte-identical.
 *
 * `makeDraggable`/`ensurePanelStyle`/`sectionLabel` and the two pure routers
 * (`routeEntry`, `sortPanelsForZone`) reference nothing from the closure and so
 * are plain module-scope exports; the rest take the panel's registries through
 * `createControlBuilders`. (`zoneIntro` and the whole 🚧 stub vocabulary were
 * deleted 2026-07-27 — see the note beside `folderOf`.)
 *
 * @module diag/debug-panel-controls
 */

function makeDraggable(handle, getHost) {
  let dragging = false;
  let grabOffsetX = 0;
  let grabOffsetY = 0;
  let moved = 0;

  handle.addEventListener('pointerdown', (e) => {
    const host = getHost();
    if (!host) return;
    const r = host.getBoundingClientRect();
    // Anchor swap — see this function's doc, point 1.
    host.style.left = `${r.left}px`;
    host.style.top = `${r.top}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    grabOffsetX = e.clientX - r.left;
    grabOffsetY = e.clientY - r.top;
    dragging = true;
    moved = 0;
    handle.style.cursor = 'grabbing';
    try {
      handle.setPointerCapture(e.pointerId); // keep the drag alive off-handle
    } catch (_) {}
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const host = getHost();
    if (!host) return;
    moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    const r = host.getBoundingClientRect();
    // Clamp — see this function's doc, point 2. A strip stays reachable.
    const maxX = Math.max(0, window.innerWidth - 60);
    const maxY = Math.max(0, window.innerHeight - 24);
    host.style.left = `${Math.max(0, Math.min(maxX, e.clientX - grabOffsetX))}px`;
    host.style.top = `${Math.max(0, Math.min(maxY, e.clientY - grabOffsetY))}px`;
    void r;
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.style.cursor = 'grab';
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch (_) {}
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  return () => moved;
}

/** Inject the panel's stylesheet once — the pseudo-element bits inline styles can't reach. */
function ensurePanelStyle() {
  if (document.getElementById('msa-debug-panel-style')) return;
  const s = document.createElement('style');
  s.id = 'msa-debug-panel-style';
  s.textContent =
    '#msa-debug-panel summary::-webkit-details-marker{display:none}' +
    '#msa-debug-panel summary:hover{background:rgba(143,214,255,0.09)}' +
    '#msa-debug-panel .msa-chev{display:inline-block;transition:transform .12s ease;opacity:.55}' +
    // `> summary >` and not a descendant selector: effect cards are `<details>`
    // containing a nested `<details>` for Advanced, and a descendant rule rotated
    // the INNER chevron whenever the OUTER card was open — a closed section
    // drawing itself as open.
    '#msa-debug-panel details[open] > summary .msa-chev{transform:rotate(90deg)}' +
    '#msa-debug-panel button:active{transform:translateY(1px)}' +
    // The preset/debug-channel dropdowns on effect cards carried this class from
    // birth with NO rule matching it anywhere in src/, styles/ or templates/, so
    // they rendered as raw browser chrome in the middle of a themed panel.
    '#msa-debug-panel .msa-effect-preset-select{' +
    'background:rgba(10,18,30,0.92);color:#dbe9fb;border:1px solid rgba(143,214,255,0.28);' +
    'border-radius:6px;padding:3px 6px;font-size:10px;font-family:inherit;outline:none}' +
    '#msa-debug-panel .msa-effect-preset-select:hover{border-color:rgba(143,214,255,0.5)}';
  document.head.appendChild(s);
}

/** The vanity footer — bug report + Patreon, carried over from V2's config menu. */

function sectionLabel(text) {
  const d = document.createElement('div');
  d.textContent = text;
  Object.assign(d.style, {
    fontSize: '9px',
    letterSpacing: '1.4px',
    textTransform: 'uppercase',
    color: '#7f97ba',
    fontWeight: '600',
    margin: '5px 0 1px',
  });
  return d;
}

/**
 * WHERE A REGISTERED ENTRY RENDERS — inside one effect's card, or in a zone body.
 *
 * ⚠️ THIS ONE LINE IS WHY THE LAB BECAME A JUNK DRAWER. Routing used to be
 * `entry.zone ?? ZONES[id] ?? 'lab'`, so the Lab was the DEFAULT sink: every
 * diagnostic registered without an explicit zone piled into it. By 2026-07-27 its
 * catch-all "More" drawer held twelve entries, EIGHT of which belonged to a
 * specific effect — which is exactly why the specular probe sat a rail click away
 * from the specular card. The fix is not a better default, it is a second
 * destination: an entry that declares `{ effect }` renders in that effect's own
 * Advanced section and in no zone at all.
 *
 * `'lab'` remains the zone fallback deliberately — a control that lands somewhere
 * unexpected is recoverable, one that renders nowhere is invisible. The build-time
 * wall is what stops the drawer re-forming; the runtime never loses a control.
 *
 * Pure and exported so both halves are Node-tested: this file's DOM builders are
 * browser-verified only (CONVENTIONS §4), and routing is the part with the bug in it.
 *
 * @param {string} id
 * @param {{zone?: string, effect?: string}} [entry]
 * @param {Record<string, string>} [zones] - legacy id→zone overrides, consulted
 *   only when the entry declares no zone of its own.
 * @returns {{kind: 'effect', effect: string} | {kind: 'zone', zone: string}}
 */
export function routeEntry(id, entry, zones = {}) {
  const effect = entry?.effect;
  if (typeof effect === 'string' && effect.length > 0) return { kind: 'effect', effect };
  return { kind: 'zone', zone: entry?.zone ?? zones?.[id] ?? 'lab' };
}

/**
 * Panels for one zone, in declared order. `order` defaults to 0 and ties keep
 * registration order (`Array.prototype.sort` is stable), so an un-ordered panel
 * behaves exactly as it did before this existed. Negative numbers pin to the top —
 * that is how the astrolabe stays the Bridge's hero no matter when it registers.
 *
 * Before this, panel order was Map-insertion order, i.e. whatever sequence
 * `install()` happened to call `registerPanel` in. Silently fragile: moving a
 * block of boot.js re-ordered the UI.
 *
 * ============================================================================
 * ⚠️ DOES NOT DELEGATE TO `routeEntry` — AND MUST NOT, EVER AGAIN
 * ============================================================================
 * 2026-07-28 LIVE BUG (author: "the Make rail is broken, there are no effects
 * in there"). This function used to be `routeEntry(id, e, zones).kind ===
 * 'zone' && ...zone === zone`, reusing the SAME router `zoneOf` uses for
 * `controls`/`actions`/`reports`. That router treats a truthy `entry.effect` as
 * an unconditional override — correct for THOSE three registries, where
 * `{ effect }` means "fold this button into that effect's card instead of
 * drawing it in a zone body" (see `attachmentsFor`).
 *
 * `entry.effect` on a PANEL means something else entirely: `buildRoutedPanels`
 * passes `attachmentsFor(entry.effect)` into every panel's own `buildFn`, so
 * `effect` on a panel means "gather MY OWN attachments from this effect id" —
 * it has nothing to do with where the panel itself renders. Every real effect
 * panel (`boot.js`'s ~10 `registerPanel` calls for bloom/water/fluid/specular/
 * etc.) legitimately declares BOTH `zone: 'workshop'` (so IT renders) AND
 * `effect: '<id>'` (so it can gather ITS OWN adjunct reports/actions) — and the
 * shared router's "effect beats zone" rule silently routed every one of them to
 * `kind: 'effect'`, which `attachmentsFor` never even reads for `panels` (it
 * only scans `controls`/`actions`/`reports`). The result was not "moved to the
 * wrong place" — it was **rendered nowhere at all**, for every effect card at
 * once, with `npm test` fully green throughout: the only test of this function
 * modelled a panel as declaring EITHER `zone` OR `effect`, never both on the
 * same entry, so it never exercised the shape every real call site actually
 * uses. See `__tests__/effect-controls.test.mjs` for the regression.
 *
 * So: a panel's zone is `entry.zone ?? zones[id] ?? 'lab'`, full stop.
 * `entry.effect` is read here NOT AT ALL — only by `attachmentsFor`, via the
 * SAME opts object, for a completely different purpose. If you are tempted to
 * make this "consistent" with `routeEntry` again, read this comment first.
 *
 * @param {Iterable<[string, object]>} entries
 * @param {string} zone
 * @param {Record<string, string>} [zones]
 * @returns {Array<[string, object]>}
 */
export function sortPanelsForZone(entries, zone, zones = {}) {
  return [...entries]
    .filter(([id, e]) => (e?.zone ?? zones?.[id] ?? 'lab') === zone)
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));
}

export { makeDraggable, ensurePanelStyle, sectionLabel };

// Readouts in blue, actions in amber — the colour is not decoration: a button
// that restarts your scene must not look identical to one that reads a counter.
// Module scope + exported because BOTH sides need them: the builders below skin
// their buttons with these, and debug-panel.js's Lab/product renderers pass them
// back in when placing rows.
export const REPORT_SKIN = { rgb: '143,214,255' };
export const ACTION_SKIN = { rgb: '255,196,120' };

/**
 * Bind the shared control builders to the panel's registries.
 * @param {object} deps
 * @param {Function} deps.runReport @param {Function} deps.copyToClipboard
 * @param {() => (HTMLElement|null)} deps.getStatusEl - reads the LIVE status
 *   element; it does not exist until buildUI has run, so this cannot be a value.
 * @param {Array<{id:string,title:string,icon:string,ids:string[]}>} deps.FOLDERS
 *   - the folder-routing table `folderOf` consults; it lives in debug-panel.js
 *   because that is where the panel's zone/folder layout is declared.
 */
export function createControlBuilders({ runReport, copyToClipboard, getStatusEl, FOLDERS }) {
  // ---- shared control builders (used by EVERY zone) ------------------------
  // Hoisted out of the old renderButtons so the product zones can render real
  // controls with the same look/behaviour as the Lab.

  /**
   * @param {string} label @param {{rgb: string, flexBasis?: string, weight?: string}} skin
   * @returns {HTMLButtonElement}
   */
  function makeButton(label, skin) {
    const btn = document.createElement('button');
    btn.textContent = label;
    const idle = `rgba(${skin.rgb},0.14)`;
    const hover = `rgba(${skin.rgb},0.30)`;
    Object.assign(btn.style, {
      pointerEvents: 'auto',
      background: idle,
      border: `1px solid rgba(${skin.rgb},0.42)`,
      borderRadius: '6px',
      color: '#eaf4ff',
      font: '10px/1.2 Signika, sans-serif',
      fontWeight: skin.weight ?? 'normal',
      padding: '5px 8px',
      cursor: 'pointer',
      transition: 'background .1s ease',
      ...(skin.flexBasis ? { flexBasis: skin.flexBasis } : {}),
    });
    btn.addEventListener('mouseenter', () => {
      btn.style.background = hover;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = idle;
    });
    return btn;
  }

  // A report/action button: click → run → copy to clipboard → report status.
  function makeRunnable(id, label, skin) {
    const btn = makeButton(label, skin);
    btn.addEventListener('click', async () => {
      getStatusEl().textContent = `Running "${id}"…`;
      try {
        const text = await runReport(id);
        const copied = await copyToClipboard(text);
        getStatusEl().textContent = copied
          ? `✔ Copied "${id}" (${text.length.toLocaleString()} chars, ${new Date().toLocaleTimeString()}).`
          : `⚠ "${id}" generated but clipboard copy failed — check console (also logged).`;
        if (!copied) console.log(`[debug-panel] ${id}:\n${text}`);
      } catch (e) {
        getStatusEl().textContent = `✘ "${id}" threw: ${e?.message || e}`;
        console.error(`[debug-panel] report "${id}" failed:`, e);
      }
    });
    return btn;
  }

  // A live select control (renderer switch, darkness lever, …). Fill logic is
  // unchanged: re-read on open so a thunk-options menu can't show stale choices.
  function makeControl(id, { label, options, getValue, onChange }) {
    const wrap = document.createElement('label');
    Object.assign(wrap.style, {
      pointerEvents: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: '5px',
      flexBasis: '100%',
      font: '10px/1.2 Signika, sans-serif',
    });
    wrap.append(label);
    const sel = document.createElement('select');
    Object.assign(sel.style, {
      pointerEvents: 'auto',
      flex: '1',
      background: 'rgba(10,14,22,0.9)',
      border: '1px solid rgba(143,214,255,0.4)',
      borderRadius: '5px',
      color: '#cfe8ff',
      font: '10px/1.2 Signika, sans-serif',
      padding: '3px',
    });
    const fill = () => {
      let list;
      try {
        list = typeof options === 'function' ? options() : options;
      } catch (err) {
        console.error(`[debug-panel] control "${id}" could not list its options:`, err);
        list = [];
      }
      sel.innerHTML = '';
      for (const o of list) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.append(opt);
      }
      try {
        sel.value = getValue() ?? '';
      } catch {
        /* a control that cannot read its own state still renders; it just starts blank */
      }
    };
    fill();
    sel.addEventListener('mousedown', fill); // re-read on open — menu reflects the click, not page load
    sel.addEventListener('change', async () => {
      getStatusEl().textContent = `${label}: ${sel.value || 'off'}…`;
      try {
        await onChange(sel.value);
        getStatusEl().textContent = `${label}: ${sel.value || 'off'} ✓`;
      } catch (err) {
        getStatusEl().textContent = `${label} failed: ${err?.message ?? err}`;
        console.error(`[debug-panel] control "${id}" failed:`, err);
      }
    });
    wrap.append(sel);
    return wrap;
  }

  // REPORT_SKIN / ACTION_SKIN moved to module scope above — both this factory
  // and debug-panel.js's own renderers need them.
  //
  // The 🚧 STUB VOCABULARY (`makeStub`, `stubRow`, `stubGallery`,
  // `stubSegmented`, `STUB_SKIN`) WAS DELETED 2026-07-27, along with all 21
  // placeholders it drew. It was scaffolding for judging the product zones'
  // arrangement before real renderers existed, and it outlived that job: two of
  // its buttons ended up duplicating live controls a few pixels above them
  // ("Toggle darkness" beside the working darkness select, "Recall camera"
  // beside the working camera-path button), and its "Water" tile sat directly
  // under the real, working Water card. That is exactly the failure the panel's
  // own astrolabe comment already named — "a stub left beside the thing it was
  // standing in for is a dead control" — reproduced eight more times. Do not
  // reintroduce it: a planned feature belongs in docs/planning, not on screen.

  // Which Lab sub-folder an entry belongs to. A declared `{ primary }`/`{ group }`
  // wins; else the FOLDERS membership map; else "More" (visible, never a guessed
  // wrong folder). `primary` is now ONLY self-declared at the registration site —
  // the panel's parallel `PRIMARY` id set was deleted 2026-07-27, because a
  // hand-maintained list of "the important ones" living a file away from the
  // things it named is the same drift the FOLDERS comment already warns about.
  const folderOf = (id, entry) => {
    if (entry.primary) return '__primary__';
    if (entry.group) return entry.group;
    for (const f of FOLDERS) if (f.ids.includes(id)) return f.id;
    return '__more__';
  };

  return {
    makeButton,
    makeRunnable,
    makeControl,
    folderOf,
  };
}
