/**
 * tools/preview-shared/serve-foundry-css.mjs — serve Foundry's own `public/` folder (its
 * stylesheet and fonts) with CORS, so a preview harness can load the REAL core CSS:
 *
 *   node tools/preview-shared/serve-foundry-css.mjs            # http://localhost:8942/
 *   node tools/shader-lab/serve.mjs                            # the harness server (8934)
 *   http://localhost:8934/tools/remote-preview/index.html?foundry=http://localhost:8942/css/foundry2.css
 *
 * Why it exists: Foundry styles every bare `button`, `input`, `select`, `h2` and range input, and a
 * harness on a bare page hides all of it (see page-setup.js). The stylesheet ships inside the
 * Foundry install, not this repo, so the folder is found from `FOUNDRY_PUBLIC` or, by default, from
 * the sibling checkout this project is developed beside:
 *   ../foundryvttsourcecode_v14/Foundry Virtual Tabletop/resources/app/public
 * `Access-Control-Allow-Origin: *` is what lets control-audit.js READ the stylesheet's rules (the
 * `<link>` is loaded with `crossorigin="anonymous"`).
 *
 * ⚠️ DEV-ONLY, LOCALHOST-ONLY, READ-ONLY: it serves files out of one folder and nothing else
 * (paths are re-checked against the root after resolution), and it never writes.
 *
 * Env: `FOUNDRY_PUBLIC` — the folder to serve; `FOUNDRY_CSS_PORT` — default 8942.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_ROOT = resolve(
  here,
  '..',
  '..',
  '..',
  'foundryvttsourcecode_v14',
  'Foundry Virtual Tabletop',
  'resources',
  'app',
  'public'
);
const root = normalize(resolve(process.env.FOUNDRY_PUBLIC || DEFAULT_ROOT));
const port = Number(process.env.FOUNDRY_CSS_PORT || 8942);

if (!existsSync(join(root, 'css', 'foundry2.css'))) {
  console.error(`No css/foundry2.css under ${root}\nSet FOUNDRY_PUBLIC to Foundry's resources/app/public folder.`);
  process.exit(1);
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = normalize(join(root, decodeURIComponent(url.pathname)));
  const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (!path.startsWith(root)) {
    res.writeHead(403, headers).end('no');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, headers).end('not found');
  }
}).listen(port, 'localhost', () =>
  console.log(`Foundry public/ on http://localhost:${port}/ (css/foundry2.css)\n  from ${root}`)
);
