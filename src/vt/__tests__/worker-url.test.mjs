/**
 * worker-url.js (#618): page-relative asset paths must resolve against the
 * PAGE inside a worker, and absolute/root-absolute ones must not move.
 */
import { resolveAgainstPage, pageBaseUrl } from '../worker-url.js';

export function run(t) {
  const { ok } = t;
  const base = 'http://localhost:30000/game';
  ok('page-relative resolves to the site root, not the worker folder',
    resolveAgainstPage('modules/m/assets/a_Bush.webp', base) === 'http://localhost:30000/modules/m/assets/a_Bush.webp');
  ok('root-absolute is unchanged in meaning',
    resolveAgainstPage('/modules/m/a.webp', base) === 'http://localhost:30000/modules/m/a.webp');
  ok('fully absolute is untouched',
    resolveAgainstPage('https://cdn.example.com/a.webp', base) === 'https://cdn.example.com/a.webp');
  ok('route prefix respected',
    resolveAgainstPage('modules/m/a.webp', 'https://host/foundry/game') === 'https://host/foundry/modules/m/a.webp');
  ok('no base = passthrough', resolveAgainstPage('modules/m/a.webp', null) === 'modules/m/a.webp');
  ok('non-string passthrough', resolveAgainstPage(undefined, base) === undefined);
  ok('no document -> null base', pageBaseUrl() === null);
}
