/**
 * table.test.mjs — the declaration validates, and the ray model behaves like a
 * real recess: the board is never moved, the wall shows on the side away from
 * the eye, and the lip covers the board's edge once the eye is past it.
 */
import { validateEffectManifest } from '../../effect-manifest.js';
import { validateParamsSchema } from '../../../core/params-schema.js';
import { TABLE, TABLE_PARAMS } from '../table.js';
import {
  tableEyeHeight,
  rectDistance,
  traceTablePixel,
  floorPoint,
  resolveTableFrame,
  srgbHexToLinear,
} from '../table-model.js';
import { sceneEyeHeight } from '../../../scene/index.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;

  ok('manifest validates', validateEffectManifest(TABLE).ok === true);
  ok('params schema validates', validateParamsSchema(TABLE_PARAMS).ok === true);
  ok('its card is titled Table', TABLE.title === 'Table');
  ok('opt-in: on by default only at the extreme profile', TABLE.enabledFromProfile === 'extreme');
  ok('the table is private by default', TABLE_PARAMS.privateOffBoard.default === true);

  // The eye frames the view: at 90° the eye height equals the half-span.
  ok('eye height at 90° = half-span', near(tableEyeHeight(500, 90), 500, 1e-6));
  ok('narrower FOV ⇒ higher eye', tableEyeHeight(500, 20) > tableEyeHeight(500, 60));
  ok('zooming in lowers the eye', tableEyeHeight(200, 40) < tableEyeHeight(800, 40));
  ok(
    '⭐ the Table’s eye IS the scene eye',
    tableEyeHeight(600, 45) === sceneEyeHeight(600, 45) && tableEyeHeight(350, 30) === sceneEyeHeight(350, 30)
  );

  const rect = { minX: 1000, minY: 1000, maxX: 5000, maxY: 4000 };
  ok('rect distance: inside is negative', rectDistance(3000, 2500, rect) < 0);
  ok('rect distance: outside is the larger overhang', rectDistance(900, 950, rect) === 100);

  const eyeH = 4000;
  const depth = 80;
  const rimW = 50;
  const centre = { x: 3000, y: 2500 };

  // Straight below the eye nothing moves.
  const under = traceTablePixel({ x: 3000, y: 2500 }, centre, eyeH, depth, rect, rimW);
  ok('⭐ the board under the eye is board', under.kind === 'board');
  ok('the board point is untouched by the trace', near(under.q.x, 3000) && near(under.q.y, 2500));

  // Just outside the left edge, eye over the middle: the ray drops past the
  // table top (q is pulled toward the eye, back inside) and hits the wall.
  const justOut = traceTablePixel({ x: 995, y: 2500 }, centre, eyeH, depth, rect, rimW);
  ok('⭐ the wall shows on the side away from the eye', justOut.kind === 'wall');
  ok('the wall hit is on the x wall', justOut.wallAxis === 'x');
  ok('the wall hit lies between floor and top', justOut.wallZ01 > 0 && justOut.wallZ01 < 1);

  // How wide is that wall band? From p = minX out to where q reaches minX.
  const k = (eyeH - depth) / eyeH;
  const wallOuter = centre.x + (rect.minX - centre.x) / k;
  ok('the wall band is where theory puts it', wallOuter < rect.minX);
  const pastWall = traceTablePixel({ x: wallOuter - 2, y: 2500 }, centre, eyeH, depth, rect, rimW);
  ok('beyond the wall band is the rim', pastWall.kind === 'rim');
  const farOut = traceTablePixel({ x: 400, y: 2500 }, centre, eyeH, depth, rect, rimW);
  ok('far out is velvet', farOut.kind === 'velvet');

  // The eye past the left edge: the lip now overhangs the board.
  const eyeOut = { x: 600, y: 2500 };
  const lipOver = traceTablePixel({ x: 1003, y: 2500 }, eyeOut, eyeH, depth, rect, rimW);
  ok('⭐ eye past the edge ⇒ the lip covers the board edge', lipOver.kind === 'rim');
  const farIn = traceTablePixel({ x: 1100, y: 2500 }, eyeOut, eyeH, depth, rect, rimW);
  ok('…but only a sliver of it', farIn.kind === 'board');

  // The outer edge: the velvet ends at the padded canvas, a finished band follows, then the void.
  const outer = { minX: 0, minY: 0, maxX: 6000, maxY: 5000 };
  const atEdge = (x) => traceTablePixel({ x, y: 2500 }, { x: 3000, y: 2500 }, eyeH, depth, rect, rimW, outer, 40).kind;
  ok('inside the canvas the velvet is unchanged', atEdge(400) === 'velvet');
  ok('⭐ just past the canvas edge is the finished edge band', atEdge(-70) === 'edge');
  ok('⭐ beyond the band is the void', atEdge(-200) === 'void');
  ok(
    'no outer rect ⇒ velvet runs on as before',
    traceTablePixel({ x: -200, y: 2500 }, centre, eyeH, depth, rect, rimW).kind === 'velvet'
  );

  // Flush board (depth 0): no wall anywhere, rim starts exactly at the edge.
  const flushIn = traceTablePixel({ x: 1000.5, y: 2500 }, centre, eyeH, 0, rect, rimW);
  const flushOut = traceTablePixel({ x: 999.5, y: 2500 }, centre, eyeH, 0, rect, rimW);
  ok('depth 0: inside the edge is board', flushIn.kind === 'board');
  ok('depth 0: outside the edge is rim', flushOut.kind === 'rim');

  // Frame resolution: board percentages become px; colours go linear.
  const ctx = { boardMinSidePx: 3000, halfSpanPx: 1000, eye: centre };
  const f = resolveTableFrame({}, ctx);
  ok('rim width is a share of the board', near(f.rimW, (TABLE_PARAMS.rimPct.default / 100) * 3000));
  ok('depth is a share of the board', near(f.eye[3], (TABLE_PARAMS.depthPct.default / 100) * 3000));
  const deep = resolveTableFrame({ depthPct: 10 }, { ...ctx, boardMinSidePx: 1e6, halfSpanPx: 10 });
  ok('depth is capped below the eye', deep.eye[3] <= deep.eye[2] * 0.5);
  ok(
    'sRGB white is linear 1',
    srgbHexToLinear('#ffffff').every((c) => near(c, 1))
  );
  const ao = resolveTableFrame({ edgeShadowSoft: 2, velvetAoPct: 1 }, ctx).ao;
  ok('AO softness is clamped to 0..1', ao[0] === 1);
  ok('velvet AO width is a share of the board', near(ao[2], 0.01 * 3000));
  ok(
    'AO controls all live in one card section',
    ['edgeShadow', 'edgeShadowPct', 'edgeShadowSoft', 'velvetAo', 'velvetAoPct'].every(
      (k) => TABLE_PARAMS[k].category === 'Ambient occlusion'
    )
  );
  // The look that ships is the one running on the Oracle server (author, 2026-10-28: "The values on the
  // oracle server win"). An earlier draft of this record carried a few dial values that were never
  // applied (depthPct 2, edgeShadowPct 10, edgePct 1.15, rimPolish 0.35); the live ones are below.
  const tuned = {
    depthPct: 1,
    edgeShadow: 1,
    edgeShadowPct: 5,
    velvetAo: 0.61,
    velvetAoPct: 3.6,
    rimPct: 2.65,
    edgePct: 0.2,
    rimShine: 1.7,
    rimPolish: 0.2,
    feltNapSize: 9,
    feltMottle: 0.79,
    feltSheen: 0.84,
    stitching: 1,
    lampStrength: 0.35,
    cornerDark: 0.74,
    roomDark: 1,
  };
  ok(
    '⭐ the author-tuned defaults ship',
    Object.entries(tuned).every(([k, v]) => TABLE_PARAMS[k].default === v)
  );
  const st = resolveTableFrame({ stitchLength: 2, stitchSpacing: 0 }, ctx);
  ok('stitch length and spacing are clamped to something drawable', st.stitch[0] <= 0.95 && st.stitch[1] > 0);
  ok(
    'the panel bump width is a share of the board',
    near(st.panel[3], (TABLE_PARAMS.panelBumpPct.default / 100) * 3000)
  );
  ok(
    'stitches have their own card section',
    ['stitchColor', 'stitchLength', 'stitchSpacing', 'stitchWidth', 'stitchOutline', 'stitchInset'].every(
      (k) => TABLE_PARAMS[k].category === 'Stitches'
    )
  );
  ok('sRGB mid-grey is ~0.216 linear', near(srgbHexToLinear('#808080')[0], 0.2158605, 1e-5));

  // ── a recess dug deeper than the board (the parallax stack) ───────────────
  const fCtx = { boardMinSidePx: 3000, halfSpanPx: 600, eye: { x: 3000, y: 2500 } };
  const base = resolveTableFrame(null, fCtx);
  ok('no stack: no floor depth, and the original table top', base.floorDepth === 0);
  const stack = resolveTableFrame(null, { ...fCtx, topHeightPx: 120, floorDepthPx: 90 });
  ok(
    '⭐ a taller stack raises the table top above the base recess',
    stack.eye[3] === 120 && stack.eye[3] > base.eye[3]
  );
  ok('the recess floor is dug to the lowest floor', stack.floorDepth === 90);
  ok(
    'a small stack never lowers the base recess',
    resolveTableFrame(null, { ...fCtx, topHeightPx: 1 }).eye[3] === base.eye[3]
  );
  ok(
    'the stack is capped by the eye height',
    resolveTableFrame(null, { ...fCtx, topHeightPx: 1e9, floorDepthPx: 1e9 }).eye[3] <=
      stack.eye[0] * 0 + base.eye[2] * 0.5
  );

  const fp = floorPoint({ x: 3400, y: 2500 }, { x: 3000, y: 2500 }, 4000, 400);
  ok('the floor point is further along the ray', near(fp.x, 3000 + 400 * 1.1) && fp.y === 2500);
  ok(
    'no depth: the floor point is the pixel',
    floorPoint({ x: 3400, y: 2100 }, { x: 3000, y: 2500 }, 4000, 0).x === 3400
  );

  const rect2 = { minX: 1000, minY: 1000, maxX: 5000, maxY: 4000 };
  const eyeC = { x: 3000, y: 2500 };
  // A pixel just inside the board's edge: board on a flat recess, wall once the floor is dug deep
  // (the ray reaches the floor outside the rect, so it is the wall the eye sees).
  const edgePx = { x: 4950, y: 2500 };
  ok('flat recess: just inside the edge is board', traceTablePixel(edgePx, eyeC, 4000, 80, rect2, 50).kind === 'board');
  const dugDeep = traceTablePixel(edgePx, eyeC, 4000, 80, rect2, 50, null, 0, 600);
  ok('⭐ a deep recess shows its wall where the floor is out of reach', dugDeep.kind === 'wall');
  ok('the wall is hit between the top and the floor', dugDeep.wallZ01 > 0 && dugDeep.wallZ01 < 1);
  ok(
    'under the eye it is still floor however deep',
    traceTablePixel(eyeC, eyeC, 4000, 80, rect2, 50, null, 0, 600).kind === 'board'
  );
  ok(
    'the table top is unchanged by the depth',
    traceTablePixel({ x: 800, y: 2500 }, eyeC, 4000, 80, rect2, 50, null, 0, 600).kind === 'velvet'
  );
}
