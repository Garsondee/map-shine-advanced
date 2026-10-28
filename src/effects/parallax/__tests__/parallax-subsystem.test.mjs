/**
 * parallax-subsystem.test.mjs — the per-frame mesh transforms: a layer is scaled about the view centre,
 * the viewed floor is never moved, a depth twin follows its colour mesh through the shared geometry,
 * and turning off (or a scale back to 1) puts every mesh back exactly where it was.
 */
import { createParallaxSubsystem } from '../parallax-subsystem.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const mesh = (geometry = {}, z = 0) => ({ geometry, position: { x: 0, y: 0, z }, scale: { x: 1, y: 1, z: 1 } });

export function run(t) {
  const { ok } = t;
  const floors = [
    { index: 0, elevationBottom: 0, elevationTop: 10 },
    { index: 1, elevationBottom: 10, elevationTop: 20 },
    { index: 2, elevationBottom: 20, elevationTop: 30 },
  ];
  const viewRect = { minX: 0, minY: 0, maxX: 2000, maxY: 1000 };
  const sceneRect = { width: 4000, height: 2400 };
  const frame = (over = {}) => ({
    enabled: true,
    params: null,
    floors,
    floorIndex: 1,
    nowMs: 0,
    viewRect,
    sceneRect,
    ...over,
  });

  const p = createParallaxSubsystem();
  ok('off until fed', p.isOn() === false && p.scaleAt(30) === 1 && p.frame() === null);
  ok('off frame returns null', p.update(frame({ enabled: false })) === null && !p.isOn());

  const f = p.update(frame());
  ok('on with the defaults', !!f && p.isOn() && f.eyeH > 0);
  ok('⭐ the viewed floor is at scale 1', p.scaleAt(10) === 1);
  ok('the floor above rides out, the floor below sinks', p.scaleAt(20) > 1 && p.scaleAt(0) < 1);

  const roof = mesh({ id: 'roof' });
  const s = p.placeItem(roof, 20);
  ok('placeItem returns the scale', s === p.scaleAt(20) && s > 1);
  ok('the mesh is scaled', near(roof.scale.x, s) && near(roof.scale.y, s) && roof.scale.z === 1);
  // A vertex at world (x, y) goes to position + scale·(x, y) — which must equal eye + (p − eye)·s.
  const vx = 1600;
  const vy = 200;
  const sx = roof.position.x + roof.scale.x * vx;
  const sy = roof.position.y + roof.scale.y * vy;
  ok(
    'a vertex lands where the parallax maths puts it',
    near(sx, 1000 + (vx - 1000) * s) && near(sy, 500 + (vy - 500) * s)
  );
  ok(
    'the eye is a fixed point',
    near(roof.position.x + roof.scale.x * 1000, 1000) && near(roof.position.y + roof.scale.y * 500, 500)
  );
  ok('z is never touched', roof.position.z === 0);

  const twin = mesh(roof.geometry, 0.42);
  p.placeProxy(twin);
  ok(
    'a depth twin follows its colour mesh through the shared geometry',
    near(twin.scale.x, s) && near(twin.position.x, roof.position.x)
  );
  ok('the twin keeps its own rank depth', twin.position.z === 0.42);
  const stranger = mesh({ id: 'other' });
  p.placeProxy(stranger);
  ok('a mesh with no colour twin is left alone', stranger.scale.x === 1 && stranger.position.x === 0);

  const floorArt = mesh({ id: 'floor1' });
  p.placeItem(floorArt, 10);
  ok(
    'the viewed floor’s art is not moved',
    floorArt.scale.x === 1 && floorArt.position.x === 0 && floorArt.position.y === 0
  );

  // The eye follows the view.
  p.update(frame({ viewRect: { minX: 500, minY: 0, maxX: 2500, maxY: 1000 }, nowMs: 16 }));
  p.placeItem(roof, 20);
  ok('panning moves the eye, so the layer slides', near(roof.position.x + roof.scale.x * 1500, 1500));

  // Back to one: the mesh is restored exactly.
  p.placeScale(roof, 1);
  ok('a scale back to 1 restores the mesh', roof.scale.x === 1 && roof.position.x === 0 && roof.position.y === 0);

  p.placeItem(roof, 20);
  p.update(frame({ enabled: false }));
  p.placeItem(roof, 20);
  ok('turning off restores the mesh', roof.scale.x === 1 && roof.position.x === 0 && roof.position.y === 0);
  p.placeProxy(twin);
  ok('and its twin', twin.scale.x === 1 && twin.position.x === 0 && twin.position.z === 0.42);

  // A floor change glides.
  const g = createParallaxSubsystem();
  g.update(frame({ floorIndex: 0, nowMs: 0 }));
  ok('first frame: no glide', !g.isGliding() && g.floorPos() === 0);
  g.update(frame({ floorIndex: 1, nowMs: 100 }));
  ok('a floor change starts a glide from the old floor', g.isGliding() && g.floorPos() === 0);
  g.update(frame({ floorIndex: 1, nowMs: 100 + 400 }));
  ok('halfway through the default glide it is between floors', g.floorPos() > 0 && g.floorPos() < 1);
  const above = g.scaleAt(10);
  ok('mid-glide the new floor rides above the camera and is settling', above > 1);
  g.update(frame({ floorIndex: 1, nowMs: 100 + 5000 }));
  ok('it lands exactly on the new floor', g.floorPos() === 1 && !g.isGliding() && g.scaleAt(10) === 1);
  g.update(frame({ floorIndex: 2, nowMs: 6000, snap: true }));
  ok('a snap (scene change) adopts the floor with no glide', g.floorPos() === 2 && !g.isGliding());
  g.update(frame({ floorIndex: 0, nowMs: 7000, params: { glideSec: 0 } }));
  ok('glide time 0 snaps', g.floorPos() === 0 && !g.isGliding());

  // The floor-change transition's step: how the old floor looks from the new one.
  const st = createParallaxSubsystem();
  ok('step: null before it has a frame', st.stepScale(0, 1) === null);
  st.update(frame({ floorIndex: 1 }));
  ok('step: climbing, the floor you left has receded', st.stepScale(0, 1) < 1);
  ok('step: descending, the floor you left has risen toward you', st.stepScale(2, 1) > 1);
  ok('step: the same floor is no step at all', st.stepScale(1, 1) === 1);
  ok('step: two floors is further than one', st.stepScale(0, 2) < st.stepScale(1, 2));
  ok('step: it does not disturb the live glide', st.floorPos() === 1);
  st.update(frame({ enabled: false }));
  ok('step: null when off', st.stepScale(0, 1) === null);

  const none = createParallaxSubsystem();
  ok('no floors: nothing happens', none.update(frame({ floors: [] })) === null && !none.isOn());
  ok('no scene rect: nothing happens', none.update(frame({ sceneRect: null })) === null);
  ok('strength 0: off', none.update(frame({ params: { strength: 0 } })) === null && !none.isOn());

  const info = p.info();
  ok('info is plain data', typeof info.on === 'boolean' && Number.isFinite(info.floorPos));
}
