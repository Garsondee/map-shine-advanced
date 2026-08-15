/**
 * THE TOKEN-VISION DIAGNOSTIC — "why can this token only see a point light?"
 *
 * Built 2026-08-15 after the SAME symptom was reported three times and two
 * fixes were declared complete without being complete. The lesson driving
 * this file: the visible-area question has SEVERAL independent gates, they
 * fail identically on screen, and no amount of source reading distinguishes
 * them from outside the author's own world.
 *
 * ⚠️ WHY A SCREENSHOT CANNOT TELL THESE APART. What a controlled token
 * reveals is `vision.light` (the global-light shape + every point light's
 * shape) INTERSECTED with `vision.light.mask` — and the mask is fed by only
 * two things (`CanvasVisibility#refreshVisibility`, vendored v14 source):
 *   (a) light sources with `data.vision === true`, drawn straight in, and
 *   (b) each active vision source's OWN light-perception polygon, but only
 *       when `visionSource.lightRadius > 0` and it is not blinded.
 * So "only a point light is revealed" has two completely different causes
 * that look pixel-identical:
 *   CAUSE A — the token's light-perception polygon is missing/empty
 *             (`lightRadius === 0`), so the mask contains nothing but a
 *             vision-providing light. Foundry/token/game-system config.
 *   CAUSE B — global illumination is not active or its darkness window
 *             excludes the current darkness, so there is no daylight shape
 *             to intersect with in the first place. MSA's own concern.
 * This report reads both, plus the third gate (`scene.tokenVision`), and
 * says which one is actually failing IN PLAIN LANGUAGE rather than leaving a
 * human to correlate five numbers.
 *
 * ⚠️ CAUSE A HAS A KNOWN, SPECIFIC, GAME-SYSTEM SHAPE — and it is why
 * `detectionModesIsArray` is reported. Foundry v14 changed
 * `TokenDocument#detectionModes` from an ARRAY of `{id, enabled, range}`
 * (v13 and earlier) to a keyed `TypedObjectField` read as
 * `detectionModes.lightPerception` (`common/documents/token.mjs`). A system
 * that still assigns the v13 ARRAY shape — PF2e's own
 * `_prepareDetectionModes` override does exactly this in the copy vendored
 * at `gamesystemsourcecode/pf2e` (v7.10.1, `compatibility.maximum: "13"`) —
 * leaves `detectionModes.lightPerception` `undefined` on v14, so
 * `Token#lightPerceptionRange` returns 0 and EVERY token silently loses the
 * ability to see any lit area it is not standing in. That is a
 * system-vs-core version mismatch, not an MSA bug, and MSA must not "fix" it
 * by writing token vision config — the author's own constraint on this work
 * was that any solution stay compatible with any game system. Naming it
 * precisely is the correct contribution.
 *
 * PURE READ. Writes nothing, never throws — a diagnostic that takes a frame
 * down is worse than no diagnostic.
 *
 * @module foundry/vision-diagnostics
 */

/** @param {*} v @returns {number|null} */
function num(v) {
  return Number.isFinite(v) ? v : null;
}

/**
 * Describe one vision source's contribution to the light mask.
 * @param {*} vs a live `PointVisionSource`
 * @returns {object}
 */
function describeVisionSource(vs) {
  // `lightRadius` is legitimately `Infinity` (Foundry's own default for
  // unlimited light perception) — JSON.stringify turns that into `null`,
  // which reads exactly like "missing" and cost a full round of this
  // investigation. Report it as a STRING so the two stay distinguishable
  // (feedback_instruments_must_not_lie).
  const lr = vs?.lightRadius;
  return {
    sourceId: vs?.sourceId ?? null,
    active: vs?.active ?? null,
    hasActiveLayer: vs?.hasActiveLayer ?? null,
    isBlinded: vs?.isBlinded ?? null,
    blindedReasons: vs?.blinded ? { ...vs.blinded } : null,
    sightRadius: num(vs?.radius),
    lightRadius: lr === Infinity ? 'Infinity' : num(lr),
    // THE decisive number: a light-perception polygon with no points
    // contributes nothing to the mask, so every lit area is masked away.
    lightPolygonPoints: vs?.light?.points?.length ?? null,
    losPolygonPoints: vs?.shape?.points?.length ?? null,
  };
}

/**
 * Describe a token document's vision authoring, including the v14 shape trap.
 * @param {*} tok a live `Token` placeable
 * @returns {object}
 */
function describeToken(tok) {
  const doc = tok?.document ?? null;
  const dm = doc?.detectionModes;
  const isArray = Array.isArray(dm);
  return {
    id: tok?.id ?? null,
    name: doc?.name ?? null,
    sight: doc?.sight ? { enabled: doc.sight.enabled, range: doc.sight.range, visionMode: doc.sight.visionMode } : null,
    // ⚠️ THE GAME-SYSTEM SHAPE TRAP — see this module's header. An ARRAY here
    // means a v13-era system is writing v13-shaped data into a v14
    // TypedObjectField, and `detectionModes.lightPerception` is undefined.
    detectionModesIsArray: isArray,
    detectionModes: (() => {
      try {
        return JSON.parse(JSON.stringify(dm ?? null));
      } catch {
        return null;
      }
    })(),
    lightPerceptionPresent: !isArray && !!dm?.lightPerception,
    lightPerceptionEnabled: !isArray ? (dm?.lightPerception?.enabled ?? null) : null,
    lightPerceptionRange: tok?.lightPerceptionRange === Infinity ? 'Infinity' : num(tok?.lightPerceptionRange),
    sightRange: num(tok?.sightRange),
  };
}

/**
 * The whole picture, plus a verdict naming the failing gate.
 * @returns {object}
 */
export function readTokenVisionDiagnostic() {
  try {
    if (typeof canvas === 'undefined' || !canvas) return { available: false, reason: 'no canvas' };
    const env = canvas.environment ?? null;
    const gls = env?.globalLightSource ?? null;
    const vis = canvas.visibility ?? null;

    const liveDarkness = num(env?.darknessLevel);
    const win = gls?.data?.darkness ?? null;
    const windowAdmitsNow = win && liveDarkness !== null ? liveDarkness >= win.min && liveDarkness <= win.max : null;

    const globalLight = {
      active: gls?.active ?? null,
      disabled: gls?.data?.disabled ?? null,
      suppressed: gls?.suppressed ?? null,
      window: win ? { min: num(win.min), max: num(win.max) } : null,
      liveDarkness,
      windowAdmitsNow,
      shapePoints: gls?.shape?.points?.length ?? null,
      // The SCENE DOCUMENT's own copy — MSA deliberately never writes this,
      // so `false` here is EXPECTED and is not the failure. Reported only so
      // nobody mistakes it for the live answer (`active`, above).
      sceneDocEnabled: canvas.scene?.environment?.globalLight?.enabled ?? null,
    };

    const visionSources = [];
    for (const vs of canvas.effects?.visionSources ?? []) visionSources.push(describeVisionSource(vs));

    const visionProvidingLights = [];
    for (const ls of canvas.effects?.lightSources ?? []) {
      if (ls?.data?.vision && ls.active) {
        visionProvidingLights.push({ sourceId: ls.sourceId, radius: num(ls.radius) });
      }
    }

    const controlled = (canvas.tokens?.controlled ?? []).map(describeToken);

    // ── THE VERDICT ────────────────────────────────────────────────────────
    // Ranked, and it names ONE cause rather than listing symptoms. Ordered by
    // which gate fails FIRST in Foundry's own pipeline, so the answer is the
    // thing to fix, not the last thing noticed.
    const findings = [];
    if (canvas.scene?.tokenVision === false) {
      findings.push('Scene has Token Vision turned OFF — nothing is gated by vision at all on this scene.');
    }
    const anyMaskContributor = visionSources.some(
      (v) => v.lightPolygonPoints > 0 && v.isBlinded === false && (v.lightRadius === 'Infinity' || v.lightRadius > 0)
    );
    if (controlled.some((t) => t.detectionModesIsArray)) {
      findings.push(
        "CAUSE A (game system): the controlled token's `detectionModes` is an ARRAY, but Foundry v14 expects a keyed object. " +
          '`detectionModes.lightPerception` is therefore undefined, `lightPerceptionRange` is 0, and this token can NEVER see a lit ' +
          'area it is not standing in — only lights flagged "Provides Vision". This is a game-system/Foundry-version mismatch ' +
          '(PF2e <= v7.10.1 targets Foundry 13 and writes the old array shape), NOT an MSA bug and NOT something MSA should overwrite.'
      );
    } else if (controlled.some((t) => !t.lightPerceptionPresent)) {
      findings.push(
        'CAUSE A (token config): the controlled token has no `lightPerception` detection mode, so `lightPerceptionRange` is 0 and it ' +
          'cannot see lit areas beyond itself. Foundry only auto-adds that mode when `sight.enabled` is true.'
      );
    } else if (controlled.some((t) => t.lightPerceptionEnabled === false)) {
      findings.push('CAUSE A (token config): the controlled token has `lightPerception` explicitly DISABLED.');
    } else if (visionSources.some((v) => v.isBlinded)) {
      findings.push(
        'CAUSE A (blinded): an active vision source is BLINDED, which removes its light polygon from the mask.'
      );
    } else if (!anyMaskContributor && visionSources.length > 0) {
      findings.push(
        'CAUSE A: no active vision source contributes a light-perception polygon to the mask (all have lightRadius 0 or an empty polygon), ' +
          'so every lit area is masked away except lights flagged "Provides Vision".'
      );
    }
    if (globalLight.active === false) {
      findings.push('CAUSE B (MSA): Global Illumination is NOT active, so there is no daylight shape to reveal.');
    } else if (globalLight.active && windowAdmitsNow === false) {
      findings.push(
        `CAUSE B (MSA): Global Illumination is active but its darkness window ${JSON.stringify(globalLight.window)} ` +
          `EXCLUDES the current darkness ${liveDarkness} — no daylight is granted at this time of day.`
      );
    }
    if (!visionSources.length) {
      findings.push('No active vision source — control a token with vision before reading this.');
    }
    if (!findings.length) {
      findings.push(
        'Every gate this report can see is PASSING: Global Illumination is active, its window admits the current darkness, and a ' +
          'vision source is contributing a real light-perception polygon. If area is still unrevealed, it is line-of-sight (walls), ' +
          'not illumination.'
      );
    }

    return {
      available: true,
      verdict: findings,
      scene: {
        tokenVision: canvas.scene?.tokenVision ?? null,
        darknessLevel: num(canvas.scene?.environment?.darknessLevel),
      },
      globalLight,
      visibility: {
        initialized: vis?.initialized ?? null,
        visible: vis?.visible ?? null,
        globalContainerVisible: vis?.vision?.light?.global?.visible ?? null,
      },
      controlledTokens: controlled,
      visionSources,
      visionProvidingLights,
    };
  } catch (err) {
    return { available: false, reason: `token-vision diagnostic threw: ${err?.message ?? err}` };
  }
}
