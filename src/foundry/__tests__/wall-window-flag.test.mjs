/**
 * wall-window-flag.test.mjs — the per-wall "Window (light pattern)" checkbox: the bulk "mark windows" helper, the
 * flag's wiring into the wall reader's two window notions, and the dialog hook's behaviour under a stub DOM.
 */
import { markWallWindows, installWallWindowConfig, WALL_WINDOW_FLAG } from '../wall-window-flag.js';
import { deriveWallAperture, deriveWallLooksLikeWindow } from '../scene-walls.js';

function fakeScene(walls) {
  const updates = [];
  const docs = walls.map((w, i) => ({
    id: `w${i}`,
    move: w.move ?? 20,
    light: w.light ?? 20,
    sight: w.sight ?? 20,
    getFlag: (scope, key) => (scope === 'map-shine-advanced' && key === WALL_WINDOW_FLAG ? w.flag : undefined),
  }));
  return {
    updates,
    scene: {
      walls: { [Symbol.iterator]: () => docs[Symbol.iterator](), size: docs.length },
      updateEmbeddedDocuments: async (type, list) => {
        updates.push({ type, list });
      },
    },
  };
}

export async function run(t) {
  const { ok } = t;

  ok('the flag key is the one the wall reader reads', WALL_WINDOW_FLAG === 'windowPattern');

  // ── the bulk helper ─────────────────────────────────────────────────────
  const fx = fakeScene([
    { light: 30, sight: 30 }, // 0 proximity window
    { light: 0, sight: 30 }, // 1 none + sight proximity window
    { light: 0, sight: 20 }, // 2 terrain edge: never
    { light: 0, sight: 0 }, // 3 railing: never
    { light: 20, sight: 20 }, // 4 ordinary wall
    { light: 30, sight: 30, flag: true }, // 5 already ticked
  ]);
  const dry = await markWallWindows({ scene: fx.scene, dryRun: true });
  ok(
    'a dry run counts the two un-ticked windows and changes nothing',
    dry.changed === 2 && dry.total === 6 && fx.updates.length === 0
  );
  const done = await markWallWindows({ scene: fx.scene });
  ok('marking ticks exactly the un-ticked windows', done.changed === 2 && fx.updates.length === 1);
  ok(
    'it writes the real flag path on the right walls only',
    JSON.stringify(fx.updates[0].list) ===
      JSON.stringify([
        { _id: 'w0', 'flags.map-shine-advanced.windowPattern': true },
        { _id: 'w1', 'flags.map-shine-advanced.windowPattern': true },
      ])
  );
  ok('and into the Wall documents', fx.updates[0].type === 'Wall');
  const fx2 = fakeScene([{ flag: true }, { flag: false }, {}]);
  const cleared = await markWallWindows({ scene: fx2.scene, mode: 'clear' });
  ok(
    '"clear" unticks only the walls that are ticked',
    cleared.changed === 1 &&
      fx2.updates[0].list[0]._id === 'w0' &&
      fx2.updates[0].list[0]['flags.map-shine-advanced.windowPattern'] === false
  );
  const none = await markWallWindows({ scene: fakeScene([]).scene });
  ok('an empty scene is a clean no-op', none.changed === 0 && none.total === 0);
  const noScene = await markWallWindows({ scene: { walls: null } });
  ok('no walls collection never throws', noScene.changed === 0);

  // ── the two window notions never get confused ───────────────────────────
  ok('looks-like-window does NOT need the flag', deriveWallLooksLikeWindow({ move: 20, light: 30, sight: 30 }));
  ok(
    'the pattern window needs the flag and ignores the look',
    !deriveWallAperture({ windowFlag: undefined }) && deriveWallAperture({ windowFlag: true })
  );

  // ── the dialog hook ─────────────────────────────────────────────────────
  const savedHooks = globalThis.Hooks;
  globalThis.Hooks = undefined;
  ok('outside Foundry installing is a safe no-op', installWallWindowConfig().registered === false);
  let hookName = null;
  let hookFn = null;
  globalThis.Hooks = {
    on: (name, fn) => {
      hookName = name;
      hookFn = fn;
    },
  };
  ok(
    'inside Foundry it subscribes to the wall dialog render',
    installWallWindowConfig().registered === true && hookName === 'renderWallConfig'
  );
  // a minimal DOM stub: enough for the hook's appendChild path
  const savedHTMLElement = globalThis.HTMLElement;
  const savedDocument = globalThis.document;
  class FakeEl {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.className = '';
      this.innerHTML = '';
    }
    querySelector(sel) {
      return sel === '.msa-wall-window'
        ? (this.children.find((c) => c.className === 'msa-wall-window') ?? null)
        : sel === '.standard-form.scrollable'
          ? this
          : null;
    }
    appendChild(c) {
      this.children.push(c);
      return c;
    }
  }
  globalThis.HTMLElement = FakeEl;
  globalThis.document = { createElement: (tag) => new FakeEl(tag) };
  const root = new FakeEl('div');
  hookFn({ document: { getFlag: () => true } }, root);
  ok(
    'the dialog gets one checkbox group at the bottom',
    root.children.length === 1 && root.children[0].className === 'msa-wall-window'
  );
  ok(
    'named like a document field so Foundry Save writes it',
    root.children[0].innerHTML.includes('name="flags.map-shine-advanced.windowPattern"')
  );
  ok('and shows ticked when the wall already has the flag', root.children[0].innerHTML.includes(' checked'));
  hookFn({ document: { getFlag: () => true } }, root);
  ok('a re-render does not add a second group', root.children.length === 1);
  const root2 = new FakeEl('div');
  hookFn({ document: { getFlag: () => undefined } }, root2);
  ok('an unflagged wall shows an unticked box', !root2.children[0].innerHTML.includes(' checked'));
  globalThis.HTMLElement = savedHTMLElement;
  globalThis.document = savedDocument;
  globalThis.Hooks = savedHooks;
}
