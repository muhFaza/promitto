import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { Spinner } from './ui/Spinner';

type Props = {
  children: ReactNode;
  requireSuperuser?: boolean;
};

export function RequireAuth({ children, requireSuperuser = false }: Props) {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const location = useLocation();

  useEffect(() => {
    if (status === 'idle') {
      void fetchMe();
    }
  }, [status, fetchMe]);

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        <Spinner size={24} />
      </div>
    );
  }

  if (status === 'unauthorized' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (requireSuperuser && user.role !== 'superuser') {
    return <Navigate to="/app" replace />;
  }

  return <>{children}</>;
}
