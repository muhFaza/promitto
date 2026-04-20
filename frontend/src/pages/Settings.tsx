import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import * as settingsApi from '../api/settings';
import { AppHeader } from '../components/ui/AppHeader';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Spinner } from '../components/ui/Spinner';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

export function Settings() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const pushToast = useUiStore((s) => s.pushToast);

  const [timezones, setTimezones] = useState<string[]>([]);
  const [tz, setTz] = useState(user?.timezone ?? '');
  const [tzBusy, setTzBusy] = useState(false);

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  useEffect(() => {
    settingsApi
      .listTimezones()
      .then((r) => setTimezones(r.timezones))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (user) setTz(user.timezone);
  }, [user]);

  async function handleTz(e: FormEvent) {
    e.preventDefault();
    setTzBusy(true);
    try {
      const updated = await settingsApi.changeTimezone(tz);
      setUser(updated);
      pushToast({ message: 'Timezone updated', level: 'success' });
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Failed to update timezone',
        level: 'error',
      });
    } finally {
      setTzBusy(false);
    }
  }

  async function handlePw(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    if (newPw !== newPw2) {
      setPwError('Passwords do not match');
      return;
    }
    if (newPw.length < 12) {
      setPwError('New password must be at least 12 characters');
      return;
    }
    setPwBusy(true);
    try {
      await settingsApi.changePassword(currentPw, newPw);
      setCurrentPw('');
      setNewPw('');
      setNewPw2('');
      pushToast({
        message: 'Password changed. Other sessions revoked.',
        level: 'success',
      });
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : 'Failed to change password');
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-2xl space-y-8 p-6">
        <header>
          <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
          <p className="mt-1 text-sm text-slate-500">Profile and security.</p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-slate-900">Timezone</h2>
          <p className="text-xs text-slate-500">
            Schedules are interpreted in this timezone. Changing it only affects future schedules.
          </p>
          <form className="mt-4 space-y-4" onSubmit={handleTz}>
            <Field label="IANA timezone">
              <Input
                type="text"
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                list="timezones-list"
                placeholder="e.g. Asia/Jakarta"
                required
              />
              <datalist id="timezones-list">
                {timezones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <Button
              type="submit"
              disabled={tzBusy || !tz || tz === user?.timezone}
            >
              {tzBusy ? <Spinner /> : 'Save timezone'}
            </Button>
          </form>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-slate-900">Password</h2>
          <p className="text-xs text-slate-500">
            Changing your password revokes all other sessions.
          </p>
          <form className="mt-4 space-y-4" onSubmit={handlePw}>
            <Field label="Current password">
              <Input
                type="password"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                required
                autoComplete="current-password"
              />
            </Field>
            <Field label="New password">
              <Input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                required
                minLength={12}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm new password">
              <Input
                type="password"
                value={newPw2}
                onChange={(e) => setNewPw2(e.target.value)}
                required
                minLength={12}
                autoComplete="new-password"
              />
            </Field>
            {pwError && (
              <div className="rounded-md bg-red-50 p-3 text-xs text-red-800" role="alert">
                {pwError}
              </div>
            )}
            <Button type="submit" disabled={pwBusy}>
              {pwBusy ? <Spinner /> : 'Change password'}
            </Button>
          </form>
        </section>
      </main>
    </>
  );
}
