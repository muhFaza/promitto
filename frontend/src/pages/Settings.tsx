import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import * as contactsApi from '../api/contacts';
import * as settingsApi from '../api/settings';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { useAuthStore } from '../stores/auth';
import { useContactsStore } from '../stores/contacts';
import { useUiStore } from '../stores/ui';
import { useWaStore } from '../stores/wa';

const RETENTION_OPTIONS = [7, 30, 60, 90, 180];

export function Settings() {
  const navigate = useNavigate();
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

  const [retentionBusy, setRetentionBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [contactsBusy, setContactsBusy] = useState(false);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPw, setHistoryPw] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePw, setDeletePw] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    if (tzBusy) return;
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
    // Enter inside a still-enabled field submits even while the button is
    // disabled, so the busy flag has to be checked here, not only on the button.
    if (pwBusy) return;
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

  async function handleRetention(days: number) {
    setRetentionBusy(true);
    try {
      const updated = await settingsApi.setRetention(days);
      setUser(updated);
      pushToast({ message: `History now kept for ${days} days`, level: 'success' });
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Failed to update retention',
        level: 'error',
      });
    } finally {
      setRetentionBusy(false);
    }
  }

  async function handleContactSync(enabled: boolean) {
    setSyncBusy(true);
    try {
      const updated = await settingsApi.setContactSync(enabled);
      setUser(updated);
      pushToast({
        message: enabled ? 'Contact sync on' : 'Contact sync off',
        level: 'success',
      });
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Failed to update contact sync',
        level: 'error',
      });
    } finally {
      setSyncBusy(false);
    }
  }

  async function handlePurgeContacts() {
    const ok = window.confirm(
      'Delete every contact synced from WhatsApp? Manually added contacts are kept. While syncing is on, contacts start coming back as soon as WhatsApp sends them again.',
    );
    if (!ok) return;
    setContactsBusy(true);
    try {
      const r = await contactsApi.purgeSynced();
      await useContactsStore.getState().load();
      pushToast({
        message: `Deleted ${r.deleted} synced contacts, cleared activity on ${r.cleared} more`,
        level: 'success',
      });
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Failed to delete synced contacts',
        level: 'error',
      });
    } finally {
      setContactsBusy(false);
    }
  }

  function closeHistory() {
    // Closing mid-request would unmount the form and take its error state with
    // it, leaving the outcome nowhere to land.
    if (historyBusy) return;
    setHistoryOpen(false);
    setHistoryPw('');
    setHistoryError(null);
  }

  async function handlePurgeHistory(e: FormEvent) {
    e.preventDefault();
    if (historyBusy) return;
    setHistoryError(null);
    setHistoryBusy(true);
    try {
      const r = await settingsApi.purgeData(historyPw);
      setHistoryPw('');
      setHistoryOpen(false);
      pushToast({
        message: `Deleted ${r.sentMessages} history entries and ${r.scheduledMessages} finished schedules`,
        level: 'success',
      });
    } catch (err) {
      setHistoryError(
        err instanceof ApiError ? err.message : 'Failed to delete message history',
      );
    } finally {
      setHistoryBusy(false);
    }
  }

  function closeDelete() {
    // Modal calls this on Escape and on a backdrop click with no busy guard of
    // its own. Closing while the request is in flight unmounts the form and
    // clears deleteError, so the response would have nowhere to be shown —
    // including the 409 last-superuser case, where the WhatsApp pairing has
    // already been destroyed server-side and the user must be told.
    if (deleteBusy) return;
    setDeleteOpen(false);
    setDeletePw('');
    setDeleteConfirm('');
    setDeleteError(null);
  }

  async function handleDeleteAccount(e: FormEvent) {
    e.preventDefault();
    // A second DELETE would land after the session cookies are gone and answer
    // 401, racing the redirect with a failure that never happened.
    if (deleteBusy) return;
    if (deleteConfirm !== 'DELETE' || !deletePw) return;
    setDeleteError(null);
    setDeleteBusy(true);
    try {
      await settingsApi.deleteAccount(deletePw);
      setDeleteOpen(false);
      useWaStore.getState().reset();
      useContactsStore.getState().reset();
      setUser(null);
      navigate('/login', { replace: true });
    } catch (err) {
      // A 409 here means "you are the last superuser" — the server's message
      // says why, so surface it verbatim rather than a generic failure.
      setDeleteError(
        err instanceof ApiError ? err.message : 'Failed to delete account',
      );
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <>
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

        <section className={`${mustChange ? 'opacity-40 ' : ''}border-y border-rule py-8`}>
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
                disabled={mustChange}
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
              disabled={mustChange || tzBusy || !tz || tz === user?.timezone}
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

        <section className={`${mustChange ? 'opacity-40 ' : ''}border-b border-rule pb-8`}>
          <div className="eyebrow">Privacy &amp; data</div>
          <h2 className="mt-1 font-display text-2xl italic text-ink">
            What the server keeps.
          </h2>
          <p className="mt-2 max-w-md text-[13px] text-ink-soft">
            The{' '}
            <Link to="/privacy" className="underline underline-offset-2 hover:text-ink">
              privacy page
            </Link>{' '}
            explains what is stored and who can read it.
          </p>

          <div className="mt-6 space-y-3">
            <Field label="Keep history for">
              <Select
                value={String(user?.retentionDays ?? 60)}
                disabled={mustChange || retentionBusy}
                onChange={(e) => void handleRetention(Number(e.target.value))}
              >
                {RETENTION_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </Select>
            </Field>
            <p className="max-w-md text-[13px] text-ink-soft">
              Sent history and finished one-off schedules are deleted permanently after
              this long. There is no unlimited option.
            </p>
          </div>

          <hr className="my-6" />

          <label className="flex max-w-md items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
              checked={user?.contactSyncEnabled ?? false}
              disabled={mustChange || syncBusy}
              onChange={(e) => void handleContactSync(e.target.checked)}
            />
            <span>
              <span className="block text-[13px] font-medium text-ink">
                Sync contacts from WhatsApp
              </span>
              <span className="mt-1 block text-[13px] text-ink-soft">
                Sync contacts, pins and recent-chat activity from WhatsApp. Turning this
                off stops new syncing; it does not delete what is already stored.
              </span>
            </span>
          </label>

          <hr className="my-6" />

          <div className="space-y-6">
            <div>
              <p className="max-w-md text-[13px] text-ink-soft">
                Delete every contact that came from WhatsApp, along with its pin and
                last-interaction data. Contacts you typed in yourself are kept. While
                syncing is on this is temporary: with a live connection, contacts start
                coming back within seconds, and activity refills on the ones you kept. Turn
                syncing off first if you want it to stick.
              </p>
              <Button
                variant="secondary"
                className="mt-3 text-accent-warm"
                disabled={mustChange || contactsBusy}
                onClick={() => void handlePurgeContacts()}
              >
                {contactsBusy ? <Spinner /> : 'Delete synced contacts'}
              </Button>
            </div>

            <div>
              <p className="max-w-md text-[13px] text-ink-soft">
                Delete your sent-message history and every finished one-off schedule now,
                without waiting for the retention period. This does not come back.
              </p>
              {historyOpen ? (
                <form className="mt-3 max-w-sm space-y-4" onSubmit={handlePurgeHistory}>
                  <Field label="Current password">
                    <Input
                      type="password"
                      value={historyPw}
                      onChange={(e) => setHistoryPw(e.target.value)}
                      required
                      autoComplete="current-password"
                    />
                  </Field>
                  {historyError && (
                    <div
                      className="border-l-2 border-accent-warm bg-accent-warm-soft/40 px-3 py-2 text-[12px] text-accent-warm"
                      role="alert"
                    >
                      {historyError}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button type="submit" variant="danger" disabled={historyBusy || !historyPw}>
                      {historyBusy ? <Spinner /> : 'Delete history'}
                    </Button>
                    <Button variant="ghost" disabled={historyBusy} onClick={closeHistory}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <Button
                  variant="secondary"
                  className="mt-3 text-accent-warm"
                  disabled={mustChange}
                  onClick={() => setHistoryOpen(true)}
                >
                  Delete message history
                </Button>
              )}
            </div>
          </div>
        </section>

        <section className={mustChange ? 'opacity-40' : undefined}>
          <div className="eyebrow text-accent-warm">Danger zone</div>
          <h2 className="mt-1 font-display text-2xl italic text-ink">
            Leave nothing behind.
          </h2>
          <p className="mt-2 max-w-md text-[13px] text-ink-soft">
            Deleting your account removes everything this server holds about you. There
            are no backups, so nobody — including the operator — can bring it back.
          </p>
          <Button
            variant="danger"
            className="mt-6"
            disabled={mustChange}
            onClick={() => setDeleteOpen(true)}
          >
            Delete my account
          </Button>
        </section>
      </main>

      <Modal open={deleteOpen} onClose={closeDelete} title="Delete your account">
        <p className="text-[13px] leading-relaxed text-ink-soft">
          This permanently destroys, with no way to undo it:
        </p>
        <ul className="mt-3 space-y-1.5 border-l-2 border-accent-warm pl-4 text-[13px] text-ink">
          <li>your account and login</li>
          <li>every contact, synced and manual</li>
          <li>every schedule, upcoming and recurring</li>
          <li>your whole sent-message history</li>
          <li>your WhatsApp pairing, and a request to WhatsApp to unlink the device</li>
        </ul>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          The unlink request only reaches WhatsApp if the session is still connected, and it
          is never allowed to block the deletion — so check Linked devices on your phone
          afterwards and remove it there if it is still listed.
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          There are no backups of any of it. Once this finishes, it is gone.
        </p>
        <form className="mt-6 space-y-4" onSubmit={handleDeleteAccount}>
          <Field label="Current password">
            <Input
              type="password"
              value={deletePw}
              onChange={(e) => setDeletePw(e.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>
          <Field label="Type DELETE to confirm">
            <Input
              type="text"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </Field>
          {deleteError && (
            <div
              className="border-l-2 border-accent-warm bg-accent-warm-soft/40 px-3 py-2 text-[12px] text-accent-warm"
              role="alert"
            >
              {deleteError}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="danger"
              disabled={deleteBusy || deleteConfirm !== 'DELETE' || !deletePw}
            >
              {deleteBusy ? <Spinner /> : 'Delete everything'}
            </Button>
            <Button variant="ghost" disabled={deleteBusy} onClick={closeDelete}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
