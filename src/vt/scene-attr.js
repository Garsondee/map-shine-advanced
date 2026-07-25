/**
 * `buf:scene.attr` — THE FLOOR-ATTRIBUTE BUFFER (`docs/planning/v3/B0-1-floor-
 * attribute-buffer.md`). A second MRT attachment on `scene.color`, written by
 * the SAME unified geometry pass, carrying per-pixel R=floor index,
 * G=outdoors, B=presence bitflags, A=authored solidity.
 *
 * ============================================================================
 * THE MRT MECHANISM (verified against src/vendor/three/three.webgpu.js)
 * ============================================================================
 *
 * three's WebGPU/TSL MRT is TWO cooperating pieces, not a per-material-only
 * feature:
 *
 *   renderer.setMRT(mrt({ output, attr: someNode }))   — a RENDERER-GLOBAL
 *   material.mrtNode = mrt({ attr: someOtherNode })     — a PER-MATERIAL override,
 *                                                          merged over the global
 *                                                          (material's keys win)
 *
 * `MRTNode.setup()` matches each key (`'output'`, `'attr'`, ...) against the
 * CURRENTLY BOUND render target's `textures[i].name` by exact string equality
 * (`getTextureIndex`, three.webgpu.js:48501-48507) — a key with no matching
 * texture name is silently skipped, no error, no shader output. This is why
 * `graph/three-allocator.js` grew a `desc.attachments[i].outputName` field:
 * an MRT render target's attachments must be named `'output'`/`'attr'`
 * VERBATIM (never the allocator's own `v3:name:i` debug tag) or the whole
 * mechanism silently does nothing.
 *
 * `output` itself (`THREE.TSL.output`) is a symbolic PropertyNode three
 * assigns per-material, per-build, to "whatever this material's own
 * colorNode pipeline already computed" — reusing the same JS reference across
 * every material's shader graph is safe, it resolves correctly per material.
 *
 * ⚠️ MRT MUST BE SCOPED, NEVER LEFT GLOBALLY SET. `renderer.setMRT(...)`
 * affects EVERY subsequent offscreen render() call, not just the one meant to
 * use it — and if a render target with fewer/differently-named attachments
 * is bound while a stale MRT node is active, `MRTNode.setup()` finds no
 * matching texture for ANY key and produces an EMPTY output struct (no
 * fragment output at all) for that other pass. `runGeometryWorldPass` (vt-
 * pan-viewer.js) saves the previous MRT, sets this module's node, and
 * restores it immediately after — the same save/set/restore discipline
 * three's own internals use around every render-target swap while MRT is
 * active (three.webgpu.js:41643-41646 et al).
 *
 * ============================================================================
 * THE SAFE DEFAULT — why most materials need ZERO changes
 * ============================================================================
 *
 * Under NormalBlending, a fragment output of EXACT `vec4(0,0,0,0)` leaves the
 * destination attachment untouched: the attachment's OWN alpha channel (here,
 * 0) is what the blend equation reads as its src-alpha factor —
 * `dst*(1-0) + 0*0 = dst` — regardless of what the material's COLOR
 * attachment's own alpha is. (WebGL2 has no per-attachment blend EQUATION
 * without `OES_draw_buffers_indexed`, but each attachment's blend SOURCE is
 * always its own output — this is not the same limitation, and the "vec4(0)
 * trick" the design doc names relies on exactly this distinction.)
 *
 * So the renderer-global default declared here (`SCENE_ATTR_ZERO_MRT`) —
 * `attr: vec4(0,0,0,0)` — already satisfies B0-1 §2.2's "transparent
 * fragments do not write attributes" rule for EVERY material in the unified
 * pass that doesn't opt in. Confirmed by audit (2026-07-25): every material
 * touching the main world scene + doorScene (`buildWholeImageMaterial`,
 * `buildVegetationMaterial` in its Case-2 overlay form, `buildDoorMaterial`)
 * is `transparent:true`, zero `alphaTest` usage anywhere. Only the REAL
 * writers (§ below) need a `material.mrtNode` override at all.
 *
 * ============================================================================
 * THE REAL WRITERS — floor art and embedded vegetation ARE the floor
 * ============================================================================
 *
 * `buildWholeImageMaterial` (the base map/tile art) and `buildVegetationMaterial`'s
 * Case-1 embedded form (a self-vegetation TILE — grass drawn AS the ground,
 * not a tree drawn ON it) both get a real `packFloorAttr(...)` output:
 *   R = this item's own floor index (`scene/layer-order.js#resolveElevationFloorIndex`,
 *       resolved ONCE at item-build time from the item's static elevation — never
 *       re-derived per frame, since an item's elevation doesn't change live)
 *   G = the outdoors value AT THIS FRAGMENT'S WORLD POSITION
 *       (`buildWorldSpaceOutdoorsGate` — NOT the screen-space `buildOutdoorsGate`
 *       bloom/grade use; a tile's own `uv()` is local sample space, not a
 *       screen-spanning one, so the screen-space gate would silently sample
 *       the wrong world position here)
 *   B = presence bit 0 (overhead/roof — `layer-order.js#isInForeground`,
 *       resolved at the SAME build-time site, same floors list); bit 1
 *       (levelsHidden) is NOT derived — see the KNOWN GAP note below
 *   A = the material's OWN alpha (the same value already driving its colour
 *       blend) — this is what makes the punch-through work for free: where
 *       the base art is opaque (alpha≈1), attr overwrites with real data
 *       (destination almost entirely replaced); where it has an authored
 *       hole (alpha=0), attr's blend leaves whatever drew before it —
 *       typically the floor below — untouched. The SAME alpha-as-blend-
 *       source mechanism the safe zero-default relies on, just with a real
 *       payload instead of zero.
 *
 * ============================================================================
 * KNOWN GAP, STATED HONESTLY (not silently deferred)
 * ============================================================================
 *
 * 1. Bit 1 (levelsHidden / below-viewed) is NOT written. Deriving it needs a
 *    per-item "is this item's floor below the CURRENTLY VIEWED floor"
 *    comparison — a per-FRAME question (the viewed floor changes at runtime)
 *    that this module answers at per-ITEM BUILD time (an item's own floor is
 *    static, but the viewed floor is not). Wiring it needs either a rebuild
 *    on floor-switch or a separate small per-frame uniform; left for a
 *    follow-up rather than guessed at here.
 * 2. The buffer's CLEAR value is the renderer's ordinary (0,0,0,0), not
 *    B0-1 §2.1's specified `(255,0,0,0)` "no geometry" sentinel — three's
 *    MRT has no documented per-attachment clear-value control found in the
 *    vendored build. Consequence: "floor 0, fully indoors, no flags, zero
 *    solidity" and "nothing drawn here at all" both read as raw (0,0,0,0)
 *    today. Consumers that need to distinguish "no geometry" should check
 *    `attr.a > 0` (solidity) rather than trusting R's zero as a sentinel,
 *    until a dedicated clear pass closes this gap.
 *
 * @module vt/scene-attr
 */

import { getActiveSceneFloors } from '../foundry/index.js';
import { resolveElevationFloorIndex, isInForeground } from '../scene/index.js';
import { buildWorldSpaceOutdoorsGate } from '../effects/index.js';

/**
 * The MRT descriptor for `scene.color` — same shape every OTHER
 * `describeSceneColor()`-style descriptor in `vt-pan-viewer.js` uses, plus
 * the second, real attribute attachment. Kept here (not inlined in the
 * viewer) so the exact channel format (RGBA8/Nearest/NoColorSpace, per B0-1
 * §2.1) has one written-down source.
 *
 * @param {object} args
 * @param {*} args.THREE - the injected THREE namespace.
 * @param {number} args.resolvedW @param {number} args.resolvedH - device px.
 * @returns {object} a `ThreeAllocator`-shaped descriptor.
 */
export function describeSceneAttrMrt({ THREE, resolvedW, resolvedH }) {
  return {
    resolvedW,
    resolvedH,
    screenSized: true,
    // Attachment 0 (color) keeps scene.color's EXISTING shape — HalfFloat/
    // linear/NoColorSpace — set at the top level, same as every other
    // describeSceneColor()-style descriptor already in this file.
    type: THREE.HalfFloatType,
    colorSpace: THREE.NoColorSpace,
    filter: 'linear',
    depth: false,
    mrtCount: 2,
    attachments: [
      { outputName: 'output' },
      {
        outputName: 'attr',
        filter: 'nearest',
        type: THREE.UnsignedByteType,
        colorSpace: THREE.NoColorSpace,
      },
    ],
  };
}

/**
 * The renderer-global safe default: every material that does NOT declare its
 * own `mrtNode` gets `attr = vec4(0,0,0,0)` for free — see this module's own
 * "THE SAFE DEFAULT" header section for why that is provably a no-op write
 * under NormalBlending. Built once per viewer instance (it references
 * `TSL.output`, a stable symbolic node — no per-frame allocation needed).
 *
 * @param {*} THREE
 * @returns {*} an `MRTNode`, ready for `renderer.setMRT(...)`.
 */
export function buildSceneAttrZeroMrt(THREE) {
  const { mrt, output, vec4 } = THREE.TSL;
  return mrt({ output, attr: vec4(0, 0, 0, 0) });
}

/**
 * Pack the four real B0-1 channels into one vec4, 0..1 per channel (the
 * shape an RGBA8 `attr` attachment expects — three's own uint8 conversion on
 * write handles the quantization, same as any ordinary 8-bit render target).
 *
 * @param {*} TSL
 * @param {object} args
 * @param {*} args.floorIndex01 - R: this item's floor index / 255 (a uniform,
 *   resolved once at build time — see `resolveItemFloorAttrUniforms` below).
 * @param {*} args.outdoors01 - G: `buildWorldSpaceOutdoorsGate`'s result, or
 *   `null` if no outdoors mask is available (reads as 0 — "indoors" — rather
 *   than compiling out, since G is real per-pixel data here, not a feature
 *   gate; a floor with no authored outdoors mask is legitimately "all indoors").
 * @param {*} args.presenceBits01 - B: presence bitfield / 255 (a uniform).
 * @param {*} args.solidityAlpha - A: the material's own alpha (the SAME node
 *   driving its colour blend — never a second, independently-computed alpha).
 * @returns {*} a vec4 node.
 */
export function packFloorAttr(TSL, { floorIndex01, outdoors01, presenceBits01, solidityAlpha }) {
  const { vec4, float } = TSL;
  const g = outdoors01 ?? float(0);
  return vec4(floorIndex01, g, presenceBits01, solidityAlpha);
}

/**
 * `buf:scene.attr`'s R (floor index) and B-bit-0 (overhead/roof) for ONE
 * item, resolved ONCE at material-BUILD time — an item's own elevation is
 * static for its lifetime, so this is a build-time cost, never a per-frame
 * one. Moved here from `vt-pan-viewer.js` (2026-07-25) purely to stay under
 * the size ratchet's per-file/per-function cap — same logic, new home; see
 * `docs/planning/VT-Pan-Viewer-Extraction.md` trap #6 for why a NESTED
 * helper wouldn't have bought anything (this one is a genuine sibling
 * module, not a function nested inside `startVtPanViewer`, so it counts as
 * its own file from the start).
 *
 * Uses `getActiveSceneFloors` + `scene/layer-order.js#resolveElevationFloor
 * Index`/`isInForeground` — the SAME Level data every other floor-aware
 * reader in the viewer already reads (`readElevationFilteredDarknessRegions`,
 * `bakeWindField`), never a second, private floor-index scheme.
 *
 * Wrapped fail-open, same posture as those readers: a lookup failure (no
 * active scene, no matching floor) falls back to the CURRENTLY VIEWED floor
 * (`viewedFloorIndex`) rather than a fabricated "no geometry" sentinel —
 * geometry genuinely exists here, we just couldn't identify which Level it
 * belongs to, and reporting "255 = nothing drawn" would be a lie.
 *
 * ⚠️ KNOWN GAP, stated honestly (this module's own header, "KNOWN GAP"
 * section): B-bit-1 (levelsHidden / below the VIEWED floor) is NOT derived
 * here — it needs the CURRENTLY VIEWED floor, which changes at runtime,
 * compared against THIS item's OWN floor, resolved once at build time. That
 * comparison belongs to a per-frame reader, not this per-item builder; left
 * for a follow-up.
 *
 * @param {object} args
 * @param {*} args.THREE - the injected THREE namespace.
 * @param {object} args.item - the drawable's own item descriptor (`item.key
 *   .elevation` is read).
 * @param {number} args.viewedFloorIndex - the CURRENTLY viewed floor
 *   (`view.floorIndex` in the viewer) — the fallback when the real lookup
 *   fails, never a fabricated sentinel.
 * @param {object|null} args.sceneDoc - `globalThis.canvas?.scene ?? null`,
 *   read by the CALLER (not here — this module has no Foundry-global access
 *   of its own; `foundry/adapter-only` scopes that pattern to the viewer's
 *   own established `readElevationFilteredDarknessRegions`-style call sites).
 * @param {(msg: string, err: unknown) => void} [args.logError] - defaults to
 *   a no-op; the caller's own logger, so a lookup failure is reported through
 *   the ONE log door (`log/one-door`), never a private console call here.
 * @returns {{uFloorIndex01: object, uPresenceBits01: object}} two TSL
 *   uniforms, already set — never updated again after this call.
 */
export function resolveItemFloorAttrUniforms({ THREE, item, viewedFloorIndex, sceneDoc, logError }) {
  const { uniform, float } = THREE.TSL;
  const uFloorIndex01 = uniform(float(viewedFloorIndex / 255));
  const uPresenceBits01 = uniform(float(0));
  try {
    const floorsResult = getActiveSceneFloors(sceneDoc);
    if (!floorsResult.ok || !floorsResult.floors.length) return { uFloorIndex01, uPresenceBits01 };
    const elevation = item?.key?.elevation ?? 0;
    const resolved = resolveElevationFloorIndex(floorsResult.floors, elevation);
    if (!resolved) return { uFloorIndex01, uPresenceBits01 };
    uFloorIndex01.value = resolved.index / 255;
    const top = resolved.floor.elevationTop ?? Infinity;
    const overhead = isInForeground(elevation, { top });
    uPresenceBits01.value = overhead ? 1 / 255 : 0; // bit 0 only — see the gap note above
  } catch (err) {
    logError?.('buf:scene.attr floor-index lookup (getActiveSceneFloors) failed — using the viewed floor:', err);
  }
  return { uFloorIndex01, uPresenceBits01 };
}

/**
 * The whole "become a real writer" recipe, ONE call — `resolveItemFloor
 * AttrUniforms` + `buildWorldSpaceOutdoorsGate` + `packFloorAttr` + `mrt(...)`.
 * Both real-writer call sites in `vt-pan-viewer.js` (`buildWholeImageMaterial`,
 * `buildVegetationMaterial`'s Case-1 embedded form) were duplicating this
 * exact five-step sequence; factored here so there is ONE place it can drift.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {object} args.item
 * @param {number} args.viewedFloorIndex
 * @param {object|null} args.sceneDoc
 * @param {Function} [args.logError]
 * @param {object} args.envLight - needs `.uOutdoorsRect`/`.outdoorsTexNode`.
 * @param {*} args.solidityAlpha - the material's OWN alpha node (never a
 *   second, independently-computed one — see `packFloorAttr`'s own doc).
 * @returns {*} the built `mrt({...})` node — assign directly to
 *   `material.mrtNode`.
 */
export function buildRealFloorAttrMrtNode({
  THREE,
  item,
  viewedFloorIndex,
  sceneDoc,
  logError,
  envLight,
  solidityAlpha,
}) {
  const { mrt } = THREE.TSL;
  const { uFloorIndex01, uPresenceBits01 } = resolveItemFloorAttrUniforms({
    THREE,
    item,
    viewedFloorIndex,
    sceneDoc,
    logError,
  });
  const outdoors01 = buildWorldSpaceOutdoorsGate(THREE.TSL, {
    uOutdoorsRect: envLight.uOutdoorsRect,
    outdoorsTexNode: envLight.outdoorsTexNode,
  });
  return mrt({
    attr: packFloorAttr(THREE.TSL, {
      floorIndex01: uFloorIndex01,
      outdoors01,
      presenceBits01: uPresenceBits01,
      solidityAlpha,
    }),
  });
}
