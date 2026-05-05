/**
 * @fileoverview Built-in V3 illumination terms.
 *
 * Each factory returns a registration payload for
 * {@link V3IlluminationPipeline#registerOcclusionTerm} or
 * {@link V3IlluminationPipeline#registerDirectTerm}. Terms own **their
 * parameter state** only — they translate that into slot values the composer
 * already understands, so adding a new shadow or light never patches the
 * illumination shader.
 *
 * First-party terms:
 *   - `skyReachSceneDarkness` — extra occlusion where the per-floor `skyReach`
 *     mask is low (roof / sheltered pixels). Scene-wide darkness from Foundry’s
 *     environment slider is applied in {@link V3IlluminationPipeline} via
 *     `uSceneDarkness` so the whole scene dims together; this term no longer
 *     duplicates that when the sky mask is missing.
 *   - `buildingShadows` — sun-projected building shadows that cascade down
 *     through transparent alpha holes in upper floors. The term reads the
 *     pre-combined scene-UV mask produced by
 *     {@link V3BuildingShadowsPass} (stored on the frame context as the
 *     `buildingShadows` mask) and slots it into the existing
 *     `OCC_KIND.MASK_MULTIPLY` path so no shader changes are needed.
 *   - `ambientTint` — uniform RGB additive wash; a deliberately tiny term
 *     used to validate the `Σ direct` path before porting real lights.
 */

import { OCC_KIND, DIR_KIND } from "./V3IlluminationPipeline.js";

/**
 * @typedef {{
 *   enabled: boolean,
 *   useSceneDarkness: boolean,
 *   manualDarkness01: number,
 *   strength: number,
 * }} SkyReachParams
 *
 * @typedef {{
 *   enabled: boolean,
 *   color: [number, number, number],
 *   intensity: number,
 * }} AmbientTintParams
 */

/**
 * Sky-reach occlusion: scales how much low `skyReach` (sheltered) pixels are
 * darkened **on top of** the pipeline’s global `uSceneDarkness` multiply.
 * `strength` is the extra shelter factor; scene vs manual darkness for the
 * whole board is resolved in {@link V3ThreeSceneHost} into `ctx.sceneDarkness01`.
 *
 * @param {{ getParams: () => SkyReachParams }} opts
 */
export function createSkyReachOcclusionTerm({ getParams } = {}) {
  return {
    id: "skyReachSceneDarkness",
    order: 10,
    update: (ctx, slot) => {
      const p = (typeof getParams === "function" ? getParams() : null) ?? {
        enabled: true,
        useSceneDarkness: true,
        manualDarkness01: 0,
        strength: 1,
      };
      const tex = ctx.getMask("skyReach");
      if (!tex) {
        slot.enabled = false;
        slot.kind = OCC_KIND.UNIFORM;
        slot.texture = null;
        slot.weight = 0;
        slot.scalar = 0;
        return;
      }
      slot.enabled = p.enabled !== false;
      slot.weight = Math.max(0, Math.min(3, Number(p.strength) || 0));
      // Host resolves useSceneDarkness vs manual into ctx.sceneDarkness01 for global uSceneDarkness.
      slot.scalar = Math.max(0, Math.min(1, Number(ctx.sceneDarkness01) || 0));
      slot.kind = OCC_KIND.SKY_REACH;
      slot.texture = tex;
    },
  };
}

/**
 * @typedef {{
 *   enabled: boolean,
 *   opacity: number,
 * }} BuildingShadowsTermParams
 */

/**
 * Building-shadow occlusion. Consumes a pre-combined scene-UV mask texture
 * produced by {@link V3BuildingShadowsPass} (key: `buildingShadows`). The
 * texture's `.r` channel already encodes `1 = lit, 0 = fully shadowed`, so we
 * slot it directly into the pipeline's `OCC_KIND.MASK_MULTIPLY` path —
 * `factor = mix(1.0, tex.r, weight)`.
 *
 * The caller owns `opacity` (via `getParams`) and the cascade (via the pass
 * itself). If the mask is missing for the current frame the slot disables
 * cleanly so illumination falls back to the old (shadow-free) behavior.
 *
 * @param {{ getParams: () => BuildingShadowsTermParams }} opts
 */
export function createBuildingShadowsOcclusionTerm({ getParams } = {}) {
  return {
    id: "buildingShadows",
    // Run after skyReach (order 10) so shadows multiply on top of sheltered
    // darkness — same stacking we'd expect from the V2 pipeline where
    // building shadows were an additional darkening pass on lit output.
    order: 20,
    update: (ctx, slot) => {
      const p = (typeof getParams === "function" ? getParams() : null) ?? {
        enabled: false,
        opacity: 0,
      };
      const tex = ctx.getMask("buildingShadows");
      const enabled = p.enabled !== false && !!tex;
      if (!enabled) {
        slot.enabled = false;
        slot.kind = OCC_KIND.UNIFORM;
        slot.texture = null;
        slot.weight = 0;
        slot.scalar = 0;
        return;
      }
      slot.enabled = true;
      slot.kind = OCC_KIND.MASK_MULTIPLY;
      slot.weight = Math.max(0, Math.min(1, Number(p.opacity) || 0));
      slot.scalar = 0;
      slot.texture = tex;
    },
  };
}

/**
 * Uniform ambient tint: `contrib = color * intensity`. Added after occlusion,
 * so raising its intensity lifts shadows rather than being clipped by them —
 * the opposite of multiplying tint into ambient. Used as a smoke test for the
 * `Σ direct` path and as a dumb global "fill light" the GM can sanity-check.
 *
 * @param {{ getParams: () => AmbientTintParams }} opts
 */
export function createAmbientTintDirectTerm({ getParams } = {}) {
  return {
    id: "ambientTint",
    order: 10,
    update: (_ctx, slot) => {
      const p = (typeof getParams === "function" ? getParams() : null) ?? {
        enabled: false,
        color: [0, 0, 0],
        intensity: 0,
      };
      slot.enabled = p.enabled === true;
      const c = Array.isArray(p.color) ? p.color : [0, 0, 0];
      slot.color = [
        Number(c[0]) || 0,
        Number(c[1]) || 0,
        Number(c[2]) || 0,
      ];
      slot.intensity = Math.max(0, Number(p.intensity) || 0);
      slot.kind = DIR_KIND.UNIFORM;
      slot.texture = null;
    },
  };
}
