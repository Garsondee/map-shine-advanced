/**
 * @fileoverview Abstraction layer for Game System specific logic.
 *
 * Uses an adapter pattern so every system-specific data-path lookup is
 * centralised here instead of scattered across managers.
 *
 * Architecture:
 *   GameSystemManager  — singleton, detects system, creates adapter, proxies API
 *   BaseSystemAdapter  — default Foundry-standard implementations
 *   DnD5eAdapter       — D&D 5th Edition overrides
 *   PF2eAdapter        — Pathfinder 2nd Edition overrides
 *
 * Consumers access the manager via  window.MapShine.gameSystem  (set by bootstrap).
 *
 * @module core/game-system
 */

import { createLogger } from './log.js';

const log = createLogger('GameSystem');

/* ======================================================================== */
/*  Helpers                                                                  */
/* ======================================================================== */

/**
 * Safely read a deeply nested property.
 * @param {object} obj
 * @param {string} path  Dot-separated path, e.g. "system.attributes.hp.value"
 * @returns {*}
 */
function _get(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/* ======================================================================== */
/*  BaseSystemAdapter                                                        */
/* ======================================================================== */

/**
 * Default adapter using Foundry-standard API paths.
 * System-specific adapters extend this and override only what differs.
 */
class BaseSystemAdapter {
  /** Human-readable label for logs / UI. */
  get label() { return 'Generic'; }

  // -- Vision ---------------------------------------------------------------

  /**
   * Whether a token has vision enabled.
   * @param {Token|TokenDocument} object
   * @returns {boolean}
   */
  hasTokenVision(object) {
    if (!object) return false;
    const doc = object.document || object;
    if (doc.sight?.enabled || doc.sight?.range > 0) return true;
    if (object.hasSight) return true;
    return false;
  }

  /**
   * Effective vision radius in *scene distance units* (feet / metres / etc.).
   * @param {Token} token  PIXI Token placeable
   * @returns {number}  0 means no vision
   */
  getTokenVisionRadius(token) {
    if (!token) return 0;
    const docRange = token.document?.sight?.range;
    if (typeof docRange === 'number' && docRange > 0) return docRange;
    if (token.hasSight) return 1000; // Effectively unlimited fallback
    return 0;
  }

  // -- Movement -------------------------------------------------------------

  /**
   * Primary land movement speed in scene distance units.
   * @param {TokenDocument} tokenDoc
   * @returns {number|null}  null = unknown / not applicable
   */
  getTokenMovementSpeed(tokenDoc) {
    // Foundry core doesn't define a standard attribute path for speed;
    // system adapters must override.
    return null;
  }

  // -- Health ---------------------------------------------------------------

  /**
   * @param {TokenDocument} tokenDoc
   * @returns {number|null}
   */
  getTokenHP(tokenDoc) {
    const bar = tokenDoc?.getBarAttribute?.('bar1');
    return bar?.value ?? null;
  }

  /**
   * @param {TokenDocument} tokenDoc
   * @returns {number|null}
   */
  getTokenMaxHP(tokenDoc) {
    const bar = tokenDoc?.getBarAttribute?.('bar1');
    return bar?.max ?? null;
  }

  // -- Defence / AC ---------------------------------------------------------

  /**
   * @param {TokenDocument} tokenDoc
   * @returns {number|null}
   */
  getTokenAC(tokenDoc) {
    return null; // No standard path — system adapters override.
  }

  // -- Defeated / death state -----------------------------------------------

  /**
   * Whether the token should be considered "defeated" (dead / dying / KO).
   * @param {TokenDocument} tokenDoc
   * @returns {boolean}
   */
  isTokenDefeated(tokenDoc) {
    // Foundry core: combatant defeated flag
    const combatant = game?.combat?.getCombatantByToken?.(tokenDoc?.id);
    if (combatant?.isDefeated) return true;
    // HP-based fallback
    const hp = this.getTokenHP(tokenDoc);
    if (hp !== null && hp <= 0) return true;
    return false;
  }

  // -- Template geometry ----------------------------------------------------

  /**
   * Default cone angle in degrees used when the user places a cone template.
   * DnD 5e = 53.13°, PF2e = 90° (varies by distance), many others = 53.13°.
   * @returns {number}
   */
  getDefaultConeAngle() {
    return 53.13;
  }

  // -- Token bar attribute paths --------------------------------------------

  /**
   * Return the *attribute key string* that a given bar index should display.
   * @param {TokenDocument} tokenDoc
   * @param {0|1} barIndex  0 = bar1, 1 = bar2
   * @returns {string|null}  e.g. "attributes.hp"
   */
  getTokenBarAttributePath(tokenDoc, barIndex) {
    const barKey = barIndex === 0 ? 'bar1' : 'bar2';
    return tokenDoc?.[barKey]?.attribute ?? null;
  }

  // -- Initiative -----------------------------------------------------------

  /**
   * Initiative modifier / bonus for the token.
   * @param {TokenDocument} tokenDoc
   * @returns {number|null}
   */
  getTokenInitiativeBonus(tokenDoc) {
    return null;
  }

  // -- Conditions / status effects ------------------------------------------

  /**
   * Return the list of system condition definitions.
   * Each entry: { id: string, label: string, icon: string }
   * @returns {Array<{id: string, label: string, icon: string}>}
   */
  getConditions() {
    // Foundry core exposes CONFIG.statusEffects
    try {
      return (CONFIG?.statusEffects ?? []).map(e => ({
        id: e.id ?? e._id ?? '',
        label: e.label ?? e.name ?? '',
        icon: e.icon ?? e.img ?? ''
      }));
    } catch (_) { return []; }
  }

  // -- Utility --------------------------------------------------------------

  /**
   * Convert scene distance units to pixels.
   * @param {number} distance
   * @returns {number}
   */
  distanceToPixels(distance) {
    if (!canvas?.dimensions) return 0;
    return (distance / canvas.dimensions.distance) * canvas.dimensions.size;
  }
}

/* ======================================================================== */
/*  DnD5eAdapter                                                             */
/* ======================================================================== */

class DnD5eAdapter extends BaseSystemAdapter {
  get label() { return 'D&D 5th Edition'; }

  // -- Vision ---------------------------------------------------------------

  getTokenVisionRadius(token) {
    if (!token) return 0;
    const docRange = token.document?.sight?.range;
    if (typeof docRange === 'number' && docRange > 0) return docRange;

    const senses = token.actor?.system?.attributes?.senses;
    if (senses) {
      const max = Math.max(
        senses.darkvision || 0,
        senses.blindsight || 0,
        senses.tremorsense || 0,
        senses.truesight || 0
      );
      if (max > 0) return max;
    }

    if (token.hasSight) return 1000;
    return 0;
  }

  // -- Movement -------------------------------------------------------------

  getTokenMovementSpeed(tokenDoc) {
    // dnd5e: actor.system.attributes.movement.walk  (in feet)
    const walk = _get(tokenDoc, 'actor.system.attributes.movement.walk');
    if (typeof walk === 'number' && walk > 0) return walk;
    // Older dnd5e versions used "speed.value"
    const legacy = _get(tokenDoc, 'actor.system.attributes.speed.value');
    if (typeof legacy === 'number' && legacy > 0) return legacy;
    return null;
  }

  // -- Health ---------------------------------------------------------------

  getTokenHP(tokenDoc) {
    const hp = _get(tokenDoc, 'actor.system.attributes.hp.value');
    return typeof hp === 'number' ? hp : super.getTokenHP(tokenDoc);
  }

  getTokenMaxHP(tokenDoc) {
    const hp = _get(tokenDoc, 'actor.system.attributes.hp.max');
    return typeof hp === 'number' ? hp : super.getTokenMaxHP(tokenDoc);
  }

  // -- AC -------------------------------------------------------------------

  getTokenAC(tokenDoc) {
    const ac = _get(tokenDoc, 'actor.system.attributes.ac.value');
    return typeof ac === 'number' ? ac : null;
  }

  // -- Defeated -------------------------------------------------------------

  isTokenDefeated(tokenDoc) {
    const hp = this.getTokenHP(tokenDoc);
    if (hp !== null && hp <= 0) return true;
    return super.isTokenDefeated(tokenDoc);
  }

  // -- Templates ------------------------------------------------------------

  getDefaultConeAngle() {
    // D&D 5e: standard cone is 53.13° (equilateral-ish triangle)
    return 53.13;
  }

  // -- Initiative -----------------------------------------------------------

  getTokenInitiativeBonus(tokenDoc) {
    const mod = _get(tokenDoc, 'actor.system.attributes.init.total');
    if (typeof mod === 'number') return mod;
    const legacy = _get(tokenDoc, 'actor.system.attributes.init.mod');
    return typeof legacy === 'number' ? legacy : null;
  }
}

/* ======================================================================== */
/*  PF2eAdapter                                                              */
/* ======================================================================== */

class PF2eAdapter extends BaseSystemAdapter {
  get label() { return 'Pathfinder 2nd Edition'; }

  // -- Vision ---------------------------------------------------------------

  hasTokenVision(object) {
    if (super.hasTokenVision(object)) return true;
    const actor = object?.actor ?? (object?.document || object)?.actor;
    if (actor) {
      // PF2e perception.vision boolean
      if (actor.system?.perception?.vision === true) return true;
      // Senses array implies vision capability
      const senses = actor.system?.traits?.senses;
      if (Array.isArray(senses) && senses.length > 0) return true;
    }
    return false;
  }

  getTokenVisionRadius(token) {
    if (!token) return 0;
    const docRange = token.document?.sight?.range;
    if (typeof docRange === 'number' && docRange > 0) return docRange;

    const actor = token.actor;
    if (actor) {
      // Normal vision in PF2e is unlimited in bright light — use a very large radius.
      if (actor.system?.perception?.vision === true) return 10000;

      // Specific senses with ranges (darkvision 60 ft, etc.)
      const senses = actor.system?.perception?.senses;
      if (Array.isArray(senses) && senses.length > 0) {
        let maxRange = 0;
        for (const s of senses) {
          if (s.range && s.range > maxRange) maxRange = s.range;
        }
        return maxRange > 0 ? maxRange : 10000;
      }
    }

    if (token.hasSight) return 1000;
    return 0;
  }

  // -- Movement -------------------------------------------------------------

  getTokenMovementSpeed(tokenDoc) {
    // PF2e: actor.system.attributes.speed.value  (in feet, base land speed)
    const speed = _get(tokenDoc, 'actor.system.attributes.speed.value');
    if (typeof speed === 'number' && speed > 0) return speed;
    // Total might include item bonuses
    const total = _get(tokenDoc, 'actor.system.attributes.speed.total');
    if (typeof total === 'number' && total > 0) return total;
    return null;
  }

  // -- Health ---------------------------------------------------------------

  getTokenHP(tokenDoc) {
    const hp = _get(tokenDoc, 'actor.system.attributes.hp.value');
    return typeof hp === 'number' ? hp : super.getTokenHP(tokenDoc);
  }

  getTokenMaxHP(tokenDoc) {
    const hp = _get(tokenDoc, 'actor.system.attributes.hp.max');
    return typeof hp === 'number' ? hp : super.getTokenMaxHP(tokenDoc);
  }

  // -- AC -------------------------------------------------------------------

  getTokenAC(tokenDoc) {
    const ac = _get(tokenDoc, 'actor.system.attributes.ac.value');
    return typeof ac === 'number' ? ac : null;
  }

  // -- Defeated -------------------------------------------------------------

  isTokenDefeated(tokenDoc) {
    // PF2e: dying condition or HP <= 0
    const hp = this.getTokenHP(tokenDoc);
    if (hp !== null && hp <= 0) return true;
    // Check for "dying" condition via Foundry effects
    try {
      const effects = tokenDoc?.actor?.effects;
      if (effects) {
        for (const e of effects) {
          const slug = e.flags?.pf2e?.condition?.slug ?? e.name?.toLowerCase?.();
          if (slug === 'dying' || slug === 'dead') return true;
        }
      }
    } catch (_) { /* safe fallback */ }
    return super.isTokenDefeated(tokenDoc);
  }

  // -- Templates ------------------------------------------------------------

  getDefaultConeAngle() {
    // PF2e: cones default to 90° (2-action Breath Weapon, etc.)
    // Some abilities use different angles but 90° is the system default.
    return 90;
  }

  // -- Initiative -----------------------------------------------------------

  getTokenInitiativeBonus(tokenDoc) {
    // PF2e initiative is usually Perception or a skill.
    // The modifier is at actor.system.attributes.perception.value or .totalModifier
    const perc = _get(tokenDoc, 'actor.system.attributes.perception.totalModifier');
    if (typeof perc === 'number') return perc;
    const val = _get(tokenDoc, 'actor.system.attributes.perception.value');
    return typeof val === 'number' ? val : null;
  }

  // -- Conditions -----------------------------------------------------------

  getConditions() {
    // PF2e defines conditions in game.pf2e.ConditionManager or CONFIG.PF2E.conditions
    try {
      const pf2eConditions = CONFIG?.PF2E?.conditions;
      if (pf2eConditions && typeof pf2eConditions === 'object') {
        return Object.entries(pf2eConditions).map(([id, data]) => ({
          id,
          label: typeof data === 'string' ? data : (data?.name ?? data?.label ?? id),
          icon: data?.icon ?? data?.img ?? ''
        }));
      }
    } catch (_) { /* fall through */ }
    return super.getConditions();
  }
}

/* ======================================================================== */
/*  Adapter Registry                                                         */
/* ======================================================================== */

/** Map of system IDs to adapter constructors. */
const ADAPTER_REGISTRY = {
  'dnd5e': DnD5eAdapter,
  'pf2e': PF2eAdapter,
};

/* ======================================================================== */
/*  GameSystemManager                                                        */
/* ======================================================================== */

/**
 * Singleton manager that detects the active game system, instantiates the
 * appropriate adapter, and proxies all system-specific queries through it.
 *
 * Consumers call  `gsm.getTokenHP(tokenDoc)`  etc. — the manager delegates to
 * the active adapter whose overrides handle system-specific data paths.
 */
export class GameSystemManager {
  constructor() {
    /** @type {string} */
    this.systemId = game?.system?.id || 'unknown';
    /** @type {string} Human-readable system title */
    this.systemTitle = game?.system?.title || this.systemId;

    /** @type {BaseSystemAdapter} */
    this.adapter = this._createAdapter();

    /** @type {boolean} */
    this.isInitialized = false;

    log.info(`Detected system: ${this.systemTitle} (${this.systemId}) → adapter: ${this.adapter.label}`);
  }

  /**
   * Initialise system-specific hooks or deferred setup.
   */
  initialize() {
    this.isInitialized = true;
    log.info(`GameSystemManager initialised (adapter: ${this.adapter.label})`);
  }

  // -- System identity helpers (convenience) --------------------------------

  /** @returns {boolean} */
  isPF2e() { return this.systemId === 'pf2e'; }
  /** @returns {boolean} */
  isDnD5e() { return this.systemId === 'dnd5e'; }

  // -- Proxied adapter API --------------------------------------------------
  // Each method delegates to the active adapter so callers don't need to know
  // which system is running.

  /** @see BaseSystemAdapter#hasTokenVision */
  hasTokenVision(object) { return this.adapter.hasTokenVision(object); }

  /** @see BaseSystemAdapter#getTokenVisionRadius */
  getTokenVisionRadius(token) { return this.adapter.getTokenVisionRadius(token); }

  /** @see BaseSystemAdapter#getTokenMovementSpeed */
  getTokenMovementSpeed(tokenDoc) { return this.adapter.getTokenMovementSpeed(tokenDoc); }

  /** @see BaseSystemAdapter#getTokenHP */
  getTokenHP(tokenDoc) { return this.adapter.getTokenHP(tokenDoc); }

  /** @see BaseSystemAdapter#getTokenMaxHP */
  getTokenMaxHP(tokenDoc) { return this.adapter.getTokenMaxHP(tokenDoc); }

  /** @see BaseSystemAdapter#getTokenAC */
  getTokenAC(tokenDoc) { return this.adapter.getTokenAC(tokenDoc); }

  /** @see BaseSystemAdapter#isTokenDefeated */
  isTokenDefeated(tokenDoc) { return this.adapter.isTokenDefeated(tokenDoc); }

  /** @see BaseSystemAdapter#getDefaultConeAngle */
  getDefaultConeAngle() { return this.adapter.getDefaultConeAngle(); }

  /** @see BaseSystemAdapter#getTokenBarAttributePath */
  getTokenBarAttributePath(tokenDoc, barIndex) { return this.adapter.getTokenBarAttributePath(tokenDoc, barIndex); }

  /** @see BaseSystemAdapter#getTokenInitiativeBonus */
  getTokenInitiativeBonus(tokenDoc) { return this.adapter.getTokenInitiativeBonus(tokenDoc); }

  /** @see BaseSystemAdapter#getConditions */
  getConditions() { return this.adapter.getConditions(); }

  /** @see BaseSystemAdapter#distanceToPixels */
  distanceToPixels(distance) { return this.adapter.distanceToPixels(distance); }

  // -- Internal -------------------------------------------------------------

  /**
   * Create the correct adapter for the detected system.
   * Falls back to BaseSystemAdapter (generic) for unknown systems.
   * @returns {BaseSystemAdapter}
   * @private
   */
  _createAdapter() {
    const AdapterClass = ADAPTER_REGISTRY[this.systemId];
    if (AdapterClass) return new AdapterClass();
    log.info(`No dedicated adapter for "${this.systemId}" — using generic fallback`);
    return new BaseSystemAdapter();
  }
}
