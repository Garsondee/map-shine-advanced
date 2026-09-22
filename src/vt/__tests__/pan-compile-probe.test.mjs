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
    ok('...and says compilation is NOT the cause', /NOT the cause/i.test(r.verdict));
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
}
