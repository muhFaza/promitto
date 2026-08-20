/**
 * Compare two dotted numeric versions. Returns >0 if `a` is newer than `b`,
 * <0 if older, 0 if equal or if either side cannot be parsed.
 *
 * Lives in `lib/` with no imports so it stays pure and directly testable —
 * `modules/version/service.ts` pulls in `env` and the network, neither of which
 * belongs in a comparison.
 *
 * Deliberately not a semver library. The only question asked of it is "is the
 * release tag on GitHub ahead of the version in package.json", both strings are
 * produced by this project, and anything unparseable returns 0 — which reads as
 * "no update available" rather than nagging every user forever over a tag
 * nobody anticipated.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] | null => {
    const cleaned = v.trim().replace(/^v/i, '');
    // Drop any pre-release or build suffix; only release cores are ranked.
    const core = cleaned.split(/[-+]/)[0] ?? '';
    if (!/^\d+(\.\d+)*$/.test(core)) return null;
    return core.split('.').map((n) => Number.parseInt(n, 10));
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
