/**
 * Node verification for effects/debug-channel-select.js.
 *
 * TSL node construction is GPU/browser-only (CONVENTIONS.md §4), so this
 * verifies the SHAPE of the graph that gets built, not shader output. A mock
 * TSL records every call as a plain marker object, which is enough to assert
 * the one property that actually matters here and could not be asserted before:
 *
 *   ⚠️ THE SELECTOR MUST BUILD NO CONDITIONAL NODE AT ALL.
 *
 * A `select()`-based fold compiles to real WGSL branches, and a `.toVar()` in
 * the shared subgraph is then ASSIGNED in whichever branch the graph walk
 * reaches first and READ AS ZERO in every other one. That defect made 12 of
 * specular's 20 debug channels structurally incapable of showing anything but
 * black — including the exact channel three separate live rounds used to
 * diagnose the effect. The real proof is the dumped WGSL (that module's own
 * header, and `tools/shader-lab/bench-specular.js#dumpShader`); this test is
 * the cheap guard that stops it coming back.
 */
import { buildDebugChannelColor, pickEquals } from '../debug-channel-select.js';

/** Every mock node carries the ops used to build it, so a test can assert what
 * a graph does NOT contain as easily as what it does. */
function node(kind, parts = []) {
  const self = {
    __kind: kind,
    __parts: parts,
    add: (o) => node('add', [self, o]),
    sub: (o) => node('sub', [self, o]),
    mul: (o) => node('mul', [self, o]),
    // Present on purpose: if the selector ever reaches for control flow again,
    // it is available and the assertions below will catch the call.
    select: (a, b) => node('select', [self, a, b]),
    lessThan: (o) => node('lessThan', [self, o]),
    greaterThan: (o) => node('greaterThan', [self, o]),
  };
  return self;
}

function makeTSL() {
  return {
    float: (v) => node('float', [v]),
    vec3: (...args) => node('vec3', args),
    step: (a, b) => node('step', [a, b]),
    abs: (a) => node('abs', [a]),
  };
}

/** Walk the whole graph, collecting every node kind that appears in it. */
function kindsIn(root, seen = new Set()) {
  if (!root || typeof root !== 'object' || !root.__kind) return seen;
  seen.add(root.__kind);
  for (const p of root.__parts ?? []) kindsIn(p, seen);
  return seen;
}

const CHANNELS = [
  { n: 0, id: 'off' },
  { n: 1, id: 'alpha' },
  { n: 2, id: 'beta' },
  { n: 3, id: 'gamma' },
];

export function run(t) {
  const { ok, throws } = t;
  const TSL = makeTSL();

  // pickEquals — the 0/1 window, built from step() alone.
  {
    const u = node('uniform');
    const p = pickEquals(TSL, u, 7);
    const kinds = kindsIn(p);
    ok('pickEquals uses step()', kinds.has('step'));
    ok('pickEquals uses abs() on the difference', kinds.has('abs') && kinds.has('sub'));
    ok('pickEquals builds NO conditional', !kinds.has('select') && !kinds.has('lessThan'));
  }

  // The fold itself.
  {
    const uDebugChannel = node('uniform');
    const nodes = { alpha: node('vec3'), beta: node('vec3'), gamma: node('vec3') };
    const out = buildDebugChannelColor(TSL, { channels: CHANNELS, nodes, uDebugChannel, label: 'test' });
    const kinds = kindsIn(out);

    // ⚠️ THE ASSERTION THIS FILE EXISTS FOR.
    ok('the selector builds NO select()/conditional node anywhere', !kinds.has('select'));
    ok('…and no comparison node either (those are what produced the branches)', !kinds.has('lessThan'));
    ok('selection is arithmetic — add + mul + step', kinds.has('add') && kinds.has('mul') && kinds.has('step'));

    // Every channel must actually be REACHABLE from the result. Under the old
    // fold a channel could be present in the graph and still render black; here
    // "present in the graph" is the whole contract, because there is no branch
    // that can skip it.
    const reachable = new Set();
    const walk = (r) => {
      if (!r || typeof r !== 'object') return;
      reachable.add(r);
      for (const p of r.__parts ?? []) walk(p);
    };
    walk(out);
    ok('channel alpha is reachable from the result', reachable.has(nodes.alpha));
    ok('channel beta is reachable from the result', reachable.has(nodes.beta));
    ok('channel gamma is reachable from the result', reachable.has(nodes.gamma));
  }

  // Channel 0 is "off" and must never be folded in — the caller detaches the
  // debug material entirely rather than rendering a black one.
  {
    const uDebugChannel = node('uniform');
    const nodes = { alpha: node('vec3'), beta: node('vec3'), gamma: node('vec3') };
    ok(
      'channel 0 needs no node in the table (it is skipped, not looked up)',
      !!buildDebugChannelColor(TSL, { channels: CHANNELS, nodes, uDebugChannel, label: 'test' })
    );
  }

  // Loud at BUILD time — a channel that quietly shows the one below it is the
  // failure this whole module is about (`feedback_instruments_must_not_lie`).
  {
    const uDebugChannel = node('uniform');
    throws(
      'a channel with no node throws, naming the effect, the id AND the number',
      () =>
        buildDebugChannelColor(TSL, {
          channels: CHANNELS,
          nodes: { alpha: node('vec3') },
          uDebugChannel,
          label: 'myEffect',
        }),
      "myEffect debug channel 'beta' (n=2)"
    );
  }
}
