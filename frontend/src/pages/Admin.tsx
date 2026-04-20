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
      <main className="mx-auto max-w-5xl p-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Admin</h1>
            <p className="mt-1 text-sm text-slate-500">User management.</p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>Create user</Button>
        </header>

        <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          {loading ? (
            <div className="flex items-center justify-center p-12 text-slate-400">
              <Spinner size={24} />
            </div>
          ) : (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-700">Email</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-700">Role</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-700">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-700">Timezone</th>
                  <th className="px-4 py-3 text-right font-medium text-slate-700">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {users.map((u) => {
                  const isSelf = u.id === currentUser?.id;
                  return (
                    <tr key={u.id}>
                      <td className="px-4 py-3 text-slate-900">{u.email}</td>
                      <td className="px-4 py-3">
                        <Badge tone={u.role === 'superuser' ? 'info' : 'neutral'}>
                          {u.role}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {u.disabledAt ? (
                          <Badge tone="warning">disabled</Badge>
                        ) : (
                          <Badge tone="success">active</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{u.timezone}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          {u.disabledAt ? (
                            <Button variant="secondary" onClick={() => handleEnable(u)}>
                              Enable
                            </Button>
                          ) : (
                            <Button
                              variant="secondary"
                              onClick={() => handleDisable(u)}
                              disabled={isSelf}
                              title={isSelf ? 'You cannot disable yourself' : undefined}
                            >
                              Disable
                            </Button>
                          )}
                          <Button variant="secondary" onClick={() => handleReset(u)}>
                            Reset password
                          </Button>
                          <Button
                            variant="danger"
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
          )}
        </div>
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
      <form onSubmit={submit} className="space-y-4">
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
        <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-800">
          A one-time password will be generated and shown once. Deliver it out-of-band.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner /> : 'Create'}
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
        <div className="space-y-4">
          <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-800">
            Copy this password now. It will not be shown again.
          </div>
          <div>
            <div className="text-xs text-slate-500">For</div>
            <div className="text-sm font-medium text-slate-900">{reveal.email}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">One-time password</div>
            <div className="mt-1 flex gap-2">
              <code className="flex-1 select-all rounded-md border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900">
                {reveal.password}
              </code>
              <Button type="button" variant="secondary" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              I&apos;ve stored it
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
