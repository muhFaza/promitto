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
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const pushToast = useUiStore((s) => s.pushToast);
  const mustChange = user?.mustChangePassword === true;

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
      await fetchMe();
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
      <main className="mx-auto max-w-2xl space-y-12 px-6 pb-24 pt-10">
        <header>
          <div className="eyebrow">Profile · security</div>
          <h1 className="mt-2 font-display text-4xl italic leading-none text-ink">
            Settings
          </h1>
        </header>

        {mustChange && (
          <div
            className="border-l-2 border-accent-warm bg-amber-soft/30 px-4 py-3 text-[13px] text-ink"
            role="alert"
          >
            <div className="eyebrow text-accent-warm">Action required</div>
            <p className="mt-1">
              Set a new password before you can continue. Temporary passwords are
              single-use.
            </p>
          </div>
        )}

        <section className={`${mustChange ? 'pointer-events-none opacity-40 ' : ''}border-y border-rule py-8`}>
          <div className="eyebrow">Timezone</div>
          <h2 className="mt-1 font-display text-2xl italic text-ink">
            Where does "now" mean now.
          </h2>
          <p className="mt-2 max-w-md text-[13px] text-ink-soft">
            Schedules are interpreted in this timezone. Changing it only affects future
            schedules — existing ones keep the zone they were created in.
          </p>
          <form className="mt-6 space-y-4" onSubmit={handleTz}>
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
              {tzBusy ? <Spinner /> : 'Save timezone →'}
            </Button>
          </form>
        </section>

        <section className="border-b border-rule pb-8">
          <div className="eyebrow">Password</div>
          <h2 className="mt-1 font-display text-2xl italic text-ink">
            Rotate the key.
          </h2>
          <p className="mt-2 max-w-md text-[13px] text-ink-soft">
            Changing your password revokes all other sessions immediately.
          </p>
          <form className="mt-6 space-y-4" onSubmit={handlePw}>
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
              <div
                className="border-l-2 border-accent-warm bg-accent-warm-soft/40 px-3 py-2 text-[12px] text-accent-warm"
                role="alert"
              >
                {pwError}
              </div>
            )}
            <Button type="submit" disabled={pwBusy}>
              {pwBusy ? <Spinner /> : 'Change password →'}
            </Button>
          </form>
        </section>
      </main>
    </>
  );
}
