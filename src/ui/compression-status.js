/**
 * @fileoverview ui/compression-status.js — a small, persistent, non-blocking
 * indicator for background GPU-texture compression, independent of the
 * cold-load curtain (ui/loading-screen.js).
 *
 * WHY THIS EXISTS (mythica-machina-press#435, 2026-09-02, author-reported —
 * "if it takes 5 minutes that reads as a bug, players/GMs will refresh or
 * disable the module trying to fix it"). First-time BC compression of a
 * large source image (vt/compressed-textures.js + vt/bc-compress.worker.js)
 * is genuine, serial, one-worker-at-a-time CPU work that can legitimately
 * take minutes for a big texture. Two places already wait for it honestly
 * and report progress while doing so — the cold-load curtain
 * (ui/loading-screen.js, gated at HARD_REVEAL_MS) and a floor switch
 * (vt-pan-viewer.js#prepareFloor) — but BOTH stop reporting the moment they
 * end, and neither covers every trigger:
 *
 *  - The cold-load curtain can, and on a big scene WILL, forcibly reveal the
 *    map at HARD_REVEAL_MS (30s) or on a manual "Show me anyway" click
 *    (SHOW_SKIP_AFTER_MS, 5s) while compression is still running — verified
 *    by reading loading-screen.js directly, not assumed. Once revealed,
 *    `endSceneLoad()` deletes the ENTIRE curtain DOM node
 *    (`document.getElementById(OVERLAY_ID)?.remove()`). Nothing survives
 *    afterward, despite that being the documented intent
 *    (load-progress.js's own header: "the curtain lifts and the unresolved
 *    blockers move to a corner note" — no such corner note was actually
 *    built anywhere; this file is that note, finally wired up).
 *  - A LIVE post-load texture change on the CURRENT floor — a GM editing a
 *    tile's `texture.src` directly (e.g. the Stage Manager macro), or
 *    placing a brand-new tile — goes through neither the cold-load curtain
 *    nor `prepareFloor` at all. Nothing waits for it and nothing reports it.
 *
 * Both gaps produce the identical real-world failure: a texture that is
 * correctly compressing in the background, and will correctly appear once
 * that job finishes, gives the person watching zero indication that
 * anything is happening in between. Read, accurately, as "the module is
 * broken" — the live report that opened #435 is exactly this: assumed
 * nothing was happening, refreshed repeatedly trying to "fix" it. On a cold
 * load this is worse than one tile: a whole party can be sitting in a
 * fully-revealed scene with missing or wrong art for several minutes with
 * nothing on screen to explain why.
 *
 * THE FIX HERE IS DELIBERATELY THE SMALLEST SAFE ONE. This module touches
 * NOTHING in the texture-loading/compression/mesh-rebuild pipeline itself —
 * every one of those files carries real device-loss/TDR scars from past
 * "obviously safe" changes (compressed-textures.js's own header: "NOT FIXED
 * BY ADDING WORKERS, deliberately"). This is a pure, independent, read-only
 * POLLER of state those files already export
 * (`getCompressedTextureStats().pending`, `getLoadingScreenState().showing`)
 * — it cannot change what gets compressed, when, or how, and a bug in this
 * file cannot itself cause a rendering regression. It is honest in the same
 * sense load-progress.js's header requires: it only ever reports a real
 * pending-job count already tracked elsewhere, never a guess, and it
 * disappears the instant that count reaches zero rather than lingering as a
 * stale claim.
 *
 * NOT a fix for the underlying wait itself — see #435 for the options
 * considered for that (build-time pre-compression is the strongest
 * candidate, tracked separately since it is a real project, not a same-day
 * change). This buys back the trust cost of the wait; it does not shorten
 * the wait.
 *
 * @module ui/compression-status
 */
import { getCompressedTextureStats } from '../vt/compressed-textures.js';
import { getLoadingScreenState } from './loading-screen.js';

const BADGE_ID = 'msa-compression-status';
const STYLE_ID = 'msa-compression-status-style';
/** Cheap object-property poll, not a render loop — no need for rAF cadence. */
const POLL_MS = 500;

let root = null;
let intervalHandle = null;

/** Mirrors loading-screen.js's own resolveHost() exactly (same host, same
 * reasoning) — not imported, because that one is a private module-local
 * helper there and duplicating four lines beats exporting a new public
 * surface from a file this sensitive for a single caller. */
function resolveHost() {
  const board = typeof document !== 'undefined' ? document.getElementById('board') : null;
  return board?.parentElement ?? document.body;
}

function ensureKeyframes() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `@keyframes msa-compression-status-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }`;
  document.head.appendChild(style);
}

function buildBadge() {
  const el = document.createElement('div');
  el.id = BADGE_ID;
  Object.assign(el.style, {
    position: 'absolute',
    left: '12px',
    bottom: '12px',
    // Above the VT canvas (5); below MSA's own floating rooms (Remote/
    // Studio/Player, 100) and their popovers (400) — see loading-screen.js's
    // own z-index note for that scale. This is an informational note, never
    // meant to contest a UI someone is actively using.
    zIndex: '90',
    display: 'none',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    borderRadius: '999px',
    background: 'rgba(7,11,18,0.82)',
    border: '1px solid rgba(143,214,255,0.35)',
    color: '#cfe8ff',
    font: '12px/1.4 Signika, sans-serif',
    userSelect: 'none',
    pointerEvents: 'none', // never swallow a click aimed at the scene underneath it
  });
  const dot = document.createElement('span');
  Object.assign(dot.style, {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: '#8fd6ff',
    flex: '0 0 auto',
    animation: 'msa-compression-status-pulse 1.4s ease-in-out infinite',
  });
  const text = document.createElement('span');
  el.append(dot, text);
  resolveHost().appendChild(el);
  return { el, text };
}

function tick() {
  if (!root) return;
  const pending = getCompressedTextureStats()?.pending ?? 0;
  // While the cold-load curtain is up it already reports this same number
  // honestly (its own blockers list) — showing both at once would be a
  // duplicate, not a second opinion.
  const curtainUp = !!getLoadingScreenState()?.showing;
  if (pending > 0 && !curtainUp) {
    root.el.style.display = 'flex';
    root.text.textContent =
      pending === 1
        ? 'Compressing 1 image for display — large images can take a few minutes the first time.'
        : `Compressing ${pending} images for display — large images can take a few minutes the first time.`;
  } else {
    root.el.style.display = 'none';
  }
}

/**
 * Start the badge. Idempotent — a second call is a no-op rather than a
 * second poller (mirrors installPlayer/installStudio's own one-shot-per-
 * client posture, boot.js). Safe to call once per client, GM or player
 * alike: every client runs its own MSA rendering pipeline and its own
 * texture cache, so every client independently pays this same cold-cache
 * cost and independently benefits from being told about it.
 * @returns {() => void} dispose
 */
export function installCompressionStatusBadge() {
  if (intervalHandle !== null) return () => {};
  if (typeof document === 'undefined') return () => {};
  ensureKeyframes();
  root = buildBadge();
  intervalHandle = setInterval(tick, POLL_MS);
  tick();
  return () => {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    root?.el.remove();
    root = null;
  };
}
