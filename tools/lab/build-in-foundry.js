/**
 * tools/lab/build-in-foundry.js — the MSA Lab builder (mmp-78u).
 *
 * ONE plain function, no imports, so it can be handed to a GM client as text (cdp eval,
 * a macro that fetches it, or a pasted console snippet). It takes the manifest from
 * lab-spec.mjs#labManifest and makes Foundry match it.
 *
 * RULES (why it is safe to run on the author's real world):
 *   - It only ever touches documents whose flags[moduleId][flag] it set: the lab folder
 *     and the lab scenes. Nothing else in the world is read for writing.
 *   - A lab scene is REPLACED, not patched: delete + create with the same fixed _id
 *     (keepId). So the scene always equals the spec, ids stay stable, and running it
 *     twice changes nothing but the scene's timestamps.
 *   - It never writes a world setting.
 *
 * Coordinates in the manifest are SCENE pixels; Foundry stores canvas pixels (scene
 * pixels + the padding offset), so walls/lights are shifted here, once.
 *
 * @param {object} manifest - labManifest() output
 * @returns {Promise<object>} a report of what was built
 */
/* global Folder */
// eslint-disable-next-line no-unused-vars -- called by name from the seed script that embeds this file
async function buildLab(manifest) {
  if (!game.user?.isGM) throw new Error('buildLab: must run as a GM');
  const M = manifest.moduleId;
  const F = manifest.flag;
  const tag = (d) => d?.flags?.[M]?.[F];
  const report = { version: manifest.version, folder: null, scenes: [] };

  // Folder: find ours by flag, else create.
  let folder = game.folders.find((f) => f.type === 'Scene' && tag(f) === 'folder');
  if (!folder) folder = await Folder.create(manifest.folder);
  else if (folder.name !== manifest.folder.name) await folder.update({ name: manifest.folder.name });
  report.folder = folder.id;

  for (const s of manifest.scenes) {
    const existing = game.scenes.get(s.id);
    if (existing && tag(existing) !== s.data.flags[M][F]) {
      throw new Error(`buildLab: scene id ${s.id} exists but is not a lab scene; refusing to touch it`);
    }
    const wasViewed = existing && canvas.scene?.id === existing.id;
    if (existing) await existing.delete();

    const scene = await Scene.create({ ...s.data, folder: folder.id }, { keepId: true });
    const dims = scene.dimensions;
    const ox = dims.sceneX;
    const oy = dims.sceneY;
    const shiftWall = (w) => ({ ...w, c: [w.c[0] + ox, w.c[1] + oy, w.c[2] + ox, w.c[3] + oy] });
    const shiftXY = (d) => ({ ...d, x: d.x + ox, y: d.y + oy });
    const shiftRegion = (r) => ({
      ...r,
      shapes: r.shapes.map((sh) =>
        sh.type === 'polygon'
          ? { ...sh, points: sh.points.map((v, i) => v + (i % 2 ? oy : ox)) }
          : { ...sh, x: sh.x + ox, y: sh.y + oy }
      ),
    });

    const made = {};
    const create = async (type, list, shift) => {
      if (!list?.length) return;
      const docs = await scene.createEmbeddedDocuments(type, shift ? list.map(shift) : list);
      made[type] = docs.length;
    };
    await create('Wall', s.walls, shiftWall);
    await create('AmbientLight', s.lights, shiftXY);
    await create('Tile', s.tiles, shiftXY);
    await create('Token', s.tokens, shiftXY);
    await create('Region', s.regions, shiftRegion);
    await create('Drawing', s.drawings, shiftXY);
    if (s.sceneFlags) {
      for (const [k, v] of Object.entries(s.sceneFlags)) await scene.setFlag(M, k, v);
    }

    report.scenes.push({
      key: s.key,
      id: scene.id,
      name: scene.name,
      offset: [ox, oy],
      levels: scene.levels.contents.map((l) => ({
        id: l.id,
        name: l.name,
        elevation: [l.elevation.bottom, l.elevation.top],
        src: l.background?.src,
        sees: [...(l.visibility?.levels ?? [])],
      })),
      made,
    });
    // Activate the main lab scene (map-development-world-2 is a dev-only world, so this is
    // free) so any reload lands back here; otherwise restore the view if we replaced it.
    if (s.activate) await scene.activate();
    else if (wasViewed) await scene.view();
  }
  return report;
}
