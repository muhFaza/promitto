/**
 * Reduce a client IP to a coarse network prefix before it is persisted.
 * We keep enough to distinguish networks for debugging and drop enough that a
 * stored session row no longer identifies a household. Rate limiting is
 * in-memory and keeps using the full address; only the DB sees this.
 *
 * Parsing is deliberately strict: `null` means "we could not tell what network
 * this is", which is always safe to store, whereas a prefix fabricated from a
 * malformed input (`999.2.3.4`, `0x10.2.3.4`) is a fact about a network that
 * does not exist. Every rejection path returns `null` rather than guessing.
 */
export function anonymizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;

  let host = ip.trim();
  if (!host) return null;

  // Bracketed forms: "[::1]" and "[::1]:443". Anything after the bracket that
  // is not a plain port is not an address we understand.
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close === -1) return null;
    const rest = host.slice(close + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return null;
    host = host.slice(1, close);
  }

  // Zone identifier ("fe80::1%eth0") is a local interface name, not part of the
  // address, and would otherwise poison the last group. Zones are IPv6-only, so
  // the flag is carried down to reject IPv4 that arrived with one: stripping
  // first and asking later would turn "1.2.3.4%not-a-zone" into a confident
  // "1.2.3.0/24" for an input we do not actually understand.
  const zone = host.indexOf('%');
  const hadZone = zone !== -1;
  if (hadZone) host = host.slice(0, zone);
  if (!host) return null;

  // "1.2.3.4:5678" — only stripped when the host half is itself a dotted quad,
  // so a bare IPv6 (which is all colons) is never mangled here.
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(host);
  if (v4WithPort) host = v4WithPort[1] as string;

  // Express reports IPv4-mapped IPv6 as "::ffff:1.2.3.4"; the prefix is
  // hex, so it can arrive upper-cased. If the remainder is not a dotted quad
  // (e.g. "::ffff:102:304") we fall through and parse it as plain IPv6.
  if (host.toLowerCase().startsWith('::ffff:')) {
    const v4 = parseIpv4(host.slice(7));
    if (v4) return hadZone ? null : `${v4[0]}.${v4[1]}.${v4[2]}.0/24`;
  }

  // Every IPv4 exit is gated on hadZone, including the "1.2.3.4:5678" form the
  // port strip above rewrites into one.
  const v4 = parseIpv4(host);
  if (v4) return hadZone ? null : `${v4[0]}.${v4[1]}.${v4[2]}.0/24`;

  if (host.includes(':')) {
    const expanded = expandIpv6(host);
    if (!expanded) return null;
    return `${expanded.slice(0, 3).join(':')}::/48`;
  }

  return null;
}

/**
 * Four groups of 1-3 ASCII digits, each 0-255. `\d` is ASCII-only in JS, so
 * this rejects the whole family of things `Number()` would happily accept:
 * "0x10", "+1", "-1", " 1", "1e2", "" and unicode digits.
 */
function parseIpv4(ip: string): string[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (Number(p) > 255) return null;
  }
  return parts;
}

/** Expand to exactly 8 groups, or null. Only one "::" is legal, ever. */
function expandIpv6(ip: string): string[] | null {
  const isGroup = (p: string): boolean => /^[0-9a-fA-F]{1,4}$/.test(p);

  const dbl = ip.indexOf('::');
  if (dbl !== -1) {
    // A second "::" (including ":::") makes the elision ambiguous — reject
    // rather than silently reading only the first two split components.
    if (ip.indexOf('::', dbl + 1) !== -1) return null;

    const head = ip.slice(0, dbl);
    const tail = ip.slice(dbl + 2);
    const headParts = head === '' ? [] : head.split(':');
    const tailParts = tail === '' ? [] : tail.split(':');
    if (!headParts.every(isGroup) || !tailParts.every(isGroup)) return null;

    const fill = 8 - headParts.length - tailParts.length;
    // "::" must stand for at least one elided group.
    if (fill < 1) return null;
    return [...headParts, ...(Array(fill).fill('0') as string[]), ...tailParts];
  }

  const parts = ip.split(':');
  if (parts.length !== 8 || !parts.every(isGroup)) return null;
  return parts;
}
