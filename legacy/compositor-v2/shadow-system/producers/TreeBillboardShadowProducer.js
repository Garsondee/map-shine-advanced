/**
 * Re-export for call sites that expected a dedicated producer class. Canopy
 * billboard lit-factor RTs are built by {@link VegetationBillboardShadowPass}
 * in {@link FloorCompositor#_prepareVegetationBillboardShadowPasses} and combined
 * in {@link ShadowManagerV2}.
 */
export { TreeEffectV2 as TreeBillboardShadowProducer } from '../../effects/TreeEffectV2.js';
