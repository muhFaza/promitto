import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import * as invitesApi from '../api/invites';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Spinner } from '../components/ui/Spinner';
import { formatInZone } from '../lib/dates';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

const MIN_PASSWORD = 12;

type State =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'valid'; invite: invitesApi.Invite };

export function Invite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const pushToast = useUiStore((s) => s.pushToast);

  const [state, setState] = useState<State>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  // No logged-in user on a public page, so the browser's zone is the only one we have.
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setState({ kind: 'invalid' });
      return;
    }
    void (async () => {
      try {
        const invite = await invitesApi.lookup(token);
        if (!cancelled) setState({ kind: 'valid', invite });
      } catch {
        if (!cancelled) setState({ kind: 'invalid' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const tooShort = password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !tooShort && confirm === password && !busy;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!token || !canSubmit) return;
    setBusy(true);
    try {
      const user = await invitesApi.consume(token, password);
      setUser(user);
      navigate('/app', { replace: true });
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Unexpected error',
        level: 'error',
      });
      // A 404 here means the link was consumed or expired between load and submit.
      if (err instanceof ApiError && err.status === 404) setState({ kind: 'invalid' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6">
      <div className="w-full max-w-md animate-fadeInUp" style={{ animationDelay: '0ms' }}>
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

        {state.kind === 'loading' && (
          <div className="flex items-center justify-center border border-rule bg-paper-raised px-7 py-12 text-ink-muted">
            <Spinner size={24} />
          </div>
        )}

        {state.kind === 'invalid' && (
          <div className="border border-rule bg-paper-raised px-7 py-8">
            <div className="eyebrow mb-1">Setup link</div>
            <h2 className="font-display text-2xl italic leading-tight text-ink">
              This link is no longer valid
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              Setup links work once and expire. Ask whoever invited you to issue a new
              one.
            </p>
            <div className="mt-6 border-t border-rule pt-4">
              <Link
                to="/login"
                className="text-[13px] font-medium text-ink underline underline-offset-4 transition-colors hover:text-ink-soft"
              >
                Go to sign in →
              </Link>
            </div>
          </div>
        )}

        {state.kind === 'valid' && (
          <form
            className="space-y-5 border border-rule bg-paper-raised px-7 py-8"
            onSubmit={handleSubmit}
            noValidate
          >
            <div>
              <div className="eyebrow mb-1">Set your password</div>
              <h2 className="font-display text-2xl italic leading-tight text-ink">
                Welcome to Promitto
              </h2>
            </div>

            <div className="border-t border-rule pt-4">
              <div className="eyebrow">Account</div>
              <div className="mt-1 font-mono text-sm text-ink">{state.invite.email}</div>
            </div>

            <Field
              label="Password"
              hint={`At least ${MIN_PASSWORD} characters.`}
              error={touched && tooShort ? `Use at least ${MIN_PASSWORD} characters.` : undefined}
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                autoFocus
              />
            </Field>

            <Field
              label="Confirm password"
              hint="Type it again to be sure."
              error={mismatch ? 'The two passwords do not match.' : undefined}
            >
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
              />
            </Field>

            <Button type="submit" disabled={busy} className="w-full">
              {busy ? <Spinner /> : 'Set password & sign in →'}
            </Button>

            <p className="border-t border-rule pt-4 text-[12px] text-ink-muted">
              This link works once, and expires{' '}
              <span className="font-mono">{formatInZone(state.invite.expiresAt, zone)}</span>{' '}
              <span className="font-mono">({zone})</span>.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
