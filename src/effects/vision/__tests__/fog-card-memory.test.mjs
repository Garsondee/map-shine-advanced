/**
 * Node verification for the Fog of War CARD (`fog-of-war.js`, `fog-of-war-look.js`) and the per-token
 * FOG MEMORY records (`foundry/fog-memory-persistence.js`, `vt/fog-memory-codec.js`), 2026-11-02.
 *
 * The author asked for the card, and for memory that survives a reload: *"Each scene must carry that
 * memory for each player controlled token."* The live round trip (save, reload, reselect, Reset Fog) was
 * proven in a private Foundry; these pin the pure halves so a later change cannot quietly undo them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOG_OF_WAR, FOG_OF_WAR_PARAMS } from '../fog-of-war.js';
import { resolveFogOfWarLook } from '../fog-of-war-look.js';
import { parseWorldEffectDefaults } from '../../../foundry/world-effect-defaults.js';
import {
  tokenIdFromSourceId,
  fogMemoryKey,
  tokenIdsOfKey,
  isValidFogMemoryRecord,
  makeFogMemoryRecord,
  mergeCoverageMax,
  fogMemorySize,
  shouldSaveFogMemory,
  readFogMemory,
  FOG_MEMORY_FLAG,
} from '../../../foundry/fog-memory-persistence.js';
import { greyFromRgba, rgbaFromGrey, hasCoverage } from '../../../vt/fog-memory-codec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewerSrc = fs.readFileSync(path.join(here, '../../../vt/vt-pan-viewer.js'), 'utf8').replace(/\r\n/g, '\n');
const bootSrc = fs.readFileSync(path.join(here, '../../../boot.js'), 'utf8').replace(/\r\n/g, '\n');

const DATA = 'data:image/webp;base64,UklGRg==';

export function run(t) {
  const { ok } = t;

  // ── The card ────────────────────────────────────────────────────────────
  ok('card: on at every profile (the painted fog is the default)', FOG_OF_WAR.enabledFromProfile === 'low');
  ok(
    'card: every param has a default inside its own range',
    Object.values(FOG_OF_WAR_PARAMS).every((s) => s.default >= s.min && s.default <= s.max)
  );
  const d = resolveFogOfWarLook({ enabled: true, params: {} }, 150);
  ok(
    'look: defaults are the look that shipped (edge 0.32 squares, ink 0.6, reveal 0.32 s)',
    d.featherGrid === 0.32 && d.ink === 0.6 && d.revealTauSec === 0.32
  );
  ok('look: sizes are grid squares turned into world px', d.inkCellPx === 0.6 * 150 && d.mistCellPx === 3.5 * 150);
  ok('look: memory brightness default matches the old EXPLORED_DIM_FACTOR', d.memoryDim === 0.35);
  const off = resolveFogOfWarLook({ enabled: false, params: { ink: 1, mist: 0.5 } }, 100);
  ok(
    'look OFF: plain fog — no ink, no mist, no fade, full colour, crisp band',
    off.ink === 0 && off.mist === 0 && off.revealTauSec === 0 && off.memorySaturation === 1 && off.featherGrid === 0
  );
  const wild = resolveFogOfWarLook({ enabled: true, params: { ink: 9, edgeSoftness: -3, mist: 'x' } }, 100);
  ok(
    'look: out-of-range values clamp, junk falls back to the default',
    wild.ink === 1 && wild.featherGrid === 0 && wild.mist === 0.14
  );
  ok('look: a missing grid size is 100 px, never NaN', Number.isFinite(resolveFogOfWarLook(null, NaN).inkCellPx));

  // ── World values ────────────────────────────────────────────────────────
  ok('world values: a stored patch parses', parseWorldEffectDefaults('{"ink":0.2}').ink === 0.2);
  ok(
    'world values: junk and arrays read as nothing stored',
    Object.keys(parseWorldEffectDefaults('{nope')).length === 0 &&
      Object.keys(parseWorldEffectDefaults('[1]')).length === 0
  );

  // ── Whose memory ────────────────────────────────────────────────────────
  ok(
    'source id → token id',
    tokenIdFromSourceId('Token.abc123') === 'abc123' && tokenIdFromSourceId('AmbientLight.x') === null
  );
  ok(
    'key: the sorted set of token ids in sight, order-independent',
    fogMemoryKey([{ sourceId: 'Token.b' }, { sourceId: 'Token.a' }, { sourceId: 'Token.a' }]) === 'a,b' &&
      fogMemoryKey([{ sourceId: 'Token.a' }, { sourceId: 'Token.b' }]) === 'a,b'
  );
  ok('key: no tokens in sight is the empty key', fogMemoryKey([]) === '' && tokenIdsOfKey('').length === 0);
  ok('key round trip', tokenIdsOfKey('a,b').join() === 'a,b');

  // ── Records ─────────────────────────────────────────────────────────────
  const rec = makeFogMemoryRecord({ rect: [0, 0, 7500, 4500], w: 1024, h: 614, data: DATA });
  ok('record: a fresh record is valid', isValidFogMemoryRecord(rec));
  ok('record: carries no wall-clock time (one-clock rule)', !('savedAt' in rec));
  ok(
    'record: a wrong version, empty rect or non-image data is refused',
    !isValidFogMemoryRecord({ ...rec, v: 2 }) &&
      !isValidFogMemoryRecord({ ...rec, rect: [0, 0, 0, 0] }) &&
      !isValidFogMemoryRecord({ ...rec, data: 'javascript:x' })
  );
  const fakeDoc = (flag, extra = {}) => ({
    getFlag: (ns, k) => (ns === 'map-shine-advanced' && k === FOG_MEMORY_FLAG ? flag : undefined),
    ...extra,
  });
  ok(
    'read: a valid flag comes back, a broken one is null',
    readFogMemory(fakeDoc(rec)) === rec && readFogMemory(fakeDoc({ v: 1 })) === null
  );

  // ── Who saves ───────────────────────────────────────────────────────────
  const user = { id: 'u' };
  ok(
    'save: a player-owned token this user may update',
    shouldSaveFogMemory(fakeDoc(null, { hasPlayerOwner: true, canUserModify: () => true }), user)
  );
  ok(
    'save: never a GM monster (no player owner)',
    !shouldSaveFogMemory(
      fakeDoc(null, { hasPlayerOwner: false, actor: { hasPlayerOwner: false }, canUserModify: () => true }),
      user
    )
  );
  ok(
    'save: never a token this user may not update',
    !shouldSaveFogMemory(fakeDoc(null, { hasPlayerOwner: true, canUserModify: () => false }), user)
  );

  // ── Merging and sizes ───────────────────────────────────────────────────
  const a = Uint8Array.from([0, 200, 10, 255]);
  mergeCoverageMax(a, Uint8Array.from([50, 100, 10, 0]));
  ok('merge: memory only grows (per-texel max), whichever client saved last', a.join() === '50,200,10,255');
  const sz = fogMemorySize([0, 0, 7500, 4500]);
  ok('size: longest side 1024, aspect kept', sz.w === 1024 && sz.h === 614);
  ok('size: a small scene is stored at its own size', fogMemorySize([0, 0, 300, 200]).w === 300);

  // ── Codec helpers ───────────────────────────────────────────────────────
  const grey = Uint8Array.from([0, 9, 255]);
  ok('codec: grey → RGBA → grey is exact', greyFromRgba(rgbaFromGrey(grey), 3, 1).join() === '0,9,255');
  ok(
    'codec: an all-black raster is not worth saving',
    !hasCoverage(new Uint8Array(10)) && hasCoverage(Uint8Array.from([0, 3]))
  );

  // ── Wiring that keeps the promise ───────────────────────────────────────
  ok(
    'viewer: follows the set of tokens in sight every gated frame',
    /if \(gating\.gate && visionDraw\.explored\?\.camera\) syncFogMemory\(visionRead\.sources\);/.test(viewerSrc)
  );
  ok(
    'viewer: a new set captures the OLD memory before the clear is requested',
    /fogMemorySave\(tokenIdsOfKey\(fogMemoryKeyNow\)\);[\s\S]{0,200}fogMemoryKeyNow = key;[\s\S]{0,400}exploredClearPending = true;/.test(
      viewerSrc
    )
  );
  ok(
    'viewer: stamps wait for the clear (never drawn into a buffer about to be wiped)',
    /fogMemoryStamps\.length > 0 && !exploredClearPending/.test(viewerSrc)
  );
  ok(
    'viewer: remembered ground on screen refills its colour',
    /storeUnlit: true,\n\s*exploredTexture: visionMask\.exploredTexture,/.test(viewerSrc)
  );
  ok(
    "boot: Foundry's Reset Fog clears MSA memory and the token flags",
    /socket\?\.on\?\.\('resetFog'[\s\S]{0,400}resetVtPanViewerFogMemory\(\)[\s\S]{0,300}clearSceneFogMemory\(scene\)/.test(
      bootSrc
    )
  );
}
