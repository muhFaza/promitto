import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { Button } from './Button';

export function AppHeader() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-4xl items-center justify-between p-4">
        <Link to="/app" className="font-semibold text-slate-900">
          Promitto
        </Link>
        <div className="flex items-center gap-3">
          {user && <span className="hidden text-xs text-slate-500 sm:inline">{user.email}</span>}
          <Button variant="secondary" onClick={handleLogout}>
            Log out
          </Button>
        </div>
      </div>
    </header>
  );
}
