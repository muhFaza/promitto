import { DateTime } from 'luxon';

export function formatInZone(epochMs: number, zone: string): string {
  return DateTime.fromMillis(epochMs).setZone(zone).toFormat('yyyy-LL-dd HH:mm:ss');
}

export function formatRelative(epochMs: number): string {
  const dt = DateTime.fromMillis(epochMs);
  const rel = dt.toRelative();
  return rel ?? dt.toISO() ?? '';
}

/** Parse a `datetime-local` input value ("YYYY-MM-DDTHH:mm") in a given IANA zone → UTC epoch ms. */
export function parseLocalInputInZone(value: string, zone: string): number | null {
  const dt = DateTime.fromFormat(value, "yyyy-LL-dd'T'HH:mm", { zone });
  if (!dt.isValid) return null;
  return dt.toUTC().toMillis();
}

/** Now + offset minutes, formatted for `datetime-local` default in a given IANA zone. */
export function nowInZoneForInput(zone: string, offsetMinutes = 5): string {
  return DateTime.now()
    .setZone(zone)
    .plus({ minutes: offsetMinutes })
    .toFormat("yyyy-LL-dd'T'HH:mm");
}

/** Convert epoch ms to the "YYYY-MM-DDTHH:mm" format used by `datetime-local` inputs. */
export function epochToLocalInput(epochMs: number, zone: string): string {
  return DateTime.fromMillis(epochMs).setZone(zone).toFormat("yyyy-LL-dd'T'HH:mm");
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function pluralize(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Human-readable absolute time: `Tomorrow · Wed 19 Aug · 08:50`.
 *
 * The relative word is a prefix to a real date, never a replacement for it —
 * the date stays visible, and the prefix drops out once the weekday is spelled
 * out anyway. Day comparison is on calendar-day boundaries in `zone`, not on a
 * 24h delta: 23:00 today vs 01:00 tomorrow reads as "Tomorrow", not "in 2h".
 * The year is appended only when it differs from the current one.
 *
 * `nowMs` is injectable so the output is deterministic; callers pass nothing.
 */
export function formatFriendly(epochMs: number, zone: string, nowMs = Date.now()): string {
  const dt = DateTime.fromMillis(epochMs).setZone(zone);
  if (!dt.isValid) return '';
  const now = DateTime.fromMillis(nowMs).setZone(zone);

  const dayDelta = dt.startOf('day').diff(now.startOf('day'), 'days').days;
  const prefix =
    dayDelta === 0 ? 'Today · ' : dayDelta === 1 ? 'Tomorrow · ' : dayDelta === -1 ? 'Yesterday · ' : '';

  const datePart = dt.toFormat(dt.year === now.year ? 'EEE d LLL' : 'EEE d LLL yyyy');
  return `${prefix}${datePart} · ${dt.toFormat('HH:mm')}`;
}

/**
 * How long until (or since) `epochMs`, e.g. `in 1d 20h` / `in 5h 20m` / `in 3 weeks`.
 *
 * Under a week this shows TWO units, and that is the whole point: a single
 * truncated unit silently disagrees with the date rendered beside it. `Wed 19
 * Aug 12:11` → `Fri 21 Aug 09:06` is 1.87 days, which truncates to "in 1 day"
 * while the date next to it plainly reads two days out. Carrying the residual
 * (`in 1d 20h`) makes the two lines agree by construction.
 *
 * Past a week the second unit stops earning its place — nobody acts on the
 * difference between `1mo 5d` and `1mo 6d`, and the exact date is already on
 * the line above — so it collapses to one coarse, calendar-aware unit. That
 * unit is ROUNDED, not floored: flooring is the same systematic understatement
 * that caused the bug above, so 25 days reads `in 4 weeks`, not `in 3 weeks`.
 *
 * `nowMs` is the base rather than the wall clock so the output is deterministic.
 * `zone` matters only for the calendar-aware branch, where month and year
 * lengths depend on the calendar the user is actually reading.
 */
export function formatCountdown(epochMs: number, nowMs: number, zone: string): string {
  if (!Number.isFinite(epochMs) || !Number.isFinite(nowMs)) return '';
  const target = DateTime.fromMillis(epochMs).setZone(zone);
  const now = DateTime.fromMillis(nowMs).setZone(zone);
  if (!target.isValid || !now.isValid) return '';

  const future = epochMs >= nowMs;
  const abs = Math.abs(epochMs - nowMs);
  if (abs < MINUTE_MS) return future ? 'in under a minute' : 'just now';

  let body: string;
  if (abs < WEEK_MS) {
    if (abs < HOUR_MS) {
      body = `${Math.floor(abs / MINUTE_MS)}m`;
    } else if (abs < DAY_MS) {
      const h = Math.floor(abs / HOUR_MS);
      const m = Math.floor((abs % HOUR_MS) / MINUTE_MS);
      body = m ? `${h}h ${m}m` : `${h}h`;
    } else {
      const d = Math.floor(abs / DAY_MS);
      const h = Math.floor((abs % DAY_MS) / HOUR_MS);
      body = h ? `${d}d ${h}h` : `${d}d`;
    }
  } else {
    // Calendar-aware: earlier instant first, so the diff is always positive.
    const [from, to] = future ? [now, target] : [target, now];
    // Gate on the UNROUNDED month count. Rounding first would promote 25 days
    // (0.81 months) to "1 month", overstating by nearly a week — the weeks
    // branch has to own everything below a real month.
    const months = to.diff(from, 'months').months;
    if (months >= 12) {
      body = pluralize(Math.round(to.diff(from, 'years').years), 'year');
    } else if (months >= 1) {
      const rounded = Math.round(months);
      // 11.6 months rounds to 12, which reads better as a year than "12 months".
      body = rounded >= 12 ? pluralize(1, 'year') : pluralize(rounded, 'month');
    } else {
      body = pluralize(Math.round(to.diff(from, 'weeks').weeks), 'week');
    }
  }

  return future ? `in ${body}` : `${body} ago`;
}
