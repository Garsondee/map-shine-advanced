/**
 * THE SCENE EXPORTER — the one human-operated bridge between the author's
 * REAL Foundry world and the assistant's disposable bench world.
 *
 * WHY THIS EXISTS (author directive, 2026-08-10): a Foundry module has full
 * read/write access to every document in the world it runs in, and a wrong
 * call (a bad bulk update, an errant delete) can destroy real, hand-authored,
 * unrecoverable work — a documented real risk of Foundry modules generally,
 * not specific to this one. An assistant must therefore NEVER be pointed at
 * the world the author uses for real development. This is the safe
 * alternative: the author presses ONE button in THEIR world, gets a portable
 * JSON file, and hands it over. The assistant only ever reads that file and
 * only ever writes to its own disposable bench world
 * (memory: reference_live_foundry_harness) — it never touches the real one.
 *
 * WHAT IT CAPTURES, and why this list and no more: exactly the document
 * types MSA's own renderer reads from a scene (docs/planning/Moonshot.md
 * §4.5's per-frame pass table) — Levels (the floors themselves), Tiles,
 * Walls, AmbientLights, Regions (darkness behaviors) — plus MSA's own three
 * scene-flag payloads (authored anchors, painted masks, the camera path),
 * read through the SAME adapters every other MSA subsystem uses
 * (anchor-adapter.js, paint-adapter.js, camera-path-player.js) rather than a
 * second, parallel flag read that could drift from them.
 *
 * WHAT IT DELIBERATELY OMITS, named rather than silently dropped: Tokens
 * (actor-bound and session-specific — a different concern from static map
 * content), Drawings, Notes, AmbientSounds, and the Playlist/Journal links
 * (no MSA subsystem reads any of these). Add a category here the day
 * something in src/ actually consumes it, not before.
 *
 * HOW: every embedded document is captured via Foundry's OWN `.toObject()`
 * — the platform's canonical plain-object serialization, walking whatever
 * the INSTALLED version's real schema is (verified against
 * common/documents/{scene,level,tile,wall,ambient-light,region}.mjs) —
 * rather than a hand-picked field list that would silently drift the moment
 * Foundry ships a schema change (feedback_read_the_producer_never_invent_
 * its_shape). `_id` is preserved on every document ON PURPOSE: Wall/Tile/
 * AmbientLight/Region each store a `levels` field referencing a Level's OWN
 * `_id` (the multi-floor visibility/restriction scoping every one of those
 * document types shares — feedback_native_levels_not_thirdparty) — an
 * import that minted fresh ids would silently orphan every one of those
 * cross-references.
 *
 * @module foundry/scene-export
 */

import { loadAuthoredAnchors } from './anchor-adapter.js';
import { loadPaintedMasks } from './paint-adapter.js';
import { loadCameraPathRaw } from './camera-path-player.js';

// The embedded collections MSA's renderer actually reads from a scene — see
// this module's header for why Tokens/Drawings/Notes/Sounds are excluded.
// Order is the export's own display order, not load-bearing.
const CAPTURED_COLLECTIONS = Object.freeze(['levels', 'tiles', 'walls', 'lights', 'regions']);

// Top-level Scene fields relevant to reconstructing the WORLD itself
// (dimensions, grid, environment/darkness, fog) — everything else on a
// Scene document (navigation ordering, permissions, ownership, `_stats`,
// compendium bookkeeping) is either meaningless outside the author's real
// world or read by no MSA subsystem. Verified against `BaseScene.
// defineSchema()` (common/documents/scene.mjs).
const CAPTURED_SCENE_FIELDS = Object.freeze([
  'name',
  'width',
  'height',
  'padding',
  'shiftX',
  'shiftY',
  'initial',
  'initialLevel',
  'grid',
  'environment',
  'fog',
]);

/**
 * Pure: given a raw Scene-shaped plain object (from `.toObject()`, or a
 * Node-test fixture of the same shape), build the export payload. Never
 * throws — an absent collection reads as an empty array, never a crash, and
 * an absent scalar field is simply omitted rather than defaulted (the
 * caller's `.toObject()` already applied every real schema default; this
 * function must not invent a second, possibly-stale set of defaults).
 *
 * @param {object} sceneObj - `canvas.scene.toObject()`, or an equivalent
 *   plain object in tests.
 * @returns {{scene: object, levels: object[], tiles: object[],
 *   walls: object[], lights: object[], regions: object[]}}
 */
export function buildSceneExportPayload(sceneObj) {
  const raw = sceneObj && typeof sceneObj === 'object' ? sceneObj : {};
  const scene = {};
  for (const key of CAPTURED_SCENE_FIELDS) {
    if (key in raw) scene[key] = raw[key];
  }
  const out = { scene };
  for (const key of CAPTURED_COLLECTIONS) {
    out[key] = Array.isArray(raw[key]) ? raw[key] : [];
  }
  return out;
}

/**
 * Every texture path this export payload references (Level backgrounds/
 * foregrounds, Tile textures), deduplicated and sorted — a RECEIPT of what
 * art the scene needs, not a requirement check. The author must ensure the
 * assistant's bench world can reach the same relative paths (today: the
 * same `mansion_example_map/` tree, junctioned into the bench Foundry's
 * `Data/modules/map-shine-advanced/` — memory: reference_live_foundry_
 * harness) — this list exists so that fact is checkable at a glance instead
 * of discovered only after an import renders blank
 * (feedback_asset_content_inferred_from_downstream_arithmetic's own lesson:
 * don't let the receiver guess what art exists).
 *
 * @param {ReturnType<typeof buildSceneExportPayload>} payload
 * @returns {string[]}
 */
export function collectExportTexturePaths(payload) {
  const set = new Set();
  for (const lvl of payload.levels ?? []) {
    if (lvl?.background?.src) set.add(lvl.background.src);
    if (lvl?.foreground?.src) set.add(lvl.foreground.src);
  }
  for (const t of payload.tiles ?? []) {
    if (t?.texture?.src) set.add(t.texture.src);
  }
  return Array.from(set).sort();
}

/**
 * Build the download filename. `wallClock` is an injected parameter, not a
 * private `Date.now()`/`new Date()` sample inline — this project's own
 * structure check treats wall-clock time as an INPUT everywhere, never
 * something a function reaches out and samples for itself (docs/planning/
 * Environment.md; the V2 desynced-animation-clocks lesson it exists to
 * prevent). Mirrors `diag/flight-recorder.js#bundleFilename`'s exact shape —
 * same problem, same fix, not reinvented.
 *
 * @param {string|null|undefined} sceneName
 * @param {() => Date} [wallClock]
 * @returns {string}
 */
export function sceneExportFilename(sceneName, wallClock = () => new Date()) {
  const slug =
    String(sceneName || 'scene')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'scene';
  const stamp = wallClock().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `msa-scene-export-${slug}-${stamp}.json`;
}

/**
 * Live build of the full export snapshot — the active scene's own document
 * data plus MSA's own three scene-flag payloads. Never throws; a failure
 * reads as `{ok:false, reason}`, the same convention every other `foundry/`
 * reader in this project uses (never take a caller down with it).
 *
 * @returns {{ok:true, snapshot:object}|{ok:false, reason:string}}
 */
export function buildLiveSceneExport() {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) {
      return { ok: false, reason: 'no active scene (canvas.scene is null) — open the scene to export first' };
    }
    const raw = typeof scene.toObject === 'function' ? scene.toObject() : scene;
    const payload = buildSceneExportPayload(raw);
    const texturePaths = collectExportTexturePaths(payload);

    return {
      ok: true,
      snapshot: {
        exportFormat: 'msa-scene-export-v1',
        exportedAt: new Date().toISOString(),
        // NOT msaVersion: this module is a `foundry/` leaf (this file's own
        // header — "imports nothing above itself") and `MapShine` is the
        // composition root, above it. The caller (boot.js) stamps its own
        // version in, the same "add context at the edge" shape `envelope()`
        // already uses for every other report.
        foundryVersion: typeof game !== 'undefined' ? (game.version ?? null) : null,
        sceneId: scene.id ?? null,
        ...payload,
        msaFlags: {
          // Read through the SAME adapters every live MSA subsystem uses —
          // never a second, parallel flag read that could drift from them.
          authoredAnchors: loadAuthoredAnchors(),
          paintedMasks: loadPaintedMasks(),
          cameraPath: loadCameraPathRaw(),
        },
        texturePaths,
        omitted: {
          note:
            'Deliberately not captured: Tokens (actor-bound, session-specific), Drawings, ' +
            "Notes, AmbientSounds, Playlist/Journal links. See this module's own header.",
        },
      },
    };
  } catch (err) {
    return { ok: false, reason: `building scene export threw: ${err?.message ?? err}` };
  }
}
