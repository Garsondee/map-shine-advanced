/**
 * src/diag/debug-panel.js — the temporary Keyhole debugging control panel.
 *
 * Lives in the same corner box as the boot heartbeat triangle. A growing set
 * of buttons, one per registered "report" — click one and its output is
 * copied to the clipboard as text, ready to paste back into chat. This is the
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

export function installDebugPanel(MapShine) {
  if (MapShine.debug) return MapShine.debug; // idempotent

  const reports = new Map(); // id -> { label, fn } — PURE READOUTS. The exporter runs these.
  const actions = new Map(); // id -> { label, fn } — side effects. The exporter never runs these.
  const controls = new Map(); // id -> { label, options, getValue, onChange } — live controls, rendered first

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
  function registerSelect(id, label, options, getValue, onChange) {
    controls.set(id, { label, options, getValue, onChange });
    if (listEl) renderButtons();
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
    if (listEl) renderButtons();
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
  function registerReport(id, label, fn) {
    reports.set(id, { label, fn });
    if (panelEl) renderButtons();
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
  function registerAction(id, label, fn) {
    actions.set(id, { label, fn });
    if (panelEl) renderButtons();
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
  let listEl = null;
  let collapsed = false;

  /** Pointer travel (px) below which a pointerdown→up counts as a CLICK, not a drag. */
  const DRAG_CLICK_SLOP_PX = 4;

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

  function buildUI() {
    const panel = document.createElement('div');
    panelEl = panel;
    panel.id = 'msa-debug-panel';
    Object.assign(panel.style, {
      pointerEvents: 'auto',
      marginTop: '6px',
      background: 'rgba(10,14,22,0.88)',
      border: '1px solid rgba(143,214,255,0.35)',
      borderRadius: '8px',
      padding: '6px',
      font: '11px/1.3 Signika, sans-serif',
      color: '#cfe8ff',
      width: '420px',
      maxHeight: '340px',
      overflowY: 'auto',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      cursor: 'grab',
      fontWeight: 'bold',
      marginBottom: '4px',
      touchAction: 'none', // let pointermove reach us instead of becoming a scroll gesture
    });
    header.innerHTML = `<span>🗝️ Keyhole Debug Panel</span><span id="msa-debug-toggle">▾</span>`;

    // DRAGGABLE (author-reported, 2026-07-16: the panel sits under Foundry's
    // right-hand sidebar). The default position now clears the sidebar, but "the
    // right default" is a guess about someone else's screen — dragging is the
    // thing that actually solves it, for any layout, at any resolution.
    //
    // The whole HOST moves, not just this panel: the heartbeat triangle and the
    // panel are one unit (the panel is a child of the host), and dragging half of
    // a visually-joined widget away from the other half would be daft.
    const dragMoved = makeDraggable(header, () => panelEl?.parentElement);

    header.addEventListener('click', () => {
      // Only collapse on a genuine CLICK. Without this, every drag that ends over
      // the header also toggles — so you could never reposition the panel without
      // also folding it up.
      if (dragMoved() > DRAG_CLICK_SLOP_PX) return;
      collapsed = !collapsed;
      listEl.style.display = collapsed ? 'none' : '';
      statusEl.style.display = collapsed ? 'none' : '';
      header.querySelector('#msa-debug-toggle').textContent = collapsed ? '▸' : '▾';
    });

    listEl = document.createElement('div');
    listEl.style.display = 'flex';
    listEl.style.flexWrap = 'wrap';
    listEl.style.gap = '4px';

    statusEl = document.createElement('div');
    Object.assign(statusEl.style, { marginTop: '5px', color: '#9fd', minHeight: '14px', wordBreak: 'break-word' });
    statusEl.textContent = 'Click a report to copy it to the clipboard.';

    panel.appendChild(header);
    panel.appendChild(listEl);
    panel.appendChild(statusEl);
    return panel;
  }

  function renderButtons() {
    listEl.innerHTML = '';
    for (const [id, { label, options, getValue, onChange }] of controls) {
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
        borderRadius: '4px',
        color: '#cfe8ff',
        font: '10px/1.2 Signika, sans-serif',
        padding: '3px',
      });
      // Fill from the CURRENT choices and the CURRENT value. Called again on every
      // open, so a thunk-options control (see registerSelect) can never show a menu
      // built from state that has since moved on.
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
      // Re-read on open: `mousedown` lands before the menu paints, so the list the
      // author sees is the list as of the click, not as of page load.
      sel.addEventListener('mousedown', fill);
      sel.addEventListener('change', async () => {
        statusEl.textContent = `${label}: ${sel.value || 'off'}…`;
        try {
          await onChange(sel.value);
          statusEl.textContent = `${label}: ${sel.value || 'off'} ✓`;
        } catch (err) {
          statusEl.textContent = `${label} failed: ${err?.message ?? err}`;
          console.error(`[debug-panel] control "${id}" failed:`, err);
        }
      });
      wrap.append(sel);
      listEl.append(wrap);
    }
    /**
     * @param {string} label @param {{rgb: string, flexBasis?: string, weight?: string}} skin
     * @returns {HTMLButtonElement}
     */
    const makeButton = (label, skin) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      const idle = `rgba(${skin.rgb},0.12)`;
      const hover = `rgba(${skin.rgb},0.28)`;
      Object.assign(btn.style, {
        pointerEvents: 'auto',
        background: idle,
        border: `1px solid rgba(${skin.rgb},0.4)`,
        borderRadius: '4px',
        color: '#cfe8ff',
        font: `10px/1.2 Signika, sans-serif`,
        fontWeight: skin.weight ?? 'normal',
        padding: '4px 6px',
        cursor: 'pointer',
        ...(skin.flexBasis ? { flexBasis: skin.flexBasis } : {}),
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.background = hover;
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = idle;
      });
      return btn;
    };

    // THE ONE BUTTON, first and full-width — the author's ask: "press a single
    // button to export all MSA logs and all supporting information". Everything
    // below it is the by-hand version of what this does in one click.
    if (typeof MapShine.flight?.export === 'function') {
      const exportBtn = makeButton('⬇ Export everything (flight recorder)', {
        rgb: '167,255,196',
        flexBasis: '100%',
        weight: 'bold',
      });
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
          // finally: an export that fails must not leave the button dead — that
          // would make the recovery path "reload Foundry", which is the one thing
          // a person reaching for this button cannot afford to do (it wipes the
          // very session they are trying to report).
          exportBtn.disabled = false;
        }
      });
      listEl.appendChild(exportBtn);
    }

    /** @param {Map<string, {label: string}>} map @param {{rgb: string}} skin */
    const renderRunnables = (map, skin) => {
      for (const [id, { label }] of map) {
        const btn = makeButton(label, skin);
        btn.addEventListener('click', async () => {
          statusEl.textContent = `Running "${id}"…`;
          try {
            const text = await runReport(id);
            const copied = await copyToClipboard(text);
            statusEl.textContent = copied
              ? `✔ Copied "${id}" to clipboard (${text.length.toLocaleString()} chars, ${new Date().toLocaleTimeString()}).`
              : `⚠ "${id}" generated but clipboard copy failed — check console for the text (also logged).`;
            if (!copied) console.log(`[debug-panel] ${id}:\n${text}`);
          } catch (e) {
            statusEl.textContent = `✘ "${id}" threw: ${e?.message || e}`;
            console.error(`[debug-panel] report "${id}" failed:`, e);
          }
        });
        listEl.appendChild(btn);
      }
    };

    // Readouts in blue, actions in amber. The colour is not decoration: a button
    // that restarts your scene should not look identical to one that reads a
    // counter, and until today they did.
    renderRunnables(reports, { rgb: '143,214,255' });
    renderRunnables(actions, { rgb: '255,196,120' });
  }

  /** Call once the boot heartbeat box exists in the DOM. Idempotent. */
  function attachPanel(panelHost) {
    if (panelEl) return panelEl;
    panelEl = buildUI();
    panelHost.appendChild(panelEl);
    renderButtons();
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
    refreshControls,
    runReport,
    copyToClipboard,
    attachPanel,
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
