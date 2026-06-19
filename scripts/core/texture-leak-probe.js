/**
 * @fileoverview Diagnostic probe that attributes THREE texture / render-target
 * allocations to their call sites and confirms true leaks.
 *
 * The persistent "orphaned texture" crashes are caused by JS `THREE.Texture`
 * (or render-target) objects that get created, uploaded to the GPU, then dropped
 * without `dispose()`. The JS wrapper is garbage-collected, but the GPU texture
 * lives on forever — so it is referenced *nowhere* in the scene graph or in any
 * shader uniform and is therefore invisible to every after-the-fact audit. The
 * only way to find the source is to record a stack signature at construction.
 *
 * This probe is intentionally read-only with respect to the textures themselves:
 *  - it wraps the mutable `window.THREE` constructors to record an allocation
 *    site + attach a `dispose` listener,
 *  - it hooks `WebGLRenderingContext.createTexture` / `deleteTexture` so internal
 *    three.js and PIXI allocations are attributed even when constructors are not
 *    wrapped (e.g. bundled module-local classes),
 *  - it registers each instance with a {@link FinalizationRegistry} so that an
 *    instance which is GC'd *without* having been disposed is counted as a
 *    confirmed leak attributed to its allocation site.
 *
 * It never disposes, mutates, or retains the textures (the registry holds only a
 * tiny per-site tally object, and instances are held weakly).
 *
 * Wrapping requires a *mutable* THREE namespace; the raw module namespace from
 * `import()` is frozen, so {@link bootstrap} exposes a shallow copy on
 * `window.THREE` and installs the probe against that copy before rendering starts.
 *
 * @module core/texture-leak-probe
 */

import { createLogger } from './log.js';

const log = createLogger('TextureLeakProbe');

/**
 * THREE constructors that allocate a GPU texture. Render targets are included
 * because each owns at least one texture counted by `renderer.info.memory`.
 * @type {readonly string[]}
 */
const TRACKED_CLASSES = Object.freeze([
  'Texture',
  'DataTexture',
  'CanvasTexture',
  'FramebufferTexture',
  'VideoTexture',
  'Data3DTexture',
  'DataArrayTexture',
  'CompressedTexture',
  'CompressedArrayTexture',
  'DepthTexture',
  'WebGLRenderTarget',
  'WebGLArrayRenderTarget',
  'WebGLCubeRenderTarget',
  'WebGL3DRenderTarget',
  'WebGLMultipleRenderTargets',
]);

/**
 * @typedef {object} LeakSite
 * @property {string} cls Constructor class name.
 * @property {number} allocated Total instances created from this site.
 * @property {number} disposed Instances that fired a `dispose` event.
 * @property {number} gcLeaked Instances GC'd without ever being disposed.
 * @property {number} lastMs performance.now() of the most recent allocation.
 */

let _installed = false;
let _enabled = true;
let _constructorsWrapped = 0;
let _glHooksInstalled = false;
let _totalAllocated = 0;
let _totalDisposed = 0;
let _totalGcLeaked = 0;
let _totalGlCreated = 0;
let _totalGlDeleted = 0;
/** @type {number|null} Lowest renderer.info.memory.textures seen this session. */
let _sessionMinTexCount = null;
/** @type {number} Last sampled live texture count. */
let _lastSampleTexCount = 0;
/** @type {number} Consecutive samples where live count rose. */
let _climbStreak = 0;
/** @type {number} performance.now() of last auto leak-watch dump. */
let _lastClimbLogMs = 0;
/** @type {number} Ms between auto leak-watch dumps while climbing. */
const CLIMB_LOG_INTERVAL_MS = 5000;
/** @type {number} Live count must exceed session min by this much before auto dump. */
const CLIMB_LOG_MIN_DELTA = 48;

/** @type {Map<string, LeakSite>} */
const _sites = new Map();
/** @type {WeakSet<object>} Guards against double-counting one instance. */
const _counted = new WeakSet();
/** @type {FinalizationRegistry<{ entry: LeakSite, state: { disposed: boolean } }>|null} */
let _registry = null;

/**
 * @param {string} sig
 * @param {string} cls
 * @returns {LeakSite}
 */
function _siteEntry(sig, cls) {
  let entry = _sites.get(sig);
  if (!entry) {
    entry = { cls, allocated: 0, disposed: 0, gcLeaked: 0, lastMs: 0 };
    _sites.set(sig, entry);
  }
  return entry;
}

/**
 * Build a compact allocation signature from the current stack, skipping probe
 * frames so the first reported frame is the real caller.
 * @param {string} cls
 * @returns {string}
 */
function _signature(cls) {
  let stack = '';
  try { stack = new Error().stack || ''; } catch (_) {}
  const frames = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    if (line.includes('texture-leak-probe')) continue;
    frames.push(line.slice(3));
    if (frames.length >= 5) break;
  }
  return `[${cls}] ${frames.join('  <-  ') || 'unknown'}`;
}

/**
 * Record a GL or JS allocation site tally.
 * @param {string} cls
 */
function _trackSiteAllocation(cls) {
  const sig = _signature(cls);
  const entry = _siteEntry(sig, cls);
  entry.allocated += 1;
  entry.lastMs = performance.now();
}

/**
 * Record an allocation and arm dispose / GC tracking for one instance.
 * @param {object} inst
 * @param {string} cls
 */
function _track(inst, cls) {
  if (!_enabled || !inst || typeof inst !== 'object') return;
  if (_counted.has(inst)) return;
  _counted.add(inst);

  const sig = _signature(cls);
  const entry = _siteEntry(sig, cls);
  entry.allocated += 1;
  entry.lastMs = performance.now();
  _totalAllocated += 1;

  const state = { disposed: false };

  try {
    if (typeof inst.addEventListener === 'function') {
      const onDispose = () => {
        if (state.disposed) return;
        state.disposed = true;
        entry.disposed += 1;
        _totalDisposed += 1;
        try { inst.removeEventListener('dispose', onDispose); } catch (_) {}
      };
      inst.addEventListener('dispose', onDispose);
    }
  } catch (_) {}

  try { _registry?.register(inst, { entry, state }); } catch (_) {}
}

/**
 * @param {{ entry: LeakSite, state: { disposed: boolean } }} held
 */
function _onFinalize(held) {
  try {
    if (!held || held.state?.disposed) return;
    held.entry.gcLeaked += 1;
    _totalGcLeaked += 1;
  } catch (_) {}
}

/**
 * Hook WebGL texture create/delete so bundled three.js internals are visible.
 * @returns {boolean}
 */
function _installGlTextureHooks() {
  if (_glHooksInstalled) return true;
  if (typeof WebGLRenderingContext === 'undefined') return false;

  const proto = WebGLRenderingContext.prototype;
  if (!proto?.createTexture || proto.createTexture.__leakProbeWrapped) {
    _glHooksInstalled = proto?.createTexture?.__leakProbeWrapped === true;
    return _glHooksInstalled;
  }

  const origCreate = proto.createTexture;
  const origDelete = proto.deleteTexture;

  proto.createTexture = function createTextureHook(...args) {
    const handle = origCreate.apply(this, args);
    if (_enabled && handle) {
      try {
        _trackSiteAllocation('gl.createTexture');
        _totalGlCreated += 1;
      } catch (_) {}
    }
    return handle;
  };
  proto.createTexture.__leakProbeWrapped = true;

  proto.deleteTexture = function deleteTextureHook(handle) {
    if (_enabled && handle) {
      try { _totalGlDeleted += 1; } catch (_) {}
    }
    return origDelete.call(this, handle);
  };
  proto.deleteTexture.__leakProbeWrapped = true;

  _glHooksInstalled = true;
  return true;
}

/**
 * Replace `ns[name]` with a transparent wrapper that records allocations.
 * @param {object} ns Mutable THREE namespace copy.
 * @param {string} name
 * @returns {boolean} True if wrapped (or already wrapped).
 */
function _wrap(ns, name) {
  const Orig = ns?.[name];
  if (typeof Orig !== 'function') return false;
  if (Orig.__leakProbeWrapped) return true;

  function Wrapped(...args) {
    const inst = Reflect.construct(Orig, args, new.target || Wrapped);
    try { _track(inst, name); } catch (_) {}
    return inst;
  }
  Wrapped.prototype = Orig.prototype;
  try { Object.setPrototypeOf(Wrapped, Orig); } catch (_) {}
  try { Object.defineProperty(Wrapped, 'name', { value: name, configurable: true }); } catch (_) {}
  Wrapped.__leakProbeWrapped = true;
  Wrapped.__leakProbeOrig = Orig;

  try {
    ns[name] = Wrapped;
  } catch (_) {
    return false;
  }
  return ns[name] === Wrapped;
}

function _exposeProbeApi() {
  try {
    if (typeof window === 'undefined') return;
    const ms = window.MapShine || (window.MapShine = {});
    ms.textureLeakProbe = {
      get enabled() { return _enabled; },
      set enabled(v) { _enabled = !!v; },
      summary: (n) => summarizeTextureLeakProbe(n),
      top: (n) => getTextureLeakProbeReport(n),
      reset: resetTextureLeakProbe,
    };
  } catch (_) {}
}

/**
 * After injecting an external GL handle into a THREE.Texture, sync renderer
 * properties so three.js does not allocate a duplicate GPU texture on bind.
 *
 * @param {import('three').Texture|null|undefined} texture
 * @param {import('three').WebGLRenderer|null|undefined} renderer
 * @param {WebGLTexture|null|undefined} [glHandle]
 */
export function markExternalGlTexture(texture, renderer, glHandle) {
  if (!texture || !renderer?.properties) return;
  try {
    const properties = renderer.properties.get(texture);
    if (glHandle) properties.__webglTexture = glHandle;
    properties.__webglInit = true;
    properties.__version = texture.version;
  } catch (_) {}
}

/**
 * Install the probe against a mutable THREE namespace. Idempotent.
 * @param {object} [ns] Defaults to `window.THREE`.
 * @returns {boolean} True if hooks or constructor wraps are active.
 */
export function installTextureLeakProbe(ns) {
  _installGlTextureHooks();

  const THREE = ns || (typeof window !== 'undefined' ? window.THREE : null);
  if (THREE) {
    try {
      if (!_registry && typeof FinalizationRegistry !== 'undefined') {
        _registry = new FinalizationRegistry(_onFinalize);
      }
    } catch (_) {
      _registry = null;
    }

    let wrapped = 0;
    for (const name of TRACKED_CLASSES) {
      if (_wrap(THREE, name)) wrapped += 1;
    }
    _constructorsWrapped = Math.max(_constructorsWrapped, wrapped);
  }

  _installed = _glHooksInstalled || _constructorsWrapped > 0;
  _exposeProbeApi();

  if (_installed) {
    log.info(
      `Installed (constructors=${_constructorsWrapped}/${TRACKED_CLASSES.length}, `
      + `glHooks=${_glHooksInstalled}, registry=${!!_registry}).`,
    );
  } else {
    log.warn('Texture leak probe could not install — no mutable THREE namespace and GL hooks unavailable.');
  }
  return _installed;
}

/**
 * Ranked allocation sites for the crash report / diagnostics.
 * @param {number} [limit=12]
 * @returns {object} Totals plus the top sites by live + confirmed-leak count.
 */
export function getTextureLeakProbeReport(limit = 12) {
  const sites = [..._sites.entries()].map(([sig, e]) => ({
    site: sig,
    cls: e.cls,
    allocated: e.allocated,
    disposed: e.disposed,
    gcLeaked: e.gcLeaked,
    alive: Math.max(0, e.allocated - e.disposed - e.gcLeaked),
    lastMs: Math.round(e.lastMs),
  }));
  sites.sort((a, b) =>
    (b.gcLeaked - a.gcLeaked)
    || (b.alive - a.alive)
    || (b.allocated - a.allocated));

  return {
    installed: _installed,
    enabled: _enabled,
    constructorsWrapped: _constructorsWrapped,
    glHooksInstalled: _glHooksInstalled,
    siteCount: _sites.size,
    totalAllocated: _totalAllocated,
    totalDisposed: _totalDisposed,
    totalGcLeaked: _totalGcLeaked,
    totalAlive: Math.max(0, _totalAllocated - _totalDisposed - _totalGcLeaked),
    glCreated: _totalGlCreated,
    glDeleted: _totalGlDeleted,
    glNetAlive: Math.max(0, _totalGlCreated - _totalGlDeleted),
    sessionMinTextures: _sessionMinTexCount,
    lastSampleTextures: _lastSampleTexCount,
    climbStreak: _climbStreak,
    topSites: sites.slice(0, Math.max(1, limit | 0)),
  };
}

/**
 * Human-readable console summary.
 * @param {number} [limit=12]
 * @returns {object} The same data as {@link getTextureLeakProbeReport}.
 */
export function summarizeTextureLeakProbe(limit = 12) {
  const report = getTextureLeakProbeReport(limit);
  try {
    log.info(
      `js alloc=${report.totalAllocated} disposed=${report.totalDisposed} `
      + `gcLeaked=${report.totalGcLeaked} alive=${report.totalAlive} | `
      + `gl create=${report.glCreated} delete=${report.glDeleted} net=${report.glNetAlive} sites=${report.siteCount}`,
    );
    // eslint-disable-next-line no-console
    console.table?.(report.topSites.map((s) => ({
      cls: s.cls,
      allocated: s.allocated,
      disposed: s.disposed,
      gcLeaked: s.gcLeaked,
      alive: s.alive,
      site: s.site.length > 160 ? `${s.site.slice(0, 157)}...` : s.site,
    })));
  } catch (_) {}
  return report;
}

/** Clear all tallies (keeps wrappers installed). */
export function resetTextureLeakProbe() {
  _sites.clear();
  _totalAllocated = 0;
  _totalDisposed = 0;
  _totalGcLeaked = 0;
  _totalGlCreated = 0;
  _totalGlDeleted = 0;
  _sessionMinTexCount = null;
  _lastSampleTexCount = 0;
  _climbStreak = 0;
  _lastClimbLogMs = 0;
}

/**
 * Per-frame (or throttled) sample of the renderer's live texture counter.
 * When the count keeps climbing, periodically dumps the top allocation sites
 * to the console so the leak source is visible before a context-loss crash.
 *
 * @param {import('three').WebGLRenderer|null|undefined} renderer
 */
export function noteRendererTextureSample(renderer) {
  if (!_installed || !_enabled || !renderer?.info?.memory) return;
  const count = Number(renderer.info.memory.textures) || 0;
  if (count <= 0) return;

  if (_sessionMinTexCount == null || count < _sessionMinTexCount) {
    _sessionMinTexCount = count;
  }

  if (count > _lastSampleTexCount) {
    _climbStreak += 1;
  } else if (count < _lastSampleTexCount) {
    _climbStreak = 0;
  }
  _lastSampleTexCount = count;

  const floor = _sessionMinTexCount ?? count;
  const delta = count - floor;
  if (delta < CLIMB_LOG_MIN_DELTA || _climbStreak < 2) return;

  const now = performance.now();
  if (now - _lastClimbLogMs < CLIMB_LOG_INTERVAL_MS) return;
  _lastClimbLogMs = now;

  log.warn(
    `Live GPU textures climbing: ${count} (+${delta} above session min ${floor}). `
    + 'Top allocation sites:',
  );
  try { summarizeTextureLeakProbe(8); } catch (_) {}
}
