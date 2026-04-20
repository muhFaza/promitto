import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { useWaStore } from '../../stores/wa';
import { WaStatusDot, WaStatusLabel } from '../WaStatusIndicator';
import { Button } from './Button';

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
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 p-4">
        <Link to="/app" className="font-semibold text-slate-900">
          Promitto
        </Link>
        <div className="flex items-center gap-3">
          <Link
            to="/app/wa"
            aria-label={`WhatsApp status: ${status}`}
            className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs transition hover:border-slate-300 hover:bg-white"
          >
            <WaStatusDot status={status} />
            <WaStatusLabel status={status} className="hidden sm:inline" />
          </Link>
          {user && (
            <span className="hidden text-xs text-slate-500 md:inline">{user.email}</span>
          )}
          <Button variant="secondary" onClick={handleLogout}>
            Log out
          </Button>
        </div>
      </div>
    </header>
  );
}
