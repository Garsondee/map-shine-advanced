/**
 * DOOR GRAPHICS — MSA's FIFTH registered effect, ported from V2's
 * `DoorMeshManager`. Renders every textured door as an animated leaf (swing /
 * slide / ascend / descend / swivel; single or double), open/close driven by
 * Foundry's own door state — the SAME `DoorMesh` Foundry itself draws
 * (client/canvas/containers/elements/door-mesh.mjs), reproduced so the door
 * looks identical under MSA's renderer.
 *
 * THIS FILE IS THE DECLARATION (params schema + manifest) — the data the
 * registry, settings cascade and (future) governor read. The runtime split is
 * the same one every effect here uses:
 *   - `foundry/scene-doors.js`         READS the door documents (adapter-only).
 *   - `effects/door-graphics-render.js` does the pure `DoorMesh` parity math + material.
 *   - `vt/vt-pan-viewer.js`            owns the GPU meshes + per-frame animation clock.
 *
 * DEFAULT ON at every profile (`enabledFromProfile: 'low'`): a door graphic is
 * a structural part of the map's look, not decorative chrome — Foundry draws it
 * unconditionally, and a handful of four-vertex quads is free
 * (feedback_default_on_new_features: ship the best look, dial DOWN on request).
 *
 * @module effects/door-graphics
 */

/**
 * The effect-wide knobs (validated by `core/params-schema.js`). Deliberately
 * FEW: a door's look is its authored texture + Foundry's per-door animation
 * config (type/double/direction/duration/strength/flip), which are Foundry
 * DATA, not MSA params. What is genuinely effect-wide is only HOW MSA plays the
 * motion — so that is all that lives here.
 *
 * @type {Record<string, object>}
 */
export const DOOR_GRAPHICS_PARAMS = Object.freeze({
  animateMotion: {
    type: 'bool',
    default: true,
    category: 'Motion',
    label: 'Animate opening',
    help: 'Swing/slide the door open and closed over time. Off = the door snaps instantly between states (cheaper, and some GMs prefer it).',
  },
  motionDurationScale: {
    type: 'float',
    min: 0.1,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Motion',
    label: 'Opening speed',
    help: "Scales how long each door takes to open or close, relative to its authored duration. 1 = Foundry's own timing; 0.5 = twice as fast; 2 = half speed.",
  },
});

/**
 * The manifest — the effect as data (Effects.md §2 shape).
 *
 * `visualWeight: 0.75` — higher than the decorative candle/UI-shadow: a door is
 * a load-bearing map element (it reads as part of the building), so it is
 * defended after the structural world/lighting passes but before the pretty
 * atmospherics. `a11y.photosensitive: false` — a swinging door is not a strobe;
 * the ascend/descend fade is a single gentle transition, not a flash.
 *
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const DOOR_GRAPHICS = Object.freeze({
  id: 'doorGraphics',
  title: 'Door graphics',
  visualWeight: 0.75,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'full',
    why: 'Loads one texture per distinct door-graphic URL on first use (ensureDoorTexture). Small individually, but a scene with many distinct door art assets loads them all after the curtain would otherwise have lifted, and doors are re-scoped on every floor change.',
    probes: ['doorTextures'],
  }),
  params: DOOR_GRAPHICS_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'animated-leaf',
      cost: Object.freeze({ class: 'C0', estMsPerMp: 0.01 }),
      adds: 'each textured door renders as an animated leaf (swing/slide/ascend/descend/swivel, single or double), open/close synced to Foundry door state, drawn into the lit scene',
    }),
  ]),
  // Recorded, NOT built — honest rungs so the deferred work does not rot
  // (Effects.md §0). The fog reveal is FIRST because it is the one behaviour V2
  // had that this V1 does not, and it is blocked only on the V3 fog system.
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'fog-reveal-sync',
      priority: 'high',
      note: "HIGH PRIORITY. A door opening must drive the fog-of-war slow reveal — the area a now-open doorway exposes fades into view synced to the door's OPEN animation, not instantly (V2's DoorMesh#getOpenAnimationFactor fed FogOfWarEffectV2 exactly this). Blocked on V3 fog-of-war landing (self-contained, incoming). The door runtime ALREADY tracks each door's eased openFactor (0..1) for its own rendering — the fog system consumes that same factor; no new door math is needed, only the consumer.",
    }),
    Object.freeze({
      name: 'roof-occlusion',
      note: "A door beneath overhead/foreground ROOF art should be hidden by it (Foundry places DoorMesh at foreground.sort-1, i.e. just UNDER the roof). V1 draws doors above the whole map stack (correct for the common no-separate-roof scene, and above tokens as Foundry does). Wire the door's LayerKey into the main draw-list sort (scene/layer-order.js) so overhead tiles occlude it.",
    }),
    Object.freeze({
      name: 'secret-door-visibility',
      note: 'A SECRET door (door type 2) should show its graphic only to the GM — Foundry renders secret doors as plain walls to players. V1 draws any textured door for everyone; gate on the viewer/GM role once player-vs-GM viewing is modelled.',
    }),
    Object.freeze({
      name: 'per-floor-elevation',
      note: "Place a door at its OWN floor's elevation for correct multi-floor stacking, rather than pinning it above the active floor's band. Rides native scene.levels, like the candle/UI-shadow per-floor rungs.",
    }),
    Object.freeze({
      name: 'door-open-sound',
      note: "Foundry plays a per-door open/close/lock sound (CONFIG.Wall.doorSounds). MSA could mirror it, but audio is out of the renderer's scope for now — recorded so it reads as a deliberate line, not an oversight.",
    }),
  ]),
});
