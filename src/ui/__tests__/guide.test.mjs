/**
 * The Map Shine Guide (mmp-0mv): its Markdown renderer, its scene buttons, and the
 * DRIFT checks that keep the guide true to the code.
 *
 * The drift half is the point (Ingram 2026-11-07: keep it concise, keep checking it is
 * correct when features change). It fails when:
 *   - a page in guide.json has no file, or a page file is not in guide.json;
 *   - a page links to a page, names a button, or shows an image that does not exist;
 *   - a page names a mask ending (`_Something`) the mask catalog does not have;
 *   - a mask in the catalog has no plain-English line in the guide's cheat sheet;
 *   - a button points at a param that no longer exists in its effect's schema;
 *   - a page grows past its word budget (concise is a rule, not a hope);
 *   - the guide's images grow past their size budget.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  renderGuideMarkdown,
  parseFrontMatter,
  resolveLink,
  renderInline,
  isSafeImagePath,
  guideSearchText,
  slugify,
} from '../rooms/guide/guide-markdown.js';
import { GUIDE_ACTIONS, GUIDE_EFFECTS, GUIDE_ACTION_IDS, runGuideAction, fmt } from '../rooms/guide/guide-actions.js';
import { MASK_GUIDE, maskCheatRows, maskCheatTableHtml } from '../rooms/guide/guide-masks.js';
import { MASK_KINDS } from '../../scene/mask-catalog.js';
import { WEATHER_ARCHETYPES } from '../../world/weather-data.js';

const GUIDE_DIR = fileURLToPath(new URL('../../../guide/', import.meta.url));
/** Hand-written words per page, tables and generated blocks included. Hubs are mostly tiles. */
const WORD_BUDGET = 650;
/** Every image in guide/images together. */
const IMAGE_BUDGET_BYTES = 14 * 1024 * 1024;
/** One image. */
const IMAGE_MAX_BYTES = 600 * 1024;

function runRenderer({ ok }) {
  const fm = parseFrontMatter('---\nsources: a.js, b.js\ntitle: "Hi"\n---\n# Head\n');
  ok(
    'front matter is split off and read',
    fm.meta.sources === 'a.js, b.js' && fm.meta.title === 'Hi' && fm.body.startsWith('# Head')
  );
  ok('no front matter is fine', parseFrontMatter('plain').body === 'plain');

  ok(
    'page links resolve',
    resolveLink('page:mask-water#depth')?.page === 'mask-water' &&
      resolveLink('page:mask-water#depth')?.anchor === 'depth'
  );
  ok(
    'external links must be http(s)',
    resolveLink('https://example.com/x')?.kind === 'external' && resolveLink('javascript:alert(1)') === null
  );
  ok('a bad link becomes plain text, never an <a>', !renderInline('[x](javascript:alert(1))').includes('<a'));
  ok(
    'inline code stays literal (no bold inside it)',
    renderInline('`**a**` and **b**') === '<code>**a**</code> and <strong>b</strong>'
  );
  ok('HTML in text is escaped', renderInline('<script>') === '&lt;script&gt;');
  ok(
    'image paths are plain names only',
    isSafeImagePath('a-b_c.webp') && !isSafeImagePath('../x.webp') && !isSafeImagePath('https://x/y.webp')
  );

  const md = [
    '# Title',
    'A lead paragraph with **bold**.',
    '',
    '- one',
    '- two',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '> [!tip] Keep it simple.',
    '> Still the tip.',
    '',
    '![Plain art](x.webp "Big Bank, by Mythica Machina")',
    '',
    '::: compare "Drag it"',
    '![Art](a.webp)',
    '![Map Shine](b.webp)',
    ':::',
    '',
    '[[do: brighten, darken]]',
    '[[cards: fixes, learn]]',
    '[[masks-table]]',
    'See [water](page:mask-water).',
  ].join('\n');
  const r = renderGuideMarkdown(md, { imageUrl: (f) => `IMG/${f}` });
  ok('headings get ids', r.headings[0]?.id === 'title' && r.html.includes('<h2 id="g-title">'));
  ok('lists render', r.html.includes('<ul><li>one</li><li>two</li></ul>'));
  ok('tables render', r.html.includes('<table class="g-table">') && r.html.includes('<td>1</td>'));
  ok(
    'a callout joins its lines',
    r.html.includes('g-callout-tip') && r.html.includes('Keep it simple. Still the tip.')
  );
  ok(
    'a figure carries its caption and goes through imageUrl',
    r.html.includes('src="IMG/x.webp"') && r.html.includes('<figcaption>Big Bank, by Mythica Machina</figcaption>')
  );
  ok(
    'a compare block is a slider over two images',
    r.html.includes('g-compare-range') && r.html.includes('IMG/a.webp') && r.html.includes('IMG/b.webp')
  );
  ok(
    'actions, cards and live blocks are collected for the room',
    r.actions.join() === 'brighten,darken' && r.cards.join() === 'fixes,learn' && r.live.join() === 'masks-table'
  );
  ok(
    'page links and images are collected (the drift test reads them)',
    r.pageLinks.includes('mask-water') && ['x.webp', 'a.webp', 'b.webp'].every((i) => r.images.includes(i))
  );
  ok('words are counted', r.words > 15 && r.words < 60);
  ok('search text drops markup', !/[[\]#*`|]/.test(guideSearchText(md)));
  ok('slugify', slugify('Your first *scene*, step by step!') === 'your-first-scene-step-by-step');
}

/** A fake scene and Remote for the buttons. */
function fakeEnv() {
  const calls = [];
  const stored = { grade: { exposure: 0.25 } };
  const settings = { 'bloom.playerEnable': 'on' };
  let archetype = 'overcast';
  let night = 0.5;
  const setter = (name, effectId) => (patch) => {
    calls.push([name, patch]);
    if (effectId && patch && !('enabled' in patch)) stored[effectId] = { ...(stored[effectId] ?? {}), ...patch };
    if ('enabled' in (patch ?? {})) settings[`${effectId}.playerEnable`] = patch.enabled ? 'on' : 'off';
  };
  const MapShine = {};
  for (const [id, spec] of Object.entries(GUIDE_EFFECTS)) MapShine[spec.setter] = setter(spec.setter, id);
  return {
    calls,
    stored,
    env: {
      effectSetter: (name) => MapShine[name] ?? null,
      readSceneEffectParams: (id) => ({ params: stored[id] ?? null }),
      readSetting: (k) => settings[k],
      writeSetting: (k, v) => {
        settings[k] = v;
      },
      getHour: () => 14.5,
      remote: {
        getFadeOverMs: () => 0,
        weatherBoard: {
          getWeatherArchetype: () => archetype,
          fadeToArchetype: (id) => {
            calls.push(['archetype', id]);
            archetype = id;
          },
          getAxisValue: () => 0.4,
          onAxisCommit: (a, v) => calls.push(['axis', a, v]),
          getNightDarkness: () => night,
          onNightDarknessCommit: (v) => {
            calls.push(['night', v]);
            night = v;
          },
        },
        onSweepToHour: (h) => calls.push(['hour', h]),
        getRendererOverride: () => 'msa',
        onRendererOverrideChange: (m) => calls.push(['renderer', m]),
      },
      open: (target) => calls.push(['open', target]),
    },
  };
}

async function runActions({ ok }) {
  {
    const { env, calls } = fakeEnv();
    const r = await runGuideAction('brighten', env);
    ok(
      'a relative button steps from the STORED value (0.25 → 0.75)',
      r.ok && calls[0][0] === 'setGrade' && calls[0][1].exposure === 0.75
    );
    ok(
      "...and says what it changed in the Studio's own words",
      r.changes[0].label === 'Colour Grade · Exposure' && r.changes[0].from === '0.25' && r.changes[0].to === '0.75'
    );
    ok('...and where to find it later', r.where === 'Studio → Effects → Colour Grade');
    const u = await r.undo();
    ok('undo puts the stored value back', u.ok && calls[1][1].exposure === 0.25);
  }
  {
    const { env, calls } = fakeEnv();
    const r = await runGuideAction('bloom-softer', env);
    ok(
      'with nothing stored, a button steps from the declared default',
      r.ok && Math.abs(calls[0][1].strength - GUIDE_EFFECTS.bloom.params.strength.default * 0.6) < 0.001
    );
  }
  {
    const { env, stored } = fakeEnv();
    stored.grade = { exposure: 2.9 };
    await runGuideAction('brighten', env);
    const r = await runGuideAction('brighten', env);
    ok(
      "a button can never push a value past the param's max",
      stored.grade.exposure === GUIDE_EFFECTS.grade.params.exposure.max && r.undo === null
    );
  }
  {
    const { env, calls } = fakeEnv();
    const r = await runGuideAction('bloom-off', env);
    await r.undo();
    ok(
      'an on/off button records the old switch and puts it back',
      calls[0][1].enabled === false && calls[1][1].enabled === true
    );
  }
  {
    const { env, calls } = fakeEnv();
    const r = await runGuideAction('wx-storm', env);
    await r.undo();
    ok(
      'weather goes through the Remote and back again',
      calls[0].join() === 'archetype,thunderstorm' && calls[1].join() === 'archetype,overcast'
    );
  }
  {
    const { env, calls } = fakeEnv();
    const r = await runGuideAction('time-night', env);
    await r.undo();
    ok(
      'time sweeps through the Remote and undo returns to the old hour',
      calls[0].join() === 'hour,23' && calls[1].join() === 'hour,14.5' && r.changes[0].from === '14:30'
    );
  }
  {
    const { env, calls } = fakeEnv();
    const r = await runGuideAction('night-lighter', env);
    ok('the Night fader moves and is clamped to 0..1', r.ok && Math.abs(calls[0][1] - 0.3) < 1e-9);
  }
  {
    const { env } = fakeEnv();
    const base = env.effectSetter;
    env.effectSetter = (n) => (n === 'setFire' ? null : base(n));
    const r = await runGuideAction('fire-smaller', env);
    ok('a missing effect fails politely, never throws', r.ok === false && /not running/.test(r.message));
    ok('an unknown button fails politely', (await runGuideAction('nope', env)).ok === false);
  }
  ok('fmt rounds for people', fmt(0.30000000004) === '0.3' && fmt(true) === 'on');

  // Every button must point at something real.
  const archetypes = new Set(WEATHER_ARCHETYPES.map((a) => a.id));
  for (const [id, a] of Object.entries(GUIDE_ACTIONS)) {
    if (a.kind === 'param' || a.kind === 'enable') ok(`button ${id}: its effect is known`, !!GUIDE_EFFECTS[a.effect]);
    if (a.kind === 'param') {
      for (const key of Object.keys(a.changes)) {
        const decl = GUIDE_EFFECTS[a.effect]?.params?.[key];
        ok(
          `button ${id}: ${a.effect}.${key} is a live numeric param`,
          decl && decl.status !== 'planned' && typeof decl.default === 'number'
        );
      }
    }
    if (a.kind === 'weather') ok(`button ${id}: weather "${a.archetype}" exists`, archetypes.has(a.archetype));
    ok(`button ${id}: has a short label`, typeof a.label === 'string' && a.label.length > 1 && a.label.length <= 26);
  }
}

function runMasks({ ok }) {
  const ids = MASK_KINDS.map((k) => k.id);
  const missing = ids.filter((id) => !MASK_GUIDE[id]);
  ok(`every catalog mask has a cheat-sheet line (missing: ${missing.join(', ') || 'none'})`, missing.length === 0);
  const stale = Object.keys(MASK_GUIDE).filter((id) => !ids.includes(id));
  ok(`no cheat-sheet line names a mask the catalog dropped (stale: ${stale.join(', ') || 'none'})`, stale.length === 0);
  const rows = maskCheatRows();
  ok(
    'the cheat sheet takes its suffixes from the catalog',
    rows.every((r, i) => r.suffix === MASK_KINDS[i].suffixes[0])
  );
  ok(
    'exactly the required masks are marked required',
    rows
      .filter((r) => r.required)
      .map((r) => r.id)
      .join() ===
      MASK_KINDS.filter((k) => k.required)
        .map((k) => k.id)
        .join()
  );
  ok('the table renders a row per mask', (maskCheatTableHtml().match(/<tr>/g) || []).length === MASK_KINDS.length + 1);
}

function runDrift({ ok }) {
  ok('the guide folder exists at the module root', existsSync(GUIDE_DIR));
  const manifest = JSON.parse(readFileSync(`${GUIDE_DIR}guide.json`, 'utf8'));
  const pageIds = manifest.pages.map((p) => p.id);
  ok('page ids are unique', new Set(pageIds).size === pageIds.length);
  ok(
    'both halves exist and their home pages exist',
    manifest.halves.length === 2 && manifest.halves.every((h) => pageIds.includes(h.home))
  );
  ok(
    'every page belongs to a half',
    manifest.pages.every((p) => manifest.halves.some((h) => h.id === p.half))
  );

  const files = readdirSync(`${GUIDE_DIR}pages`).filter((f) => f.endsWith('.md'));
  const orphan = files.map((f) => f.slice(0, -3)).filter((id) => !pageIds.includes(id));
  const absent = pageIds.filter((id) => !files.includes(`${id}.md`));
  ok(`every page has a file (missing: ${absent.join(', ') || 'none'})`, absent.length === 0);
  ok(`every file is listed in guide.json (unlisted: ${orphan.join(', ') || 'none'})`, orphan.length === 0);

  const images = existsSync(`${GUIDE_DIR}images`) ? readdirSync(`${GUIDE_DIR}images`) : [];
  const suffixes = new Set(MASK_KINDS.flatMap((k) => k.suffixes.map((s) => s.toLowerCase())));
  const usedImages = new Set();
  for (const p of manifest.pages) {
    if (p.thumb) {
      usedImages.add(p.thumb);
      ok(`${p.id}: its thumbnail exists`, images.includes(p.thumb));
    }
    if (!existsSync(`${GUIDE_DIR}pages/${p.id}.md`)) continue;
    const md = readFileSync(`${GUIDE_DIR}pages/${p.id}.md`, 'utf8');
    const r = renderGuideMarkdown(md);
    const badLinks = [...r.pageLinks, ...r.cards].filter((id) => !pageIds.includes(id));
    ok(
      `${p.id}: every page link and tile points at a real page (bad: ${badLinks.join(', ') || 'none'})`,
      badLinks.length === 0
    );
    const badActs = r.actions.filter((id) => !GUIDE_ACTION_IDS.includes(id));
    ok(`${p.id}: every button is a real guide button (bad: ${badActs.join(', ') || 'none'})`, badActs.length === 0);
    const badImgs = r.images.filter((i) => !images.includes(i));
    ok(`${p.id}: every image exists (missing: ${badImgs.join(', ') || 'none'})`, badImgs.length === 0);
    for (const i of r.images) usedImages.add(i);
    ok(`${p.id}: stays under ${WORD_BUDGET} words (has ${r.words})`, r.words <= WORD_BUDGET);
    // Mask endings written in prose: `_Name` inside backticks must be a real suffix.
    const named = [...md.matchAll(/`(_[A-Z][A-Za-z]+)`/g)].map((m) => m[1]);
    const unknown = named.filter((s) => !suffixes.has(s.toLowerCase()));
    ok(
      `${p.id}: every mask ending it names is real (unknown: ${[...new Set(unknown)].join(', ') || 'none'})`,
      unknown.length === 0
    );
    ok(
      `${p.id}: has a sources line (what it describes, for whoever updates it)`,
      typeof r.meta.sources === 'string' && r.meta.sources.length > 3
    );
  }
  const unused = images.filter((i) => !usedImages.has(i));
  ok(`every image in guide/images is used by a page (unused: ${unused.join(', ') || 'none'})`, unused.length === 0);
  let total = 0;
  for (const i of images) {
    const size = statSync(`${GUIDE_DIR}images/${i}`).size;
    total += size;
    ok(
      `image ${i} is WebP and under ${IMAGE_MAX_BYTES / 1024} KB (${Math.round(size / 1024)} KB)`,
      i.endsWith('.webp') && size <= IMAGE_MAX_BYTES
    );
  }
  ok(
    `all guide images together stay under ${IMAGE_BUDGET_BYTES / 1048576} MB (${(total / 1048576).toFixed(1)} MB)`,
    total <= IMAGE_BUDGET_BYTES
  );
}

export async function run(t) {
  runRenderer(t);
  await runActions(t);
  runMasks(t);
  runDrift(t);
}
