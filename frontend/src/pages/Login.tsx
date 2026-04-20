import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Spinner } from '../components/ui/Spinner';
import { useAuthStore } from '../stores/auth';

type LocationState = { from?: string } | null;

export function Login() {
  const login = useAuthStore((s) => s.login);
  const status = useAuthStore((s) => s.status);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'idle') void fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status === 'authenticated') {
      const state = location.state as LocationState;
      navigate(state?.from ?? '/app', { replace: true });
    }
  }, [status, navigate, location.state]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6">
      <div
        className="w-full max-w-md animate-fadeInUp"
        style={{ animationDelay: '0ms' }}
      >
        {/* Masthead */}
        <div className="mb-12 text-center">
          <div className="eyebrow">self-hosted · promises kept</div>
          <h1 className="mt-4 font-display text-[72px] italic leading-none tracking-tight text-ink">
            Promitto
          </h1>
          <div className="mt-3 flex items-center justify-center gap-3 text-[12px] text-ink-muted">
            <span className="h-px w-8 bg-rule" />
            <span>scheduled whatsapp messages</span>
            <span className="h-px w-8 bg-rule" />
          </div>
        </div>

        <form
          className="space-y-5 border border-rule bg-paper-raised px-7 py-8"
          onSubmit={handleSubmit}
          noValidate
        >
          <div className="eyebrow mb-1">Sign in to continue</div>

          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoFocus
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>

          {error && (
            <div
              className="border-l-2 border-accent-warm bg-accent-warm-soft/40 px-3 py-2 text-[12px] text-accent-warm"
              role="alert"
            >
              {error}
            </div>
          )}

          <Button type="submit" disabled={busy} className="w-full">
            {busy ? <Spinner /> : 'Sign in →'}
          </Button>

          <p className="border-t border-rule pt-4 text-[12px] text-ink-muted">
            Forgot your password? There is no reset link — contact your administrator.
          </p>
        </form>

        <div className="mt-8 text-center">
          <div className="eyebrow">one vps · one container · no saas</div>
        </div>
      </div>
    </div>
  );
}
