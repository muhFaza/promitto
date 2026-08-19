/**
 * Assertions for the humanized date helpers in src/lib/dates.ts.
 *
 * Not a test framework — the same plain-assertion, tsx-run convention as
 * backend/scripts/test-interaction-flush.ts. Run it after touching either
 * helper:
 *
 *   docker compose exec frontend npx tsx scripts/test-dates.ts
 *
 * These exist because this logic already shipped one real bug: formatCountdown
 * truncated to a single unit, so a schedule 1.87 days out rendered "in 1 day"
 * directly beneath a date that read two days out. The pair of helpers must
 * agree with each other, and only assertions pinned to a fixed `now` can prove
 * that.
 */
import { DateTime } from 'luxon';
import { formatCountdown, formatFriendly } from '../src/lib/dates';

const Z = 'Asia/Jakarta';
const at = (o: Record<string, number>) => DateTime.fromObject(o, { zone: Z }).toMillis();

let fail = 0;
const eq = (label: string, got: string, want: string) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} ${ok ? `"${got}"` : `got "${got}"  want "${want}"`}`,
  );
};

// ---------------------------------------------------------------- formatFriendly
{
  const NOW = at({ year: 2026, month: 8, day: 18, hour: 20, minute: 12 });
  eq('same day',      formatFriendly(at({ year: 2026, month: 8, day: 18, hour: 20, minute: 12 }), Z, NOW), 'Today · Tue 18 Aug · 20:12');
  eq('next day',      formatFriendly(at({ year: 2026, month: 8, day: 19, hour: 8, minute: 50 }), Z, NOW), 'Tomorrow · Wed 19 Aug · 08:50');
  eq('previous day',  formatFriendly(at({ year: 2026, month: 8, day: 17, hour: 9 }), Z, NOW), 'Yesterday · Mon 17 Aug · 09:00');
  eq('within a week', formatFriendly(at({ year: 2026, month: 8, day: 21, hour: 14 }), Z, NOW), 'Fri 21 Aug · 14:00');
  eq('beyond a week', formatFriendly(at({ year: 2026, month: 8, day: 25, hour: 9 }), Z, NOW), 'Tue 25 Aug · 09:00');
  eq('another year',  formatFriendly(at({ year: 2027, month: 8, day: 25, hour: 9 }), Z, NOW), 'Wed 25 Aug 2027 · 09:00');
}
{
  // Calendar-day boundaries, not 24h deltas: 23:00 -> 01:00 is "Tomorrow".
  const LATE = at({ year: 2026, month: 8, day: 18, hour: 23 });
  eq('23:00 -> 01:00', formatFriendly(at({ year: 2026, month: 8, day: 19, hour: 1 }), Z, LATE), 'Tomorrow · Wed 19 Aug · 01:00');
  const NYE = at({ year: 2026, month: 12, day: 31, hour: 22 });
  eq('across new year', formatFriendly(at({ year: 2027, month: 1, day: 1, hour: 9 }), Z, NYE), 'Tomorrow · Fri 1 Jan 2027 · 09:00');
}

// --------------------------------------------------------------- formatCountdown
{
  // Pinned to the exact moment of the reported bug.
  const NOW = at({ year: 2026, month: 8, day: 19, hour: 12, minute: 11, second: 51 });

  // REGRESSION: this rendered "in 1 day" beside a date reading two days out.
  eq('regression: 1.87 days', formatCountdown(at({ year: 2026, month: 8, day: 21, hour: 9, minute: 6 }), NOW, Z), 'in 1d 20h');

  // Under a day: hours + minutes.
  eq('sub-minute',      formatCountdown(NOW + 30_000, NOW, Z), 'in under a minute');
  eq('minutes only',    formatCountdown(NOW + 45 * 60_000, NOW, Z), 'in 45m');
  eq('hours + minutes', formatCountdown(NOW + (5 * 60 + 20) * 60_000, NOW, Z), 'in 5h 20m');
  eq('whole hours',     formatCountdown(NOW + 5 * 3_600_000, NOW, Z), 'in 5h');

  // Under a week: days + hours.
  eq('days + hours',    formatCountdown(NOW + (2 * 24 + 6) * 3_600_000, NOW, Z), 'in 2d 6h');
  eq('whole days',      formatCountdown(NOW + 2 * 24 * 3_600_000, NOW, Z), 'in 2d');
  eq('six days',        formatCountdown(NOW + (6 * 24 + 3) * 3_600_000, NOW, Z), 'in 6d 3h');

  // A week or more: one coarse unit, rounded.
  eq('exactly a week',  formatCountdown(NOW + 7 * 24 * 3_600_000, NOW, Z), 'in 1 week');
  eq('ten days',        formatCountdown(NOW + 10 * 24 * 3_600_000, NOW, Z), 'in 1 week');
  // Gated on the UNROUNDED month count: rounding first would call this "1 month".
  eq('25 days',         formatCountdown(NOW + 25 * 24 * 3_600_000, NOW, Z), 'in 4 weeks');
  eq('a month + days',  formatCountdown(at({ year: 2026, month: 9, day: 24, hour: 12, minute: 11, second: 51 }), NOW, Z), 'in 1 month');
  eq('exactly a month', formatCountdown(at({ year: 2026, month: 9, day: 19, hour: 12, minute: 11, second: 51 }), NOW, Z), 'in 1 month');
  eq('six months',      formatCountdown(at({ year: 2027, month: 2, day: 21, hour: 12, minute: 11, second: 51 }), NOW, Z), 'in 6 months');
  eq('just over a year',formatCountdown(at({ year: 2027, month: 9, day: 19, hour: 12, minute: 11, second: 51 }), NOW, Z), 'in 1 year');
  eq('two years',       formatCountdown(at({ year: 2028, month: 2, day: 21, hour: 12, minute: 11, second: 51 }), NOW, Z), 'in 2 years');

  // The past mirrors the same shape.
  eq('past minutes',      formatCountdown(NOW - 45 * 60_000, NOW, Z), '45m ago');
  eq('past days + hours', formatCountdown(NOW - (2 * 24 + 6) * 3_600_000, NOW, Z), '2d 6h ago');
  eq('past weeks',        formatCountdown(NOW - 10 * 24 * 3_600_000, NOW, Z), '1 week ago');
  eq('past sub-minute',   formatCountdown(NOW - 30_000, NOW, Z), 'just now');

  // Degenerate input must never throw.
  eq('NaN', formatCountdown(NaN, NOW, Z), '');
}

console.log(fail === 0 ? '\nOK all assertions passed' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
