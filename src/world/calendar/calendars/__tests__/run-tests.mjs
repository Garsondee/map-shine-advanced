/** src/world/calendar/calendars/ verification — the shipped calendar data. */
import { run as runCalendars } from './calendars.test.mjs';

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

runCalendars(t);

console.log(`\nsrc/world/calendar/calendars verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
