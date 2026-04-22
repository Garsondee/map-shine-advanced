/**
 * @fileoverview Runtime regression checks for the V3 mask hub.
 *
 * These exercise the three V2 failure classes that motivated the hub
 * migration:
 *
 *   1. **Wrong floor mask after view change** — verify the hub's active
 *      floor key matches `getViewedLevelIndex(scene)` and that the floor
 *      record actually exists.
 *   2. **Stale mask after async load** — verify every `status: 'ready'`
 *      record has a non-null texture, and that no `.url` is stale relative
 *      to the current background base path.
 *   3. **Divergence between effects and inspector** — verify that every
 *      consumer registered with the binding controller resolved to the same
 *      texture uuid that `hub.peekFloorMask(floorKey, maskId)` returns.
 *
 * Results come back as `{ ok, issues, details }` so they can be dumped to
 * console, asserted in tests, or surfaced in the inspector.
 *
 * @module v3/V3MaskDiagnostics
 */

import { V3_LEVEL_TEXTURE_FLIP_Y } from "./V3RenderConventions.js";
import { getBackgroundBasePathForLevel } from "./V3MaskProbe.js";
import { getViewedLevelIndex } from "./V3ViewedLevel.js";
import { resolveOutdoorsVariant } from "./V3MaskCatalog.js";

/**
 * @typedef {Object} DiagnosticsResult
 * @property {boolean} ok
 * @property {string[]} issues
 * @property {object} details
 */

/**
 * Run every regression check and return a combined report.
 *
 * @param {{
 *   host: import("./V3ThreeSceneHost.js").V3ThreeSceneHost|null,
 * }} args
 * @returns {DiagnosticsResult}
 */
export function runMaskDiagnostics({ host }) {
  /** @type {DiagnosticsResult} */
  const report = { ok: false, issues: [], details: {} };
  if (!host) {
    report.issues.push("no-host");
    return report;
  }
  const hub = host.maskHub;
  const bindings = host.maskBindings;
  const scene = host.canvas?.scene ?? null;
  if (!hub) {
    report.issues.push("no-hub");
    return report;
  }

  const viewed = checkViewedFloorConsistency(hub, scene);
  const staleness = checkStaleness(hub, scene);
  const orientation = checkOrientation(hub);
  const divergence = checkBindingDivergence(hub, bindings);
  const integrity = hub.validate();

  report.details = {
    viewed,
    staleness,
    orientation,
    divergence,
    integrity,
  };
  const groups = [viewed, staleness, orientation, divergence, integrity];
  for (const g of groups) {
    for (const i of g.issues ?? []) report.issues.push(i);
  }
  report.ok = report.issues.length === 0;
  return report;
}

/**
 * @param {import("./V3MaskHub.js").V3MaskHub} hub
 * @param {Scene|null} scene
 * @returns {{ok:boolean, issues:string[], details:object}}
 */
function checkViewedFloorConsistency(hub, scene) {
  const issues = [];
  const viewedIndex = getViewedLevelIndex(scene);
  const activeKey = hub.getActiveFloorKey();
  const expected = hub.floorKeyForIndex(Math.max(0, viewedIndex || 0));
  if (activeKey !== expected) {
    issues.push(`activeFloorKey '${activeKey}' does not match viewed '${expected}'`);
  }
  const floor = hub.getFloorRecord(activeKey);
  if (!floor) {
    issues.push(`no floor record for active '${activeKey}'`);
  }
  return {
    ok: issues.length === 0,
    issues,
    details: { activeKey, expected, viewedIndex, hasRecord: !!floor },
  };
}

/**
 * @param {import("./V3MaskHub.js").V3MaskHub} hub
 * @param {Scene|null} scene
 * @returns {{ok:boolean, issues:string[], details:object}}
 */
function checkStaleness(hub, scene) {
  const issues = [];
  const snapshot = hub.snapshot();
  for (const floor of snapshot.floors) {
    const expectedBase = scene ? getBackgroundBasePathForLevel(scene, floor.floorIndex) : null;
    if ((floor.basePath ?? null) !== (expectedBase ?? null)) {
      issues.push(
        `${floor.floorKey}: basePath stale (hub='${floor.basePath}' vs scene='${expectedBase}')`,
      );
    }
    for (const m of floor.masks) {
      if (m.status === "ready" && !m.hasTexture) {
        issues.push(`${floor.floorKey}/${m.maskId}: status=ready but no texture`);
      }
      if (!m.derived && m.status === "missing" && m.url) {
        issues.push(
          `${floor.floorKey}/${m.maskId}: status=missing but url=${m.url}`,
        );
      }
    }
  }
  return { ok: issues.length === 0, issues, details: {} };
}

/**
 * @param {import("./V3MaskHub.js").V3MaskHub} hub
 * @returns {{ok:boolean, issues:string[], details:object}}
 */
function checkOrientation(hub) {
  const issues = [];
  for (const key of hub.listFloorKeys()) {
    for (const rec of hub.listFloorMaskRecords(key)) {
      const tex = rec.texture;
      if (tex && "flipY" in tex && tex.flipY !== V3_LEVEL_TEXTURE_FLIP_Y) {
        issues.push(
          `${key}/${rec.maskId}: flipY=${tex.flipY} expected ${V3_LEVEL_TEXTURE_FLIP_Y}`,
        );
      }
    }
  }
  return { ok: issues.length === 0, issues, details: { expected: V3_LEVEL_TEXTURE_FLIP_Y } };
}

/**
 * @param {import("./V3MaskHub.js").V3MaskHub} hub
 * @param {import("./V3MaskBindingController.js").V3MaskBindingController|null} controller
 * @returns {{ok:boolean, issues:string[], details:object}}
 */
function checkBindingDivergence(hub, controller) {
  const issues = [];
  const detail = [];
  if (!controller) {
    return { ok: true, issues, details: { skipped: "no-controller" } };
  }
  const snap = controller.snapshot();
  for (const c of snap.consumers) {
    const floorKey = c.floorKey ?? hub.getActiveFloorKey();
    for (const slot of c.bound ?? []) {
      const [baseId, purpose] = String(slot.slot).split("@");
      const maskId = baseId === "outdoors"
        ? resolveOutdoorsVariant(purpose === "sky" ? "sky" : "surface")
        : baseId;
      const peekOpts = {};
      if (maskId === "outdoors") {
        peekOpts.purpose = purpose === "sky" ? "sky" : "surface";
      }
      const peek = hub.peekFloorMask(floorKey, maskId, peekOpts);
      const hubUuid = peek.texture?.uuid ?? null;
      if (slot.textureUuid !== hubUuid) {
        issues.push(
          `consumer '${c.id}' slot '${slot.slot}' bound=${slot.textureUuid} hub=${hubUuid} on ${floorKey}`,
        );
      }
      detail.push({
        consumer: c.id,
        slot: slot.slot,
        floorKey,
        maskId,
        hubUuid,
        boundUuid: slot.textureUuid,
      });
    }
  }
  return { ok: issues.length === 0, issues, details: { slots: detail } };
}
