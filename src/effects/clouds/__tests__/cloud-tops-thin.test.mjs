/**
 * Node verification for the zoomed-out thinning of the cloud tops (mmp-63o.30).
 */
import {
  cloudTopsZoomOutThin,
  CLOUD_TOPS_THIN_START,
  CLOUD_TOPS_THIN_END,
  CLOUD_TOPS_ZOOMED_OUT_OPACITY_FLOOR,
} from '../cloud-shade.js';
import { CLOUD_TOPS_PARAMS } from '../cloud-tops.js';

export function run(t) {
  const { ok } = t;
  ok('thin: full opacity just above the deck', cloudTopsZoomOutThin(1) === 1);
  ok('thin: full opacity at the start of the band', cloudTopsZoomOutThin(CLOUD_TOPS_THIN_START) === 1);
  ok(
    'thin: reaches the floor at the end of the band',
    Math.abs(cloudTopsZoomOutThin(CLOUD_TOPS_THIN_END) - CLOUD_TOPS_ZOOMED_OUT_OPACITY_FLOOR) < 1e-9
  );
  ok(
    'thin: stays at the floor far out',
    Math.abs(cloudTopsZoomOutThin(50) - CLOUD_TOPS_ZOOMED_OUT_OPACITY_FLOOR) < 1e-9
  );
  const mid = cloudTopsZoomOutThin((CLOUD_TOPS_THIN_START + CLOUD_TOPS_THIN_END) / 2);
  ok('thin: halfway is between floor and full', mid > CLOUD_TOPS_ZOOMED_OUT_OPACITY_FLOOR && mid < 1);
  let prev = 2;
  let monotone = true;
  for (let r = 0; r <= 6; r += 0.05) {
    const v = cloudTopsZoomOutThin(r);
    if (v > prev + 1e-12) monotone = false;
    prev = v;
  }
  ok('thin: never brightens as the view rises', monotone);
  ok('thin: NaN reads as up close (full)', cloudTopsZoomOutThin(NaN) === 1);
  ok(
    'tops wait for a wider view by default (zoomSensitivity 0.45)',
    CLOUD_TOPS_PARAMS.zoomSensitivity.default === 0.45
  );
}
