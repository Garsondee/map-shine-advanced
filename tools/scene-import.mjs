#!/usr/bin/env node
/**
 * THE SCENE IMPORTER — the assistant's own half of the export/import bridge
 * (foundry/scene-export.js is the other half, and the one that ships in the
 * module; this file does NOT ship — it is bench tooling only).
 *
 * WHY THIS IS A SEPARATE, UNSHIPPED SCRIPT: the author's standing rule
 * (2026-08-10) is that an assistant must never be pointed at their real
 * development Foundry. This script only ever runs against the assistant's
 * own disposable bench install (memory: reference_live_foundry_harness) —
 * it has no reason to exist inside the customer-facing module, and keeping
 * it out of src/ makes that boundary structural, not just a habit.
 *
 * THE MECHANISM, proven live against a real bench Foundry (2026-08-10)
 * before this file was written — see the Testament's Petition log:
 *   1. `Scene.create({...})` from the export's `scene` fields.
 *   2. `scene.createEmbeddedDocuments('Level'|'Tile'|'Wall'|'AmbientLight'|
 *      'Region', payload, {keepId: true})` — ONE call per collection,
 *      Region's nested `behaviors[]` create inline with no separate step.
 *   3. `{keepId: true}` is not cosmetic: Wall/Tile/AmbientLight/Region each
 *      store a `levels` field referencing a Level's OWN `_id` (native
 *      multi-floor scoping — feedback_native_levels_not_thirdparty).
 *      Preserving every id across the export/import boundary is WHY those
 *      cross-references still resolve in the new scene — verified directly:
 *      an imported First-Floor's `visibility.levels` still contains the
 *      imported Ground level's real id, not a dangling reference.
 *   4. MSA's own scene flags (`msaFlags` in the export) are restored last,
 *      via `scene.setFlag('map-shine-advanced', key, value)` — the same
 *      flag keys anchor-adapter.js/paint-adapter.js/camera-path-player.js
 *      read, so a re-imported scene's candles/painted masks/camera path
 *      come back exactly as authored, not re-derived.
 *
 * USAGE (from a Playwright `page` already on the bench Foundry, logged in
 * as GM — see tests/playwright/msa-look.spec.js for that setup):
 *   const { importSceneExport } = await import('../../tools/scene-import.mjs');
 *   const exportJson = JSON.parse(fs.readFileSync(exportFilePath, 'utf8'));
 *   const result = await page.evaluate(importSceneExport, { exportJson, sceneName: 'My Import' });
 *
 * `importSceneExport` is written as a plain, dependency-free function
 * (no imports of its own) specifically so it can be handed to
 * `page.evaluate()` and run INSIDE the browser, where `Scene`/`canvas`/
 * `game` actually exist — it cannot be called from Node directly.
 *
 * @module tools/scene-import
 */

/**
 * Runs INSIDE the browser (via `page.evaluate`), not in Node. Creates a new
 * Scene from an `foundry/scene-export.js`-shaped payload and populates it.
 * Never assumes the export is well-formed beyond what `JSON.parse` already
 * guarantees — a malformed collection reads as empty rather than throwing,
 * matching this project's own `foundry/` reader convention.
 *
 * @param {{exportJson: object, sceneName?: string}} args
 * @returns {Promise<{ok:true, sceneId:string, levels:number, tiles:number,
 *   walls:number, lights:number, regions:number, flagsRestored:string[]}
 *   |{ok:false, reason:string}>}
 */
export async function importSceneExport({ exportJson, sceneName }) {
  try {
    const data = exportJson;
    if (!data || typeof data !== 'object' || !data.scene) {
      return {
        ok: false,
        reason: 'exportJson is missing its top-level "scene" object — not an msa-scene-export-v1 file?',
      };
    }

    const scene = await Scene.create({
      name: sceneName || data.scene.name || 'MSA Import',
      width: data.scene.width,
      height: data.scene.height,
      padding: data.scene.padding,
      shiftX: data.scene.shiftX,
      shiftY: data.scene.shiftY,
      grid: data.scene.grid,
      environment: data.scene.environment,
      fog: data.scene.fog,
      initial: data.scene.initial,
    });

    // Foundry seeds every freshly-created Scene with its OWN default Level, at the fixed,
    // reserved id "defaultLevel0000" — not authored data — and REFUSES to let the Levels
    // collection ever go empty (a plain delete-then-create throws "must have at least one
    // level"). A real export's Ground-floor level legitimately reuses that exact same
    // reserved id too (it is Foundry's own default, not something the author chose), so the
    // seeded level is UPDATED in place where the incoming id matches it, and only levels
    // that don't collide are created fresh — the collection is never empty in between. Both
    // failure modes caught live, 2026-08-10, on the first real (non-synthetic) import.
    const seededLevelIds = Array.from(scene.levels?.keys?.() ?? []);
    const seededSet = new Set(seededLevelIds);
    const incomingLevels = Array.isArray(data.levels) ? data.levels : [];
    const collidingLevels = incomingLevels.filter((l) => seededSet.has(l._id));
    const freshLevels = incomingLevels.filter((l) => !seededSet.has(l._id));
    const leftoverSeededIds = seededLevelIds.filter((id) => !incomingLevels.some((l) => l._id === id));

    let levelCount = 0;
    if (collidingLevels.length) {
      await scene.updateEmbeddedDocuments('Level', collidingLevels);
      levelCount += collidingLevels.length;
    }
    if (freshLevels.length) {
      levelCount += (await scene.createEmbeddedDocuments('Level', freshLevels, { keepId: true })).length;
    }
    if (leftoverSeededIds.length && levelCount > 0) {
      await scene.deleteEmbeddedDocuments('Level', leftoverSeededIds);
    }

    const counts = { levels: levelCount };
    for (const [type, key] of [
      ['Tile', 'tiles'],
      ['Wall', 'walls'],
      ['AmbientLight', 'lights'],
      ['Region', 'regions'],
    ]) {
      const payload = Array.isArray(data[key]) ? data[key] : [];
      counts[key] = payload.length ? (await scene.createEmbeddedDocuments(type, payload, { keepId: true })).length : 0;
    }

    const flagsRestored = [];
    for (const [flagKey, value] of Object.entries(data.msaFlags ?? {})) {
      if (value === null || value === undefined) continue;
      await scene.setFlag('map-shine-advanced', flagKey, value);
      flagsRestored.push(flagKey);
    }

    return { ok: true, sceneId: scene.id, ...counts, flagsRestored };
  } catch (err) {
    return { ok: false, reason: `import threw: ${err?.message ?? err}` };
  }
}
