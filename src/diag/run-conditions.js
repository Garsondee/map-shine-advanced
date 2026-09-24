/**
 * RUN CONDITIONS — "was this measurement taken under conditions it can be
 * trusted in?" (2026-09-24, mythica-machina-press perf-rig setup).
 *
 * Every perf number is only as good as the window it was measured in, and the
 * single easiest way to ruin one is invisible from inside the numbers: a
 * browser stops drawing frames for a MINIMISED window, and on Windows also for
 * a window that is FULLY COVERED by another one (Chromium's native occlusion
 * tracking flips `document.visibilityState` to 'hidden' either way). A route
 * measured half-covered produces a plausible-looking report whose frame counts,
 * hitch stats and per-zone means all quietly describe a stalled loop. The load
 * report already accounts for this (`load-report.js#buildBackgroundSection`);
 * the performance actions never did — this closes that gap.
 *
 * Also stamped, because two reports are only comparable if they were taken on
 * the same canvas: viewport size + devicePixelRatio (fragment cost scales with
 * physical pixel count — a 1080p and a 1440p run of the same scene are
 * different workloads), and the GPU adapter + browser that did the work.
 *
 * VERDICT RULES (strict on purpose — the cost of a false "valid" is a wrong
 * baseline that every later comparison inherits):
 *   - any hidden time at all            → invalid (the loop was not drawing);
 *   - viewport or DPR changed mid-run   → invalid (the workload changed);
 *   - focus lost                        → NOTED ONLY. An unfocused but visible
 *     window keeps rendering at full rate; flagging it would invalidate every
 *     run where the author clicks on another monitor, for no reason.
 *
 * TIMELINE (2026-09-24): every hide/show and canvas-size change is recorded
 * with its time and the sweep PHASE it landed in (`notePhase` — fed from the
 * on-screen progress text), plus explicit `checkpoint(name)`s. A 25-minute
 * sweep whose Chrome extension blipped at minute 20 is then honestly "invalid
 * as a whole, clean up to checkpoint X" instead of all-or-nothing.
 *
 * Pure except for the injected `win`/`doc` — tests drive it with fakes.
 */

const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/**
 * @param {object} [env]
 * @param {Window} [env.win]
 * @param {Document} [env.doc]
 * @param {() => number} [env.now]
 * @param {() => object|null} [env.readAdapter]  GPU adapter info, or null
 */
export function createRunConditionsMonitor(env = {}) {
  const win = env.win ?? (typeof window !== 'undefined' ? window : null);
  const doc = env.doc ?? (typeof document !== 'undefined' ? document : null);
  const now = env.now ?? (() => performance.now());
  const readAdapter = env.readAdapter ?? (() => null);
  // Optional: the render-scale governor's state. Sampled on a slow timer (not
  // per frame — this must cost nothing measurable) so an AUTO governor that
  // moves internal resolution mid-run is visible in the stamp.
  const readRenderScale = env.readRenderScale ?? null;
  const setIntervalFn = env.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = env.clearInterval ?? ((id) => clearInterval(id));
  const sampleIntervalMs = env.sampleIntervalMs ?? 1000;

  let startedAt = null;
  let hiddenSince = null;
  let hiddenMs = 0;
  let hiddenEpisodes = 0;
  let blurredSince = null;
  let unfocusedMs = 0;
  let resizeEvents = 0;
  let startViewport = null;
  let listening = false;
  let scaleTimer = null;
  let scaleStart = null;
  let scaleLastKey = null;
  let scaleChanges = 0;
  let scaleSeen = new Set();
  const MAX_EVENTS = 100;
  let events = [];
  let checkpoints = [];
  let currentPhase = null;
  let lastPhaseKey = null;
  let lastCanvasKey = null;
  let firstInvalid = null;

  const canvasKey = (vp) => (vp ? `${vp.physicalWidth}x${vp.physicalHeight}@${vp.devicePixelRatio}` : null);
  const pushEvent = (kind, extra = {}) => {
    const ev = { atMs: round(now() - startedAt), kind, phase: currentPhase, ...extra };
    if (events.length < MAX_EVENTS) events.push(ev);
    if ((kind === 'hidden' || kind === 'canvas') && firstInvalid === null) firstInvalid = ev;
  };

  const readScaleSafe = () => {
    if (!readRenderScale) return null;
    try {
      const s = readRenderScale();
      if (!s || s.skipped) return null;
      return {
        userSetting: s.userSetting ?? null,
        internalScale: s.resolvedInternalScale ?? null,
        internalW: s.internalW ?? null,
        internalH: s.internalH ?? null,
      };
    } catch {
      return null;
    }
  };
  const sampleScale = () => {
    const s = readScaleSafe();
    if (!s) return;
    const key = `${s.internalScale}|${s.internalW}x${s.internalH}`;
    if (scaleLastKey !== null && key !== scaleLastKey) scaleChanges++;
    scaleLastKey = key;
    scaleSeen.add(key);
  };

  const readViewport = () => {
    if (!win) return null;
    const w = win.innerWidth;
    const h = win.innerHeight;
    const dpr = win.devicePixelRatio ?? 1;
    return {
      cssWidth: w,
      cssHeight: h,
      devicePixelRatio: dpr,
      physicalWidth: Math.round(w * dpr),
      physicalHeight: Math.round(h * dpr),
      screenWidth: win.screen?.width ?? null,
      screenHeight: win.screen?.height ?? null,
    };
  };

  const isHidden = () => doc?.visibilityState === 'hidden';

  const onVisibility = () => {
    const t = now();
    if (isHidden()) {
      if (hiddenSince === null) {
        hiddenSince = t;
        hiddenEpisodes++;
        pushEvent('hidden');
      }
    } else if (hiddenSince !== null) {
      hiddenMs += t - hiddenSince;
      hiddenSince = null;
      pushEvent('visible');
    }
  };
  const onBlur = () => {
    if (blurredSince === null) blurredSince = now();
  };
  const onFocus = () => {
    if (blurredSince !== null) {
      unfocusedMs += now() - blurredSince;
      blurredSince = null;
    }
  };
  const onResize = () => {
    resizeEvents++;
    const vp = readViewport();
    const key = canvasKey(vp);
    if (key !== lastCanvasKey) {
      pushEvent('canvas', { from: lastCanvasKey, to: key });
      lastCanvasKey = key;
    }
  };

  /** Phase label from the on-screen progress text; counters are stripped so
   * "555 frames · 7.0s" ticking does not count as a new phase. */
  function notePhase(text) {
    if (startedAt === null || typeof text !== 'string') return;
    const key = text.replace(/[0-9.]+/g, '#');
    if (key === lastPhaseKey) return;
    lastPhaseKey = key;
    currentPhase = text.length > 160 ? `${text.slice(0, 157)}...` : text;
  }

  /** A named point in the run ("main-route-end"); records whether the run
   * was still clean at that moment. */
  function checkpoint(name) {
    if (startedAt === null) return;
    checkpoints.push({ name, atMs: round(now() - startedAt), cleanSoFar: firstInvalid === null });
  }

  function start() {
    startedAt = now();
    hiddenMs = 0;
    hiddenEpisodes = 0;
    unfocusedMs = 0;
    resizeEvents = 0;
    hiddenSince = isHidden() ? startedAt : null;
    if (hiddenSince !== null) hiddenEpisodes = 1;
    const focused = typeof doc?.hasFocus === 'function' ? doc.hasFocus() : true;
    blurredSince = focused ? null : startedAt;
    startViewport = readViewport();
    events = [];
    checkpoints = [];
    currentPhase = null;
    lastPhaseKey = null;
    firstInvalid = null;
    lastCanvasKey = canvasKey(startViewport);
    if (hiddenSince !== null) {
      const ev = { atMs: 0, kind: 'hidden', phase: null };
      events.push(ev);
      firstInvalid = ev;
    }
    scaleChanges = 0;
    scaleSeen = new Set();
    scaleLastKey = null;
    scaleStart = readScaleSafe();
    sampleScale();
    if (readRenderScale && scaleTimer === null) scaleTimer = setIntervalFn(sampleScale, sampleIntervalMs);
    if (!listening) {
      doc?.addEventListener?.('visibilitychange', onVisibility);
      win?.addEventListener?.('blur', onBlur);
      win?.addEventListener?.('focus', onFocus);
      win?.addEventListener?.('resize', onResize);
      listening = true;
    }
  }

  function stop() {
    if (startedAt === null) return null;
    const endedAt = now();
    if (hiddenSince !== null) hiddenMs += endedAt - hiddenSince;
    if (blurredSince !== null) unfocusedMs += endedAt - blurredSince;
    hiddenSince = null;
    blurredSince = null;
    if (listening) {
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      win?.removeEventListener?.('blur', onBlur);
      win?.removeEventListener?.('focus', onFocus);
      win?.removeEventListener?.('resize', onResize);
      listening = false;
    }
    if (scaleTimer !== null) {
      clearIntervalFn(scaleTimer);
      scaleTimer = null;
    }
    sampleScale();
    const scaleEnd = readScaleSafe();
    const endViewport = readViewport();
    let adapter = null;
    try {
      adapter = readAdapter();
    } catch {
      adapter = null;
    }
    const result = buildRunConditions({
      durationMs: endedAt - startedAt,
      hiddenMs,
      hiddenEpisodes,
      unfocusedMs,
      resizeEvents,
      startViewport,
      endViewport,
      adapter,
      events,
      checkpoints,
      firstInvalid,
      renderScale: readRenderScale
        ? { start: scaleStart, end: scaleEnd, changes: scaleChanges, distinct: [...scaleSeen] }
        : null,
      userAgent: win?.navigator?.userAgent ?? null,
      hardwareConcurrency: win?.navigator?.hardwareConcurrency ?? null,
    });
    startedAt = null;
    return result;
  }

  return { start, stop, notePhase, checkpoint };
}

/** Pure verdict builder — exported for tests. */
export function buildRunConditions({
  durationMs,
  hiddenMs,
  hiddenEpisodes,
  unfocusedMs,
  resizeEvents,
  startViewport,
  endViewport,
  adapter,
  events = [],
  checkpoints = [],
  firstInvalid = null,
  renderScale = null,
  userAgent,
  hardwareConcurrency,
}) {
  const invalidReasons = [];
  const notes = [];
  if (hiddenMs > 0) {
    invalidReasons.push(
      `The window was hidden, minimised or fully covered for ${round(hiddenMs)}ms ` +
        `(${hiddenEpisodes} time${hiddenEpisodes === 1 ? '' : 's'}). Browsers stop drawing frames while a ` +
        'window is not visible, so this run measured a stalled loop for that stretch. Re-run with the window ' +
        'uncovered for the whole run.'
    );
  }
  const vpChanged =
    !!startViewport &&
    !!endViewport &&
    (startViewport.physicalWidth !== endViewport.physicalWidth ||
      startViewport.physicalHeight !== endViewport.physicalHeight ||
      startViewport.devicePixelRatio !== endViewport.devicePixelRatio);
  const canvasEvents = (events ?? []).filter((ev) => ev.kind === 'canvas');
  if (!vpChanged && canvasEvents.length > 0) {
    // A flip-and-back (the Chrome extension's debugging bar appearing and
    // vanishing) ends at the start size, so a start/end compare alone would
    // call it valid — while part of the run measured a different canvas.
    invalidReasons.push(
      `The canvas size changed ${canvasEvents.length} time(s) mid-run (${canvasEvents
        .map((ev) => `${ev.from} → ${ev.to} at ${Math.round(ev.atMs / 1000)}s`)
        .join(', ')}) before returning to its starting size. Part of this run measured a different workload.`
    );
  }
  if (vpChanged) {
    invalidReasons.push(
      `The canvas size changed mid-run (${startViewport.physicalWidth}×${startViewport.physicalHeight} → ` +
        `${endViewport.physicalWidth}×${endViewport.physicalHeight} physical px). Per-pixel cost changed with it, ` +
        'so the start and end of this run measured different workloads.'
    );
  } else if (resizeEvents > 0) {
    notes.push(`${resizeEvents} resize event(s) fired, but the final canvas size matched the start.`);
  }
  if (renderScale && renderScale.changes > 0) {
    notes.push(
      `Internal render resolution changed ${renderScale.changes} time(s) during this run ` +
        `(${renderScale.distinct.join(', ')}). Expected in a run that deliberately switches quality tiers; ` +
        'otherwise it means the auto governor moved resolution, and before/after comparisons of per-pixel ' +
        'cost are confounded. Pin a fixed render scale for benchmark runs.'
    );
  }
  if (unfocusedMs > 0) {
    notes.push(
      `The window was unfocused for ${round(unfocusedMs)}ms. Not a problem on its own: a visible, unfocused ` +
        'window keeps rendering at full rate.'
    );
  }
  return {
    valid: invalidReasons.length === 0,
    invalidReasons,
    notes,
    durationMs: round(durationMs),
    hiddenMs: round(hiddenMs),
    hiddenEpisodes,
    unfocusedMs: round(unfocusedMs),
    viewport: endViewport ?? startViewport ?? null,
    viewportAtStart: vpChanged ? startViewport : undefined,
    adapter: adapter ?? null,
    // Where the run first went bad, and which checkpoints it was still clean
    // at — so an invalid run can still vouch for its early phases.
    firstInvalid,
    checkpoints,
    events,
    renderScale,
    userAgent: userAgent ?? null,
    hardwareConcurrency: hardwareConcurrency ?? null,
  };
}

/** WebGPU adapter info off a three.js WebGPURenderer, or null. */
export function readRendererAdapterInfo(renderer) {
  // three's WebGPUBackend does not keep the GPUAdapter around (verified live
  // 2026-09-24: `backend.adapter` undefined), but the device carries the same
  // info as `GPUDevice.adapterInfo` (Chrome 132+). Adapter first, device second.
  const info = renderer?.backend?.adapter?.info ?? renderer?.backend?.device?.adapterInfo;
  if (!info) return null;
  return {
    backend: renderer?.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2',
    vendor: info.vendor ?? null,
    architecture: info.architecture ?? null,
    device: info.device ?? null,
    description: info.description ?? null,
  };
}
