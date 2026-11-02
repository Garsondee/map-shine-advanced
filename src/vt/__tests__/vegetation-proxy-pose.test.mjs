/**
 * vegetation-proxy-pose.test.mjs — the canopy and its depth proxy pose a plant the same way.
 *
 * The floor discards itself wherever `buf:scene.depth` says a canopy covers it (`maskNode`,
 * `querySceneDepth(...).isAtOrBelow`). The canopy's proxy therefore has to sway EXACTLY like the
 * canopy, or the floor hides under a proxy the leaves have already left and the gap shows the void.
 * 2026-11-02, author: "when it distorts it leaves behind a gap of unrendered space". `9b5b7ec8` gave
 * the canopy a pivot map (one plant, one body) and `74b2099e` a two-body hand-over at plant seams,
 * both at the canopy's call site only; the proxy kept the old per-vertex sway.
 *
 * Both call sites live inside `startVtPanViewer` (no renderer here), so this reads the source:
 * the hand-over must live in the shared function, and the proxy must pass the canopy's pivot.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VT_PAN_VIEWER_PATH = fileURLToPath(new URL('../vt-pan-viewer.js', import.meta.url));

/** The text of the call starting at `start` (an index of its opening parenthesis), balanced. */
function callText(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

export function run(t) {
  const { ok } = t;
  const src = readFileSync(VT_PAN_VIEWER_PATH, 'utf8');

  const defAt = src.indexOf('function buildVegetationSwayDisplacementNode(');
  ok('the shared sway function exists', defAt >= 0);
  const bodyAt = src.indexOf('{', src.indexOf(')', defAt) + 1);
  const bodyHead = src.slice(bodyAt, bodyAt + 4000);
  ok(
    'the two-body hand-over lives inside the shared sway function (every caller gets it)',
    /if \(pivot\?\.texture2 && !pivot\.sample\)/.test(bodyHead)
  );

  // No caller may mix two bodies on its own: that is how one consumer drifted from another.
  const callerMixes = [...src.matchAll(/if \(pivot\?\.texture2\)/g)].length;
  ok('no call site does its own two-body mix', callerMixes === 0);

  const proxyMarker = src.indexOf('asShadow: false, // this proxy represents the CANOPY, never the shadow');
  ok('the depth proxy call site is found', proxyMarker >= 0);
  const proxyCallAt = src.lastIndexOf('buildVegetationSwayDisplacementNode(', proxyMarker);
  const proxyCall = callText(src, src.indexOf('(', proxyCallAt));
  ok("the depth proxy passes the canopy's own pivot map", /pivot:\s*overlay\.motion\.pivot/.test(proxyCall));
  ok("the depth proxy uses the canopy's own motion bag", /motion:\s*overlay\.motion\b/.test(proxyCall));

  // The canopy's own call keeps passing its pivot through the args bag.
  ok("the canopy's sway args carry its pivot", /rotationLiftEnabled,\s*pivot,\s*\};/.test(src));
}
