/**
 * THE ORIENTATION PROBE — the answer to "how do we stop fighting Y-flips?"
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * Author, 2026-07-17, on being shown an upside-down map: *"How can we make sure
 * that we don't have to fight y-flipping for every effect? (this happened a lot
 * with V1 and even occasionally with V2)."*
 *
 * The honest diagnosis of why it keeps happening:
 *
 *  1. There are FIVE conventions in play and they disagree by design —
 *     Foundry canvas space (+Y down), world space, NDC (+Y **up**), texture UV
 *     (v=0 at the top for an image, at the BOTTOM for a PlaneGeometry vertex),
 *     and framebuffer origin (bottom-left on WebGL, top-left on WebGPU).
 *     Every new mapping between two of them is a coin flip.
 *  2. **The mistake is invisible in code.** It is a sign, or an index, or a
 *     geometry choice. It reads as correct. No reviewer catches it.
 *  3. **You only find it by looking** — and symmetric content hides it
 *     completely. A grid, a radial glow, a blur kernel: all look identical
 *     flipped. It surfaces later, on different content, as a mystery.
 *
 * So the durable fix cannot be "be careful" or "remember the convention" —
 * those are the L4 comment-skeleton that Skeleton.md §0 proves loses every
 * time. It has to be a MACHINE that looks, on demand, at real pixels.
 *
 * ============================================================================
 * WHAT IT DOES
 * ============================================================================
 *
 * Renders a deliberately ASYMMETRIC pattern — four distinctly-coloured corners
 * — through the **real** chain (the same RenderTarget + the same present pass
 * the map uses), then reads back the actual pixels and asserts each corner is
 * the colour it must be. `topLeft: RED, expected RED — ok`. Not "does it look
 * right to you"; a named expectation and a measured value.
 *
 * The pattern is asymmetric on BOTH axes on purpose: a Y-flip and an X-flip and
 * a 180° rotation all produce different, individually-identifiable failures, so
 * the report says WHICH transform is wrong rather than just "something is off".
 *
 * THE STANDING RULE THIS SERVES: every new screen-space or world→texture
 * mapping gets one click of this before it is believed —
 * `masks.occlusion` (which already has a known `maskUV` bug waiting: it is fed
 * `positionGeometry.xy`, a WORLD coord, where a SCREEN uv belongs), every
 * effect that samples `buf:scene.color`, every new render target. One click,
 * real pixels, named expectations.
 *
 * @module diag/orientation-probe
 */

/** The four corners, and the colour each MUST be. Asymmetric on both axes. */
export const PROBE_CORNERS = Object.freeze([
  { name: 'topLeft', u: 0.12, v: 0.12, rgb: [255, 0, 0], label: 'RED' },
  { name: 'topRight', u: 0.88, v: 0.12, rgb: [0, 255, 0], label: 'GREEN' },
  { name: 'bottomLeft', u: 0.12, v: 0.88, rgb: [0, 0, 255], label: 'BLUE' },
  { name: 'bottomRight', u: 0.88, v: 0.88, rgb: [255, 255, 0], label: 'YELLOW' },
]);

/**
 * Which single transform, if any, explains a set of misplaced corners? Pure, so
 * the diagnosis itself is Node-tested rather than eyeballed — an instrument that
 * guesses is worse than none (memory: feedback_instruments_must_not_lie).
 *
 * @param {Record<string, string>} found - corner name -> the label actually measured there
 * @returns {{ok: boolean, diagnosis: string}}
 */
export function diagnoseOrientation(found) {
  const expect = Object.fromEntries(PROBE_CORNERS.map((c) => [c.name, c.label]));
  const same = (a, b) => found[a] === expect[b];

  if (PROBE_CORNERS.every((c) => found[c.name] === c.label)) {
    return { ok: true, diagnosis: 'correct — every corner is where it belongs' };
  }
  // Y-flip: top<->bottom swap. THE recurring one.
  if (
    same('topLeft', 'bottomLeft') &&
    same('bottomLeft', 'topLeft') &&
    same('topRight', 'bottomRight') &&
    same('bottomRight', 'topRight')
  ) {
    return {
      ok: false,
      diagnosis:
        'Y-FLIPPED (top<->bottom). The classic. Something between the draw and the screen disagrees ' +
        'about which way is up — most likely a hand-rolled fullscreen quad (PlaneGeometry puts v=0 at ' +
        'the screen BOTTOM; three render-target textures are v=0 TOP). Use THREE.QuadMesh. Do NOT add ' +
        'a compensating flip.',
    };
  }
  // X-flip: left<->right swap.
  if (
    same('topLeft', 'topRight') &&
    same('topRight', 'topLeft') &&
    same('bottomLeft', 'bottomRight') &&
    same('bottomRight', 'bottomLeft')
  ) {
    return { ok: false, diagnosis: 'X-FLIPPED (left<->right) — a negated U somewhere, or a reversed winding.' };
  }
  // 180: both.
  if (
    same('topLeft', 'bottomRight') &&
    same('bottomRight', 'topLeft') &&
    same('topRight', 'bottomLeft') &&
    same('bottomLeft', 'topRight')
  ) {
    return { ok: false, diagnosis: 'ROTATED 180° — BOTH axes inverted. Two flips, not one; find both.' };
  }
  return {
    ok: false,
    diagnosis:
      'WRONG, but not a clean flip/rotation — corners are not simply permuted. Suspect the sampling ' +
      'itself (wrong texture bound, wrong UV source, or nothing rendered) before suspecting orientation.',
  };
}

/** Nearest known probe colour to a measured pixel, or null if it matches none. */
export function classifyPixel(r, g, b) {
  let best = null;
  let bestDist = Infinity;
  for (const c of PROBE_CORNERS) {
    const d = (r - c.rgb[0]) ** 2 + (g - c.rgb[1]) ** 2 + (b - c.rgb[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = c.label;
    }
  }
  // ~70 per channel of slack: enough for sRGB<->linear round-tripping and
  // filtering, far short of confusing RED with GREEN.
  return bestDist <= 3 * 70 * 70 ? best : null;
}
