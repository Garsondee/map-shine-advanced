/**
 * @fileoverview foundry/transition-bridge.js — everything MSA's transition system needs from
 * Foundry's OWN transition system (author, 2026-10-26: "read from the Foundry VTT system's own
 * transition system so that we can be compatible with their stuff").
 *
 *  - THE CATALOGUE. `CONFIG.Canvas.sceneTransitions` (`F:config.mjs:985`) lists every effect
 *    Foundry (and any module) offers, with its label and default duration. The Remote's override
 *    picker lists exactly these, so a module that adds one is offered automatically.
 *  - THE SCENE'S OWN SETTING. `Scene#transition` (`F:common/documents/scene.mjs:137`): `type`
 *    (null = not set), `duration`, `activeOnly`.
 *  - THE LOCK. `canvas.transition.isLocked` (`F:canvas/transition.mjs:35`) is Foundry's own flag
 *    for "an external workflow owns transitions"; set, core skips playing its effect at the end
 *    of a draw (`F:canvas/board.mjs:1277`). Its tear-down snapshot still happens, which is why the
 *    interface seam also keeps that container un-renderable (`canvas-compositing.js`).
 *  - FOUNDRY'S EFFECT, ON A COMBINED FRAME. Foundry's filters only ever see its PIXI layer, and
 *    MSA draws underneath on its own canvas — the reason Foundry's snapshot came out grey. So the
 *    effect is played here on a full-screen sprite (a colour) animating to a still that MSA
 *    composed from both canvases, through Foundry's own public
 *    `TextureTransitionFilter.animate` (`F:canvas/rendering/filters/transition.mjs`). When it ends,
 *    the sprite shows exactly the live view beneath it, and goes.
 *
 * Every function here fails soft: a missing Foundry object means "not available", never a throw.
 *
 * @module foundry/transition-bridge
 */
import { createLogger } from '../core/log.js';

const log = createLogger('transition-bridge');

/**
 * Foundry's transition catalogue, as plain data.
 * @param {object} [config] - defaults to the live `CONFIG`
 * @param {(key: string) => string} [localize]
 * @returns {Array<{id: string, label: string, defaultDurationMs: number}>}
 */
export function listFoundryTransitions(config = globalThis.CONFIG, localize = defaultLocalize) {
  const catalogue = config?.Canvas?.sceneTransitions;
  if (!catalogue || typeof catalogue !== 'object') return [];
  return Object.entries(catalogue).map(([id, def]) => ({
    id,
    label: labelFor(def?.label, localize) || id,
    defaultDurationMs: Number.isFinite(def?.defaultDuration) ? def.defaultDuration : 1500,
  }));
}

/** A translated label; a module's plain-text label as-is; never a raw `A.B.C` i18n key. */
function labelFor(label, localize) {
  if (typeof label !== 'string' || !label) return null;
  const translated = localize(label);
  if (translated) return translated;
  return /^[\w-]+(\.[\w-]+)+$/.test(label) ? null : label;
}

function defaultLocalize(key) {
  try {
    const s = globalThis.game?.i18n?.localize?.(key);
    return s && s !== key ? s : null;
  } catch {
    return null;
  }
}

/**
 * A scene's own transition setting, in the shape `ui/scene-transition.js#planTransition` takes.
 * @param {object|null} sceneDoc
 * @returns {{type: string|null, durationMs: number|null, activeOnly: boolean, sceneActive: boolean}|null}
 */
export function readSceneTransition(sceneDoc) {
  const t = sceneDoc?.transition;
  if (!t) return null;
  return {
    type: typeof t.type === 'string' && t.type ? t.type : null,
    durationMs: Number.isFinite(t.duration) ? t.duration : null,
    activeOnly: t.activeOnly === true,
    sceneActive: sceneDoc.active === true,
  };
}

/** Tell Foundry's core that MSA owns transitions (or hand them back). @param {boolean} locked */
export function setFoundryTransitionLock(locked) {
  try {
    const tr = globalThis.canvas?.transition;
    if (tr) tr.isLocked = locked === true;
    return !!tr;
  } catch (err) {
    log.warn('could not set the Foundry transition lock:', err);
    return false;
  }
}

/**
 * Foundry's own layer (tokens, walls UI, fog — everything on its PIXI stage) as a canvas.
 * @returns {HTMLCanvasElement|null}
 */
export function captureFoundryLayer() {
  try {
    const c = globalThis.canvas;
    if (!c?.app?.renderer?.extract || !c.stage) return null;
    return c.app.renderer.extract.canvas(c.stage);
  } catch (err) {
    log.warn("could not capture Foundry's layer for a transition:", err);
    return null;
  }
}

/** '#rrggbb' → 0xrrggbb, black for anything else. */
export function colorToNumber(color) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(color ?? ''));
  return m ? parseInt(m[1], 16) : 0x000000;
}

/**
 * Play one of Foundry's effects from a solid colour to `to` (a still of the new view).
 * Resolves `true` once it finished, `false` if it could not play (the caller then fades instead).
 * @param {{to: HTMLCanvasElement, type: string, durationMs: number, color?: string, onCovered?: () => void}} args
 *   `onCovered` runs once the effect's own sprite is on screen — the moment MSA's veil can go.
 * @returns {Promise<boolean>}
 */
export async function playFoundryTransition({ to, type, durationMs, color = '#000000', onCovered }) {
  const c = globalThis.canvas;
  const PIXIns = globalThis.PIXI;
  const fvtt = globalThis.foundry;
  const def = globalThis.CONFIG?.Canvas?.sceneTransitions?.[type];
  const FilterClass = def?.filterClass ?? fvtt?.canvas?.rendering?.filters?.TextureTransitionFilter;
  const Unbound = fvtt?.canvas?.containers?.UnboundContainer;
  if (!def || !c?.app?.renderer || !c.stage || !PIXIns || !Unbound || typeof FilterClass?.animate !== 'function') {
    return false;
  }
  let container = null;
  let toTexture = null;
  try {
    const renderer = c.app.renderer;
    const { width, height } = renderer.screen;
    container = new Unbound();
    container.eventMode = 'none';
    // One full-screen sprite for the transition (not a particle: `particles/one-engine` is about
    // per-particle sprites). `Sprite.from` is PIXI's own constructor for a texture.
    const sprite = PIXIns.Sprite.from(PIXIns.Texture.WHITE);
    Object.assign(sprite, { width, height, tint: colorToNumber(color) });
    container.addChild(sprite);
    c.stage.addChild(container); // added last: drawn above everything else on the stage
    toTexture = PIXIns.Texture.from(to);
    // Wait until the sprite has actually been drawn, so the veil can go without a gap.
    await new Promise((resolve) => {
      const after = () => {
        if (renderer.lastObjectRendered !== c.stage) return;
        renderer.off('postrender', after);
        resolve();
      };
      renderer.on('postrender', after);
    });
    onCovered?.();
    await FilterClass.animate(sprite, toTexture, { type: def.filterType ?? type, duration: durationMs });
    return true;
  } catch (err) {
    log.warn(`Foundry transition "${type}" failed — the caller will fade instead:`, err);
    return false;
  } finally {
    try {
      container?.destroy({ children: true });
      toTexture?.destroy(true);
    } catch (err) {
      log.warn('cleaning up a Foundry transition threw:', err);
    }
  }
}
