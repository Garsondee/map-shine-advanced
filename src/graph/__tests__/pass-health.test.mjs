/**
 * Derived health — proving the claim that "every declaration is a free health
 * check". The point of each case: V2 needed 2,261 hand-maintained lines and a
 * comment-MUST on ten effects to ask these questions, and could not ask some of
 * them at all.
 */
import { evaluatePassHealth, breakerCircuits } from '../pass-health.js';

/** A fake frame: a set of resource ids that exist right now. */
const frameOf = (...ids) => ({ has: (id) => ids.includes(id) });

const pass = (over) => ({
  id: 'p',
  stage: 'frame',
  kind: 'gpu',
  status: 'live',
  owns: 'doc',
  creates: [],
  reads: [],
  modifies: [],
  absorbs: ['x'],
  note: 'test fixture pass — long enough to satisfy the declaration rules here.',
  ...over,
});

export function run(t) {
  // ---- a live pass that delivered ------------------------------------------
  {
    const p = [pass({ id: 'geometry.world', creates: ['buf:scene.color'] })];
    const r = evaluatePassHealth(frameOf('buf:scene.color'), p);
    t.ok('a live pass producing its declared output is healthy', r.ok);
    t.ok("...and reports it 'live'", r.findings[0].status === 'live');
  }

  // ---- a live pass that did NOT deliver -- the real failure -----------------
  {
    const p = [pass({ id: 'geometry.world', creates: ['buf:scene.color'] })];
    const r = evaluatePassHealth(frameOf(), p);
    t.ok('a LIVE pass missing its declared output is an ERROR', !r.ok);
    t.ok('...status MISSING', r.findings[0].status === 'MISSING');
    t.ok(
      '...and the message names the pass and the resource',
      /geometry\.world.*buf:scene\.color/.test(r.findings[0].message)
    );
  }

  // ---- UNBUILT is not BROKEN -- the distinction V2 could not draw -----------
  {
    const p = [
      pass({ id: 'light.accumulate', status: 'seam', creates: ['buf:scene.illum'], owns: 'Light-and-Shadow.md' }),
    ];
    const r = evaluatePassHealth(frameOf(), p);
    t.ok('a SEAM pass with no output is NOT an error (unbuilt != broken)', r.ok);
    t.ok("...status 'unbuilt'", r.findings[0].status === 'unbuilt');
    t.ok(
      '...and it points at the design doc rather than crying wolf',
      /Light-and-Shadow\.md/.test(r.findings[0].message)
    );
    // In V2 an unwired effect and a failed one looked identical in the Breaker
    // Box, which is precisely why a red light was hard to trust.
  }

  // ---- STARVED: a declared read nothing produced ----------------------------
  {
    const p = [pass({ id: 'surface.water', reads: ['buf:scene.illum'] })];
    const r = evaluatePassHealth(frameOf(), p);
    t.ok('a live pass whose declared READ is absent is an ERROR', !r.ok);
    t.ok('...status STARVED', r.findings[0].status === 'STARVED');
    // THE POINT: V2 could not ask this question. `reads` was never declared, so
    // the health service hand-wrote addEdge('WaterEffectV2','WindowLightEffectV2')
    // to guess at the same fact -- a parallel graph that drifted.
    t.ok('...naming the missing pipe', /buf:scene\.illum/.test(r.findings[0].message));
  }
  {
    const p = [pass({ id: 'surface.water', status: 'seam', reads: ['buf:scene.illum'] })];
    t.ok("a SEAM pass's absent read is informational, not an error", evaluatePassHealth(frameOf(), p).ok);
  }

  // ---- modifies is checked like reads (you cannot modify what does not exist)
  {
    const p = [pass({ id: 'surface.response', modifies: ['buf:scene.color'] })];
    t.ok('a declared MODIFY of an absent resource is an error', !evaluatePassHealth(frameOf(), p).ok);
  }

  // ---- the whole pipeline, end to end --------------------------------------
  {
    const p = [
      pass({ id: 'frame.snapshot', creates: ['res:env'] }),
      pass({ id: 'geometry.world', creates: ['buf:scene.color'], reads: ['res:env'] }),
      pass({ id: 'post.grade', creates: ['buf:final'], reads: ['buf:scene.color'] }),
    ];
    t.ok(
      'a fully-delivered chain is healthy',
      evaluatePassHealth(frameOf('res:env', 'buf:scene.color', 'buf:final'), p).ok
    );

    // Break the FIRST link: everything downstream is starved, and health says so
    // per-pass without any hand-written dependency edges.
    const broken = evaluatePassHealth(frameOf('buf:scene.color', 'buf:final'), p);
    t.ok('breaking the first link is caught', !broken.ok);
    t.ok(
      '...and the STARVED consumer is named too (the graph is derived, not hand-drawn)',
      broken.findings.some((f) => f.passId === 'geometry.world' && f.status === 'STARVED')
    );
  }

  // ---- the Breaker Box circuits, derived -----------------------------------
  {
    const p = [
      pass({ id: 'vt.residency', creates: ['vt:albedo'] }),
      pass({ id: 'geometry.world', creates: ['buf:scene.color'] }),
    ];
    const circuits = breakerCircuits(frameOf('vt:albedo'), p);
    t.ok('one circuit per pass, derived from the pass list', circuits.length === 2);
    t.ok('the delivering circuit is ok', circuits.find((c) => c.id === 'vt.residency').severity === 'ok');
    t.ok('the failing circuit is error', circuits.find((c) => c.id === 'geometry.world').severity === 'error');
    // V2 hand-wrote SOURCE_DEFS in the UI and bound rules by KEYWORD STRING
    // (keywords: ['composeMaterial']) -- rename a private field and the panel
    // silently showed the wrong circuit. Here the id IS the pass id.
  }
  {
    // Worst-status-wins: a pass that delivered one output and missed another is
    // not "ok" just because a green finding came first.
    const p = [pass({ id: 'x', creates: ['buf:a', 'buf:b'] })];
    const circuits = breakerCircuits(frameOf('buf:a'), p);
    t.ok('a partly-failing circuit reports its WORST status', circuits[0].severity === 'error');
  }

  // ---- the meta-assertion: no model, no drift ------------------------------
  {
    const src = String(evaluatePassHealth);
    t.ok('health hardcodes NO effect names (V2 hardcoded 17)', !/EffectV2/.test(src));
    t.ok('health reads NO private fields (V2 checked instance._composeMaterial)', !/\._[a-z]/i.test(src));
    t.ok('health hand-writes NO dependency edges (V2 called addEdge)', !/addEdge/.test(src));
  }
}
