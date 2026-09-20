/**
 * SCENE INTRO ZOOM (mythica-machina-press#6) — a brief cinematic zoom onto
 * the viewing player's own token when a scene genuinely loads, before
 * settling back to normal play view. V2 had a generic "zoom on the scene"
 * intro (`V2-UI-Featureset.md` §4.1); the token-targeted version here is a
 * refinement beyond what V2 did, per the issue's own spec — not a straight
 * port.
 *
 * Deliberately NOT built on `foundry/camera-path-player.js` — that system
 * is the full authored-cinematic tool (letterbox bars, UI hiding, a whole
 * playback state machine) for a GM-crafted camera PASS. This is a small,
 * always-on courtesy on ordinary scene load, so it talks to Foundry's own
 * `canvas.animatePan()` directly, the same primitive that player wraps,
 * with none of the heavyweight cinematic trappings.
 *
 * Lives in `foundry/` (touches `canvas`/`game` directly) per the
 * `foundry/adapter-only` wall — the caller (boot.js) decides POLICY (is
 * reduced-motion on, is this actually a fresh scene), this module is pure
 * mechanism.
 *
 * @module foundry/scene-intro-zoom
 */

import { createLogger } from '../core/log.js';
import { resolveViewerToken } from './viewer-token.js';

const log = createLogger('scene-intro-zoom');

/** How long after scene-load to start (ms) — borrows tile-motion-runtime.js's
 * own settle delay verbatim ("let the scene graph finish settling"), the
 * same concern applies here: panning before the camera's own initial
 * position is even set would zoom from a meaningless start point. */
const SETTLE_DELAY_MS = 250;
/** Zoom-in duration, hold, and zoom-out duration (ms). ~2.4s total — reads
 * as "brief" per the issue's own wording, not a cutscene. */
const ZOOM_IN_MS = 900;
const HOLD_MS = 650;
const ZOOM_OUT_MS = 850;
/** How much closer than the settled view to punch in, and the ceiling on
 * how close that can ever get (a scene that already opens zoomed in should
 * not zoom in AGAIN to something absurd). */
const ZOOM_IN_MULTIPLIER = 2;
const MAX_ZOOM_SCALE = 3;

/**
 * Run the intro zoom, if there is a token to run it on. Fails silently
 * (logged, never thrown) on any Foundry-API surprise — a missed intro zoom
 * is a cosmetic miss, never worth breaking scene load over.
 *
 * @returns {Promise<{ran: boolean, reason: string|null}>}
 */
export async function runSceneIntroZoom() {
  try {
    if (typeof canvas === 'undefined' || !canvas?.stage || typeof canvas.animatePan !== 'function') {
      return { ran: false, reason: 'no live canvas' };
    }
    // GMs have no single "my token" — zooming one to an arbitrary owned
    // token (a GM can own everything) would be surprising, not a courtesy.
    if (game?.user?.isGM) return { ran: false, reason: 'GM — no personal token to zoom to' };
    const token = resolveViewerToken();
    if (!token) return { ran: false, reason: 'no owned token on this scene' };

    // Capture whatever Foundry/MSA already decided the settled view should
    // be (scene.initial, a resumed position, whatever) — this is the
    // authoritative "normal play view" to return to, not something this
    // module re-derives on its own.
    const settled = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
    const zoomScale = Math.min(MAX_ZOOM_SCALE, settled.scale * ZOOM_IN_MULTIPLIER);

    await canvas.animatePan({ x: token.center.x, y: token.center.y, scale: zoomScale, duration: ZOOM_IN_MS });
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await canvas.animatePan({ ...settled, duration: ZOOM_OUT_MS });
    return { ran: true, reason: null };
  } catch (err) {
    log.error('scene intro zoom failed (non-fatal):', err);
    return { ran: false, reason: `threw: ${err?.message ?? err}` };
  }
}

/**
 * Schedule {@link runSceneIntroZoom} after the settle delay. Fire-and-forget
 * by design (the caller — boot.js's scene-load handler — must not await a
 * multi-second cinematic before considering scene load complete).
 */
export function scheduleSceneIntroZoom() {
  setTimeout(() => {
    void runSceneIntroZoom();
  }, SETTLE_DELAY_MS);
}
