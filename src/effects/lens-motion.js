/**
 * LENS MOTION — the pure math behind autofocus pulses, camera motion blur and
 * light-burn's darkness gate/decay (mythica-machina-press#57).
 *
 * Every function here is a straight, verified transcription of V2's own real
 * arithmetic (`legacy/compositor-v2/effects/LensEffectV2.js`, recovered from
 * git history at `c328c9bd~1`) — not a re-derivation, not a guess at what "an
 * autofocus pulse" should feel like. Where V2's own method mixed pure maths
 * with mutated instance state (`this._autoFocusEventActive = ...` etc.), the
 * maths is extracted here as a stateless function and the MUTATION stays with
 * whichever caller owns the actual per-frame state — `vt-pan-viewer.js`'s own
 * closure, the same split `world/weather.js#tick()` already uses around the
 * pure `envelopePhase`/`advanceWalk` helpers it calls.
 *
 * No THREE, no `canvas`/`game` — plain numbers in, plain numbers out, so this
 * whole file is directly Node-testable (CONVENTIONS §4).
 *
 * @module effects/lens-motion
 */

/**
 * The autofocus pulse's own envelope, 0..1 — rise (smoothstep) for the first
 * 55% of the pulse, hold at 1 for the next 30%, fall (smoothstep) for the
 * last 15%. V2's own exact fractions (`LensEffectV2.js#_computeAutoFocusAmount`)
 * — not retuned, since the whole point of this port is that a pulse feels the
 * way it always has.
 * @param {number} phase - elapsed / duration, any range (clamped internally).
 * @returns {number} 0..1.
 */
export function computeAutoFocusAmount(phase) {
  const t = clamp01(phase);
  if (t < 0.55) {
    const x = t / 0.55;
    return x * x * (3 - 2 * x);
  }
  if (t < 0.85) return 1.0;
  const x = clamp01((t - 0.85) / 0.15);
  const smooth = x * x * (3 - 2 * x);
  return 1.0 - smooth;
}

/**
 * Pick the real-seconds gap before the next SCHEDULED (non-zoom-triggered)
 * autofocus event. V2's own floor (0.5s) stops a misconfigured 0/0 schema
 * edit from producing a machine-gun of pulses.
 * @param {number} minIntervalSec @param {number} maxIntervalSec
 * @param {() => number} [rng] - 0..1, injected for determinism in tests.
 * @returns {number} seconds.
 */
export function pickAutoFocusIntervalSec(minIntervalSec, maxIntervalSec, rng = Math.random) {
  const lo = minIntervalSec > 0.5 ? minIntervalSec : 0.5;
  const hi = maxIntervalSec > lo ? maxIntervalSec : lo;
  return randomInRange(lo, hi, rng);
}

/**
 * How long THIS pulse actually lasts, once triggered — V2's own "a stronger
 * (zoom-triggered) pulse resolves faster, never slower" rule: `strength`
 * divides the base duration, floored at 0.6 so an extreme zoom cannot
 * collapse the pulse to a single-frame flash.
 * @param {number} baseDurationSec @param {number} strength - 1.0 for an
 *   ordinary timed pulse; >1 for a fast zoom's own stronger trigger.
 * @returns {number} seconds, floored at 0.05.
 */
export function computeAutoFocusEventDurationSec(baseDurationSec, strength) {
  const base = baseDurationSec > 0.05 ? baseDurationSec : 0.35;
  const s = strength > 0.1 ? strength : 0.1;
  const computed = base / (s > 0.6 ? s : 0.6);
  return computed > 0.05 ? computed : 0.05;
}

/**
 * The random sideways drift one pulse picks, in screen px — a uniformly
 * random DIRECTION, a magnitude drawn from the top 55% of the configured max
 * (V2's own `_randomInRange(0.45, 1.0)`, so a pulse never drifts an
 * imperceptible amount), scaled by the SAME strength a zoom trigger uses to
 * lengthen/shorten the pulse (capped at 1.8× so a wild zoom cannot fling the
 * frame arbitrarily far).
 * @param {number} maxShiftPx @param {number} strength
 * @param {() => number} [rng]
 * @returns {{x: number, y: number}} px.
 */
export function computeAutoFocusShiftPx(maxShiftPx, strength, rng = Math.random) {
  const s = strength > 0.1 ? strength : 0.1;
  const maxShift = (maxShiftPx > 0 ? maxShiftPx : 0) * (s < 1.8 ? s : 1.8);
  const theta = rng() * (Math.PI * 2);
  const mag = maxShift * randomInRange(0.45, 1.0, rng);
  return { x: Math.cos(theta) * mag, y: Math.sin(theta) * mag };
}

/**
 * Does THIS frame's zoom speed earn a refocus trigger? Pure yes/no + the
 * resulting event strength — cooldown/already-active gating is real STATE
 * and stays with the caller (mirrors this file's own header). V2's own
 * `_maybeTriggerZoomRefocus` formula exactly.
 * @param {number} zoomVelocity - |Δzoom/Δt| this frame, any sign already
 *   stripped by the caller (this function takes the magnitude).
 * @param {number} threshold @param {number} strengthScale
 * @returns {number|null} the event strength to trigger with, or `null` if
 *   this frame's zoom speed does not clear the threshold.
 */
export function computeZoomTriggerStrength(zoomVelocity, threshold, strengthScale) {
  const speed = Math.abs(zoomVelocity || 0);
  const thresh = threshold > 0.01 ? threshold : 0.75;
  if (speed < thresh) return null;
  const scale = strengthScale > 0.1 ? strengthScale : 1.0;
  return Math.min(2.0, scale * (1.0 + (speed - thresh)));
}

/**
 * One frame's worth of camera-pan motion blur, EMA-smoothed against the
 * previous frame's own smoothed value — a real pure reducer (previous state
 * is an explicit input, not a hidden closure), the same shape
 * `world/weather.js#advanceWalk` already takes for its own per-tick state.
 *
 * World-space camera delta is converted to SCREEN pixels via the current
 * view rect (`Δworld / viewSpan × screenSpan`) BEFORE smoothing — V2's own
 * order — and the sign is inverted: panning the camera right makes the
 * WORLD appear to slide left underneath it, which is the direction the blur
 * itself must smear in.
 *
 * @param {object} args
 * @param {number} args.dxWorld @param {number} args.dyWorld - this frame's
 *   camera-centre delta, world units.
 * @param {number} args.viewW @param {number} args.viewH - the current view
 *   rect's span, world units (floored at a small epsilon by the caller).
 * @param {number} args.screenW @param {number} args.screenH - viewport px.
 * @param {{x: number, y: number}} prevSmoothedPx - last frame's OWN return
 *   value's `smoothedPx`, or `{x:0,y:0}` on the first frame.
 * @param {number} dtSec
 * @param {{strength: number, maxPx: number, smoothingSeconds: number}} params
 * @returns {{smoothedPx: {x: number, y: number}, blurPx: {x: number, y: number}}}
 *   `smoothedPx` — feed back in as next frame's `prevSmoothedPx`.
 *   `blurPx` — the clamped value to actually push into the shader uniform.
 */
export function computeCameraMotionBlurPx(
  { dxWorld, dyWorld, viewW, viewH, screenW, screenH },
  prevSmoothedPx,
  dtSec,
  { strength, maxPx, smoothingSeconds }
) {
  const rawX = -(dxWorld / Math.max(viewW, 1e-3)) * Math.max(screenW, 1);
  const rawY = -(dyWorld / Math.max(viewH, 1e-3)) * Math.max(screenH, 1);

  const tau = smoothingSeconds > 0 ? smoothingSeconds : 0;
  const alpha = tau <= 0.0001 ? 1.0 : 1.0 - Math.exp(-Math.max(dtSec, 0) / tau);
  const smoothedX = (prevSmoothedPx?.x ?? 0) + (rawX - (prevSmoothedPx?.x ?? 0)) * alpha;
  const smoothedY = (prevSmoothedPx?.y ?? 0) + (rawY - (prevSmoothedPx?.y ?? 0)) * alpha;

  const s = strength > 0 ? strength : 0;
  const max = maxPx > 0 ? maxPx : 0;
  const blurX = clampAbs(smoothedX * s, max);
  const blurY = clampAbs(smoothedY * s, max);

  return { smoothedPx: { x: smoothedX, y: smoothedY }, blurPx: { x: blurX, y: blurY } };
}

/**
 * Zoom-driven motion blur — a single scalar (the shader applies it radially,
 * outward from frame centre), independent of the pan blur above. V2's own
 * formula: raw zoom velocity × strength, clamped to the SAME px ceiling pan
 * blur uses.
 * @param {number} zoomVelocity - Δzoom/Δt this frame (signed: positive =
 *   zooming in).
 * @param {number} zoomStrength @param {number} maxPx
 * @returns {number} px.
 */
export function computeZoomMotionBlurPx(zoomVelocity, zoomStrength, maxPx) {
  const s = zoomStrength > 0 ? zoomStrength : 0;
  const max = maxPx > 0 ? maxPx : 0;
  return clampAbs((zoomVelocity || 0) * s, max);
}

/**
 * Light burn's own per-FRAME decay factor, derived from a real seconds-based
 * half-life-style persistence — `exp(-dt/persist)` reads the same total fade
 * time at any framerate, unlike V2's raw per-frame `uDecayFactor` uniform
 * (which V2 itself computed this exact way, just inline rather than as a
 * named function — see `LensEffectV2.js#_updateLightBurnMap`).
 * @param {number} dtSec @param {number} persistenceSec
 * @returns {number} 0..1, the multiplier applied to the PREVIOUS frame's burn.
 */
export function computeLightBurnDecayFactor(dtSec, persistenceSec) {
  const persist = persistenceSec > 0.05 ? persistenceSec : 2.5;
  const dt = dtSec > 0.004166 ? dtSec : 0.004166;
  return clamp01(Math.exp(-dt / persist));
}

/**
 * How much of light burn's own write should reach the buffer this frame,
 * given the scene's current darkness level — V2's own smoothstep blend
 * between "no gate" (1, always writes) and "fully gated" (0 outside the
 * authored darkness range), scaled by how strongly the gate is allowed to
 * suppress at all (`influence`).
 * @param {object} args
 * @param {number} args.darkness01 - 0 (full daylight) .. 1 (pitch black).
 * @param {number} args.start @param {number} args.end - the darkness range
 *   the gate fades across; may be given in either order.
 * @param {number} args.influence - 0 (gate has no effect) .. 1 (gate fully
 *   suppresses outside its range).
 * @param {boolean} args.enabled - `false` short-circuits to 1 (no gate at
 *   all), V2's own "gate disabled" behaviour.
 * @returns {number} 0..1, multiplies straight into the light-burn write.
 */
export function computeLightBurnDarknessGate({ darkness01, start, end, influence, enabled }) {
  if (!enabled) return 1.0;
  const darkness = clamp01(darkness01);
  const d0 = clamp01(start);
  const d1 = clamp01(end);
  const lo = Math.min(d0, d1);
  const hi = Math.max(d0, d1);
  const inf = clamp01(influence);
  const denom = hi - lo;
  if (denom < 0.0001) {
    // A degenerate (zero-width) range: V2's own reading is "fully gated
    // unless darkness has reached the (single) threshold exactly" — the
    // smooth term below would divide by ~0, so this is its honest limit,
    // not an approximation of it.
    return darkness >= lo ? 1.0 : 1.0 - inf;
  }
  const x = clamp01((darkness - lo) / denom);
  const smooth = x * x * (3 - 2 * x);
  return 1.0 + (smooth - 1.0) * inf;
}

/**
 * OVERLAY CATALOG — which two catalog images are showing right now, and how
 * far through the crossfade between them (mythica-machina-press#57's basic
 * v1: ONE cycling library across all bundled images, sequential order, no
 * V2 4-channel classification/dual-slot layering — see lens.js's own header).
 *
 * A pure CLOCK READ, not an event scheduler like autofocus above: the whole
 * state is a deterministic function of elapsed time and the two authored
 * durations, so there is nothing to schedule and nothing that can desync
 * after a dropped frame or a paused tab the way a countdown state machine
 * could — the caller can call this every frame off a plain running clock and
 * always get the answer a fresh page load would also get at that same
 * elapsed time.
 *
 * The crossfade runs over the LAST `crossfadeSeconds` of every cycle window,
 * so `currentIndex`/`nextIndex` roll over EXACTLY as `crossfadeT` reaches 1:
 * the instant before rollover shows `nextIndex` at full strength, the
 * instant after shows the (now-current) same image at full strength again —
 * the boundary itself is never visible as a pop.
 *
 * @param {object} args
 * @param {number} args.elapsedSec - seconds on any non-negative running
 *   clock (never needs to reset itself; negative/non-finite reads as 0).
 * @param {number} args.cycleSeconds - how long one image stays "current"
 *   before the catalog advances. Floored at 1s — a misconfigured near-zero
 *   value would otherwise spin the cycle every frame.
 * @param {number} args.crossfadeSeconds - how long the transition to the
 *   next image takes. Clamped to (0, cycleSeconds] so a fade can never
 *   outlast, or exceed, the cycle window it belongs to.
 * @param {number} args.catalogLength - how many images are in the library.
 *   `<= 1` means there is nothing to cycle to; this always reports index 0
 *   with no crossfade rather than dividing by a degenerate range.
 * @returns {{currentIndex: number, nextIndex: number, crossfadeT: number}}
 *   `crossfadeT` is 0..1, the mix weight toward `nextIndex`.
 */
export function computeOverlayCatalogState({ elapsedSec, cycleSeconds, crossfadeSeconds, catalogLength }) {
  const count = Number.isInteger(catalogLength) && catalogLength > 0 ? catalogLength : 1;
  if (count <= 1) return { currentIndex: 0, nextIndex: 0, crossfadeT: 0 };

  const cycle = cycleSeconds > 1 ? cycleSeconds : 1;
  const fade = clamp(crossfadeSeconds > 0.001 ? crossfadeSeconds : 0.001, 0.001, cycle);
  const t = Number.isFinite(elapsedSec) && elapsedSec > 0 ? elapsedSec : 0;

  const cyclePosition = t / cycle;
  const cycleIndex = Math.floor(cyclePosition);
  const secondsIntoCycle = (cyclePosition - cycleIndex) * cycle;
  const secondsRemaining = cycle - secondsIntoCycle;

  const currentIndex = cycleIndex % count;
  const nextIndex = (currentIndex + 1) % count;
  const crossfadeT = secondsRemaining <= fade ? clamp01(1 - secondsRemaining / fade) : 0;

  return { currentIndex, nextIndex, crossfadeT };
}

/** @param {number} min @param {number} max @param {() => number} rng */
function randomInRange(min, max, rng) {
  const lo = Number(min) || 0;
  const hi = Number(max) || lo;
  if (hi <= lo) return lo;
  return lo + rng() * (hi - lo);
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** @param {number} v */
function clamp01(v) {
  return clamp(v, 0, 1);
}

/** @param {number} v @param {number} max */
function clampAbs(v, max) {
  return clamp(v, -max, max);
}
