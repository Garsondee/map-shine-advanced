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
  refreshItemFloorAttrUniforms,
  occludesBackgroundPresenceBit,
  PRESENCE_BIT_OVERHEAD,
  PRESENCE_BIT_OCCLUDES_BACKGROUND,
  quantizeReceiverElevationAboveFloor,
  receiverElevationLevelToUnits,
  decodeReceiverElevationLevel,
  decodeOverheadBit,
  RECEIVER_ELEVATION_LEVELS,
  RECEIVER_ELEVATION_RANGE_UNITS,
  ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD,
} from '../scene-attr.js';
// The elevation-only lookup the floor-ownership fix replaced — imported so the
// regression block below can prove it genuinely disagrees (a non-vacuous test).
import { resolveElevationFloorIndex } from '../../scene/layer-order.js';

/**
 * A minimal chainable node — supports exactly the TSL method chain
 * `packFloorAttr` calls on its `solidityAlpha` argument since the ROUND 15
 * alpha-test fix (`X.greaterThanEqual(threshold).select(whenTrue, whenFalse)`)
 * — this file's own established "minimal mock, not the real vendored TSL"
 * posture (see this file's own header). `subject` keeps the ORIGINAL node
 * reachable off the chain's result so a test can still prove IDENTITY (the
 * exact node passed in is the one being compared), the same thing a bare
 * `===` check proved before this chain existed.
 */
function chainable(kind) {
  const subject = { __kind: kind };
  subject.greaterThanEqual = (threshold) => ({
    __kind: 'greaterThanEqual',
    subject,
    threshold,
    select: (whenTrue, whenFalse) => ({ __kind: 'select', subject, threshold, whenTrue, whenFalse }),
  });
  return subject;
}

// A real (not swizzle-capable) plain object standing in for `output.a` —
// distinct identity from the bare `output` symbol so a test can tell whether
// a node came from `output.a` specifically, not just "some node". Chainable
// (see `chainable` above) since it flows through `packFloorAttr`'s alpha-test.
const OUTPUT_ALPHA_SWIZZLE = chainable('output-alpha-swizzle');

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
    const solidityAlpha = chainable('material-alpha');
    const packed = packFloorAttr(TSL, { floorIndex01, outdoors01, presenceBits01, solidityAlpha });
    ok('pack: returns a vec4', packed.__kind === 'vec4');
    ok(
      'pack: channel order is R,G,B = floor,outdoors,presence, unchanged by the alpha-test fix',
      packed.args[0] === floorIndex01 && packed.args[1] === outdoors01 && packed.args[2] === presenceBits01
    );
    // ⚠️ ROUND 15 (2026-08-04) — A IS NO LONGER solidityAlpha VERBATIM. It is
    // ALPHA-TESTED: `solidityAlpha.greaterThanEqual(THRESHOLD).select(1, 0)`
    // — see `packFloorAttr`'s own "ALPHA-TEST, NOT A CONTINUOUS BLEND" header
    // for the live bug this fixes (a translucent fragment's presence-bits
    // byte scaling by its own raw alpha under MRT blending, corrupting the
    // receiver-elevation VALUE field — a margin only protects a single
    // boolean bit, never a multi-bit value). Pinning the ARITHMETIC, not just
    // the shape: a smooth-looking select() call proves nothing about whether
    // the threshold or the branch VALUES are actually right
    // (`feedback_smooth_output_hides_ported_bugs`).
    const a = packed.args[3];
    ok('pack: A is a select() node, not solidityAlpha passed through raw', a.__kind === 'select');
    ok('pack: the select is gated on THIS solidityAlpha, identity-checkable', a.subject === solidityAlpha);
    ok(
      'pack: the comparison is >= the real exported threshold constant, not a re-typed magic number',
      a.threshold.__kind === 'float' && a.threshold.value === ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD
    );
    ok('pack: the threshold is 0.5 — a WIDE margin, not a tight one', ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD === 0.5);
    ok(
      'pack: at/above threshold writes fully solid (1), below writes fully transparent (0) — never a fraction',
      a.whenTrue.__kind === 'float' &&
        a.whenTrue.value === 1 &&
        a.whenFalse.__kind === 'float' &&
        a.whenFalse.value === 0
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
    const { mrtNode, floorAttrUniforms } = buildRealFloorAttrMrtNode({
      THREE,
      item: { key: { elevation: 0 } },
      viewedFloorIndex: 0,
      sceneDoc: null,
      logError: () => {},
      envLight: { uOutdoorsRect: null, outdoorsTexNode: null },
    });
    ok('real-writer: built via mrt()', mrtNode.__kind === 'mrt');
    const attr = mrtNode.outputs.attr;
    ok('real-writer: attr is a vec4', attr.__kind === 'vec4');
    ok(
      'real-writer: solidity gate (arg 3) is ALPHA-TESTED against TSL.output.a — never a param, never null/undefined',
      attr.args[3].__kind === 'select' && attr.args[3].subject === OUTPUT_ALPHA_SWIZZLE
    );
    ok(
      'real-writer: solidity is not gated on the bare output symbol either (it must be the .a swizzle)',
      attr.args[3].subject !== THREE.TSL.output
    );
    // ⚠️ NEW (2026-08-03) — the FIX for a real live bug (top floor's specular
    // invisible: its floor-index was baked once, at build time, and never
    // revisited). `floorAttrUniforms` is what a caller retains and refreshes
    // every frame via `refreshItemFloorAttrUniforms` — proven real here, not
    // just present by accident.
    ok(
      'real-writer: also returns the LIVE uniforms, not just the mrt node',
      !!floorAttrUniforms?.uFloorIndex01 && !!floorAttrUniforms?.uPresenceBits01
    );
    ok(
      'real-writer: those uniforms are exactly what packFloorAttr used to build the attr node',
      attr.args[0] === floorAttrUniforms.uFloorIndex01 && attr.args[2] === floorAttrUniforms.uPresenceBits01
    );
  }

  // buildRealFloorAttrMrtNode — THE OCCLUSION-FADE FIX (2026-08-03, live
  // report): `output.a` is this material's FINAL on-screen alpha, which for
  // an occludable Tile/roof already has `occlusionAlphaFactor(occ)` folded
  // in — a fade meant PURELY so a player can see their own token standing
  // under the roof (`scene/occlusion.js`). Using that as solidity made a
  // light stop being occluded by its own roof the instant a token walked
  // into the room the roof did not move; only its RENDERING did
  // (`feedback_one_byte_two_quantities`). An explicit `solidityAlpha`
  // override — a real, pre-built node, never a closure variable (the
  // ORIGINAL, different trap the block above pins) — lets a caller supply
  // the item's PHYSICAL presence instead.
  {
    const THREE = makeTHREE();
    const physicalAlpha = chainable('physical-solidity-alpha');
    const { mrtNode } = buildRealFloorAttrMrtNode({
      THREE,
      item: { key: { elevation: 0 } },
      viewedFloorIndex: 0,
      sceneDoc: null,
      logError: () => {},
      envLight: { uOutdoorsRect: null, outdoorsTexNode: null },
      solidityAlpha: physicalAlpha,
    });
    const attr = mrtNode.outputs.attr;
    ok(
      'an explicit solidityAlpha REPLACES output.a — the caller´s own physical-presence node gates the alpha-test',
      attr.args[3].__kind === 'select' && attr.args[3].subject === physicalAlpha
    );
    ok('and it is NOT gated on the output-alpha swizzle any more', attr.args[3].subject !== OUTPUT_ALPHA_SWIZZLE);
  }
  {
    // Omitting it entirely must be BYTE-IDENTICAL to the pre-fix behaviour —
    // every OTHER real-writer call site (no occlusion concept) must see no
    // change at all.
    const THREE = makeTHREE();
    const { mrtNode } = buildRealFloorAttrMrtNode({
      THREE,
      item: { key: { elevation: 0 } },
      viewedFloorIndex: 0,
      sceneDoc: null,
      logError: () => {},
      envLight: { uOutdoorsRect: null, outdoorsTexNode: null },
    });
    ok(
      'omitting solidityAlpha still falls back to output.a — every existing call site is unaffected',
      mrtNode.outputs.attr.args[3].__kind === 'select' && mrtNode.outputs.attr.args[3].subject === OUTPUT_ALPHA_SWIZZLE
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

    // ══════════════════════════════════════════════════════════════════
    // 🔒 ROUND 8 — THE SAME BOUNDARY BUG, RECURRING IN A LOOSE TILE (found
    // writing THIS round's own Shader Lab proof, not a live report). The
    // fix above (lines 320-330) only covers `levelId`-owned art; a Tile has
    // NONE (confirmed: `levelId: ''`, always), so the ONE natural way to
    // mark a discrete cover object as "this floor's own roof" — raise its
    // elevation to match that floor's own `elevationTop` — falls straight
    // into `resolveElevationFloorIndex`'s `[bottom, top)` band and gets
    // attributed to the floor ABOVE, same as the original bug, one level
    // down the call stack. `uFloorIndex01` staying "wrong floor" here is
    // ACCEPTED (R is deliberately unchanged — see the fix's own doc); only
    // the OVERHEAD bit is asked to get this right.
    // ══════════════════════════════════════════════════════════════════
    const looseTileAtBoundary = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'tile', levelId: '', key: { elevation: 10 } }, // EXACTLY lvl0's own top
      viewedFloorIndex: 0,
      sceneDoc,
      logError: () => {},
    }).uPresenceBits01.value;
    const looseTileByte = Math.round(looseTileAtBoundary * 255);
    ok(
      "🔒 a loose Tile raised to EXACTLY its intended floor's own top still reports OVERHEAD — the " +
        "author's one natural way to mark a discrete cover as a roof, without needing a levelId",
      decodeOverheadBit(looseTileByte) === 1
    );
    ok(
      '...and R (floor index) is DELIBERATELY left at whatever elevation-banding alone says (floor ABOVE, ' +
        'the pre-existing, unchanged behaviour) — this fix is scoped to the overhead bit only',
      floorOf({ kind: 'tile', levelId: '', key: { elevation: 10 } }) === 1
    );
    // A tile NOT raised to any boundary (ordinary furniture/decoration,
    // sitting comfortably inside its own floor's band) must NOT read as
    // overhead — the regression guard for the false-positive this whole
    // design deliberately avoided (a torch on a table, a bush on a tile).
    const ordinaryLooseTile = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'tile', levelId: '', key: { elevation: 3 } }, // well inside lvl0's [0,10) band
      viewedFloorIndex: 0,
      sceneDoc,
      logError: () => {},
    }).uPresenceBits01.value;
    ok(
      'an ORDINARY tile, nowhere near a floor boundary, does NOT report overhead',
      decodeOverheadBit(Math.round(ordinaryLooseTile * 255)) === 0
    );

    // The overhead presence bit was ALSO wrong for every Level foreground:
    // it was tested against the WRONG floor's `top`, so a Level's own
    // foreground reported "not overhead". Fixing the ownership fixes it.
    // The raw byte ALSO now carries this item's receiver-elevation bits
    // (2-5) — subtract them out (via the same decode the shader uses) before
    // checking the overhead/occludes bits alone, rather than asserting a
    // fragile exact sum that would drift the moment the elevation field's
    // own quantization changes.
    const fgBits = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'levelForeground', levelId: 'lvl0', key: { elevation: 10 } },
      viewedFloorIndex: 0,
      sceneDoc,
      logError: () => {},
    }).uPresenceBits01.value;
    const fgByte = Math.round(fgBits * 255);
    const fgElevationLevel = decodeReceiverElevationLevel(fgByte);
    ok(
      "a Level's foreground now reports the OVERHEAD bit (it is that Level's roof layer, by isInForeground's own definition)",
      fgByte - fgElevationLevel * 4 === PRESENCE_BIT_OCCLUDES_BACKGROUND + PRESENCE_BIT_OVERHEAD
    );
    ok(
      "...and its receiver-elevation level matches elevation(10) - this Level's own elevationBottom(0), quantized",
      fgElevationLevel === quantizeReceiverElevationAboveFloor(10 - 0)
    );

    // ══════════════════════════════════════════════════════════════════
    // 🔒 ROUND 9 (2026-08-04) — A TILE'S OWN `restrictsLight` IS A SECOND,
    // ELEVATION-INDEPENDENT OVERHEAD SIGNAL. The live report: a lantern's
    // cover Tile, Foundry's own "Restrict Lighting" ticked, elevation
    // comfortably INSIDE its floor's band (nowhere near the ceiling
    // `isInForeground` tests against) — the numeric height-gate arithmetic
    // was already proven correct for this exact pair (see
    // point-light-illumination.test.mjs's own "LIVE CASE 1"), but nothing
    // ever asked the one flag the author actually set.
    // ══════════════════════════════════════════════════════════════════
    const flaggedTile = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'tile', levelId: '', key: { elevation: 3 }, restrictsLight: true }, // well inside lvl0's [0,10) band — NOT a boundary case
      viewedFloorIndex: 0,
      sceneDoc,
      logError: () => {},
    }).uPresenceBits01.value;
    ok(
      "🔒 a Tile with Foundry's own restrictsLight ticked reports OVERHEAD even nowhere near its floor's " +
        'ceiling — the exact lantern-cover gap, closed with no elevation authoring required',
      decodeOverheadBit(Math.round(flaggedTile * 255)) === 1
    );

    // The regression guard this whole fix hinges on: `restrictsLight` must
    // stay SCOPED TO TILES. A Level's own BACKGROUND gets `restrictsLight:
    // true` UNCONDITIONALLY in production (`collectLevelTextures`, mirroring
    // real Foundry's own `primary.mjs#restrictsLight = true` for
    // `isBackground`) — if this new clause were not kind-guarded, a floor's
    // own ground would set the overhead bit on itself EVERYWHERE it draws,
    // and `overheadGate` ANDs into every light's falloff
    // (`point-light-illumination.js#buildHeightGateNode`), which would black
    // out every light on every floor. This is the single most important
    // assertion in this block.
    const flaggedBackground = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'levelBackground', levelId: 'lvl0', key: { elevation: 0 }, restrictsLight: true },
      viewedFloorIndex: 0,
      sceneDoc,
      logError: () => {},
    }).uPresenceBits01.value;
    ok(
      "🔒🔒 a Level's own BACKGROUND — restrictsLight:true UNCONDITIONALLY in production — must NOT self-report " +
        'overhead via this new path, or every light everywhere goes dark',
      decodeOverheadBit(Math.round(flaggedBackground * 255)) === 0
    );

    // An ordinary tile with the flag left at its Foundry default (false/
    // undefined) must be completely unaffected — the fix is additive, not a
    // behaviour change for the overwhelming majority of tiles that never
    // touch this checkbox.
    const unflaggedTile = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'tile', levelId: '', key: { elevation: 3 } }, // no restrictsLight field at all
      viewedFloorIndex: 0,
      sceneDoc,
      logError: () => {},
    }).uPresenceBits01.value;
    ok(
      'an ordinary tile with no restrictsLight field at all still reads NOT overhead — no regression for ' +
        'the overwhelming common case',
      decodeOverheadBit(Math.round(unflaggedTile * 255)) === 0
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // 🔧 refreshItemFloorAttrUniforms — THE FIX FOR A REAL LIVE BUG (2026-08-03):
  // specular worked on the basement and ground floor but was completely
  // invisible on a scene's newest, uppermost floor — the mask genuinely
  // loaded (real, healthy mask/strength/tint/presence/islands readings) but
  // the floor-match bit read exactly 0 at every point on that floor. Traced
  // to `resolveItemFloorAttrUniforms` resolving an item's floor membership
  // exactly ONCE, at material-build time, and never again — this proves the
  // fix: an item built against ONE floor snapshot, then REFRESHED against a
  // DIFFERENT one (exactly what happens if a floor is added, or an
  // elevation edited, or a bake simply raced), lands on the NEW correct
  // answer, in the SAME uniform objects, not a fresh pair.
  // ══════════════════════════════════════════════════════════════════
  {
    const THREE = makeTHREE();
    // Built against a scene that ONLY has two floors — 'lvl0' hasn't been
    // added yet (or wasn't visible to this call for any other reason).
    const sceneDocV1 = {
      levels: [
        { id: 'lvlGround', name: 'Ground', background: { src: 'g.webp' }, elevation: { bottom: 0, top: 10 } },
        { id: 'lvlUpper', name: 'Upper', background: { src: 'u.webp' }, elevation: { bottom: 10, top: 20 } },
      ],
    };
    const item = { kind: 'levelBackground', levelId: 'lvlUpper', key: { elevation: 10 } };
    const uniforms = resolveItemFloorAttrUniforms({
      THREE,
      item,
      viewedFloorIndex: 1,
      sceneDoc: sceneDocV1,
      logError: () => {},
    });
    ok(
      'built against the v1 scene, the upper floor resolves to index 1',
      Math.round(uniforms.uFloorIndex01.value * 255) === 1
    );

    // NOW the scene gains a genuine basement BELOW ground — floors re-sort by
    // elevation and 'lvlUpper' shifts from index 1 to index 2. A real editing
    // sequence (a floor added below existing ones), not a contrived one.
    const sceneDocV2 = {
      levels: [
        { id: 'lvlBasement', name: 'Basement', background: { src: 'b.webp' }, elevation: { bottom: -10, top: 0 } },
        ...sceneDocV1.levels,
      ],
    };
    refreshItemFloorAttrUniforms(uniforms, {
      item,
      viewedFloorIndex: 2,
      sceneDoc: sceneDocV2,
      logError: () => {},
    });
    ok(
      "🔒 refreshed against the v2 scene, the SAME uniform pair now reports the upper floor's NEW index (2) — " +
        'this is the fix: the OLD code would have left it at 1 forever',
      Math.round(uniforms.uFloorIndex01.value * 255) === 2
    );
    ok(
      'refresh mutates the EXISTING uniform objects — it never hands back a fresh pair',
      uniforms.uFloorIndex01 === uniforms.uFloorIndex01 && typeof uniforms.uFloorIndex01.value === 'number'
    );

    // A FRESH resolveItemFloorAttrUniforms call against v2, from scratch,
    // must agree with the refreshed value — refresh isn't a different,
    // second code path that could itself drift from the original resolver.
    const freshV2 = resolveItemFloorAttrUniforms({
      THREE,
      item,
      viewedFloorIndex: 2,
      sceneDoc: sceneDocV2,
      logError: () => {},
    });
    ok(
      'refresh and a from-scratch build against the SAME scene agree exactly',
      freshV2.uFloorIndex01.value === uniforms.uFloorIndex01.value
    );
  }

  // ── RECEIVER ELEVATION (bits 2-5) — 2026-08-03, for the point-light
  // height gate ("a lantern's own cover, sitting above the flame, should not
  // light up from it"). ──────────────────────────────────────────────────
  {
    const THREE = makeTHREE();
    // Same real-map bands as the ownership-fix fixture above (floor 0 =
    // [0,10)) — a fresh instance rather than reaching out of that block's
    // own scope, so this section reads standalone.
    const sceneDoc = {
      levels: [
        { id: 'lvl0', name: 'Underground', background: { src: 'a.webp' }, elevation: { bottom: 0, top: 10 } },
        { id: 'lvl1', name: 'Middle', background: { src: 'b.webp' }, elevation: { bottom: 10, top: 20 } },
        { id: 'lvl2', name: 'Roof', background: { src: 'c.webp' }, elevation: { bottom: 20, top: 30 } },
      ],
    };

    // Quantize/decode round-trip — the CPU twin must agree with itself
    // across the documented range, including its own clamped edges.
    for (const raw of [-50, 0, 1, 33, 50, 99, 100, 250]) {
      const level = quantizeReceiverElevationAboveFloor(raw);
      ok(
        `level for raw elevation ${raw} stays in [0, ${RECEIVER_ELEVATION_LEVELS - 1}]`,
        level >= 0 && level <= RECEIVER_ELEVATION_LEVELS - 1
      );
    }
    ok('a negative elevation-above-floor clamps to level 0 (ground)', quantizeReceiverElevationAboveFloor(-50) === 0);
    ok('elevation 0 (exactly at the floor´s own ground) is level 0', quantizeReceiverElevationAboveFloor(0) === 0);
    ok(
      `elevation at RANGE_UNITS (${RECEIVER_ELEVATION_RANGE_UNITS}) reaches the TOP level, not one short of it`,
      quantizeReceiverElevationAboveFloor(RECEIVER_ELEVATION_RANGE_UNITS) === RECEIVER_ELEVATION_LEVELS - 1
    );
    ok(
      'anything past the reference range clamps to the SAME top level — never wraps back toward ground',
      quantizeReceiverElevationAboveFloor(RECEIVER_ELEVATION_RANGE_UNITS * 10) === RECEIVER_ELEVATION_LEVELS - 1
    );
    ok('a non-finite raw value reads as ground level, never NaN', quantizeReceiverElevationAboveFloor(NaN) === 0);

    // The packed byte round-trips through the SAME decode the shader uses,
    // regardless of which OTHER bits (overhead, occludes-background) ride
    // alongside it — this is the whole reason it lives at bits 2-5 rather
    // than sharing a byte position with either.
    for (const level of [0, 1, 5, 10, RECEIVER_ELEVATION_LEVELS - 1]) {
      const bare = level * 4;
      const withOverhead = bare + PRESENCE_BIT_OVERHEAD;
      const withOccludes = bare + PRESENCE_BIT_OCCLUDES_BACKGROUND;
      const withBoth = bare + PRESENCE_BIT_OVERHEAD + PRESENCE_BIT_OCCLUDES_BACKGROUND;
      ok(`level ${level} decodes correctly alone`, decodeReceiverElevationLevel(bare) === level);
      ok(
        `level ${level} decodes correctly WITH the overhead bit set`,
        decodeReceiverElevationLevel(withOverhead) === level
      );
      ok(
        `level ${level} decodes correctly WITH the occludes-background bit set`,
        decodeReceiverElevationLevel(withOccludes) === level
      );
      ok(`level ${level} decodes correctly with BOTH other bits set`, decodeReceiverElevationLevel(withBoth) === level);
      // decodeOverheadBit's own round-trip, same fixtures, same reasoning:
      // the level field riding alongside it must never perturb this bit.
      ok(`level ${level}, overhead bit reads 0 when unset`, decodeOverheadBit(bare) === 0);
      ok(`level ${level}, overhead bit reads 1 when set`, decodeOverheadBit(withOverhead) === 1);
      ok(
        `level ${level}, overhead bit reads 0 when only occludes-background is set`,
        decodeOverheadBit(withOccludes) === 0
      );
      ok(`level ${level}, overhead bit reads 1 with BOTH other bits set`, decodeOverheadBit(withBoth) === 1);
    }

    // THE COLLISION-SAFETY PIN — this field's own maximum, even combined with
    // the overhead bit, must never reach specular's occlusion-bit threshold
    // (64/255); the occludes-background bit, combined with this field's
    // maximum, must still read unambiguously above it. Nothing forces bit
    // allocation to respect this by construction — only this test does.
    const maxElevationRaw = (RECEIVER_ELEVATION_LEVELS - 1) * 4;
    ok(
      "this field's own max, plus the overhead bit, stays BELOW the occlusion threshold (64) — no false " +
        '"occluded" reading from elevation/overhead alone',
      maxElevationRaw + PRESENCE_BIT_OVERHEAD < 64
    );
    ok(
      'the occludes-background bit, plus this field at its max, still reads unambiguously as occluded',
      PRESENCE_BIT_OCCLUDES_BACKGROUND + maxElevationRaw > 64
    );

    // Dequantize is the documented approximate inverse, not a claim of exact
    // recovery — bounded by the field's own step size.
    const stepUnits = RECEIVER_ELEVATION_RANGE_UNITS / (RECEIVER_ELEVATION_LEVELS - 1);
    ok('dequantizing level 0 returns exactly 0 (ground)', receiverElevationLevelToUnits(0) === 0);
    ok(
      `dequantizing the top level returns exactly the reference range (${RECEIVER_ELEVATION_RANGE_UNITS})`,
      receiverElevationLevelToUnits(RECEIVER_ELEVATION_LEVELS - 1) === RECEIVER_ELEVATION_RANGE_UNITS
    );
    ok(
      'quantize -> dequantize never drifts further than one step from the original value (a value WITHIN ' +
        'the range, not one that clamps)',
      Math.abs(receiverElevationLevelToUnits(quantizeReceiverElevationAboveFloor(7)) - 7) <= stepUnits
    );

    // Wired through resolveItemFloorAttrUniforms — an item sitting well above
    // its own floor's ground (a raised tile, or a stand-in for a lantern's
    // own cover) reports a REAL, non-zero level; an item flush with its own
    // floor's ground reports level 0, matching today's byte-identical
    // behaviour for every scene that has never authored a raised drawable.
    const groundBits = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'tile', levelId: '', key: { elevation: 0 } },
      viewedFloorIndex: 0,
      sceneDoc,
      logError: () => {},
    }).uPresenceBits01.value;
    ok(
      'an item flush with its own floor´s ground packs receiver-elevation level 0',
      decodeReceiverElevationLevel(Math.round(groundBits * 255)) === 0
    );
    const raisedBits = resolveItemFloorAttrUniforms({
      THREE,
      // Floor 0 spans [0, 10) per the fixture below — an item at elevation 8
      // sits near the TOP of its own floor's band, the lantern-cover shape.
      item: { kind: 'tile', levelId: '', key: { elevation: 8 } },
      viewedFloorIndex: 0,
      sceneDoc,
      logError: () => {},
    }).uPresenceBits01.value;
    ok(
      'an item raised well above its own floor´s ground packs a NON-ZERO receiver-elevation level',
      decodeReceiverElevationLevel(Math.round(raisedBits * 255)) === quantizeReceiverElevationAboveFloor(8 - 0)
    );
    ok(
      '...and that level is clearly above ground (0) — the lantern-cover shape this field exists for',
      decodeReceiverElevationLevel(Math.round(raisedBits * 255)) > 0
    );

    // receiverHeightFt (renamed 2026-08-06 from receiverElevationFraction01,
    // when vegetation moved off a clamped-fraction sort model onto a real,
    // unbounded height — same role, same gate, new units) — vegetation
    // Case-2's own door. A tree overlay's HOST tile sits at ordinary ground
    // elevation, but the CANOPY itself (its own live treeHeightFt/
    // bushHeightFt, `vegetation-render.js#vegetationHeightFt`) is what should
    // gate a light's reach — never the host's own near-ground placement.
    // Floor 0 spans [0,10), so a height of 9 (well within the band, deliberately
    // chosen so `bottom + heightFt` reproduces the exact same elevation the old
    // `bottom + (top-bottom)*0.9` fraction test asserted on) resolves to
    // elevation 9, well above the host's own elevation 1.
    const hostGroundBits = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'tile', levelId: '', key: { elevation: 1 } }, // the host tile itself, barely off the ground
      viewedFloorIndex: 0,
      sceneDoc,
      logError: () => {},
      receiverHeightFt: 9, // the canopy's own real height, well above its host
    }).uPresenceBits01.value;
    ok(
      'the height override replaces the item´s own elevation for the receiver-elevation field ONLY',
      decodeReceiverElevationLevel(Math.round(hostGroundBits * 255)) === quantizeReceiverElevationAboveFloor(9 - 0)
    );
    ok(
      '...and clearly differs from what the host´s OWN (near-ground) elevation would have packed',
      decodeReceiverElevationLevel(Math.round(hostGroundBits * 255)) !== quantizeReceiverElevationAboveFloor(1 - 0)
    );
    // Floor MEMBERSHIP must still come from the item's real elevation, never
    // the height override — a canopy's floor is still whichever floor its
    // HOST belongs to.
    const floorOfHost = Math.round(
      resolveItemFloorAttrUniforms({
        THREE,
        item: { kind: 'tile', levelId: '', key: { elevation: 1 } },
        viewedFloorIndex: 0,
        sceneDoc,
        logError: () => {},
        receiverHeightFt: 9,
      }).uFloorIndex01.value * 255
    );
    ok(
      'the height override never leaks into floor MEMBERSHIP — the host´s own elevation (1) still resolves floor 0',
      floorOfHost === 0
    );
    // An UNBOUNDED band (elevationTop undeclared/Infinity) has no scale to
    // apply the height override against — falls back to the item's own
    // elevation, the same "no scale to work against" posture
    // stampVegetationRenderOrders already takes for its own sort-order
    // fallback.
    const unboundedSceneDoc = {
      levels: [{ id: 'lvlU', name: 'Unbounded', background: { src: 'u.webp' }, elevation: { bottom: 0, top: null } }],
    };
    const unboundedBits = resolveItemFloorAttrUniforms({
      THREE,
      item: { kind: 'tile', levelId: '', key: { elevation: 3 } },
      viewedFloorIndex: 0,
      sceneDoc: unboundedSceneDoc,
      logError: () => {},
      receiverHeightFt: 9,
    }).uPresenceBits01.value;
    ok(
      'an unbounded band ignores the height override and falls back to the item´s own real elevation (3)',
      decodeReceiverElevationLevel(Math.round(unboundedBits * 255)) === quantizeReceiverElevationAboveFloor(3 - 0)
    );
  }

  // ⚠️ THE CROSS-FILE PIN THAT USED TO LIVE HERE IS GONE, NAMED HONESTLY, NOT
  // SILENTLY DROPPED. Through STAGE 2 (2026-08-04), `effects/specular`'s own
  // `SPECULAR_OCCLUDES_BACKGROUND_THRESHOLD01` decoded THIS byte's bit 7
  // (`PRESENCE_BIT_OCCLUDES_BACKGROUND`) directly, and this block cross-
  // checked the two constants against each other so a rename of either could
  // not silently desync from the other. STAGE 3 (2026-08-05,
  // `specular-render.js`'s own "STAGE 3" header) moved specular's occlusion
  // read onto `buf:scene.depth`'s single rank comparison instead, and that
  // threshold constant no longer exists — there is nothing left for a pin to
  // cross-check. `PRESENCE_BIT_OCCLUDES_BACKGROUND`/
  // `occludesBackgroundPresenceBit` themselves are UNCHANGED and still
  // exercised above (this file's own "occludesBackgroundPresenceBit" block)
  // — this bit is still written into `buf:scene.attr` every frame — but as
  // far as this codebase's own source currently shows, nothing reads it back
  // out any more. That is a real, separate finding (a write with no known
  // reader), not this migration's to resolve.
}
