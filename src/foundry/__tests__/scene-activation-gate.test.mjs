/**
 * Node verification for foundry/scene-activation-gate.js — a GM activating a
 * scene waits for the table to be ready (loading audit, 2026-10-25).
 *
 * Defended: the gate only ever DELAYS an activation — it fails open on any error,
 * leaves a changeless or non-GM call alone, joins a double click instead of
 * waiting twice, and the one thing that stops an activation is the GM cancelling.
 */
import { classifyActivation, createActivationGate, installSceneActivationGate } from '../scene-activation-gate.js';

const on = { enabled: true, isGM: true, sceneActive: false };

export async function run(t) {
  const { ok } = t;

  ok('a GM activating an inactive scene is coordinated', classifyActivation(on).coordinate === true);
  ok('the setting off => not coordinated', classifyActivation({ ...on, enabled: false }).coordinate === false);
  ok('a non-GM client never coordinates', classifyActivation({ ...on, isGM: false }).coordinate === false);
  ok(
    'an already-active scene is a changeless call',
    classifyActivation({ ...on, sceneActive: true }).coordinate === false
  );
  ok(
    'every verdict explains itself',
    ['enabled', 'isGM', 'sceneActive'].every(
      (k) => typeof classifyActivation({ ...on, [k]: k === 'sceneActive' }).reason === 'string'
    )
  );

  // ── coordinate runs BEFORE the real activate ─────────────────────────────────
  {
    const order = [];
    let release;
    const gate = createActivationGate({
      coordinate: () =>
        new Promise((resolve) => {
          order.push('coordinate');
          release = () => resolve({});
        }),
      isEnabled: () => true,
      isGM: () => true,
    });
    const scene = { id: 's2', active: false };
    const p = gate.run(scene, { pullUsers: true }, async (s, o) => {
      order.push(`activate:${o.pullUsers}`);
      return s;
    });
    await Promise.resolve();
    ok('while the table is preparing, the real activate has NOT run', order.join() === 'coordinate');
    release();
    await p;
    ok(
      'when coordination ends, the real activate runs with the ORIGINAL options',
      order.join() === 'coordinate,activate:true'
    );
  }

  // ── cancel is the only thing that stops it ───────────────────────────────────
  {
    let activated = 0;
    const gate = createActivationGate({
      coordinate: async () => ({ cancelled: true }),
      isEnabled: () => true,
      isGM: () => true,
    });
    const scene = { id: 's2', active: false };
    const r = await gate.run(scene, {}, async () => activated++);
    ok(
      'the GM cancelling => the scene is NOT activated',
      activated === 0 && r === scene && gate.getStatus().cancelled === 1
    );
  }

  // ── fail open ────────────────────────────────────────────────────────────────
  {
    let activated = 0;
    const boom = createActivationGate({
      coordinate: async () => {
        throw new Error('socket exploded');
      },
      isEnabled: () => true,
      isGM: () => true,
    });
    await boom.run({ id: 's', active: false }, {}, async () => activated++);
    ok('a coordinate that throws still activates', activated === 1 && boom.getStatus().failedOpen === 1);

    const badSetting = createActivationGate({
      coordinate: async () => ({}),
      isEnabled: () => {
        throw new Error('settings not ready');
      },
      isGM: () => true,
    });
    await badSetting.run({ id: 's', active: false }, {}, async () => activated++);
    ok('a setting that cannot be read still activates', activated === 2 && badSetting.getStatus().failedOpen === 1);

    const quiet = createActivationGate({ coordinate: async () => undefined, isEnabled: () => true, isGM: () => true });
    await quiet.run({ id: 's', active: false }, {}, async () => activated++);
    ok('a coordinate that returns nothing activates', activated === 3);
  }

  // ── pass-through ─────────────────────────────────────────────────────────────
  {
    let coordinated = 0;
    let activated = 0;
    const gate = createActivationGate({
      coordinate: async () => {
        coordinated++;
      },
      isEnabled: () => true,
      isGM: () => false,
    });
    await gate.run({ id: 's', active: false }, {}, async () => activated++);
    await gate.run({ id: 's', active: true }, {}, async () => activated++);
    ok(
      'a non-GM and an already-active scene both go straight through',
      coordinated === 0 && activated === 2 && gate.getStatus().passedThrough === 2
    );
  }

  // ── a double click joins ─────────────────────────────────────────────────────
  {
    let coordinated = 0;
    let activated = 0;
    let release;
    const gate = createActivationGate({
      coordinate: () =>
        new Promise((resolve) => {
          coordinated++;
          release = () => resolve({});
        }),
      isEnabled: () => true,
      isGM: () => true,
    });
    const scene = { id: 's2', active: false };
    const a = gate.run(scene, {}, async () => activated++);
    const b = gate.run(scene, {}, async () => activated++);
    await Promise.resolve();
    release();
    await Promise.all([a, b]);
    ok(
      'a second click on the same scene joins the wait: one coordination, one activation',
      coordinated === 1 && activated === 1 && gate.getStatus().joined === 1
    );
  }

  // ── installer ────────────────────────────────────────────────────────────────
  {
    ok(
      'no class => not installed',
      installSceneActivationGate({
        coordinate: async () => ({}),
        isEnabled: () => true,
        isGM: () => true,
        getSceneClass: () => null,
      }).installed === false
    );
    const calls = [];
    class Base {
      async activate(options = {}) {
        calls.push(['activate', this.id, options.pullUsers ?? null]);
        return this;
      }
    }
    class Sub extends Base {
      constructor(id) {
        super();
        this.id = id;
        this.active = false;
      }
    }
    const r1 = installSceneActivationGate({
      coordinate: async () => ({}),
      isEnabled: () => true,
      isGM: () => true,
      getSceneClass: () => Sub,
    });
    ok(
      'installs on the prototype that OWNS activate (the base), covering subclasses',
      r1.installed === true &&
        Object.prototype.hasOwnProperty.call(Base.prototype, 'activate') &&
        !Object.prototype.hasOwnProperty.call(Sub.prototype, 'activate')
    );
    const r2 = installSceneActivationGate({
      coordinate: async () => ({}),
      isEnabled: () => true,
      isGM: () => true,
      getSceneClass: () => Sub,
    });
    ok('a second install does not wrap again', r2.reason === 'already installed');
    const s = new Sub('s9');
    const out = await s.activate({ pullUsers: false });
    ok(
      'the wrapped activate coordinates, then calls the original once on the same document',
      out === s && calls.length === 1 && calls[0][1] === 's9' && calls[0][2] === false
    );
  }
}
