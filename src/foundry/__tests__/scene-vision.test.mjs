/**
 * Node verification for foundry/scene-vision.js — slice 1 of "MSA owns
 * vision/fog" (Testament Pillar 11).
 *
 * Only the pure half is testable here; `readActiveVisionSources` reads live
 * Foundry globals and is browser-only, same split every other reader in this
 * zone uses. The live half is covered by
 * `tests/playwright/msa-token-vision-noon.spec.js`, which creates and CONTROLS
 * a real token — the bench scene ships none, and a GM with nothing selected
 * exercises none of this.
 */
import { deriveVisionSource, isUsablePolygon, shouldGateVision, MIN_POLYGON_FLOATS } from '../scene-vision.js';
import { REPORT_BUILD_TAG } from '../vision-diagnostics.js';
// `effects/` sits above `foundry/` in the layering (`zones/one-door` —
// foundry/ is a leaf and may not import effects/ in PRODUCTION code), but a
// __tests__ file is verification code, not a runtime cross-zone import, so
// pinning both tags equal HERE is what proves the two independent literals
// (which production code genuinely cannot share) haven't silently drifted.
import { VISION_GATE_BUILD_TAG } from '../../effects/vision/vision-mask.js';

/** A minimal square LOS polygon, flat [x0,y0,...] the way Foundry emits it. */
const SQUARE = [0, 0, 100, 0, 100, 100, 0, 100];

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // isUsablePolygon
  // ======================================================================
  ok('a real square is usable', isUsablePolygon(SQUARE));
  ok('exactly 3 vertices (the minimum enclosing an area) is usable', isUsablePolygon([0, 0, 1, 0, 0, 1]));
  ok('two vertices cannot enclose area', !isUsablePolygon([0, 0, 1, 1]));
  ok('an odd-length array is malformed, never half-read', !isUsablePolygon([0, 0, 1, 0, 5]));
  ok('a non-array never throws, just reads false', isUsablePolygon(null) === false);
  ok('the minimum is 3 vertices = 6 floats', MIN_POLYGON_FLOATS === 6);

  // ======================================================================
  // deriveVisionSource — the happy path
  // ======================================================================
  {
    const v = deriveVisionSource({
      sourceId: 'Token.abc',
      active: true,
      hasActiveLayer: true,
      x: 50,
      y: 60,
      elevation: 0,
      radius: 0,
      lightRadius: Infinity,
      blinded: false,
      losPoints: SQUARE,
      lightPoints: SQUARE,
    });
    ok('a real source is derived', v !== null);
    ok('origin passes through', v.x === 50 && v.y === 60);
    ok('the LOS polygon is passed by REFERENCE, not copied per frame', v.losPoints === SQUARE);
    ok('blinded reads false', v.blinded === false);
  }

  // ---- Infinity is a REAL value here, not a bug to normalise away --------
  // Foundry's own default light perception is unlimited. The trap this pins:
  // JSON.stringify(Infinity) === "null", which reads exactly like "missing"
  // and cost a full round of the investigation that started this build.
  {
    const v = deriveVisionSource({
      sourceId: 'Token.abc',
      x: 0,
      y: 0,
      radius: 0,
      lightRadius: Infinity,
      losPoints: SQUARE,
    });
    ok('an unlimited light radius survives as real Infinity', v.lightRadius === Infinity);
    ok('and is NOT silently turned into 0', v.lightRadius !== 0);
  }

  // ---- radius and lightRadius are two DIFFERENT questions ---------------
  // Merging them would either grant darkvision to everyone (if lightRadius
  // won) or delete it from everyone (if radius won).
  {
    const v = deriveVisionSource({
      sourceId: 'Token.abc',
      x: 0,
      y: 0,
      radius: 30, // sees 30px in pitch darkness
      lightRadius: 900, // sees lit things out to 900px
      losPoints: SQUARE,
    });
    ok('sight radius is kept distinct', v.radius === 30);
    ok('light-perception radius is kept distinct', v.lightRadius === 900);
    ok('they are not collapsed into one another', v.radius !== v.lightRadius);
  }

  // ======================================================================
  // deriveVisionSource — everything that must NOT become a contributor
  // ======================================================================
  ok('null input never throws', deriveVisionSource(null) === null);
  ok('a missing sourceId is rejected', deriveVisionSource({ x: 0, y: 0, losPoints: SQUARE }) === null);
  ok(
    'an INACTIVE source contributes nothing — Foundry already decided that',
    deriveVisionSource({ sourceId: 'a', active: false, x: 0, y: 0, losPoints: SQUARE }) === null
  );
  ok(
    'a source with no active layer contributes nothing',
    deriveVisionSource({ sourceId: 'a', hasActiveLayer: false, x: 0, y: 0, losPoints: SQUARE }) === null
  );
  ok(
    'a non-finite origin is rejected rather than propagating NaN into geometry',
    deriveVisionSource({ sourceId: 'a', x: NaN, y: 0, losPoints: SQUARE }) === null
  );
  ok(
    'a source with NO usable geometry at all contributes nothing',
    deriveVisionSource({ sourceId: 'a', x: 0, y: 0, losPoints: [0, 0], lightPoints: null }) === null
  );
  {
    // ...but ONE usable polygon is enough: a token whose light perception is
    // off still has a real LOS polygon and must still reveal within its own
    // sight radius.
    const v = deriveVisionSource({ sourceId: 'a', x: 0, y: 0, radius: 40, losPoints: SQUARE, lightPoints: null });
    ok('LOS alone is a real contributor', v !== null && v.losPoints === SQUARE && v.lightPoints === null);
  }

  // ---- a blinded source keeps geometry but is FLAGGED -------------------
  // Foundry drops a blinded source from its light mask; carrying the flag (vs
  // dropping the source) lets the renderer honour that without the token
  // silently vanishing from its own view.
  {
    const v = deriveVisionSource({ sourceId: 'a', x: 0, y: 0, blinded: true, losPoints: SQUARE });
    ok('a blinded source is still derived', v !== null);
    ok('and is flagged so the renderer can refuse to reveal through it', v.blinded === true);
  }

  // ---- negative/garbage radii are floored, never propagated -------------
  {
    const v = deriveVisionSource({ sourceId: 'a', x: 0, y: 0, radius: -50, lightRadius: 'nope', losPoints: SQUARE });
    ok('a negative radius floors to 0', v.radius === 0);
    ok('a non-numeric radius floors to 0 rather than NaN', v.lightRadius === 0);
  }

  // ======================================================================
  // shouldGateVision — reproduces Foundry's own skip, which is load-bearing
  // ======================================================================
  // `CanvasVisibility#refresh`: visible = sources.some(active) || !isGM.
  // A GM with nothing selected skips the ENTIRE visibility group — which is
  // exactly why two earlier "verified live" claims in this investigation were
  // measuring nothing at all.
  ok(
    'a GM with no vision source is NOT gated (sees everything)',
    shouldGateVision({ sourceCount: 0, isGM: true }) === false
  );
  ok('a GM controlling a token IS gated', shouldGateVision({ sourceCount: 1, isGM: true }) === true);
  ok(
    'a PLAYER with no vision source is STILL gated — never a free reveal',
    shouldGateVision({ sourceCount: 0, isGM: false }) === true
  );
  ok('a player with a vision source is gated', shouldGateVision({ sourceCount: 2, isGM: false }) === true);

  // ======================================================================
  // ⚠️ THE CROSS-FILE BUILD-TAG PIN — see both tags' own doc comments
  // ======================================================================
  // `foundry/vision-diagnostics.js#REPORT_BUILD_TAG` and
  // `effects/vision/vision-mask.js#VISION_GATE_BUILD_TAG` are two INDEPENDENT
  // literals because `foundry/` may not import `effects/` in production code
  // — but they describe the SAME fact (which cut of the reveal rule is live)
  // and MUST agree, or a pasted-back diagnostic report can no longer be
  // trusted to say which build actually produced it. This is the enforcement:
  // bump one without the other and this test fails, by name, immediately.
  ok(
    'REPORT_BUILD_TAG and VISION_GATE_BUILD_TAG are the SAME string — bump both together or this fails',
    REPORT_BUILD_TAG === VISION_GATE_BUILD_TAG
  );
}
