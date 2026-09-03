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
  isHoverFadeEligible,
  buildElevationTable,
  mapElevation,
  computeOcclusionState,
  testTokenOcclusion,
  testItemHoverAlpha,
  testVegetationHoverAlpha,
  createHoverFadeState,
  HOVER_FADE_CONFIG,
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

  // --- isHoverFadeEligible: tile.mjs:365's exact rule ------------------------
  {
    const M = OCCLUSION_MODES;
    ok('hoverFadeEligible: NONE is never eligible', isHoverFadeEligible(M.NONE) === false);
    ok('hoverFadeEligible: FADE alone is eligible', isHoverFadeEligible(M.FADE) === true);
    ok('hoverFadeEligible: RADIAL alone is eligible', isHoverFadeEligible(M.RADIAL) === true);
    ok('hoverFadeEligible: VISION alone is eligible', isHoverFadeEligible(M.VISION) === true);
    // SURFACE is excluded even combined with something else eligible — real
    // Foundry's own `!(occlusionMode & M.SURFACE)` half of the expression.
    ok('hoverFadeEligible: SURFACE alone is NOT eligible', isHoverFadeEligible(M.SURFACE) === false);
    ok(
      'hoverFadeEligible: RADIAL|SURFACE is NOT eligible (SURFACE poisons it)',
      isHoverFadeEligible(M.RADIAL | M.SURFACE) === false
    );
    ok('hoverFadeEligible: FADE|SURFACE is NOT eligible', isHoverFadeEligible(M.FADE | M.SURFACE) === false);
    ok('hoverFadeEligible: FADE|RADIAL (no SURFACE) is eligible', isHoverFadeEligible(M.FADE | M.RADIAL) === true);
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

  // --- testItemHoverAlpha: the CPU mirror of containsCanvasPoint's alpha test
  {
    // A 2x2 grid: opaque top-left texel (255), transparent everywhere else.
    const grid = { w: 2, h: 2, data: new Uint8Array([255, 0, 0, 0]) };
    ok(
      'hoverAlpha: off the quad entirely (u<0) is never a hit',
      testItemHoverAlpha({ u: -0.1, v: 0.5, grid, alphaThreshold: 0.75 }) === false
    );
    ok(
      'hoverAlpha: off the quad entirely (v>1) is never a hit',
      testItemHoverAlpha({ u: 0.5, v: 1.1, grid, alphaThreshold: 0.75 }) === false
    );
    ok(
      'hoverAlpha: u=0/v=0 (top-left texel, opaque) hits at the default 0.75 threshold',
      testItemHoverAlpha({ u: 0, v: 0, grid, alphaThreshold: 0.75 }) === true
    );
    ok(
      'hoverAlpha: u=1/v=1 (bottom-right texel, transparent) does not hit',
      testItemHoverAlpha({ u: 0.99, v: 0.99, grid, alphaThreshold: 0.75 }) === false
    );
    // On-the-quad boundary values (u=1, v=1 exactly) must clamp into the grid,
    // not index out of bounds.
    ok(
      'hoverAlpha: u=1/v=1 exactly clamps to the last texel, not an out-of-range read',
      testItemHoverAlpha({ u: 1, v: 1, grid, alphaThreshold: 0.75 }) === false
    );
    // FAIL OPEN: no grid at all (still loading, or never arrived) is a hit
    // anywhere on the quad — matches this codebase's "no grid == draw the
    // whole quad" convention everywhere else a coarse alpha grid is read.
    ok(
      'hoverAlpha: missing grid fails open (still a hit, if on the quad)',
      testItemHoverAlpha({ u: 0.5, v: 0.5, grid: null, alphaThreshold: 0.75 }) === true
    );
    ok(
      'hoverAlpha: missing grid still respects the off-quad reject',
      testItemHoverAlpha({ u: 1.5, v: 0.5, grid: null, alphaThreshold: 0.75 }) === false
    );
    ok(
      'hoverAlpha: a degenerate grid (w:0) fails open exactly like a missing one',
      testItemHoverAlpha({
        u: 0.5,
        v: 0.5,
        grid: { w: 0, h: 2, data: new Uint8Array([255]) },
        alphaThreshold: 0.75,
      }) === true
    );
    // Threshold is a real gate, not decorative: the SAME texel (128/255 =
    // 0.502) hits a low threshold and misses a high one.
    const halfGrid = { w: 1, h: 1, data: new Uint8Array([128]) };
    ok(
      'hoverAlpha: a partial texel hits below its own alpha',
      testItemHoverAlpha({ u: 0.5, v: 0.5, grid: halfGrid, alphaThreshold: 0.4 }) === true
    );
    ok(
      'hoverAlpha: the SAME partial texel misses above its own alpha',
      testItemHoverAlpha({ u: 0.5, v: 0.5, grid: halfGrid, alphaThreshold: 0.6 }) === false
    );

    // Composed with testTokenOcclusion exactly as vt-pan-viewer.js wires them
    // together: testItemHoverAlpha stands in for the alpha-aware
    // `containsPoint`, proving the two functions' contracts actually fit —
    // not just that each passes its own isolated assertions. `testPoints`
    // stays {x,y} (testTokenOcclusion's real contract — a WORLD point); the
    // real caller inserts `worldToQuadUv` (scene/world-quad.js, tested in its
    // own suite) between the two, so `containsPoint` here treats x/y as
    // already-converted UV, a deliberate test-only simplification of that one
    // step, not a claim about the real coordinate mapping.
    ok(
      'composed: testTokenOcclusion + testItemHoverAlpha occludes through a real opaque texel',
      testTokenOcclusion({
        tokenElevation: 5,
        objectElevation: 10,
        testPoints: [{ x: 0, y: 0 }],
        containsPoint: (p) => testItemHoverAlpha({ u: p.x, v: p.y, grid, alphaThreshold: 0.75 }),
      }) === true
    );
    ok(
      'composed: the SAME pair does NOT occlude through a transparent texel',
      testTokenOcclusion({
        tokenElevation: 5,
        objectElevation: 10,
        testPoints: [{ x: 0.99, y: 0.99 }],
        containsPoint: (p) => testItemHoverAlpha({ u: p.x, v: p.y, grid, alphaThreshold: 0.75 }),
      }) === false
    );
  }

  // --- HOVER_FADE_CONFIG: Foundry's real CONFIG.Canvas.hoverFade -------------
  {
    // Verified directly against the vendored v14.367.0 client source
    // (client/config.mjs:1125 AND the built public/scripts/foundry.mjs:217661
    // agree): duration is 750, not a rounder-sounding guess.
    ok('HOVER_FADE_CONFIG: delay matches real Foundry (250ms)', HOVER_FADE_CONFIG.delay === 250);
    ok('HOVER_FADE_CONFIG: duration matches real Foundry (750ms)', HOVER_FADE_CONFIG.duration === 750);
    ok(
      'HOVER_FADE_CONFIG: frozen, so a careless caller cannot mutate the shared constant',
      Object.isFrozen(HOVER_FADE_CONFIG)
    );
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

  // --- REGRESSION (mythica-machina-press#470 follow-up, 2026-09-02): a
  // HOST's own coverage grid is NOT a safe substitute for a smaller feature
  // painted on top of it, for hover-hit-testing purposes ------------------
  {
    // The exact shape of the live regression (author, verbatim: "Trees just
    // turned black and hovering my mouse over them does not cause them to
    // disappear"). A Case-2 `_Tree`/`_Bush` vegetation overlay can be hosted
    // on an entire Level's BACKGROUND image, not just a small Tile
    // (`boot.js`'s own `vegetationUrlByItemId` covers `levelBackground`
    // items too — a real, deliberately supported authoring pattern:
    // `vt-pan-viewer.js#ensureVegetationOverlay`'s own measured note says
    // "`_Tree` paints 11.9% of its 12000² canvas" on the author's own map —
    // one mask painted across a WHOLE floor, not one Tile per plant). The
    // first fix attempt (`vt-pan-viewer.js`'s `runMaskOcclusionPass`) reused
    // the HOST's own hit test — `testItemHoverAlpha` against the HOST's own
    // coverage grid — to decide whether the vegetation itself was hovered.
    // This models exactly why that is unsafe: a real ground image is opaque
    // almost everywhere, so its OWN grid says "hit" at UVs the much
    // sparser vegetation-only grid (the actual painted tree/bush pixels)
    // correctly says are empty ground. Substituting one grid for the other
    // is not a rounding error — the two silhouettes can, and structurally
    // will, disagree the moment the host is bigger than the plant.
    //
    // The fix (`vegetationOverlayContainsWorldPoint`, vt-pan-viewer.js) is
    // this exact composition — `testItemHoverAlpha` against the
    // VEGETATION's OWN grid instead of the host's — so this test exercises
    // the real primitive both the broken and fixed code are built from,
    // even though the browser-only closure that wires it up cannot be
    // exercised directly from Node (this module stays GPU/DOM-free by
    // design — see this file's own header).
    const hostGrid = { w: 2, h: 2, data: new Uint8Array([255, 255, 255, 255]) }; // opaque everywhere — a real ground image
    const vegGrid = { w: 2, h: 2, data: new Uint8Array([255, 0, 0, 0]) }; // only the top-left texel is painted tree

    // A UV on bare ground — no tree painted there — but well inside the
    // host's own opaque art (this is the exact point a mouse sitting
    // anywhere over an ordinary floor lands on, almost always).
    const bareGroundUv = { u: 0.9, v: 0.9 };
    ok(
      'regression: the HOST grid alone says "hit" on bare ground (the bug\'s own premise)',
      testItemHoverAlpha({ ...bareGroundUv, grid: hostGrid, alphaThreshold: 0.75 }) === true
    );
    ok(
      'regression FIX: the VEGETATION\'s OWN grid correctly says "no hit" at the SAME point',
      testItemHoverAlpha({ ...bareGroundUv, grid: vegGrid, alphaThreshold: 0.75 }) === false
    );

    // The converse, proving this is a genuine disagreement rather than one
    // grid simply being stricter everywhere: at a UV actually painted with
    // tree art, both grids correctly agree it is a hit.
    const paintedUv = { u: 0, v: 0 };
    ok(
      'regression: both grids agree at a UV actually painted with vegetation',
      testItemHoverAlpha({ ...paintedUv, grid: hostGrid, alphaThreshold: 0.75 }) === true &&
        testItemHoverAlpha({ ...paintedUv, grid: vegGrid, alphaThreshold: 0.75 }) === true
    );
  }

  // --- testVegetationHoverAlpha: THIRD-ROUND REGRESSION (mythica-machina-
  // press#470, live report 2026-09-02, fixed 2026-09-03 — author, verbatim:
  // "No matter where the mouse is any place within the scene bounds the
  // trees/bushes fade out"). The block just above (round 2) fixed WHICH grid
  // vegetation's hover hit test samples — its OWN, never the host's — but
  // the hit test still ran that grid through `testItemHoverAlpha`, which
  // FAILS OPEN on a missing grid, by design, for its OTHER callers.
  // `entry.coverageGrid` can be null even once an entry is 'ready'
  // (vt-pan-viewer.js#ensureVegetationOverlay: `requestCoarseAlphaGrid`
  // resolves `null` on failure, it does not throw), and failing open on THAT
  // means "the whole HOST quad counts as a hit" — structurally the identical
  // bug round 2 fixed, one layer down. THIS IS EXACTLY THE GAP ROUND 2's OWN
  // TEST (just above) DID NOT COVER: it proved two GRIDS can disagree, never
  // that a MISSING grid needs a different default than
  // `testItemHoverAlpha`'s own — so a real regression slipped straight past
  // a green test suite. `testVegetationHoverAlpha` is the fix, and (unlike
  // `vegetationOverlayContainsWorldPoint`, the private vt-pan-viewer.js
  // closure that calls it — world bounds + placement + UV conversion, no
  // logic of its own beyond routing `entry.coverageGrid ?? null` in) it is
  // an exported, pure function, so it gets tested directly here rather than
  // only through the primitives it's composed from. ------------------------
  {
    const realGrid = { w: 2, h: 2, data: new Uint8Array([255, 0, 0, 0]) }; // top-left painted, rest empty

    // THE BUG, reproduced directly: testItemHoverAlpha — what vegetation's
    // hit test called before this fix — fails OPEN on a missing grid, a hit
    // ANYWHERE on the quad. This is the live symptom, verbatim: "no matter
    // where the mouse is".
    ok(
      'the PRE-FIX call (testItemHoverAlpha against a null grid) hits anywhere on the quad — the live bug, reproduced',
      testItemHoverAlpha({ u: 0.5, v: 0.5, grid: null, alphaThreshold: 0.75 }) === true &&
        testItemHoverAlpha({ u: 0.99, v: 0.01, grid: null, alphaThreshold: 0.75 }) === true
    );

    // THE FIX: testVegetationHoverAlpha fails CLOSED on the identical
    // missing grid, at the identical UVs — no hover-fade until real data
    // arrives, rather than hover-fade everywhere, forever.
    ok(
      'the FIX (testVegetationHoverAlpha) fails CLOSED on a null grid at the SAME UVs — never a hit',
      testVegetationHoverAlpha({ u: 0.5, v: 0.5, grid: null, alphaThreshold: 0.75 }) === false &&
        testVegetationHoverAlpha({ u: 0.99, v: 0.01, grid: null, alphaThreshold: 0.75 }) === false
    );

    // The same fail-closed default for a PRESENT but degenerate grid (w:0):
    // testItemHoverAlpha's own test (above) treats this identically to a
    // missing grid, so testVegetationHoverAlpha must too, for the same
    // reason — a grid with no real cells is not "real alpha data" either.
    ok(
      'testVegetationHoverAlpha fails CLOSED on a degenerate grid (w:0) exactly like a missing one',
      testVegetationHoverAlpha({
        u: 0.5,
        v: 0.5,
        grid: { w: 0, h: 2, data: new Uint8Array([255]) },
        alphaThreshold: 0.75,
      }) === false
    );

    // NOT a blanket "always false" stub — once a REAL grid is available,
    // testVegetationHoverAlpha must agree with testItemHoverAlpha exactly:
    // hit on a painted texel, miss on an empty one, off-quad still rejects.
    // Proves the fix changes ONLY the missing-grid default, nothing else
    // about the comparison itself.
    ok(
      'with a real grid, testVegetationHoverAlpha hits a painted texel exactly like testItemHoverAlpha',
      testVegetationHoverAlpha({ u: 0, v: 0, grid: realGrid, alphaThreshold: 0.75 }) === true &&
        testItemHoverAlpha({ u: 0, v: 0, grid: realGrid, alphaThreshold: 0.75 }) === true
    );
    ok(
      'with a real grid, testVegetationHoverAlpha misses an empty texel exactly like testItemHoverAlpha',
      testVegetationHoverAlpha({ u: 0.99, v: 0.99, grid: realGrid, alphaThreshold: 0.75 }) === false &&
        testItemHoverAlpha({ u: 0.99, v: 0.99, grid: realGrid, alphaThreshold: 0.75 }) === false
    );
    ok(
      'off the quad entirely, testVegetationHoverAlpha still rejects even with a real grid present',
      testVegetationHoverAlpha({ u: 1.5, v: 0.5, grid: realGrid, alphaThreshold: 0.75 }) === false
    );
    ok(
      'off the quad AND a missing grid — still false (the bounds check does not depend on the grid check)',
      testVegetationHoverAlpha({ u: -0.1, v: 0.5, grid: null, alphaThreshold: 0.75 }) === false
    );

    // THE FULL THIRD-ROUND SCENARIO, composed exactly as
    // `vegetationOverlayContainsWorldPoint` calls it: a level-background HOST
    // (opaque virtually everywhere — see round 2's regression block above,
    // `bareGroundUv`/`hostGrid`) whose vegetation overlay's OWN grid fetch
    // failed. The OLD call (`testItemHoverAlpha` against `entry.coverageGrid
    // ?? null`) says "hit" continuously across the host's own bounds; the
    // NEW call (`testVegetationHoverAlpha`) says "no hit" at the identical
    // point, until a real grid arrives.
    const bareGroundUv = { u: 0.9, v: 0.9 }; // the same point round 2's own test used
    ok(
      'third-round scenario: a level-background host + a FAILED vegetation grid fetch — the old call still hits',
      testItemHoverAlpha({ ...bareGroundUv, grid: null, alphaThreshold: 0.75 }) === true
    );
    ok(
      'third-round scenario: the SAME failed fetch — the new call correctly never hits',
      testVegetationHoverAlpha({ ...bareGroundUv, grid: null, alphaThreshold: 0.75 }) === false
    );
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
