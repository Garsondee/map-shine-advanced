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
export function buildVisionGateMaterial({
  THREE,
  maskTexture,
  illumTexture,
  threshold,
  exploredTexture,
  uViewRect,
  uExploredRect,
  exploredDimNode,
}) {
  const { texture, uv, float, vec4, select, max, mix, vec2 } = THREE.TSL;

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

  // ── THE THREE ZONES (slice 3) ──────────────────────────────────────────
  // Foundry's own fog has three states and players depend on all three:
  //   currently visible    → full brightness
  //   explored, not visible→ DIM (the remembered map — you know the room is
  //                          there, you just cannot see what is in it now)
  //   never explored       → black
  //
  // ⚠️ WITHOUT THIS, "MSA owns fog" IS A GAMEPLAY REGRESSION, NOT JUST A LOOK
  // ONE. Suppressing `canvas.visibility` removes Foundry's explored memory
  // along with its live cone, so a two-zone gate (visible/black) would erase
  // everything a player had already mapped the moment they looked away. That
  // is why slice 3 had to land WITH the takeover rather than after it.
  //
  // ⚠️ THE DIM ZONE SHOWS THE MAP, NEVER THE CONTENTS. It is applied to the
  // FULLY COMPOSITED frame, which already contains tokens, candle flames and
  // particles — so dimming rather than blacking would leak a moving monster at
  // reduced brightness, which is precisely the 50%-alpha hole this whole
  // pillar exists to close. The dim factor is therefore applied to a
  // SEPARATELY-SAMPLED base (the lit map without live content) only when that
  // is available; until it is, `exploredDimNode` is 0 and the explored zone
  // renders black — LESS information than Foundry, never more. Erring toward
  // black is the only safe direction here.
  const factor0 = select(revealed, float(1), float(0));
  let factor = factor0;
  if (exploredTexture && uViewRect && uExploredRect) {
    // Screen UV → world position → explored-buffer UV. Identical mapping to
    // `sun-occlusion-render.js#buildSunVisibilityNode`, reused rather than
    // re-derived so the two cannot drift (and so a Y-flip mistake here would
    // have to be a mistake there too, where it is already proven correct).
    const worldX = mix(uViewRect.x, uViewRect.z, uv().x);
    const worldY = mix(uViewRect.y, uViewRect.w, uv().y);
    const eu = worldX.sub(uExploredRect.x).div(uExploredRect.z.sub(uExploredRect.x));
    const ev = worldY.sub(uExploredRect.y).div(uExploredRect.w.sub(uExploredRect.y));
    const explored = texture(exploredTexture).sample(vec2(eu.clamp(0, 1), ev.clamp(0, 1))).r;
    const isExplored = explored.greaterThan(float(0.5));
    // max(): a currently-visible pixel is never dimmed by also being explored.
    factor = max(factor0, select(isExplored, exploredDimNode ?? float(0), float(0)));
  }

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

  /**
   * THE EXPLORED-AREA BUFFER (slice 3) — WORLD space, never cleared.
   *
   * ⚠️ WORLD-SPACE, NOT SCREEN-SPACE, AND THAT IS THE WHOLE DIFFICULTY. The
   * live mask above is screen-space because it is consumed by a fullscreen
   * gate. Exploration must survive the camera moving, so it is accumulated
   * against the SCENE rect and sampled back through a screen→world→buffer UV
   * mapping. A screen-space accumulation would smear a trail across the map
   * every time the GM panned.
   *
   * ⚠️ NEVER CLEARED, BY DESIGN. Every other target here is cleared each
   * frame; this one is the opposite — it MAX-accumulates forever, because
   * "explored" is monotonic within a session. `resetExploration` exists for
   * the one legitimate reason to wipe it (a scene change, or a GM resetting
   * fog), and nothing else may clear it.
   *
   * 2048² is the world-res cap `docs/planning/Vision-Fog-Ownership.md` §4
   * commits to, matching the sun-shadow field's own ladder — O(1) in map size,
   * so a 12,000px map and a 2,000px map cost the same.
   */
  const exploredRtDesc = {
    resolvedW: 2048,
    resolvedH: 2048,
    screenSized: false,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    // LINEAR here, unlike the live mask's NEAREST: the explored boundary is a
    // remembered edge a player has already seen, so a soft ramp reads better
    // than a 2048-texel staircase, and no information is gated on its exact
    // position (the LIVE gate is what decides what is currently visible).
    filter: 'linear',
    depth: false,
  };
  const exploredTarget = allocator.create(`${rtName}.explored`, exploredRtDesc);
  /** The world rect the explored buffer covers, as [x0,y0,x1,y1]. */
  let exploredRect = [0, 0, 1, 1];
  /** Ortho camera over `exploredRect` — rebuilt only when the rect changes. */
  let exploredCamera = null;
  let exploredNeedsClear = true;

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
    return {
      target: renderTarget,
      scene,
      clearColor: 0x000000,
      drawn,
      // The SECOND draw the host must perform: the same fan scene, into the
      // world-space explored buffer, MAX-accumulated and NEVER cleared.
      explored: {
        target: exploredTarget,
        camera: exploredCamera,
        // Only the very first frame after a scene/rect change clears it;
        // every later frame accumulates. Consumed-and-reset so the host
        // cannot accidentally clear twice.
        clearFirst: (() => {
          const c = exploredNeedsClear;
          exploredNeedsClear = false;
          return c;
        })(),
      },
    };
  }

  /**
   * Point the explored buffer at a world rect (the scene rect). Rebuilds the
   * ortho camera and schedules ONE clear.
   *
   * ⚠️ CALLING THIS WIPES EXPLORATION, so it must be driven by a real scene
   * change and nothing else — not by a resize, not by a floor switch. Wiping
   * exploration mid-session hands players back territory they had already
   * mapped, which is a gameplay event, not a rendering one.
   *
   * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect
   */
  function setExploredRect(rect) {
    const next = [rect.minX, rect.minY, rect.maxX, rect.maxY];
    if (next.every((v, i) => v === exploredRect[i]) && exploredCamera) return;
    exploredRect = next;
    // Ortho over the world rect. Y is NOT flipped: MSA's world space is
    // Foundry pixel space with +Y down, the same convention the light meshes
    // use (`point-light-pool.js` positions with raw Foundry coords), so top =
    // minY and bottom = maxY. Getting this backwards would mirror exploration
    // vertically — the recurring Y-flip trap, avoided by matching the proven
    // call site rather than reasoning from scratch.
    exploredCamera = new THREE.OrthographicCamera(rect.minX, rect.maxX, rect.minY, rect.maxY, -1, 1);
    exploredCamera.updateProjectionMatrix();
    exploredNeedsClear = true;
  }

  /** The gate needs to know which world rect the buffer covers. */
  function getExploredRect() {
    return exploredRect;
  }

  /** Wipe exploration — a GM resetting fog, or a scene change. */
  function resetExploration() {
    exploredNeedsClear = true;
  }

  function dispose() {
    for (const [, entry] of pool) disposeEntry(entry);
    pool.clear();
    allocator.dispose(renderTarget);
    allocator.dispose(exploredTarget);
  }

  /** For the Diagnostics report — a mask that silently stopped drawing must be
   *  visible as a number, not inferred from a dark screen
   *  (`feedback_diagnostics_must_land_in_perf_report`). */
  function getInfo() {
    return {
      pooled: pool.size,
      meshesDrawn: lastDrawn,
      gated: lastGate,
      // The explored buffer never clears, so "is it accumulating" cannot be
      // read off a screenshot — report the rect it covers instead.
      exploredRect: [...exploredRect],
    };
  }

  return {
    scene,
    renderTarget,
    get texture() {
      return renderTarget.texture;
    },
    sync,
    setExploredRect,
    getExploredRect,
    resetExploration,
    get exploredTexture() {
      return exploredTarget.texture;
    },
    dispose,
    getInfo,
  };
}
