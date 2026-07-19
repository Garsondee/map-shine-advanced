/**
 * Node verification for foundry/scene-lights.js.
 *
 * `deriveLightSnapshot`/`deriveGlobalLightConfig` are testable here — same
 * split as scene-environment.test.mjs's own header explains: the pure
 * validation logic is Node-tested, the live `canvas.effects.lightSources`/
 * `canvas.scene.environment.globalLight` reads are browser-only (verified
 * via a debug report, not here).
 */
import { deriveLightSnapshot, deriveGlobalLightConfig } from '../scene-lights.js';

/** A valid triangle around the origin — 3 vertices, 6 numbers, even length. */
const TRIANGLE = [-100, -100, 100, -100, 0, 100];

export function run(t) {
  const { ok } = t;

  // ---- the happy path: a real, well-formed light passes through ----------
  {
    const raw = {
      sourceId: 'AmbientLight.abc123',
      x: 500,
      y: 600,
      radius: 300,
      ratio: 0.4,
      attenuation: 0.6,
      shapePoints: TRIANGLE,
    };
    const snap = deriveLightSnapshot(raw);
    ok('a valid light is not rejected', snap !== null);
    ok('sourceId passes through', snap.sourceId === 'AmbientLight.abc123');
    ok('x/y pass through', snap.x === 500 && snap.y === 600);
    ok('radius passes through', snap.radius === 300);
    ok('ratio passes through', snap.ratio === 0.4);
    ok('attenuation01 passes through', snap.attenuation01 === 0.6);
    ok('shapePoints passes through by reference-equal content', snap.shapePoints.join(',') === TRIANGLE.join(','));
  }

  // ---- missing/invalid sourceId is rejected -------------------------------
  ok('undefined sourceId rejected', deriveLightSnapshot({ x: 0, y: 0, radius: 1, shapePoints: TRIANGLE }) === null);
  ok(
    'empty-string sourceId rejected',
    deriveLightSnapshot({ sourceId: '', x: 0, y: 0, radius: 1, shapePoints: TRIANGLE }) === null
  );
  ok(
    'non-string sourceId rejected',
    deriveLightSnapshot({ sourceId: 42, x: 0, y: 0, radius: 1, shapePoints: TRIANGLE }) === null
  );

  // ---- non-finite position is rejected ------------------------------------
  ok('NaN x rejected', deriveLightSnapshot({ sourceId: 'a', x: NaN, y: 0, radius: 1, shapePoints: TRIANGLE }) === null);
  ok(
    'undefined y rejected',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: undefined, radius: 1, shapePoints: TRIANGLE }) === null
  );

  // ---- radius <= 0 is rejected (a disabled/degenerate light draws nothing) -
  ok(
    'radius 0 rejected',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 0, shapePoints: TRIANGLE }) === null
  );
  ok(
    'negative radius rejected',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: -50, shapePoints: TRIANGLE }) === null
  );
  ok(
    'NaN radius rejected',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: NaN, shapePoints: TRIANGLE }) === null
  );

  // ---- shapePoints validation ----------------------------------------------
  ok('missing shapePoints rejected', deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1 }) === null);
  ok(
    'non-array shapePoints rejected',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1, shapePoints: 'nope' }) === null
  );
  ok(
    'too-few points (< 3 vertices) rejected',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1, shapePoints: [0, 0, 1, 1] }) === null
  );
  ok(
    'odd-length points array rejected (not a flat x,y pair list)',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1, shapePoints: [0, 0, 1, 1, 2] }) === null
  );
  ok(
    'a non-finite coordinate anywhere in the polygon rejects the whole shape',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1, shapePoints: [0, 0, 1, 1, NaN, 2] }) === null
  );
  ok(
    'exactly 3 vertices (6 numbers) is the minimum valid polygon',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1, shapePoints: TRIANGLE }) !== null
  );

  // ---- ratio/attenuation clamp rather than propagate a bad number ---------
  {
    const outOfRange = deriveLightSnapshot({
      sourceId: 'a',
      x: 0,
      y: 0,
      radius: 1,
      ratio: 1.7,
      attenuation: -0.3,
      shapePoints: TRIANGLE,
    });
    ok('ratio above 1 clamps to 1', outOfRange.ratio === 1);
    ok('attenuation below 0 clamps to 0', outOfRange.attenuation01 === 0);
  }
  {
    const missing = deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1, shapePoints: TRIANGLE });
    ok('missing ratio reads as 0 (never NaN)', missing.ratio === 0);
    ok(
      "missing attenuation reads as Foundry's own default (0.5), matching LightData's AlphaField initial",
      missing.attenuation01 === 0.5
    );
  }
  {
    const bad = deriveLightSnapshot({
      sourceId: 'a',
      x: 0,
      y: 0,
      radius: 1,
      ratio: 'nope',
      attenuation: NaN,
      shapePoints: TRIANGLE,
    });
    ok('non-numeric ratio reads as 0, never propagated', bad.ratio === 0);
    ok('NaN attenuation reads as 0, never propagated', bad.attenuation01 === 0);
  }

  // ---- luminosity01 ---------------------------------------------------------
  {
    const withLum = deriveLightSnapshot({
      sourceId: 'a',
      x: 0,
      y: 0,
      radius: 1,
      luminosity: 0.8,
      shapePoints: TRIANGLE,
    });
    ok('luminosity passes through', withLum.luminosity01 === 0.8);
    const noLum = deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1, shapePoints: TRIANGLE });
    ok("missing luminosity reads as Foundry's own default (0.5) — a neutral (0) exposure", noLum.luminosity01 === 0.5);
    const badLum = deriveLightSnapshot({
      sourceId: 'a',
      x: 0,
      y: 0,
      radius: 1,
      luminosity: NaN,
      shapePoints: TRIANGLE,
    });
    ok('NaN luminosity falls back to 0.5, never NaN', badLum.luminosity01 === 0.5);
  }

  // ---- alpha01 / color — the coloration channel's own inputs --------------
  {
    const snap = deriveLightSnapshot({
      sourceId: 'a',
      x: 0,
      y: 0,
      radius: 1,
      alpha: 0.8,
      color: [0.9, 0.2, 0.1],
      shapePoints: TRIANGLE,
    });
    ok('alpha passes through', snap.alpha01 === 0.8);
    ok('color passes through', snap.color[0] === 0.9 && snap.color[1] === 0.2 && snap.color[2] === 0.1);
    ok('an authored color sets hasColor true (the coloration mesh must draw)', snap.hasColor === true);
  }
  {
    const snap = deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1, shapePoints: TRIANGLE });
    ok("missing alpha reads as Foundry's own default (0.5)", snap.alpha01 === 0.5);
    ok(
      "missing color (Foundry's own 'colourless') reads color as white, a harmless placeholder never actually sampled",
      snap.color[0] === 1 && snap.color[1] === 1 && snap.color[2] === 1
    );
    ok(
      'missing color sets hasColor false — real Foundry SKIPS the coloration layer entirely for a colourless ' +
        'light (coloration-lighting.mjs#isRequired), it does not tint neutrally; this is the "lights read ' +
        'monochrome" bug\'s fix',
      snap.hasColor === false
    );
  }
  ok(
    'NaN alpha falls back to 0.5, never NaN',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1, alpha: NaN, shapePoints: TRIANGLE }).alpha01 === 0.5
  );
  {
    const snap = deriveLightSnapshot({
      sourceId: 'a',
      x: 0,
      y: 0,
      radius: 1,
      color: 'not-an-array',
      shapePoints: TRIANGLE,
    });
    ok('a malformed color (wrong shape) falls back to white, never throws', snap.color[0] === 1);
    ok(
      'a malformed color reads as hasColor false, same as no color at all — never a false positive',
      snap.hasColor === false
    );
  }
  // ---- THE root cause of "MSA lights make the scene black and white"
  // (2026-07-19): the live reader must hand deriveLightSnapshot a real
  // [r,g,b] ARRAY (source.colorRGB), NOT a bare hex integer (what
  // source.data.color actually is — Color#valueOf()). These cases lock in
  // that a numeric colour is rejected (→ colourless white, never a silent
  // pass-through as if valid), so a regression to `source.data.color` — a
  // number — can't quietly reinstate the all-lights-read-white bug.
  {
    const asInteger = deriveLightSnapshot({
      sourceId: 'a',
      x: 0,
      y: 0,
      radius: 1,
      color: 0xff9900, // a bare hex int — what source.data.color IS, and what MSA WRONGLY read for a session
      shapePoints: TRIANGLE,
    });
    ok('a bare integer colour is rejected (not a valid rgb triple)', asInteger.hasColor === false);
    ok('a bare integer colour falls back to white, never throws', asInteger.color[0] === 1);
  }
  {
    // The CORRECT live value: source.colorRGB is a normalized [r,g,b] array.
    const orange = deriveLightSnapshot({
      sourceId: 'a',
      x: 0,
      y: 0,
      radius: 1,
      color: [1, 0.6, 0], // an orange torch, as source.colorRGB actually provides it
      shapePoints: TRIANGLE,
    });
    ok('a real rgb array (source.colorRGB) sets hasColor true', orange.hasColor === true);
    ok(
      'a real rgb array passes its hue through (so coloration tints ORANGE, not white)',
      orange.color[0] === 1 && orange.color[1] === 0.6 && orange.color[2] === 0
    );
  }

  // ---- per-light darkness activation window ({min,max}, default {0,1}) -----
  ok(
    'no window given + no darkness given: still draws (defaults are {0,1} and 0)',
    deriveLightSnapshot({ sourceId: 'a', x: 0, y: 0, radius: 1, shapePoints: TRIANGLE }) !== null
  );
  ok(
    'darkness01 below the window rejects the light (not yet dark enough to switch on)',
    deriveLightSnapshot(
      { sourceId: 'a', x: 0, y: 0, radius: 1, darknessMin: 0.5, darknessMax: 1, shapePoints: TRIANGLE },
      0.3
    ) === null
  );
  ok(
    'darkness01 inside the window draws',
    deriveLightSnapshot(
      { sourceId: 'a', x: 0, y: 0, radius: 1, darknessMin: 0.5, darknessMax: 1, shapePoints: TRIANGLE },
      0.7
    ) !== null
  );
  ok(
    'darkness01 above the window rejects the light (a daytime-only light, at night)',
    deriveLightSnapshot(
      { sourceId: 'a', x: 0, y: 0, radius: 1, darknessMin: 0, darknessMax: 0.4, shapePoints: TRIANGLE },
      0.9
    ) === null
  );
  ok(
    'exactly at min/max boundary still draws (inclusive window)',
    deriveLightSnapshot(
      { sourceId: 'a', x: 0, y: 0, radius: 1, darknessMin: 0.5, darknessMax: 0.5, shapePoints: TRIANGLE },
      0.5
    ) !== null
  );
  ok(
    'a non-finite darkness01 floors to 0, same as deriveDarkness’s own "could not read" floor',
    deriveLightSnapshot(
      { sourceId: 'a', x: 0, y: 0, radius: 1, darknessMin: 0, darknessMax: 1, shapePoints: TRIANGLE },
      NaN
    ) !== null
  );

  // ---- deriveGlobalLightConfig — the scene's Global Illumination gate.
  // Same "return null to skip" convention as deriveLightSnapshot. ----------
  ok('disabled reads as null (no floor to raise)', deriveGlobalLightConfig({ enabled: false }, 0.5) === null);
  ok('missing raw reads as null, never throws', deriveGlobalLightConfig(null, 0.5) === null);
  ok('undefined enabled (malformed read) reads as null', deriveGlobalLightConfig({}, 0.5) === null);

  {
    const cfg = deriveGlobalLightConfig({ enabled: true, luminosity: 0.7, bright: true }, 0.5);
    ok('enabled + no window configured (schema default {0,1}) is active at any darkness', cfg !== null);
    ok('luminosity passes through', cfg.luminosity01 === 0.7);
    ok('bright passes through', cfg.bright === true);
  }
  {
    const cfg = deriveGlobalLightConfig({ enabled: true }, 0.5);
    ok(
      "missing luminosity reads as GlobalLightData's OWN default (0), NOT a normal light's 0.5 — different schema default",
      cfg.luminosity01 === 0
    );
    ok('missing bright reads as false (dim mode)', cfg.bright === false);
  }
  ok(
    'darkness01 outside the configured window is rejected (enabled but not active right now)',
    deriveGlobalLightConfig({ enabled: true, darknessMin: 0, darknessMax: 0.5 }, 0.8) === null
  );
  ok(
    'darkness01 inside the configured window is active',
    deriveGlobalLightConfig({ enabled: true, darknessMin: 0, darknessMax: 0.5 }, 0.3) !== null
  );
  ok(
    'a non-finite darkness01 floors to 0, same convention as deriveLightSnapshot',
    deriveGlobalLightConfig({ enabled: true, darknessMin: 0, darknessMax: 1 }, NaN) !== null
  );
}
