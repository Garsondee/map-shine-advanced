import { createLogger } from '../core/log.js';

const log = createLogger('EmitterManager');

/**
 * EmitterManager bridges Foundry/engine events to GPU particle emitters.
 * This is a minimal scaffold; concrete hooks will be added in later steps.
 */
export class EmitterManager {
  constructor() {
    /** @type {Array<Object>} */
    this.emitters = [];
  }

  /**
   * Register a one-shot or continuous emitter.
   * @param {Object} options
   * @returns {Object} handle
   */
  addEmitter(options) {
    log.info(`Adding emitter type ${options.type} at (${options.x}, ${options.y}, ${options.z}) rate=${options.rate}`);
    const handle = {
      id: crypto.randomUUID(),
      x: options.x ?? 0,
      y: options.y ?? 0,
      z: options.z ?? 0,
      type: options.type ?? 0,
      rate: options.rate ?? 0,
      param1: options.param1 ?? 0,
      param2: options.param2 ?? 0,
      active: true
    };

    this.emitters.push(handle);
    return handle;
  }

  /**
   * Mark an emitter as inactive.
   * @param {string} id
   */
  removeEmitter(id) {
    const emitter = this.emitters.find(e => e.id === id);
    if (emitter) {
      emitter.active = false;
      log.debug(`Removed emitter ${id}`);
    }
  }

  /**
   * Build a compact list for ParticleBuffers.updateEmitters().
   * @returns {Array<Object>}
   */
  buildFrameEmitList() {
    const list = this.emitters.filter(e => e.active && e.rate > 0).map(e => ({
      x: e.x,
      y: e.y,
      z: e.z,
      type: e.type,
      count: e.rate,
      param1: e.param1,
      param2: e.param2
    }));
    
    if (list.length > 0) {
      log.debug(`Built frame emit list with ${list.length} active emitters`);
    }
    
    return list;
  }
}
