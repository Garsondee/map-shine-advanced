/**
 * @fileoverview Clean Performance Recorder test — hides MSA overlay UI, settles,
 * records for a fixed duration, settles again, then restores prior UI state.
 *
 * @module core/diagnostics/performance-recorder-clean-test
 */

import { createLogger } from '../log.js';

const log = createLogger('PerfRecorderCleanTest');

/** Default timings for the "10 Second Test Mode". */
export const CLEAN_TEST_DEFAULTS = Object.freeze({
  settleBeforeMs: 1000,
  durationMs: 10_000,
  settleAfterMs: 1000,
});

/**
 * @typedef {object} CleanTestManagerEntry
 * @property {string} key
 * @property {boolean} wasOpen
 * @property {() => void} [restore]
 * @property {object} [meta]
 */

/**
 * @typedef {object} CleanTestDomEntry
 * @property {HTMLElement} el
 * @property {string} display
 * @property {boolean} [hidden]
 */

/**
 * @typedef {object} MsaOverlayUiSnapshot
 * @property {CleanTestManagerEntry[]} managers
 * @property {CleanTestDomEntry[]} dom
 */

/**
 * @param {string} v
 * @returns {boolean}
 */
function isElementVisible(el) {
  if (!el?.isConnected) return false;
  if (el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  return true;
}

/**
 * @param {import('./PerformanceRecorder.js').PerformanceRecorder} recorder
 * @returns {boolean}
 */
function recorderIsActive(recorder) {
  return recorder?.enabled === true;
}

/**
 * @returns {MsaOverlayUiSnapshot}
 */
export function captureAndHideMsaOverlayUi() {
  /** @type {MsaOverlayUiSnapshot} */
  const snapshot = { managers: [], dom: [] };
  const ms = window.MapShine ?? {};

  /**
   * @param {string} key
   * @param {object|null|undefined} manager
   * @param {() => boolean} isOpen
   * @param {() => void} hideFn
   * @param {() => void} restoreFn
   * @param {object} [meta]
   */
  const trackManager = (key, manager, isOpen, hideFn, restoreFn, meta = null) => {
    if (!manager || typeof hideFn !== 'function') return;
    const open = isOpen();
    if (!open) return;
    snapshot.managers.push({
      key,
      wasOpen: true,
      restore: restoreFn,
      meta: meta ?? undefined,
    });
    try {
      hideFn();
    } catch (err) {
      log.warn(`hide failed for ${key}`, err);
    }
  };

  trackManager(
    'performanceRecorderDialog',
    ms.performanceRecorderDialog,
    () => ms.performanceRecorderDialog?.visible === true,
    () => ms.performanceRecorderDialog?.hide?.(),
    () => ms.performanceRecorderDialog?.show?.(),
  );

  trackManager(
    'uiManager',
    ms.uiManager,
    () => ms.uiManager?.visible === true,
    () => ms.uiManager?.hide?.(),
    () => ms.uiManager?.show?.(),
  );

  const cp = ms.controlPanel;
  const cpWasMinimized = cp?._isMinimized === true;
  const cpDockLeft = cpWasMinimized
    ? Number.parseFloat(String(cp?._minimizedDock?.style?.left ?? ''))
    : NaN;
  const cpDockTop = cpWasMinimized
    ? Number.parseFloat(String(cp?._minimizedDock?.style?.top ?? ''))
    : NaN;
  trackManager(
    'controlPanel',
    cp,
    () => !!(cp && (cp.visible === true || cp._isMinimized === true)),
    () => cp?.hide?.(),
    () => {
      if (!cp) return;
      if (cpWasMinimized) {
        const left = Number.isFinite(cpDockLeft) ? cpDockLeft : 20;
        const top = Number.isFinite(cpDockTop) ? cpDockTop : 20;
        try {
          cp._setPanelDomVisible?.(false);
          cp.visible = false;
          cp._isMinimized = true;
          cp._showMinimizedDockAt?.(left, top);
        } catch (_) {}
        return;
      }
      cp.show?.();
    },
    { wasMinimized: cpWasMinimized, dockLeft: cpDockLeft, dockTop: cpDockTop },
  );

  trackManager(
    'cameraPanel',
    ms.cameraPanel,
    () => ms.cameraPanel?.visible === true,
    () => ms.cameraPanel?.hide?.(),
    () => ms.cameraPanel?.show?.(),
  );

  trackManager(
    'breakerBoxDialog',
    ms.breakerBoxDialog,
    () => ms.breakerBoxDialog?._visible === true,
    () => ms.breakerBoxDialog?.hide?.(),
    () => ms.breakerBoxDialog?.show?.(),
  );

  const diagDialog = ms.uiManager?.diagnosticCenter?.dialog;
  trackManager(
    'diagnosticCenter',
    diagDialog,
    () => diagDialog?.visible === true,
    () => ms.uiManager?.diagnosticCenter?.hide?.(),
    () => ms.uiManager?.diagnosticCenter?.show?.(),
  );

  const gfx = ms.graphicsSettings;
  trackManager(
    'graphicsSettings',
    gfx,
    () => gfx?.dialog?.visible === true,
    () => gfx?.hide?.(),
    () => gfx?.show?.(),
  );

  const cameraPathDialog = ms.uiManager?.cameraPathDialog;
  trackManager(
    'cameraPathDialog',
    cameraPathDialog,
    () => cameraPathDialog?.visible === true,
    () => cameraPathDialog?.hide?.(),
    () => cameraPathDialog?.show?.(),
  );

  const handledRoots = new Set(
    snapshot.managers
      .map((m) => {
        switch (m.key) {
          case 'performanceRecorderDialog': return ms.performanceRecorderDialog?.container;
          case 'uiManager': return ms.uiManager?.container;
          case 'controlPanel': return ms.controlPanel?.container;
          case 'cameraPanel': return ms.cameraPanel?.container;
          case 'breakerBoxDialog': return ms.breakerBoxDialog?.container;
          case 'diagnosticCenter': return diagDialog?.container;
          case 'graphicsSettings': return gfx?.dialog?.container;
          case 'cameraPathDialog': return cameraPathDialog?.container;
          default: return null;
        }
      })
      .filter(Boolean),
  );

  /** @type {HTMLElement[]} */
  const domCandidates = [];
  try {
    domCandidates.push(...document.querySelectorAll('.map-shine-overlay-ui'));
  } catch (_) {}
  try {
    const dock = document.getElementById('map-shine-control-panel-minimized');
    if (dock) domCandidates.push(dock);
  } catch (_) {}

  for (const el of domCandidates) {
    if (!el || handledRoots.has(el)) continue;
    if (handledRoots.has(el.parentElement)) continue;
    if (!isElementVisible(el)) continue;

    snapshot.dom.push({
      el,
      display: el.style.display,
      hidden: el.hidden,
    });
    el.style.display = 'none';
    el.hidden = false;
  }

  return snapshot;
}

/**
 * @param {MsaOverlayUiSnapshot|null|undefined} snapshot
 */
export function restoreMsaOverlayUi(snapshot) {
  if (!snapshot) return;

  for (const entry of snapshot.dom) {
    const el = entry.el;
    if (!el?.isConnected) continue;
    try {
      el.style.display = entry.display ?? '';
      if (typeof entry.hidden === 'boolean') el.hidden = entry.hidden;
    } catch (_) {}
  }

  for (const entry of snapshot.managers) {
    if (!entry.wasOpen || typeof entry.restore !== 'function') continue;
    try {
      entry.restore();
    } catch (err) {
      log.warn(`restore failed for ${entry.key}`, err);
    }
  }
}

/**
 * @param {number} ms
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
function delayMs(ms, options = {}) {
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const id = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {import('./PerformanceRecorder.js').PerformanceRecorder} recorder
 * @param {object} [options]
 * @param {number} [options.settleBeforeMs]
 * @param {number} [options.durationMs]
 * @param {number} [options.settleAfterMs]
 * @param {boolean} [options.gpuTiming]
 * @param {(phase: string, detail?: string) => void} [options.onPhase]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ snapshot: object, uiSnapshot: MsaOverlayUiSnapshot }>}
 */
export async function runCleanPerfTest(recorder, options = {}) {
  if (!recorder) throw new Error('Performance recorder is not available');

  const settleBeforeMs = Number(options.settleBeforeMs) || CLEAN_TEST_DEFAULTS.settleBeforeMs;
  const durationMs = Number(options.durationMs) || CLEAN_TEST_DEFAULTS.durationMs;
  const settleAfterMs = Number(options.settleAfterMs) || CLEAN_TEST_DEFAULTS.settleAfterMs;
  const gpuTiming = options.gpuTiming !== false;
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : null;
  const signal = options.signal;

  if (recorderIsActive(recorder)) {
    throw new Error('Stop the current recording before starting a clean test');
  }

  /** @type {MsaOverlayUiSnapshot|null} */
  let uiSnapshot = null;

  const phase = (name, detail) => {
    try { onPhase?.(name, detail); } catch (_) {}
  };

  try {
    phase('hide-ui');
    uiSnapshot = captureAndHideMsaOverlayUi();

    phase('settle-before', `${settleBeforeMs}ms`);
    await delayMs(settleBeforeMs, { signal });

    phase('recording', `${durationMs}ms`);
    recorder.start({ gpuTiming });
    await delayMs(durationMs, { signal });
    recorder.stop();

    phase('settle-after', `${settleAfterMs}ms`);
    await delayMs(settleAfterMs, { signal });

    const snap = recorder.getSnapshot?.() ?? {};
    phase('complete');
    return { snapshot: snap, uiSnapshot };
  } finally {
    restoreMsaOverlayUi(uiSnapshot);
    phase('ui-restored');
  }
}
