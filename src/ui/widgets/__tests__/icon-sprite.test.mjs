/**
 * The pure half of the icon sprite: the `ICONS` table and `iconMarkup`'s
 * string shape. `installIconSprite` itself is DOM-only (creates real SVG
 * elements) and is verified live via the widget-gallery harness, not here
 * (CONVENTIONS.md §4 — no DOM mock just to force a Node test).
 */
import { ICONS, iconMarkup } from '../icon-sprite.js';

export function run(t) {
  const names = Object.keys(ICONS);
  t.ok('the sprite is not empty', names.length > 0);
  t.ok(
    'every icon has non-empty markup',
    names.every((n) => typeof ICONS[n] === 'string' && ICONS[n].length > 0)
  );
  t.ok(
    'every icon is built from <path>/<circle>/<rect>/<ellipse> only — no stray viewBox/fill/stroke baked into the shape',
    names.every((n) => !/viewBox|fill=|stroke=/.test(ICONS[n]))
  );
  t.ok(
    'every icon name is a bare word (no accidental "i-" prefix baked into the key)',
    names.every((n) => !n.startsWith('i-'))
  );

  // A handful of icons this session's rooms actually reference by name — a
  // rename here is a silent break at every one of those call sites.
  for (const must of ['sun', 'moon', 'bug', 'heart', 'camera', 'health', 'water', 'fire', 'gear']) {
    t.ok(`'${must}' is in the sprite`, must in ICONS);
  }

  t.ok(
    'iconMarkup produces the exact <svg class="ico"><use.../></svg> shape',
    iconMarkup('sun') === '<svg class="ico" ><use href="#i-sun"/></svg>'
  );
  t.ok(
    "extra attribute text splices into the <svg> tag, matching the mock's own icon() helper",
    iconMarkup('gauge', 'class="ico eff"') === '<svg class="ico" class="ico eff"><use href="#i-gauge"/></svg>'
  );
}
