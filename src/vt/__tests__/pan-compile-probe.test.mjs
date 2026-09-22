/**
 * pan-compile-probe.test.mjs — mythica-machina-press#611.
 *
 * This probe exists to END a theory, either way. Four theories about the
 * freeze have already been wrong, so the thing that must be pinned hardest is
 * that it CANNOT produce a confident answer it has not earned: an unavailable
 * pipeline count must read as unavailable, never as "no compiles", and a first
 * sample must never attribute the session's startup compiles to whatever the
 * camera happened to be doing.
 */
import { createPanCompileProbe } from '../pan-compile-probe.js';

const rect = (x) => ({ minX: x, minY: 0, maxX: x + 100, maxY: 100 });

export function run(t) {
  const { ok } = t;

  // --- THE BASELINE CANNOT BE A DELTA -------------------------------------
  {
    const p = createPanCompileProbe();
    p.sample({ viewRect: rect(0), pipelineCount: 500, gapMs: 16 });
    const r = p.read();
    ok(
      'the first sample attributes nothing (it establishes the baseline)',
      r.compiledWhileMoving === 0 && r.compiledWhileStill === 0
    );
    ok('...but it IS counted as measured', r.measured === true);
  }

  // --- THE POSITIVE CASE: compiles while the camera moves -----------------
  {
    const p = createPanCompileProbe();
    p.sample({ viewRect: rect(0), pipelineCount: 500, gapMs: 16 });
    p.sample({ viewRect: rect(0), pipelineCount: 500, gapMs: 16 }); // still
    p.sample({ viewRect: rect(10), pipelineCount: 512, gapMs: 900 }); // panned, 12 new
    p.sample({ viewRect: rect(20), pipelineCount: 520, gapMs: 400 }); // panned, 8 more
    const r = p.read();
    ok('compiles during movement are attributed to movement', r.compiledWhileMoving === 20);
    ok('...and none are misattributed to stillness', r.compiledWhileStill === 0);
    ok('the verdict names the mechanism outright', /COMPILED ON PAN|COMPILING ON PAN|compiled on pan/i.test(r.verdict));
    ok('the worst gap while moving is kept', r.worstGapWhileMovingMs === 900);
    ok('individual bursts are kept, not just the sum', r.movingBursts.length === 2 && r.movingBursts[0].created === 12);
  }

  // --- THE NEGATIVE CASE MUST BE JUST AS CLEAR ----------------------------
  {
    const p = createPanCompileProbe();
    p.sample({ viewRect: rect(0), pipelineCount: 500 });
    p.sample({ viewRect: rect(10), pipelineCount: 500 });
    p.sample({ viewRect: rect(20), pipelineCount: 500 });
    const r = p.read();
    ok('panning with no new pipelines reports zero', r.compiledWhileMoving === 0);
    // Wording split when the stall branch was added: with no compiles AND no
    // stall, the honest statement is that there is nothing to explain here at
    // all — 'compilation is not the cause' would imply something needed a cause.
    ok('...and says there is nothing to explain in this window', /no compilation and no stall/i.test(r.verdict));
  }

  // --- COMPILES WHILE STILL MUST NOT READ AS A PAN FINDING -----------------
  {
    const p = createPanCompileProbe();
    p.sample({ viewRect: rect(0), pipelineCount: 500 });
    p.sample({ viewRect: rect(0), pipelineCount: 530 }); // still, 30 new
    const r = p.read();
    ok('compiles while still are attributed to stillness', r.compiledWhileStill === 30 && r.compiledWhileMoving === 0);
    ok('...and the verdict explicitly says panning is not the trigger', /not what triggers them/i.test(r.verdict));
  }

  // --- UNAVAILABLE IS NOT ZERO --------------------------------------------
  // The single most important property: a probe that cannot read the pipeline
  // cache must not report "no compiles happened", which would look exactly
  // like exonerating evidence.
  {
    const p = createPanCompileProbe();
    p.sample({ viewRect: rect(0), pipelineCount: null });
    p.sample({ viewRect: rect(10), pipelineCount: null });
    const r = p.read();
    ok('an unreadable pipeline count reports measured:false', r.measured === false);
    ok('...and the verdict refuses to exonerate anything', /NOT evidence either way/i.test(r.verdict));
  }

  // --- MOVEMENT IS ANY CHANGE, NOT A THRESHOLD ----------------------------
  {
    const p = createPanCompileProbe();
    p.sample({ viewRect: rect(0), pipelineCount: 100 });
    p.sample({ viewRect: { minX: 0, minY: 0, maxX: 100, maxY: 100.0001 }, pipelineCount: 101 });
    ok('a sub-pixel change still counts as moving (it can still reveal a mesh)', p.read().compiledWhileMoving === 1);
  }

  // --- RESET KEEPS THE DEVICE-WIDE BASELINE -------------------------------
  {
    const p = createPanCompileProbe();
    p.sample({ viewRect: rect(0), pipelineCount: 500 });
    p.sample({ viewRect: rect(10), pipelineCount: 505 });
    p.reset();
    const r0 = p.read();
    ok('reset clears the window', r0.compiledWhileMoving === 0 && r0.movingFrames === 0);
    // The very next sample after a reset must still be able to see a compile —
    // re-establishing a baseline here would blind it to exactly the pan the
    // reset was called to measure.
    p.sample({ viewRect: rect(20), pipelineCount: 510 });
    ok('the first sample after reset still sees a compile (baseline survives)', p.read().compiledWhileMoving === 5);
  }

  // --- THE UNPAUSE CASE: a stall with NO compilation ----------------------
  // Unpausing happens with the camera still, so its hitch lands in
  // `worstGapWhileStillMs`. The probe must distinguish "stalled but compiled
  // nothing" (main-thread or GPU work) from "nothing happened at all" —
  // otherwise it answers the pan question and is silent on the unpause one.
  {
    const p = createPanCompileProbe();
    p.sample({ viewRect: rect(0), pipelineCount: 900, gapMs: 16 });
    p.sample({ viewRect: rect(0), pipelineCount: 900, gapMs: 1800 }); // still; big stall, no compiles
    const r = p.read();
    ok('a stall with zero compiles is reported as a stall', /A STALL HAPPENED/.test(r.verdict));
    ok('...and explicitly exonerates shader compilation', /NOT shader compilation/.test(r.verdict));
    ok('...and says how to tell main-thread from GPU apart', /per-thread/i.test(r.verdict));
    ok('worstGapMs surfaces it without knowing which bucket to look in', r.worstGapMs === 1800);
  }
  {
    // A quiet window must NOT be dressed up as a stall.
    const p = createPanCompileProbe();
    p.sample({ viewRect: rect(0), pipelineCount: 900, gapMs: 16 });
    p.sample({ viewRect: rect(0), pipelineCount: 900, gapMs: 17 });
    const r = p.read();
    ok('a quiet window says so plainly', /no frame gap crossed the stall threshold/i.test(r.verdict));
    ok('...and reports a small worst gap', r.worstGapMs === 17);
  }
  {
    // A stall that DID compile keeps the compilation verdict — the stall note
    // must not swallow the finding it exists alongside.
    const p = createPanCompileProbe();
    p.sample({ viewRect: rect(0), pipelineCount: 900, gapMs: 16 });
    p.sample({ viewRect: rect(10), pipelineCount: 930, gapMs: 2000 });
    ok('compiles still win the verdict when both happened', /COMPILED ON PAN/i.test(p.read().verdict));
  }
}
