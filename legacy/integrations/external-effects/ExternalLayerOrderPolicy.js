/**
 * @fileoverview ExternalLayerOrderPolicy — re-export of the
 * `externalEffectOrder` helper from `compositor-v2/LayerOrderPolicy.js`.
 *
 * The actual implementation lives next to the canonical role-band
 * definitions so that any future band reshuffling automatically updates
 * the external-effects mapping. This module exists only to keep the
 * import surface symmetric with the rest of the integration package.
 *
 * @module integrations/external-effects/ExternalLayerOrderPolicy
 */

export {
  externalEffectOrder,
  EXTERNAL_SORT_LAYER_BREAKPOINTS,
} from '../../compositor-v2/LayerOrderPolicy.js';
