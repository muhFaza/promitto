import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import * as contactsApi from '../api/contacts';
import { AppHeader } from '../components/ui/AppHeader';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Spinner } from '../components/ui/Spinner';
import type { Contact } from '../lib/types';
import { useUiStore } from '../stores/ui';

export function Contacts() {
  const pushToast = useUiStore((s) => s.pushToast);
  const [rows, setRows] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(
    async (q?: string) => {
      setLoading(true);
      try {
        const r = await contactsApi.list(q ? { search: q } : {});
        setRows(r.contacts);
      } catch (err) {
        pushToast({
          message: err instanceof ApiError ? err.message : 'Failed to load contacts',
          level: 'error',
        });
      } finally {
        setLoading(false);
      }
    },
    [pushToast],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function handleSearch(v: string) {
    setSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void refresh(v);
    }, 200);
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await contactsApi.create({ phone, displayName: name });
      const label =
        created.verifiedOnWhatsapp === true
          ? `Added ${created.displayName} (verified on WhatsApp)`
          : created.verifiedOnWhatsapp === false
            ? `Added ${created.displayName} — NOT on WhatsApp`
            : `Added ${created.displayName} — verification pending (connect WhatsApp to confirm)`;
      pushToast({
        message: label,
        level:
          created.verifiedOnWhatsapp === false
            ? 'error'
            : created.verifiedOnWhatsapp === true
              ? 'success'
              : 'info',
      });
      setPhone('');
      setName('');
      await refresh(search);
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Add failed',
        level: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(c: Contact) {
    if (!editName.trim()) return;
    try {
      await contactsApi.rename(c.id, editName);
      setEditingId(null);
      setEditName('');
      await refresh(search);
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Rename failed',
        level: 'error',
      });
    }
  }

  async function handleDelete(c: Contact) {
    if (!confirm(`Delete ${c.displayName}?`)) return;
    try {
      await contactsApi.remove(c.id);
      await refresh(search);
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Delete failed',
        level: 'error',
      });
    }
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-4xl p-6">
        <header>
          <h1 className="text-2xl font-semibold text-slate-900">Contacts</h1>
          <p className="mt-1 text-sm text-slate-500">
            Synced from WhatsApp + manual entries.
          </p>
        </header>

        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
          <form
            onSubmit={handleAdd}
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          >
            <Field label="Phone">
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                placeholder="0812xxxx or +628xxxx"
              />
            </Field>
            <Field label="Display name">
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="Jane Doe"
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={busy} className="w-full sm:w-auto">
                {busy ? <Spinner /> : 'Add'}
              </Button>
            </div>
          </form>
        </section>

        <section className="mt-6">
          <div className="mb-3 flex items-center justify-between gap-2">
            <Input
              type="search"
              placeholder="Search by name or phone…"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="max-w-sm"
            />
            <span className="text-xs text-slate-500">
              {rows.length} contact{rows.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            {loading ? (
              <div className="flex items-center justify-center p-12 text-slate-400">
                <Spinner size={24} />
              </div>
            ) : rows.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">
                {search
                  ? 'No contacts match your search.'
                  : 'No contacts yet. Add one above, or connect WhatsApp on the WhatsApp page — synced contacts will appear here.'}
              </div>
            ) : (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-slate-700">Name</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-700">Phone</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-700">Source</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-700">WA</th>
                    <th className="px-4 py-3 text-right font-medium text-slate-700">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-3 text-slate-900">
                        {editingId === c.id ? (
                          <div className="flex gap-2">
                            <Input
                              autoFocus
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleRename(c);
                                if (e.key === 'Escape') {
                                  setEditingId(null);
                                  setEditName('');
                                }
                              }}
                              className="max-w-[200px]"
                            />
                            <Button
                              variant="secondary"
                              onClick={() => void handleRename(c)}
                            >
                              Save
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setEditingId(null);
                                setEditName('');
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          c.displayName
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-600">{c.phone}</td>
                      <td className="px-4 py-3">
                        <Badge tone={c.source === 'synced' ? 'info' : 'neutral'}>
                          {c.source}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {c.verifiedOnWhatsapp === true ? (
                          <Badge tone="success">verified</Badge>
                        ) : c.verifiedOnWhatsapp === false ? (
                          <Badge tone="danger">not on WA</Badge>
                        ) : (
                          <Badge tone="warning">unverified</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          {editingId !== c.id && (
                            <Button
                              variant="secondary"
                              onClick={() => {
                                setEditingId(c.id);
                                setEditName(c.displayName);
                              }}
                            >
                              Rename
                            </Button>
                          )}
                          <Button variant="danger" onClick={() => void handleDelete(c)}>
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
