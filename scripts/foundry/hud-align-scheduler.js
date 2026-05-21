/**
 * Coalesce Foundry HUD alignment to at most one synchronous layout pass per frame.
 * canvas.pan() and CameraFollower both call hud.align(), which can trigger
 * elementsFromPoint and forced reflow — expensive during camera drag.
 *
 * @module foundry/hud-align-scheduler
 */

/** @type {number} */
let _rafId = 0;

/** @type {boolean} */
let _pending = false;

/** @type {(() => void)|null} */
let _originalAlign = null;

/**
 * @private
 */
function _invokeAlign() {
  try {
    if (!canvas?.hud?.rendered) return;
    if (typeof _originalAlign === 'function') {
      _originalAlign();
      return;
    }
    if (typeof canvas?.hud?.align === 'function') {
      canvas.hud.align();
    }
  } catch (_) {
  }
}

/**
 * Replace hud.align with a coalesced scheduler (Foundry pan → align no longer
 * forces layout on every pointermove tick).
 * @returns {boolean}
 */
export function installHudAlignCoalescer() {
  const hud = canvas?.hud;
  if (!hud || hud.__msaAlignCoalesced === true) return false;
  if (typeof hud.align !== 'function') return false;

  _originalAlign = hud.align.bind(hud);
  hud.align = function msaCoalescedHudAlign() {
    scheduleHudAlign();
  };
  hud.__msaAlignCoalesced = true;
  return true;
}

/**
 * Schedule hud.align on the next animation frame (coalesced).
 */
export function scheduleHudAlign() {
  if (!canvas?.hud) return;
  if (_pending) return;
  _pending = true;
  // Defer two frames so align/layout does not share the compositor rAF (~18ms GPU).
  _rafId = requestAnimationFrame(() => {
    _rafId = requestAnimationFrame(() => {
      _pending = false;
      _rafId = 0;
      _invokeAlign();
    });
  });
}

/**
 * Run hud.align immediately (e.g. end of camera drag).
 */
export function flushHudAlign() {
  if (_rafId) {
    cancelAnimationFrame(_rafId);
    _rafId = 0;
  }
  _pending = false;
  _invokeAlign();
}

/**
 * Cancel a pending align without running it.
 */
export function cancelHudAlign() {
  if (_rafId) {
    cancelAnimationFrame(_rafId);
    _rafId = 0;
  }
  _pending = false;
}
