/**
 * PLAYER TORCH FLAME + EMBERS — THE RENDER HALF (mythica-machina-press#77/
 * #578, Stage 2a). See `player-torch-flame-geometry.js`'s own header for the
 * full "why candle's flame body, why a new ember shader, why no sparks yet"
 * account. This file is the THREE/TSL glue only — unverified live (no Node
 * test; `CONVENTIONS.md §4`'s own "Foundry/THREE-touching glue" carve-out) —
 * a genuinely new small shader for embers, plus a thin re-use of candle's own
 * flame-body builders for the flame itself.
 *
 * ⚠️ WHY CANDLE'S FLAME BODY, NOT FIRE'S PARTICLE ENGINE (the judgement call
 * this dispatch asked to be explicit about) — `particle-system-schema.js#
 * SPAWN_KINDS`'s own header is unambiguous: `'extracted'` spawn points (what
 * `fire-particle-runtime.js#createFireParticleEngine` consumes) are computed
 * "at DECODE time, per page, in the worker" — a fundamentally STATIC, scene-
 * authored input. A player-carried torch has no decode-time existence at
 * all: it can appear, move, and disappear at any moment during play, driven
 * by a live Foundry Token document. `'area'`-kind emission (the schema's
 * other spawn kind) is closer in spirit but the real engine's own emitter
 * shapes/behaviors are still built around a scene-authored declaration, not
 * a per-frame live position feed, and adopting the full storage-buffer GPU-
 * compute engine for "one flame, five embers, per torch" would be a large,
 * genuinely separate integration for a look this dispatch scopes as
 * "distinct and functional," not "V2 parity." Candle's OWN flame body
 * (`candle-flame-render.js`) is architecturally the opposite of fire's engine
 * in exactly the way that matters here: `buildCandleFlameGeometry`/
 * `buildCandleFlameMaterial` take a plain, duck-typed `{x,y,...}` anchor
 * array and rebuild a small batched mesh from it — no decode-time step, no
 * storage buffers, nothing that assumes a static scene. Reusing it verbatim
 * for a LIVE anchor list (rebuilt every frame from the live token read,
 * mirroring `point-light-pool.js`'s own re-triangulation dirty-check
 * discipline via `torchFlameSignature` below) gets the real chaotic-life/
 * wind/gutter look for free, genuinely reused rather than re-implemented.
 *
 * @module effects/player-torch-flame-render
 */

import { buildCandleFlameGeometry, buildCandleFlameMaterial } from './candle-flame-render.js';
import { computeTorchEmberArrays } from './player-torch-flame-geometry.js';

/**
 * Build (or fill) a THREE.BufferGeometry for the ember quads. Kept thin —
 * the vertex MATH lives in `computeTorchEmberArrays` (Node-tested).
 *
 * ⚠️ `opts.sizePx` MUST equal `EMBER_BOX_SIZE_PX` (below) — the shader's own
 * local-pixel math (`buildTorchEmberMaterial`) assumes the quad it draws on
 * is exactly that many world pixels wide/tall; a caller-supplied size that
 * disagrees would desync the ember's SHADER-computed position from its own
 * quad's real footprint. Left as a param (not hardcoded) purely so a Node
 * test can probe a different size without touching the shader; every real
 * caller should omit it and take the default.
 *
 * @param {*} THREE @param {Array<{x:number,y:number,id?:string}>} anchors
 * @param {{emberCount?:number, sizePx?:number, colorHex?:string}} [opts]
 * @returns {{geometry: *, quadCount: number}}
 */
export function buildTorchEmberGeometry(THREE, anchors, opts = {}) {
  const { positions, uvs, seeds, colors, indices, quadCount } = computeTorchEmberArrays(anchors, {
    ...opts,
    sizePx: opts.sizePx ?? EMBER_BOX_SIZE_PX,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('emberSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('emberColor', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, quadCount * 6);
  return { geometry, quadCount };
}

/**
 * THE EMBER SHAPE — one place, named constants (this codebase's own comment
 * discipline). `BOX_SIZE_PX` is the quad's own footprint and must stay large
 * enough to contain an ember's whole rise+jitter travel (rise height + twice
 * the jitter amplitude + the dot's own diameter, with margin) — the quad
 * never moves or resizes; only the dot drawn inside it does, entirely in-
 * shader (see `computeTorchEmberArrays`'s own "dumb quad" header).
 */
const EMBER_BOX_SIZE_PX = 110;
const EMBER_RISE_HEIGHT_PX = 60;
const EMBER_RISE_DURATION_S = 2.6;
const EMBER_JITTER_AMP_PX = 7;
const EMBER_JITTER_RATE_HZ = 1.3;
const EMBER_DOT_RADIUS_START_PX = 3.2; // bigger, hotter at birth (near the flame)
const EMBER_DOT_RADIUS_END_PX = 1.2; // shrinks as it cools and rises
const EMBER_BRIGHTNESS = 2.2; // additive-blend headroom, matching candle's own emission scale

/**
 * Build the ember batch's TSL material — a small, self-contained, ADDITIVE
 * glow-dot shader. Each ember's OWN position within its quad is computed
 * purely from `uGlobalTimeMs` + its baked `emberSeed`, so N embers sharing
 * one draw call each run their own independent rise/jitter/fade cycle with
 * zero per-ember CPU work per frame (`uIntensity` is the only uniform this
 * material owns).
 *
 * ⚠️ NOT depth/floor-occlusion gated (Stage 2a simplification, named rather
 * than silent) — unlike the flame body (which inherits candle's own real
 * depth-authority gate via `expectedDepth`, defaulting to 0/"never occluded"
 * when absent, exactly like an anchor a Node test builds by hand), embers
 * carry no authored elevation at all yet. A torch carried under a genuine
 * roof/floor overhang would show its embers un-occluded until a future pass
 * threads a real expected-depth value through `computeTorchEmberArrays`.
 *
 * @param {{THREE: *, uGlobalTimeMs?: *}} args
 * @returns {{material: *, uIntensity: *}}
 */
export function buildTorchEmberMaterial({ THREE, uGlobalTimeMs }) {
  const { uv, uniform, attribute, vec2, vec3, vec4, float, length, smoothstep, mix, sin, fract } = THREE.TSL;

  const uIntensity = uniform(float(1));

  const seed = attribute('emberSeed', 'float');
  const emberColor = attribute('emberColor', 'vec3');
  const uvNode = uv();

  const timeS = uGlobalTimeMs ? uGlobalTimeMs.mul(float(0.001)) : float(0);
  // AGE — a [0,1) cycle, phase-shifted per ember by its own seed so a torch's
  // five embers rise at staggered moments rather than in lockstep.
  const age = fract(timeS.div(float(EMBER_RISE_DURATION_S)).add(seed));
  const rise = age.mul(float(EMBER_RISE_HEIGHT_PX));
  const jitter = sin(timeS.mul(float(EMBER_JITTER_RATE_HZ * Math.PI * 2)).add(seed.mul(float(11.3))))
    .mul(float(EMBER_JITTER_AMP_PX))
    .mul(age); // jitter grows with age — a young ember close to the wick barely sways

  // The fragment's own position, in px, relative to the quad's centre (the
  // wick) — uv (0.5,0.5) is the centre, so this recentres and rescales.
  const localPx = uvNode.sub(vec2(0.5, 0.5)).mul(float(EMBER_BOX_SIZE_PX));
  // The ember's CURRENT position, in the same space: rising is -Y (canvas Y
  // grows downward — the SAME convention `player-light-geometry.js#
  // tokenRotationToForwardVector`'s own header verifies against the vendored
  // source), jittering sideways in X.
  const emberPosPx = vec2(jitter, rise.negate());
  const dist = length(localPx.sub(emberPosPx));

  const dotRadius = mix(float(EMBER_DOT_RADIUS_START_PX), float(EMBER_DOT_RADIUS_END_PX), age);
  const core = float(1).sub(smoothstep(float(0), dotRadius, dist));
  // FADE — in quickly at birth, out gently over the back half of the cycle,
  // so an ember never just vanishes or pops.
  const fadeIn = smoothstep(float(0), float(0.08), age);
  const fadeOut = float(1).sub(smoothstep(float(0.6), float(1), age));
  const alpha = core.mul(fadeIn).mul(fadeOut).mul(uIntensity);

  // HEAT — white-hot at birth (close to the flame it just left), cooling
  // into the ember's own authored colour over the cycle's first third.
  const heat = float(1).sub(smoothstep(float(0), float(0.35), age));
  const color = mix(emberColor, vec3(1, 0.95, 0.85), heat);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.fragmentNode = vec4(color.mul(alpha).mul(float(EMBER_BRIGHTNESS)), alpha);

  return { material, uIntensity };
}

// Re-exported so a caller (vt-pan-viewer.js) needs only this one module for
// both halves of the torch flame body — candle's own builders, unmodified.
export { buildCandleFlameGeometry as buildTorchFlameGeometry, buildCandleFlameMaterial as buildTorchFlameMaterial };
