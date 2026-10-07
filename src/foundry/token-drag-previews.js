/**
 * THE DRAG-PREVIEW READER — the one place MSA looks at `canvas.tokens.preview`.
 *
 * When a token is dragged, Foundry does NOT move it. `PlaceableObject#
 * _initializeDragLeft` (placeable-object.mjs:1346) clones every dragged token,
 * tags the clone `previewType: "dragging"`, parks it in `canvas.tokens.preview`
 * and from then on moves only the clone — `Token.#updateDragPreview` writes the
 * destination into `clone.document.x/y/elevation/...` on every pointer move. The
 * real token stays put until the drop, drawn at 0.4 alpha while its clone is
 * drawn at 0.8 (`_getTargetAlpha`, placeable-object.mjs:640).
 *
 * MSA draws tokens from SCENE documents, and a clone's document is not a scene
 * document (`canvas.scene.tokens` never contains it), so before this existed the
 * clone's art went into Foundry's suppressed `primary` group and nothing drew
 * it: you dragged an outline with no picture (see canvas-compositing.js's "NOT
 * DONE HERE" note, which named exactly this gap).
 *
 * This hands the clones' own TokenDocuments to `collectTokens`, which turns each
 * into a ghost item. Handing over the DOCUMENT, not a snapshot of its fields, is
 * the point: `computeItemPlacement` re-reads the document every frame (see
 * scene-layers.js), so the ghost follows the cursor with no further wiring — the
 * same mechanism a real token's movement already relies on.
 *
 * @module foundry/token-drag-previews
 */

import { createLogger } from '../core/log.js';

const log = createLogger('token-drag-previews');

/**
 * Every live drag-preview clone, as `{originalId, document}`.
 *
 * `previewType === "dragging"` ONLY. The same container also holds "config"
 * previews (the Token Config sheet editing live) and "creation" previews (placing
 * an actor from the sidebar); those are different workflows with different ids
 * and are deliberately not ghosted here.
 *
 * A clone that is mid-`destroy()` is skipped: Foundry fires `destroyToken` BEFORE
 * the clone leaves its parent in some paths (`#cancelDrag`), and `destroy()` has
 * already marked its document `_destroyed` by then. Without this the ghost would
 * survive until the next unrelated refresh.
 *
 * @returns {Array<{originalId: string, document: object}>}
 */
export function readTokenDragPreviews() {
  try {
    const children = globalThis.canvas?.tokens?.preview?.children;
    if (!children?.length) return [];
    const previews = [];
    for (const clone of children) {
      if (clone?.previewType !== 'dragging') continue;
      if (clone.destroyed || clone.document?._destroyed) continue;
      // `clone()` is called with `keepId: true`, so the clone's own document id IS
      // the original's; `_original` is the explicit link and is preferred.
      const originalId = clone._original?.document?.id ?? clone.document?.id;
      if (!originalId || !clone.document) continue;
      previews.push({ originalId, document: clone.document });
    }
    return previews;
  } catch (err) {
    log.error('reading canvas.tokens.preview failed — drag ghosts skipped this pass:', err);
    return [];
  }
}

/**
 * Tell `onChange` whenever a drag preview appears or goes away.
 *
 * Foundry fires no hook for "a drag started", but it does fire the generic
 * `drawToken` (end of `PlaceableObject#draw`, placeable-object.mjs:546) and
 * `destroyToken` (`destroy()`, :510) for EVERY token object, previews included —
 * a clone is drawn once when the drag starts and destroyed when it ends or is
 * cancelled. Movement of an existing ghost needs no event at all (see this file's
 * header); only its arrival and departure change the draw list.
 *
 * Registered once for the session; the handlers ignore every non-preview token.
 *
 * @param {(hookName: string) => void} onChange
 */
export function watchTokenDragPreviews(onChange) {
  for (const hook of ['drawToken', 'destroyToken']) {
    Hooks.on(hook, (token) => {
      if (token?.previewType !== 'dragging') return;
      onChange(`${hook}:dragPreview`);
    });
  }
}
