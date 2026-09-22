/**
 * DOES PANNING COMPILE SHADERS? — the one measurement that settles
 * mythica-machina-press#611.
 *
 * ============================================================================
 * THE QUESTION, AND WHY IT NEEDS ITS OWN INSTRUMENT
 * ============================================================================
 * The author's performance trace of the freeze-on-first-pan shows the GPU
 * PROCESS busy for 75.6s across twelve tasks (16.5s, 12.5s, 10.2s...) while the
 * renderer's main thread sits IDLE. GPU-process work with an idle JS thread is
 * the signature of asynchronous pipeline compilation.
 *
 * It is a theory. Four theories about this freeze have already been wrong, and
 * each was expensive precisely because it was reasoned rather than measured —
 * including "compilation is ruled out", which was asserted from probes that
 * bracket the JS-side `createRenderPipeline` call and therefore cannot see
 * driver compilation happening in another process at all.
 *
 * So this does not reason. It counts pipelines, it notices whether the camera
 * was moving, and it reports the correlation. If the pipeline cache grows while
 * the camera moves, pipelines are being compiled on pan and #611 has its
 * mechanism. If it stays flat, the theory is dead and nobody spends another
 * round building on it.
 *
 * ============================================================================
 * WHY `readPipelineCount()` IS TRUSTWORTHY HERE
 * ============================================================================
 * `renderer._pipelines.caches` was verified directly against the vendored
 * `three.webgpu.js` to be a real `Map`, and `getForCompute` shares it with the
 * render path — so the count covers both. It is a plain `.size` read: no
 * allocation, no GPU call, nothing that could itself perturb what it measures.
 * That matters for an instrument meant to run inside the render loop.
 *
 * ============================================================================
 * WHAT "MOVING" MEANS, AND WHY IT IS DELIBERATELY GENEROUS
 * ============================================================================
 * A pan is any frame whose view rect differs from the previous frame's. Not a
 * velocity threshold, not a gesture state — the question is "did new content
 * come into view", and a single-pixel nudge that reveals a new mesh counts just
 * as much as a fast drag. A threshold here would be a second opinion about what
 * a pan is, and the cheapest way to get a wrong answer is to define the
 * question narrowly enough to miss it.
 *
 * Pure: no clock, no renderer, no globals. Time and counts are inputs, the same
 * discipline `vt/settle.js` follows, so it is Node-testable without a browser.
 *
 * @module vt/pan-compile-probe
 */

/** @typedef {{minX:number,minY:number,maxX:number,maxY:number}} Rect */

/**
 * A frame gap at or above which this probe will call something a stall.
 *
 * 250ms, matching `ui/load-progress.js#STALL_THRESHOLD_MS` — the "is it dead"
 * question, NOT the renderer's 50ms hitch threshold. Those are two different
 * measurements and this file asks the first one: the user reported a FREEZE,
 * not a stutter.
 */
const STALL_MS = 250;

/** Did the view rect change at all between two frames? */
function rectChanged(a, b) {
  if (!a || !b) return false;
  return a.minX !== b.minX || a.minY !== b.minY || a.maxX !== b.maxX || a.maxY !== b.maxY;
}

/**
 * @returns {{sample: Function, read: Function, reset: Function}}
 */
export function createPanCompileProbe() {
  let lastRect = null;
  let lastCount = null;
  let movingFrames = 0;
  let stillFrames = 0;
  let compiledWhileMoving = 0;
  let compiledWhileStill = 0;
  let worstGapWhileMovingMs = 0;
  let worstGapWhileStillMs = 0;
  /** @type {Array<{atFrame:number, created:number, gapMs:number}>} */
  let movingBursts = [];
  let frame = 0;
  /**
   * Compiles seen AFTER the curtain lifted (mythica-machina-press#614).
   *
   * This is the regression detector for #614. A pipeline compiling once the
   * user can see the map IS the bug — it is the freeze-then-pop-in, by
   * definition, whatever effect happened to cause it. Counting it means the
   * module notices its own regression instead of waiting for someone to report
   * a stutter months later.
   *
   * `null` until the curtain is known to have lifted, so "not watching yet" can
   * never be mistaken for "watched and saw nothing".
   */
  let compiledAfterReveal = null;
  let worstGapAfterRevealMs = 0;

  /**
   * One frame.
   * @param {object} s
   * @param {Rect|null} s.viewRect - this frame's world-space view rect.
   * @param {number|null} s.pipelineCount - `readPipelineCount()`; null when
   *   unavailable, which is recorded as unavailable and never as zero.
   * @param {number} [s.gapMs] - ms since the previous frame.
   */
  function sample({ viewRect, pipelineCount, gapMs = 0 }) {
    frame++;
    const moving = rectChanged(lastRect, viewRect);
    // A FIRST reading establishes the baseline and can never be a delta —
    // otherwise frame one would attribute every pipeline compiled during
    // startup to whatever the camera happened to be doing.
    const created = Number.isFinite(pipelineCount) && lastCount !== null ? Math.max(0, pipelineCount - lastCount) : 0;
    if (Number.isFinite(pipelineCount)) lastCount = pipelineCount;

    if (compiledAfterReveal !== null) {
      compiledAfterReveal += created;
      if (gapMs > worstGapAfterRevealMs) worstGapAfterRevealMs = gapMs;
    }
    if (moving) {
      movingFrames++;
      compiledWhileMoving += created;
      if (gapMs > worstGapWhileMovingMs) worstGapWhileMovingMs = gapMs;
      // Keep the individual bursts, not just the total: "12 pipelines in one
      // frame that also took 900ms" and "12 pipelines spread over 200 frames"
      // are completely different findings, and a sum cannot tell them apart.
      if (created > 0) {
        movingBursts.push({ atFrame: frame, created, gapMs: Math.round(gapMs) });
        if (movingBursts.length > 64) movingBursts.shift();
      }
    } else {
      stillFrames++;
      compiledWhileStill += created;
      if (gapMs > worstGapWhileStillMs) worstGapWhileStillMs = gapMs;
    }
    lastRect = viewRect ? { ...viewRect } : null;
  }

  /**
   * The curtain just lifted — start watching for the thing that must not
   * happen. Idempotent: a second call does not restart the count, because a
   * load that revealed once has revealed.
   */
  function noteRevealed() {
    if (compiledAfterReveal === null) compiledAfterReveal = 0;
  }

  function read() {
    const unavailable = lastCount === null;
    const total = compiledWhileMoving + compiledWhileStill;
    return {
      measured: !unavailable,
      movingFrames,
      stillFrames,
      compiledWhileMoving,
      compiledWhileStill,
      worstGapWhileMovingMs: Math.round(worstGapWhileMovingMs),
      worstGapWhileStillMs: Math.round(worstGapWhileStillMs),
      movingBursts: [...movingBursts],
      /**
       * The worst frame gap seen at all, whichever state the camera was in.
       * Carried so this probe can answer the UNPAUSE question too: unpausing
       * happens with the camera still, so a hitch there lands in
       * `worstGapWhileStillMs`, and "was there a stall" must be answerable
       * without the reader having to know which bucket to look in.
       */
      worstGapMs: Math.round(Math.max(worstGapWhileMovingMs, worstGapWhileStillMs)),
      compiledAfterReveal,
      worstGapAfterRevealMs: Math.round(worstGapAfterRevealMs),
      /**
       * THE REGRESSION VERDICT (mythica-machina-press#614). `null` means the
       * curtain is not known to have lifted yet — never "clean".
       */
      postRevealVerdict:
        compiledAfterReveal === null
          ? null
          : compiledAfterReveal > 0
            ? `⚠️ ${compiledAfterReveal} pipeline(s) compiled AFTER the curtain lifted (worst frame ${Math.round(worstGapAfterRevealMs)}ms). That is mythica-machina-press#614 recurring: an effect became visible only after the warm-up converged, so its shader compiled in front of the user. Read \`warmUp.postContentPipelinesCreated\` to see whether the warm-up ran at all, and which effect appeared at that moment.`
            : 'Clean: no pipeline compiled after the curtain lifted. The post-content warm-up caught everything this load.',
      // The verdict this exists to produce, stated rather than left as an
      // exercise — and refusing to give one when nothing was measured.
      verdict: unavailable
        ? 'Pipeline count unavailable — `renderer._pipelines.caches` was not a Map. Nothing measured; this is NOT evidence either way.'
        : total === 0
          ? Math.max(worstGapWhileMovingMs, worstGapWhileStillMs) >= STALL_MS
            ? `A STALL HAPPENED (worst frame gap ${Math.round(Math.max(worstGapWhileMovingMs, worstGapWhileStillMs))}ms) but ZERO pipelines were created. So it is NOT shader compilation — it is main-thread or GPU work. Capture a performance trace of this window and read it per-thread: if the renderer's main thread is busy it is JS, and if it is idle while CrGpuMain is busy it is the GPU process.`
            : 'No pipelines were created, and no frame gap crossed the stall threshold. Nothing to explain in this window — no compilation and no stall.'
          : compiledWhileMoving > compiledWhileStill
            ? `PIPELINES ARE BEING COMPILED ON PAN: ${compiledWhileMoving} while the camera moved vs ${compiledWhileStill} while still. This is mythica-machina-press#611's mechanism — new content entering view is compiling shaders, in the GPU process, which is why the freeze shows there with the main thread idle.`
            : `Pipelines were created, but mostly while the camera was STILL (${compiledWhileStill} still vs ${compiledWhileMoving} moving). Panning is not what triggers them — look at what else changed in this window.`,
    };
  }

  return {
    sample,
    read,
    noteRevealed,
    reset: () => {
      // `lastRect` is KEPT, for the same reason `lastCount` is (below). Reset
      // clears the COUNTS, not the knowledge of where the camera already was.
      // Clearing it would leave the first post-reset frame with nothing to
      // compare against, so it could not tell it had moved — and its compiles
      // would be filed under "still". That is precisely backwards for the
      // intended use: `resetPanCompileProbe()` then pan. The one frame the
      // caller most wants attributed correctly is the first one.
      movingFrames = 0;
      stillFrames = 0;
      compiledWhileMoving = 0;
      compiledWhileStill = 0;
      worstGapWhileMovingMs = 0;
      worstGapWhileStillMs = 0;
      movingBursts = [];
      frame = 0;
      compiledAfterReveal = null;
      worstGapAfterRevealMs = 0;
      // `lastCount` is deliberately KEPT — it is a property of the GPU device
      // for the whole session, not of this window. Clearing it would make the
      // first sample after a reset re-establish a baseline and therefore be
      // blind to a compile happening in exactly the window being reset for.
    },
  };
}
