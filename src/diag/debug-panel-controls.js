/**
 * @fileoverview DEBUG PANEL — the reusable DOM vocabulary. Drag behaviour, the
 * injected stylesheet, the shared control builders every zone renders through
 * (buttons, runnable report/action rows, live selects, "planned" stubs), and
 * the Tier-0 product-zone scaffold pieces.
 *
 * Split out of debug-panel.js on 2026-07-25 (the size-ratchet god-object
 * reversal): that file was 1,321 lines with a 1,249-line `installDebugPanel`
 * closure. Bodies moved VERBATIM with ONE mechanical exception, called out
 * because it is the only line-level change: `statusEl` is a mutable binding in
 * debug-panel.js that is not assigned until `buildUI` runs, so the seven
 * `statusEl.textContent = …` writes below read it through a `getStatusEl()`
 * getter instead. Everything else is byte-identical.
 *
 * `makeDraggable`/`ensurePanelStyle`/`sectionLabel`/`zoneIntro` reference
 * nothing from the closure at all (verified before moving) and so are plain
 * module-scope exports; the rest take the panel's registries through
 * `createControlBuilders`.
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
    '#msa-debug-panel details[open] .msa-chev{transform:rotate(90deg)}' +
    '#msa-debug-panel button:active{transform:translateY(1px)}';
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

function zoneIntro(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  Object.assign(d.style, { fontSize: '10.5px', color: '#9fb6d8', lineHeight: '1.5', marginBottom: '3px' });
  return d;
}

export { makeDraggable, ensurePanelStyle, sectionLabel, zoneIntro };

// Readouts in blue, actions in amber — the colour is not decoration: a button
// that restarts your scene must not look identical to one that reads a counter.
// Module scope + exported because BOTH sides need them: the builders below skin
// their buttons with these, and debug-panel.js's Lab/product renderers pass them
// back in when placing rows.
export const REPORT_SKIN = { rgb: '143,214,255' };
export const ACTION_SKIN = { rgb: '255,196,120' };
const STUB_SKIN = { rgb: '120,140,170' }; // muted grey: a control that isn't wired yet

/**
 * Bind the shared control builders to the panel's registries.
 * @param {object} deps
 * @param {Function} deps.runReport @param {Function} deps.copyToClipboard
 * @param {() => (HTMLElement|null)} deps.getStatusEl - reads the LIVE status
 *   element; it does not exist until buildUI has run, so this cannot be a value.
 * @param {Set<string>} deps.PRIMARY - ids that get quick-reach placement.
 * @param {Array<{id:string,title:string,icon:string,ids:string[]}>} deps.FOLDERS
 *   - the folder-routing table `folderOf` consults; it lives in debug-panel.js
 *   because that is where the panel's zone/folder layout is declared.
 */
export function createControlBuilders({ runReport, copyToClipboard, getStatusEl, PRIMARY, FOLDERS }) {
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

  // REPORT_SKIN / ACTION_SKIN / STUB_SKIN moved to module scope above — both
  // this factory and debug-panel.js's own renderers need them.

  /**
   * A "planned, not wired yet" placeholder (🚧). Deliberately inert — clicking it
   * only says so. This is the scaffold that lets the four product zones' final
   * arrangement be judged before the real renderers exist.
   */
  function makeStub(label) {
    const btn = makeButton(`🚧 ${label}`, STUB_SKIN);
    btn.style.opacity = '0.6';
    btn.style.borderStyle = 'dashed';
    btn.style.cursor = 'default';
    btn.title = 'Planned — not wired yet';
    btn.addEventListener('click', () => {
      getStatusEl().textContent = `🚧 “${label}” is planned — not wired yet (Tier 0 scaffold).`;
    });
    return btn;
  }

  // Which Lab sub-folder an entry belongs to. A declared `{ group }`/`{ primary }`
  // wins; else the FOLDERS membership map; else "More" (visible, never a guessed
  // wrong folder).
  const folderOf = (id, entry) => {
    if (entry.primary || PRIMARY.has(id)) return '__primary__';
    if (entry.group) return entry.group;
    for (const f of FOLDERS) if (f.ids.includes(id)) return f.id;
    return '__more__';
  };

  function stubRow(labels) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexWrap: 'wrap', gap: '5px' });
    for (const l of labels) {
      const b = makeStub(l);
      b.style.flex = '1 1 calc(50% - 3px)';
      b.style.textAlign = 'left';
      wrap.appendChild(b);
    }
    return wrap;
  }

  function stubGallery(labels) {
    const grid = document.createElement('div');
    Object.assign(grid.style, { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '6px' });
    for (const l of labels) grid.appendChild(makeStub(l));
    return grid;
  }

  function stubSegmented(labels) {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '3px' });
    for (const o of labels) {
      const b = makeStub(o);
      b.textContent = o; // inside a segmented control the 🚧 prefix is dropped; the row sits under a "Planned" label
      b.style.flex = '1';
      b.style.padding = '5px 2px';
      b.style.textAlign = 'center';
      row.appendChild(b);
    }
    return row;
  }

  return {
    makeButton,
    makeRunnable,
    makeControl,
    makeStub,
    folderOf,
    stubRow,
    stubGallery,
    stubSegmented,
  };
}
