/**
 * warm-up-chunking.test.mjs — mythica-machina-press#534: the chunked
 * cold-load warm-up draw (`vt-pan-viewer.js#warmUpDrawStateChunked`) and its
 * opt-in flag.
 *
 * TWO KINDS OF COVERAGE, DELIBERATELY SEPARATED:
 *
 * 1. REAL EXECUTION. `setVtPanViewerChunkedWarmUp`/`getVtPanViewerChunkedWarmUp`
 *    and `formatWarmUpChunkDetail` are plain, renderer-free exports — no THREE,
 *    no DOM, just a module-level boolean and a pure string formatter — so
 *    `../vt-pan-viewer.js` is imported directly and these are called for real,
 *    same reasoning `vt-pan-viewer-diagnostics.test.mjs` already gives for
 *    `percentileMs`/`sampleDiagnostics`/`buildDrawList` (CONVENTIONS §4).
 *    Confirmed safe first: importing the whole 27,000+ line module under
 *    plain Node throws nothing and touches no timers (nothing at module top
 *    level reaches `document`/`window`/`requestAnimationFrame` — those are
 *    all read from inside function bodies, never at import time).
 *
 *    `warmUpDrawState`/`warmUpDrawStateChunked` themselves are NOT reachable
 *    this way — genuine closure-nested functions inside `startVtPanViewer`,
 *    needing a real (or exhaustively mocked) THREE renderer to run at all.
 *    That gap is exactly why `chunkIds` (the core "same ids, same order,
 *    just batched" correctness property) was extracted to `graph/run-frame.js`
 *    instead — see `graph/__tests__/run-frame.test.mjs`'s own "chunkIds"
 *    section, which proves that property directly, against the REAL
 *    `masks..present` pass list, with no renderer at all.
 *
 * 2. SOURCE-TEXT REGRESSION CHECKS. The two remaining properties this issue
 *    asks for — "default (flag off) cold-load behaviour is unchanged" and
 *    "the floor-switch call site is untouched" — are about the literal
 *    SHAPE of two specific call sites inside `startVtPanViewer`, a function
 *    this suite cannot execute (see above). Read the file's own real source
 *    text instead (same technique `ui/__tests__/paint-mode.test.mjs` uses to
 *    re-host `installPainter`, minus the re-host/execute step — this suite
 *    never runs the source, only inspects its shape) and assert on it
 *    directly. This is deliberately narrow and literal: it exists to catch a
 *    future edit that widens the chunked path's reach, not to replace a live
 *    test of the actual rendering behaviour (there is no live WebGPU session
 *    available here — see mythica-machina-press#534's own scoping).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setVtPanViewerChunkedWarmUp, getVtPanViewerChunkedWarmUp, formatWarmUpChunkDetail } from '../vt-pan-viewer.js';

const VT_PAN_VIEWER_PATH = fileURLToPath(new URL('../vt-pan-viewer.js', import.meta.url));
const DIAGNOSTICS_PATH = fileURLToPath(new URL('../vt-pan-viewer-diagnostics.js', import.meta.url));
const BOOT_PATH = fileURLToPath(new URL('../../boot.js', import.meta.url));

export function run(t) {
  const { ok } = t;

  // ---- formatWarmUpChunkDetail — pure, real execution ------------------------
  {
    ok(
      'an unmeasured count (null) reads as "compiling", never a fabricated number',
      formatWarmUpChunkDetail(null) === 'Compiling shaders — the screen may pause briefly, in shorter bursts'
    );
    ok(
      'a GENUINE zero is worded distinctly from "unmeasured" — the two must never read the same',
      formatWarmUpChunkDetail(0) === 'Compiling shaders — no new pipelines yet' &&
        formatWarmUpChunkDetail(0) !== formatWarmUpChunkDetail(null)
    );
    ok('singular wording for exactly 1', formatWarmUpChunkDetail(1) === '1 new pipeline compiled so far');
    ok('plural wording for N > 1', formatWarmUpChunkDetail(7) === '7 new pipelines compiled so far');
    ok('plural wording for a large count too', formatWarmUpChunkDetail(240) === '240 new pipelines compiled so far');
  }

  // ---- setVtPanViewerChunkedWarmUp / getVtPanViewerChunkedWarmUp -------------
  {
    // Checked FIRST, before this suite (or anything else in this process —
    // no other suite imports vt-pan-viewer.js today, confirmed by grep) has
    // ever called the setter: the module's own `let _chunkedWarmUpEnabled`
    // seed, observed genuinely untouched.
    //
    // ⚠️ THIS PIN HAS MOVED TWICE — both moves recorded, because a pin that
    // quietly changes direction is worse than no pin.
    //
    // It shipped OFF (#534: the capability was built but never live-tested).
    // It was flipped ON (#582) on the strength of the author's standing "even
    // at the cost of a little loading performance". It is now OFF again — and
    // NOT for the reason first given: the `warmUp.ran:false` that prompted the
    // revert turned out to be a wrong-address read in the report itself (#584),
    // so it was never evidence of anything.
    //
    // The honest reason it stays off: the first live load with it ON went from
    // 31,361ms to 80,024ms, and an untested flag was the one new variable. The
    // control is the path that has actually run in production. Re-enable only
    // once a load with working instrumentation says it is safe.
    ok(
      'defaults OFF — the one live load with it ON went 31s -> 80s, and it has never been live-verified',
      getVtPanViewerChunkedWarmUp().chunkedWarmUpEnabled === false
    );

    ok('the setter flips it on', setVtPanViewerChunkedWarmUp(true).chunkedWarmUpEnabled === true);
    ok('...and the getter agrees', getVtPanViewerChunkedWarmUp().chunkedWarmUpEnabled === true);
    ok('the setter flips it back off', setVtPanViewerChunkedWarmUp(false).chunkedWarmUpEnabled === false);
    ok('...and the getter agrees again', getVtPanViewerChunkedWarmUp().chunkedWarmUpEnabled === false);

    // Fails CLOSED: only a literal `true` may enable it — this is what makes
    // "ship inert until deliberately enabled" a real guarantee rather than a
    // convention a stray truthy value could quietly defeat.
    setVtPanViewerChunkedWarmUp(true);
    for (const notLiterallyTrue of [1, 'true', 'yes', {}, [], undefined, null, 0]) {
      setVtPanViewerChunkedWarmUp(notLiterallyTrue);
      ok(
        `a non-boolean-true value (${JSON.stringify(notLiterallyTrue)}) leaves it OFF, not accidentally on`,
        getVtPanViewerChunkedWarmUp().chunkedWarmUpEnabled === false
      );
    }

    // Restore the default for any later suite in this same process that may
    // (now or in the future) also import vt-pan-viewer.js.
    setVtPanViewerChunkedWarmUp(false);
    ok('left OFF for the rest of this test run', getVtPanViewerChunkedWarmUp().chunkedWarmUpEnabled === false);
  }

  // ---- source-text regression checks — see this file's own header ----------
  {
    // Normalised to LF first: this repo's prettier config is `endOfLine:
    // "auto"`, so the working copy can legitimately be CRLF and every literal
    // anchor below would silently miss (same normalisation paint-mode.test.mjs
    // already uses for the identical reason).
    const src = readFileSync(VT_PAN_VIEWER_PATH, 'utf8').replace(/\r\n/g, '\n');

    // ---- Property: the floor-switch call site is untouched ------------------
    const FLOOR_SWITCH_LINE = 'if (warmUpRestore.length > 0) warmUpDrawState({ includePresent: false });';
    ok(
      'the floor-switch call site still calls the plain synchronous warmUpDrawState, includePresent:false — verbatim',
      src.includes(FLOOR_SWITCH_LINE)
    );

    // The whole visibility-flip/warm-up/restore block, bounded by two
    // pre-existing anchors this change never touched — see warmUpDrawStateChunked's
    // own header for exactly why introducing a yield anywhere in this block
    // would be a real, live bug (a real renderFrame could then observe the
    // new floor's meshes transiently visible=true over the old floor).
    const floorPrepareStart = src.indexOf('const warmUpRestore = [];');
    const floorPrepareEnd = src.indexOf("onProgress?.({ phase: 'warmup', done: 1, total: 1 });");
    ok(
      'both boundary anchors of the floor-prepare warm-up block were found',
      floorPrepareStart >= 0 && floorPrepareEnd > floorPrepareStart
    );
    const floorPrepareBlock = src.slice(floorPrepareStart, floorPrepareEnd);
    ok(
      'the floor-prepare warm-up block references no chunking at all — no flag, no chunked function',
      !/chunk/i.test(floorPrepareBlock)
    );
    ok(
      'the floor-prepare warm-up block contains no `await` — the ENTIRE point of the safety comment above it ' +
        '(no yield point can exist between the visible=true flip and its restore)',
      !/\bawait\b/.test(floorPrepareBlock)
    );

    // ---- Property: exactly one real invocation of the chunked path, and it lives at cold load ----
    const realInvocations = src.match(/await warmUpDrawStateChunked\(/g) || [];
    ok(
      'warmUpDrawStateChunked is actually CALLED exactly once in the whole file — proves the floor-switch site ' +
        '(asserted chunk-free just above) is not a second, differently-shaped call site',
      realInvocations.length === 1
    );

    // ---- Property: default (flag off) cold-load behaviour is unchanged ------
    const coldLoadStart = src.indexOf('if (_chunkedWarmUpEnabled) {');
    const coldLoadEnd = src.indexOf('loopActive = true;');
    ok(
      'both boundary anchors of the cold-load warm-up branch were found',
      coldLoadStart >= 0 && coldLoadEnd > coldLoadStart
    );
    const coldLoadBlock = src.slice(coldLoadStart, coldLoadEnd);
    ok(
      'the cold-load branch on the flag calls the chunked path when (and only when) the flag is on',
      coldLoadBlock.includes('await warmUpDrawStateChunked();')
    );
    ok(
      "the cold-load branch's OFF path is the exact original statement, unchanged — byte-for-byte the same " +
        'synchronous call as before this flag existed',
      /\}\s*else\s*\{\s*\n\s*warmUpDrawState\(\);\s*\n\s*\}/.test(coldLoadBlock)
    );
    ok(
      'the OFF path passes no options — the same bare `warmUpDrawState()` call as always (default includePresent:true)',
      /else\s*\{\s*\n\s*warmUpDrawState\(\);/.test(coldLoadBlock)
    );
  }

  // --- THE WARM-UP REPORT'S ADDRESS CONTRACT (mythica-machina-press#584) ---
  // A wrong-address read does not fail loudly — it fabricates a confident
  // wrong answer. `boot.js` read the warm-up fields from the ROOT of
  // `getVtPanViewerDiagnostics()`, but `buildViewerDiagnostics` nests every
  // one of them under `shaders:`. Every read returned `undefined`, which
  // `Number.isFinite` turned into `ran: false` on EVERY load — so the
  // loading-time report accused the warm-up of throwing on a healthy load,
  // and that false signal was acted on before it was caught.
  //
  // Runtime-testing this would mean mocking a renderer (this suite's sibling
  // header explains why that is not worth it). The defect is in the SHAPE, so
  // the source text is the honest place to pin it.
  {
    const diagSrc = readFileSync(DIAGNOSTICS_PATH, 'utf8');
    const bootSrc = readFileSync(BOOT_PATH, 'utf8');
    const shadersBlock = diagSrc.slice(diagSrc.indexOf('    shaders: {'));
    const FIELDS = ['warmUpMs', 'warmUpPipelinesCreated', 'warmUpSimPipelinesCreated', 'warmUpError', 'warmUpSimError'];
    for (const f of FIELDS) {
      ok(
        `diagnostics really publishes ${f} (a value passed in but never output reads as never measured)`,
        shadersBlock.includes(`      ${f},`)
      );
      ok(
        `boot reads ${f} from .shaders, not the root where it is silently undefined`,
        bootSrc.includes(`warmUpDiag?.shaders?.${f}`)
      );
    }
    ok(
      'no warm-up field is read from the diagnostics ROOT any more',
      !FIELDS.some((f) => bootSrc.includes(`warmUpDiag?.${f}`))
    );
    ok(
      'shaderCompileMs is read by its real published name (precompileMs), not its local one',
      bootSrc.includes('warmUpDiag?.shaders?.precompileMs') && !bootSrc.includes('warmUpDiag?.shaderCompileMs')
    );
  }

  // --- THE COMPRESSION SECTION'S ADDRESS CONTRACT (#586) -------------------
  // Same class of defect as #584, pinned BEFORE it can bite: boot reads the
  // compression health out of the diagnostics tree by path, and a wrong path
  // returns `undefined` silently rather than failing. The published key names
  // are asserted against the builder that actually emits them.
  {
    const diagSrc = readFileSync(DIAGNOSTICS_PATH, 'utf8');
    const bootSrc = readFileSync(BOOT_PATH, 'utf8');
    ok('diagnostics publishes the whole-image item array as `items`', diagSrc.includes('items: perItem,'));
    ok(
      'diagnostics publishes the compressed-worker stats under compressed.worker',
      diagSrc.includes('worker: getCompressedTextureStats()')
    );
    for (const path of [
      'warmUpDiag?.wholeImage?.compressed?.worker',
      'warmUpDiag?.wholeImage?.compressed?.applied',
      'warmUpDiag?.wholeImage?.estTextureVramMB',
      'warmUpDiag?.wholeImage?.items',
    ]) {
      ok(`boot reads compression health via ${path}`, bootSrc.includes(path));
    }
  }
}
