/**
 * @fileoverview Dev-only Foundry Dialog to bisect multi-floor water / level composite.
 *
 * Open from console: `MapShine.openWaterLayeringBisectDialog()`
 *
 * One-shot auto-open after reload (then clears):
 *   localStorage.setItem('mapshine-v2-water-bisect', '1'); location.reload();
 *
 * @module ui/water-layering-bisect-dialog
 */

/** @type {string} */
const LS_AUTO = 'mapshine-v2-water-bisect';

/** Dialog title — must match `Hooks.on('renderDialog')` filter and `new Dialog({ title })`. */
export const WATER_LAYER_BISECT_DIALOG_TITLE = 'Map Shine — Water / level layering bisect';

export const WATER_LAYER_BISECT_DEFAULTS = {
  /** @type {'normal'|'lowerOnly'|'upperOnly'|'swapped'} */
  compositePreview: 'normal',
  /** @type {'default'|'off'} — `off` disables borrowing lower-floor water packs on upper slices */
  crossSliceBorrow: 'default',
  /** @type {'off'|'on'} — skip WaterEffectV2 entirely on floor index > 0 */
  skipWaterUpper: 'off',
  /** @type {'off'|'on'} — subtle RGB tint in LevelCompositePass (two levels) */
  perLevelTint: 'off',
};

/** Select `name` values we own (ignore other dialogs' selects). */
const _bisectSelectNames = new Set(Object.keys(WATER_LAYER_BISECT_DEFAULTS));

/** Read-only fallback when `MapShine` is not yet on `globalThis` (do not mutate from handlers). */
const _fallbackBisect = { ...WATER_LAYER_BISECT_DEFAULTS };

/**
 * Live bisect flags used by FloorCompositor / WaterEffectV2. Always returns the object on
 * `MapShine.__v2WaterLayerBisect` when available (with defaults merged).
 *
 * @returns {typeof WATER_LAYER_BISECT_DEFAULTS & Record<string, string>}
 */
export function getWaterLayerBisectState() {
  const ms = globalThis.MapShine;
  if (!ms) return /** @type {any} */ (_fallbackBisect);
  const cur = _ensureBisect(ms);
  return /** @type {any} */ (cur ?? _fallbackBisect);
}

/**
 * @param {Record<string, unknown>|null|undefined} ms
 */
function _ensureBisect(ms) {
  if (!ms) return null;
  const cur = ms.__v2WaterLayerBisect;
  if (!cur || typeof cur !== 'object') {
    ms.__v2WaterLayerBisect = { ...WATER_LAYER_BISECT_DEFAULTS };
  } else {
    for (const [k, v] of Object.entries(WATER_LAYER_BISECT_DEFAULTS)) {
      if (cur[k] === undefined) cur[k] = v;
    }
  }
  return ms.__v2WaterLayerBisect;
}

/**
 * Capture-phase listener: Foundry v12–v14 Application dialogs differ (jQuery vs HTMLElement,
 * `renderDialog` availability). Delegation from `document` always sees real DOM events.
 *
 * @param {Event} ev
 */
function _onDocumentSelectInputForBisect(ev) {
  const t = ev.target;
  if (!t || /** @type {any} */ (t).tagName !== 'SELECT') return;
  const name = /** @type {HTMLSelectElement} */ (t).getAttribute('name');
  if (!name || !_bisectSelectNames.has(name)) return;
  try {
    if (!/** @type {HTMLElement} */ (t).closest?.('[data-msa-water-bisect="1"]')) return;
  } catch (_) {
    return;
  }
  const ms = globalThis.MapShine;
  if (!ms) return;
  const st = getWaterLayerBisectState();
  if (!st) return;
  st[name] = /** @type {HTMLSelectElement} */ (t).value;
  _requestRender();
  _updateBisectStateReadout(/** @type {HTMLElement} */ (t).closest('[data-msa-water-bisect="1"]'));
}

function _installDelegatedBisectListeners() {
  if (globalThis.__msaWaterBisectDelegatedListeners) return;
  globalThis.__msaWaterBisectDelegatedListeners = true;
  try {
    // `change` only: for `<select>`, some browsers also emit `input`, which would
    // double-apply and double-render.
    document.addEventListener('change', _onDocumentSelectInputForBisect, true);
  } catch (_) {}
}

/**
 * @param {Record<string, unknown>|null|undefined} mapShine
 */
export function installWaterLayerBisectTools(mapShine) {
  if (!mapShine || mapShine.__waterLayerBisectInstalled) return;
  mapShine.__waterLayerBisectInstalled = true;
  _ensureBisect(mapShine);
  _installDelegatedBisectListeners();
  _registerRenderDialogBisectHook();

  mapShine.openWaterLayeringBisectDialog = () => {
    try {
      openWaterLayeringBisectDialog(mapShine);
    } catch (e) {
      console.warn('MapShine.openWaterLayeringBisectDialog failed:', e);
    }
  };

  Hooks.once('canvasReady', () => {
    try {
      if (globalThis.localStorage?.getItem(LS_AUTO) !== '1') return;
      globalThis.localStorage.removeItem(LS_AUTO);
      setTimeout(() => {
        try {
          openWaterLayeringBisectDialog(globalThis.MapShine ?? mapShine);
        } catch (_) {}
      }, 400);
    } catch (_) {}
  });
}

/** @type {number|null} */
let _bisectRenderHookId = null;

function _registerRenderDialogBisectHook() {
  if (_bisectRenderHookId != null) return;
  try {
    _bisectRenderHookId = Hooks.on('renderDialog', (app, html) => {
      try {
        const title = app?.options?.title ?? app?.data?.title;
        if (title !== WATER_LAYER_BISECT_DIALOG_TITLE) return;
        _updateBisectStateReadout(
          /** @type {HTMLElement|null} */ (document.querySelector('[data-msa-water-bisect="1"]')),
        );
      } catch (_) {}
    });
  } catch (_) {
    _bisectRenderHookId = null;
  }
}

/**
 * @param {HTMLElement|null|undefined} scopeRoot
 */
function _updateBisectStateReadout(scopeRoot) {
  try {
    const root =
      scopeRoot && scopeRoot.nodeType === 1
        ? scopeRoot
        : /** @type {HTMLElement|null} */ (document.querySelector('[data-msa-water-bisect="1"]'));
    const el = root?.querySelector?.('.msa-bisect-state-readout');
    if (!el) return;
    const s = getWaterLayerBisectState();
    el.textContent = JSON.stringify({
      compositePreview: s.compositePreview,
      crossSliceBorrow: s.crossSliceBorrow,
      skipWaterUpper: s.skipWaterUpper,
      perLevelTint: s.perLevelTint,
    });
  } catch (_) {}
}

/**
 * @param {Record<string, unknown>|null|undefined} mapShine
 */
export function openWaterLayeringBisectDialog(mapShine) {
  const ms = mapShine ?? globalThis.MapShine;
  const b = _ensureBisect(ms);
  if (!b) return;

  const mkSelect = (key, label, options) => {
    const opts = options
      .map(
        (o) =>
          `<option value="${o.value}"${b[key] === o.value ? ' selected' : ''}>${o.label}</option>`,
      )
      .join('');
    return `
      <div class="form-group" style="margin-bottom:10px">
        <label style="display:block;font-weight:600;margin-bottom:4px">${label}</label>
        <select name="${key}" style="width:100%">${opts}</select>
      </div>`;
  };

  const content = `
    <div data-msa-water-bisect="1" style="font-size:0.9em;line-height:1.35">
      <p>Change a control — <strong>Active flags</strong> must update (proves the handler ran). If flags move but the canvas does not, this scene may be single-floor (some previews need two visible levels).</p>
      <p style="opacity:0.85"><strong>compositePreview</strong> does not fix bugs by itself — it checks whether the stack or ordering hypothesis matches what you see.</p>
      <p style="margin-top:6px"><span style="opacity:0.85">Active flags:</span>
        <code class="msa-bisect-state-readout" style="font-size:0.78em;word-break:break-all;display:block;margin-top:4px"></code>
      </p>
      <hr/>
      ${mkSelect('compositePreview', 'Level composite preview', [
        { value: 'normal', label: 'Normal (bottom then top)' },
        { value: 'lowerOnly', label: 'Lower slice RT only' },
        { value: 'upperOnly', label: 'Upper slice RT only' },
        { value: 'swapped', label: 'Swapped roles (sanity: inverted stack)' },
      ])}
      ${mkSelect('crossSliceBorrow', 'Upper slice borrows lower-floor _Water pack', [
        { value: 'default', label: 'Default (borrow when upper has no masks)' },
        { value: 'off', label: 'Off (never borrow — old behaviour)' },
      ])}
      ${mkSelect('skipWaterUpper', 'Water pass on upper floor index', [
        { value: 'off', label: 'Run when data / borrow allows' },
        { value: 'on', label: 'Skip water on index > 0' },
      ])}
      ${mkSelect('perLevelTint', 'Composite debug tint (2 visible levels)', [
        { value: 'off', label: 'Off' },
        { value: 'on', label: 'On (cool/warm slice bias)' },
      ])}
      <p style="margin-top:8px;font-size:0.85em;opacity:0.9">
        Auto-open once: <code>localStorage.setItem('${LS_AUTO}','1');location.reload()</code>
      </p>
    </div>
  `;

  const dlg = new Dialog({
    title: WATER_LAYER_BISECT_DIALOG_TITLE,
    content,
    buttons: {
      reset: {
        icon: '<i class="fas fa-undo"></i>',
        label: 'Reset defaults',
        callback: () => {
          Object.assign(b, WATER_LAYER_BISECT_DEFAULTS);
          _syncUiFromState(dlg, b);
          _requestRender();
          _updateBisectStateReadout(
            /** @type {HTMLElement|null} */ (document.querySelector('[data-msa-water-bisect="1"]')),
          );
        },
      },
      close: {
        icon: '<i class="fas fa-times"></i>',
        label: 'Close',
      },
    },
    default: 'close',
  });
  dlg.render(true);

  const kickReadout = () => {
    _updateBisectStateReadout(
      /** @type {HTMLElement|null} */ (document.querySelector('[data-msa-water-bisect="1"]')),
    );
  };
  kickReadout();
  requestAnimationFrame(() => {
    kickReadout();
    requestAnimationFrame(kickReadout);
  });
  setTimeout(kickReadout, 50);
  setTimeout(kickReadout, 250);
}

/**
 * @param {Dialog} dlg
 * @param {object} b
 */
function _syncUiFromState(dlg, b) {
  try {
    const $ = globalThis.jQuery;
    if (!$ || !dlg?.element) return;
    const $el = /** @type {any} */ (dlg.element).jquery ? dlg.element : $(dlg.element);
    if (!$el?.length) return;
    const $root = $el.find('.window-content').length ? $el.find('.window-content') : $el;
    for (const key of Object.keys(WATER_LAYER_BISECT_DEFAULTS)) {
      const sel = $root.find(`select[name="${key}"]`)[0];
      if (sel) sel.value = String(b[key] ?? '');
    }
  } catch (_) {}
}

function _requestRender() {
  const ms = globalThis.MapShine;
  try {
    ms?.renderLoop?.requestRender?.();
    ms?.renderLoop?.requestContinuousRender?.(2500);
  } catch (_) {}
  try {
    const ec = ms?.effectComposer;
    if (ec && typeof ec.render === 'function') ec.render(1 / 60);
  } catch (e) {
    console.warn('[MapShine bisect] effectComposer.render failed:', e);
  }
  try {
    globalThis.canvas?.draw?.();
  } catch (_) {}
}
