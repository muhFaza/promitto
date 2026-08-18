import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { useAuthStore } from '../../stores/auth';
import { useWaStore } from '../../stores/wa';
import { WaStatusDot, WaStatusLabel } from '../WaStatusIndicator';

export function AppHeader() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const status = useWaStore((s) => s.status);
  const streamStale = useWaStore((s) => s.streamStale);
  const fetchStatus = useWaStore((s) => s.fetchStatus);
  const subscribe = useWaStore((s) => s.subscribe);
  const navigate = useNavigate();

  // Mounted once by AppLayout and kept alive across navigation, so this opens
  // exactly one event stream per visit rather than one per route change.
  useEffect(() => {
    void fetchStatus().catch(() => {});
    const unsub = subscribe();
    return () => unsub();
  }, [fetchStatus, subscribe]);

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-5xl items-end justify-between gap-4 px-6 py-4">
        <Link to="/app" className="group block" aria-label="Promitto home">
          <div className="font-display text-[22px] italic leading-none text-ink transition-colors group-hover:text-accent">
            Promitto
          </div>
          <div className="eyebrow mt-1">scheduled messages</div>
        </Link>

        <div className="flex items-center gap-5">
          <Link
            to="/app/wa"
            aria-label={
              streamStale
                ? `WhatsApp status: ${status}, last known — live updates disconnected`
                : `WhatsApp status: ${status}`
            }
            className={cn(
              'flex items-center gap-2 border-b border-transparent pb-0.5 transition-colors hover:border-ink',
              // Dimming alone would be a colour-only signal, so the word carries
              // the meaning and the opacity just reinforces it.
              streamStale && 'opacity-60',
            )}
          >
            <WaStatusDot status={status} />
            <WaStatusLabel status={status} className="hidden sm:inline" />
            {streamStale && (
              <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                stale
              </span>
            )}
          </Link>

          {/* Without this the stale state is a dead end. AppHeader is mounted by
              the layout route now, so it survives navigation and its subscribe()
              effect never runs a second time — only a full page reload would
              reopen the stream. A deploy takes the backend away for longer than
              the retry budget, so ordinary deploys would otherwise leave every
              open tab reading "stale" until someone thought to refresh.
              Sibling of the Link, not a child: a button inside an anchor is
              invalid HTML and swallows the click. */}
          {streamStale && (
            <button
              type="button"
              onClick={() => {
                void fetchStatus().catch(() => {});
                subscribe();
              }}
              className="eyebrow border-b border-transparent transition-colors hover:border-ink hover:text-ink"
            >
              Reconnect
            </button>
          )}

          {user && (
            <div className="hidden text-right md:block">
              <div className="font-mono text-[11px] text-ink-soft">
                {user.email}
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="eyebrow mt-0.5 transition-colors hover:text-ink"
              >
                Log out →
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={handleLogout}
            className="eyebrow transition-colors hover:text-ink md:hidden"
            aria-label="Log out"
          >
            Log out →
          </button>
        </div>
      </div>
    </header>
  );
}
