import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import * as usersApi from '../api/users';
import { AppHeader } from '../components/ui/AppHeader';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import type { UserPublic } from '../lib/types';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

type Reveal = { email: string; password: string } | null;

export function Admin() {
  const currentUser = useAuthStore((s) => s.user);
  const pushToast = useUiStore((s) => s.pushToast);

  const [users, setUsers] = useState<UserPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [reveal, setReveal] = useState<Reveal>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await usersApi.list();
      setUsers(r.users);
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Failed to load users',
        level: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleDisable(u: UserPublic) {
    if (!confirm(`Disable ${u.email}? All their sessions will be revoked.`)) return;
    try {
      await usersApi.disable(u.id);
      pushToast({ message: `${u.email} disabled`, level: 'success' });
      await refresh();
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Failed',
        level: 'error',
      });
    }
  }

  async function handleEnable(u: UserPublic) {
    try {
      await usersApi.enable(u.id);
      pushToast({ message: `${u.email} enabled`, level: 'success' });
      await refresh();
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Failed',
        level: 'error',
      });
    }
  }

  async function handleReset(u: UserPublic) {
    if (!confirm(`Reset password for ${u.email}?`)) return;
    try {
      const r = await usersApi.resetPassword(u.id);
      setReveal({ email: u.email, password: r.tempPassword });
      await refresh();
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Failed',
        level: 'error',
      });
    }
  }

  async function handleDelete(u: UserPublic) {
    if (!confirm(`PERMANENTLY delete ${u.email}? This cannot be undone.`)) return;
    try {
      await usersApi.remove(u.id);
      pushToast({ message: `${u.email} deleted`, level: 'success' });
      await refresh();
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Failed',
        level: 'error',
      });
    }
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow">Superuser</div>
            <h1 className="mt-2 font-display text-4xl italic leading-none text-ink">
              Admin
            </h1>
            <p className="mt-3 text-sm text-ink-soft">
              Provision, reset, enable, disable, delete.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>+ Create user</Button>
        </header>

        <section className="mt-10">
          {loading ? (
            <div className="flex items-center justify-center p-16 text-ink-muted">
              <Spinner size={24} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-rule">
                    <th className="eyebrow px-4 py-3 text-left">Email</th>
                    <th className="eyebrow px-4 py-3 text-left">Role</th>
                    <th className="eyebrow px-4 py-3 text-left">Status</th>
                    <th className="eyebrow px-4 py-3 text-left">Timezone</th>
                    <th className="eyebrow px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isSelf = u.id === currentUser?.id;
                    return (
                      <tr
                        key={u.id}
                        className="border-b border-rule/60 transition-colors hover:bg-paper-raised"
                      >
                        <td className="px-4 py-4 align-top text-ink">{u.email}</td>
                        <td className="px-4 py-4 align-top">
                          <Badge tone={u.role === 'superuser' ? 'info' : 'neutral'}>
                            {u.role}
                          </Badge>
                        </td>
                        <td className="px-4 py-4 align-top">
                          {u.disabledAt ? (
                            <Badge tone="warning">disabled</Badge>
                          ) : (
                            <Badge tone="success">active</Badge>
                          )}
                        </td>
                        <td className="px-4 py-4 align-top font-mono text-[12px] text-ink-soft">
                          {u.timezone}
                        </td>
                        <td className="px-4 py-4 text-right align-top">
                          <div className="flex flex-wrap justify-end gap-2">
                            {u.disabledAt ? (
                              <Button variant="ghost" onClick={() => handleEnable(u)}>
                                Enable
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                onClick={() => handleDisable(u)}
                                disabled={isSelf}
                                title={isSelf ? 'You cannot disable yourself' : undefined}
                              >
                                Disable
                              </Button>
                            )}
                            <Button variant="ghost" onClick={() => handleReset(u)}>
                              Reset pw
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => handleDelete(u)}
                              disabled={isSelf}
                              title={isSelf ? 'You cannot delete yourself' : undefined}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(email, password) => {
          setCreateOpen(false);
          setReveal({ email, password });
          void refresh();
        }}
      />

      <TempPasswordModal reveal={reveal} onClose={() => setReveal(null)} />
    </>
  );
}

function CreateUserModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (email: string, tempPassword: string) => void;
}) {
  const pushToast = useUiStore((s) => s.pushToast);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'user' | 'superuser'>('user');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await usersApi.create({ email, role });
      onCreated(r.user.email, r.tempPassword);
      setEmail('');
      setRole('user');
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Failed to create user',
        level: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Create user">
      <form onSubmit={submit} className="space-y-5">
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label="Role">
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as 'user' | 'superuser')}
          >
            <option value="user">user</option>
            <option value="superuser">superuser</option>
          </Select>
        </Field>
        <div className="border-l-2 border-amber-soft bg-amber-soft-bg/60 px-3 py-2 text-[12px] text-ink-soft">
          A one-time password will be generated and shown once. Deliver it out-of-band.
        </div>
        <div className="flex justify-end gap-2 border-t border-rule pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner /> : 'Create →'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TempPasswordModal({
  reveal,
  onClose,
}: {
  reveal: Reveal;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!reveal) return;
    try {
      await navigator.clipboard.writeText(reveal.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — user can still select + copy manually
    }
  }

  return (
    <Modal open={!!reveal} onClose={onClose} title="Temporary password">
      {reveal && (
        <div className="space-y-5">
          <div className="border-l-2 border-amber-soft bg-amber-soft-bg/60 px-3 py-2 text-[12px] text-ink-soft">
            Copy this password now. It will not be shown again.
          </div>
          <div>
            <div className="eyebrow">For</div>
            <div className="mt-1 text-sm font-medium text-ink">{reveal.email}</div>
          </div>
          <div>
            <div className="eyebrow">One-time password</div>
            <div className="mt-2 flex gap-2">
              <code className="flex-1 select-all border border-rule bg-paper-deep px-3 py-2 font-mono text-sm text-ink">
                {reveal.password}
              </code>
              <Button type="button" variant="secondary" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
          <div className="flex justify-end border-t border-rule pt-4">
            <Button type="button" onClick={onClose}>
              I&apos;ve stored it
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
