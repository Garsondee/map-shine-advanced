/**
 * SMOOTH PAN (2026-11-04) — Foundry's own camera input, made frame-even.
 *
 * MSA draws the map from Foundry's camera (`canvas.stage`, read every frame by
 * vt-pan-viewer's syncFoundryCamera). So the map can only move as evenly as
 * Foundry moves that camera, and measured live (tools/pan-smoothness/measure.mjs,
 * Big Bank, all effects off, 144 Hz) it does not:
 *
 * 1. RIGHT-DRAG PAN DROPS A THIRD OF ITS FRAMES. MouseInteractionManager
 *    #handlePointerMove ("Limit dragging to 60 updates per second") ignores a
 *    move unless `Date.now() - dragTime >= canvas.app.ticker.elapsedMS`. Date.now()
 *    counts whole milliseconds and elapsedMS is the last tick's real length, so on
 *    a 144 Hz frame (6.9 ms) a 6 ms reading loses, and at 60 Hz a 16 ms reading
 *    loses to 16.7. Measured: input arrived on every frame, Foundry panned on 114
 *    of 171 — the camera held still for a frame, then jumped double (step spread
 *    ~150%, 11-30 px of wobble around a straight pan).
 *    Fix: the BOARD's manager (not tokens', not any other) gets a dragTime that
 *    never throttles. One pan per delivered move: Chrome already aligns mouse
 *    moves to frames, so this is one camera update per frame, not a flood.
 *
 * 2. HELD ARROW KEYS PULSE. Each key repeat (~30 per second) starts a NEW 100 ms
 *    ease-in-out `canvas.animatePan` from wherever the last one had got to, so the
 *    camera speeds up and slows down 30 times a second (per-frame step swinging
 *    1-19 px, step spread ~57%).
 *    Fix: the first press is Foundry's own one-grid step, untouched (a tap still
 *    nudges one square). From the first auto-repeat on, a held key drives a GLIDE:
 *    constant speed, eased in and out, advanced once per Foundry tick by that
 *    tick's own time. Foundry's own bookkeeping (`game.keyboard.panKeys`, tours,
 *    released keys on blur) stays Foundry's: the glide only reads panKeys.
 *
 * Both write Foundry's camera through `canvas.pan()`, the same call Foundry
 * itself makes — MSA still has no camera of its own (keyhole-input-model).
 * `MapShine.setSmoothPan(false)` puts Foundry's own behaviour back.
 */

/** Grid squares per second a held arrow key glides — Foundry's own held speed, measured (~7.9). */
export const KEY_GLIDE_GRIDS_PER_SEC = 8;
/** Half-life of the glide's speed easing toward its target, seconds. */
export const KEY_GLIDE_HALF_LIFE_SEC = 0.05;
/** Below this speed (world px/s) with no key held, the glide is over. */
export const KEY_GLIDE_STOP_PX_PER_SEC = 2;
/** Longest step one tick may integrate (a stalled tick must not fling the camera). */
export const KEY_GLIDE_MAX_DT_SEC = 0.1;

/** Foundry's core pan actions and the directions each one holds. */
export const PAN_ACTIONS = Object.freeze({
  'core.panUp': ['up'],
  'core.panLeft': ['left'],
  'core.panDown': ['down'],
  'core.panRight': ['right'],
  'core.panUpLeft': ['up', 'left'],
  'core.panUpRight': ['up', 'right'],
  'core.panDownLeft': ['down', 'left'],
  'core.panDownRight': ['down', 'right'],
});

/**
 * Unit direction of travel for a set of held pan keys — Foundry's own sums
 * (`#handleCanvasPan`: each held direction adds one grid on its axis, so a
 * diagonal is faster, exactly as Foundry's is). Zoom directions (ascend/descend)
 * are not planar: `{zoom: true}` hands the key back to Foundry.
 * @param {Iterable<string>} panKeys - values of game.keyboard.panKeys
 * @param {Record<string,string>} D - ClientKeybindings.MOVEMENT_DIRECTIONS
 */
export function panKeyDirection(panKeys, D) {
  let x = 0;
  let y = 0;
  let zoom = false;
  for (const k of panKeys) {
    if (k === D.LEFT) x -= 1;
    else if (k === D.RIGHT) x += 1;
    else if (k === D.UP) y -= 1;
    else if (k === D.DOWN) y += 1;
    else if (k === D.ASCEND || k === D.DESCEND) zoom = true;
  }
  return { x, y, zoom };
}

/**
 * One glide step: ease the velocity toward the target, then move by it.
 * Frame-rate independent: two half-steps land where one whole step does (up to
 * the easing's own curvature), so an uneven frame cadence gives an even path.
 * @param {{x:number,y:number}} v - velocity, world px/s
 * @param {{x:number,y:number}} target - target velocity, world px/s
 * @param {number} dtSec
 * @param {number} [halfLifeSec]
 * @returns {{v:{x:number,y:number}, dx:number, dy:number}}
 */
export function glideStep(v, target, dtSec, halfLifeSec = KEY_GLIDE_HALF_LIFE_SEC) {
  const dt = Math.min(KEY_GLIDE_MAX_DT_SEC, Math.max(0, dtSec));
  if (dt === 0) return { v, dx: 0, dy: 0 };
  // Exact integral of exponential approach over dt, so the distance does not
  // depend on how the time was sliced into frames.
  const lambda = Math.LN2 / halfLifeSec;
  const k = Math.exp(-lambda * dt);
  const nv = { x: target.x + (v.x - target.x) * k, y: target.y + (v.y - target.y) * k };
  const travel = (1 - k) / lambda; // integral of the decaying difference
  return {
    v: nv,
    dx: target.x * dt + (v.x - target.x) * travel,
    dy: target.y * dt + (v.y - target.y) * travel,
  };
}

/**
 * Make a MouseInteractionManager's drag throttle never fire. Its check is
 * `if ((now - this.dragTime) < ticker.elapsedMS) return;` — with dragTime pinned
 * at -Infinity the difference is +Infinity and every move goes through. Returns
 * a function that puts the original value back.
 * @param {object} mgr
 */
export function unthrottleDrag(mgr) {
  if (!mgr || typeof mgr !== 'object') return null;
  const own = Object.getOwnPropertyDescriptor(mgr, 'dragTime');
  if (own && own.get && own.get.__msaSmoothPan) return null; // already done
  const getter = () => -Infinity;
  getter.__msaSmoothPan = true;
  Object.defineProperty(mgr, 'dragTime', { configurable: true, enumerable: true, get: getter, set() {} });
  return () => {
    if (own) Object.defineProperty(mgr, 'dragTime', own);
    else delete mgr.dragTime;
  };
}

/**
 * Install both fixes. Call once at module load (hooks are registered here).
 * @param {{onReady?: () => void}} [opts] - also run at Foundry's `ready` (settings
 *   are registered by then); boot applies the frame-pacing setting through it, so
 *   the Foundry hook stays in the adapter.
 * @returns {{setEnabled:(on:boolean)=>void, status:()=>object}}
 */
export function installSmoothPan({ onReady = null } = {}) {
  let enabled = true;
  let restoreDrag = null;
  /** @type {Map<string, {onDown:Function, onUp:Function}>} original handlers per action */
  const originals = new Map();
  const glide = { running: false, v: { x: 0, y: 0 }, last: null, shift: false, tickFn: null };
  const counts = { glides: 0, glideTicks: 0, tapsPassedThrough: 0 };

  const D = () => globalThis.foundry?.helpers?.interaction?.ClientKeybindings?.MOVEMENT_DIRECTIONS ?? {
    UP: 'up', LEFT: 'left', DOWN: 'down', RIGHT: 'right', ASCEND: 'ascend', DESCEND: 'descend',
  };

  // ---- 1. drag throttle ---------------------------------------------------
  const applyDrag = () => {
    restoreDrag?.();
    restoreDrag = null;
    if (!enabled) return;
    restoreDrag = unthrottleDrag(globalThis.canvas?.mouseInteractionManager);
  };

  // ---- 2. key glide ---------------------------------------------------------
  const stopGlide = () => {
    if (glide.tickFn) globalThis.canvas?.app?.ticker?.remove(glide.tickFn);
    glide.running = false;
    glide.tickFn = null;
    glide.v = { x: 0, y: 0 };
    glide.last = null;
  };

  const glideTick = () => {
    const c = globalThis.canvas;
    const ticker = c?.app?.ticker;
    if (!enabled || !c?.ready || !ticker) return stopGlide();
    const now = ticker.lastTime;
    const dtSec = glide.last === null ? 0 : (now - glide.last) / 1000;
    glide.last = now;
    const dir = panKeyDirection(globalThis.game?.keyboard?.panKeys ?? [], D());
    const speed = (c.dimensions?.size ?? 100) * KEY_GLIDE_GRIDS_PER_SEC * (glide.shift ? 0.5 : 1);
    const target = dir.zoom ? { x: 0, y: 0 } : { x: dir.x * speed, y: dir.y * speed };
    const step = glideStep(glide.v, target, dtSec);
    glide.v = step.v;
    counts.glideTicks++;
    if (step.dx || step.dy) c.pan({ x: c.stage.pivot.x + step.dx, y: c.stage.pivot.y + step.dy });
    const held = target.x !== 0 || target.y !== 0;
    if (!held && Math.hypot(glide.v.x, glide.v.y) < KEY_GLIDE_STOP_PX_PER_SEC) stopGlide();
  };

  const startGlide = (shift) => {
    glide.shift = shift;
    if (glide.running) return;
    const ticker = globalThis.canvas?.app?.ticker;
    if (!ticker) return;
    // The tap's own one-grid animatePan may still be running: one writer at a time.
    globalThis.foundry?.canvas?.animation?.CanvasAnimation?.terminateAnimation?.('canvas.animatePan');
    glide.running = true;
    glide.last = null;
    glide.tickFn = glideTick;
    counts.glides++;
    // HIGH priority: the camera moves before Foundry draws its own layers this tick.
    ticker.add(glide.tickFn, null, globalThis.PIXI?.UPDATE_PRIORITY?.HIGH ?? 25);
  };

  const wrapAction = (id, dirs) => {
    const kb = globalThis.game?.keybindings;
    const action = kb?.actions?.get(id);
    if (!action) return;
    if (!originals.has(id)) originals.set(id, { onDown: action.onDown, onUp: action.onUp });
    const orig = originals.get(id);
    const onDown = (context) => {
      const tour = globalThis.foundry?.nue?.Tour?.tourInProgress;
      if (!enabled || tour || !globalThis.canvas?.ready || !context?.repeat) {
        if (!context?.repeat) counts.tapsPassedThrough++;
        return orig.onDown(context);
      }
      const panKeys = globalThis.game.keyboard.panKeys;
      const d = D();
      for (const k of dirs) panKeys.add(d[k.toUpperCase()]);
      if (panKeyDirection(panKeys, d).zoom) return orig.onDown(context);
      startGlide(context.isShift === true);
      return true;
    };
    // Release stays Foundry's (it removes the keys; the glide sees them gone and eases out).
    action.onDown = onDown;
    // activeKeys holds COPIES of onDown made by initialize(): patch those too.
    for (const list of kb.activeKeys?.values?.() ?? []) {
      for (const entry of list) if (entry.action === id) entry.onDown = onDown;
    }
  };

  const applyKeys = () => {
    const kb = globalThis.game?.keybindings;
    if (!kb) return;
    if (enabled) for (const [id, dirs] of Object.entries(PAN_ACTIONS)) wrapAction(id, dirs);
    else {
      for (const [id, orig] of originals) {
        const action = kb.actions?.get(id);
        if (action) action.onDown = orig.onDown;
        for (const list of kb.activeKeys?.values?.() ?? []) {
          for (const entry of list) if (entry.action === id) entry.onDown = orig.onDown;
        }
      }
      stopGlide();
    }
  };

  // initialize() rebuilds activeKeys from the actions (on load and whenever a
  // binding is edited) — re-patch after every rebuild.
  const hookInitialize = () => {
    const kb = globalThis.game?.keybindings;
    if (!kb || kb.__msaSmoothPanInit) return;
    const init = kb.initialize.bind(kb);
    kb.initialize = (...a) => {
      const r = init(...a);
      applyKeys();
      return r;
    };
    kb.__msaSmoothPanInit = true;
  };

  if (typeof Hooks !== 'undefined') {
    Hooks.on('canvasReady', applyDrag);
    Hooks.once('ready', () => {
      hookInitialize();
      applyKeys();
      onReady?.();
    });
    Hooks.on('canvasTearDown', stopGlide);
  }

  return {
    setEnabled(on) {
      enabled = on !== false;
      applyDrag();
      applyKeys();
      return enabled;
    },
    status() {
      const own = Object.getOwnPropertyDescriptor(globalThis.canvas?.mouseInteractionManager ?? {}, 'dragTime');
      return {
        enabled,
        dragUnthrottled: !!own?.get?.__msaSmoothPan,
        keysWrapped: originals.size,
        glideRunning: glide.running,
        ...counts,
      };
    },
  };
}
