import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { compareVersions } from '../../lib/version.js';

export const REPO_URL = 'https://github.com/muhFaza/promitto';
const RELEASES_API = 'https://api.github.com/repos/muhFaza/promitto/releases/latest';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * Hard ceiling on the GitHub round trip. The container is capped at 384MB and a
 * hung socket would pin a timer plus its buffers for as long as the OS lets it;
 * a stale "latest" is strictly better than that.
 */
const FETCH_TIMEOUT_MS = 5_000;
/**
 * Don't retry a failure for this long. GitHub allows 60 unauthenticated calls
 * an hour per IP and this box shares its address with everything else on it,
 * so a hard-failing check must not spend that budget.
 */
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;

/** Read once at import: the file is baked into the image and cannot change under us. */
const packageVersion = ((): string => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/modules/version -> dist -> backend
    const pkg = readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(pkg);
    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      const v = (parsed as { version: unknown }).version;
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    // Falls through — a version we cannot read must not stop the server booting.
  }
  return '0.0.0';
})();

export type VersionInfo = {
  version: string;
  commit: string | null;
  repoUrl: string;
  latest: string | null;
  updateAvailable: boolean | null;
  checkedAt: number | null;
  checkEnabled: boolean;
};

class UpdateChecker {
  private latest: string | null = null;
  private checkedAt: number | null = null;
  private lastAttemptAt = 0;
  private inFlight: Promise<void> | null = null;

  get info(): VersionInfo {
    const latest = this.latest;
    return {
      version: packageVersion,
      commit: env.GIT_SHA ?? null,
      repoUrl: REPO_URL,
      latest,
      // null, not false: "we have not managed to ask" is a different answer from
      // "you are current", and the UI says so rather than claiming you are fine.
      updateAvailable: latest === null ? null : compareVersions(latest, packageVersion) > 0,
      checkedAt: this.checkedAt,
      checkEnabled: env.UPDATE_CHECK,
    };
  }

  /**
   * Refresh if the cache is cold or stale. Never throws and never blocks the
   * caller on the network: the route serves whatever is cached and this settles
   * in the background.
   */
  maybeRefresh(now = Date.now()): void {
    if (!env.UPDATE_CHECK) return;
    if (this.inFlight) return;
    const fresh = this.checkedAt !== null && now - this.checkedAt < CHECK_INTERVAL_MS;
    if (fresh) return;
    if (this.lastAttemptAt !== 0 && now - this.lastAttemptAt < FAILURE_BACKOFF_MS) return;

    this.lastAttemptAt = now;
    this.inFlight = this.fetchLatest()
      .then((tag) => {
        if (tag !== null) {
          this.latest = tag;
          this.checkedAt = Date.now();
        }
      })
      .catch(() => {
        // fetchLatest already logged; swallow so an unhandled rejection can
        // never reach main.ts's process-wide handler and shut the server down.
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  private async fetchLatest(): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(RELEASES_API, {
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'promitto-update-check',
        },
      });
      if (!res.ok) {
        logger.debug({ status: res.status }, 'update check: non-ok response');
        return null;
      }
      const body: unknown = await res.json();
      if (body && typeof body === 'object' && 'tag_name' in body) {
        const tag = (body as { tag_name: unknown }).tag_name;
        if (typeof tag === 'string' && tag.length > 0) return tag;
      }
      return null;
    } catch (err) {
      logger.debug({ err }, 'update check failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const updateChecker = new UpdateChecker();
