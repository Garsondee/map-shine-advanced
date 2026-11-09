/**
 * tools/lab/lab-index.mjs — every lab scene together (mmp-78u). lab.mjs uses this.
 * @module tools/lab/lab-index
 */
import { LAB_VERSION, labManifest, labPaintJob } from './lab-spec.mjs';
import { wallsImages, wallsScene } from './walls-spec.mjs';
import { interiorsImages, interiorsScene } from './interiors-spec.mjs';
import { vegetationImages, vegetationScene } from './vegetation-spec.mjs';

/** The whole folder: Lab · Effects (activated) + Lab · Walls & Windows + Lab · Interiors & Regions. */
export function labManifestAll({ assetDir, version = LAB_VERSION } = {}) {
  const m = labManifest({ assetDir, version });
  return {
    ...m,
    scenes: [
      ...m.scenes,
      wallsScene(assetDir, version),
      interiorsScene(assetDir, version),
      vegetationScene(assetDir, version),
    ],
  };
}

/** Every image of every lab scene. */
export function labPaintJobAll(version = LAB_VERSION) {
  const j = labPaintJob(version);
  return {
    ...j,
    images: [...j.images, ...wallsImages(version), ...interiorsImages(version), ...vegetationImages(version)],
  };
}
