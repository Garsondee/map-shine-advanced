/**
 * Node verification for the zoom-linked lens curvature (mmp-ilo.4) and the natural vignette's shape (mmp-ilo.5).
 */
import {
  lensZoomCurvature,
  LENS_ZOOMED_IN_CURVATURE_SHARE,
  LENS_CURVATURE_ZOOM_IN_FRAC,
  LENS_CURVATURE_ZOOM_OUT_FRAC,
} from '../lens-motion.js';

/** CPU twin of the vignette in lens-render.js: brightness multiplier at radius r (0 centre, ~0.707 corner). */
function naturalVignette(r, softness, intensity) {
  const f = 1 + Math.max(0, softness) * 2;
  const x = r / f;
  const cos2 = 1 / (1 + x * x);
  const natural = cos2 * cos2;
  return 1 + (natural - 1) * intensity;
}

export function run(t) {
  const { ok } = t;
  const k = -0.1;
  ok('curvature: whole map in view = full card value', lensZoomCurvature(k, LENS_CURVATURE_ZOOM_OUT_FRAC) === k);
  ok('curvature: wider than the map = full', lensZoomCurvature(k, 3) === k);
  ok(
    'curvature: zoomed in = the flat share',
    Math.abs(lensZoomCurvature(k, LENS_CURVATURE_ZOOM_IN_FRAC) - k * LENS_ZOOMED_IN_CURVATURE_SHARE) < 1e-12
  );
  ok('curvature: very close = still the flat share', lensZoomCurvature(k, 0.01) === k * LENS_ZOOMED_IN_CURVATURE_SHARE);
  let prev = -Infinity;
  let mono = true;
  for (let f = 0; f <= 1.5; f += 0.01) {
    const v = Math.abs(lensZoomCurvature(k, f));
    if (v < prev - 1e-12) mono = false;
    prev = v;
  }
  ok('curvature: grows as the view widens', mono);
  ok('curvature: NaN view reads as wide (full)', lensZoomCurvature(k, NaN) === k);
  ok('curvature: zero stays zero', lensZoomCurvature(0, 0.5) === 0);

  ok('vignette: centre untouched', naturalVignette(0, 0.02, 1) === 1);
  const corner = naturalVignette(Math.SQRT1_2, 0.02, 1);
  ok('vignette: default corners ~54% darker (not the old ~83%)', corner > 0.42 && corner < 0.5);
  ok('vignette: softer is gentler', naturalVignette(Math.SQRT1_2, 0.9, 1) > corner);
  ok('vignette: intensity 0 is off', naturalVignette(Math.SQRT1_2, 0.02, 0) === 1);
  let p = 2;
  let fall = true;
  for (let r = 0; r <= 0.71; r += 0.01) {
    const v = naturalVignette(r, 0.02, 1);
    if (v > p + 1e-12) fall = false;
    p = v;
  }
  ok('vignette: falls smoothly from centre to corner', fall);
}
