/**
 * RAIN FROM THE CLOUDS (2026-11-03) — the link between the cloud deck and everything that falls from it.
 *
 * Author: *"link the clouds to precipitation ... rain/snow originates from the cloud height and falls to the
 * ground to splash."* Before this, rain spawned uniformly over the view at a fixed 780 px under its own camera
 * (1.66 x the scene eye), knowing nothing about the clouds drawn above it.
 *
 * ============================================================================
 * THREE THINGS THE RAIN NOW TAKES FROM THE CLOUDS
 * ============================================================================
 *
 * 1. WHERE IT FALLS — the rain field. One small world-space target per frame (the viewer owns it; textures live
 *    in vt/) holds how much cloud is straight above each point, remapped so thin scraps drop nothing and thick
 *    cores rain hardest. The fall and the splashes both CHOOSE their birthplaces from it (best of a few candidate
 *    points), so drops gather under the clouds instead of being thrown away by an opacity mask; the population
 *    stays the slider's, it just moves to where the cloud is.
 *
 * 2. WHERE IT STARTS — the deck. Every storybook pixel is cast to the shared scene eye at the deck's height (a
 *    dome over the board). A drop is born at that same height, under that same eye, so it leaves the cloud at
 *    the spot the cloud is drawn and shrinks toward its landing point exactly as the cloud's own parallax says.
 *    With no storybook deck (realistic style, or a lab), a flat VIRTUAL deck at the same share of the eye stands
 *    in, so the physics below never changes with the cloud style.
 *
 * 3. HOW IT MOVES — once the deck sets a real height, the fall can be real too: terminal velocities in m/s at the
 *    scene's px/m, carried sideways at the wind's own speed. See `precip-runtime.js#setCloudDeck`.
 *
 * ============================================================================
 * ⚠️ FAILS OPEN: NO CLOUD MEANS RAIN EVERYWHERE, NEVER NO RAIN
 * ============================================================================
 *
 * The codebase's gate polarity (`feedback_gate_polarity_must_fail_open`): a GM who sets rain with a clear sky
 * gets rain, not a mysteriously dry map. The link's weight ramps in with the deck's own fill
 * ({@link cloudRainLinkWeight}), so at cover 0 the field is ignored entirely and rain falls everywhere as it
 * always did; with even a few clouds, it gathers under them.
 *
 * Pure TSL builders (TSL injected) + pure JS. No THREE import, no textures created here.
 *
 * @module effects/precipitation/cloud-rain
 */

import { buildStorybookCloudDepthNode } from '../clouds/storybook-clouds.js';

/**
 * The rain field's remap of cloud depth (`buildStorybookCloudDepthNode`, 0..1 of a cloud's thickness): nothing
 * below `lo` (the frayed skirt and scraps carry no rain), full rain by `hi` (the thick body). Real showers fall
 * from the deep cores of a cumulus, not its wisps.
 */
export const CLOUD_RAIN_DEPTH_LO = 0.06;
export const CLOUD_RAIN_DEPTH_HI = 0.4;

/**
 * How many candidate birthplaces a body weighs (the fall and the splashes alike). Best-of-N moves the population
 * under the clouds without throwing any of it away: with a cloud fraction f, `1 - (1-f)^N` of the bodies find
 * cloud. At N = 4 and a quarter of the sky covered, 68% of the rain falls under cloud (2.7x as dense there as a
 * uniform fall) and the rest fade out in the open.
 */
export const CLOUD_RAIN_CANDIDATES = 4;

/** The flat virtual deck's height as a share of the eye — the storybook deck's own base-plus-half-dome. */
export const VIRTUAL_DECK_SHARE = 0.21;

/**
 * How strongly the rain follows the clouds this frame, 0..1: the card's link dial, ramped in by how much cloud the
 * deck holds (so a clear sky rains everywhere — see the module header).
 * @param {number} fill01 - the deck's coverage share (`resolveStorybookDeck(...).fill`).
 * @param {number} link01 - the card's "Rain follows clouds" dial.
 */
export function cloudRainLinkWeight(fill01, link01) {
  const f = Number.isFinite(fill01) ? Math.max(0, Math.min(1, fill01)) : 0;
  const l = Number.isFinite(link01) ? Math.max(0, Math.min(1, link01)) : 0;
  const t = Math.min(1, f / 0.12);
  // Under a heavy overcast the sky is one cloud: dry gaps would read as "the weather stopped". The link eases off
  // from 55% to 85% fill, to a fifth of itself (some shower structure stays, never a dry view).
  const o = Math.min(1, Math.max(0, (f - 0.55) / 0.3));
  return l * t * t * (3 - 2 * t) * (1 - 0.8 * o * o * (3 - 2 * o));
}

/**
 * A flat deck for when no storybook deck exists: the same shape `resolveStorybookDeck` returns, so the engines
 * take one kind of input.
 * @param {number} eyeHeight
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} [board]
 */
export function virtualRainDeck(eyeHeight, board = null) {
  const H = Math.max(1, Number.isFinite(eyeHeight) ? eyeHeight : 1000);
  const cx = board ? (board.minX + board.maxX) / 2 : 0;
  const cy = board ? (board.minY + board.maxY) / 2 : 0;
  return {
    baseHeight: VIRTUAL_DECK_SHARE * H,
    domeHeight: 0,
    domeCentre: [cx, cy],
    domeRadius: 1,
    lens: 0,
    fill: 0,
    virtual: true,
  };
}

/**
 * The deck's uniforms, packed into four vec4s for an engine (`precip-runtime.js` documents the lanes). One
 * helper so the engines stay under the per-file uniform cap and agree on the layout.
 * @param {object} TSL
 */
export function createCloudDeckUniforms(TSL) {
  const { uniform, vec4 } = TSL;
  return {
    deckA: uniform(vec4(0, 0, 0, 0)),
    deckB: uniform(vec4(1, 0, 0, 0)),
    deckC: uniform(vec4(0, 0, 0, 0)),
    rainRect: uniform(vec4(0, 0, 1, 1)),
  };
}

/**
 * The rain field at a ground point: 0 = no rain falls from here, 1 = a thick core overhead.
 * @param {object} TSL
 * @param {{worldXY:*, u:object, wind:{drift:*, dir:*}}} a - the storybook uniforms and the shared cloud wind.
 */
export function buildStorybookRainFieldNode(TSL, { worldXY, u, wind }) {
  const { float, smoothstep } = TSL;
  const depth = buildStorybookCloudDepthNode(TSL, { worldXY, u, wind });
  return smoothstep(float(CLOUD_RAIN_DEPTH_LO), float(CLOUD_RAIN_DEPTH_HI), depth);
}

/**
 * Read the rain field target at a world point, bilinear, clamped to its rect (a body born past the view's edge
 * reads the edge texel — the field is low-frequency, so that is the right guess, not a seam).
 * @param {object} TSL
 * @param {{texNode:*, rect:*, worldXY:*}} a - `rect` is a vec4 uniform (minX, minY, maxX, maxY).
 */
export function sampleCloudRainNode(TSL, { texNode, rect, worldXY }) {
  const { vec2, float, clamp } = TSL;
  const u = clamp(worldXY.x.sub(rect.x).div(rect.z.sub(rect.x).max(float(1))), float(0), float(1));
  const v = clamp(worldXY.y.sub(rect.y).div(rect.w.sub(rect.y).max(float(1))), float(0), float(1));
  return texNode.sample(vec2(u, v)).level(0).x;
}
