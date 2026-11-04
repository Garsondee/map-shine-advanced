/**
 * vt/motion-tile-shadow.js — MOVING TILES CAST THE WINDOW LIGHT'S SHADOW.
 *
 * Author, 2026-11-04 (the Wizard's Lair orrery): *"motion tiles can be set to cast a shadow as a flag … make it so
 * that the shadows cascade down and that those shadows move at the same angle and rate as window lighting so that
 * it is as if the window lighting is casting shadows which are then moving … vary the shadow size by elevation and
 * sort values so that higher ones get a more blurred shadow."*
 *
 * WHAT A SHADOW IS HERE: the window light that never arrives. Each caster tile draws a soft copy of its own alpha
 * into `buf:scene.casterShadow` (R = how much of this pixel the casters cover, MAX across casters, 0..1). Two
 * readers turn that coverage into missing light:
 *
 *   - THE WINDOW (`effects/window/window-render.js`): its contribution — the pull of the room toward the light
 *     outside — is multiplied by `1 − coverage · darkness`. In a caster's shadow the floor keeps the room's own
 *     indoor level and loses only the beam. No beam, no shadow: this is the window's shadow, nothing else's.
 *   - THE ROOM'S SOFT LIGHT FROM ABOVE: after the lamps and before the window, `buf:scene.illum` is multiplied
 *     by `1 − coverage · skylight`. A skylight lets in diffuse light from overhead as well as the beam; something
 *     hanging under it blocks some of that too. Half by default (0.5): on a dark painted floor the beam's share
 *     alone barely shows. ⚠️ It is laid over the LAMPS on purpose, a deliberate exception to 'a shadow takes only
 *     its own light': the Wizard's Lair hangs a white lamp at the orrery's own hub (radius ~525 px), and drawn
 *     before the lamps the soft share vanished under its MAX-blend (measured: shaded pixels 8% → 2% of the frame).
 *     The window's share stays exact either way. Set 'Soft light shadow' to 0 for the strict model.
 *
 * WHERE IT LANDS — the window beam's own throw. `window-room-light.js#resolveRoomSunFrame` says how far the
 * painted beam drifts for the sun right now (`throw`, world px, for a window `throwHeightPx` above the floor).
 * A caster at height `h` throws its shadow `throw · h / throwHeightPx` the same way: the SAME direction and,
 * as the sun moves, the SAME rate, scaled by height. When the window is set not to drift, nothing moves and the
 * shadow lies straight under its caster.
 *
 * HOW HIGH — a piece riding another (a planet on its arm) sits ON its parent: the parent's height + `childLiftPx`.
 * Free pieces: elevation, then sort. All of an orrery's tiles sit at one elevation; their sort order is the stack.
 * A free caster's height is `baseHeightPx + elevation · pxPerElevationUnit + rank · layerStepPx`, `rank` being its
 * place among the DISTINCT sort values of the casters at its own elevation (0 = the lowest). Raw sort numbers
 * (1, 15, 999) are an author's ordering, not distances; the rank keeps a stack of eleven pieces eleven even
 * steps tall whatever numbers they were given. A per-tile height in the tile's motion settings overrides all
 * of it.
 *
 * HOW SOFT — a penumbra grows with the distance to what it falls on: `blurPx = blurBasePx + h · blurPerPx`.
 *
 * CASCADE — a caster's shadow falls only on what is drawn BELOW it: a planet shades the arms and the floor under
 * it, never itself and never the piece above it; each lower piece in turn shades what is under IT. The test is
 * the casters' REAL silhouettes, not `buf:scene.depth`: a tile's depth proxy is built from coarse coverage cells,
 * so it claims the transparent pixels round its art in steps, and a depth-gated shadow showed blocky unshadowed
 * islands beside every piece (found on the rig, 2026-11-04). So a pre-pass draws each caster's art into
 * `buf:scene.casterRank`, and the gate is SOFT — a hard 50%-alpha cut chopped a gear's own shadow into a pixel
 * stair round the rims of its holes (author, 2026-11-04: "the inside of the cogs is showing a clipped ugly pixel
 * shadow"). The pre-pass writes, wherever a caster has any alpha, in stack order so the highest wins:
 * R = the top caster's index, G = ITS alpha; then, MAX-blended, B = the highest index that is fully opaque. A
 * shadow of caster i draws with weight [B < i] · ([R < i] + [R ≥ i]·(1 − G)): nothing at or above i fully covers the
 * pixel, and where the top piece only partly covers it (an anti-aliased rim, a hole's edge) the shadow fills
 * exactly the uncovered fraction. Depth still keeps every shadow off
 * anything drawn above the WHOLE stack (a roof, an overhead tile).
 *
 * This file: the settings (one shared set, like the Tokens card), the pure maths (Node-tested), and the two TSL
 * materials. The viewer owns the target, the meshes and the draw order.
 *
 * @module vt/motion-tile-shadow
 */

import { resolveRoomLook, resolveRoomSunFrame } from '../effects/index.js';

export const MOTION_TILE_SHADOW_DEFAULTS = Object.freeze({
  /** How much of the WINDOW's light a fully covered pixel loses, 0..1. */
  darkness: 1,
  /** How much of the room's other light (ambient, lamps) it loses, 0..1 — skylight from overhead. */
  skylight: 0.5,
  /** Height of the lowest caster at elevation 0, world px. */
  baseHeightPx: 45,
  /** Extra height per step up the sort order, world px. */
  layerStepPx: 20,
  /** How far a tile riding another (its Tile Motion parent) sits above that parent, world px. */
  childLiftPx: 4,
  /** Multiplies every caster's height (and so its throw and blur). */
  heightScale: 1,
  /** Penumbra at zero height, world px. */
  blurBasePx: 2,
  /** Penumbra growth per world px of height. */
  blurPerPx: 0.12,
});

const CLAMPS = Object.freeze({
  darkness: [0, 1],
  skylight: [0, 1],
  baseHeightPx: [0, 400],
  layerStepPx: [0, 120],
  childLiftPx: [0, 120],
  heightScale: [0, 4],
  blurBasePx: [0, 40],
  blurPerPx: [0, 1],
});

/** The Studio/console schema; ranges mirror the clamps in `setMotionTileShadows`. */
export const MOTION_TILE_SHADOW_PARAMS = Object.freeze({
  darkness: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: MOTION_TILE_SHADOW_DEFAULTS.darkness,
    category: 'Look',
    label: 'Window shadow',
    help: "How much of the window's light a moving tile's shadow takes away. 0 turns the window's shadow off.",
  },
  skylight: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: MOTION_TILE_SHADOW_DEFAULTS.skylight,
    category: 'Look',
    label: 'Soft light shadow',
    help: "How much of the room's other light (ambient, lamps) the shadow also takes away, so it still reads when the window is dim.",
  },
  baseHeightPx: {
    type: 'float',
    min: 0,
    max: 400,
    step: 2,
    default: MOTION_TILE_SHADOW_DEFAULTS.baseHeightPx,
    category: 'Height',
    label: 'Lowest piece height',
    help: 'How high the lowest shadow-casting tile hangs above the floor, in map pixels. Higher throws its shadow further and softer.',
  },
  layerStepPx: {
    type: 'float',
    min: 0,
    max: 120,
    step: 1,
    default: MOTION_TILE_SHADOW_DEFAULTS.layerStepPx,
    category: 'Height',
    label: 'Height per layer',
    help: 'How much higher each step up the sort order hangs, in map pixels. The top of a stack throws the longest, softest shadow.',
  },
  childLiftPx: {
    type: 'float',
    min: 0,
    max: 120,
    step: 1,
    default: MOTION_TILE_SHADOW_DEFAULTS.childLiftPx,
    category: 'Height',
    label: 'Riding piece lift',
    help: "How far a tile that rides another (a planet on its arm: its parent in Tile Motion) sits above it, in map pixels. Small keeps its shadow joined to its parent's.",
  },
  heightScale: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: MOTION_TILE_SHADOW_DEFAULTS.heightScale,
    category: 'Height',
    label: 'Height scale',
    help: 'Multiplies every height at once: longer, softer shadows above 1, tighter ones below.',
  },
  blurBasePx: {
    type: 'float',
    min: 0,
    max: 40,
    step: 0.5,
    default: MOTION_TILE_SHADOW_DEFAULTS.blurBasePx,
    category: 'Softness',
    label: 'Edge softness',
    help: 'How soft every shadow edge is at the floor, in map pixels.',
  },
  blurPerPx: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: MOTION_TILE_SHADOW_DEFAULTS.blurPerPx,
    category: 'Softness',
    label: 'Softness with height',
    help: 'How much softer a shadow gets for each map pixel its tile hangs above the floor.',
  },
});

const _s = { ...MOTION_TILE_SHADOW_DEFAULTS, enabled: true };
/** @type {null|{darkness:any, skylight:any}} */
let _uniforms = null;

function clampKey(key, v) {
  const [lo, hi] = CLAMPS[key];
  return Math.max(lo, Math.min(hi, v));
}

function pushUniforms() {
  if (!_uniforms) return;
  _uniforms.darkness.value = _s.enabled ? _s.darkness : 0;
  _uniforms.skylight.value = _s.enabled ? _s.skylight : 0;
}

/**
 * The two shared strength uniforms (one set for every reader, so a dial is a uniform write, never a rebuild).
 * @param {*} THREE
 * @returns {{darkness:any, skylight:any}}
 */
export function motionTileShadowUniforms(THREE) {
  if (_uniforms === null) {
    const { uniform, float } = THREE.TSL;
    _uniforms = { darkness: uniform(float(0)), skylight: uniform(float(0)) };
    pushUniforms();
  }
  return _uniforms;
}

/**
 * Tune live. Unknown keys are ignored; numbers are clamped to the schema's range.
 * @param {Partial<typeof MOTION_TILE_SHADOW_DEFAULTS> & {enabled?:boolean}} next
 */
export function setMotionTileShadows(next = {}) {
  for (const key of Object.keys(CLAMPS)) {
    if (Number.isFinite(next[key])) _s[key] = clampKey(key, next[key]);
  }
  if (typeof next.enabled === 'boolean') _s.enabled = next.enabled;
  pushUniforms();
  return getMotionTileShadows();
}

export function resetMotionTileShadows() {
  return setMotionTileShadows({ ...MOTION_TILE_SHADOW_DEFAULTS, enabled: true });
}

export function getMotionTileShadows() {
  return { ..._s };
}

/** Is anything to be drawn at all? The viewer skips the whole pass when not. */
export function isMotionTileShadowOn() {
  return _s.enabled && (_s.darkness > 0 || _s.skylight > 0);
}

// ===========================================================================
// THE MATHS — pure, Node-tested.
// ===========================================================================

/**
 * Every caster's height above the floor, world px.
 *
 * ATTACHED PIECES SHARE THEIR PARENT'S HEIGHT (2026-11-04, author: "one of the planets shadows is detached from
 * the bar"). A tile riding another (Tile Motion's `parentId`: a planet on its arm, a moon on its planet) sits ON
 * it, so it hangs at the parent's height plus a small `childLiftPx` — never at its own sort rank, which put a
 * planet (sort 150) ~80 px above the arm it is bolted to (sort 35) and threw its shadow clear of the arm's.
 * Only FREE pieces (no parent) are ranked: by elevation, then by the distinct sort values among the free pieces.
 *
 * @param {Array<{id:string, elevation?:number, sort?:number, heightPx?:number|null, parentId?:string|null}>} tiles
 *   - the casters AND any non-casting ancestors of theirs (a parent's height is needed even when it casts nothing).
 * @param {{pxPerElevationUnit?:number}} [scene] - world px per elevation unit (grid size / grid distance).
 * @param {Partial<typeof MOTION_TILE_SHADOW_DEFAULTS>} [settings]
 * @returns {Map<string, number>}
 */
export function resolveCasterHeights(tiles, scene = {}, settings = _s) {
  const D = MOTION_TILE_SHADOW_DEFAULTS;
  const base = Number.isFinite(settings.baseHeightPx) ? settings.baseHeightPx : D.baseHeightPx;
  const step = Number.isFinite(settings.layerStepPx) ? settings.layerStepPx : D.layerStepPx;
  const lift = Number.isFinite(settings.childLiftPx) ? settings.childLiftPx : D.childLiftPx;
  const scale = Number.isFinite(settings.heightScale) ? settings.heightScale : 1;
  const perUnit =
    Number.isFinite(scene.pxPerElevationUnit) && scene.pxPerElevationUnit > 0 ? scene.pxPerElevationUnit : 0;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const parentOf = (t) => (t.parentId && t.parentId !== t.id && byId.has(t.parentId) ? byId.get(t.parentId) : null);

  // Distinct sort values per elevation among the FREE pieces, ascending -> rank.
  const sortsByElevation = new Map();
  for (const t of tiles) {
    if (parentOf(t)) continue;
    const e = num(t.elevation);
    let set = sortsByElevation.get(e);
    if (!set) sortsByElevation.set(e, (set = new Set()));
    set.add(num(t.sort));
  }
  const rankOf = new Map();
  for (const [e, set] of sortsByElevation) {
    const ordered = [...set].sort((a, b) => a - b);
    rankOf.set(e, new Map(ordered.map((v, i) => [v, i])));
  }

  // Unscaled height. `seen` breaks a parent cycle: the tile that closes it is treated as free.
  const memo = new Map();
  const heightOf = (t, seen) => {
    if (memo.has(t.id)) return memo.get(t.id);
    seen.add(t.id);
    let h;
    const override = Number(t.heightPx);
    const parent = parentOf(t);
    if (Number.isFinite(override) && override > 0) h = override;
    else if (parent && !seen.has(parent.id)) h = heightOf(parent, seen) + lift;
    else {
      const e = num(t.elevation);
      const rank = rankOf.get(e)?.get(num(t.sort)) ?? 0;
      h = base + Math.max(0, e) * perUnit + rank * step;
    }
    memo.set(t.id, h);
    return h;
  };

  const out = new Map();
  for (const t of tiles) out.set(t.id, Math.max(0, heightOf(t, new Set()) * scale));
  return out;
}

/**
 * The window beam's throw for this sun, with the window card's own dials — the SAME call the window makes.
 * @param {object|null} sun - `env.sun` ({elevationDeg, azimuthDeg, dayFactor01}).
 * @param {object} windowParams - the window effect's live params.
 * @returns {{throwX:number, throwY:number, throwHeightPx:number}}
 */
export function resolveWindowThrow(sun, windowParams = {}) {
  const look = resolveRoomLook(windowParams ?? {});
  const frame = resolveRoomSunFrame(sun ?? null, look);
  return { throwX: frame.throwX, throwY: frame.throwY, throwHeightPx: look.throwHeightPx };
}

/**
 * One caster's shadow: where it lands and how soft it is.
 * @param {number} heightPx
 * @param {{throwX:number, throwY:number, throwHeightPx:number}} windowThrow
 * @param {Partial<typeof MOTION_TILE_SHADOW_DEFAULTS>} [settings]
 * @returns {{offsetX:number, offsetY:number, blurPx:number}}
 */
export function resolveCasterShadow(heightPx, windowThrow, settings = _s) {
  const h = Math.max(0, Number(heightPx) || 0);
  const ref = windowThrow?.throwHeightPx > 0 ? windowThrow.throwHeightPx : 0;
  const k = ref > 0 ? h / ref : 0;
  const blurBase = Number.isFinite(settings.blurBasePx) ? settings.blurBasePx : MOTION_TILE_SHADOW_DEFAULTS.blurBasePx;
  const blurPer = Number.isFinite(settings.blurPerPx) ? settings.blurPerPx : MOTION_TILE_SHADOW_DEFAULTS.blurPerPx;
  return {
    offsetX: (windowThrow?.throwX ?? 0) * k,
    offsetY: (windowThrow?.throwY ?? 0) * k,
    blurPx: Math.max(0.5, blurBase + h * blurPer),
  };
}

// ===========================================================================
// THE MATERIALS
// ===========================================================================

/** Blur taps in units of the blur radius: centre, inner ring, outer ring (weights fall outward). */
const SHADOW_TAPS = (() => {
  const taps = [[0, 0, 1]];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    taps.push([Math.cos(a) * 0.45, Math.sin(a) * 0.45, 0.8]);
  }
  for (let i = 0; i < 10; i++) {
    const a = ((i + 0.5) / 10) * Math.PI * 2;
    taps.push([Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.45]);
  }
  return taps;
})();

/**
 * ONE caster's coverage material: the tile's own geometry, grown about its rest centre by twice the blur
 * (the blur's real support), carried by the tile's live motion (the SAME uniform bag its colour mesh reads),
 * then moved by the shadow offset. Writes coverage to R (and A), MAX-blended.
 *
 * @param {*} THREE
 * @param {object} args
 * @param {*} args.tex - the tile's art.
 * @param {number[]} [args.uvScale] - the tile piece's padding crop.
 * @param {number} args.texWidth - texel width (sizes the blur mip).
 * @param {*} args.depthTexture - `buf:scene.depth`'s depth.
 * @param {*} args.rankTexture - `buf:scene.casterRank` (R top caster's index / 255, G its alpha, B highest fully
 *   opaque index / 255).
 * @param {object|null} args.tileMotion - the tile's motion uniform bag, or null.
 * @returns {{material:any, uCenter:any, uSize:any, uRestRot:any, uOffset:any, uBlurPx:any, uTopDepth:any, uIndex:any, uAlpha:any}}
 */
export function buildMotionTileShadowMaterial(
  THREE,
  { tex, uvScale, texWidth, depthTexture, rankTexture, tileMotion }
) {
  const TSL = THREE.TSL;
  const { Fn, uniform, vec2, vec3, vec4, float, uv, texture, positionLocal, screenUV } = TSL;
  const uCenter = uniform(vec2(0, 0));
  const uSize = uniform(vec2(1, 1));
  const uRestRot = uniform(vec2(1, 0));
  const uOffset = uniform(vec2(0, 0));
  const uBlurPx = uniform(float(4));
  /** Tie-safe expected depth of the TOP caster: anything stored nearer than this is above the whole stack. */
  const uTopDepth = uniform(float(0));
  /** This caster's place in the stack, 1..255, over 255. */
  const uIndex = uniform(float(1 / 255));
  const uAlpha = uniform(float(1));
  const uUvScale = uniform(vec2(uvScale?.[0] ?? 1, uvScale?.[1] ?? 1));
  const uTexWidth = uniform(float(Math.max(1, texWidth || 1)));

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  // The world camera is Y-down: without DoubleSide every world quad is culled (token contact shadow, 2026-11-02).
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;

  // Grow factor per LOCAL axis: twice the blur on every side.
  const pad = vec2(1, 1).add(uBlurPx.mul(4).div(uSize));

  material.positionNode = Fn(() => {
    // Rest world vertex -> the tile's own local frame (its static rotation), grown, back to world.
    const rel = positionLocal.xy.sub(uCenter);
    const lx = rel.x.mul(uRestRot.x).add(rel.y.mul(uRestRot.y));
    const ly = rel.y.mul(uRestRot.x).sub(rel.x.mul(uRestRot.y));
    const gx = lx.mul(pad.x);
    const gy = ly.mul(pad.y);
    const grown = uCenter.add(
      vec2(gx.mul(uRestRot.x).sub(gy.mul(uRestRot.y)), gx.mul(uRestRot.y).add(gy.mul(uRestRot.x)))
    );
    let xy = grown;
    if (tileMotion) {
      // The colour mesh's own rigid motion (vt-pan-viewer.js, 'TILE MOTION'): v' = pivot + Rot·(v − pivot) + T.
      const r = grown.sub(tileMotion.uMotionPivot);
      const rotated = vec2(
        r.x.mul(tileMotion.uMotionRot.x).sub(r.y.mul(tileMotion.uMotionRot.y)),
        r.x.mul(tileMotion.uMotionRot.y).add(r.y.mul(tileMotion.uMotionRot.x))
      );
      xy = tileMotion.uMotionPivot.add(rotated).add(tileMotion.uMotionTranslate);
    }
    xy = xy.add(uOffset);
    return vec3(xy.x, xy.y, positionLocal.z);
  })();

  material.colorNode = Fn(() => {
    // The art uv this fragment would have on the un-grown quad.
    const artUv = uv().sub(0.5).mul(pad).add(0.5).toVar();
    const reach = uBlurPx.div(uSize).toVar(); // blur radius in art uv, per axis
    const reachMax = TSL.max(reach.x, reach.y);
    const lod = TSL.log2(TSL.max(float(1), uTexWidth.mul(uUvScale.x).mul(reachMax).div(3)));
    const artSample = (p) => {
      let s = p.clamp(0, 1).mul(uUvScale);
      if (tileMotion) {
        // A texture-mode tile spins its art inside a still quad: the shadow spins with it.
        const rel = s.sub(tileMotion.uTexPivotUV);
        const rc = tileMotion.uTexRotUV.x;
        const rs = tileMotion.uTexRotUV.y;
        s = tileMotion.uTexPivotUV
          .add(tileMotion.uTexScrollUV)
          .add(vec2(rel.x.mul(rc).add(rel.y.mul(rs)), rel.y.mul(rc).sub(rel.x.mul(rs))));
      }
      return texture(tex, s).level(lod).a;
    };
    // Past the art's border the alpha falls away smoothly over the blur width, as a blurred zero-padded image
    // would (a hard inside-[0,1] cut made straight-edged halos on token shadows, 2026-11-02).
    const cover = (p) => {
      const outside = TSL.max(TSL.max(p.negate(), p.sub(1)), vec2(0))
        .div(TSL.max(reach, vec2(1e-4)))
        .length();
      return artSample(p).mul(float(1).sub(TSL.smoothstep(0, 0.6, outside)));
    };
    const acc = float(0).toVar();
    let wsum = 0;
    for (const [ox, oy, w] of SHADOW_TAPS) {
      acc.addAssign(cover(artUv.add(vec2(ox, oy).mul(reach))).mul(w));
      wsum += w;
    }
    const s = TSL.smoothstep(0, 0.9, acc.div(wsum));

    // CASCADE (soft — see the module header): no caster at or above this one fully covers the pixel, and a
    // partly covering top piece lets through exactly its uncovered fraction…
    const rankHere = rankTexture ? texture(rankTexture, screenUV) : vec4(0, 0, 0, 0);
    const myEdge = uIndex.sub(0.5 / 255);
    const noCoreAbove = TSL.step(rankHere.b, myEdge);
    const topBelow = TSL.step(rankHere.r, myEdge);
    const belowCasters = noCoreAbove.mul(topBelow.add(float(1).sub(topBelow).mul(float(1).sub(rankHere.g))));
    // …and nothing above the whole stack covers the pixel.
    const notUnderRoof = depthTexture ? TSL.step(uTopDepth, texture(depthTexture, screenUV).x) : float(1);
    const below = belowCasters.mul(notUnderRoof);

    // Zero at the grown quad's own border, fading over its last half-blur only (per axis, in grown-quad uv).
    // The quad is grown 2 blurs past the art and the taps reach ~1.5 blurs, so nothing real lives out there;
    // the first cut faded over 0.5/pad of the WHOLE quad and dimmed big shadows far inside their border.
    const q = uv();
    const band = reach.mul(0.5).div(pad);
    const edgeFade = TSL.smoothstep(0, band.x, TSL.min(q.x, float(1).sub(q.x))).mul(
      TSL.smoothstep(0, band.y, TSL.min(q.y, float(1).sub(q.y)))
    );

    const c = s.mul(below).mul(edgeFade).mul(uAlpha);
    return vec4(c, c, c, c);
  })();

  return { material, uCenter, uSize, uRestRot, uOffset, uBlurPx, uTopDepth, uIndex, uAlpha };
}

/**
 * ONE caster's silhouette for `buf:scene.casterRank` — two materials on the tile's own geometry and live motion
 * (texture-mode spin included):
 *   - `material`: wherever the art has any alpha, writes (index, alpha) to R,G with NO blending — drawn in stack
 *     order (`mesh.renderOrder` = index), so the highest caster here is the one left;
 *   - `coreMaterial`: where the art is fully opaque, writes the index to B, MAX-blended (R and G receive 0, which a
 *     MAX leaves untouched).
 * @param {*} THREE
 * @param {{tex:any, uvScale?:number[], tileMotion:object|null}} args
 * @returns {{material:any, coreMaterial:any, uIndex:any}}
 */
export function buildCasterSilhouetteMaterial(THREE, { tex, uvScale, tileMotion }) {
  const TSL = THREE.TSL;
  const { Fn, uniform, vec2, vec3, vec4, float, uv, texture, positionLocal } = TSL;
  const uIndex = uniform(float(1 / 255));
  const uUvScale = uniform(vec2(uvScale?.[0] ?? 1, uvScale?.[1] ?? 1));
  const positionNode = tileMotion
    ? Fn(() => {
        const r = positionLocal.xy.sub(tileMotion.uMotionPivot);
        const rotated = vec2(
          r.x.mul(tileMotion.uMotionRot.x).sub(r.y.mul(tileMotion.uMotionRot.y)),
          r.x.mul(tileMotion.uMotionRot.y).add(r.y.mul(tileMotion.uMotionRot.x))
        );
        const xy = tileMotion.uMotionPivot.add(rotated).add(tileMotion.uMotionTranslate);
        return vec3(xy.x, xy.y, positionLocal.z);
      })()
    : null;
  const alphaNode = () =>
    Fn(() => {
      let s = uv().mul(uUvScale);
      if (tileMotion) {
        const rel = s.sub(tileMotion.uTexPivotUV);
        const rc = tileMotion.uTexRotUV.x;
        const rs = tileMotion.uTexRotUV.y;
        s = tileMotion.uTexPivotUV
          .add(tileMotion.uTexScrollUV)
          .add(vec2(rel.x.mul(rc).add(rel.y.mul(rs)), rel.y.mul(rc).sub(rel.x.mul(rs))));
      }
      return texture(tex, s).a;
    })();
  const make = () => {
    const m = new THREE.NodeMaterial();
    m.transparent = true;
    m.depthTest = false;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    if (positionNode) m.positionNode = positionNode;
    return m;
  };

  const material = make();
  material.blending = THREE.NoBlending;
  const a = alphaNode();
  material.maskNode = a.greaterThan(0.004);
  material.colorNode = vec4(uIndex, a, float(0), float(1));

  const coreMaterial = make();
  coreMaterial.blending = THREE.CustomBlending;
  coreMaterial.blendEquation = THREE.MaxEquation;
  coreMaterial.blendSrc = THREE.OneFactor;
  coreMaterial.blendDst = THREE.OneFactor;
  coreMaterial.blendEquationAlpha = THREE.MaxEquation;
  coreMaterial.blendSrcAlpha = THREE.OneFactor;
  coreMaterial.blendDstAlpha = THREE.OneFactor;
  coreMaterial.maskNode = alphaNode().greaterThan(0.98);
  coreMaterial.colorNode = vec4(float(0), float(0), uIndex, float(1));

  return { material, coreMaterial, uIndex };
}

/**
 * The fullscreen multiply for the room's soft light from above: `illum *= 1 − coverage · skylight`, drawn into
 * `buf:scene.illum` BEFORE the window adds its beam (the window reads the coverage itself).
 * @param {*} THREE
 * @param {*} coverageTexture - `buf:scene.casterShadow`.
 * @returns {any} a NodeMaterial for a `THREE.QuadMesh`.
 */
export function buildCasterSkylightMaterial(THREE, coverageTexture) {
  const TSL = THREE.TSL;
  const { vec3, vec4, float, texture, screenUV } = TSL;
  const u = motionTileShadowUniforms(THREE);
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.ZeroFactor;
  material.blendDst = THREE.SrcColorFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  const cov = texture(coverageTexture, screenUV).r;
  material.colorNode = vec4(vec3(float(1).sub(cov.mul(u.skylight))), 1);
  return material;
}

/** @type {{casters:number, throwX:number, throwY:number, heights:Array<{id:string, sort:number, heightPx:number, blurPx:number}>}} */
let _lastFrame = { casters: 0, throwX: 0, throwY: 0, heights: [] };

/** The viewer's per-frame report of what it drew (casters, the window throw used, each caster's height/blur). */
export function recordMotionTileShadowFrame(report) {
  if (report && typeof report === 'object') _lastFrame = report;
}

/** For the console: the settings plus last frame's report. */
export function getMotionTileShadowInfo() {
  return {
    ...getMotionTileShadows(),
    lastFrame: { ..._lastFrame, heights: _lastFrame.heights.map((x) => ({ ...x })) },
  };
}
