import { ordinalString, formatThemedDate, formatThemedTime } from '../format.js';

/** A tiny stand-in calendar shape — enough for format.js's lookups. */
const CAL = {
  months: { values: [{ name: 'January' }, { name: 'February' }, { name: 'August' }] },
  days: { values: [{ name: 'Sunday' }, { name: 'Monday' }] },
};

export function run(t) {
  // ---- ordinalString: the 11/12/13 exception is the whole test -----------
  {
    const cases = {
      1: '1st',
      2: '2nd',
      3: '3rd',
      4: '4th',
      10: '10th',
      11: '11th',
      12: '12th',
      13: '13th',
      21: '21st',
      22: '22nd',
      23: '23rd',
      24: '24th',
      101: '101st',
      111: '111th',
      112: '112th',
      113: '113th',
    };
    let ok = true;
    for (const [n, expected] of Object.entries(cases)) {
      const got = ordinalString(Number(n));
      if (got !== expected) {
        ok = false;
        console.error(`  ordinalString(${n}) = ${got}, expected ${expected}`);
      }
    }
    t.ok('ordinalString handles the 1st/2nd/3rd/nth rule AND the 11th/12th/13th exception', ok);
  }

  // ---- formatThemedDate, no theme (Earth's own base names) ---------------
  {
    const components = { year: 2026, month: 2, dayOfMonth: 16, dayOfWeek: 1, hour: 0, minute: 0, second: 0 };
    const s = formatThemedDate(components, CAL);
    t.ok(
      `no-theme format uses the calendar's OWN names and no trailing era space ("${s}")`,
      s === 'Monday, 17th of August, 2026'
    );
  }

  // ---- formatThemedDate, PF2E-shaped theme (AR) ---------------------------
  {
    const components = { year: 2026, month: 2, dayOfMonth: 16, dayOfWeek: 1, hour: 0, minute: 0, second: 0 };
    const AR = {
      id: 'AR',
      yearOffset: 2700,
      eraLabel: 'AR',
      monthNames: { August: 'Arodus' },
      weekdayNames: { Monday: 'Moonday' },
    };
    const s = formatThemedDate(components, CAL, AR);
    t.ok(
      `AR theme applies name mapping + year offset + trailing era ("${s}")`,
      s === 'Moonday, 17th of Arodus, 4726 AR'
    );
  }

  // ---- formatThemedDate, a theme with NO era label (CE) -------------------
  {
    const components = { year: 2026, month: 2, dayOfMonth: 16, dayOfWeek: 1, hour: 0, minute: 0, second: 0 };
    const CE = { id: 'CE', yearOffset: 0, eraLabel: '' };
    const s = formatThemedDate(components, CAL, CE);
    t.ok(`an empty eraLabel produces NO trailing space ("${s}")`, s === 'Monday, 17th of August, 2026');
  }

  // ---- a theme name mapping falls back to the base name when absent -------
  {
    const components = { year: 2026, month: 0, dayOfMonth: 0, dayOfWeek: 0, hour: 0, minute: 0, second: 0 };
    const PARTIAL = { id: 'X', yearOffset: 0, eraLabel: 'X', monthNames: { August: 'Arodus' } }; // no January mapping
    const s = formatThemedDate(components, CAL, PARTIAL);
    t.ok(`an unmapped month name falls back to the base name ("${s}")`, s.includes('of January,'));
  }

  // ---- formatThemedTime: 24h and 12h, incl. midnight/noon edge cases -----
  {
    t.ok('24h: 14:30:45', formatThemedTime({ hour: 14, minute: 30, second: 45 }) === '14:30:45');
    t.ok('24h: zero-padded 03:05:09', formatThemedTime({ hour: 3, minute: 5, second: 9 }) === '03:05:09');
    t.ok(
      '12h: 2:30:45 PM',
      formatThemedTime({ hour: 14, minute: 30, second: 45 }, { convention: 12 }) === '2:30:45 PM'
    );
    t.ok(
      '12h midnight is 12:00:00 AM, not 0:00:00 AM',
      formatThemedTime({ hour: 0, minute: 0, second: 0 }, { convention: 12 }) === '12:00:00 AM'
    );
    t.ok(
      '12h noon is 12:00:00 PM, not 0:00:00 PM',
      formatThemedTime({ hour: 12, minute: 0, second: 0 }, { convention: 12 }) === '12:00:00 PM'
    );
    t.ok(
      '12h 11:59 PM edge',
      formatThemedTime({ hour: 23, minute: 59, second: 0 }, { convention: 12 }) === '11:59:00 PM'
    );
  }
}
