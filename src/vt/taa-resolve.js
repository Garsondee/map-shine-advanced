/**
 * @fileoverview vt/taa-resolve.js — temporal supersampling for the whole-image
 * renderer (2026-08-30, [[project_albedo_zoom_out_clarity_audit_2026-08-30]]
 * Stage 5). Split out from vt-pan-viewer.js from the start, mirroring
 * albedo-clarity.js's own extraction reasoning verbatim: THREE arrives by
 * parameter, nothing here touches `game`/`canvas`/settings, so a standalone
 * shader-lab bench can import the real node-building functions directly, and
 * the pure math below is Node-testable with zero GPU.
 *
 * ===========================================================================
 * SCOPE, STATED PLAINLY, NOT ASSUMED
 * ===========================================================================
 * Reprojection uses ONLY the camera's own analytic frame-to-frame delta, plus
 * a neighbourhood clamp as the general anti-ghosting fallback — NOT a
 * per-effect motion-vector G-buffer covering animated water, fire,
 * vegetation-sway, precipitation, door motion, or tokens. Building true
 * per-effect motion vectors would be its own large secondary project
 * touching every animated subsystem.
 *
 * This is a deliberate, favourable trade for THIS renderer specifically: an
 * orthographic camera over an essentially static 2D plane means the
 * CAMERA-caused portion of frame-to-frame motion is a closed-form affine
 * transform (see `computeReprojectTransform` below) — no depth
 * reconstruction, no per-pixel world-position unprojection, the kind of
 * machinery a perspective camera's TAA needs at all. Under this scope,
 * animated content gets ZERO extra AA benefit but ALSO zero regression: the
 * neighbourhood clamp rejects history that disagrees with the current frame
 * and falls back to single-sample quality — exactly what ships today,
 * never worse.
 *
 * ===========================================================================
 * WHY NO DEPTH/MOTION-VECTOR BUFFER IS NEEDED FOR THE CAMERA HALF EITHER
 * ===========================================================================
 * A perspective camera's TAA reprojects by unprojecting a screen pixel to
 * world space (needs depth), transforming by the camera's own delta, then
 * reprojecting back to screen space — because a perspective camera's
 * screen-to-world mapping depends on depth. An ORTHOGRAPHIC camera over a
 * FLAT Z=0 plane has no such dependency: screen UV maps to world position by
 * one linear interpolation of the frustum bounds (`f.left/right/top/bottom`),
 * invertible in closed form, the SAME for every pixel regardless of what it's
 * showing. `computeReprojectTransform` IS that closed-form inverse-then-
 * forward composition, expressed directly as one 1-D affine transform per
 * axis — the entire "motion vector" this scope needs.
 *
 * ===========================================================================
 * UV-DIRECTION — X-axis mechanism CONFIRMED on real hardware; Y traced from
 * source, not yet independently bench-confirmed
 * ===========================================================================
 * `computeReprojectTransform` derives `scaleX`/`offsetX` (and, by the exact
 * same shape, `scaleY`/`offsetY`) from ONLY the algebraic relationship "UV
 * u=0 maps to `camera.left`'s value, u=1 to `camera.right`'s" (Y: v=0 ↔
 * `camera.bottom`, v=1 ↔ `camera.top`) — the FIXED, standard three.js
 * orthographic projection semantics, true regardless of what world-space
 * values those fields happen to hold. `vt-pan-viewer.js#updateCamera`'s own
 * doc records that `computeCameraFrustum` deliberately stores the world's
 * SMALLEST Y in `f.top` (Foundry's Y-down convention) — but that assignment
 * is exactly what makes `f.top`/`f.bottom` mean "top/bottom" in the first
 * place, not a SECOND, independent flip layered on top of standard NDC
 * semantics; the derivation depends on nothing else.
 *
 * `tools/shader-lab/bench-taa-resolve.js`'s `reprojection-lands-on-the-
 * correct-stripe` scenario CONFIRMED this mechanism on a real WebGPU
 * device, 2026-08-30: three independent X-axis probes, the ACTUAL compiled
 * shader (the `prevUV = uvNode.mul(uReproject.xy).add(uReproject.zw)` line
 * below, copied verbatim into the bench) landed on the EXACT texel the JS
 * algebra predicted, all three, zero colour-distance error. That proves the
 * whole surrounding mechanism — uniform packing, `.xy`/`.zw` swizzling, a
 * texture sample at a formula-derived offset UV — compiles and runs
 * correctly, which the Y axis shares byte-for-byte; only the SIGN of what
 * value lands in `.zw`'s Y half differs, and — deliberately, see that
 * bench's own header — that specific sign was NOT independently re-proven
 * on a real render (a pure-Y bench scenario, sidestepped this round to keep
 * the fixture unambiguous), so it still rests on the source-level argument
 * above, not on this same class of direct GPU confirmation the X axis now
 * has. Matches `mip-resample.js`'s own linearization fix, same session: an
 * algebraically-sound design that still needed — and got — a real render
 * before being trusted, not assumed correct from the math alone.
 *
 * @module vt/taa-resolve
 */

/**
 * The Van der Corput radical inverse of `index` in `base` — the standard
 * building block of a Halton low-discrepancy sequence. `index` starts at 1;
 * index 0 degenerates to exactly 0 in every base, which would repeat the
 * un-jittered pixel-centre sample forever if included.
 * @param {number} index @param {number} base
 * @returns {number} in [0,1)
 */
export function haltonSequence(index, base) {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/**
 * `count` sub-pixel jitter samples, Halton(2,3) — the standard TAA jitter
 * sequence — recentred to [-0.5, 0.5) so each sample is a fraction of ONE
 * pixel either side of centre, never a whole pixel off.
 * @param {number} [count]
 * @returns {{x:number, y:number}[]}
 */
export function buildHaltonJitterSequence(count = 8) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 8;
  const seq = [];
  for (let i = 1; i <= n; i++) {
    seq.push({ x: haltonSequence(i, 2) - 0.5, y: haltonSequence(i, 3) - 0.5 });
  }
  return seq;
}

/**
 * A jitter sample (fractional PIXEL offset, [-0.5,0.5) each axis) converted
 * to a WORLD-space translation of the camera frustum `f`, sized to the
 * INTERNAL render resolution (`internalW`/`internalH` — the resolution the
 * jittered frame is actually rendered at, not the present/display size).
 * @param {{left:number,right:number,top:number,bottom:number}} f
 * @param {number} internalW @param {number} internalH
 * @param {{x:number,y:number}} sample
 * @returns {{dx:number, dy:number}}
 */
export function computeJitterOffsetWorld(f, internalW, internalH, sample) {
  const w = Number.isFinite(internalW) && internalW > 0 ? internalW : 1;
  const h = Number.isFinite(internalH) && internalH > 0 ? internalH : 1;
  return {
    dx: (sample.x * (f.right - f.left)) / w,
    dy: (sample.y * (f.top - f.bottom)) / h,
  };
}

/**
 * The closed-form affine transform from THIS frame's UV space to the
 * PREVIOUS frame's, expressed per-axis in the same WORLD-space frustum terms
 * both frames already carry — see this file's header for why an orthographic
 * camera over a flat plane needs nothing more. Handles pan AND zoom in one
 * pair of scale/offset numbers per axis; a UV `u` in the current frame maps
 * to `u * scaleX + offsetX` in the previous frame's own UV space, i.e. the
 * value to sample the history buffer at (same shape for `v`/Y — see this
 * file's header for the UV-direction caveat that applies there).
 *
 * @param {{left:number,right:number,top:number,bottom:number}} f - this frame's frustum.
 * @param {{left:number,right:number,top:number,bottom:number}} fPrev - the previous frame's.
 * @returns {{scaleX:number, offsetX:number, scaleY:number, offsetY:number}}
 *   identity (`{1,0,1,0}`) when `f === fPrev` in value (nothing moved).
 */
export function computeReprojectTransform(f, fPrev) {
  const spanX = fPrev.right - fPrev.left;
  const spanY = fPrev.top - fPrev.bottom;
  const scaleX = spanX !== 0 ? (f.right - f.left) / spanX : 1;
  const offsetX = spanX !== 0 ? (f.left - fPrev.left) / spanX : 0;
  const scaleY = spanY !== 0 ? (f.top - f.bottom) / spanY : 1;
  const offsetY = spanY !== 0 ? (f.bottom - fPrev.bottom) / spanY : 0;
  return { scaleX, offsetX, scaleY, offsetY };
}

/**
 * Is this frame's camera delta big enough to be a CUT (a floor switch's
 * camera reframe, a scripted jump, a fast wheel-zoom) rather than an ordinary
 * pan/zoom step? Reuses the SAME scale/offset `computeReprojectTransform`
 * already derived — a "cut" is exactly "this affine transform is far from
 * identity," no separate computation needed. One of THREE independent
 * history-invalidation triggers (the other two: the existing
 * `settleTracker`/`renderScaleGovernor` hold signal, and a resize/rung-change
 * flag — see vt-pan-viewer.js's own wiring).
 * @param {{scaleX:number, offsetX:number, scaleY:number, offsetY:number}} reprojectTransform
 * @param {{scaleThreshold?:number, offsetThreshold?:number}} [opts] - both
 *   default 0.25: a quarter of the previous frame's own span moved/zoomed in
 *   ONE frame. Generous — an ordinary pan/zoom step at any real frame rate
 *   moves a tiny fraction of the visible span; tune live if a real fast pan
 *   turns out to false-positive.
 * @returns {boolean}
 */
export function isCutDetected(reprojectTransform, opts = {}) {
  const scaleThreshold = Number.isFinite(opts.scaleThreshold) ? opts.scaleThreshold : 0.25;
  const offsetThreshold = Number.isFinite(opts.offsetThreshold) ? opts.offsetThreshold : 0.25;
  const { scaleX, offsetX, scaleY, offsetY } = reprojectTransform;
  const scaleDeviation = Math.max(Math.abs(scaleX - 1), Math.abs(scaleY - 1));
  const offsetDeviation = Math.max(Math.abs(offsetX), Math.abs(offsetY));
  return scaleDeviation > scaleThreshold || offsetDeviation > offsetThreshold;
}

/**
 * THE TAA RESOLVE NODE — bench-only verified (same untested-at-Node-level
 * convention this file's shader-glue shares with albedo-clarity.js's own).
 *
 * Five screen-space taps of the CURRENT frame build a neighbourhood colour
 * AABB (LINEAR space — the buffer's own native space, no gamma-2.0 encode
 * round trip needed here, unlike CAS: this is clamping a REPROJECTED sample
 * against what the current frame actually shows, not restoring perceptual
 * contrast). The reprojected history sample is clamped into that box before
 * blending — the standard "neighbourhood clipping" anti-ghosting technique —
 * so stale history from an animated element (water, fire, vegetation-sway)
 * gets pulled toward what the current frame shows rather than lingering, per
 * this file's own stated scope.
 *
 * ⚠️ ARITHMETIC, NOT CONTROL FLOW, for the offscreen fallback — deliberately
 * NOT a TSL `select()`/branch (memory:
 * feedback_tsl_select_chain_strands_vars — a `.toVar()`'d subgraph shared
 * across a `select()`'s branches gets its assignment emitted inside only
 * ONE branch's WGSL control flow, so the other branch silently reads an
 * uninitialised zero; three live specular rounds were mis-diagnosed off
 * exactly that). `inside` below is a plain 0/1 float built from `step()`,
 * multiplied through `mix()` — no branch, so "assigned before read" holds
 * by construction, the same discipline `effects/debug-channel-select.js`
 * already established for this exact class of trap.
 *
 * ⚠️ WHY `historyTexNode` IS RETURNED, NOT JUST A RAW TEXTURE TAKEN IN — the
 * SAME "wasteful if reused for a per-frame swap" problem `grade-present.js`'s
 * own `rebindLit` already has a name for (see that function's own doc):
 * `texture(rawTex, uv)` binds to WHATEVER texture object `rawTex` is AT
 * MATERIAL-BUILD TIME, and swapping which GPU texture a compiled shader
 * samples from — required EVERY FRAME here, for the ping-pong — needs the
 * SAME NODE OBJECT's `.value` reassigned, not a fresh `texture()` call (which
 * would mean rebuilding the whole material every frame, far too costly for a
 * per-frame ping-pong). `currentTex` has no such need — it is always
 * `scene.lit`'s own texture, the SAME GPU object every frame regardless of
 * what pixels it holds — so it stays a plain build-time parameter, bound
 * once, exactly like every other whole-image material's `tex` argument.
 *
 * @param {*} THREE
 * @param {{currentTex:*, initialHistoryTex:*, uvNode:*, uReproject:*, uBlendWeight:*}} args
 *   `currentTex` - the current, un-resolved colour texture (`scene.lit`),
 *     bound once — never swapped.
 *   `initialHistoryTex` - whichever history buffer's texture is live at
 *     BUILD time; the caller reassigns the returned `historyTexNode.value`
 *     every frame thereafter to point at the OTHER buffer.
 *   `uReproject` - vec4(scaleX, scaleY, offsetX, offsetY), packed the same
 *     way `albedo-clarity.js#albedoClarityUniforms`'s own `gate` uniform
 *     packs four related floats into one vec4.
 *   `uBlendWeight` - the frame-level history/current mix (0 = pure history,
 *     1 = pure current) — forced to 1 per-pixel wherever the reprojected UV
 *     lands offscreen, REGARDLESS of what the frame-level value says (a
 *     second, independent, per-pixel fail-open on top of the frame-level one
 *     — see vt-pan-viewer.js's own invalidation wiring for the frame-level
 *     half).
 * @returns {{rgb:*, a:*, historyTexNode:*}} LINEAR rgb (same units in and
 *   out, like `buildFlatAlbedoNode`'s own contract) + the current frame's
 *   own alpha + the swappable history-texture node (`.value = nextTexture`
 *   each frame, no rebuild).
 */
export function buildTaaResolveNode(THREE, { currentTex, initialHistoryTex, uvNode, uReproject, uBlendWeight }) {
  const TSL = THREE.TSL;
  const { float, texture, dFdx, dFdy, clamp, min, max, mix, step } = TSL;

  // UNIFORM CONTROL FLOW: nothing may branch above these two lines — same
  // requirement every other screen-space-derivative tap in this codebase
  // carries (albedo-clarity.js's own comment on this exact point).
  const duvdx = dFdx(uvNode).toVar();
  const duvdy = dFdy(uvNode).toVar();

  const c = texture(currentTex, uvNode).toVar();
  const sL = texture(currentTex, uvNode.sub(duvdx));
  const sR = texture(currentTex, uvNode.add(duvdx));
  const sU = texture(currentTex, uvNode.sub(duvdy));
  const sD = texture(currentTex, uvNode.add(duvdy));

  const nMin = min(c.rgb, min(min(sL.rgb, sR.rgb), min(sU.rgb, sD.rgb))).toVar();
  const nMax = max(c.rgb, max(max(sL.rgb, sR.rgb), max(sU.rgb, sD.rgb))).toVar();

  // See this file's header §"UV-DIRECTION" — traced against updateCamera's
  // own doc, still bench-checked by `moving-edge-reprojection-alignment`.
  const prevUV = uvNode.mul(uReproject.xy).add(uReproject.zw).toVar();

  // Arithmetic inside-test — see this function's own header for why this is
  // NOT a select()/branch. 1 where both axes are in [0,1], 0 otherwise.
  const insideX = step(float(0), prevUV.x).mul(step(prevUV.x, float(1)));
  const insideY = step(float(0), prevUV.y).mul(step(prevUV.y, float(1)));
  const inside = insideX.mul(insideY);

  // The ONE node whose `.value` the caller re-points to the current ping-pong
  // source every tick — mirrors fluid-render.js's own documented convention
  // for the identical "one persistent node, swapped value" shape.
  const historyTexNode = texture(initialHistoryTex, prevUV);
  const hClamped = clamp(historyTexNode.rgb, nMin, nMax);

  // mix(a,b,t) = a*(1-t)+b*t (FUNCTION form, deliberately — `a.mix(b,t)`
  // silently evaluates as `mix(b,t,a)`, memory: reference_tsl_method_chaining_trap,
  // the same trap albedo-clarity.js's own gate math already carries a
  // warning about). `w`: `inside=1` (normal) -> `uBlendWeight`; `inside=0`
  // (reprojected UV fell off the history buffer) -> forced to `1`.
  const w = mix(float(1), uBlendWeight, inside);

  const resolved = mix(hClamped, c.rgb, w);
  return { rgb: resolved, a: c.a, historyTexNode };
}
