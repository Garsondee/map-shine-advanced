/**
 * scene-eye.test.mjs — the one pretend camera: it sits over the true view's centre, frames the view with
 * the Table's field of view, follows zoom like a real camera, and the constant-camera effects keep their
 * tuned ratio to it.
 */
import {
  SCENE_EYE_DEFAULT_FOV_DEG,
  REFERENCE_EYE_PX,
  sceneEyeHeight,
  resolveSceneEye,
  eyeScale,
  eyeCameraForFixed,
  encodeLayerScale01,
  decodeLayerScale01,
  liftedLookup,
} from '../scene-eye.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;
  ok('the default field of view is the Table’s 45°', SCENE_EYE_DEFAULT_FOV_DEG === 45);
  ok('at 90° the eye height equals the half-span', near(sceneEyeHeight(500, 90), 500));
  ok('a narrower field of view raises the eye (flatter)', sceneEyeHeight(500, 20) > sceneEyeHeight(500, 60));
  ok('zooming in lowers the eye', sceneEyeHeight(200) < sceneEyeHeight(800));
  ok('garbage degrades to something finite', Number.isFinite(sceneEyeHeight(NaN, NaN)) && sceneEyeHeight(NaN) > 0);

  const eye = resolveSceneEye({ minX: 1000, minY: 400, maxX: 3000, maxY: 1400 }, 45);
  ok('the eye sits over the view centre', eye.x === 2000 && eye.y === 900);
  ok('at the height that frames the view', near(eye.height, sceneEyeHeight(500, 45)));
  ok('and remembers its field of view', eye.fovDeg === 45);
  ok(
    'no rect, no eye',
    resolveSceneEye(null) === null && resolveSceneEye({ minX: 0, minY: 0, maxX: 0, maxY: 0 }) === null
  );
  ok('a non-finite rect is no eye', resolveSceneEye({ minX: NaN, minY: 0, maxX: 1, maxY: 1 }) === null);
  ok('the field of view is clamped', resolveSceneEye({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 999).fovDeg === 170);

  ok('⭐ the viewed plane is never scaled', eyeScale(0, 1500) === 1);
  ok('higher is bigger, lower is smaller', eyeScale(100, 1500) > 1 && eyeScale(-100, 1500) < 1);
  ok('s = H / (H − h)', near(eyeScale(300, 1500), 1500 / 1200));
  ok('nothing is drawn through the camera', Number.isFinite(eyeScale(1e9, 1500)) && eyeScale(1e9, 1500) <= 4 + 1e-9);
  ok('no eye, no scale', eyeScale(100, 0) === 1 && eyeScale(NaN, 1000) === 1);

  ok('a constant camera keeps its ratio to the 1000 px reference eye', eyeCameraForFixed(2250, 2000) === 4500);
  ok(
    'at the reference eye it is exactly the old camera',
    eyeCameraForFixed(1000 / 0.15, REFERENCE_EYE_PX) === 1000 / 0.15
  );
  ok('no eye: the old camera unchanged', eyeCameraForFixed(1234, 0) === 1234);
  // The algebra behind "a perspective dial scales heights": D/k with height h is D with height k·h.
  const D = 1800;
  const k = 0.4;
  ok('D/k with height h equals D with height k·h', near(eyeScale(90, D / k, 1), eyeScale(90 * k, D, 1)));

  // THE LAYER SCALE BYTE (2026-10-28): the depth pass's G byte carries each layer's parallax scale.
  const byte = (s) => Math.round(encodeLayerScale01(s) * 255) / 255;
  ok('⭐ layer scale: an unlifted layer reads back as exactly 1 through a byte', decodeLayerScale01(byte(1)) === 1);
  ok('layer scale: an unwritten byte (0) is scale 1', decodeLayerScale01(0) === 1 && encodeLayerScale01(1e-9) > 0);
  ok(
    'layer scale: lifted and sunk layers survive the byte to within 0.2 %',
    [0.85, 0.95, 1.02, 1.06, 1.15, 1.2].every((v) => Math.abs(decodeLayerScale01(byte(v)) / v - 1) < 0.002)
  );
  ok('layer scale: order is kept', decodeLayerScale01(byte(1.1)) > decodeLayerScale01(byte(1.05)));
  const lookEye = { x: 1000, y: 1000 };
  const p = { x: 1500, y: 1000 };
  const noThrow = { x: 0, y: 0 };
  ok('lookup: scale 1 is the pixel itself', near(liftedLookup(p, lookEye, 2000, 1, noThrow).x, 1500));
  const sLift = 2000 / (2000 - 100);
  ok(
    '⭐ lookup: a lifted layer is looked up at its own place on the map',
    near(liftedLookup(p, lookEye, 2000, sLift, noThrow).x, 1000 + 500 / sLift, 1e-9)
  );
  const sunward = liftedLookup(p, lookEye, 2000, sLift, { x: 0.5, y: 0 });
  ok(
    '⭐ lookup: ...and toward the sun by its height (shadow throw ½ px per px → 50 px back)',
    near(sunward.x, 1000 + 500 / sLift - 50, 1e-6)
  );
  ok(
    'lookup: a sunk floor gets no throw',
    near(liftedLookup(p, lookEye, 2000, 0.95, { x: 0.5, y: 0 }).x, 1000 + 500 / 0.95, 1e-9)
  );
}
