/**
 * ui/rooms/guide/guide-markdown.js — the guide's small Markdown renderer.
 *
 * The guide's pages are plain Markdown files in `guide/pages/` (mmp-0mv, Ingram
 * 2026-11-07: "Format is markdown, images are Webp"). This turns one page into
 * safe HTML for the Guide room. Pure: no DOM, no Foundry, so it is tested in
 * Node and the drift tests can read every page with the same parser the room uses.
 *
 * WHAT IT UNDERSTANDS (and nothing else — a guide page is meant to stay simple):
 *   front matter    `---` key: value lines `---` at the very top
 *   headings        `#`, `##`, `###` (ids from the text, for deep links)
 *   paragraphs, `**bold**`, `*italic*`, `` `code` ``, `[text](target)` links
 *   lists           `- item` and `1. item` (one level)
 *   tables          `| a | b |` rows, the second row `|---|---|`
 *   rules           a line of `---` after the front matter
 *   callouts        `> [!tip] text`, `> [!warn]`, `> [!note]`, `> [!try]` (more `>` lines continue it)
 *   figures         a line that is only `![alt](file "caption")`
 *   compare         `::: compare "caption"` then two image lines then `:::` — a drag slider
 *   gallery         `::: gallery` then image lines then `:::` — a grid of figures
 *   action buttons  `[[do: id, id]]` on its own line — the room fills them in (guide-actions.js)
 *   live blocks     `[[looks]]`, `[[masks-table]]`, `[[settings: effectId]]` — filled in by the room from live data
 *   page cards      `[[cards: page-id, page-id]]` — big link tiles to other pages
 *
 * Link targets: `page:<id>` (another guide page), `page:<id>#anchor`, `#anchor`
 * (this page), or an absolute http(s) URL (opens a new tab). Anything else is
 * rendered as plain text, so a typo can never become a javascript: link.
 *
 * @module ui/rooms/guide/guide-markdown
 */

/** Escape text for HTML element content and attribute values. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A heading's anchor id: lower case, words joined by `-`. */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Split `---` front matter off the top of a page.
 * @param {string} md
 * @returns {{meta: Record<string, string>, body: string}}
 */
export function parseFrontMatter(md) {
  const text = String(md ?? '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { meta: {}, body: text };
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  const after = text.slice(end + 4);
  return { meta, body: after.startsWith('\n') ? after.slice(1) : after };
}

/**
 * Resolve a link target into `{href, kind}`; `null` for anything not allowed.
 * @param {string} target
 */
export function resolveLink(target) {
  const t = String(target ?? '').trim();
  let m = t.match(/^page:([a-z0-9-]+)(?:#([a-z0-9-]+))?$/);
  if (m) return { kind: 'page', page: m[1], anchor: m[2] ?? null };
  m = t.match(/^#([a-z0-9-]+)$/);
  if (m) return { kind: 'anchor', anchor: m[1] };
  if (/^https?:\/\/[^\s"'<>]+$/i.test(t)) return { kind: 'external', href: t };
  return null;
}

/** Inline formatting: code first (its contents stay literal), then links, bold, italic. */
export function renderInline(text, ctx = {}) {
  const codes = [];
  let s = String(text ?? '').replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `${codes.length - 1}`;
  });
  const links = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, target) => {
    const r = resolveLink(target);
    const inner = renderInline(label, ctx);
    let html;
    if (!r) html = inner;
    else if (r.kind === 'page') {
      ctx.pageLinks?.push(r.page);
      html = `<a class="g-link" data-page="${escapeHtml(r.page)}"${
        r.anchor ? ` data-anchor="${escapeHtml(r.anchor)}"` : ''
      } href="#">${inner}</a>`;
    } else if (r.kind === 'anchor')
      html = `<a class="g-link" data-anchor="${escapeHtml(r.anchor)}" href="#">${inner}</a>`;
    else
      html = `<a class="g-link g-ext" href="${escapeHtml(r.href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    links.push(html);
    return `${links.length - 1}`;
  });
  s = escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  // Private-use placeholders (U+E000/U+E001) hold code and links aside while the rest is escaped.
  return s.replace(/(\d+)/g, (_, i) => links[Number(i)]).replace(/(\d+)/g, (_, i) => codes[Number(i)]);
}

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/;
const ACTIONS_LINE = /^\[\[do:\s*([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)\s*\]\]\s*$/;
const CARDS_LINE = /^\[\[cards:\s*([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)\s*\]\]\s*$/;
const LIVE_LINE = /^\[\[(looks|masks-table)\]\]\s*$/;
const SETTINGS_LINE = /^\[\[settings:\s*([a-zA-Z]+)\s*\]\]\s*$/;
const CALLOUT_KINDS = new Set(['tip', 'warn', 'note', 'try']);
const CALLOUT_TITLES = { tip: 'Tip', warn: 'Watch out', note: 'Good to know', try: 'Try it' };

/** Only plain file names (or sub-paths) under the guide's image folder — never a URL. */
export function isSafeImagePath(p) {
  return /^[a-z0-9][a-z0-9/_-]*\.(webp|png|jpg|svg)$/i.test(String(p ?? '')) && !String(p).includes('..');
}

function figureHtml(alt, src, caption, ctx) {
  if (!isSafeImagePath(src)) return `<p class="g-bad">Image not shown: ${escapeHtml(src)}</p>`;
  ctx.images?.push(src);
  const url = escapeHtml(ctx.imageUrl ? ctx.imageUrl(src) : src);
  const cap = caption ? `<figcaption>${renderInline(caption, ctx)}</figcaption>` : '';
  return `<figure class="g-fig"><img src="${url}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">${cap}</figure>`;
}

function compareHtml(images, caption, ctx) {
  if (images.length !== 2 || !images.every((im) => isSafeImagePath(im.src))) {
    return '<p class="g-bad">A compare block needs exactly two images.</p>';
  }
  for (const im of images) ctx.images?.push(im.src);
  const [a, b] = images.map((im) => ({ ...im, url: escapeHtml(ctx.imageUrl ? ctx.imageUrl(im.src) : im.src) }));
  const cap = caption ? `<figcaption>${renderInline(caption, ctx)}</figcaption>` : '';
  return (
    `<figure class="g-compare" style="--split:50%">` +
    `<div class="g-compare-frame">` +
    `<img class="g-compare-b" src="${b.url}" alt="${escapeHtml(b.alt)}" loading="lazy" decoding="async">` +
    `<div class="g-compare-a"><img src="${a.url}" alt="${escapeHtml(a.alt)}" loading="lazy" decoding="async"></div>` +
    `<span class="g-compare-tag g-compare-tag-a">${escapeHtml(a.alt)}</span>` +
    `<span class="g-compare-tag g-compare-tag-b">${escapeHtml(b.alt)}</span>` +
    `<span class="g-compare-handle" aria-hidden="true"></span>` +
    `<input class="g-compare-range" type="range" min="0" max="100" value="50" aria-label="Drag to compare ${escapeHtml(
      a.alt
    )} with ${escapeHtml(b.alt)}">` +
    `</div>${cap}</figure>`
  );
}

function tableHtml(rows, ctx) {
  const cells = (row) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return (
    `<div class="g-table-wrap"><table class="g-table"><thead><tr>${head
      .map((c) => `<th>${renderInline(c, ctx)}</th>`)
      .join('')}</tr></thead><tbody>` +
    body.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, ctx)}</td>`).join('')}</tr>`).join('') +
    `</tbody></table></div>`
  );
}

/**
 * Render one guide page.
 * @param {string} md
 * @param {{imageUrl?: (file: string) => string}} [opts]
 * @returns {{meta: Record<string,string>, html: string, headings: Array<{level:number,text:string,id:string}>,
 *   actions: string[], cards: string[], pageLinks: string[], images: string[], live: string[], words: number}}
 */
export function renderGuideMarkdown(md, opts = {}) {
  const { meta, body } = parseFrontMatter(md);
  const ctx = { imageUrl: opts.imageUrl, pageLinks: [], images: [] };
  const out = [];
  const headings = [];
  const actions = [];
  const cards = [];
  const live = [];
  const settings = [];
  const usedIds = new Set();
  let words = 0;
  const lines = body.split('\n');
  let para = [];
  let list = null; // {type:'ul'|'ol', items:[]}

  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(' ');
    words += text.split(/\s+/).filter(Boolean).length;
    out.push(`<p>${renderInline(text, ctx)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    for (const it of list.items) words += it.split(/\s+/).filter(Boolean).length;
    out.push(`<${list.type}>${list.items.map((it) => `<li>${renderInline(it, ctx)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    let m;
    if ((m = trimmed.match(/^(#{1,3})\s+(.+)$/))) {
      flush();
      const level = m[1].length;
      let id = slugify(m[2]) || `section-${headings.length + 1}`;
      while (usedIds.has(id)) id += '-x';
      usedIds.add(id);
      headings.push({ level, text: m[2], id });
      words += m[2].split(/\s+/).length;
      out.push(`<h${level + 1} id="g-${id}">${renderInline(m[2], ctx)}</h${level + 1}>`);
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      flush();
      out.push('<hr>');
      continue;
    }
    if ((m = trimmed.match(ACTIONS_LINE))) {
      flush();
      const ids = m[1].split(',').map((s) => s.trim());
      actions.push(...ids);
      out.push(`<div class="g-actions" data-actions="${escapeHtml(ids.join(','))}"></div>`);
      continue;
    }
    if ((m = trimmed.match(CARDS_LINE))) {
      flush();
      const ids = m[1].split(',').map((s) => s.trim());
      cards.push(...ids);
      out.push(`<div class="g-cards" data-cards="${escapeHtml(ids.join(','))}"></div>`);
      continue;
    }
    if ((m = trimmed.match(SETTINGS_LINE))) {
      flush();
      settings.push(m[1]);
      out.push(`<div class="g-live" data-live="settings" data-effect="${escapeHtml(m[1])}"></div>`);
      continue;
    }
    if ((m = trimmed.match(LIVE_LINE))) {
      flush();
      live.push(m[1]);
      out.push(`<div class="g-live" data-live="${m[1]}"></div>`);
      continue;
    }
    if ((m = trimmed.match(IMAGE_LINE))) {
      flush();
      out.push(figureHtml(m[1], m[2], m[3], ctx));
      continue;
    }
    if ((m = trimmed.match(/^:::\s*(compare|gallery)(?:\s+"([^"]*)")?\s*$/))) {
      flush();
      const kind = m[1];
      const caption = m[2] ?? '';
      const images = [];
      i++;
      for (; i < lines.length && lines[i].trim() !== ':::'; i++) {
        const im = lines[i].trim().match(IMAGE_LINE);
        if (im) images.push({ alt: im[1], src: im[2], caption: im[3] ?? '' });
      }
      if (kind === 'compare') out.push(compareHtml(images, caption, ctx));
      else
        out.push(
          `<div class="g-gallery">${images.map((im) => figureHtml(im.alt, im.src, im.caption, ctx)).join('')}</div>`
        );
      continue;
    }
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      flush();
      const rows = [];
      for (; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(lines[i]);
      i--;
      for (const r of rows) words += r.replace(/[|-]/g, ' ').split(/\s+/).filter(Boolean).length;
      out.push(tableHtml(rows, ctx));
      continue;
    }
    if ((m = trimmed.match(/^>\s*\[!(\w+)\]\s*(.*)$/)) && CALLOUT_KINDS.has(m[1].toLowerCase())) {
      flush();
      const kind = m[1].toLowerCase();
      const parts = [m[2]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim()) && !/^>\s*\[!/.test(lines[i + 1].trim())) {
        i++;
        parts.push(lines[i].trim().replace(/^>\s?/, ''));
      }
      const text = parts.join(' ').trim();
      words += text.split(/\s+/).filter(Boolean).length;
      out.push(
        `<aside class="g-callout g-callout-${kind}"><span class="g-callout-title">${CALLOUT_TITLES[kind]}</span><p>${renderInline(
          text,
          ctx
        )}</p></aside>`
      );
      continue;
    }
    if ((m = trimmed.match(/^(-|\*|\d+\.)\s+(.+)$/))) {
      flushPara();
      const type = /^\d/.test(m[1]) ? 'ol' : 'ul';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${trimmed}`;
      continue;
    }
    flushList();
    para.push(trimmed);
  }
  flush();
  return {
    meta,
    html: out.join('\n'),
    headings,
    actions,
    cards,
    pageLinks: ctx.pageLinks,
    images: ctx.images,
    live,
    settings,
    words,
  };
}

/**
 * Plain text of a page for search (headings + body, markup stripped).
 * @param {string} md
 */
export function guideSearchText(md) {
  const { body } = parseFrontMatter(md);
  return body
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[!\w+\]/g, ' ')
    .replace(/^:::.*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`|_:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
