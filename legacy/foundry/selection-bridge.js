import { createLogger } from '../core/log.js';

const log = createLogger('SelectionBridge');

function _reassertManualLevelsPerspective() {
  const ctx = window.MapShine?.cameraFollower?.getActiveLevelContext?.() || window.MapShine?.activeLevelContext;
  if (!ctx || ctx.lockMode !== 'manual') return;

  const elevation = Number(ctx.center ?? ctx.bottom);
  if (!Number.isFinite(elevation)) return;

  try {
    if (globalThis.WallHeight && globalThis.WallHeight.currentTokenElevation !== elevation) {
      globalThis.WallHeight.currentTokenElevation = elevation;
    }
  } catch (_) {
  }

  try {
    const levels = globalThis.CONFIG?.Levels;
    if (levels && levels.currentToken != null) {
      levels.currentToken = null;
    }
  } catch (_) {
  }
}

/**
 * Apply an authoritative token controlled-set into Foundry.
 * This keeps module interoperability while allowing Three.js to own selection input.
 *
 * @param {Iterable<string>} desiredTokenIds
 */
export function applyControlledTokenSet(desiredTokenIds) {
  const desired = new Set(
    Array.from(desiredTokenIds || [])
      .map((id) => String(id || '').trim())
      .filter((id) => id.length > 0)
  );

  const controlled = canvas?.tokens?.controlled;
  const current = new Set(
    Array.isArray(controlled)
      ? controlled
          .map((token) => String(token?.id || token?.document?.id || '').trim())
          .filter((id) => id.length > 0)
      : []
  );

  /** @type {string[]} */
  const toRelease = [];
  for (const id of current) {
    if (!desired.has(id)) toRelease.push(id);
  }

  /** @type {string[]} */
  const toControl = [];
  for (const id of desired) {
    if (!current.has(id)) toControl.push(id);
  }

  // Release first so additions are deterministic and don't depend on releaseOthers behavior.
  for (const id of toRelease) {
    try {
      const token = canvas?.tokens?.get?.(id);
      token?.release?.();
    } catch (_) {
    }
  }

  for (const id of toControl) {
    try {
      const token = canvas?.tokens?.get?.(id);
      token?.control?.({ releaseOthers: false, pan: false });
    } catch (_) {
    }
  }

  if (toRelease.length > 0 || toControl.length > 0) {
    // Keep manual floor mode authoritative even when Foundry token control
    // events trigger Levels perspective rebinding.
    _reassertManualLevelsPerspective();

    log.debug('Applied controlled token set', {
      desiredCount: desired.size,
      released: toRelease.length,
      controlled: toControl.length
    });
  }
}
