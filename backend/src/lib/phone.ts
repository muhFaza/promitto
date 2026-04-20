import { parsePhoneNumberFromString } from 'libphonenumber-js';

export type NormalizedPhone = {
  e164: string;
  jid: string;
  digits: string;
};

/**
 * Normalize a user-entered phone string to E.164 + Baileys JID.
 * Indonesian numbers are the default when no country prefix is present
 * (`0812…` and `62812…` both → `+62812…`).
 * Anything starting with `+` is parsed as-is.
 */
export function normalizeToE164(input: string): NormalizedPhone | null {
  const cleaned = input.trim();
  if (!cleaned) return null;
  const parsed = parsePhoneNumberFromString(cleaned, 'ID');
  if (!parsed || !parsed.isValid()) return null;
  const e164 = parsed.format('E.164');
  const digits = e164.replace(/^\+/, '');
  return { e164, jid: `${digits}@s.whatsapp.net`, digits };
}
