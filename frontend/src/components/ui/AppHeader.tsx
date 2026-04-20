import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { useWaStore } from '../../stores/wa';
import { WaStatusDot, WaStatusLabel } from '../WaStatusIndicator';

export function AppHeader() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const status = useWaStore((s) => s.status);
  const fetchStatus = useWaStore((s) => s.fetchStatus);
  const subscribe = useWaStore((s) => s.subscribe);
  const navigate = useNavigate();

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
            aria-label={`WhatsApp status: ${status}`}
            className="flex items-center gap-2 border-b border-transparent pb-0.5 transition-colors hover:border-ink"
          >
            <WaStatusDot status={status} />
            <WaStatusLabel status={status} className="hidden sm:inline" />
          </Link>

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
