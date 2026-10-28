/**
 * TABLE'S SURFACE — the recessed board, brass rim and velvet, as TSL. THREE is
 * injected as `TSL`, never imported.
 *
 * Every pixel is traced in closed form (`table-model.js#traceTablePixel`,
 * mirrored here node for node): where the ray from the pretend eye meets the
 * table top, the recess wall, or the board. Everything is procedural — a
 * texture-free hash noise (Dave Hoskins' `hash12`, no `sin`, so it stays stable
 * at world coordinates in the tens of thousands) for the pile, the brushing and
 * the mottling; the brass is a moulded profile lit by one overhead lamp.
 *
 * TWO MESHES IN THE WORLD PASS (`buildTableMaterials`), because the table must sit
 * UNDER tokens and tiles placed on the velvet and yet OVER the board's edge:
 *  - the FLOOR (opaque, `renderOrder` below the floor art): velvet, rim and the
 *    recess wall wherever the pixel is not board. Discards the board's pixels, and
 *    does its heavy shading inside a branch, so a zoomed-in board costs next to nothing;
 *  - the OVERLAY (blended, drawn last): the lip where it overhangs the board's edge
 *    once the eye is past it, plus the contact shadow the rim throws on the board.
 *
 * @module effects/table/table-render
 */

/**
 * The live values the surface reads, packed into vec4s.
 * @param {*} TSL
 */
export function createTableUniforms(TSL) {
  const { uniform, vec3, vec4 } = TSL;
  return {
    /** (eye x, eye y, eye height, recess depth), world px. */
    eye: uniform(vec4(0, 0, 1000, 60)),
    /** The table's outer edge — the padded canvas: (minX, minY, maxX, maxY), world px. */
    outer: uniform(vec4(-1, -1, 2, 2)),
    /** The board: (minX, minY, maxX, maxY), world px. */
    rect: uniform(vec4(0, 0, 1, 1)),
    /** (padding x, padding y, rim width, detail unit), world px. The unit scales seams, stitches and brushing. */
    frame: uniform(vec4(1, 1, 40, 100)),
    /** (edge shadow 0..1, edge shadow width px, engraving 0..1, lamp height px). */
    look: uniform(vec4(0.45, 60, 0.6, 3000)),
    /** (board AO softness, velvet AO strength, velvet AO width px, recess floor depth below the board px). */
    ao: uniform(vec4(0.65, 0.4, 60, 0)),
    /** (roundness, shine, polish, brushed). */
    rim: uniform(vec4(0.8, 1, 0.7, 0.35)),
    rimColor: uniform(vec3(0.48, 0.25, 0.05)),
    /** (nap, nap size px, mottle, sheen). */
    felt: uniform(vec4(0.4, 6, 0.35, 0.5)),
    feltColor: uniform(vec3(0.012, 0.15, 0.06)),
    /** (seams, stitching, world px per screen px, outer edge width px). */
    seams: uniform(vec4(0.75, 0.4, 1, 0)),
    /** (stitch length 0..1, spacing ×, thickness ×, outline 0..1). */
    stitch: uniform(vec4(0.5, 1, 1, 0.7)),
    /** (stitch inset ×, middle panel lines 0..1, panel bump 0..1, bump width px). */
    panel: uniform(vec4(1, 0.75, 0.35, 200)),
    stitchColor: uniform(vec3(0.58, 0.36, 0.07)),
    /** (strength, spread, room dark, corner darkening). */
    lamp: uniform(vec4(1, 1.2, 0.75, 0.7)),
    lampColor: uniform(vec3(1, 0.79, 0.52)),
    /** (share of the board shadow the overlay applies — the top layers' share, 1 = all of it;
     * overhang reach 0..1 — the shadow carries on past the board to the brass while parallax raises layers; unused ×2). */
    shade: uniform(vec4(1, 0, 0, 0)),
  };
}

/** Push `resolveTableFrame`'s values (plus the board and the pixel size) into the uniforms. */
export function applyTableFrame(u, frame, { rect, outer, padX, padY, worldPerPx }) {
  const [ex, ey, eh, depth] = frame.eye;
  u.eye.value.set(ex, ey, eh, depth);
  u.rect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
  const o = outer ?? { minX: rect.minX - padX, minY: rect.minY - padY, maxX: rect.maxX + padX, maxY: rect.maxY + padY };
  u.outer.value.set(o.minX, o.minY, o.maxX, o.maxY);
  u.frame.value.set(Math.max(1, padX), Math.max(1, padY), frame.rimW, frame.rimW);
  const halfDiag = 0.5 * Math.hypot(rect.maxX - rect.minX, rect.maxY - rect.minY);
  u.look.value.set(frame.shadow[0], frame.shadow[1], frame.rimEngrave, Math.max(eh * 0.6, halfDiag * 1.4));
  u.ao.value.set(frame.ao[0], frame.ao[1], frame.ao[2], frame.floorDepth ?? 0);
  u.rim.value.set(...frame.rim);
  u.rimColor.value.set(...frame.rimColor);
  u.felt.value.set(...frame.felt);
  u.feltColor.value.set(...frame.feltColor);
  u.seams.value.set(frame.seams[0], frame.seams[1], Math.max(1e-4, worldPerPx), frame.edgeW);
  u.lamp.value.set(...frame.lamp);
  u.stitch.value.set(...frame.stitch);
  u.panel.value.set(...frame.panel);
  u.stitchColor.value.set(...frame.stitchColor);
  u.lampColor.value.set(...frame.lampColor);
}

/**
 * The cheap half: where the ray lands, which surface it meets, and how much of
 * the pixel each mesh owns. Pure arithmetic — safe to evaluate for every pixel.
 * @param {*} TSL
 * @param {object} args
 * @param {*} args.worldXY - the pixel's position on the board plane (vec2, world px, y down).
 * @param {ReturnType<typeof createTableUniforms>} args.u
 */
export function buildTableTrace(TSL, { worldXY, u }) {
  const { float, max, smoothstep } = TSL;
  const eye = u.eye.xy;
  const eyeH = u.eye.z;
  const depth = u.eye.w;
  const rMin = u.rect.xy;
  const rMax = u.rect.zw;
  const wpp = u.seams.z;
  const p = worldXY;
  const fd = u.ao.w;
  const k = eyeH.sub(depth).div(eyeH);
  const q = eye.add(p.sub(eye).mul(k));
  const over = (v) => max(rMin.sub(v), v.sub(rMax)); // per-axis overhang, negative inside
  const oq = over(q);
  const op = over(p);
  const dq = max(oq.x, oq.y);
  const dp = max(op.x, op.y);
  // Where the ray meets the recess floor (the lowest floor of the parallax stack): the board
  // plane's own point when there is no stack (fd = 0), so dw is then exactly dp.
  const w = eye.add(p.sub(eye).mul(eyeH.add(fd).div(eyeH)));
  const ow = over(w);
  const dw = max(ow.x, ow.y);
  const aa = wpp.mul(0.75);
  // The floor owns every pixel that is not board; the overlay owns the lip over
  // the board and the shadow beside it.
  // ⚠️ "Not board" is the viewed floor's plane (dp) AS WELL AS the recess floor (dw). With the eye past
  // the board's edge, a ray that lands inside the rect on the recess floor (dw ≤ 0) can still start
  // outside the board (dp > 0), where the viewed floor draws nothing: discarding there showed the
  // background grey through a hole along the far rim (found live 2026-10-28, "a gap in the geometry").
  const floorLive = max(dp, dw).greaterThan(aa.negate());
  const shadowW = u.look.y;
  // The lip covers the board AND whatever a lower floor (drawn later, shrunk toward the eye) puts past
  // the board's edge while the table top is in the way (dq > 0): the top hides what is under it.
  const underTop = dq.greaterThan(aa.negate());
  // THE OVERHANG: past the board's edge but inside the brass's inner edge — the strip of recess wall a
  // parallax canopy rides out over. The board shadow carries on across it (`buildBoardOcclusion`), so a
  // canopy crossing the board's edge is not cut by a hard dark seam there (found live 2026-10-28).
  const overhang = dp.greaterThan(float(0)).and(dq.lessThanEqual(aa.negate()));
  const overlayLive = dp
    .lessThanEqual(float(0))
    .and(underTop.or(dp.negate().lessThan(shadowW)))
    .or(dw.lessThanEqual(float(0)).and(underTop))
    .or(overhang);
  const tableCover = smoothstep(aa.negate(), aa, dq);
  const lipCover = tableCover;
  return { p, w, q, k, oq, dq, dp, dw, aa, floorLive, overlayLive, overhang, tableCover, lipCover };
}

/**
 * The expensive half: the colour of the table at a traced pixel — the brass rim
 * or velvet on the table top, or the recess wall — and the board's contact shadow.
 * @param {*} TSL
 * @param {ReturnType<typeof buildTableTrace>} tr
 * @param {ReturnType<typeof createTableUniforms>} u
 * @returns {{rgb:*, boardShade:*}}
 */
export function buildTableShading(TSL, tr, u) {
  const { float, vec2, vec3, max, min, abs, mix, smoothstep, fract, floor, dot, exp, pow, sqrt, normalize, length } =
    TSL;
  // ── noise ──────────────────────────────────────────────────────────────
  const hash12 = (p) => {
    let p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031));
    p3 = p3.add(dot(p3, vec3(p3.y, p3.z, p3.x).add(33.33)));
    return fract(p3.x.add(p3.y).mul(p3.z));
  };
  const vnoise = (p) => {
    const i = floor(p);
    const f = fract(p);
    const w = f.mul(f).mul(float(3).sub(f.mul(2)));
    const a = hash12(i);
    const b = hash12(i.add(vec2(1, 0)));
    const c = hash12(i.add(vec2(0, 1)));
    const d = hash12(i.add(vec2(1, 1)));
    return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
  };

  const eye = u.eye.xy;
  const eyeH = u.eye.z;
  const depth = u.eye.w;
  const rMin = u.rect.xy;
  const rMax = u.rect.zw;
  const centre = rMin.add(rMax).mul(0.5);
  const pad = u.frame.xy;
  const rimW = u.frame.z;
  const unit = u.frame.w;
  const wpp = u.seams.z;
  const { q, oq, dq, dp, aa } = tr;

  // The lamp hangs over the board's centre; the pool of light falls off with
  // distance on the table and fades into a dark room.
  const halfDiag = length(rMax.sub(rMin)).mul(0.5);
  // ONE SPOT LIGHT hanging over the board's centre. Over a flat table a spot's light falls as
  // cos³ of the angle off its axis (the `pow(1+r², -1.5)`), a soft-edged cone then eases the
  // rim of its pool out to nothing, and the room beyond is dark. On top, the table's four
  // diagonal corners are darkened — |nx·ny| peaks only toward the corners, so the sides keep
  // their light while the corners sink into shadow, which is most of what makes it feel deep.
  const halfTable = rMax.sub(rMin).mul(0.5).add(pad);
  const lampAt = (xy) => {
    const d = xy.sub(centre);
    const r = length(d).div(halfDiag.mul(u.lamp.y));
    const spot = pow(float(1).add(r.mul(r)), float(-1.5)).mul(float(1).sub(smoothstep(float(0.9), float(2.6), r)));
    const n = d.div(halfTable);
    const corner = float(1).sub(smoothstep(float(0.12), float(0.8), abs(n.x.mul(n.y))).mul(u.lamp.w));
    return mix(float(1), spot, u.lamp.z).mul(corner).mul(u.lamp.x);
  };
  const lampHeight = u.look.w;
  const lampPos = vec3(centre.x, centre.y, lampHeight);
  const eyePos = vec3(eye.x, eye.y, eyeH);

  // ── brass rim ────────────────────────────────────────────────────────────
  const xRail = oq.x.greaterThan(oq.y);
  const outDir = xRail.select(vec2(q.x.sub(centre.x).sign(), 0), vec2(0, q.y.sub(centre.y).sign()));
  const t = dq.div(rimW).clamp(0, 1);
  // A picture-frame moulding: a half-round bead on the inner edge, a small
  // cove behind it, then a flat band that rolls over at the outer edge. Each
  // change of slope catches the lamp as its own line of light.
  const tb = t.div(0.42);
  const tc = t.sub(0.42).div(0.1);
  const beadAcross = tb.mul(2).sub(1).mul(0.95);
  const coveAcross = float(1).sub(tc.mul(2)).mul(0.55);
  const flatAcross = float(0.1).add(smoothstep(float(0.9), float(1), t).mul(0.75));
  const across = t.lessThan(0.42).select(beadAcross, t.lessThan(0.52).select(coveAcross, flatAcross)).mul(u.rim.x);
  const nUp = sqrt(max(float(1).sub(across.mul(across)), float(0.02)));
  const nRim = normalize(vec3(outDir.mul(across), nUp));
  const rimPos = vec3(q, depth.add(nUp.sub(0.4).mul(rimW).mul(0.25)));
  const vRim = normalize(eyePos.sub(rimPos));
  const lRim = normalize(lampPos.sub(rimPos));
  const rRim = vRim.negate().reflect(nRim);
  const polish = u.rim.z;
  const along = xRail.select(q.y, q.x);
  const brushFade = float(1).sub(smoothstep(float(0.5), float(1.5), wpp.mul(60).div(rimW)));
  const brush = vnoise(vec2(along.div(unit.mul(3)), t.mul(40)))
    .mul(0.6)
    .add(vnoise(vec2(along.div(unit.mul(0.8)), t.mul(90))).mul(0.4))
    .sub(0.5)
    .mul(u.rim.w)
    .mul(brushFade);
  const specPow = mix(float(10), float(260), polish);
  const spec = pow(max(dot(rRim, lRim), float(0)), specPow)
    .mul(specPow.mul(0.05).add(0.6))
    .mul(u.rim.y);
  // A studio-like surround: reflections that point up see the lit ceiling,
  // ones that skim the table see the dark room — that banding is what reads as metal.
  const env = mix(float(0.06), float(0.5), smoothstep(float(-0.1), float(0.95), rRim.z));
  const lampRim = lampAt(q);
  const fres = pow(float(1).sub(max(dot(vRim, nRim), float(0))), float(5));
  let rimRgb = u.rimColor
    .mul(env.add(max(dot(nRim, lRim), float(0)).mul(0.25)))
    .mul(lampRim)
    .add(u.rimColor.mul(u.lampColor).mul(spec).mul(lampRim))
    .add(u.lampColor.mul(fres).mul(0.06).mul(lampRim));
  rimRgb = rimRgb.mul(float(1).add(brush.mul(0.35)));
  // BRASS AO — the metal sits in the same shadows as everything round it. A surface tilted
  // away from straight up sees less of the room (1 − n.z), the concave cove behind the bead
  // more so, and the inner flank that drops into the recess shares the board's own AO.
  const rimAoAmt = max(u.look.x, u.ao.y);
  const flank = float(1).sub(nUp).mul(rimAoAmt).mul(0.85);
  const cove = smoothstep(float(0.4), float(0.47), t)
    .mul(float(1).sub(smoothstep(float(0.47), float(0.54), t)))
    .mul(rimAoAmt)
    .mul(0.35);
  const intoRecess = float(1)
    .sub(smoothstep(float(0), float(0.25), t))
    .mul(u.look.x)
    .mul(0.45);
  rimRgb = rimRgb.mul(float(1).sub(flank).sub(cove).sub(intoRecess).max(0.05));
  // Engraving: a fine line round the rim, and the 45° mitre at each corner.
  const lineW = max(float(0.035), wpp.mul(1.1).div(rimW));
  const groove = (c) => float(1).sub(smoothstep(lineW.mul(0.5), lineW, abs(t.sub(c))));
  const mitreD = abs(oq.x.sub(oq.y)).div(rimW);
  const mitre = float(1)
    .sub(smoothstep(lineW.mul(0.5), lineW, mitreD))
    .mul(oq.x.greaterThan(0).and(oq.y.greaterThan(0)).select(float(1), float(0)));
  const engrave = max(groove(float(0.74)), mitre).mul(u.look.z);
  rimRgb = rimRgb.mul(float(1).sub(engrave.mul(0.7)));
  // The inner arris catches the lamp: a hairline of light on the lip's edge.
  rimRgb = rimRgb.add(
    u.rimColor
      .mul(u.lampColor)
      .mul(float(1).sub(smoothstep(float(0), lineW.mul(1.5), t)))
      .mul(0.6)
      .mul(lampRim)
  );

  // The table's outer edge (the padded canvas), needed by both the velvet and the edge bead.
  const edgeW = u.seams.w;
  const oMin = u.outer.xy;
  const oMax = u.outer.zw;
  const oEdge = max(oMin.sub(q), q.sub(oMax));
  const dOut = max(oEdge.x, oEdge.y);

  // ── velvet ───────────────────────────────────────────────────────────────
  // Panels are split by the seams, which run from the rim's outer corners to
  // the table's corners; each panel's pile runs outward from the board.
  const ov = oq.sub(rimW);
  const padV = max(pad.sub(rimW), vec2(1, 1));
  const xPanel = ov.x.mul(padV.y).greaterThan(ov.y.mul(padV.x));
  const napDir = xPanel.select(vec2(q.x.sub(centre.x).sign(), 0), vec2(0, q.y.sub(centre.y).sign()));
  const napSize = u.felt.y;
  const napFade = float(1).sub(smoothstep(float(0.35), float(1.2), wpp.div(napSize)));
  const pile = vnoise(q.div(napSize))
    .mul(0.65)
    .add(vnoise(q.div(napSize.mul(0.43)).add(17.3)).mul(0.35))
    .sub(0.5)
    .mul(u.felt.x)
    .mul(napFade);
  // Crushed-velvet brushing: soft streaks running with each panel's pile.
  const napAlong = dot(q, napDir);
  const napAcross = dot(q, vec2(napDir.y, napDir.x.negate()));
  const mottle = vnoise(vec2(napAlong.div(unit.mul(6)), napAcross.div(unit.mul(2.6))))
    .mul(0.65)
    .add(vnoise(vec2(napAlong.div(unit.mul(2.2)), napAcross.div(unit.mul(1))).add(5.1)).mul(0.35))
    .sub(0.5)
    .mul(u.felt.z);
  const tilt = q.sub(eye).div(eyeH);
  const sheenDir = dot(tilt, napDir).mul(3).clamp(-1, 1);
  const graze = smoothstep(float(0.05), float(0.9), length(tilt));
  let feltLum = float(1)
    .add(pile.mul(0.45))
    .add(mottle.mul(0.45))
    .add(sheenDir.mul(u.felt.w).mul(0.16))
    .add(graze.mul(u.felt.w).mul(0.22));
  // SEAMS. The corner seams run from the rim's outer corners to the table's corners; the
  // middle panel lines run straight out from the midpoint of each side of the board. Each is a
  // crease with a lifted fold beside it and a line of stitches either side.
  const seamDir = normalize(padV);
  const inCorner = ov.x.greaterThan(0).and(ov.y.greaterThan(0)).select(float(1), float(0));
  const seamSigned = ov.x.mul(seamDir.y).sub(ov.y.mul(seamDir.x));
  const seamAlong = dot(ov, seamDir);
  const dv = dq.sub(rimW);
  const onCloth = dv.greaterThan(0).select(float(1), float(0));
  const midSigned = xPanel.select(q.y.sub(centre.y), q.x.sub(centre.x));
  const gw = max(unit.mul(0.06), wpp);
  const creaseOf = (sd) => exp(sd.div(gw).pow(2).negate());
  const foldOf = (sd) => exp(sd.abs().sub(gw.mul(2.2)).div(gw.mul(1.4)).pow(2).negate());
  const cornerAmt = inCorner.mul(u.seams.x);
  const midAmt = onCloth.mul(u.panel.y);
  const crease = max(creaseOf(seamSigned).mul(cornerAmt), creaseOf(midSigned).mul(midAmt));
  const fold = max(foldOf(seamSigned).mul(cornerAmt), foldOf(midSigned).mul(midAmt));
  feltLum = feltLum.mul(float(1).sub(crease.mul(0.6))).add(fold.mul(0.12));

  // PANEL BUMP. Each panel is padded: the cloth is pulled down into every boundary — corner
  // seam, middle line, the rim, the table's edge — and rises to a gentle crown between them.
  const rayT = max(dot(ov, seamDir), float(0));
  const toCornerSeam = length(ov.sub(seamDir.mul(rayT)));
  const nearest = min(
    min(dv, toCornerSeam),
    min(midSigned.abs().add(u.panel.y.lessThan(0.01).select(float(1e9), float(0))), dOut.negate())
  ).max(0);
  const pillow = smoothstep(float(0), u.panel.w, nearest);
  // The crown faces the lamp, the dip faces away: a soft lift in, a darker trough at the seams.
  feltLum = feltLum.mul(
    mix(float(1).sub(u.panel.z.mul(0.5)), float(1).add(u.panel.z.mul(0.12)), pillow.mul(pillow.mul(-1).add(2)))
  );

  // STITCHES — a thread with a dark outline (the cloth pulled into each stitch hole).
  const stitchFade = smoothstep(float(1.2), float(3), gw.div(wpp));
  const stitchGap = unit.mul(0.3).mul(u.stitch.y);
  const threadW = gw.mul(0.45).mul(u.stitch.z);
  const dashOf = (a, grow) => {
    const f = fract(a.div(stitchGap)).sub(0.5).abs();
    const half = u.stitch.x.mul(0.5).add(grow);
    return float(1).sub(smoothstep(half.sub(0.06), half, f));
  };
  const threadOf = (dist, a, grow, wMul) => exp(dist.div(threadW.mul(wMul)).pow(2).negate()).mul(dashOf(a, grow));
  const inset = gw.mul(4.5).mul(u.panel.x);
  const lines = (grow, wMul) =>
    max(
      max(
        threadOf(seamSigned.abs().sub(inset), seamAlong, grow, wMul).mul(inCorner),
        threadOf(midSigned.abs().sub(inset), dv, grow, wMul).mul(midAmt.greaterThan(0).select(float(1), float(0)))
      ),
      threadOf(dv.sub(unit.mul(0.35).mul(u.panel.x)), xRail.select(q.y, q.x), grow, wMul)
    )
      .mul(u.seams.y)
      .mul(stitchFade);
  const stitch = lines(float(0), float(1));
  const stitchShadow = lines(float(0.07), float(2.1));
  // Velvet AO: the border stands proud of the cloth, so the cloth is darkest hard against it.
  const rimShadow = float(1).sub(exp(dv.max(0).div(u.ao.z).negate()).mul(u.ao.y));
  const feltLight = lampAt(q).mul(rimShadow);
  let feltRgb = u.feltColor.mul(u.lampColor).mul(feltLum.max(0)).mul(feltLight);
  feltRgb = feltRgb.mul(float(1).sub(stitchShadow.clamp(0, 1).mul(u.stitch.w).mul(0.85)));
  feltRgb = mix(feltRgb, u.stitchColor.mul(u.lampColor).mul(feltLight), stitch.clamp(0, 1).mul(0.9));

  const onRim = float(1).sub(smoothstep(rimW.sub(aa), rimW.add(aa), dq));
  const railRgb = mix(feltRgb, rimRgb, onRim);

  // ── the finished outer edge, and the void ──────────────────────────────────
  // The velvet ends at the padded canvas. Past it a rounded brass bead (the same half-round
  // profile as the rim, catching the same lamp) closes the table off, then nothing: black.
  const et = dOut.div(edgeW).clamp(0, 1);
  const eAcross = et.mul(2).sub(1).mul(0.95);
  const eUp = sqrt(max(float(1).sub(eAcross.mul(eAcross)), float(0.02)));
  const eOut = oEdge.x
    .greaterThan(oEdge.y)
    .select(vec2(q.x.sub(centre.x).sign(), 0), vec2(0, q.y.sub(centre.y).sign()));
  const eN = normalize(vec3(eOut.mul(eAcross), eUp));
  const ePos = vec3(q, depth);
  const eV = normalize(eyePos.sub(ePos));
  const eL = normalize(lampPos.sub(ePos));
  const eR = eV.negate().reflect(eN);
  const eSpec = pow(max(dot(eR, eL), float(0)), float(90)).mul(u.rim.y);
  const eEnv = mix(float(0.05), float(0.45), smoothstep(float(-0.1), float(0.95), eR.z));
  const lampEdge = lampAt(q.clamp(oMin, oMax));
  const edgeRgb = u.rimColor
    .mul(eEnv.mul(0.9).add(max(dot(eN, eL), float(0)).mul(0.2)))
    .add(u.rimColor.mul(u.lampColor).mul(eSpec))
    .mul(lampEdge)
    // Brass AO again: the bead's flanks, and its inner foot where it meets the cloth.
    .mul(
      float(1)
        .sub(float(1).sub(eUp).mul(max(u.look.x, u.ao.y)).mul(0.85))
        .sub(
          float(1)
            .sub(smoothstep(float(0), float(0.3), et))
            .mul(u.ao.y)
            .mul(0.5)
        )
        .max(0.05)
    );
  const onEdge = smoothstep(aa.negate(), aa, dOut);
  const inVoid = smoothstep(edgeW.sub(aa), edgeW.add(aa), dOut);
  const topRgb = mix(mix(railRgb, edgeRgb, onEdge), vec3(0, 0, 0), inVoid);

  // ── the recess wall ──────────────────────────────────────────────────────
  // Same crossing test as the model: the smaller of the per-axis fractions
  // from the table plane (q) down to the board (p) is the wall actually hit.
  const sAxis = (qv, pv, lo, hi) => {
    const den = pv.sub(qv);
    const safe = den.abs().max(1e-3).mul(den.sign().add(0.5).sign());
    return pv.greaterThan(hi).select(hi.sub(qv).div(safe), pv.lessThan(lo).select(lo.sub(qv).div(safe), float(1e6)));
  };
  const sx = sAxis(q.x, tr.w.x, rMin.x, rMax.x);
  const sy = sAxis(q.y, tr.w.y, rMin.y, rMax.y);
  const s = min(sx, sy).clamp(0, 1);
  const z01 = float(1).sub(s);
  const hitX = sx.lessThanEqual(sy);
  const wallAlong = hitX.select(q.y.add(tr.w.y.sub(q.y).mul(s)), q.x.add(tr.w.x.sub(q.x).mul(s)));
  // A brass lip the depth of the rim's bead, then dark polished walnut down to the board.
  // The brass lip is a fixed fifth of the table-top height however deep the recess is dug.
  const wallTotal = depth.add(u.ao.w);
  const lipZ = float(1).sub(depth.mul(0.2).div(wallTotal.max(1e-3)));
  const lip = smoothstep(lipZ.sub(0.02), lipZ.add(0.02), z01);
  const grain = vnoise(vec2(wallAlong.div(unit.mul(2)), z01.mul(wallTotal).div(unit.mul(0.15))))
    .mul(0.5)
    .add(0.75);
  const wood = vec3(0.045, 0.018, 0.008).mul(grain);
  const wallLight = lampAt(q).mul(mix(float(0.25), float(1), z01.mul(z01)));
  const wallRgb = mix(wood, u.rimColor.mul(0.55), lip).mul(u.lampColor).mul(wallLight);

  const onTable = smoothstep(aa.negate(), aa, dq);
  const rgb = mix(wallRgb, topRgb, onTable);

  const boardShade = float(1).sub(buildBoardOcclusion(TSL, tr, u));
  return { rgb, boardShade };
}

/**
 * The board's contact shadow under the brass: 0 (none) to the card's strength, hard against the
 * border. Cheap arithmetic on the trace, so the shadow steps (`buildTableShadeStepMaterial`) can
 * redo it without the table's shading.
 * @param {*} TSL
 * @param {ReturnType<typeof buildTableTrace>} tr
 * @param {ReturnType<typeof createTableUniforms>} u
 */
export function buildBoardOcclusion(TSL, tr, u) {
  const { float, mix, smoothstep, pow, max } = TSL;
  const inside = tr.dp.negate().max(0);
  const fall = float(1).sub(smoothstep(float(0), u.look.y, inside));
  // Softness picks the falloff curve: fall^3 hugs the border (a crease), fall^1 is a wide haze.
  // Two layers — a tight core and a broad skirt — so even a crease has a soft edge.
  const curve = mix(float(3), float(1), u.ao.x);
  const core = pow(fall, curve);
  const skirt = fall.mul(fall);
  // On the board, and across the overhang while parallax has layers riding out over it (`u.shade.y`, 1
  // then): there the crease's full depth carries on to the brass, so a canopy that crosses the board's
  // edge keeps one even shadow instead of a seam where the shadow stopped. Elsewhere past the edge
  // (where the overlay may still draw the lip) there is no crease.
  const onBoard = tr.dp.lessThanEqual(float(0)).select(float(1), float(0));
  const reach = max(onBoard, tr.overhang.select(u.shade.y, float(0)));
  return core.mul(0.65).add(skirt.mul(0.35)).mul(u.look.x).mul(reach);
}

/**
 * ONE STEP OF THE BOARD SHADOW, drawn between two bands of layers (`parallax-model.js#edgeShadeLadder`).
 * It hands the layers drawn after it from share `from` of the shadow down to share `to`: with `occ` the
 * full shadow, it darkens by `(1 − occ·from)/(1 − occ·to)`, so with the steps after it and the
 * overlay's own `occ·last` the darkening multiplies out to exactly `1 − occ·from`.
 * Blended black like the overlay, early-discarded outside the shadow's band, deferrable.
 * @param {*} THREE
 * @param {ReturnType<typeof createTableUniforms>} u
 * @param {*} step - its own `uniform(vec2(from, to))`.
 * @param {(m:*, why:string) => *} markDeferrable
 */
export function buildTableShadeStepMaterial(THREE, u, step, markDeferrable) {
  const TSL = THREE.TSL;
  const { Fn, If, vec4, float, positionWorld, mrt } = TSL;
  const m = new THREE.NodeMaterial();
  m.side = THREE.DoubleSide;
  m.transparent = true;
  m.depthTest = false;
  m.depthWrite = false;
  const live = (tr) => tr.dp.lessThanEqual(float(0)).and(tr.dp.negate().lessThan(u.look.y)).or(tr.overhang);
  m.maskNode = live(buildTableTrace(TSL, { worldXY: positionWorld.xy, u }));
  m.colorNode = Fn(() => {
    const out = vec4(0, 0, 0, 0).toVar();
    const tr = buildTableTrace(TSL, { worldXY: positionWorld.xy, u });
    If(live(tr), () => {
      const occ = buildBoardOcclusion(TSL, tr, u);
      const keep = float(1)
        .sub(occ.mul(step.x))
        .div(float(1).sub(occ.mul(step.y)).max(1e-3));
      out.assign(vec4(0, 0, 0, float(1).sub(keep).clamp(0, 1)));
    });
    return out;
  })();
  m.mrtNode = mrt({ attr: vec4(0, 0, 0, 0) });
  markDeferrable(m, 'table shade step');
  return m;
}

/**
 * The two world-pass materials. Both carry `markCompileDeferrable` (they are
 * redrawn every frame: they may appear a few frames late, never block the GPU
 * process — `src/GPU-SAFETY.md`).
 *
 * @param {*} THREE - the three namespace (for `NodeMaterial` and blend constants).
 * @param {ReturnType<typeof createTableUniforms>} u
 * @param {(m:*, why:string) => *} markDeferrable - `core/compile-policy.js#markCompileDeferrable`, injected.
 * @returns {{floor:*, overlay:*}}
 */
export function buildTableMaterials(THREE, u, markDeferrable) {
  const TSL = THREE.TSL;
  const { Fn, If, vec4, float, positionWorld, mrt } = TSL;

  // ⚠️ `colorNode` + `maskNode`, NEVER `fragmentNode` (found live 2026-10-27). The world pass
  // draws into TWO colour targets (`output` + the scene-attr buffer, `vt/scene-attr.js`), and
  // three only routes a material through that MRT when it builds the output itself from
  // `colorNode`. A raw `fragmentNode` writes attachment 0 alone and WebGPU rejects the pipeline
  // ("Color target has no corresponding fragment stage output … targets[1]") — nothing draws.
  // `maskNode` is three's own early discard (`NodeMaterial#setupDiffuseColor` runs it first).

  // DoubleSide: the viewer's camera is Y-down (`top: minY, bottom: maxY`), which
  // mirrors the winding order — a one-sided plane would be culled as a back face.
  const floor = new THREE.NodeMaterial();
  floor.side = THREE.DoubleSide;
  floor.depthTest = false;
  floor.depthWrite = false;
  // Board pixels are drawn by the art. Opaque + discard, not blended, so the floor
  // always sorts before every token and tile however they are blended. The padding has
  // no floor attributes, so the renderer's zero `attr` default is right here.
  floor.maskNode = buildTableTrace(TSL, { worldXY: positionWorld.xy, u }).floorLive;
  floor.colorNode = Fn(() => {
    const out = vec4(0, 0, 0, 1).toVar();
    const tr = buildTableTrace(TSL, { worldXY: positionWorld.xy, u });
    If(tr.floorLive, () => {
      out.assign(vec4(buildTableShading(TSL, tr, u).rgb, 1));
    });
    return out;
  })();
  markDeferrable(floor, 'table floor');

  const overlay = new THREE.NodeMaterial();
  overlay.side = THREE.DoubleSide;
  overlay.transparent = true;
  overlay.depthTest = false;
  overlay.depthWrite = false;
  overlay.maskNode = buildTableTrace(TSL, { worldXY: positionWorld.xy, u }).overlayLive;
  overlay.colorNode = Fn(() => {
    const out = vec4(0, 0, 0, 0).toVar();
    const tr = buildTableTrace(TSL, { worldXY: positionWorld.xy, u });
    If(tr.overlayLive, () => {
      const sh = buildTableShading(TSL, tr, u);
      // The share of the shadow the layers drawn last keep (all of it unless Parallax raised them).
      const shadowA = float(1).sub(sh.boardShade).mul(u.shade.x);
      const a = tr.lipCover.add(float(1).sub(tr.lipCover).mul(shadowA));
      // Straight-alpha blend: the lip's colour where it covers, black where only the shadow does.
      out.assign(vec4(sh.rgb.mul(tr.lipCover).div(a.max(1e-4)), a));
    });
    return out;
  })();
  // Alpha 0 in `attr`: the blend leaves the board's own floor attributes untouched under the
  // lip and the shadow (the same reasoning as water's in-scatter, `water-render.js`).
  overlay.mrtNode = mrt({ attr: vec4(0, 0, 0, 0) });
  markDeferrable(overlay, 'table overlay');
  return { floor, overlay };
}
