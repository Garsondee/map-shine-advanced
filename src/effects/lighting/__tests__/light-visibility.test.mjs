/**
 * Node verification for effects/lighting/light-visibility.js — the pure core of
 * the shadow half (`light.visibility`).
 *
 * Everything here is pure and Node-tested. There is NO TSL material build in
 * this module on purpose: the GPU producer that fills `buf:scene.vis` and the
 * frame-loop multiply are browser-only and must be verified LIVE with the pixel
 * probe (a world→screen mask sample is the Y-flip class — memory:
 * feedback_y_flip_recurring_risk), so the pass stays a seam until then. What a
 * Node test CAN pin — the model, the doctrine invariant, and the projection
 * CONVENTION (every quadrant) — is pinned here.
 */
import {
  SUN_VISIBILITY_LIT,
  SUN_VISIBILITY_SHADOW,
  DEFAULT_WORKSPACE_LIGHT,
  clamp01,
  combineVisibility,
  authoredShadowVisibility,
  composeSunTermWithMaxLight,
  shadowOffsetDirection,
  projectShadowOffset,
  shadowPenumbraPx,
  projectOccluderShadow,
  mapWindowRectToStamp,
  MAX_UI_SHADOW_STAMPS,
} from '../light-visibility.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // combineVisibility — min-combine, absence = fully lit
  // ======================================================================
  ok('no producers → fully lit (1)', near(combineVisibility(), SUN_VISIBILITY_LIT));
  ok('empty list → fully lit (1)', near(combineVisibility([]), SUN_VISIBILITY_LIT));
  ok('the darkest producer wins (min)', near(combineVisibility([1, 0.3, 0.8]), 0.3));
  ok('a full-shadow producer drives it to 0', near(combineVisibility([0.9, 0]), SUN_VISIBILITY_SHADOW));
  ok('null/undefined entries are skipped, NOT read as 0', near(combineVisibility([0.5, null, undefined]), 0.5));
  ok('a non-finite reading never manufactures shadow', near(combineVisibility([0.5, NaN, Infinity]), 0.5));
  ok('all-absent (only nullish) → fully lit', near(combineVisibility([null, undefined]), SUN_VISIBILITY_LIT));
  ok('out-of-range entries clamp into [0,1]', near(combineVisibility([1.4, 0.6]), 0.6));
  ok('a negative entry clamps to 0 (full shadow)', near(combineVisibility([0.9, -0.2]), 0));

  // ======================================================================
  // authoredShadowVisibility — the `_Shadow` mask semantic (absent = lit)
  // ======================================================================
  ok('white mask = lit (1)', near(authoredShadowVisibility(1), SUN_VISIBILITY_LIT));
  ok('black mask = shadow (0)', near(authoredShadowVisibility(0), SUN_VISIBILITY_SHADOW));
  ok('grey mask passes through', near(authoredShadowVisibility(0.42), 0.42));
  ok('ABSENT (null) mask = fully lit, not 0 — the catalog owns absence', near(authoredShadowVisibility(null), 1));
  ok('undefined mask = fully lit', near(authoredShadowVisibility(undefined), 1));
  ok('non-finite mask = fully lit, never NaN downstream', near(authoredShadowVisibility(NaN), 1));

  // ======================================================================
  // composeSunTermWithMaxLight — THE DOCTRINE INVARIANT (no lift needed)
  //
  // illum = max(ambient × sunVisibility, maxLight). A torch at least as bright
  // as the un-shadowed ambient makes the sun's painted shadow irrelevant — the
  // result is the torch, whatever the visibility was. This is Light-and-
  // Shadow.md §1 steps 3–4 as a scalar: shadow gated the SUN's own light and
  // nothing else, so the torch was never darkened and no lift can be needed.
  // ======================================================================
  {
    const ambient = 0.9;
    const deepShadow = 0.1; // sun 90% blocked here
    // No local light: the shadow darkens the sun term as expected.
    ok('full sun (vis 1), no light → ambient unchanged', near(composeSunTermWithMaxLight(ambient, 1, 0), ambient));
    ok(
      'painted shadow, no light → ambient × visibility (darkened)',
      near(composeSunTermWithMaxLight(ambient, deepShadow, 0), ambient * deepShadow)
    );
    // A torch as bright as the un-shadowed ambient: the shadow becomes a no-op
    // at that pixel WITHOUT any override machinery — the whole point.
    ok(
      'a torch ≥ ambient fully lights a shadowed pixel — NO lift',
      near(composeSunTermWithMaxLight(ambient, deepShadow, ambient), ambient)
    );
    // And the shadow value genuinely did not participate: same result for any
    // visibility once the torch dominates.
    ok(
      'the torch result is independent of how dark the sun shadow was',
      near(composeSunTermWithMaxLight(ambient, 0.01, ambient), composeSunTermWithMaxLight(ambient, 0.99, ambient))
    );
    // A dim torch below the shadowed sun term does not reduce it (MAX, not add/replace).
    ok(
      'a dim light below the shadowed sun term leaves it alone (MAX)',
      near(composeSunTermWithMaxLight(ambient, 0.5, 0.2), ambient * 0.5)
    );
    ok('non-finite ambient reads as 0, never NaN', near(composeSunTermWithMaxLight(NaN, 1, 0), 0));
  }

  // ======================================================================
  // shadowOffsetDirection — the screen-space convention, every quadrant
  // (+x right, +y DOWN; azimuth compass cw from up; shadow falls away from light)
  // ======================================================================
  {
    const nDir = shadowOffsetDirection(0); // light from north(up) → shadow south(down)
    ok('light N (az 0) → shadow points DOWN (+y)', near(nDir.x, 0) && near(nDir.y, 1));
    const eDir = shadowOffsetDirection(90); // light from east(right) → shadow west(left)
    ok('light E (az 90) → shadow points LEFT (−x)', near(eDir.x, -1) && near(eDir.y, 0));
    const sDir = shadowOffsetDirection(180); // light from south(down) → shadow north(up)
    ok('light S (az 180) → shadow points UP (−y)', near(sDir.x, 0) && near(sDir.y, -1));
    const wDir = shadowOffsetDirection(270); // light from west(left) → shadow east(right)
    ok('light W (az 270) → shadow points RIGHT (+x)', near(wDir.x, 1) && near(wDir.y, 0));
    const nw = shadowOffsetDirection(315); // the default workspace light (upper-left) → SE shadow
    ok('light NW (az 315) → shadow points down-right (SE)', nw.x > 0 && nw.y > 0);
    ok('every direction is a unit vector', near(Math.hypot(nw.x, nw.y), 1));
  }

  // ======================================================================
  // projectShadowOffset — length physics: overhead = 0, grazing = clamped, monotonic
  // ======================================================================
  {
    const overhead = projectShadowOffset({ azimuthDeg: 315, elevationDeg: 90, heightPx: 30 });
    ok('overhead light (elev 90) casts a zero-length shadow', near(overhead.length, 0));

    const mid = projectShadowOffset({ azimuthDeg: 315, elevationDeg: 45, heightPx: 30 });
    ok('elev 45 casts offset = height (tan45 = 1)', near(mid.length, 30));

    // Monotonic: as the light lowers from 90° toward the horizon, the offset grows.
    let prev = -1;
    let monotonic = true;
    for (const e of [90, 75, 60, 45, 30, 15, 5]) {
      const len = projectShadowOffset({ azimuthDeg: 315, elevationDeg: e, heightPx: 30 }).length;
      if (len < prev - 1e-9) monotonic = false;
      prev = len;
    }
    ok('offset length grows monotonically as the light lowers', monotonic);

    const grazing = projectShadowOffset({ azimuthDeg: 315, elevationDeg: 0.5, heightPx: 30, maxOffsetPx: 200 });
    ok(
      'a grazing light saturates at maxOffsetPx, never Infinity',
      grazing.length === 200 && Number.isFinite(grazing.length)
    );

    const zeroH = projectShadowOffset({ azimuthDeg: 315, elevationDeg: 45, heightPx: 0 });
    ok('a flush occluder (height 0) casts no offset', near(zeroH.length, 0));

    // The offset vector agrees with the direction convention (NW light → SE offset).
    ok('offset vector points SE for the NW workspace light', mid.x > 0 && mid.y > 0);
  }

  // ======================================================================
  // offsetScale — the cosmetic "x5" multiplier (author-requested 2026-07-20 v4),
  // independent of heightPx/penumbra
  // ======================================================================
  {
    const base = projectShadowOffset({ azimuthDeg: 315, elevationDeg: 45, heightPx: 30 }); // scale defaults to 1
    const scaled5 = projectShadowOffset({ azimuthDeg: 315, elevationDeg: 45, heightPx: 30, offsetScale: 5 });
    ok('offsetScale=5 makes the offset exactly 5x the unscaled length', near(scaled5.length, base.length * 5));
    ok('the x5 case is the concrete number the author asked for', near(scaled5.length, 150));

    const clamped = projectShadowOffset({
      azimuthDeg: 315,
      elevationDeg: 45,
      heightPx: 30,
      offsetScale: 5,
      maxOffsetPx: 50,
    });
    ok('offsetScale still respects maxOffsetPx (applied AFTER scaling)', clamped.length === 50);

    const negScale = projectShadowOffset({ azimuthDeg: 315, elevationDeg: 45, heightPx: 30, offsetScale: -3 });
    ok('a non-positive offsetScale falls back to 1x, never inverts', near(negScale.length, base.length));
    const nanScale = projectShadowOffset({ azimuthDeg: 315, elevationDeg: 45, heightPx: 30, offsetScale: NaN });
    ok('a non-finite offsetScale falls back to 1x', near(nanScale.length, base.length));

    // projectOccluderShadow / mapWindowRectToStamp default to the WORKSPACE
    // LIGHT's own offsetScale (5) when the caller doesn't override it — so the
    // live default is genuinely 5x, not just an available knob nobody sets.
    const stampDefault = projectOccluderShadow({
      rect: { x: 0, y: 0, w: 10, h: 10 },
      azimuthDeg: DEFAULT_WORKSPACE_LIGHT.azimuthDeg,
      elevationDeg: DEFAULT_WORKSPACE_LIGHT.elevationDeg,
      heightPx: DEFAULT_WORKSPACE_LIGHT.heightPx,
    });
    const unscaledOnly = projectShadowOffset({
      azimuthDeg: DEFAULT_WORKSPACE_LIGHT.azimuthDeg,
      elevationDeg: DEFAULT_WORKSPACE_LIGHT.elevationDeg,
      heightPx: DEFAULT_WORKSPACE_LIGHT.heightPx,
    });
    ok(
      'projectOccluderShadow defaults to DEFAULT_WORKSPACE_LIGHT.offsetScale (5x) when omitted',
      near(
        Math.hypot(stampDefault.offsetX, stampDefault.offsetY),
        unscaledOnly.length * DEFAULT_WORKSPACE_LIGHT.offsetScale
      )
    );
  }

  // ======================================================================
  // shadowPenumbraPx — softer when higher and when the light grazes; ≥ base
  // ======================================================================
  {
    const base = 6;
    const overhead = shadowPenumbraPx({ heightPx: 30, elevationDeg: 90, baseSoftnessPx: base });
    const grazing = shadowPenumbraPx({ heightPx: 30, elevationDeg: 10, baseSoftnessPx: base });
    ok('penumbra is never below the base feather', overhead >= base - 1e-9);
    ok('a grazing light softens the shadow more than an overhead one', grazing > overhead);

    const low = shadowPenumbraPx({ heightPx: 10, elevationDeg: 55, baseSoftnessPx: base });
    const high = shadowPenumbraPx({ heightPx: 60, elevationDeg: 55, baseSoftnessPx: base });
    ok('a higher-floating occluder casts a softer shadow', high > low);

    const flush = shadowPenumbraPx({ heightPx: 0, elevationDeg: 90, baseSoftnessPx: base });
    ok('a flush overhead occluder keeps exactly the base feather', near(flush, base));
  }

  // ======================================================================
  // projectOccluderShadow — the full UI-window stamp
  // ======================================================================
  {
    const rect = { x: 100, y: 200, w: 320, h: 480 };
    const stamp = projectOccluderShadow({
      rect,
      azimuthDeg: DEFAULT_WORKSPACE_LIGHT.azimuthDeg,
      elevationDeg: DEFAULT_WORKSPACE_LIGHT.elevationDeg,
      heightPx: DEFAULT_WORKSPACE_LIGHT.heightPx,
      strength01: DEFAULT_WORKSPACE_LIGHT.strength01,
    });
    ok('stamp preserves the occluder size', stamp.w === rect.w && stamp.h === rect.h);
    ok('stamp is the rect translated by the projected offset (x)', near(stamp.x, rect.x + stamp.offsetX));
    ok('stamp is the rect translated by the projected offset (y)', near(stamp.y, rect.y + stamp.offsetY));
    ok('the NW workspace light throws the stamp down-right (SE)', stamp.offsetX > 0 && stamp.offsetY > 0);
    ok('stamp carries a positive penumbra', stamp.penumbraPx > 0);
    ok('stamp strength is clamped into [0,1]', stamp.strength01 >= 0 && stamp.strength01 <= 1);

    // Over-bright strength clamps; a missing rect degrades to a zero-size stamp, not a throw.
    const clampedStrength = projectOccluderShadow({
      rect,
      azimuthDeg: 315,
      elevationDeg: 55,
      heightPx: 26,
      strength01: 5,
    });
    ok('an over-range strength clamps to 1', near(clampedStrength.strength01, 1));
    const noRect = projectOccluderShadow({ azimuthDeg: 315, elevationDeg: 55, heightPx: 26 });
    ok('a missing rect degrades to a zero-size stamp (no throw)', noRect.w === 0 && noRect.h === 0);
  }

  // ======================================================================
  // mapWindowRectToStamp — the DOM→shader adapter (canvas-local, top-down px)
  // ======================================================================
  {
    const light = { azimuthDeg: 315, elevationDeg: 55, heightPx: 26 };
    // Canvas fills the viewport from its origin; a window sits inside it.
    const canvasRect = { left: 0, top: 0, width: 1920, height: 1080 };
    const winRect = { left: 500, top: 300, width: 400, height: 600 };
    const stamp = mapWindowRectToStamp(winRect, canvasRect, light, { strength01: 0.4 });
    ok('stamp half-size is the window half-size', near(stamp.halfX, 200) && near(stamp.halfY, 300));
    // Window centre is (700, 600) canvas-local; the NW light throws it down-right.
    ok('stamp centre is offset SE of the window centre', stamp.centerX > 700 && stamp.centerY > 600);
    ok(
      'stamp carries a positive penumbra and the requested strength',
      stamp.penumbraPx > 0 && near(stamp.strength, 0.4)
    );

    // A non-zero canvas origin is subtracted: the SAME window relative to a
    // shifted canvas lands at the SAME canvas-local centre (minus the shift).
    const shifted = mapWindowRectToStamp(
      { left: 700, top: 400, width: 400, height: 600 },
      { left: 200, top: 100, width: 1920, height: 1080 },
      light,
      { strength01: 0.4 }
    );
    ok(
      'canvas origin is subtracted (window is canvas-relative)',
      near(shifted.centerX, stamp.centerX) && near(shifted.centerY, stamp.centerY)
    );

    // Overhead light → no offset → stamp centre is exactly the window centre.
    const overhead = mapWindowRectToStamp(winRect, canvasRect, { azimuthDeg: 315, elevationDeg: 90, heightPx: 26 }, {});
    ok(
      'an overhead light leaves the stamp centred on the window',
      near(overhead.centerX, 700) && near(overhead.centerY, 600)
    );

    // Degrades on nullish input rather than throwing (the frame loop must never crash on a stray read).
    const empty = mapWindowRectToStamp(null, null, light, {});
    ok('nullish rects degrade to a zero-size stamp, no throw', empty.halfX === 0 && empty.halfY === 0);
    ok('MAX_UI_SHADOW_STAMPS is a small positive cap', MAX_UI_SHADOW_STAMPS > 0 && MAX_UI_SHADOW_STAMPS <= 16);

    // The x5 default flows all the way through the DOM adapter, and the
    // penumbra stays untouched by it (only the throw distance changes).
    const tinyWin = { left: 500, top: 300, width: 100, height: 100 };
    const tinyCanvas = { left: 0, top: 0, width: 1000, height: 1000 };
    const winCenterX = 550;
    const winCenterY = 350;
    const scale1 = mapWindowRectToStamp(tinyWin, tinyCanvas, light, { offsetScale: 1 });
    const scale5 = mapWindowRectToStamp(tinyWin, tinyCanvas, light, {}); // default omitted → 5x
    const d1 = { x: scale1.centerX - winCenterX, y: scale1.centerY - winCenterY };
    const d5 = { x: scale5.centerX - winCenterX, y: scale5.centerY - winCenterY };
    ok('mapWindowRectToStamp defaults to the 5x offset scale', near(d5.x, d1.x * 5) && near(d5.y, d1.y * 5));
    ok('the offsetScale default does not change the penumbra', near(scale1.penumbraPx, scale5.penumbraPx));
  }

  // ======================================================================
  // clamp01 + the workspace-light default sanity
  // ======================================================================
  ok('clamp01 clamps high', near(clamp01(2), 1));
  ok('clamp01 clamps low', near(clamp01(-1), 0));
  ok('clamp01 maps non-finite to 0', near(clamp01(NaN), 0));
  ok(
    'DEFAULT_WORKSPACE_LIGHT is a sane decorative key',
    DEFAULT_WORKSPACE_LIGHT.elevationDeg > 0 &&
      DEFAULT_WORKSPACE_LIGHT.elevationDeg <= 90 &&
      DEFAULT_WORKSPACE_LIGHT.heightPx > 0 &&
      DEFAULT_WORKSPACE_LIGHT.strength01 >= 0 &&
      DEFAULT_WORKSPACE_LIGHT.strength01 <= 1
  );
}
