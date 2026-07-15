import { createLogger } from '../core/log.js';
import { applyControlledTokenSet } from '../foundry/selection-bridge.js';
import {
  isTokenBelowActiveLevel,
  isTokenDragSelectable,
  shouldRestrictMarqueeToActiveLevel,
  switchToLevelForElevation
} from './level-interaction-service.js';

const log = createLogger('TokenSelectionController');

export class TokenSelectionController {
  /**
   * @param {import('./interaction-manager.js').InteractionManager} interactionManager
   */
  constructor(interactionManager) {
    this.im = interactionManager;
    this._syncInFlight = false;
    this._resyncQueued = false;
  }

  /** @returns {Set<string>} */
  getSelectedTokenIds() {
    const ids = new Set();
    for (const id of this.im.selection) {
      if (this.im.tokenManager?.tokenSprites?.has?.(id)) ids.add(String(id));
    }
    return ids;
  }

  /**
   * @param {string|null|undefined} tokenId
   * @param {{ additive?: boolean, toggle?: boolean, autoSwitchFloor?: boolean }} [options]
   */
  selectSingle(tokenId, options = {}) {
    const id = String(tokenId || '').trim();
    if (!id) return;

    const tokenData = this.im.tokenManager?.tokenSprites?.get?.(id);
    const tokenDoc = tokenData?.tokenDoc;
    if (!tokenDoc?.canUserModify?.(game.user, 'update')) return;

    const additive = !!options.additive;
    const toggle = !!options.toggle;
    const next = this.getSelectedTokenIds();

    if (!additive && !toggle) {
      this.im.clearSelection();
      next.clear();
      next.add(id);
    } else if (toggle) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else {
      next.add(id);
    }

    this._applyTokenSelectionSet(next);

    if (options.autoSwitchFloor !== false && isTokenBelowActiveLevel(tokenDoc)) {
      switchToLevelForElevation(Number(tokenDoc.elevation ?? 0), 'level-interaction-click-select');
    }
  }

  /**
   * @param {{minX:number,maxX:number,minY:number,maxY:number}} worldRect
   * @param {{ additive?: boolean, subtractive?: boolean }} [options]
   * @returns {Array<any>} token docs selected by the marquee after filtering
   */
  selectByMarquee(worldRect, options = {}) {
    const additive = !!options.additive;
    const subtractive = !!options.subtractive;

    const minX = Number(worldRect?.minX);
    const maxX = Number(worldRect?.maxX);
    const minY = Number(worldRect?.minY);
    const maxY = Number(worldRect?.maxY);
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
      return [];
    }

    const insideIds = new Set();
    const selectedDocs = [];
    const tokens = this.im.tokenManager?.getAllTokenSprites?.() || [];
    const activeLevelOnly = shouldRestrictMarqueeToActiveLevel();

    for (const sprite of tokens) {
      const x = Number(sprite?.position?.x);
      const y = Number(sprite?.position?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;

      const tokenDoc = sprite?.userData?.tokenDoc;
      if (!tokenDoc?.canUserModify?.(game.user, 'update')) continue;
      if (!isTokenDragSelectable(sprite, this.im.tileManager, { activeLevelOnly, allowBelowOnly: true })) continue;

      const id = String(tokenDoc.id || '').trim();
      if (!id) continue;
      insideIds.add(id);
      selectedDocs.push(tokenDoc);
    }

    let next = this.getSelectedTokenIds();
    if (!additive && !subtractive) {
      this.im.clearSelection();
      next = new Set(insideIds);
    } else if (subtractive) {
      for (const id of insideIds) next.delete(id);
    } else {
      for (const id of insideIds) next.add(id);
    }

    this._applyTokenSelectionSet(next);
    return selectedDocs;
  }

  /** @param {{ preserveNonToken?: boolean }} [options] */
  clearTokenSelection(options = {}) {
    if (!options.preserveNonToken) {
      this.im.clearSelection();
      this._syncFoundryControlledSet(new Set());
      return;
    }

    const tokenIds = this.getSelectedTokenIds();
    for (const id of tokenIds) {
      this.im.tokenManager?.setTokenSelection?.(id, false);
      this.im.selection.delete(id);
    }

    this._syncFoundryControlledSet(new Set());
  }

  /**
   * @param {Set<string>} nextIds
   * @private
   */
  _applyTokenSelectionSet(nextIds) {
    const tokenIds = new Set(
      Array.from(nextIds || [])
        .map((id) => String(id || '').trim())
        .filter((id) => this.im.tokenManager?.tokenSprites?.has?.(id))
    );

    const currentIds = this.getSelectedTokenIds();

    for (const id of currentIds) {
      if (tokenIds.has(id)) continue;
      this.im.tokenManager?.setTokenSelection?.(id, false);
      this.im.selection.delete(id);
    }

    for (const id of tokenIds) {
      this.im.tokenManager?.setTokenSelection?.(id, true);
      this.im.selection.add(id);
    }

    this._syncFoundryControlledSet(tokenIds);
  }

  /**
   * @param {Set<string>} tokenIds
   * @private
   */
  _syncFoundryControlledSet(tokenIds) {
    if (this._syncInFlight) {
      this._resyncQueued = true;
      return;
    }

    this._syncInFlight = true;
    try {
      applyControlledTokenSet(tokenIds);
    } catch (error) {
      log.warn('Failed to sync controlled token set', error);
    } finally {
      this._syncInFlight = false;
      if (this._resyncQueued) {
        this._resyncQueued = false;
        this._syncFoundryControlledSet(this.getSelectedTokenIds());
      }
    }
  }
}
