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
/** @type {number|null} HDR highlight-rolloff knee for the present pass (default 0.9). */
let _runtimeV3HdrKnee = null;
/** @type {boolean|null} Run V2's colour grade (ColorCorrection + contextual) on V3 (default on). */
let _runtimeV3Post = null;

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
    indoorOutdoor: isV3IndoorOutdoorEnabled(),
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
      indoorOutdoor: (on) => setV3IndoorOutdoor(on),
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
          + '  .post(false)                     — disable V2 colour grade on V3 (see raw V3 lighting)\n'
          + '  .indoorOutdoor(false)            — disable indoor darkening (uniform sky ambient)\n'
          + '  URL: ?msaV3=0 forces V2 for a reload  ·  ?msaV3=1 forces V3',
        );
      },
    };
    log.info('Debug helper available: MapShine.v3.help()');
  } catch (_) {}
}
