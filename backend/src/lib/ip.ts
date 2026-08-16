/**
 * Reduce a client IP to a coarse network prefix before it is persisted.
 * We keep enough to distinguish networks for debugging and drop enough that a
 * stored session row no longer identifies a household. Rate limiting is
 * in-memory and keeps using the full address; only the DB sees this.
 */
export function anonymizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;

  // Express reports IPv4-mapped IPv6 as "::ffff:1.2.3.4".
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  if (mapped.includes('.') && !mapped.includes(':')) {
    const parts = mapped.split('.');
    if (parts.length !== 4 || parts.some((p) => p === '' || Number.isNaN(Number(p)))) {
      return null;
    }
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }

  if (mapped.includes(':')) {
    const expanded = expandIpv6(mapped);
    if (!expanded) return null;
    return `${expanded.slice(0, 3).join(':')}::/48`;
  }

  return null;
}

function expandIpv6(ip: string): string[] | null {
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  if (ip.includes('::')) {
    const fill = 8 - headParts.length - tailParts.length;
    if (fill < 0) return null;
    return [...headParts, ...Array(fill).fill('0'), ...tailParts];
  }
  const parts = ip.split(':');
  return parts.length === 8 ? parts : null;
}
