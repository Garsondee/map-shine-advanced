import { createLogger } from '../log.js';

const log = createLogger('HealthContractRegistry');

/**
 * Lightweight contract registry for staged rollout.
 */
export class HealthContractRegistry {
  constructor() {
    /** @type {Map<string, any>} */
    this._contracts = new Map();
  }

  register(effectId, contract) {
    const id = String(effectId || '').trim();
    if (!id) return false;
    if (!contract || typeof contract !== 'object') return false;
    this._contracts.set(id, contract);
    return true;
  }

  unregister(effectId) {
    return this._contracts.delete(String(effectId || ''));
  }

  get(effectId) {
    return this._contracts.get(String(effectId || '')) || null;
  }

  getAll() {
    return Array.from(this._contracts.values());
  }

  clear() {
    this._contracts.clear();
    log.debug('Contracts cleared');
  }
}

