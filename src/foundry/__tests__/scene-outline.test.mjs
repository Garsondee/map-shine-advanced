/**
 * scene-outline.test.mjs — Foundry's black outline round the map is found among the interface group's
 * children by its shape alone (v14 draws it as an unfilled stroke of the scene rect and the padded
 * canvas rect), hidden and shown on request, and nothing else is ever touched.
 */
import { isSceneOutline, setSceneOutlineVisible } from '../scene-outline.js';

export function run(t) {
  const { ok } = t;
  const dimensions = {
    rect: { x: 0, y: 0, width: 6000, height: 4000 },
    sceneRect: { x: 1000, y: 800, width: 4000, height: 2400 },
  };
  const stroke = (shape) => ({ shape, lineStyle: { visible: true, width: 4 }, fillStyle: { visible: false } });
  const graphics = (data) => ({ visible: true, geometry: { graphicsData: data } });

  // v14's outline: the padded canvas, then the scene rect (one Graphics).
  const outline = graphics([stroke({ ...dimensions.rect }), stroke({ ...dimensions.sceneRect })]);
  const noPadding = graphics([stroke({ ...dimensions.sceneRect })]);
  const filledBox = graphics([{ ...stroke({ ...dimensions.sceneRect }), fillStyle: { visible: true } }]);
  const otherStroke = graphics([stroke({ x: 10, y: 10, width: 100, height: 100 })]);
  const text = { visible: true };

  ok('⭐ the outline (canvas + scene rect strokes) is recognised', isSceneOutline(outline, dimensions));
  ok('a scene with no padding (scene rect alone) is recognised', isSceneOutline(noPadding, dimensions));
  ok('a FILLED rect is not the outline', !isSceneOutline(filledBox, dimensions));
  ok('a stroke of any other rect is not the outline', !isSceneOutline(otherStroke, dimensions));
  ok('a non-Graphics child is not the outline', !isSceneOutline(text, dimensions));

  const canvas = { dimensions, interface: { children: [text, otherStroke, outline, filledBox] } };
  const hid = setSceneOutlineVisible(canvas, false);
  ok('⭐ hiding hides the outline', hid.ok && hid.found === 1 && outline.visible === false);
  ok('...and touches nothing else', text.visible && otherStroke.visible && filledBox.visible);
  setSceneOutlineVisible(canvas, true);
  ok('showing brings it back', outline.visible === true);
  const none = setSceneOutlineVisible({ dimensions, interface: { children: [text] } }, false);
  ok('no outline: reports it rather than guessing', none.ok === false && /no outline/.test(none.reason));
  ok('no canvas yet: reports it', setSceneOutlineVisible(null, false).ok === false);
}
