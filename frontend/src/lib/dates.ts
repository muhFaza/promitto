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
