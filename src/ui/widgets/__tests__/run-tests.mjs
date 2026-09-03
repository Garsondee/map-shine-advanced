/**
 * src/ui/widgets/ verification — the reusable LANTERN widget canon (U0,
 * docs/holy/UI-Testament.md §9): icons, the param-control type→widget
 * dispatch's pure half, and the pure category/FOH-ROH/snapshot logic every
 * card shell shares.
 */
import { run as runIconSprite } from './icon-sprite.test.mjs';
import { run as runParamControl } from './param-control.test.mjs';
import { run as runParamGroups } from './param-groups.test.mjs';
import { run as runFineDrag } from './fine-drag.test.mjs';

let passed = 0;
let failed = 0;
const fails = [];
const t = {
  ok(name, cond) {
    if (cond) passed++;
    else {
      failed++;
      fails.push(name);
      console.error('  FAIL:', name);
    }
  },
};

const suites = [
  ['icon-sprite', runIconSprite],
  ['param-control', runParamControl],
  ['param-groups', runParamGroups],
  ['fine-drag', runFineDrag],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : `${failed - before} FAILED`}`);
}

console.log(`\nsrc/ui/widgets verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
