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
 */

const MAX_CONSOLE_ENTRIES = 200;

export function installDebugPanel(MapShine) {
  if (MapShine.debug) return MapShine.debug; // idempotent

  const reports = new Map(); // id -> { label, fn }
  const consoleBuffer = [];

  // Capture console.warn/error from install time onward (can't retroactively
  // see anything before this call — install this as early in boot as possible).
  for (const level of ['warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      consoleBuffer.push({
        t: new Date().toISOString(),
        level,
        msg: args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack || ''}` : safeStringify(a))).join(' '),
      });
      if (consoleBuffer.length > MAX_CONSOLE_ENTRIES) consoleBuffer.shift();
      orig(...args);
    };
  }

  function safeStringify(v) {
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v);
    } catch (_) {
      return String(v);
    }
  }

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
  function registerReport(id, label, fn) {
    reports.set(id, { label, fn });
    if (panelEl) renderButtons();
  }

  async function runReport(id) {
    const entry = reports.get(id);
    if (!entry) throw new Error(`debug-panel: unknown report "${id}"`);
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
      maxHeight: '260px',
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
    for (const [id, { label }] of reports) {
      const btn = document.createElement('button');
      btn.textContent = label;
      Object.assign(btn.style, {
        pointerEvents: 'auto',
        background: 'rgba(143,214,255,0.12)',
        border: '1px solid rgba(143,214,255,0.4)',
        borderRadius: '4px',
        color: '#cfe8ff',
        font: '10px/1.2 Signika, sans-serif',
        padding: '4px 6px',
        cursor: 'pointer',
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(143,214,255,0.28)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'rgba(143,214,255,0.12)';
      });
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
    const canvas = MapShine.__heartbeat?.renderer?.domElement || document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || MapShine.__heartbeat?.renderer?.getContext?.();
    let vendor = null,
      renderer = null,
      maxTextureSize = null,
      maxArrayLayers = null,
      extensions = [];
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      maxArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
      extensions = gl.getSupportedExtensions() || [];
    }
    return envelope('environment', {
      webgl2: !!gl,
      vendor,
      renderer,
      maxTextureSize,
      maxArrayLayers,
      hasTimerQuery: extensions.includes('EXT_disjoint_timer_query_webgl2'),
      devicePixelRatio: window.devicePixelRatio,
      screen: { width: screen.width, height: screen.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      memory: performance.memory
        ? {
            usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
            limitJSHeapMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
          }
        : null,
    });
  });

  registerReport('console', 'Console (warn/error log)', () =>
    envelope('console', {
      entryCount: consoleBuffer.length,
      entries: consoleBuffer.slice(-100), // most recent 100
    })
  );

  if (typeof MapShine.soak === 'function') {
    registerReport('soak', 'Soak (3 cycles)', async () => {
      const result = await MapShine.soak(3);
      return envelope('soak', { result });
    });
  }

  MapShine.debug = {
    registerReport,
    runReport,
    copyToClipboard,
    attachPanel,
    get reports() {
      return reports;
    },
  };
  return MapShine.debug;
}
