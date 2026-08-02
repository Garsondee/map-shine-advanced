/**
 * Node verification for vt/scene-attr.js.
 *
 * TSL node construction is inherently GPU/browser-only (CONVENTIONS.md §4) —
 * these tests verify the JS-level WIRING (which descriptor fields are set,
 * which TSL functions get called with what), not shader correctness. A
 * minimal mock TSL stands in: each function returns a plain marker object
 * recording its own call, so assertions read the SHAPE of what was built.
 */
import {
  describeSceneAttrMrt,
  buildSceneAttrZeroMrt,
  packFloorAttr,
  buildRealFloorAttrMrtNode,
  resolveItemFloorAttrUniforms,
  occludesBackgroundPresenceBit,
  PRESENCE_BIT_OVERHEAD,
  PRESENCE_BIT_OCCLUDES_BACKGROUND,
} from '../scene-attr.js';
import { SPECULAR_OCCLUDES_BACKGROUND_THRESHOLD01 } from '../../effects/specular/specular-render.js';
// The elevation-only lookup the floor-ownership fix replaced — imported so the
// regression block below can prove it genuinely disagrees (a non-vacuous test).
import { resolveElevationFloorIndex } from '../../scene/layer-order.js';

// A real (not swizzle-capable) plain object standing in for `output.a` —
// distinct identity from the bare `output` symbol so a test can tell whether
// a node came from `output.a` specifically, not just "some node".
const OUTPUT_ALPHA_SWIZZLE = { __kind: 'output-alpha-swizzle' };

function makeTSL() {
  return {
    mrt: (outputs) => ({ __kind: 'mrt', outputs }),
    output: { __kind: 'output-symbol', a: OUTPUT_ALPHA_SWIZZLE },
    vec4: (...args) => ({ __kind: 'vec4', args }),
    float: (v) => ({ __kind: 'float', value: v }),
    uniform: (v) => ({ __kind: 'uniform', value: v?.value }),
  };
}

function makeTHREE() {
  return {
    HalfFloatType: 'F16',
    UnsignedByteType: 'U8',
    NoColorSpace: 'none',
    TSL: makeTSL(),
  };
}

export function run(t) {
  const { ok } = t;

  // describeSceneAttrMrt — pure descriptor shape, no TSL involved.
  {
    const THREE = makeTHREE();
    const d = describeSceneAttrMrt({ THREE, resolvedW: 1920, resolvedH: 1080 });
    ok('descriptor: screenSized', d.screenSized === true);
    ok('descriptor: sizes pass through', d.resolvedW === 1920 && d.resolvedH === 1080);
    ok('descriptor: attachment 0 color unchanged (HalfFloat)', d.type === 'F16');
    ok('descriptor: no depth (unified pass has none)', d.depth === false);
    ok('descriptor: mrtCount 2', d.mrtCount === 2);
    ok('descriptor: 2 attachment entries', Array.isArray(d.attachments) && d.attachments.length === 2);
    ok('descriptor: attachment[0] named "output" verbatim', d.attachments[0].outputName === 'output');
    ok('descriptor: attachment[1] named "attr" verbatim', d.attachments[1].outputName === 'attr');
    ok('descriptor: attr is nearest', d.attachments[1].filter === 'nearest');
    ok('descriptor: attr is 8-bit unsigned', d.attachments[1].type === 'U8');
    ok('descriptor: attr is NoColorSpace (a data buffer, never sRGB)', d.attachments[1].colorSpace === 'none');
  }

  // buildSceneAttrZeroMrt — the renderer-global safe default.
  {
    const THREE = makeTHREE();
    const node = buildSceneAttrZeroMrt(THREE);
    ok('zero-mrt: built via mrt()', node.__kind === 'mrt');
    ok('zero-mrt: keeps the material\'s own "output" symbol untouched', node.outputs.output.__kind === 'output-symbol');
    ok('zero-mrt: attr is a vec4(0,0,0,0) — exact zero, not a partial value', node.outputs.attr.__kind === 'vec4');
    ok(
      'zero-mrt: all four components are literal 0',
      node.outputs.attr.args.length === 4 && node.outputs.attr.args.every((a) => a === 0)
    );
  }

  // packFloorAttr — the real-writer channel pack.
  {
    const TSL = makeTSL();
    const floorIndex01 = { __kind: 'uniform-floor' };
    const outdoors01 = { __kind: 'gate-result' };
    const presenceBits01 = { __kind: 'uniform-presence' };
    const solidityAlpha = { __kind: 'material-alpha' };
    const packed = packFloorAttr(TSL, { floorIndex01, outdoors01, presenceBits01, solidityAlpha });
    ok('pack: returns a vec4', packed.__kind === 'vec4');
    ok(
      'pack: channel order is R,G,B,A = floor,outdoors,presence,solidity',
      packed.args[0] === floorIndex01 &&
        packed.args[1] === outdoors01 &&
        packed.args[2] === presenceBits01 &&
        packed.args[3] === solidityAlpha
    );

    // No outdoors mask available (e.g. a floor with none authored) — G reads
    // as a real "indoors" 0, not a compiled-out gap. Per the module's own
    // doc: this is real per-pixel DATA, not a feature toggle, so it must
    // never disappear the way a JS-time tier gate would.
    const packedNoOutdoors = packFloorAttr(TSL, {
      floorIndex01,
      outdoors01: null,
      presenceBits01,
      solidityAlpha,
    });
    ok('pack: null outdoors becomes a real float(0), not undefined', packedNoOutdoors.args[1].__kind === 'float');
    ok('pack: that float is exactly 0', packedNoOutdoors.args[1].value === 0);
  }

  // buildRealFloorAttrMrtNode — REGRESSION for the live crash (2026-07-25):
  // the first draft took `solidityAlpha` as a caller-supplied param, fed by a
  // JS closure variable set INSIDE a material's `Fn(() => {...})()` body.
  // `Fn(cb)()` does not run `cb` synchronously — it returns a lazy call node
  // and `cb` only runs later, at actual shader-compile time — so the closure
  // variable was still `null` the instant this function ran, and every
  // whole-image tile failed to load (`vec4(...)` received a literal `null`).
  // The fix reads `TSL.output.a` instead — this test proves that's still
  // true, so the exact bug can't silently come back via a future edit that
  // reintroduces a `solidityAlpha` parameter.
  {
    const THREE = makeTHREE();
    // sceneDoc: null -> getActiveSceneFloors(null) hits its own real,
    // deterministic "no active scene" branch (verified against foundry/
    // active-scene-source.js) — exercises resolveItemFloorAttrUniforms'
    // actual fail-open path for real, no mock needed for that half.
    const node = buildRealFloorAttrMrtNode({
      THREE,
      item: { key: { elevation: 0 } },
      viewedFloorIndex: 0,
      sceneDoc: null,
      logError: () => {},
      envLight: { uOutdoorsRect: null, outdoorsTexNode: null },
    });
    ok('real-writer: built via mrt()', node.__kind === 'mrt');
    const attr = node.outputs.attr;
    ok('real-writer: attr is a vec4', attr.__kind === 'vec4');
    ok(
      'real-writer: solidity (arg 3) IS TSL.output.a — never a param, never null/undefined',
      attr.args[3] === OUTPUT_ALPHA_SWIZZLE
    );
    ok(
      'real-writer: solidity is not the bare output symbol either (it must be the .a swizzle)',
      attr.args[3] !== THREE.TSL.output
    );
  }

  // occludesBackgroundPresenceBit — the tile-occlusion fix's encode side
  // (2026-07-29), POLARITY INVERTED 2026-08-01. `effects/specular` is the one
  // consumer: it reads a Level's background mask ONLY
  // (`mask-authority.js#authoredStatus` resolves `backgroundItemOf` and nothing
  // else), so a Tile AND the Level's own foreground/roof must BOTH read as
  // "occluding", or the exact bug this fixes (background shine glowing through
  // whatever actually covers it) reopens for roofs instead of tiles.
  {
    ok(
      'a Tile sets the occluder bit',
      occludesBackgroundPresenceBit({ kind: 'tile' }) === PRESENCE_BIT_OCCLUDES_BACKGROUND
    );
    ok(
      "the Level's OWN foreground/roof sets it too — it must occlude exactly like a Tile",
      occludesBackgroundPresenceBit({ kind: 'levelForeground' }) === PRESENCE_BIT_OCCLUDES_BACKGROUND
    );
    ok(
      'levelBackground does NOT set it — it is the thing being occluded',
      occludesBackgroundPresenceBit({ kind: 'levelBackground' }) === 0
    );
    ok('a token (or anything else) does not set it', occludesBackgroundPresenceBit({ kind: 'token' }) === 0);
    // ⚠️ THE POLARITY PIN. These three are the whole reason the bit was
    // inverted: every "I could not tell what this is" input must land on
    // NOT-OCCLUDED, so an unknown/missing writer can never switch a consumer
    // off. Under the old polarity each of these meant "not background", which
    // meant "hide the effect" — globally, silently, with every status field
    // reporting healthy.
    ok('a missing item is treated as NOT occluding, never throws', occludesBackgroundPresenceBit(null) === 0);
    ok('a missing kind is treated as NOT occluding', occludesBackgroundPresenceBit({}) === 0);
    ok(
      'an unrecognised kind is treated as NOT occluding',
      occludesBackgroundPresenceBit({ kind: 'somethingNew' }) === 0
    );
  }

  // resolveItemFloorAttrUniforms — the bit must reach the REAL uniform, on
  // EVERY return path, not just the happy one. `sceneDoc: null` hits the
  // function's own real "no active scene" fail-open branch (see the
  // buildRealFloorAttrMrtNode block above for why no mock is needed for
  // that half) — exactly the path this fix touched, since the occluder
  // bit is computed BEFORE the try block rather than only inside it.
  {
    const THREE = makeTHREE();
    const tile = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'tile', key: { elevation: 0 } },
      viewedFloorIndex: 0,
      sceneDoc: null,
      logError: () => {},
    });
    ok(
      'a Tile carries the occluder bit through the fail-open path',
      tile.uPresenceBits01.value === PRESENCE_BIT_OCCLUDES_BACKGROUND / 255
    );

    const fg = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'levelForeground', key: { elevation: 0 } },
      viewedFloorIndex: 0,
      sceneDoc: null,
      logError: () => {},
    });
    ok(
      "the Level's own foreground carries it too",
      fg.uPresenceBits01.value === PRESENCE_BIT_OCCLUDES_BACKGROUND / 255
    );

    const bg = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'levelBackground', key: { elevation: 0 } },
      viewedFloorIndex: 0,
      sceneDoc: null,
      logError: () => {},
    });
    ok('a levelBackground item carries NO occluder bit', bg.uPresenceBits01.value === 0);
  }

  // ══════════════════════════════════════════════════════════════════
  // 🏢 A LEVEL'S FOREGROUND BELONGS TO ITS OWN LEVEL (live bug, 2026-08-02:
  // the author's River Town Bridge map rendered NO sun shadow at all while
  // Shader Lab, on the same data, rendered a near-black one).
  //
  // A Level's foreground sits AT that Level's `elevation.top` — which is
  // precisely `isInForeground`'s own definition of "this Level's foreground"
  // (`elevation >= top`). But `resolveElevationFloorIndex`'s band is
  // half-open `[bottom, top)`, so resolving by elevation ALONE pushed every
  // Level's own foreground into the Level above. `buf:scene.attr`.R then
  // disagreed with the shadow bake about which floor that art was on, and
  // `environmental-light.js`'s floor gate erased the shadow entirely —
  // silently, at any strength.
  //
  // These bands are the real map's (floor 0 = [0,10), foreground at 10),
  // because the bug only fires when a foreground's elevation lands exactly
  // on a boundary — a synthetic scene with roomier bands would pass while
  // the shipped one failed.
  // ══════════════════════════════════════════════════════════════════
  {
    const THREE = makeTHREE();
    const sceneDoc = {
      levels: [
        { id: 'lvl0', name: 'Underground', background: { src: 'a.webp' }, elevation: { bottom: 0, top: 10 } },
        { id: 'lvl1', name: 'Middle', background: { src: 'b.webp' }, elevation: { bottom: 10, top: 20 } },
        { id: 'lvl2', name: 'Roof', background: { src: 'c.webp' }, elevation: { bottom: 20, top: 30 } },
      ],
    };
    const floorOf = (item) =>
      Math.round(
        resolveItemFloorAttrUniforms({ THREE, item, viewedFloorIndex: 0, sceneDoc, logError: () => {} }).uFloorIndex01
          .value * 255
      );

    ok(
      "a Level's BACKGROUND resolves to its own floor (this never broke — the regression guard)",
      floorOf({ kind: 'levelBackground', levelId: 'lvl0', key: { elevation: 0 } }) === 0
    );
    ok(
      "🔒 a Level's FOREGROUND resolves to ITS OWN floor, not the one above — the shipped bug",
      floorOf({ kind: 'levelForeground', levelId: 'lvl0', key: { elevation: 10 } }) === 0
    );
    ok(
      'the same holds one floor up (the bug repeated at every boundary, not just the ground one)',
      floorOf({ kind: 'levelForeground', levelId: 'lvl1', key: { elevation: 20 } }) === 1
    );
    ok(
      "the TOPMOST level's foreground stays on its own floor too",
      floorOf({ kind: 'levelForeground', levelId: 'lvl2', key: { elevation: 30 } }) === 2
    );

    // THE DETECTOR IS NOT VACUOUS: the elevation-only lookup this replaced
    // must genuinely disagree, or the assertions above prove nothing.
    const byElevationAlone = resolveElevationFloorIndex(
      [
        { index: 0, elevationBottom: 0, elevationTop: 10 },
        { index: 1, elevationBottom: 10, elevationTop: 20 },
        { index: 2, elevationBottom: 20, elevationTop: 30 },
      ],
      10
    );
    ok(
      'the elevation-only lookup really does answer "floor 1" for floor 0\'s foreground — so the fix above is load-bearing',
      byElevationAlone?.index === 1
    );

    // A drawable with NO owning Level (a loose tile — `scene-layers.js` gives
    // those `levelId: ''`) must still fall through to the elevation lookup:
    // that IS the right answer for something no Level claims.
    ok(
      'a loose tile (no levelId) still resolves by elevation',
      floorOf({ kind: 'tile', levelId: '', key: { elevation: 25 } }) === 2
    );

    // The overhead presence bit was ALSO wrong for every Level foreground:
    // it was tested against the WRONG floor's `top`, so a Level's own
    // foreground reported "not overhead". Fixing the ownership fixes it.
    const fgBits = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'levelForeground', levelId: 'lvl0', key: { elevation: 10 } },
      viewedFloorIndex: 0,
      sceneDoc,
      logError: () => {},
    }).uPresenceBits01.value;
    ok(
      "a Level's foreground now reports the OVERHEAD bit (it is that Level's roof layer, by isInForeground's own definition)",
      Math.round(fgBits * 255) === PRESENCE_BIT_OCCLUDES_BACKGROUND + PRESENCE_BIT_OVERHEAD
    );
  }

  // THE CROSS-FILE PIN — `effects/specular`'s decode threshold must sit
  // strictly between "occluder bit clear" (0, or the overhead bit alone — its
  // max is PRESENCE_BIT_OVERHEAD) and "occluder bit set" (at minimum
  // PRESENCE_BIT_OCCLUDES_BACKGROUND, whether or not overhead is ALSO set).
  // Nothing forces these two files to agree; only this test does — the same
  // shape as `SPECULAR_DEFAULT_SHIMMER_GAIN` vs
  // `SPECULAR_PARAMS.shimmerGain.default` in `specular.test.mjs`.
  {
    ok(
      'the decode threshold clears every "occluder bit NOT set" byte value (0 or overhead alone)',
      SPECULAR_OCCLUDES_BACKGROUND_THRESHOLD01 > PRESENCE_BIT_OVERHEAD / 255
    );
    ok(
      'the decode threshold sits BELOW every "occluder bit set" byte value, overhead or not',
      SPECULAR_OCCLUDES_BACKGROUND_THRESHOLD01 < PRESENCE_BIT_OCCLUDES_BACKGROUND / 255 &&
        SPECULAR_OCCLUDES_BACKGROUND_THRESHOLD01 < (PRESENCE_BIT_OCCLUDES_BACKGROUND + PRESENCE_BIT_OVERHEAD) / 255
    );

    // ⚠️ THE MARGIN PIN, 2026-07-29. `buildWholeImageMaterial`'s attr write is
    // NOT a hard overwrite — it rides NormalBlending scaled by the material's
    // OWN alpha (`attr_new = attr_old·(1−α) + attr_src·α`), and a real α is not
    // always bit-exact 1.0 even when the art looks fully opaque. The bit's first
    // shipped version (weight 4, threshold 3.5) needed ≥87.5% of its strength to
    // survive and failed on a deficiency too small to see. Keep the margin wide
    // even though the inverted polarity now makes the residual error harmless.
    ok(
      'the decode threshold tolerates the write surviving at only HALF its nominal strength',
      SPECULAR_OCCLUDES_BACKGROUND_THRESHOLD01 <= 0.5 * (PRESENCE_BIT_OCCLUDES_BACKGROUND / 255)
    );
    ok(
      '…while the overhead bit alone cannot cross it even at FULL strength — ' +
        'alpha-scaling only ever shrinks a value, never grows it',
      PRESENCE_BIT_OVERHEAD / 255 < SPECULAR_OCCLUDES_BACKGROUND_THRESHOLD01
    );

    // ⚠️ THE FAIL-OPEN PIN — the assertion the ORIGINAL polarity could not have
    // had, and the reason for the inversion. `buf:scene.attr` clears to
    // (0,0,0,0) (this module's KNOWN GAP #2: "no geometry" and "floor 0, no
    // flags" are the same bytes), so a cleared/never-written buffer MUST decode
    // to "not occluded". A future edit that flips the polarity back fails here.
    ok(
      'an UNWRITTEN attr buffer (b = 0) decodes as NOT occluded — the effect must survive a missing write',
      0 < SPECULAR_OCCLUDES_BACKGROUND_THRESHOLD01
    );
  }
}
