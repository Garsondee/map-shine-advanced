/**
 * @fileoverview V3 unified-forward-pipeline experiment flags.
 *
 * The V3 pipeline (Forward+ plan Stage B) is built as a parallel path behind a
 * flag, default OFF, so the shipping V2 compositor is never at risk while V3 is
 * incomplete (Forward+ §14.1 principle 7 — shippable at every step). Nothing in
 * the V2 path should branch on these flags; only V3 construction/wiring does.
 *
 * Resolution order for {@link isV3PipelineEnabled}:
 *   1. runtime override set via {@link setV3Pipeline} (live A/B, no reload);
 *   2. `window.MapShine.__v3Pipeline === true` (console poke);
 *   3. URL param `?msaV3=1` (shareable repro links);
 *   4. persisted client setting `v3Pipeline` if registered;
 *   5. default `false`.
 *
 * The floor-change fast path (view-only floor switches with no loading curtain —
 * the headline V3 UX win) is a *separate* sub-flag so it can be exercised
 * independently while the rest of V3 matures; it is meaningful only when the V3
 * pipeline itself is on. See {@link isV3FloorFastPathEnabled} and the design
 * note in this module's README.
 *
 * Live console API: `MapShine.v3.help()`.
 *
 * @module compositor-v3/v3-flags
 */

import { createLogger } from '../core/log.js';
import { buildPerfRows } from './v3-perf.js';

const log = createLogger('V3Flags');

const MODULE_ID = 'map-shine-advanced';

export const V3_PIPELINE_SETTING = 'v3Pipeline';
export const V3_FLOOR_FAST_PATH_SETTING = 'v3FloorFastPath';

/** @type {boolean|null} Non-null overrides every other source. */
let _runtimeV3Pipeline = null;
/** @type {boolean|null} Non-null overrides every other source. */
let _runtimeV3FloorFastPath = null;
/** @type {boolean|null} ACES tone mapping in the present pass (default on). */
let _runtimeV3Tonemap = null;
/** @type {boolean|null} Indoor/outdoor ambient via the _Outdoors mask (default on). */
let _runtimeV3IndoorOutdoor = null;
/** @type {boolean|null} Tint the ambient red(indoor)/green(outdoor) to debug the mask (default off). */
let _runtimeV3OutdoorsDebug = null;
/** @type {number|null} HDR highlight-rolloff knee for the present pass (default 0.9). */
let _runtimeV3HdrKnee = null;
/** @type {boolean|null} Run V2's colour grade (ColorCorrection + contextual) on V3 (default on). */
let _runtimeV3Post = null;
/** @type {boolean|null} Run V2's bloom in the V3 post chain (default on; needs post on). */
let _runtimeV3Bloom = null;
/** @type {'auto'|number|null} Render-scale setting: 'auto' = governor-driven DRS, number = fixed (default 'auto'). */
let _runtimeV3RenderScale = null;
/** @type {boolean|null} Dither the present pass's 8-bit encode (default on — kills banding on dark scenes). */
let _runtimeV3Dither = null;

/**
 * Tri-state URL flag: `?param=1/true/on` → true, `?param=0/false/off` → false,
 * absent → null. Lets `?msaV3=0` force V2 for a debug reload.
 * @returns {boolean|null}
 */
function _urlFlag(param) {
  try {
    if (typeof window === 'undefined' || !window.location) return null;
    const v = new URLSearchParams(window.location.search).get(param);
    if (v == null) return null;
    if (v === '1' || v === 'true' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'off') return false;
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Raw persisted setting value: true / false / undefined (unregistered or unset).
 * @returns {boolean|undefined}
 */
function _settingRaw(key) {
  try {
    const v = game?.settings?.get?.(MODULE_ID, key);
    return v === true ? true : (v === false ? false : undefined);
  } catch (_) {
    return undefined;
  }
}

/**
 * Whether the V3 unified-forward pipeline should drive rendering.
 *
 * **V3 is the default renderer.** V2 is reachable only by an explicit opt-out
 * (for debugging / A-B comparison), never as an automatic fallback:
 *   - `MapShine.v3.pipeline(false)` (runtime, this session),
 *   - `window.MapShine.__v3Pipeline = false`,
 *   - `?msaV3=0` in the URL,
 *   - the persisted `v3Pipeline` client setting = false.
 * Absent any of those, this returns true.
 * @returns {boolean}
 */
export function isV3PipelineEnabled() {
  if (_runtimeV3Pipeline !== null) return _runtimeV3Pipeline;
  try {
    if (window?.MapShine?.__v3Pipeline === false) return false;
    if (window?.MapShine?.__v3Pipeline === true) return true;
  } catch (_) {}
  const url = _urlFlag('msaV3');
  if (url !== null) return url;
  return _settingRaw(V3_PIPELINE_SETTING) !== false; // default ON
}

/**
 * Whether floor switches take the V3 view-only fast path (no mask rebuild, no
 * forceRepopulate, no fade-to-black curtain). Only meaningful when
 * {@link isV3PipelineEnabled} is true — the fast path assumes every floor's
 * content is already resident in the unified pass.
 * @returns {boolean}
 */
export function isV3FloorFastPathEnabled() {
  if (!isV3PipelineEnabled()) return false;
  if (_runtimeV3FloorFastPath !== null) return _runtimeV3FloorFastPath;
  try {
    if (window?.MapShine?.__v3FloorFastPath === false) return false;
    if (window?.MapShine?.__v3FloorFastPath === true) return true;
  } catch (_) {}
  const url = _urlFlag('msaV3Floors');
  if (url !== null) return url;
  // Default ON once V3 is on: the fast path is the whole point of V3 floor
  // switching. Set the client setting or runtime override to false to opt out.
  return _settingRaw(V3_FLOOR_FAST_PATH_SETTING) !== false;
}

/**
 * Whether the present pass applies ACES tone mapping to the HDR scene. Default
 * ON (rolls candle glow / bright lights off smoothly instead of clipping to
 * white). Toggle off to compare against the raw clipped look.
 * @returns {boolean}
 */
export function isV3TonemapEnabled() {
  if (_runtimeV3Tonemap !== null) return _runtimeV3Tonemap;
  try {
    if (window?.MapShine?.__v3Tonemap === false) return false;
    if (window?.MapShine?.__v3Tonemap === true) return true;
  } catch (_) {}
  const url = _urlFlag('msaV3Tonemap');
  if (url !== null) return url;
  return true; // default ON
}

/**
 * @param {boolean|null} on Pass `null` to clear the override.
 * @returns {ReturnType<typeof getV3Status>}
 */
export function setV3Tonemap(on) {
  _runtimeV3Tonemap = on === null ? null : !!on;
  return getV3Status();
}

/**
 * Whether the lighting ambient distinguishes indoor from outdoor using the
 * scene's _Outdoors mask (indoor areas get only base darkness, lit by local
 * lights; outdoor areas get sky ambient). Default ON. Toggle off to compare
 * against a uniform ambient (or if the mask looks misaligned).
 * @returns {boolean}
 */
export function isV3IndoorOutdoorEnabled() {
  if (_runtimeV3IndoorOutdoor !== null) return _runtimeV3IndoorOutdoor;
  try {
    if (window?.MapShine?.__v3IndoorOutdoor === false) return false;
    if (window?.MapShine?.__v3IndoorOutdoor === true) return true;
  } catch (_) {}
  const url = _urlFlag('msaV3Indoor');
  if (url !== null) return url;
  return true; // default ON
}

/**
 * @param {boolean|null} on Pass `null` to clear the override.
 * @returns {ReturnType<typeof getV3Status>}
 */
export function setV3IndoorOutdoor(on) {
  _runtimeV3IndoorOutdoor = on === null ? null : !!on;
  return getV3Status();
}

/**
 * Whether the lighting pass tints its ambient base red (indoor) / green (outdoor)
 * so the resolved `_Outdoors` mask and its alignment are visible at a glance.
 * Default OFF — a diagnostic, not a look. Lights still render on top.
 * @returns {boolean}
 */
export function isV3OutdoorsDebugEnabled() {
  if (_runtimeV3OutdoorsDebug !== null) return _runtimeV3OutdoorsDebug;
  try {
    if (window?.MapShine?.__v3OutdoorsDebug === true) return true;
    if (window?.MapShine?.__v3OutdoorsDebug === false) return false;
  } catch (_) {}
  const url = _urlFlag('msaV3OutdoorsDebug');
  if (url !== null) return url;
  return false; // default OFF
}

/**
 * @param {boolean|null} on Pass `null` to clear the override.
 * @returns {ReturnType<typeof getV3Status>}
 */
export function setV3OutdoorsDebug(on) {
  _runtimeV3OutdoorsDebug = on === null ? null : !!on;
  return getV3Status();
}

/**
 * The HDR highlight-rolloff knee for the present pass: peak luminance below which
 * the frame is left pixel-identical to what lighting produced (Foundry-matched);
 * above it, only the brightest filament is compressed toward white. Default 0.9.
 * Lower → more of the highlights roll off; higher (→1.0) → only the very hottest
 * cores are touched. Live-tunable to dial the look per scene.
 * @returns {number} knee clamped to [0,1]
 */
export function isV3HdrKnee() { return getV3HdrKnee(); }

/** @returns {number} the resolved knee (runtime override → global → URL → 0.9). */
export function getV3HdrKnee() {
  if (_runtimeV3HdrKnee !== null) return _runtimeV3HdrKnee;
  try {
    const g = Number(window?.MapShine?.__v3HdrKnee);
    if (Number.isFinite(g)) return Math.max(0, Math.min(1, g));
  } catch (_) {}
  try {
    const v = new URLSearchParams(window.location.search).get('msaV3Knee');
    if (v != null && Number.isFinite(Number(v))) return Math.max(0, Math.min(1, Number(v)));
  } catch (_) {}
  return 0.9;
}

/**
 * @param {number|null} knee Pass `null` to clear the override (back to default 0.9).
 * @returns {ReturnType<typeof getV3Status>}
 */
export function setV3HdrKnee(knee) {
  _runtimeV3HdrKnee = (knee === null || !Number.isFinite(Number(knee)))
    ? null : Math.max(0, Math.min(1, Number(knee)));
  return getV3Status();
}

/**
 * Whether V3 runs V2's post-merge colour grade (ColorCorrection + the Contextual
 * Scene Grade it hosts — ToD timeline, indoor/outdoor packs) on the lit buffer.
 * Default ON: restores the module's signature look so V3's lighting can be judged
 * against it. Toggle off to see V3's raw physical lighting (with the HDR rolloff).
 * @returns {boolean}
 */
export function isV3PostEnabled() {
  if (_runtimeV3Post !== null) return _runtimeV3Post;
  try {
    if (window?.MapShine?.__v3Post === false) return false;
    if (window?.MapShine?.__v3Post === true) return true;
  } catch (_) {}
  const url = _urlFlag('msaV3Post');
  if (url !== null) return url;
  return true; // default ON
}

/**
 * @param {boolean|null} on Pass `null` to clear the override.
 * @returns {ReturnType<typeof getV3Status>}
 */
export function setV3Post(on) {
  _runtimeV3Post = on === null ? null : !!on;
  return getV3Status();
}

/**
 * Whether V3 runs V2's bloom in the post chain (HDR, before ColorCorrection).
 * Default ON, but only meaningful when {@link isV3PostEnabled} is on (bloom lives
 * inside the post chain). Toggle off to compare without bloom.
 * @returns {boolean}
 */
export function isV3BloomEnabled() {
  if (_runtimeV3Bloom !== null) return _runtimeV3Bloom;
  try {
    if (window?.MapShine?.__v3Bloom === false) return false;
    if (window?.MapShine?.__v3Bloom === true) return true;
  } catch (_) {}
  const url = _urlFlag('msaV3Bloom');
  if (url !== null) return url;
  return true; // default ON
}

/**
 * @param {boolean|null} on Pass `null` to clear the override.
 * @returns {ReturnType<typeof getV3Status>}
 */
export function setV3Bloom(on) {
  _runtimeV3Bloom = on === null ? null : !!on;
  return getV3Status();
}

/**
 * The render-scale SETTING for the internal render/present split (Forward+
 * §16.3 P2): `'auto'` hands control to the frame-time governor (DRS); a number
 * in [0.5, 1] pins the internal render scale. This is the *setting* — the live
 * effective scale (what the governor chose) is in `MapShine.v3.perf()`.
 *
 * Resolution: runtime override → `window.MapShine.__v3RenderScale` → URL
 * `?msaV3Scale=0.75|auto` → default `'auto'`.
 * @returns {'auto'|number}
 */
export function getV3RenderScaleSetting() {
  const clamp = (n) => Math.max(0.5, Math.min(1, n));
  if (_runtimeV3RenderScale !== null) return _runtimeV3RenderScale;
  try {
    const g = window?.MapShine?.__v3RenderScale;
    if (g === 'auto') return 'auto';
    if (Number.isFinite(Number(g)) && g !== null && g !== undefined && g !== '') return clamp(Number(g));
  } catch (_) {}
  try {
    const v = new URLSearchParams(window.location.search).get('msaV3Scale');
    if (v === 'auto') return 'auto';
    if (v != null && Number.isFinite(Number(v))) return clamp(Number(v));
  } catch (_) {}
  return 'auto';
}

/**
 * @param {'auto'|number|null} v `'auto'` for governor-driven DRS, a number in
 *   [0.5, 1] to pin the scale, `null` to clear the override (back to 'auto').
 * @returns {ReturnType<typeof getV3Status>}
 */
export function setV3RenderScale(v) {
  if (v === null || v === undefined) _runtimeV3RenderScale = null;
  else if (v === 'auto') _runtimeV3RenderScale = 'auto';
  else if (Number.isFinite(Number(v))) _runtimeV3RenderScale = Math.max(0.5, Math.min(1, Number(v)));
  return getV3Status();
}

/**
 * Whether the present pass dithers its linear→sRGB 8-bit encode (Forward+ §16.3
 * P7). Default ON — ~1 LSB of spatial noise is invisible as noise but kills the
 * banding that dark VTT scenes otherwise show. Toggle off for A/B.
 * @returns {boolean}
 */
export function isV3DitherEnabled() {
  if (_runtimeV3Dither !== null) return _runtimeV3Dither;
  try {
    if (window?.MapShine?.__v3Dither === false) return false;
    if (window?.MapShine?.__v3Dither === true) return true;
  } catch (_) {}
  const url = _urlFlag('msaV3Dither');
  if (url !== null) return url;
  return true; // default ON
}

/**
 * @param {boolean|null} on Pass `null` to clear the override.
 * @returns {ReturnType<typeof getV3Status>}
 */
export function setV3Dither(on) {
  _runtimeV3Dither = on === null ? null : !!on;
  return getV3Status();
}

/**
 * Runtime override for the V3 pipeline (live A/B, does not persist unless asked).
 * @param {boolean|null} on Pass `null` to clear the override.
 * @param {{ persist?: boolean }} [opts]
 * @returns {Promise<ReturnType<typeof getV3Status>>}
 */
export async function setV3Pipeline(on, opts = {}) {
  _runtimeV3Pipeline = on === null ? null : !!on;
  if (opts.persist === true && typeof game?.settings?.set === 'function') {
    try { await game.settings.set(MODULE_ID, V3_PIPELINE_SETTING, !!on); } catch (_) {}
  }
  return getV3Status();
}

/**
 * @param {boolean|null} on Pass `null` to clear the override.
 * @param {{ persist?: boolean }} [opts]
 * @returns {Promise<ReturnType<typeof getV3Status>>}
 */
export async function setV3FloorFastPath(on, opts = {}) {
  _runtimeV3FloorFastPath = on === null ? null : !!on;
  if (opts.persist === true && typeof game?.settings?.set === 'function') {
    try { await game.settings.set(MODULE_ID, V3_FLOOR_FAST_PATH_SETTING, !!on); } catch (_) {}
  }
  return getV3Status();
}

/**
 * @returns {{ pipeline: boolean, floorFastPath: boolean, source: { pipeline: string, floorFastPath: string } }}
 */
export function getV3Status() {
  return {
    pipeline: isV3PipelineEnabled(),
    floorFastPath: isV3FloorFastPathEnabled(),
    tonemap: isV3TonemapEnabled(),
    hdrKnee: getV3HdrKnee(),
    post: isV3PostEnabled(),
    bloom: isV3BloomEnabled(),
    indoorOutdoor: isV3IndoorOutdoorEnabled(),
    outdoorsDebug: isV3OutdoorsDebugEnabled(),
    renderScale: getV3RenderScaleSetting(),
    dither: isV3DitherEnabled(),
    source: {
      pipeline: _runtimeV3Pipeline !== null ? 'runtime'
        : (() => {
          try {
            if (window?.MapShine?.__v3Pipeline === true || window?.MapShine?.__v3Pipeline === false) return 'global';
          } catch (_) {}
          if (_urlFlag('msaV3') !== null) return 'url';
          return _settingRaw(V3_PIPELINE_SETTING) === false ? 'setting' : 'default-on';
        })(),
      floorFastPath: _runtimeV3FloorFastPath !== null ? 'runtime' : 'default/setting',
    },
  };
}

/**
 * Install `window.MapShine.v3` console helpers (idempotent).
 */
export function exposeV3FlagsApi() {
  try {
    if (typeof window === 'undefined') return;
    const ms = window.MapShine || (window.MapShine = {});
    ms.v3 = {
      ...(ms.v3 || {}),
      status: () => getV3Status(),
      pipeline: (on, opts) => setV3Pipeline(on, opts),
      floorFastPath: (on, opts) => setV3FloorFastPath(on, opts),
      tonemap: (on) => setV3Tonemap(on),
      hdrKnee: (x) => setV3HdrKnee(x),
      post: (on) => setV3Post(on),
      bloom: (on) => setV3Bloom(on),
      indoorOutdoor: (on) => setV3IndoorOutdoor(on),
      outdoorsDebug: (on) => setV3OutdoorsDebug(on),
      outdoors: () => {
        try {
          return window?.MapShine?.__v3PipelineInstance?.debugOutdoors?.()
            ?? { error: 'V3 pipeline not initialized yet (load a scene first)' };
        } catch (err) {
          return { error: String(err?.message ?? err) };
        }
      },
      renderScale: (v) => setV3RenderScale(v),
      dither: (on) => setV3Dither(on),
      perf: () => {
        try {
          const pipe = window?.MapShine?.__v3PipelineInstance;
          const report = pipe?.getPerfReport?.();
          if (!report) return { error: 'V3 pipeline not initialized yet (load a scene first)' };
          const rs = report.renderScale;
          console.info(
            `V3 perf — render ${report.renderSize.width}×${report.renderSize.height}`
            + ` → present ${report.presentSize.width}×${report.presentSize.height}`
            + ` (scale ${rs.scale}${rs.mode === 'auto' ? ', auto' : ', fixed'})`
            + ` · frame budget ${report.monitor.frameBudgetMs} ms`
            + ` · GPU timer ${report.gpuTimerSupported ? 'on' : 'unavailable'}`,
          );
          console.table(buildPerfRows(report.monitor));
          return report;
        } catch (err) {
          return { error: String(err?.message ?? err) };
        }
      },
      help: () => {
        console.info(
          'MapShine.v3 — V3 unified-forward pipeline (DEFAULT renderer)\n'
          + '  .status()                        — current flag state + source\n'
          + '  .pipeline(false)                 — fall back to V2 for this session (debug)\n'
          + '  .pipeline(null)                  — clear override → default (V3 on)\n'
          + '  .pipeline(false, {persist:true}) — persist V2 for this client\n'
          + '  .floorFastPath(false)            — force curtain on floor changes\n'
          + '  .tonemap(false)                  — disable the HDR highlight rolloff (hard clip)\n'
          + '  .hdrKnee(0.95)                   — raise the rolloff knee (0..1; 0.9 default; higher = only the hottest cores roll off)\n'
          + '  .hdrKnee(null)                   — clear override → default (0.9)\n'
          + '  .post(false)                     — disable the whole V2 post chain on V3 (raw lighting)\n'
          + '  .bloom(false)                    — disable bloom within the post chain\n'
          + '  .indoorOutdoor(false)            — disable indoor darkening (uniform sky ambient)\n'
          + '  .outdoorsDebug(true)             — tint ambient red(indoor)/green(outdoor) to see the mask\n'
          + '  .outdoors()                      — diagnose the _Outdoors resolve (mask handle → cache → resolve → frame)\n'
          + '  .perf()                          — per-pass CPU/GPU ms vs budgets, render/present sizes, scale state\n'
          + '  .renderScale(0.75)               — pin the internal render scale (0.5..1)\n'
          + "  .renderScale('auto')             — governor-driven dynamic resolution (default)\n"
          + '  .dither(false)                   — disable the present-pass encode dither (A/B banding)\n'
          + '  URL: ?msaV3=0 forces V2 for a reload  ·  ?msaV3=1 forces V3  ·  ?msaV3Scale=0.75|auto',
        );
      },
    };
    log.info('Debug helper available: MapShine.v3.help()');
  } catch (_) {}
}
