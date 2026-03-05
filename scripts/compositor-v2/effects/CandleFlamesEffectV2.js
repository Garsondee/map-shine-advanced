/**
 * @fileoverview V2 adapter for CandleFlamesEffect with lazy runtime loading.
 *
 * IMPORTANT: This file intentionally avoids a static import of
 * ../../effects/CandleFlamesEffect.js. A static import creates an ES module
 * cycle through EffectComposer/EffectBase in V2 startup.
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('CandleFlamesEffectV2');

export class CandleFlamesEffectV2 {
  constructor() {
    this.id = 'candle-flames';
    this.priority = 8;
    this.floorScope = 'global';

    this.params = { enabled: true };

    this._delegate = null;
    this._delegateLoadPromise = null;

    this._initArgs = null;
    this._lightingEffect = null;
    this._mapPointsManager = null;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
      },
    };
  }

  get enabled() {
    return !!this.params?.enabled;
  }

  set enabled(value) {
    const v = !!value;
    this.params.enabled = v;
    if (this._delegate) {
      this._delegate.params.enabled = v;
      this._delegate._applyVisibility?.();
    }
  }

  async _ensureDelegate() {
    if (this._delegate) return this._delegate;
    if (this._delegateLoadPromise) return this._delegateLoadPromise;

    this._delegateLoadPromise = (async () => {
      const mod = await import('../../effects/CandleFlamesEffect.js');
      const DelegateCtor = mod.CandleFlamesEffect || mod.default;
      if (typeof DelegateCtor !== 'function') {
        throw new Error('CandleFlamesEffect delegate class not found');
      }

      const delegate = new DelegateCtor();
      delegate.id = this.id;
      delegate.priority = this.priority;
      delegate.floorScope = this.floorScope;
      delegate.params.enabled = !!this.params.enabled;

      this._delegate = delegate;
      this.params = delegate.params;

      if (this._initArgs) {
        const [renderer, scene, camera] = this._initArgs;
        delegate.initialize?.(renderer, scene, camera);
      }

      if (this._lightingEffect) {
        delegate.setLightingEffect?.(this._lightingEffect);
      }
      if (this._mapPointsManager) {
        delegate.setMapPointsSources?.(this._mapPointsManager);
      }

      return delegate;
    })().catch((err) => {
      log.error('Failed to lazy-load CandleFlamesEffect delegate:', err);
      this._delegateLoadPromise = null;
      throw err;
    });

    return this._delegateLoadPromise;
  }

  initialize(renderer, scene, camera) {
    this._initArgs = [renderer, scene, camera];
    void this._ensureDelegate();
  }

  setLightingEffect(lightingEffect) {
    this._lightingEffect = lightingEffect || null;
    this._delegate?.setLightingEffect?.(lightingEffect);
  }

  setMapPointsSources(manager) {
    this._mapPointsManager = manager || null;
    this._delegate?.setMapPointsSources?.(manager);
  }

  applyParamChange(paramId, value) {
    if (paramId === 'enabled') this.enabled = value;
    this._delegate?.applyParamChange?.(paramId, value);
  }

  update(timeInfo) {
    this._delegate?.update?.(timeInfo);
  }

  render() {
    this._delegate?.render?.();
  }

  onFloorChange(_maxFloorIndex) {}

  onResize(_width, _height) {}

  dispose() {
    this._delegate?.dispose?.();
    this._delegate = null;
    this._delegateLoadPromise = null;
  }
}

export default CandleFlamesEffectV2;
