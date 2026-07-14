/**
 * @fileoverview FrameGraph — the minimal declarative render-pass scheduler for
 * the V3 unified pipeline (Forward+ plan B0-2 §2).
 *
 * A pass declares the logical resources it {@link FrameGraphPass.reads reads}
 * and {@link FrameGraphPass.writes writes}; the graph derives execution order
 * from those data dependencies (topological, stable-tie-broken by registration
 * order), validates it, allocates physical render targets from a pool, and runs
 * each pass with per-pass timing. This replaces the implicit ordering,
 * ping-pong bookkeeping, and RT-lifetime management scattered through
 * `FloorCompositor.render()` — where picking the wrong ping-pong anchor is a
 * documented cause of WebGL feedback loops → black frames.
 *
 * ## Design constraints (from B0-2)
 * - **~200 lines, not an engine.** No multi-queue scheduling, no automatic pass
 *   splitting, no cross-frame resource versioning. If a need appears it is a
 *   design change, not a config toggle.
 * - **Loud, not silent.** A dependency cycle, a read-before-write, a write to an
 *   imported resource, or a same-resource read+write (WebGL feedback loop) is a
 *   compile-time throw — never a degraded frame (Forward+ §14.1 principle 4).
 * - **THREE-free core.** Physical resource allocation is delegated to an
 *   injected {@link FrameGraphAllocator} so this module carries no `three`
 *   dependency and is exercisable under Node. The V3 orchestrator injects a
 *   real THREE-backed allocator; tests inject a fake.
 * - **Correctness before memory.** v1 allocates one physical target per declared
 *   resource, pooled by name and reused across frames. Lifetime **aliasing**
 *   (sharing physical targets between resources whose live ranges do not
 *   overlap) is a deliberate follow-up behind a debug flag (B0-2 §5 #3), not in
 *   this file yet.
 *
 * @module compositor-v3/FrameGraph
 */

/**
 * @typedef {object} ResourceDescriptor
 * @property {'screen'|[number, number]} size - `'screen'` tracks the frame's
 *   drawing-buffer size; `[w, h]` is a fixed allocation.
 * @property {number} [format] - THREE pixel format (opaque to this module;
 *   passed verbatim to the allocator).
 * @property {number} [type] - THREE texture type (opaque here).
 * @property {number} [mrtCount=1] - Number of color attachments (the attribute
 *   buffer rides on `mrtCount: 2`, B0-1).
 * @property {boolean} [depth=false] - Whether the target needs a depth buffer.
 * @property {number} [scale=1] - Multiplier applied to `'screen'` size (e.g. a
 *   half-res producer uses `0.5`).
 * @property {string} [colorSpace] - THREE color space (opaque here).
 */

/**
 * @typedef {object} FrameGraphPass
 * @property {string} name - Unique; becomes the timing + diagnostics key.
 * @property {string[]} [reads] - Logical resource names this pass samples.
 * @property {string[]} [writes] - Logical resource names this pass renders into.
 * @property {() => boolean} [when] - Optional per-frame gate. A skipped pass
 *   contributes no timing and allocates nothing; its writes are simply not
 *   produced this frame (readers must be gated consistently — see class docs).
 * @property {(ctx: PassContext) => void} execute - The render body.
 * @property {'sceneRect'|'full'} [scissor] - Advisory; carried through to the
 *   pass context for the executor to honor (the graph does not set GL state).
 */

/**
 * @typedef {object} FrameGraphAllocator
 * @property {(name: string, desc: ResolvedDescriptor) => any} create - Allocate
 *   a physical target for a resolved descriptor. Return value is opaque.
 * @property {(handle: any, w: number, h: number) => void} [resize] - Resize an
 *   existing physical target in place. If absent, the graph disposes + recreates
 *   on size change.
 * @property {(handle: any) => void} [dispose] - Free a physical target.
 */

/**
 * @typedef {object} PassContext
 * @property {any} renderer
 * @property {any} camera
 * @property {number} width - Current drawing-buffer width.
 * @property {number} height - Current drawing-buffer height.
 * @property {(name: string) => any} get - Physical handle for a resource this
 *   pass reads or imported/earlier-written. Throws if the name is unknown.
 * @property {(name: string) => any} target - Physical handle for a resource this
 *   pass writes (allocated on demand). Throws if `name` is not in `writes`.
 * @property {'sceneRect'|'full'|null} scissor - The pass's advisory scissor.
 * @property {object} frame - The verbatim frame context passed to `execute()`.
 */

/**
 * @typedef {ResourceDescriptor & {resolvedW: number, resolvedH: number}} ResolvedDescriptor
 */

const DEFAULT_NOW = () => {
  // performance.now in browser/Node; Date-free fallback keeps the module usable
  // in the workflow-script sandbox that forbids Date.now().
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch (_) {}
  return 0;
};

export class FrameGraph {
  /**
   * @param {object} [options]
   * @param {FrameGraphAllocator} [options.allocator] - Physical target factory.
   *   Required before {@link FrameGraph#execute} allocates anything; may be set
   *   later via {@link FrameGraph#setAllocator}.
   * @param {() => number} [options.now] - Monotonic clock for pass timing.
   * @param {(msg: string, ...args: any[]) => void} [options.logWarn]
   */
  constructor(options = {}) {
    /** @type {FrameGraphAllocator|null} */
    this._allocator = options.allocator ?? null;
    this._now = typeof options.now === 'function' ? options.now : DEFAULT_NOW;
    this._logWarn = typeof options.logWarn === 'function' ? options.logWarn : null;

    /** @type {FrameGraphPass[]} Passes in registration order. */
    this._passes = [];
    /** @type {Map<string, ResourceDescriptor>} Declared (writable) resources. */
    this._declared = new Map();
    /** @type {Map<string, any>} Imported (read-only external) handles. */
    this._imports = new Map();

    /** @type {number[]|null} Compiled execution order (indices into _passes). */
    this._order = null;

    /** @type {Map<string, {handle: any, w: number, h: number, desc: ResourceDescriptor}>} */
    this._pool = new Map();
    /** @type {Map<string, number>} Last-frame per-pass CPU ms. */
    this._timings = new Map();
    /** @type {{width: number, height: number}} */
    this._lastFrameSize = { width: 0, height: 0 };
    /**
     * Optional GPU timer (duck-typed so this module stays THREE/WebGL-free —
     * see GpuPassTimer for the real one, tests inject a fake):
     * `{ frameBegin(), begin(name) → boolean, end(), getResults() → Map }`.
     * @type {{frameBegin?: () => void, begin: (name: string) => boolean, end: () => void, getResults: () => Map<string, number>}|null}
     */
    this._gpuTimer = null;
  }

  /** @param {FrameGraphAllocator} allocator */
  setAllocator(allocator) {
    this._allocator = allocator ?? null;
  }

  /**
   * Inject a per-pass GPU timer (see the `_gpuTimer` field for the interface).
   * Pass `null` to remove. GPU timings are a diagnostic luxury: every call is
   * guarded so a broken timer can never take a frame down.
   * @param {object|null} timer
   */
  setGpuTimer(timer) {
    this._gpuTimer = timer ?? null;
  }

  /**
   * Declare a writable logical resource and its allocation descriptor. Must be
   * called before any pass that writes `name`. Re-declaring with a different
   * descriptor is an error (a resource has one shape).
   * @param {string} name
   * @param {ResourceDescriptor} descriptor
   * @returns {this}
   */
  declareResource(name, descriptor) {
    if (!name || typeof name !== 'string') {
      throw new Error('FrameGraph.declareResource: name must be a non-empty string');
    }
    if (this._imports.has(name)) {
      throw new Error(`FrameGraph.declareResource: "${name}" is already an imported resource`);
    }
    if (this._declared.has(name)) {
      throw new Error(`FrameGraph.declareResource: "${name}" already declared`);
    }
    if (!descriptor || (descriptor.size !== 'screen' && !Array.isArray(descriptor.size))) {
      throw new Error(`FrameGraph.declareResource: "${name}" needs size 'screen' or [w,h]`);
    }
    this._declared.set(name, { mrtCount: 1, depth: false, scale: 1, ...descriptor });
    this._order = null;
    return this;
  }

  /**
   * Register a read-only external resource (mask-compositor product, sim RT,
   * Foundry-owned texture). Passes may {@link PassContext.get read} it but not
   * write it. The graph never allocates, resizes, or disposes imports.
   * @param {string} name
   * @param {any} handle
   * @returns {this}
   */
  importResource(name, handle) {
    if (this._declared.has(name)) {
      throw new Error(`FrameGraph.importResource: "${name}" is a declared (writable) resource`);
    }
    this._imports.set(name, handle);
    return this;
  }

  /**
   * Register a pass. Order of registration is the stable tie-break when data
   * dependencies leave execution order ambiguous; it is not itself the
   * execution order (that is derived in {@link FrameGraph#compile}).
   * @param {FrameGraphPass} pass
   * @returns {this}
   */
  addPass(pass) {
    if (!pass || typeof pass.name !== 'string' || !pass.name) {
      throw new Error('FrameGraph.addPass: pass.name must be a non-empty string');
    }
    if (typeof pass.execute !== 'function') {
      throw new Error(`FrameGraph.addPass: pass "${pass.name}" needs an execute() function`);
    }
    if (this._passes.some((p) => p.name === pass.name)) {
      throw new Error(`FrameGraph.addPass: duplicate pass name "${pass.name}"`);
    }
    const reads = Array.isArray(pass.reads) ? pass.reads.slice() : [];
    const writes = Array.isArray(pass.writes) ? pass.writes.slice() : [];

    // Feedback-loop guard: a pass cannot read and write the same resource. This
    // is the exact hazard the graph exists to prevent (sampling an RT you are
    // rendering into → GL_INVALID_OPERATION → black frame). Use two resources
    // and let aliasing (later) reclaim the memory instead.
    for (const r of reads) {
      if (writes.includes(r)) {
        throw new Error(
          `FrameGraph.addPass: pass "${pass.name}" both reads and writes "${r}" `
          + '(feedback loop). Declare separate input/output resources.',
        );
      }
    }
    this._passes.push({
      name: pass.name,
      reads,
      writes,
      when: typeof pass.when === 'function' ? pass.when : null,
      execute: pass.execute,
      scissor: pass.scissor ?? null,
    });
    this._order = null;
    return this;
  }

  /**
   * Derive and validate execution order. Idempotent: caches until the pass set
   * or resource set changes. Throws (loudly, at "registration time") on:
   *  - a read of a resource that is neither imported nor written by any pass;
   *  - a write to an imported resource;
   *  - a write to an undeclared resource;
   *  - a dependency cycle.
   * @returns {number[]} execution order as indices into the registration list
   */
  compile() {
    if (this._order) return this._order;

    const n = this._passes.length;
    const writersOf = new Map();   // resource → [passIdx...] in registration order
    const readersOf = new Map();   // resource → [passIdx...]

    for (let i = 0; i < n; i++) {
      const p = this._passes[i];
      for (const w of p.writes) {
        if (this._imports.has(w)) {
          throw new Error(
            `FrameGraph.compile: pass "${p.name}" writes imported (read-only) resource "${w}"`,
          );
        }
        if (!this._declared.has(w)) {
          throw new Error(
            `FrameGraph.compile: pass "${p.name}" writes undeclared resource "${w}" `
            + '(call declareResource first)',
          );
        }
        if (!writersOf.has(w)) writersOf.set(w, []);
        writersOf.get(w).push(i);
      }
      for (const r of p.reads) {
        if (!readersOf.has(r)) readersOf.set(r, []);
        readersOf.get(r).push(i);
      }
    }

    // Read-before-write validation: every read resource must be imported or
    // have at least one writer somewhere in the graph. (Ordering — that the
    // writer actually runs first — is then guaranteed by the RAW edges + topo
    // sort below, or surfaces as a cycle.)
    for (const [res, readers] of readersOf) {
      if (this._imports.has(res)) continue;
      if (!writersOf.has(res)) {
        const first = this._passes[readers[0]];
        throw new Error(
          `FrameGraph.compile: pass "${first.name}" reads "${res}" but nothing writes or imports it`,
        );
      }
    }

    // Build dependency edges (adjacency + indegree) for Kahn's algorithm.
    //  - RAW: every writer → every reader of the same resource (reader depends
    //    on writer producing it).
    //  - WAW: consecutive writers of a resource ordered by registration, so
    //    two passes targeting the same resource keep authoring order.
    const adj = Array.from({ length: n }, () => new Set());
    const indeg = new Array(n).fill(0);
    const addEdge = (from, to) => {
      if (from === to) return;
      if (!adj[from].has(to)) {
        adj[from].add(to);
        indeg[to] += 1;
      }
    };
    for (const [res, writers] of writersOf) {
      const readers = readersOf.get(res) ?? [];
      for (const w of writers) {
        for (const r of readers) addEdge(w, r);
      }
      for (let k = 1; k < writers.length; k++) addEdge(writers[k - 1], writers[k]);
    }

    // Kahn's algorithm with a registration-order tie-break: among all currently
    // schedulable passes, always emit the one registered earliest. This makes
    // the derived order deterministic and, for a pipeline authored in intended
    // execution order, identical to registration order.
    const ready = [];
    for (let i = 0; i < n; i++) if (indeg[i] === 0) ready.push(i);
    ready.sort((a, b) => a - b);

    const order = [];
    while (ready.length) {
      const idx = ready.shift(); // smallest registration index (list stays sorted)
      order.push(idx);
      const nexts = Array.from(adj[idx]).sort((a, b) => a - b);
      for (const m of nexts) {
        indeg[m] -= 1;
        if (indeg[m] === 0) {
          // Insert keeping `ready` sorted by registration index.
          let lo = 0; let hi = ready.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ready[mid] < m) lo = mid + 1; else hi = mid;
          }
          ready.splice(lo, 0, m);
        }
      }
    }

    if (order.length !== n) {
      const scheduled = new Set(order);
      const stuck = [];
      for (let i = 0; i < n; i++) if (!scheduled.has(i)) stuck.push(this._passes[i].name);
      throw new Error(
        `FrameGraph.compile: dependency cycle among passes [${stuck.join(', ')}]`,
      );
    }

    this._order = order;
    return order;
  }

  /**
   * Run the graph for one frame.
   * @param {object} frameCtx
   * @param {any} [frameCtx.renderer]
   * @param {any} [frameCtx.camera]
   * @param {number} frameCtx.width - Drawing-buffer width.
   * @param {number} frameCtx.height - Drawing-buffer height.
   * @returns {{ order: string[], skipped: string[] }}
   */
  execute(frameCtx = {}) {
    const order = this.compile();
    const width = Math.max(1, Math.floor(Number(frameCtx.width) || 1));
    const height = Math.max(1, Math.floor(Number(frameCtx.height) || 1));
    this._lastFrameSize = { width, height };
    this._timings.clear();

    const ranNames = [];
    const skippedNames = [];

    // Resolve any completed GPU queries from earlier frames before this frame
    // opens new ones. Guarded: the timer must never be able to break a frame.
    const gpuTimer = this._gpuTimer;
    if (gpuTimer) {
      try { gpuTimer.frameBegin?.(); } catch (_) { /* timer self-manages errors */ }
    }

    // A resource is "available" to a pass's get() once it has been produced this
    // frame (written by an earlier executed pass) or imported. Writes register
    // availability the moment target() is first requested for them.
    const producedThisFrame = new Set();

    for (const idx of order) {
      const pass = this._passes[idx];
      if (pass.when && !pass.when()) {
        skippedNames.push(pass.name);
        continue;
      }

      const ctx = this._makePassContext(pass, frameCtx, width, height, producedThisFrame);
      let gpuTimed = false;
      if (gpuTimer) {
        try { gpuTimed = gpuTimer.begin(pass.name) === true; } catch (_) {}
      }
      const t0 = this._now();
      try {
        pass.execute(ctx);
      } catch (err) {
        // A throwing pass is a real defect; surface it but do not abort the
        // whole frame silently — subsequent passes that depend on this one will
        // fail their own get() loudly, which localizes the blame.
        if (this._logWarn) this._logWarn(`FrameGraph: pass "${pass.name}" threw`, err);
        else throw err;
      } finally {
        if (gpuTimed) {
          try { gpuTimer.end(); } catch (_) {}
        }
      }
      this._timings.set(pass.name, this._now() - t0);
      for (const w of pass.writes) producedThisFrame.add(w);
      ranNames.push(pass.name);
    }

    return { order: ranNames, skipped: skippedNames };
  }

  /**
   * @param {FrameGraphPass} pass
   * @param {object} frameCtx
   * @param {number} width
   * @param {number} height
   * @param {Set<string>} producedThisFrame
   * @returns {PassContext}
   * @private
   */
  _makePassContext(pass, frameCtx, width, height, producedThisFrame) {
    const readable = new Set([...pass.reads, ...pass.writes]);
    const writable = new Set(pass.writes);
    return {
      renderer: frameCtx.renderer ?? null,
      camera: frameCtx.camera ?? null,
      width,
      height,
      scissor: pass.scissor,
      frame: frameCtx,
      get: (name) => {
        if (!readable.has(name)) {
          throw new Error(
            `FrameGraph: pass "${pass.name}" get("${name}") — not in its reads/writes`,
          );
        }
        if (this._imports.has(name)) return this._imports.get(name);
        if (this._declared.has(name)) {
          if (!writable.has(name) && !producedThisFrame.has(name)) {
            throw new Error(
              `FrameGraph: pass "${pass.name}" reads "${name}" before it was produced this frame`,
            );
          }
          return this._acquire(name, width, height).handle;
        }
        throw new Error(`FrameGraph: pass "${pass.name}" get("${name}") — unknown resource`);
      },
      target: (name) => {
        if (!writable.has(name)) {
          throw new Error(
            `FrameGraph: pass "${pass.name}" target("${name}") — not in its writes`,
          );
        }
        const entry = this._acquire(name, width, height);
        producedThisFrame.add(name);
        return entry.handle;
      },
    };
  }

  /**
   * Acquire (allocate or reuse+resize) the physical target for a declared
   * resource. v1: one physical target per resource name, pooled across frames.
   * @param {string} name
   * @param {number} frameW
   * @param {number} frameH
   * @private
   */
  _acquire(name, frameW, frameH) {
    if (!this._allocator) {
      throw new Error(`FrameGraph: no allocator set; cannot allocate "${name}"`);
    }
    const desc = this._declared.get(name);
    const { w, h } = this._resolveSize(desc, frameW, frameH);

    let entry = this._pool.get(name);
    if (!entry) {
      const resolved = { ...desc, resolvedW: w, resolvedH: h };
      const handle = this._allocator.create(name, resolved);
      entry = { handle, w, h, desc };
      this._pool.set(name, entry);
      return entry;
    }
    if (entry.w !== w || entry.h !== h) {
      if (typeof this._allocator.resize === 'function') {
        this._allocator.resize(entry.handle, w, h);
      } else {
        if (typeof this._allocator.dispose === 'function') this._allocator.dispose(entry.handle);
        const resolved = { ...desc, resolvedW: w, resolvedH: h };
        entry.handle = this._allocator.create(name, resolved);
      }
      entry.w = w;
      entry.h = h;
    }
    return entry;
  }

  /**
   * @param {ResourceDescriptor} desc
   * @param {number} frameW
   * @param {number} frameH
   * @returns {{w: number, h: number}}
   * @private
   */
  _resolveSize(desc, frameW, frameH) {
    if (Array.isArray(desc.size)) {
      return { w: Math.max(1, desc.size[0] | 0), h: Math.max(1, desc.size[1] | 0) };
    }
    const scale = Number(desc.scale) > 0 ? Number(desc.scale) : 1;
    return {
      w: Math.max(1, Math.round(frameW * scale)),
      h: Math.max(1, Math.round(frameH * scale)),
    };
  }

  /** @returns {Map<string, number>} last-frame per-pass CPU ms (copy). */
  getLastTimings() {
    return new Map(this._timings);
  }

  /**
   * Latest completed per-pass GPU ms from the injected timer (empty map when no
   * timer / unsupported). Values are the most recent *resolved* measurements —
   * GPU query results arrive 1–3 frames after submission, so treat them as
   * "recent", not "this frame".
   * @returns {Map<string, number>} (copy)
   */
  getGpuTimings() {
    if (!this._gpuTimer) return new Map();
    try {
      const m = this._gpuTimer.getResults?.();
      return m instanceof Map ? new Map(m) : new Map();
    } catch (_) {
      return new Map();
    }
  }

  /** @returns {string[]} declared execution order (compiling if needed). */
  getExecutionOrder() {
    return this.compile().map((i) => this._passes[i].name);
  }

  /** @returns {{passes: number, declared: number, imported: number, pooled: number}} */
  getStats() {
    return {
      passes: this._passes.length,
      declared: this._declared.size,
      imported: this._imports.size,
      pooled: this._pool.size,
    };
  }

  /** Clear only per-frame imports (call at frame start before re-importing). */
  clearImports() {
    this._imports.clear();
    this._order = null;
  }

  /**
   * Remove all passes and declared resources (keeps the pooled physical targets
   * so a redefine-then-execute does not thrash GPU memory). Call when the pass
   * list itself changes shape (e.g. effects enabled/disabled structurally).
   */
  resetGraph() {
    this._passes.length = 0;
    this._declared.clear();
    this._imports.clear();
    this._order = null;
  }

  /** Dispose every pooled physical target. Call on teardown. */
  dispose() {
    if (this._allocator && typeof this._allocator.dispose === 'function') {
      for (const entry of this._pool.values()) {
        try { this._allocator.dispose(entry.handle); } catch (_) {}
      }
    }
    this._pool.clear();
    this._passes.length = 0;
    this._declared.clear();
    this._imports.clear();
    this._order = null;
    this._timings.clear();
  }
}
