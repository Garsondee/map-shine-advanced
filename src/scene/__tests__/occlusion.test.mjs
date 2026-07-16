/**
 * Node verification for scene/occlusion.js — the roof-gets-out-of-the-way model.
 *
 * The `computeOcclusionAlpha` block is the important one: it's a CPU mirror of
 * Foundry's four-line shader, so testing it here is the only way to prove the
 * channel semantics (R=Fade, G=Radial, B=Vision, A=Surface, each holding an
 * ELEVATION INDEX rather than a coverage value) are understood correctly before
 * any of it reaches GLSL, where it can only be eyeballed.
 */
import {
  OCCLUSION_MODES,
  MAX_OCCLUSION_ELEVATIONS,
  packOcclusionModes,
  isOccludable,
  buildElevationTable,
  mapElevation,
  computeOcclusionState,
  testTokenOcclusion,
  createHoverFadeState,
  updateHoverFade,
  easeInOutCosine,
  computeOcclusionAlpha,
} from '../occlusion.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok } = t;

  // --- the constants must match Foundry's bitflags exactly -----------------
  {
    // common/constants.mjs:1022. These are flags, not an enum of alternatives.
    ok(
      'OCCLUSION_MODES match Foundry (0,1,2,4,8)',
      OCCLUSION_MODES.NONE === 0 &&
        OCCLUSION_MODES.FADE === 1 &&
        OCCLUSION_MODES.SURFACE === 2 &&
        OCCLUSION_MODES.RADIAL === 4 &&
        OCCLUSION_MODES.VISION === 8
    );
    ok('254 elevation slots (8-bit channel, index 0 reserved)', MAX_OCCLUSION_ELEVATIONS === 254);
  }

  // --- packOcclusionModes: a Set of flags -> one bitfield -------------------
  {
    ok('pack: empty -> NONE', packOcclusionModes(new Set()) === 0);
    ok('pack: null/undefined -> NONE', packOcclusionModes(null) === 0 && packOcclusionModes(undefined) === 0);
    ok('pack: single FADE', packOcclusionModes(new Set([1])) === 1);
    // v14's whole reason for making this a Set: modes COMBINE.
    ok('pack: RADIAL|VISION combine (12)', packOcclusionModes(new Set([4, 8])) === 12);
    ok('pack: all modes (15)', packOcclusionModes(new Set([1, 2, 4, 8])) === 15);
    ok('pack: accepts an array too', packOcclusionModes([1, 4]) === 5);
    ok('isOccludable: NONE is not occludable', isOccludable(0) === false);
    ok('isOccludable: any flag is occludable', isOccludable(1) && isOccludable(8));
  }

  // --- buildElevationTable / mapElevation ----------------------------------
  {
    const table = buildElevationTable([10, 0, 5, 5, 0]);
    ok('elevation table: distinct + ascending', table.join() === '0,5,10');
    // mapElevation returns (i+1)/255 for the first entry >= elevation.
    ok('mapElevation: exact hit on the first entry -> 1/255', near(mapElevation(table, 0), 1 / 255));
    ok('mapElevation: exact hit on the second -> 2/255', near(mapElevation(table, 5), 2 / 255));
    ok('mapElevation: exact hit on the third -> 3/255', near(mapElevation(table, 10), 3 / 255));
    ok('mapElevation: between entries rounds UP to the next -> 2/255', near(mapElevation(table, 3), 2 / 255));
    ok('mapElevation: above every entry -> 1 (saturated)', mapElevation(table, 99) === 1);
    ok('mapElevation: below every entry -> the lowest slot', near(mapElevation(table, -50), 1 / 255));
    ok(
      "elevation table: empty input -> Foundry's -Infinity sentinel",
      buildElevationTable([]).join() === String(-Infinity)
    );
    // The 254 cap is Foundry's and is inherited on purpose.
    const many = buildElevationTable(Array.from({ length: 500 }, (_, i) => i));
    ok('elevation table: caps at 254 entries', many.length === 254);
  }

  // --- computeOcclusionState: the per-object weights ------------------------
  {
    const M = OCCLUSION_MODES;
    // FADE only counts when a token is actually under it — the mask has no
    // spatial info for this channel, so the boolean IS the gate.
    ok(
      'state: FADE + occluded -> fade 1',
      computeOcclusionState({ occlusionMode: M.FADE, occluded: true, visionActive: false }).fade === 1
    );
    ok(
      'state: FADE + NOT occluded -> fade 0',
      computeOcclusionState({ occlusionMode: M.FADE, occluded: false, visionActive: false }).fade === 0
    );
    // RADIAL/SURFACE are unconditional weights; the MASK does the spatial work.
    ok(
      'state: RADIAL -> radial 1 regardless of occluded',
      computeOcclusionState({ occlusionMode: M.RADIAL, occluded: false, visionActive: false }).radial === 1
    );
    ok(
      'state: SURFACE -> surface 1',
      computeOcclusionState({ occlusionMode: M.SURFACE, occluded: false, visionActive: false }).surface === 1
    );
    // Combined modes both light up.
    const both = computeOcclusionState({ occlusionMode: M.RADIAL | M.SURFACE, occluded: false, visionActive: false });
    ok('state: RADIAL|SURFACE lights both channels', both.radial === 1 && both.surface === 1);
  }

  // --- computeOcclusionState: VISION's fallback to FADE ---------------------
  {
    const M = OCCLUSION_MODES;
    // Foundry's deliberate degradation: a VISION roof with no vision source
    // would be permanently opaque (e.g. a GM with nothing selected), so it falls
    // back to fading whole.
    const withVision = computeOcclusionState({ occlusionMode: M.VISION, occluded: true, visionActive: true });
    ok('state: VISION + a vision source -> vision 1, fade 0', withVision.vision === 1 && withVision.fade === 0);
    const noVision = computeOcclusionState({ occlusionMode: M.VISION, occluded: true, visionActive: false });
    ok(
      'state: VISION + NO vision source + occluded -> degrades to fade 1',
      noVision.fade === 1 && noVision.vision === 0
    );
    const noVisionNoToken = computeOcclusionState({ occlusionMode: M.VISION, occluded: false, visionActive: false });
    ok('state: VISION + no source + no token -> nothing', noVisionNoToken.fade === 0 && noVisionNoToken.vision === 0);
  }

  // --- computeOcclusionState: hover-fade rides the live channel -------------
  {
    const M = OCCLUSION_MODES;
    // THE author-requested behavior: hover the roof, see the token.
    const hoverNoVision = computeOcclusionState({
      occlusionMode: M.FADE,
      occluded: false,
      visionActive: false,
      hoverFadeAmount: 0.7,
    });
    ok('hover: with no vision source it maxes into FADE', near(hoverNoVision.fade, 0.7));
    const hoverVision = computeOcclusionState({
      occlusionMode: M.FADE,
      occluded: false,
      visionActive: true,
      hoverFadeAmount: 0.7,
    });
    ok(
      'hover: with a vision source it maxes into VISION instead',
      near(hoverVision.vision, 0.7) && hoverVision.fade === 0
    );
    // Hover must never REDUCE an already-full occlusion.
    const hoverWeaker = computeOcclusionState({
      occlusionMode: M.FADE,
      occluded: true,
      visionActive: false,
      hoverFadeAmount: 0.3,
    });
    ok('hover: max(), so a weak hover cannot undo a full fade', hoverWeaker.fade === 1);
    // Hover works even on a NONE-mode object (Foundry gates that via hoverFade,
    // not via the mode) — so the weight must still come through here.
    const hoverNone = computeOcclusionState({
      occlusionMode: M.NONE,
      occluded: false,
      visionActive: false,
      hoverFadeAmount: 1,
    });
    ok('hover: applies regardless of mode (hoverFade is gated separately)', hoverNone.fade === 1);
  }

  // --- testTokenOcclusion ---------------------------------------------------
  {
    const always = () => true;
    const never = () => false;
    const pts = [{ x: 0, y: 0 }];
    ok(
      'testOcclusion: token below + hit -> occludes',
      testTokenOcclusion({ tokenElevation: 5, objectElevation: 10, testPoints: pts, containsPoint: always }) === true
    );
    // STRICT: equal elevation must NOT occlude. This is the common authoring case
    // (a tile and a token both at 0) and getting it wrong fades every ground tile.
    ok(
      'testOcclusion: token at the SAME elevation does NOT occlude (strict >=)',
      testTokenOcclusion({ tokenElevation: 10, objectElevation: 10, testPoints: pts, containsPoint: always }) === false
    );
    ok(
      'testOcclusion: token ABOVE does not occlude',
      testTokenOcclusion({ tokenElevation: 20, objectElevation: 10, testPoints: pts, containsPoint: always }) === false
    );
    ok(
      'testOcclusion: below but no point hits -> no',
      testTokenOcclusion({ tokenElevation: 5, objectElevation: 10, testPoints: pts, containsPoint: never }) === false
    );
    ok(
      'testOcclusion: bounds early-out short-circuits',
      testTokenOcclusion({
        tokenElevation: 5,
        objectElevation: 10,
        testPoints: pts,
        containsPoint: always,
        boundsIntersect: never,
      }) === false
    );
    // Any ONE test point hitting is enough.
    let calls = 0;
    const hitSecond = (p) => {
      calls++;
      return p.x === 1;
    };
    ok(
      'testOcclusion: any single test point hitting is enough',
      testTokenOcclusion({
        tokenElevation: 5,
        objectElevation: 10,
        testPoints: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        containsPoint: hitSecond,
      }) === true
    );
    ok('testOcclusion: stops at the first hit', calls === 2);
  }

  // --- easeInOutCosine ------------------------------------------------------
  {
    ok('ease: 0 -> 0', near(easeInOutCosine(0), 0));
    ok('ease: 1 -> 1', near(easeInOutCosine(1), 1));
    ok('ease: 0.5 -> 0.5', near(easeInOutCosine(0.5), 0.5));
    ok('ease: monotonic', easeInOutCosine(0.25) < easeInOutCosine(0.75));
  }

  // --- updateHoverFade: the delay, the ramp, the settle --------------------
  {
    const cfg = { delay: 250, duration: 500 };
    const s = createHoverFadeState();
    ok('hoverFade: starts unfaded', s.occlusion === 0 && s.faded === false);

    // Pointer arrives at t=1000.
    s.hovered = true;
    s.hoveredTime = 1000;
    updateHoverFade(s, 1100, cfg);
    // The delay is what stops a roof strobing as the pointer crosses it.
    ok('hoverFade: nothing happens before the delay elapses', s.occlusion === 0 && s.faded === false);

    updateHoverFade(s, 1300, cfg); // 300ms > 250ms delay -> the ramp begins HERE
    ok('hoverFade: past the delay it starts fading', s.faded === true && s.fading === true);
    // The ramp is anchored at the instant it starts (fadingTime = time), so
    // occlusion is exactly 0 at t=1300 and climbs from there — it does not
    // inherit any progress from the delay period.
    ok('hoverFade: the ramp starts at exactly 0, not partway', s.occlusion === 0);

    updateHoverFade(s, 1550, cfg); // 250ms into a 500ms duration -> ease(0.5)
    ok('hoverFade: halfway through the ramp -> 0.5', near(s.occlusion, 0.5));
    ok('hoverFade: still fading at the halfway point', s.fading === true);

    updateHoverFade(s, 1900, cfg); // well past fadingTime + duration
    ok('hoverFade: settles fully faded at 1', s.fading === false && s.occlusion === 1);
  }

  // --- updateHoverFade: leaving fades back out -----------------------------
  {
    const cfg = { delay: 0, duration: 400 };
    const s = createHoverFadeState();
    s.hovered = true;
    s.hoveredTime = 0;
    updateHoverFade(s, 500, cfg);
    ok('hoverFade: zero delay + past duration -> fully faded', s.occlusion === 1);
    // Pointer leaves.
    s.hovered = false;
    s.hoveredTime = 500;
    updateHoverFade(s, 1000, cfg);
    ok('hoverFade: leaving settles back to 0', s.occlusion === 0 && s.faded === false);
  }

  // --- updateHoverFade: reversal mid-flight must not pop -------------------
  {
    const cfg = { delay: 0, duration: 400 };
    const s = createHoverFadeState();
    s.hovered = true;
    s.hoveredTime = 0;
    updateHoverFade(s, 100, cfg); // ramp begins at t=100 (occlusion 0)
    updateHoverFade(s, 300, cfg); // 200/400 -> halfway in
    const midIn = s.occlusion;
    ok('hoverFade: halfway into the fade-in', near(midIn, 0.5));
    // Change of mind: pointer leaves mid-fade. The value must CONTINUE from where
    // it visually is, not restart — a pop here is exactly the jank the time
    // reflection in updateHoverFade() exists to prevent.
    s.hovered = false;
    const afterReversal = updateHoverFade(s, 300, cfg).occlusion;
    ok('hoverFade: reversal is continuous (no jump at the instant of reversal)', near(afterReversal, midIn, 1e-6));
    // ...and from there it must head back DOWN, not keep climbing.
    updateHoverFade(s, 400, cfg);
    ok('hoverFade: after reversing it fades back out', s.occlusion < afterReversal);
  }

  // --- computeOcclusionAlpha: the CPU mirror of the shader ------------------
  {
    // The scenario: a roof (elevation 10) and a token (elevation 5), plus a
    // second roof at 2 that the same token must NOT fade.
    const table = buildElevationTable([5]); // one occluder: the token at 5
    const tokenValue = mapElevation(table, 5); // what the token writes into the mask
    const roofElevation = mapElevation(table, 10);
    const lowTileElevation = mapElevation(table, 2);

    // Inside the token's radial disc, G = tokenValue; elsewhere G = 1 (cleared).
    const insideDisc = { r: 0, g: tokenValue, b: 1, a: 1 };
    const outsideDisc = { r: 0, g: 1, b: 1, a: 1 };
    const radialState = { fade: 0, radial: 1, vision: 0, surface: 0 };

    const roofInside = computeOcclusionAlpha({
      maskSample: insideDisc,
      occlusionElevation: roofElevation,
      state: radialState,
      unoccludedAlpha: 1,
      occludedAlpha: 0,
    });
    ok('shader mirror: RADIAL roof ABOVE the token fades inside the disc', near(roofInside, 0));

    const roofOutside = computeOcclusionAlpha({
      maskSample: outsideDisc,
      occlusionElevation: roofElevation,
      state: radialState,
      unoccludedAlpha: 1,
      occludedAlpha: 0,
    });
    ok('shader mirror: the same roof stays opaque outside the disc', near(roofOutside, 1));

    // THE key property: a tile BELOW the token must not be revealed by it.
    const lowInside = computeOcclusionAlpha({
      maskSample: insideDisc,
      occlusionElevation: lowTileElevation,
      state: radialState,
      unoccludedAlpha: 1,
      occludedAlpha: 0,
    });
    ok('shader mirror: a tile BELOW the token is NOT faded, even inside the disc', near(lowInside, 1));

    // occludedAlpha isn't always 0 — Foundry lets a tile fade to partial.
    const partial = computeOcclusionAlpha({
      maskSample: insideDisc,
      occlusionElevation: roofElevation,
      state: radialState,
      unoccludedAlpha: 1,
      occludedAlpha: 0.25,
    });
    ok('shader mirror: honours a non-zero occludedAlpha', near(partial, 0.25));

    // A channel with zero weight must contribute nothing even where the mask says
    // "occluded" — this is what keeps the four modes independent.
    const noRadial = computeOcclusionAlpha({
      maskSample: insideDisc,
      occlusionElevation: roofElevation,
      state: { fade: 0, radial: 0, vision: 0, surface: 0 },
      unoccludedAlpha: 1,
      occludedAlpha: 0,
    });
    ok('shader mirror: zero weight -> no occlusion regardless of the mask', near(noRadial, 1));

    // max() across channels: the strongest wins.
    const mixed = computeOcclusionAlpha({
      maskSample: { r: 0, g: tokenValue, b: 1, a: 1 },
      occlusionElevation: roofElevation,
      state: { fade: 0, radial: 0.5, vision: 1, surface: 0 },
      unoccludedAlpha: 1,
      occludedAlpha: 0,
    });
    ok('shader mirror: max() across channels — B is cleared so RADIAL 0.5 wins', near(mixed, 0.5));
  }

  // --- computeOcclusionAlpha: FADE's constant-R channel --------------------
  {
    // Foundry clears R to 0 and never writes it (MIN blend + 0xFF writes are
    // no-ops), so R is ALWAYS 0 == "occlude everywhere". The gate is the weight.
    const table = buildElevationTable([5]);
    const roof = mapElevation(table, 10);
    const mask = { r: 0, g: 1, b: 1, a: 1 };
    const faded = computeOcclusionAlpha({
      maskSample: mask,
      occlusionElevation: roof,
      state: { fade: 1, radial: 0, vision: 0, surface: 0 },
      unoccludedAlpha: 1,
      occludedAlpha: 0,
    });
    ok('shader mirror: FADE weight 1 + constant-0 R channel -> whole tile fades', near(faded, 0));
    const notFaded = computeOcclusionAlpha({
      maskSample: mask,
      occlusionElevation: roof,
      state: { fade: 0, radial: 0, vision: 0, surface: 0 },
      unoccludedAlpha: 1,
      occludedAlpha: 0,
    });
    ok('shader mirror: FADE weight 0 -> unaffected despite R=0', near(notFaded, 1));
  }
}
