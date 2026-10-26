/**
 * Node verification for foundry/scene-switch-gate.js — prepare, then let Foundry
 * draw (loading audit, 2026-10-25).
 *
 * What this suite defends is the gate's CONTRACT, because the failure modes of a
 * wrapper around `Scene#view` are all of the same kind — the table is left unable
 * to switch: it must classify exactly as Foundry does, run prepare to completion
 * BEFORE the real view, fail open on any error, never swallow what Foundry would
 * itself refuse, and let the last request win.
 */
import { classifyViewRequest, createViewGate, installSceneSwitchGate } from '../scene-switch-gate.js';

const idle = (over = {}) => ({
  currentSceneId: 's1',
  currentLevelId: 'L0',
  hasCurrentScene: true,
  canvasInitialized: true,
  canvasLoading: false,
  ...over,
});

/** A prepare whose completion the test controls. */
function controlled() {
  const calls = [];
  const waiters = [];
  const prepare = (request, control) => {
    calls.push({ request, control });
    return new Promise((resolve) => waiters.push(resolve));
  };
  return { prepare, calls, finish: (i, outcome = { ok: true }) => waiters[i](outcome) };
}

const tick = async (n = 4) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

export async function run(t) {
  const { ok } = t;

  // ── classifyViewRequest: exactly Foundry's own test (scene.mjs:262-273) ───────
  ok(
    'a level change in the same scene is "level"',
    classifyViewRequest(idle(), { sceneId: 's1', levelId: 'L1' }).kind === 'level'
  );
  ok('a different scene is "scene"', classifyViewRequest(idle(), { sceneId: 's2' }).kind === 'scene');
  ok(
    'a different scene AND level is "scene"',
    classifyViewRequest(idle(), { sceneId: 's2', levelId: 'L3' }).kind === 'scene'
  );
  ok(
    'the same scene with no level given is "none" (a collection re-render)',
    classifyViewRequest(idle(), { sceneId: 's1' }).kind === 'none'
  );
  ok(
    'the same scene and the SAME level is "none"',
    classifyViewRequest(idle(), { sceneId: 's1', levelId: 'L0' }).kind === 'none'
  );
  ok(
    'Foundry is mid-draw => "blocked": it will refuse the view itself, so the gate must not interfere',
    classifyViewRequest(idle({ canvasLoading: true }), { sceneId: 's2' }).kind === 'blocked'
  );
  ok(
    'canvas not initialised => "none": view() will not draw at all',
    classifyViewRequest(idle({ canvasInitialized: false }), { sceneId: 's2' }).kind === 'none'
  );
  const cold = classifyViewRequest(idle({ hasCurrentScene: false, currentSceneId: null, currentLevelId: null }), {
    sceneId: 's1',
  });
  ok(
    'nothing drawn yet => "cold" (the very first draw, or after a blank canvas)',
    cold.kind === 'cold' && cold.sceneId === 's1'
  );
  ok('the request carries the level, or null', classifyViewRequest(idle(), { sceneId: 's2' }).levelId === null);

  // ── run: prepare completes BEFORE the real view ───────────────────────────────
  {
    const order = [];
    const c = controlled();
    const gate = createViewGate({ prepare: c.prepare, isEnabled: () => true, readState: () => idle() });
    const scene = { id: 's1' };
    const p = gate.run(scene, { level: 'L1' }, async (s, o) => {
      order.push('view');
      return { viewed: o.level };
    });
    await tick();
    ok(
      'prepare is called, and the real view has NOT run while it is pending',
      c.calls.length === 1 && order.length === 0
    );
    ok(
      '…with the classified request and the scene',
      c.calls[0].request.kind === 'level' && c.calls[0].request.scene === scene && c.calls[0].request.levelId === 'L1'
    );
    c.finish(0);
    const result = await p;
    ok(
      'when prepare finishes, the real view runs with the ORIGINAL options',
      order.join() === 'view' && result.viewed === 'L1'
    );
    ok('stats count one gated switch', gate.getStatus().gated === 1 && gate.getStatus().inflight === null);
  }

  // ── the floor-change timeline hears the gate, in order ─────────────────────────
  {
    const events = [];
    const c = controlled();
    const gate = createViewGate({
      prepare: c.prepare,
      isEnabled: () => true,
      readState: () => idle(),
      onEvent: (e, d) => events.push(d?.outcome ? e + ':' + d.outcome : e),
    });
    const p = gate.run({ id: 's1' }, { level: 'L1' }, async () => 'viewed');
    await tick();
    c.finish(0);
    await p;
    ok(
      'events: request, prepare-start, prepare-end:ok, view-called',
      events.join() === 'request,prepare-start,prepare-end:ok,view-called'
    );
    const throwing = createViewGate({
      prepare: c.prepare,
      isEnabled: () => true,
      readState: () => idle(),
      onEvent: () => {
        throw new Error('observer broke');
      },
    });
    const q = throwing.run({ id: 's1' }, { level: 'L2' }, async () => 'still viewed');
    await tick();
    c.finish(1);
    ok('a throwing observer never stops the switch', (await q) === 'still viewed');
  }

  // ── disabled / changeless: untouched ──────────────────────────────────────────
  {
    const c = controlled();
    let viewed = 0;
    const off = createViewGate({ prepare: c.prepare, isEnabled: () => false, readState: () => idle() });
    await off.run({ id: 's2' }, {}, async () => viewed++);
    ok('the world setting OFF => straight through, prepare never called', viewed === 1 && c.calls.length === 0);

    const on = createViewGate({ prepare: c.prepare, isEnabled: () => true, readState: () => idle() });
    await on.run({ id: 's1' }, {}, async () => viewed++);
    ok('a changeless view is straight through', viewed === 2 && c.calls.length === 0);
    const blocked = createViewGate({
      prepare: c.prepare,
      isEnabled: () => true,
      readState: () => idle({ canvasLoading: true }),
    });
    await blocked.run({ id: 's2' }, {}, async () => viewed++);
    ok('a view Foundry will refuse is passed through for Foundry to refuse', viewed === 3 && c.calls.length === 0);
  }

  // ── FAIL OPEN ─────────────────────────────────────────────────────────────────
  {
    let viewed = 0;
    const boom = createViewGate({
      prepare: async () => {
        throw new Error('prepare exploded');
      },
      isEnabled: () => true,
      readState: () => idle(),
    });
    await boom.run({ id: 's2' }, {}, async () => viewed++);
    ok('a prepare that THROWS does not stop the switch', viewed === 1 && boom.getStatus().failedOpen === 1);

    const badState = createViewGate({
      prepare: async () => ({ ok: true }),
      isEnabled: () => true,
      readState: () => {
        throw new Error('canvas getter threw');
      },
    });
    await badState.run({ id: 's2' }, {}, async () => viewed++);
    ok(
      'a state read that throws does not stop the switch either',
      viewed === 2 && badState.getStatus().failedOpen === 1
    );

    const notOk = createViewGate({
      prepare: async () => ({ ok: false, reason: 'nothing to prepare' }),
      isEnabled: () => true,
      readState: () => idle(),
    });
    await notOk.run({ id: 's2' }, {}, async () => viewed++);
    ok('a prepare that reports ok:false still lets the switch go (only "cancelled" stops it)', viewed === 3);

    const undef = createViewGate({ prepare: async () => undefined, isEnabled: () => true, readState: () => idle() });
    await undef.run({ id: 's2' }, {}, async () => viewed++);
    ok('a prepare that returns nothing lets the switch go', viewed === 4);
  }

  // ── CANCEL: the user stays where they are ─────────────────────────────────────
  {
    let viewed = 0;
    const g = createViewGate({
      prepare: async () => ({ cancelled: true }),
      isEnabled: () => true,
      readState: () => idle(),
    });
    const scene = { id: 's2' };
    const r = await g.run(scene, {}, async () => viewed++);
    ok('cancelled => the real view never runs', viewed === 0 && r === scene && g.getStatus().cancelled === 1);
  }

  // ── LAST REQUEST WINS; an identical one is joined ─────────────────────────────
  {
    const c = controlled();
    const viewedWith = [];
    const gate = createViewGate({ prepare: c.prepare, isEnabled: () => true, readState: () => idle() });
    const first = gate.run({ id: 's1' }, { level: 'L1' }, async (s, o) => viewedWith.push(o.level));
    await tick();
    const joined = gate.run({ id: 's1' }, { level: 'L1' }, async (s, o) => viewedWith.push(`dup-${o.level}`));
    await tick();
    ok(
      'an identical request while one is preparing is JOINED, not prepared twice',
      c.calls.length === 1 && gate.getStatus().joined === 1
    );
    const second = gate.run({ id: 's1' }, { level: 'L2' }, async (s, o) => viewedWith.push(o.level));
    await tick();
    ok('a different request starts its own prepare', c.calls.length === 2);
    ok(
      '…and marks the first as cancelled for its own prepare to see',
      c.calls[0].control.isCancelled() === true && c.calls[1].control.isCancelled() === false
    );
    c.finish(0);
    c.finish(1);
    await Promise.all([first, joined, second]);
    ok('only the NEWEST request is viewed; the superseded one resolves without drawing', viewedWith.join() === 'L2');
    ok('stats count the supersede', gate.getStatus().superseded === 1);
  }

  // ── installSceneSwitchGate: wraps once, never double, fails soft ──────────────
  {
    ok(
      'no Scene class => not installed, with a reason (Foundry will draw immediately)',
      installSceneSwitchGate({ prepare: async () => ({}), isEnabled: () => true, getSceneClass: () => null })
        .installed === false
    );
    ok(
      'a class with no view() => not installed',
      installSceneSwitchGate({ prepare: async () => ({}), isEnabled: () => true, getSceneClass: () => class {} })
        .installed === false
    );

    const calls = [];
    class FakeScene {
      constructor(id) {
        this.id = id;
      }
      async view(options = {}) {
        calls.push(['view', this.id, options.level ?? null]);
        return this;
      }
    }
    let prepared = 0;
    const r1 = installSceneSwitchGate({
      prepare: async () => {
        prepared++;
        return { ok: true };
      },
      isEnabled: () => true,
      readState: () => idle(),
      getSceneClass: () => FakeScene,
    });
    ok('installs on a class with view()', r1.installed === true && typeof r1.gate?.getStatus === 'function');
    const r2 = installSceneSwitchGate({
      prepare: async () => ({}),
      isEnabled: () => true,
      readState: () => idle(),
      getSceneClass: () => FakeScene,
    });
    ok('a second install does not wrap again', r2.installed === true && r2.reason === 'already installed');

    const s = new FakeScene('s2');
    const out = await s.view({ level: 'L9' });
    ok(
      'the wrapped view prepares first, then calls the ORIGINAL on the same document',
      prepared === 1 && calls.length === 1 && calls[0][1] === 's2' && out === s
    );
    ok('…once, not twice', calls.length === 1);
  }
}
