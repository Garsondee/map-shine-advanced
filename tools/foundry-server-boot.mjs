#!/usr/bin/env node

/**
 * Boot Foundry VTT as a PURE SERVER using the Electron distribution's own bundled Node.
 *
 * WHY THIS FILE EXISTS — two facts collide:
 *
 *  1. Foundry v14 requires Node >= 24 (`resources/app/package.json` → `release.node_version`),
 *     and the system Node here is 18. The Electron binary ships Node 24 internally, reachable
 *     via `ELECTRON_RUN_AS_NODE=1`, so no separate Node install is needed.
 *
 *  2. But Foundry decides whether to build a desktop window with
 *     `isElectron = process.versions.hasOwnProperty("electron")`
 *     (`resources/app/dist/config.mjs`) — and that key is STILL present under
 *     ELECTRON_RUN_AS_NODE. So Foundry tries to construct an `ElectronWindow`, reaches for
 *     `app.setUserTasks`, finds `app` undefined in run-as-node mode, and dies with
 *     "Cannot read properties of undefined (reading 'setUserTasks')". `--headless` does NOT
 *     avoid this: nothing consults it before the window is built.
 *
 * The fix is to delete that one key before Foundry's config module reads it, then import
 * Foundry's own entry point normally. Nothing inside the Foundry installation is modified.
 *
 * USAGE (argv after this script is passed through to Foundry untouched):
 *   ELECTRON_RUN_AS_NODE=1 "<...>/Foundry Virtual Tabletop.exe" tools/foundry-server-boot.mjs \
 *     --foundry-app="<...>/resources/app" --dataPath="<...>" --port=30000 --noupnp
 *
 * `--foundry-app` is consumed here and not passed on; everything else Foundry parses itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// --- 1. Make Foundry believe it is plain Node, not Electron -------------------------------
if (Object.prototype.hasOwnProperty.call(process.versions, 'electron')) {
  delete process.versions.electron;

  // `process.versions` is a normal object in current Node, so the delete above is expected to
  // work. It is not contractually guaranteed to, and a silent failure here would resurface as
  // the confusing `setUserTasks` crash, so replace the whole object if the key survived.
  if (Object.prototype.hasOwnProperty.call(process.versions, 'electron')) {
    const copy = { ...process.versions };
    delete copy.electron;
    Object.defineProperty(process, 'versions', { value: Object.freeze(copy), configurable: true });
  }

  if (Object.prototype.hasOwnProperty.call(process.versions, 'electron')) {
    console.error(
      '[foundry-server-boot] Could not hide process.versions.electron; Foundry ' +
        'would try to open a desktop window and crash. Aborting.'
    );
    process.exit(1);
  }
}

// --- 2. Locate Foundry's own entry point ---------------------------------------------------
const appArg = process.argv.find((a) => a.startsWith('--foundry-app='));
const appDir = appArg
  ? appArg.slice('--foundry-app='.length)
  : path.resolve(process.cwd(), 'FoundryVTT/Foundry Virtual Tabletop/resources/app');

const entry = path.join(appDir, 'main.mjs');
if (!fs.existsSync(entry)) {
  console.error(`[foundry-server-boot] Foundry entry point not found: ${entry}`);
  console.error('[foundry-server-boot] Pass --foundry-app=<path to resources/app>.');
  process.exit(1);
}

// Foundry re-parses process.argv itself; drop only the flag it would not understand.
process.argv = process.argv.filter((a) => !a.startsWith('--foundry-app='));

await import(pathToFileURL(entry).href);
