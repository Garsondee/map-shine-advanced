/**
 * THE VISION MASK RASTERISER — slice 2b of "MSA owns vision/fog" (Testament
 * Pillar 11, `docs/planning/Vision-Fog-Ownership.md`).
 *
 * Draws every active vision source's Foundry-computed polygons into ONE
 * screen-space mask that the composite then reads. The RULE it serves is
 * `./vision-mask.js#decideRevealed` — that function is the CPU twin and the
 * single definition; this file must never drift from it (Law 7:
 * player-facing information gating is sacred).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE CHANNELS, and why the rule is split across them rather than
 * evaluated here
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   R = inside LOS                (this source's wall-swept polygon)
 *   G = inside basicSight radius  (darkvision — illumination-INDEPENDENT)
 *   B = inside the lightPerception polygon
 *
 * The composite finishes the rule, because the last clause needs MSA's own
 * per-pixel illumination and that lives in a DIFFERENT buffer
 * (`buf:scene.illum`) which this pass has no business sampling mid-rasterise:
 *
 *   revealed = R AND (G OR (B AND illum >= threshold))
 *
 * MAX blending unions the sources: two tokens each contribute their own
 * polygons and a pixel either token can see reads 1 in the right channel.
 * MAX (not additive) because these are BOOLEANS — additive would saturate to
 * the same answer for R/G/B here, but would silently start lying the moment
 * anyone introduced a partial value, and this is not a buffer to be subtle in.
 *
 * ⚠️ A BLINDED SOURCE IS DROPPED ENTIRELY rather than drawn and masked later.
 * Foundry does the same (`refreshVisibility`'s `!blinded` guard), and it is
 * the fail-safe direction: a bug that drops a source shows a player LESS than
 * they should see, a bug that draws one shows them MORE.
 *
 * ⚠️ COORDINATE CONVENTION IS COPIED FROM THE WORKING LIGHT PATH, NOT DERIVED
 * — `point-light-pool.js` does `mesh.position.set(x, y, 0)` with Foundry's
 * world coordinates straight in, no Y flip. This file does the same and
 * differs in exactly one way: it calls `triangulateLightFan` with
 * **`radius = 1`**, which makes the "normalisation" an identity and yields
 * plain local-space offsets, so no compensating `scale` is needed. Y-flip has
 * bitten this project five times (`feedback_y_flip_recurring_risk`); copying a
 * proven call site is the cheapest way not to make it six.
 *
 * @module effects/vision/vision-mask-render
 */

import { triangulateLightFan } from '../lighting/point-light-illumination.js';

/**
 * `triangulateLightFan` divides by this to reach the light shader's
 * unit-circle space. Passing 1 makes that an identity, which is exactly what
 * a mask wants: local-space offsets in real world units, so the mesh needs
 * only a position and no scale.
 */
const NO_RADIUS_NORMALISATION = 1;

/**
 * Build the material that stamps the LOS polygon (R) plus the darkvision disc
 * (G) in ONE draw.
 *
 * G is computed per-fragment from `positionLocal` rather than by drawing a
 * second circle mesh: the LOS fan already covers every pixel darkvision could
 * reach (darkvision cannot see through walls either), so intersecting it with
 * a radius test in the shader is both exact and one fewer draw call.
 *
 * @param {*} THREE @returns {{material: *, uSightRadius: *}}
 */
export function buildVisionLosMaterial({ THREE }) {
  const { uniform, float, vec4, positionLocal, select, length } = THREE.TSL;
  const uSightRadius = uniform(float(0));

  const distFromOrigin = length(positionLocal.xy);
  // `> 0` guard first: a sightRadius of 0 means NO darkvision, and must not
  // be read as "everything within 0 units", which a bare <= would make true
  // exactly at the origin pixel. Cheap, and it keeps the CPU twin's own
  // `sr > 0 && d <= sr` shape visible here.
  const hasSight = uSightRadius.greaterThan(float(0));
  const withinSight = distFromOrigin.lessThanEqual(uSightRadius);
  const sightChannel = select(hasSight.and(withinSight), float(1), float(0));

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(float(1), sightChannel, float(0), float(1));
  return { material, uSightRadius };
}

/**
 * Build the material that stamps the light-perception polygon (B).
 *
 * No radius uniform: Foundry has ALREADY clipped `source.light` to the
 * light-perception range AND to walls, so the polygon itself is the answer.
 * Re-testing the radius here would be re-deriving something we consumed —
 * the exact discipline this build is built on.
 *
 * @param {*} THREE @returns {{material: *}}
 */
export function buildVisionLightMaterial({ THREE }) {
  const { float, vec4 } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(float(0), float(0), float(1), float(1));
  return { material };
}

/**
 * Build the FULLSCREEN GATE — one MULTIPLY quad that finishes the reveal rule
 * over the whole composited frame.
 *
 * ⚠️ WHY THIS IS A SEPARATE FULLSCREEN PASS AND NOT A TERM IN THE COMPOSITE
 * MATERIAL — found live, not reasoned about. The first cut put the gate inside
 * `environmental-light.js`'s composite. A verification run showed the map
 * correctly blacked out where unrevealed AND candle flames, fire particles and
 * light coronas drawing straight through the fog: they are ADDITIVE draws that
 * land on `scene.lit` AFTER the composite quad and therefore never pass
 * through it. Gating "the composite" gates the map and nothing else. Only a
 * pass that runs after every contributor can gate every contributor.
 *
 * ⚠️ AND IT MUST RUN BEFORE BLOOM. Bloom reads `scene.lit` and smears bright
 * pixels outward; gating afterwards would let a hidden candle bloom across the
 * fog and betray its position through a wall. Gate first, then bloom only ever
 * sees what the viewer is allowed to see.
 *
 * MULTIPLY (rather than reading `scene.lit` and writing it back) because a
 * pass may not sample the target it writes. The quad reads only the mask and
 * the illumination buffer, and the blend does the rest.
 *
 * The expression is `./vision-mask.js#decideRevealed`'s last three clauses —
 * that function remains the single definition and the CPU twin:
 *     revealed = R AND (G OR (B AND illum >= threshold))
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture - this subsystem's own R/G/B mask.
 * @param {*} args.illumTexture - `buf:scene.illum`, MSA's own per-pixel brightness.
 * @param {number} args.threshold - `REVEAL_ILLUMINATION_THRESHOLD`.
 * @returns {*} a NodeMaterial for a fullscreen quad.
 */
export function buildVisionGateMaterial({ THREE, maskTexture, illumTexture, threshold }) {
  const { texture, uv, float, vec4, select, max } = THREE.TSL;

  const mask = texture(maskTexture).sample(uv());
  const illum = texture(illumTexture).sample(uv());
  // The SAME illumination the composite lit the frame with — deliberately not
  // a second, differently-derived brightness, so "bright enough to see" and
  // "bright enough to look lit" can never disagree on screen.
  const luminance = max(max(illum.r, illum.g), illum.b);
  const litEnough = luminance.greaterThanEqual(float(threshold));

  const insideLos = mask.r.greaterThan(float(0.5));
  const darkvision = mask.g.greaterThan(float(0.5));
  const lightPerception = mask.b.greaterThan(float(0.5));
  const revealed = insideLos.and(darkvision.or(lightPerception.and(litEnough)));

  // HARD 1/0. No partial reveal: a shader that quietly half-reveals is a
  // shader that quietly half-leaks. A soft fog edge is a presentation choice
  // for a later slice to make on purpose.
  const factor = select(revealed, float(1), float(0));

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  // dst * src — the classic multiply. Alpha is left alone (OneFactor/
  // ZeroFactor would stamp the quad's own alpha over the scene's).
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.ZeroFactor;
  material.blendDst = THREE.SrcColorFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(factor, factor, factor, float(1));
  return material;
}

/**
 * Write a fan-triangulated polygon into a mesh's geometry, reusing the
 * existing attribute array whenever it still fits.
 *
 * ⚠️ REUSES THE ARRAY AND SETS `needsUpdate` — never allocates a new
 * `BufferAttribute` per frame, and never calls `dispose()` on one (there is no
 * such method; `reference_bufferattribute_no_dispose_trap`). A fresh attribute
 * every frame on every vision source is a real GPU-buffer leak, and vision
 * sources rebuild on every token move.
 *
 * @param {*} THREE @param {*} mesh @param {number[]} points @param {number} ox @param {number} oy
 * @returns {number} the vertex count now drawn
 */
function writeFanGeometry(THREE, mesh, points, ox, oy) {
  const existing = mesh.geometry.getAttribute('position');
  const { array, vertexCount } = triangulateLightFan(
    points,
    ox,
    oy,
    NO_RADIUS_NORMALISATION,
    existing ? existing.array : undefined
  );
  if (!existing || existing.array !== array) {
    mesh.geometry.setAttribute('position', new THREE.BufferAttribute(array, 3));
  } else {
    existing.needsUpdate = true;
  }
  // `setDrawRange` rather than resizing: the buffer is deliberately allowed to
  // stay larger than this frame's polygon (see triangulateLightFan's own reuse
  // contract), so the draw range is what makes stale tail vertices invisible.
  mesh.geometry.setDrawRange(0, vertexCount);
  return vertexCount;
}

/**
 * The subsystem. Self-contained on purpose — `vt-pan-viewer.js` is a ~15k-line
 * god object under concurrent edit, so its integration surface here is a
 * constructor, one `update()` and one `dispose()`.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.allocator - `graph/three-allocator.js`'s instance.
 * @param {string} [args.rtName]
 * @returns {{scene: *, texture: *, renderTarget: *, update: Function, dispose: Function, getInfo: Function}}
 */
export function createVisionMaskSubsystem({ THREE, allocator, rtName = 'vision.mask' }) {
  const scene = new THREE.Scene();
  const rtDesc = {
    // SCREEN-SIZED: this mask is consumed by the fullscreen composite at
    // `uv()`, and is drawn with the SAME world camera as the light pass, so
    // it shares the screen's own resolution rather than claiming a world-space
    // budget of its own.
    screenSized: true,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    // NEAREST: every channel is a boolean. Linear filtering would invent
    // half-revealed pixels along a wall edge — a soft fog edge is a
    // presentation choice for the composite to make deliberately, never a
    // sampling accident in the information buffer.
    filter: 'nearest',
    depth: false,
  };
  const renderTarget = allocator.create(rtName, rtDesc);

  /** sourceId → {losMesh, lightMesh, uSightRadius} */
  const pool = new Map();
  let lastDrawn = 0;
  let lastGate = null;

  function createEntry() {
    const los = buildVisionLosMaterial({ THREE });
    const light = buildVisionLightMaterial({ THREE });
    const losMesh = new THREE.Mesh(new THREE.BufferGeometry(), los.material);
    const lightMesh = new THREE.Mesh(new THREE.BufferGeometry(), light.material);
    // Frustum culling OFF: the geometry is rewritten in place every frame and
    // its bounding sphere is never recomputed, so three's own cull test would
    // be deciding against a stale volume — the classic way a correct mesh
    // silently stops drawing.
    losMesh.frustumCulled = false;
    lightMesh.frustumCulled = false;
    losMesh.renderOrder = 0;
    lightMesh.renderOrder = 1;
    scene.add(losMesh);
    scene.add(lightMesh);
    return { losMesh, lightMesh, uSightRadius: los.uSightRadius };
  }

  function disposeEntry(entry) {
    scene.remove(entry.losMesh);
    scene.remove(entry.lightMesh);
    entry.losMesh.geometry.dispose();
    entry.lightMesh.geometry.dispose();
    entry.losMesh.material.dispose();
    entry.lightMesh.material.dispose();
  }

  /**
   * Reconcile the pool against this frame's sources and rebuild geometry.
   *
   * ⚠️ DELIBERATELY DOES NOT TOUCH THE RENDERER. `renderer-state/graph-only`
   * is a structure wall with a body count behind it: V2 had 452
   * `setRenderTarget` sites across 60 files and 262 touches of a global
   * `autoClear`, which is the bug class that produces "it works unless you
   * enable bloom, then shadows break" — unfixable at the call site because
   * the call site isn't wrong. So this returns a DESCRIPTION of the draw and
   * the frame host performs it, exactly as `regionScene`/`lightScene` already
   * work. The structure check caught an earlier version of this file binding
   * its own target; the wall was right.
   *
   * ⚠️ THE CLEAR COLOUR IS PART OF THE ANSWER, not a detail for the caller to
   * pick. When `gate` is false the mask must clear to WHITE — "revealed
   * everywhere" — which is the correct view for a GM with nothing selected
   * (Foundry skips its whole visibility group there too). Leaving it stale
   * would freeze the last token's view onto the GM's screen; clearing to
   * BLACK would blind them. When gating IS on it clears to BLACK, so nothing
   * is revealed until a source actually draws it — the fail-safe direction,
   * because an empty mask then hides the map rather than exposing it.
   *
   * @param {object} args
   * @param {Array<object>} args.sources - from `foundry/scene-vision.js`.
   * @param {boolean} args.gate - from `vision-mask.js#decideFogGating`.
   * @returns {{target: *, scene: *, clearColor: number, drawn: number}} the
   *   draw the host should perform.
   */
  function sync({ sources, gate }) {
    lastGate = gate;
    const live = Array.isArray(sources) ? sources : [];

    if (!gate) {
      for (const [, entry] of pool) {
        entry.losMesh.visible = false;
        entry.lightMesh.visible = false;
      }
      lastDrawn = 0;
      return { target: renderTarget, scene, clearColor: 0xffffff, drawn: 0 };
    }

    const seen = new Set();
    let drawn = 0;
    for (const src of live) {
      const id = src?.sourceId;
      if (typeof id !== 'string' || id.length === 0) continue;
      if (seen.has(id)) continue; // a duplicate id must not produce two meshes
      seen.add(id);
      // A blinded source contributes NOTHING — see this module's header for
      // why dropping (rather than drawing-then-masking) is the safe direction.
      if (src.blinded) continue;

      let entry = pool.get(id);
      if (!entry) {
        entry = createEntry();
        pool.set(id, entry);
      }

      if (src.losPoints) {
        writeFanGeometry(THREE, entry.losMesh, src.losPoints, src.x, src.y);
        entry.losMesh.position.set(src.x, src.y, 0);
        entry.losMesh.visible = true;
        entry.uSightRadius.value = Number.isFinite(src.radius) ? src.radius : 0;
        drawn++;
      } else {
        entry.losMesh.visible = false;
      }

      if (src.lightPoints) {
        writeFanGeometry(THREE, entry.lightMesh, src.lightPoints, src.x, src.y);
        entry.lightMesh.position.set(src.x, src.y, 0);
        entry.lightMesh.visible = true;
        drawn++;
      } else {
        entry.lightMesh.visible = false;
      }
    }

    // Drop anything that went away — a pool that only grows is a GPU leak, and
    // vision sources churn on every selection, move and refreshVision.
    for (const [id, entry] of [...pool]) {
      if (seen.has(id)) continue;
      disposeEntry(entry);
      pool.delete(id);
    }

    lastDrawn = drawn;
    return { target: renderTarget, scene, clearColor: 0x000000, drawn };
  }

  function dispose() {
    for (const [, entry] of pool) disposeEntry(entry);
    pool.clear();
    allocator.dispose(renderTarget);
  }

  /** For the Diagnostics report — a mask that silently stopped drawing must be
   *  visible as a number, not inferred from a dark screen
   *  (`feedback_diagnostics_must_land_in_perf_report`). */
  function getInfo() {
    return { pooled: pool.size, meshesDrawn: lastDrawn, gated: lastGate };
  }

  return {
    scene,
    renderTarget,
    get texture() {
      return renderTarget.texture;
    },
    sync,
    dispose,
    getInfo,
  };
}
