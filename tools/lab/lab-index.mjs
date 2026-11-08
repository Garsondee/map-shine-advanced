/**
 * tools/lab/lab-index.mjs — every lab scene together (mmp-78u). lab.mjs uses this.
 * @module tools/lab/lab-index
 */
import { LAB_VERSION, labManifest, labPaintJob } from './lab-spec.mjs';
import { wallsImages, wallsScene } from './walls-spec.mjs';

/** The whole folder: Lab · Effects (activated) + Lab · Walls & Windows. */
export function labManifestAll({ assetDir, version = LAB_VERSION } = {}) {
  const m = labManifest({ assetDir, version });
  return { ...m, scenes: [...m.scenes, wallsScene(assetDir, version)] };
}

/** Every image of every lab scene. */
export function labPaintJobAll(version = LAB_VERSION) {
  const j = labPaintJob(version);
  return { ...j, images: [...j.images, ...wallsImages(version)] };
}
