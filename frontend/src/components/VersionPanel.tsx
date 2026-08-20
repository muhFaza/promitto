import { useEffect, useState } from 'react';
import { getVersion, type VersionInfo } from '../api/version';
import { formatCountdown } from '../lib/dates';
import { REPO_URL } from '../lib/repo';
import { useAuthStore } from '../stores/auth';
import { Badge } from './ui/Badge';

/**
 * Shows what this instance is running and whether the repo has moved past it.
 *
 * The comparison happens on the server, not here: `connect-src` is `'self'`, and
 * loosening it so every browser could call GitHub would hand them a request per
 * user for a fact the server can fetch once every six hours.
 */
export function VersionPanel() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const timezone = useAuthStore((s) => s.user?.timezone) ?? 'UTC';

  useEffect(() => {
    let live = true;
    getVersion()
      .then((v) => {
        if (live) setInfo(v);
      })
      .catch(() => {
        // Non-critical: this panel is informational, so a failure hides the
        // detail rather than raising a toast over the rest of Settings.
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  if (failed) return null;

  return (
    <div className="mt-6 max-w-md">
      <dl className="divide-y divide-rule border-y border-rule text-[13px]">
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-ink-soft">Version</dt>
          <dd className="flex items-center gap-2">
            <span className="font-mono text-ink">{info ? `v${info.version}` : '—'}</span>
            {info ? <UpdateBadge info={info} /> : null}
          </dd>
        </div>
        {info?.commit ? (
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-ink-soft">Commit</dt>
            <dd>
              <a
                className="font-mono text-ink underline underline-offset-4 hover:text-ink-soft"
                href={`${REPO_URL}/commit/${info.commit}`}
                target="_blank"
                rel="noreferrer"
              >
                {info.commit.slice(0, 7)}
              </a>
            </dd>
          </div>
        ) : null}
        {info?.latest ? (
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-ink-soft">Latest release</dt>
            <dd>
              <a
                className="font-mono text-ink underline underline-offset-4 hover:text-ink-soft"
                href={`${REPO_URL}/releases`}
                target="_blank"
                rel="noreferrer"
              >
                {info.latest}
              </a>
            </dd>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-ink-soft">Source</dt>
          <dd>
            <a
              className="text-ink underline underline-offset-4 hover:text-ink-soft"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              github.com/muhFaza/promitto
            </a>
          </dd>
        </div>
      </dl>
      {info ? (
        <p className="mt-3 text-[12px] text-ink-muted">{describe(info, timezone)}</p>
      ) : null}
    </div>
  );
}

function UpdateBadge({ info }: { info: VersionInfo }) {
  if (!info.checkEnabled) return <Badge tone="neutral">check off</Badge>;
  // null is "we have not managed to ask", which must not read as "you are current".
  if (info.updateAvailable === null) return <Badge tone="neutral">unknown</Badge>;
  if (info.updateAvailable) return <Badge tone="warning">update available</Badge>;
  return <Badge tone="success">up to date</Badge>;
}

function describe(info: VersionInfo, timezone: string): string {
  if (!info.checkEnabled) {
    return 'This server does not check for updates. Compare the version above against the releases page yourself.';
  }
  if (info.updateAvailable === null) {
    return 'Could not reach GitHub to check for a newer release. The version above is still what is running.';
  }
  // Relative reads better than an absolute stamp for "how stale is this answer",
  // and formatCountdown already renders the past as "45m ago".
  const checked = info.checkedAt ? formatCountdown(info.checkedAt, Date.now(), timezone) : '';
  const when = checked ? ` Checked ${checked}.` : '';
  return info.updateAvailable
    ? `A newer release exists. Only the admin of this server can update it.${when}`
    : `This server is running the newest release.${when}`;
}
