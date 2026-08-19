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
 * `in 45 minutes` / `in 3 days` / `2 days ago`. Luxon picks the unit and the
 * plural; `nowMs` is the base rather than the wall clock so the string is
 * deterministic. Sub-minute futures collapse to a phrase, since "in 0 minutes"
 * and "in 43 seconds" are both worse than "in under a minute" here.
 */
export function formatCountdown(epochMs: number, nowMs: number): string {
  const dt = DateTime.fromMillis(epochMs);
  if (!dt.isValid) return '';
  const delta = epochMs - nowMs;
  if (delta >= 0 && delta < 60_000) return 'in under a minute';
  return dt.toRelative({ base: DateTime.fromMillis(nowMs) }) ?? '';
}
