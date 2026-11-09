/**
 * tools/lab/lab-index.mjs — every lab scene together (mmp-78u). lab.mjs uses this.
 * @module tools/lab/lab-index
 */
import { LAB_VERSION, labManifest, labPaintJob } from './lab-spec.mjs';
import { wallsImages, wallsScene } from './walls-spec.mjs';
import { interiorsImages, interiorsScene } from './interiors-spec.mjs';
import { vegetationImages, vegetationScene } from './vegetation-spec.mjs';
import { weatherImages, weatherScene } from './weather-spec.mjs';

/**
 * The whole folder: Lab · Effects (activated) + Lab · Walls & Windows + Lab · Interiors & Regions +
 * Lab · Vegetation + Lab · Weather. `only` (scene keys, e.g. ['weather']) builds just those scenes and activates
 * the first, so one lab agent can rebuild its own scene without replacing (or re-activating) the others'.
 */
export function labManifestAll({ assetDir, version = LAB_VERSION, only = null } = {}) {
  const m = labManifest({ assetDir, version });
  const all = [
    ...m.scenes,
    wallsScene(assetDir, version),
    interiorsScene(assetDir, version),
    vegetationScene(assetDir, version),
    weatherScene(assetDir, version),
  ];
  if (!only?.length) return { ...m, scenes: all };
  const picked = all.filter((s) => only.includes(s.key)).map((s, i) => ({ ...s, activate: i === 0 }));
  if (!picked.length) throw new Error(`labManifestAll: no scene key in ${JSON.stringify(only)}`);
  return { ...m, scenes: picked };
}

/** Every image of every lab scene. */
export function labPaintJobAll(version = LAB_VERSION) {
  const j = labPaintJob(version);
  return {
    ...j,
    images: [
      ...j.images,
      ...wallsImages(version),
      ...interiorsImages(version),
      ...vegetationImages(version),
      ...weatherImages(version),
    ],
  };
}
