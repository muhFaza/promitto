export function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

let cachedList: readonly string[] | null = null;

export function listTimezones(): readonly string[] {
  if (cachedList) return cachedList;

  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };

  if (typeof intl.supportedValuesOf === 'function') {
    cachedList = Object.freeze(intl.supportedValuesOf('timeZone'));
  } else {
    cachedList = Object.freeze([
      'UTC',
      'Asia/Jakarta',
      'Asia/Singapore',
      'Asia/Tokyo',
      'Asia/Shanghai',
      'Europe/London',
      'Europe/Berlin',
      'America/New_York',
      'America/Los_Angeles',
    ]);
  }
  return cachedList;
}
