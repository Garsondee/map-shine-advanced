/**
 * Node verification for FrameGraph.js. Run via ../run-tests.mjs (esbuild bundle
 * → node). Pure-logic coverage: ordering, cycles, read-before-write, gating,
 * allocator lifecycle, timing. No THREE, no browser.
 */
import { FrameGraph } from '../FrameGraph.js';

export function run(t) {
  const { ok, throws } = t;

  function fakeAllocator() {
    const log = [];
    return {
      log,
      create: (name, desc) => { log.push(['create', name, desc.resolvedW, desc.resolvedH, desc.mrtCount]); return { name, w: desc.resolvedW, h: desc.resolvedH }; },
      resize: (h, w, hh) => { log.push(['resize', h.name, w, hh]); h.w = w; h.h = hh; },
      dispose: (h) => { log.push(['dispose', h.name]); },
    };
  }

  // 1. Linear pipeline: order == registration when authored in order.
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.declareResource('albedo', { size: 'screen', mrtCount: 2 });
    g.declareResource('hdr', { size: 'screen' });
    g.declareResource('graded', { size: 'screen' });
    g.importResource('masks', { fake: true });
    const ran = [];
    g.addPass({ name: 'geometry', reads: ['masks'], writes: ['albedo'], execute: (c) => { ran.push('geometry'); c.target('albedo'); c.get('masks'); } });
    g.addPass({ name: 'lighting', reads: ['albedo'], writes: ['hdr'], execute: (c) => { ran.push('lighting'); c.get('albedo'); c.target('hdr'); } });
    g.addPass({ name: 'grade', reads: ['hdr'], writes: ['graded'], execute: (c) => { ran.push('grade'); c.get('hdr'); c.target('graded'); } });
    ok('linear order', JSON.stringify(g.getExecutionOrder()) === JSON.stringify(['geometry', 'lighting', 'grade']));
    const res = g.execute({ width: 1920, height: 1080 });
    ok('linear ran all', JSON.stringify(res.order) === JSON.stringify(['geometry', 'lighting', 'grade']));
    ok('execute body order matches', JSON.stringify(ran) === JSON.stringify(['geometry', 'lighting', 'grade']));
  }

  // 2. Derived reorder: registration out of order, deps fix it.
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.declareResource('a', { size: 'screen' });
    g.declareResource('b', { size: 'screen' });
    g.addPass({ name: 'consumer', reads: ['a'], writes: ['b'], execute: (c) => { c.get('a'); c.target('b'); } });
    g.addPass({ name: 'producer', writes: ['a'], execute: (c) => { c.target('a'); } });
    ok('derived reorder puts producer first', JSON.stringify(g.getExecutionOrder()) === JSON.stringify(['producer', 'consumer']));
  }

  // 3. Stable tie-break.
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.declareResource('x', { size: 'screen' }); g.declareResource('y', { size: 'screen' }); g.declareResource('z', { size: 'screen' });
    g.addPass({ name: 'p1', writes: ['x'], execute: (c) => c.target('x') });
    g.addPass({ name: 'p2', writes: ['y'], execute: (c) => c.target('y') });
    g.addPass({ name: 'p3', writes: ['z'], execute: (c) => c.target('z') });
    ok('independent passes keep reg order', JSON.stringify(g.getExecutionOrder()) === JSON.stringify(['p1', 'p2', 'p3']));
  }

  // 4. Cycle.
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.declareResource('r1', { size: 'screen' }); g.declareResource('r2', { size: 'screen' });
    g.addPass({ name: 'A', reads: ['r2'], writes: ['r1'], execute: () => {} });
    g.addPass({ name: 'B', reads: ['r1'], writes: ['r2'], execute: () => {} });
    throws('cycle throws', () => g.compile(), 'cycle');
  }

  // 5. Read-before-write / missing producer.
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.declareResource('out', { size: 'screen' });
    g.addPass({ name: 'reader', reads: ['ghost'], writes: ['out'], execute: () => {} });
    throws('unproduced read throws', () => g.compile(), 'nothing writes or imports');
  }

  // 6. Feedback-loop guard.
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.declareResource('rt', { size: 'screen' });
    throws('feedback loop throws', () => g.addPass({ name: 'bad', reads: ['rt'], writes: ['rt'], execute: () => {} }), 'feedback loop');
  }

  // 7. Write to imported.
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.importResource('foundryTex', {});
    g.addPass({ name: 'w', writes: ['foundryTex'], execute: () => {} });
    throws('write-to-import throws', () => g.compile(), 'imported');
  }

  // 8. Write to undeclared.
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.addPass({ name: 'w', writes: ['nope'], execute: () => {} });
    throws('write-to-undeclared throws', () => g.compile(), 'undeclared');
  }

  // 9. when() gating.
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.declareResource('a', { size: 'screen' }); g.declareResource('b', { size: 'screen' });
    let on = false;
    g.addPass({ name: 'geo', writes: ['a'], execute: (c) => c.target('a') });
    g.addPass({ name: 'light', reads: ['a'], writes: ['b'], when: () => on, execute: (c) => { c.get('a'); c.target('b'); } });
    let res = g.execute({ width: 100, height: 100 });
    ok('gated pass skipped', res.skipped.includes('light') && !res.order.includes('light'));
    on = true;
    res = g.execute({ width: 100, height: 100 });
    ok('gated pass runs when enabled', res.order.includes('light'));
  }

  // 10. Illegal get() throws through execute (no logWarn → rethrow).
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.declareResource('a', { size: 'screen' });
    g.addPass({ name: 'r', writes: ['a'], execute: (c) => { c.get('nonsense'); } });
    let threw = false;
    try { g.execute({ width: 10, height: 10 }); } catch (_) { threw = true; }
    ok('illegal get throws through execute', threw);
  }

  // 11. Allocator create/resize/scale.
  {
    const alloc = fakeAllocator();
    const g = new FrameGraph({ allocator: alloc });
    g.declareResource('full', { size: 'screen' });
    g.declareResource('half', { size: 'screen', scale: 0.5 });
    g.declareResource('fixed', { size: [256, 256] });
    g.addPass({ name: 'p', writes: ['full', 'half', 'fixed'], execute: (c) => { c.target('full'); c.target('half'); c.target('fixed'); } });
    g.execute({ width: 1000, height: 800 });
    const creates = alloc.log.filter((e) => e[0] === 'create');
    ok('created 3 targets', creates.length === 3);
    ok('full = frame size', creates.find((e) => e[1] === 'full')[2] === 1000);
    ok('half = 0.5 scale', creates.find((e) => e[1] === 'half')[2] === 500);
    ok('fixed = literal', creates.find((e) => e[1] === 'fixed')[2] === 256);
    const before = alloc.log.length;
    g.execute({ width: 1000, height: 800 });
    ok('no realloc on same size', alloc.log.length === before);
    g.execute({ width: 1200, height: 900 });
    const resizes = alloc.log.filter((e) => e[0] === 'resize');
    ok('full resized', resizes.some((e) => e[1] === 'full' && e[2] === 1200));
    ok('fixed not resized', !resizes.some((e) => e[1] === 'fixed'));
  }

  // 12. Timing.
  {
    let t = 0;
    const g = new FrameGraph({ allocator: fakeAllocator(), now: () => (t += 5) });
    g.declareResource('a', { size: 'screen' });
    g.addPass({ name: 'timed', writes: ['a'], execute: (c) => c.target('a') });
    g.execute({ width: 10, height: 10 });
    ok('timing captured', g.getLastTimings().get('timed') === 5);
  }

  // 13. Diamond.
  {
    const g = new FrameGraph({ allocator: fakeAllocator() });
    g.declareResource('base', { size: 'screen' }); g.declareResource('l', { size: 'screen' });
    g.declareResource('r', { size: 'screen' }); g.declareResource('merge', { size: 'screen' });
    g.addPass({ name: 'base', writes: ['base'], execute: (c) => c.target('base') });
    g.addPass({ name: 'left', reads: ['base'], writes: ['l'], execute: (c) => { c.get('base'); c.target('l'); } });
    g.addPass({ name: 'right', reads: ['base'], writes: ['r'], execute: (c) => { c.get('base'); c.target('r'); } });
    g.addPass({ name: 'merge', reads: ['l', 'r'], writes: ['merge'], execute: (c) => { c.get('l'); c.get('r'); c.target('merge'); } });
    const order = g.getExecutionOrder();
    ok('diamond: base first', order.indexOf('base') === 0);
    ok('diamond: merge last', order.indexOf('merge') === 3);
    ok('diamond: branches between',
       order.indexOf('left') > 0 && order.indexOf('right') > 0 && order.indexOf('left') < 3 && order.indexOf('right') < 3);
  }
}
