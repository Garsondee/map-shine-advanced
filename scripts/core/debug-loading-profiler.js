/**
 * @fileoverview Debug Loading Profiler — sequential loading with granular timing.
 *
 * When `debugMode` is enabled, this profiler:
 * - Forces all loading tasks to run sequentially (no parallelism)
 * - Records start/end/delta for every individual task
 * - Collects resource usage metrics (textures, memory, GPU estimates)
 * - Generates a formatted, selectable text log for the loading overlay
 *
 * The profiler is designed to be the single source of truth for whether
 * debug loading mode is active. Other modules check `debugLoadingProfiler.debugMode`.
 *
 * @module core/debug-loading-profiler
 */

import { createLogger } from './log.js';

const log = createLogger('DebugLoadProfiler');

/**
 * @typedef {Object} DebugLoadEntry
 * @property {string} id - Human-readable task name
 * @property {string} category - One of: cleanup, setup, texture, effect, manager, sync, finalize, weather, graphics
 * @property {number} startMs - performance.now() when task started
 * @property {number} [endMs] - performance.now() when task ended
 * @property {number} [durationMs] - endMs - startMs
 * @property {Object} [meta] - Optional metadata (texture dims, byte sizes, etc.)
 */

/**
 * @typedef {Object} ResourceSnapshot
 * @property {number} textures - renderer.info.memory.textures
 * @property {number} geometries - renderer.info.memory.geometries
 * @property {number} drawCalls - renderer.info.render.calls
 * @property {number} triangles - renderer.info.render.triangles
 * @property {number} [jsHeapUsedMB] - performance.memory.usedJSHeapSize in MB
 * @property {number} [jsHeapTotalMB] - performance.memory.totalJSHeapSize in MB
 * @property {number} [estimatedGpuTextureMB] - Rough GPU texture memory estimate
 */

export class DebugLoadingProfiler {
  constructor() {
    /**
     * Master toggle. When true, loading is forced sequential and the debug
     * log overlay is shown. This is controlled by the Foundry setting
     * "Debug Loading Mode" and defaults to disabled.
     * @type {boolean}
     */
    this.debugMode = false;

    /**
     * All recorded loading entries for the current session.
     * @type {DebugLoadEntry[]}
     */
    this.entries = [];

    /**
     * Currently open (started but not ended) entries, keyed by id.
     * @type {Map<string, DebugLoadEntry>}
     */
    this._openEntries = new Map();

    /**
     * Absolute timestamp when the current profiling session started.
     * @type {number}
     */
    this._sessionStartMs = 0;

    /**
     * Scene name for the current session.
     * @type {string}
     */
    this._sceneName = '';

    /**
     * Resource snapshot taken at the end of loading.
     * @type {ResourceSnapshot|null}
     */
    this.resourceSnapshot = null;

    /**
     * Arbitrary diagnostic info sections to include in the log.
     * Each key maps to an object of key-value pairs rendered as a section.
     * @type {Map<string, Object>}
     */
    this._diagnostics = new Map();

    /**
     * Timestamped event log for inline instrumentation messages.
     * Replaces console.log — all messages appear in the profiler output.
     * @type {Array<{relMs: number, level: string, msg: string}>}
     */
    this._events = [];

    /**
     * Callback fired when a new entry is completed.
     * Used by LoadingOverlay to append log lines in real time.
     * @type {function(DebugLoadEntry): void|null}
     */
    this.onEntryComplete = null;

    /**
     * Callback fired when a new entry starts.
     * Used by LoadingOverlay to show "currently loading..." status.
     * @type {function(DebugLoadEntry): void|null}
     */
    this.onEntryStart = null;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start a new profiling session. Clears all previous data.
   * @param {string} sceneName - Name of the scene being loaded
   */
  startSession(sceneName) {
    this.entries = [];
    this._openEntries.clear();
    this.resourceSnapshot = null;
    this._diagnostics.clear();
    this._events = [];
    this._sceneName = sceneName || 'Unknown Scene';
    this._sessionStartMs = performance.now();
    log.info(`Debug loading profiler session started for "${this._sceneName}"`);
  }

  /**
   * End the current profiling session.
   * Closes any still-open entries with a warning.
   */
  endSession() {
    // Close any orphaned entries
    for (const [id, entry] of this._openEntries) {
      entry.endMs = performance.now();
      entry.durationMs = entry.endMs - entry.startMs;
      entry._orphaned = true;
      this.entries.push(entry);
      log.warn(`Orphaned debug load entry closed: "${id}" (${entry.durationMs.toFixed(1)}ms)`);
    }
    this._openEntries.clear();
    log.info(`Debug loading profiler session ended for "${this._sceneName}" — ${this.entries.length} entries recorded`);
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Log a timestamped event message into the profiler output.
   * Use this instead of console.log for loading instrumentation.
   * @param {string} msg - Message text
   * @param {'info'|'warn'|'error'} [level='info'] - Severity level
   */
  event(msg, level = 'info') {
    if (!this.debugMode) return;
    const relMs = performance.now() - this._sessionStartMs;
    this._events.push({ relMs, level, msg });
  }

  /**
   * Add a diagnostic info section to be rendered in the final log.
   * @param {string} section - Section heading (e.g., 'Asset Cache')
   * @param {Object} data - Key-value pairs to display
   */
  addDiagnostic(section, data) {
    if (!this.debugMode) return;
    const existing = this._diagnostics.get(section);
    if (existing) {
      Object.assign(existing, data);
    } else {
      this._diagnostics.set(section, { ...data });
    }
  }

  // ---------------------------------------------------------------------------
  // Task timing
  // ---------------------------------------------------------------------------

  /**
   * Begin timing a task.
   * @param {string} id - Human-readable task name (e.g., "effect.Specular.initialize")
   * @param {string} [category='other'] - Category for grouping
   * @param {Object} [meta=null] - Optional metadata
   */
  begin(id, category = 'other', meta = null) {
    if (!this.debugMode) return;

    const entry = {
      id,
      category,
      startMs: performance.now(),
      endMs: null,
      durationMs: null,
      meta: meta || null,
      _depth: this._openEntries.size
    };

    this._openEntries.set(id, entry);

    if (this.onEntryStart) {
      try { this.onEntryStart(entry); } catch (_) { /* ignore callback errors */ }
    }
  }

  /**
   * End timing a task. Records the completed entry.
   * @param {string} id - Must match a previous begin() call
   * @param {Object} [extraMeta=null] - Additional metadata to merge
   */
  end(id, extraMeta = null) {
    if (!this.debugMode) return;

    const entry = this._openEntries.get(id);
    if (!entry) {
      log.warn(`end() called for unknown entry: "${id}"`);
      return;
    }

    entry.endMs = performance.now();
    entry.durationMs = entry.endMs - entry.startMs;
    this._openEntries.delete(id);

    if (extraMeta) {
      entry.meta = entry.meta ? { ...entry.meta, ...extraMeta } : extraMeta;
    }

    this.entries.push(entry);

    if (this.onEntryComplete) {
      try { this.onEntryComplete(entry); } catch (_) { /* ignore callback errors */ }
    }
  }

  /**
   * Time a synchronous task in one call.
   * @param {string} id
   * @param {string} category
   * @param {Function} fn - Synchronous function to execute
   * @param {Object} [meta=null]
   * @returns {*} Return value of fn
   */
  timeSync(id, category, fn, meta = null) {
    if (!this.debugMode) return fn();
    this.begin(id, category, meta);
    try {
      const result = fn();
      this.end(id);
      return result;
    } catch (err) {
      this.end(id, { error: err.message });
      throw err;
    }
  }

  /**
   * Time an async task in one call.
   * @param {string} id
   * @param {string} category
   * @param {Function} fn - Async function to execute
   * @param {Object} [meta=null]
   * @returns {Promise<*>} Return value of fn
   */
  async timeAsync(id, category, fn, meta = null) {
    if (!this.debugMode) return fn();
    this.begin(id, category, meta);
    try {
      const result = await fn();
      this.end(id);
      return result;
    } catch (err) {
      this.end(id, { error: err.message });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Resource metrics
  // ---------------------------------------------------------------------------

  /**
   * Capture a snapshot of current resource usage from the Three.js renderer.
   * @param {THREE.WebGLRenderer} renderer
   * @param {Object} [bundle] - Asset bundle with mask textures for GPU estimate
   */
  captureResourceSnapshot(renderer, bundle = null) {
    if (!this.debugMode) return;

    const snap = {
      textures: 0,
      geometries: 0,
      drawCalls: 0,
      triangles: 0,
      jsHeapUsedMB: null,
      jsHeapTotalMB: null,
      estimatedGpuTextureMB: 0
    };

    try {
      if (renderer?.info) {
        snap.textures = renderer.info.memory?.textures ?? 0;
        snap.geometries = renderer.info.memory?.geometries ?? 0;
        snap.drawCalls = renderer.info.render?.calls ?? 0;
        snap.triangles = renderer.info.render?.triangles ?? 0;
        snap.shaderPrograms = Array.isArray(renderer.info.programs) ? renderer.info.programs.length : null;
        snap.renderFrame = renderer.info.render?.frame ?? null;
      }
    } catch (_) { /* ignore */ }

    // JS heap (Chrome only)
    try {
      if (performance.memory) {
        snap.jsHeapUsedMB = (performance.memory.usedJSHeapSize / (1024 * 1024));
        snap.jsHeapTotalMB = (performance.memory.totalJSHeapSize / (1024 * 1024));
      }
    } catch (_) { /* ignore */ }

    // Estimate GPU texture memory from bundle masks
    try {
      if (bundle?.masks?.length) {
        let totalBytes = 0;
        for (const mask of bundle.masks) {
          const tex = mask?.texture;
          if (!tex?.image) continue;
          const w = tex.image.width || 0;
          const h = tex.image.height || 0;
          // Assume 4 bytes per pixel (RGBA8), plus mipmaps (~33% overhead)
          totalBytes += w * h * 4 * 1.33;
        }
        snap.estimatedGpuTextureMB = totalBytes / (1024 * 1024);
      }
    } catch (_) { /* ignore */ }

    this.resourceSnapshot = snap;
  }

  // ---------------------------------------------------------------------------
  // Log generation
  // ---------------------------------------------------------------------------

  /**
   * Generate the formatted debug log text.
   * Builds a hierarchical tree from flat entries, computes exclusive (self) time
   * for each entry, and renders an indented log with accurate category sums.
   * @returns {string} Full selectable text log
   */
  generateLog() {
    const lines = [];
    const divider = '═'.repeat(55);

    lines.push(divider);
    lines.push('  MAP SHINE — DEBUG LOADING PROFILE');
    lines.push(`  Scene: "${this._sceneName}"`);
    lines.push(`  Date: ${new Date().toISOString()}`);
    lines.push(divider);
    lines.push('');

    // Sort entries chronologically by start time, depth as tiebreaker
    const sorted = [...this.entries]
      .filter(e => e.durationMs != null)
      .sort((a, b) => (a.startMs - b.startMs) || ((a._depth || 0) - (b._depth || 0)));

    // Build parent/child tree using time-containment heuristic
    for (const entry of sorted) {
      entry._treeChildren = [];
      entry._treeParent = null;
    }
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      let bestParent = null;
      for (let j = i - 1; j >= 0; j--) {
        const cand = sorted[j];
        if (cand.startMs <= entry.startMs && (cand.endMs || 0) >= (entry.endMs || 0)) {
          if (!bestParent || cand.startMs > bestParent.startMs) {
            bestParent = cand;
          }
        }
      }
      if (bestParent) {
        entry._treeParent = bestParent;
        bestParent._treeChildren.push(entry);
      }
    }

    // Compute exclusive (self) time = total − direct children total
    for (const entry of sorted) {
      const childSum = entry._treeChildren.reduce((s, c) => s + (c.durationMs || 0), 0);
      entry._selfMs = Math.max(0, (entry.durationMs || 0) - childSum);
    }

    // Render task entries with indentation
    const sessionStart = this._sessionStartMs;
    for (const entry of sorted) {
      const offsetSec = ((entry.startMs - sessionStart) / 1000).toFixed(3);
      const dur = `${entry.durationMs.toFixed(1)}ms`;
      const cat = `[${entry.category}]`.padEnd(12);
      const indent = '  '.repeat(entry._depth || 0);
      const orphanTag = entry._orphaned ? ' [ORPHANED]' : '';
      const metaStr = entry.meta ? ` ${_formatMeta(entry.meta)}` : '';
      const selfStr = (entry._treeChildren.length > 0 && entry._selfMs < entry.durationMs)
        ? ` (self: ${entry._selfMs.toFixed(1)}ms)`
        : '';
      lines.push(`[+${offsetSec}s] ${cat} ${indent}${entry.id} — ${dur}${selfStr}${orphanTag}${metaStr}`);
    }

    lines.push('');
    lines.push(divider);
    lines.push('  SUMMARY');
    lines.push(divider);
    lines.push('');

    // Total load time: max endMs across all entries − session start
    let maxEndMs = 0;
    for (const e of sorted) {
      if ((e.endMs || 0) > maxEndMs) maxEndMs = e.endMs;
    }
    const totalMs = maxEndMs > 0 ? maxEndMs - sessionStart : 0;
    lines.push(`Total Load Time: ${totalMs.toFixed(1)}ms`);
    lines.push('');

    // Category breakdown using EXCLUSIVE (self) time to avoid double-counting
    const catTotals = new Map();
    for (const entry of sorted) {
      const cat = entry.category || 'other';
      catTotals.set(cat, (catTotals.get(cat) || 0) + (entry._selfMs ?? entry.durationMs ?? 0));
    }
    const catEntries = [...catTotals.entries()].sort((a, b) => b[1] - a[1]);

    lines.push('By Category (exclusive time):');
    for (const [cat, dur] of catEntries) {
      const pct = totalMs > 0 ? ((dur / totalMs) * 100).toFixed(1) : '0.0';
      const label = `  ${cat}:`.padEnd(18);
      const durStr = `${dur.toFixed(1)}ms`.padStart(12);
      const marker = totalMs > 0 && (dur / totalMs) > 0.25 ? '  ← BOTTLENECK' : '';
      lines.push(`${label}${durStr} (${pct}%)${marker}`);
    }
    lines.push('');

    // Top 10 slowest by EXCLUSIVE (self) time — most actionable for optimization
    const bySelfTime = [...sorted]
      .sort((a, b) => (b._selfMs ?? b.durationMs ?? 0) - (a._selfMs ?? a.durationMs ?? 0))
      .slice(0, 10);

    lines.push('Top 10 Slowest (by exclusive time):');
    for (let i = 0; i < bySelfTime.length; i++) {
      const e = bySelfTime[i];
      const num = `${i + 1}.`.padEnd(4);
      const name = e.id.padEnd(42);
      const selfMs = (e._selfMs ?? e.durationMs ?? 0).toFixed(1);
      const totalStr = (e._treeChildren?.length > 0 && (e._selfMs ?? 0) < (e.durationMs ?? 0))
        ? ` (total: ${e.durationMs.toFixed(1)}ms)`
        : '';
      lines.push(`  ${num}${name}${selfMs}ms${totalStr}`);
    }
    lines.push('');

    // Resource snapshot
    if (this.resourceSnapshot) {
      const snap = this.resourceSnapshot;
      lines.push('Resource Snapshot:');
      lines.push(`  Textures: ${snap.textures}`);
      lines.push(`  Geometries: ${snap.geometries}`);
      if (snap.shaderPrograms != null) {
        lines.push(`  Shader Programs: ${snap.shaderPrograms}`);
      }
      if (snap.jsHeapUsedMB != null) {
        lines.push(`  JS Heap: ${snap.jsHeapUsedMB.toFixed(1)} MB / ${snap.jsHeapTotalMB?.toFixed(1) ?? '?'} MB`);
      }
      if (snap.estimatedGpuTextureMB > 0) {
        lines.push(`  Est. GPU Textures: ~${snap.estimatedGpuTextureMB.toFixed(0)} MB`);
      }
      lines.push(`  Draw Calls (frame 1): ${snap.drawCalls}`);
      lines.push(`  Triangles (frame 1): ${snap.triangles.toLocaleString()}`);
      if (snap.renderFrame != null) {
        lines.push(`  Render Frame #: ${snap.renderFrame}`);
      }
    }

    // Event timeline (replaces console.log messages)
    if (this._events.length > 0) {
      lines.push(divider);
      lines.push('  EVENT LOG');
      lines.push(divider);
      lines.push('');
      for (const ev of this._events) {
        const t = `[+${(ev.relMs / 1000).toFixed(3)}s]`;
        const lvl = ev.level === 'info' ? '' : ` [${ev.level.toUpperCase()}]`;
        lines.push(`${t}${lvl} ${ev.msg}`);
      }
      lines.push('');
    }

    // Diagnostic info sections (cache stats, tile details, etc.)
    if (this._diagnostics.size > 0) {
      lines.push(divider);
      lines.push('  DIAGNOSTICS');
      lines.push(divider);
      lines.push('');
      for (const [section, data] of this._diagnostics) {
        lines.push(`${section}:`);
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            const val = (Array.isArray(v)) ? v.join(', ') : String(v ?? '—');
            lines.push(`  ${k}: ${val}`);
          }
        }
        lines.push('');
      }
    }

    // Cleanup temporary tree properties
    for (const entry of sorted) {
      delete entry._treeChildren;
      delete entry._treeParent;
      delete entry._selfMs;
    }

    return lines.join('\n');
  }

  /**
   * Generate a single log line for a completed entry (used for real-time overlay updates).
   * @param {DebugLoadEntry} entry
   * @returns {string}
   */
  formatEntryLine(entry) {
    const offsetSec = ((entry.startMs - this._sessionStartMs) / 1000).toFixed(3);
    const duration = entry.durationMs != null ? `${entry.durationMs.toFixed(1)}ms` : '???';
    const cat = `[${entry.category}]`.padEnd(12);
    const indent = '  '.repeat(entry._depth || 0);
    return `[+${offsetSec}s] ${cat} ${indent}${entry.id} — ${duration}`;
  }
}

/**
 * Format metadata object into a compact string for log display.
 * @param {Object} meta
 * @returns {string}
 */
function _formatMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    if (typeof v === 'number') {
      parts.push(`${k}=${Number.isInteger(v) ? v : v.toFixed(1)}`);
    } else if (typeof v === 'string' && v.length < 60) {
      parts.push(`${k}="${v}"`);
    } else if (typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.length > 0 ? `{${parts.join(', ')}}` : '';
}

/** Singleton instance used throughout the loading pipeline. */
export const debugLoadingProfiler = new DebugLoadingProfiler();
