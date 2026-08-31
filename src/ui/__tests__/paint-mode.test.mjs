/**
 * ui/paint-mode.js + ui/paint-mode-toolbar.js — the painter's state machine and
 * the two toolbar guards, under plain Node.
 *
 * ============================================================================
 * WHY THIS SUITE RE-HOSTS THE MODULE INSTEAD OF IMPORTING IT
 * ============================================================================
 * `import('../paint-mode.js')` cannot load here: it pulls `../scene/index.js`,
 * `../foundry/index.js` and `../vt/index.js`, and that graph reaches the whole
 * effects tree and THREE. So the file is read off disk, its `import` statements
 * are removed, the removed names are re-supplied as stubs, and ONE anchor
 * (`installPainter`'s own `return {`) gains a `__test` handle onto the closure's
 * internals. Everything between those two edits is the REAL SHIPPED SOURCE,
 * byte-for-byte — this suite runs the actual `pushUndo`/`undo`/`discardEdits`/
 * `hydrateFromScene`, not a re-implementation of them (a mirror would pass
 * forever while the module rotted underneath it, which is the exact failure
 * this project's own doctrine names).
 *
 * The cost is that a rename of one of those internals fails the re-host rather
 * than the assertion. That is deliberate: it fails LOUDLY, at the extraction,
 * with a message saying what moved.
 *
 * NOT covered here (browser-only, verified live): the window capture-phase
 * listeners themselves, the preview canvas, and the real confirm dialog's DOM.
 * `endStroke` — the pure half of the pointer-capture fix — IS covered, because
 * it is the part every one of those paths funnels through.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createToolbar } from '../paint-mode-toolbar.js';

const PAINT_MODE_PATH = fileURLToPath(new URL('../paint-mode.js', import.meta.url));
const IMPORT_RE = /^import\s+\{([\s\S]*?)\}\s+from\s+'[^']+';$/gm;
const RETURN_ANCHOR = '\n  return {\n';
const TEST_HANDLE =
  '\n  return {\n    __test: { state, pushUndo, undo, discardEdits, applyHydrate, endStroke, activeKey, save },\n';

/** Compile the real `installPainter` with its imports replaced by stubs. */
function compileInstallPainter() {
  // Normalised to LF first: this repo's prettier config is `endOfLine: "auto"`,
  // so the working copy can legitimately be CRLF and every anchor below would
  // silently miss.
  const src = readFileSync(PAINT_MODE_PATH, 'utf8').replace(/\r\n/g, '\n');
  const names = new Set();
  for (const m of src.matchAll(IMPORT_RE)) {
    for (const raw of m[1].split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop()
        .trim();
      if (name) names.add(name);
    }
  }
  if (names.size === 0)
    throw new Error('re-host: no imported names found in paint-mode.js — did the import block move?');
  const occurrences = src.split(RETURN_ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(`re-host: expected exactly one "  return {" anchor in paint-mode.js, found ${occurrences}`);
  }
  const body = src
    .replace(IMPORT_RE, '')
    .replace('export function installPainter', 'function installPainter')
    .replace(RETURN_ANCHOR, TEST_HANDLE);
  const factory = new Function(
    '__deps',
    `const { ${[...names].join(', ')} } = __deps;\n${body}\nreturn installPainter;`
  );
  return factory;
}

const installPainterFactory = compileInstallPainter();

const SCENE_RECT = { x: 0, y: 0, width: 400, height: 400 };
const gridSpec = { w: 4, h: 4, x: 0, y: 0, texelW: 100, texelH: 100 };
const makeLayer = (fill = 0) => ({ spec: gridSpec, data: new Uint8Array(16).fill(fill) });

/**
 * A painter with every Foundry/DOM dependency stubbed. Returns the public
 * surface, the `__test` handle onto its internals, and the recorders.
 */
function makePainter({ scenePayload = null, sceneLayers = null } = {}) {
  const calls = { saved: [], announced: [], confirms: [], notifications: [] };
  const answers = [];
  const board = {
    captured: [],
    released: [],
    setPointerCapture(id) {
      board.captured.push(id);
    },
    releasePointerCapture(id) {
      board.released.push(id);
    },
  };
  const ctx = {
    ready: true,
    sceneRect: SCENE_RECT,
    boardElement: board,
    floorCount: 3,
    viewedFloorIndex: 0,
    screenToWorld: (x, y) => ({ x, y }),
    worldToClient: (x, y) => ({ x, y }),
    snapWorld: (x, y) => ({ x, y }),
  };
  const deps = {
    createPaintLayer: () => makeLayer(0),
    stampBrushWorld: (layer) => layer,
    rasterizePolygon: (layer) => layer,
    rasterizeStrokedLine: (layer) => layer,
    serializePaintedMasks: (layers) => ({ ...layers }),
    hydratePaintedMasks: () => ({ layers: sceneLayers ?? {}, mismatched: [] }),
    encodedByteEstimate: () => 1,
    PAINT_EMBED_BYTE_BUDGET: 1e9,
    MASK_KINDS: [
      { id: 'fire', suffixes: ['_Fire'] },
      { id: 'water', suffixes: ['_Water'] },
    ],
    readPaintContext: () => ctx,
    savePaintedMasks: async (payload) => {
      calls.saved.push(payload);
      return { ok: true };
    },
    loadPaintedMasks: () => scenePayload,
    setVtPanViewerFloor: async () => {},
    createConfirmModal: () => (title, message) => {
      calls.confirms.push({ title, message });
      return Promise.resolve(answers.shift() ?? 'cancel');
    },
    createPaintCanvas: () => ({
      markFull: () => {},
      markWorldDisc: () => {},
      markWorldRect: () => {},
      loop: () => {},
    }),
    createToolbar: () => () => ({}),
  };
  const painter = installPainterFactory(deps)({}, { onLayersChanged: (layers) => calls.announced.push(layers) });
  return { painter, t: painter.__test, state: painter.__test.state, calls, answers, board, ctx };
}

export function run(t) {
  const { ok } = t;

  // ---- Finding D: undo is scoped per `${kind}::${floor}` -------------------
  {
    const { t: api, state } = makePainter();
    ok(
      'undo starts as a per-key map, not one flat stack',
      !Array.isArray(state.undo) && typeof state.undo === 'object'
    );

    state.layers['fire::0'] = makeLayer(10);
    state.layers['fire::1'] = makeLayer(20);

    state.floor = 0;
    api.pushUndo(); // remembers floor 0 at 10
    state.layers['fire::0'].data.fill(11);

    state.floor = 1;
    api.pushUndo(); // remembers floor 1 at 20
    state.layers['fire::1'].data.fill(22);

    ok('each layer gets its own stack', state.undo['fire::0']?.length === 1 && state.undo['fire::1']?.length === 1);

    api.undo(); // viewing floor 1
    ok('undo restores the layer being viewed', state.layers['fire::1'].data[0] === 20);
    ok('...and never touches another floor', state.layers['fire::0'].data[0] === 11);
    ok('...popping only its own stack', state.undo['fire::1'].length === 0 && state.undo['fire::0'].length === 1);

    // The bug this replaces: one flat stack meant this second Ctrl+Z (still on
    // floor 1, whose stack is now empty) popped floor 0's snapshot and rolled
    // back a stroke on a layer the author could not even see.
    api.undo();
    ok('an exhausted stack is a no-op, not a raid on another layer', state.layers['fire::0'].data[0] === 11);
    ok('...and the other layer keeps its history', state.undo['fire::0'].length === 1);

    state.floor = 0;
    api.undo();
    ok('the other floor can still undo its own stroke', state.layers['fire::0'].data[0] === 10);
  }

  // ---- Finding D: UNDO_LIMIT is enforced per key, not globally -------------
  {
    const { t: api, state } = makePainter();
    state.layers['fire::0'] = makeLayer(1);
    state.layers['fire::1'] = makeLayer(1);
    state.floor = 0;
    for (let i = 0; i < 25; i++) api.pushUndo();
    state.floor = 1;
    api.pushUndo();
    ok('a key cannot exceed the undo cap', state.undo['fire::0'].length <= 10);
    ok('...and the cap is per key, so another layer keeps its own', state.undo['fire::1'].length === 1);
  }

  // ---- Findings A + B: the committed snapshot -----------------------------
  {
    const {
      painter,
      t: api,
      state,
    } = makePainter({
      scenePayload: { 'fire::0': 'encoded' },
      sceneLayers: { 'fire::0': makeLayer(5) },
    });
    const r = painter.hydrateFromScene();
    ok('a clean hydrate still loads the scene', r.loaded === true && state.layers['fire::0'].data[0] === 5);
    ok('...and is clean afterwards', state.dirtySinceSave === false);
    ok('...and takes the committed snapshot', state.committedLayers?.['fire::0']?.data[0] === 5);

    state.layers['fire::0'].data.fill(99);
    ok(
      'the snapshot is a DEEP copy — editing the live layer cannot reach it',
      state.committedLayers['fire::0'].data[0] === 5
    );

    state.dirtySinceSave = true;
    state.undo['fire::0'] = [{ key: 'fire::0', data: new Uint8Array(16) }];
    ok('discard reports that it had something to restore', api.discardEdits() === true);
    ok('discard actually rolls the pixels back', state.layers['fire::0'].data[0] === 5);
    ok('...clears the undo stacks', Object.keys(state.undo).length === 0);
    ok('...and marks the painter clean', state.dirtySinceSave === false);
    ok(
      'the restored layer is itself a copy — a later edit cannot corrupt the snapshot',
      (state.layers['fire::0'].data.fill(77), state.committedLayers['fire::0'].data[0] === 5)
    );
  }

  // ---- Finding A: the no-snapshot fallback (never hydrated, never saved) ---
  {
    const { t: api, state } = makePainter();
    state.layers['fire::0'] = makeLayer(3);
    state.dirtySinceSave = true;
    ok('discard admits when there is nothing committed to go back to', api.discardEdits() === false);
    ok('...and leaves the layers exactly as they were (the caller just closes)', state.layers['fire::0'].data[0] === 3);
  }

  // ---- Finding B: a scene load never overwrites unsaved work ---------------
  {
    const { painter, state, calls } = makePainter({
      scenePayload: { 'fire::0': 'encoded' },
      sceneLayers: { 'fire::0': makeLayer(5) },
    });
    painter.hydrateFromScene(); // establish a committed baseline
    state.active = true;
    state.layers['fire::0'].data.fill(42);
    state.dirtySinceSave = true;

    const r = painter.hydrateFromScene();
    ok('a load over unsaved work is deferred, not applied', r.deferredForUnsavedChanges === true);
    ok('...the unsaved pixels survive', state.layers['fire::0'].data[0] === 42);
    ok('...the toolbar keeps saying unsaved (it used to flip to "Saved")', state.dirtySinceSave === true);
    ok('...and the deferral is recorded', state.pendingHydrate === true);
    ok('the author is asked, not just ignored', calls.confirms.length === 1);
    ok(
      'the render bridge is fed NOTHING while the layers belong to another scene',
      Object.keys(painter.getLayers()).length === 0
    );
  }

  // ---- Finding B: discarding resolves the deferred load --------------------
  {
    const {
      painter,
      t: api,
      state,
      calls,
    } = makePainter({
      scenePayload: { 'fire::0': 'encoded' },
      sceneLayers: { 'fire::0': makeLayer(7) },
    });
    state.active = true;
    state.layers['fire::0'] = makeLayer(42);
    state.dirtySinceSave = true;
    painter.hydrateFromScene();
    ok('the deferral held', state.pendingHydrate === true && state.layers['fire::0'].data[0] === 42);

    ok('discarding resolves it', api.discardEdits() === true);
    ok("...by finally loading the scene's own masks", state.layers['fire::0'].data[0] === 7);
    ok('...clean again', state.dirtySinceSave === false && state.pendingHydrate === false);
    ok('...and getLayers is honest again', painter.getLayers()['fire::0'].data[0] === 7);
    ok('...and the render is told, since the caller re-ingest is long gone', calls.announced.length === 1);
  }

  // ---- Finding B: a CLEAN load behaves exactly as it always did ------------
  {
    const { painter, state } = makePainter({
      scenePayload: { 'fire::0': 'encoded' },
      sceneLayers: { 'fire::0': makeLayer(9) },
    });
    state.active = true; // open, but nothing unsaved
    const r = painter.hydrateFromScene();
    ok('an open-but-clean painter hydrates normally', r.loaded === true && state.layers['fire::0'].data[0] === 9);
    ok('...with no deferral and no dialog', state.pendingHydrate === false);
  }

  // ---- Finding C: a load re-resolves the paint context ---------------------
  {
    const { painter, state, ctx } = makePainter({ scenePayload: null });
    state.ctx = { ready: true, boardElement: { stale: true }, sceneRect: SCENE_RECT };
    painter.hydrateFromScene();
    ok('a scene load re-resolves ctx (the stale boardElement is what killed painting)', state.ctx === ctx);

    // ...and on the deferred path too, which is the one that matters most:
    // that is precisely when the painter stays open across a canvas rebuild.
    state.active = true;
    state.dirtySinceSave = true;
    state.ctx = { ready: true, boardElement: { stale: true }, sceneRect: SCENE_RECT };
    painter.hydrateFromScene();
    ok('...including when the load itself is deferred', state.ctx === ctx);
  }

  // ---- Finding E: endStroke is the one exit every stroke funnels through ---
  {
    const { t: api, state, board } = makePainter();
    state.ctx = { boardElement: board };
    state.painting = true;
    state.pointerId = 7;
    state.lastWorld = { x: 1, y: 2 };
    ok('ending a live stroke reports it ended', api.endStroke() === true);
    ok('...stops painting', state.painting === false);
    ok('...drops the interpolation anchor', state.lastWorld === null);
    ok('...and releases the pointer capture', board.released[0] === 7);
    ok('ending twice is a harmless no-op', api.endStroke() === false);

    // A capture that was never taken (setPointerCapture refused) must not
    // throw its way out of the stroke ending.
    state.painting = true;
    state.pointerId = null;
    ok('a stroke with no capture still ends cleanly', api.endStroke() === true && board.released.length === 1);
  }

  // ---- Finding G: save() is inert when nothing is dirty --------------------
  {
    const { t: api, state, calls } = makePainter();
    state.layers['fire::0'] = makeLayer(1);
    return api.save().then(() => {
      ok('a save with nothing dirty writes nothing', calls.saved.length === 0);
      state.dirtySinceSave = true;
      return api.save().then(() => {
        ok('...but a dirty save still writes', calls.saved.length === 1);
        ok('...and re-takes the committed snapshot', state.committedLayers?.['fire::0']?.data[0] === 1);
        return runToolbarChecks(t); // RETURNED: the harness must not finish before the toolbar half does
      });
    });
  }
}

// ---------------------------------------------------------------------------
// THE TOOLBAR HALF — `createToolbar` is real (its only import is the pure DOM
// widgets module), so it runs against a minimal `document` shim. The shim is
// installed and REMOVED inside this function: `floor-transition.test.mjs` in
// this same process asserts the no-DOM path, and a leaked `globalThis.document`
// would quietly invalidate it.
// ---------------------------------------------------------------------------
function makeDocumentShim() {
  const createElement = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      style: {},
      children: [],
      textContent: '',
      disabled: false,
      listeners: {},
      append: (...kids) => node.children.push(...kids),
      appendChild: (kid) => (node.children.push(kid), kid),
      addEventListener: (type, fn) => (node.listeners[type] ??= []).push(fn),
      removeEventListener: () => {},
      remove: () => {},
    };
    return node;
  };
  return {
    createElement,
    createTextNode: (text) => ({ tagName: '#text', textContent: text, children: [], listeners: {} }),
    body: { append: () => {}, appendChild: () => {} },
  };
}

function collectButtons(node, out = []) {
  if (node?.tagName === 'BUTTON') out.push(node);
  for (const kid of node?.children ?? []) collectButtons(kid, out);
  return out;
}

function runToolbarChecks(t) {
  const { ok } = t;
  const hadDocument = 'document' in globalThis;
  const previousDocument = globalThis.document;
  globalThis.document = makeDocumentShim();
  try {
    const cleared = [];
    const confirms = [];
    const answers = [];
    const state = {
      tool: 'brush',
      snap: false,
      floor: 2,
      kind: 'water',
      floorSwitching: false,
      dirtySinceSave: false,
      brush: { radius: 90, strength: 180, hardness: 0.55, mode: 'add' },
      refreshToolbar: null,
    };
    const buildToolbar = createToolbar(state, {
      setTool: () => {},
      changeFloor: () => {},
      save: () => {},
      undo: () => {},
      clearActive: () => cleared.push(true),
      requestExit: () => {},
      layerFor: () => {},
      markFull: () => {},
      activeKey: () => `${state.kind}::${state.floor}`,
      confirmModal: (title, message) => {
        confirms.push({ title, message });
        return Promise.resolve(answers.shift() ?? 'cancel');
      },
      paintableKinds: [
        { id: 'fire', suffixes: ['_Fire'] },
        { id: 'water', suffixes: ['_Water'] },
      ],
    });
    const bar = buildToolbar();
    const buttons = collectButtons(bar);
    const clearBtn = buttons.find((b) => b.textContent === 'Clear');
    const saveBtn = buttons.find((b) => String(b.textContent).includes('Save'));

    // ---- Finding G: dimmed is not disabled -------------------------------
    ok('a clean Save button is really disabled, not just dimmed', saveBtn?.disabled === true);
    ok('...and still LOOKS clean', saveBtn.style.opacity === '0.55');
    state.dirtySinceSave = true;
    state.refreshToolbar();
    ok('a dirty Save button is enabled again', saveBtn.disabled === false);

    // ---- Finding F: Clear confirms, and names what it is about to wipe ----
    ok('the Clear button exists', !!clearBtn);
    answers.push('cancel');
    return clearBtn.listeners.click[0]()
      .then(() => {
        ok('Clear asks first', confirms.length === 1);
        ok('...naming the exact mask', confirms[0].message.includes('_Water'));
        ok('...and the exact floor', confirms[0].message.includes('floor 2'));
        ok('cancelling clears nothing', cleared.length === 0);
        answers.push('clear');
        return clearBtn.listeners.click[0]();
      })
      .then(() => {
        ok('confirming clears', cleared.length === 1);
      })
      .finally(() => {
        if (hadDocument) globalThis.document = previousDocument;
        else delete globalThis.document;
      });
  } catch (err) {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
    throw err;
  }
}
