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
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-10">
        <header>
          <div className="eyebrow">The roster</div>
          <h1 className="mt-2 font-display text-4xl italic leading-none text-ink">
            Contacts
          </h1>
          <p className="mt-3 text-sm text-ink-soft">
            Synced from WhatsApp pairing, plus anything you add by hand.
          </p>
        </header>

        <section className="mt-10 border-y border-rule py-6">
          <div className="eyebrow mb-4">Add manually</div>
          <form
            onSubmit={handleAdd}
            className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
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
            <div>
              <Button type="submit" disabled={busy} className="w-full sm:w-auto">
                {busy ? <Spinner /> : 'Add →'}
              </Button>
            </div>
          </form>
        </section>

        <section className="mt-10">
          <div className="mb-4 flex items-center justify-between gap-4">
            <Input
              type="search"
              placeholder="Search by name or phone…"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="max-w-sm"
            />
            <span className="text-[12px] text-ink-muted">
              {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
            </span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center p-16 text-ink-muted">
              <Spinner size={24} />
            </div>
          ) : rows.length === 0 ? (
            <div className="border-y border-rule px-6 py-16 text-center">
              <div className="font-display text-xl italic text-ink">
                No contacts yet.
              </div>
              <div className="eyebrow mt-2">
                {search
                  ? 'No matches for your search.'
                  : 'Add one above, or connect WhatsApp to sync.'}
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-rule">
                    <th className="eyebrow px-4 py-3 text-left">Name</th>
                    <th className="eyebrow px-4 py-3 text-left">Phone</th>
                    <th className="eyebrow px-4 py-3 text-left">Source</th>
                    <th className="eyebrow px-4 py-3 text-left">WA</th>
                    <th className="eyebrow px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-rule/60 transition-colors hover:bg-paper-raised"
                    >
                      <td className="px-4 py-4 align-top text-ink">
                        {editingId === c.id ? (
                          <div className="flex flex-wrap gap-2">
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
                      <td className="px-4 py-4 align-top font-mono text-[12px] text-ink-soft">
                        {c.phone}
                      </td>
                      <td className="px-4 py-4 align-top">
                        <Badge tone={c.source === 'synced' ? 'info' : 'neutral'}>
                          {c.source}
                        </Badge>
                      </td>
                      <td className="px-4 py-4 align-top">
                        {c.verifiedOnWhatsapp === true ? (
                          <Badge tone="success">verified</Badge>
                        ) : c.verifiedOnWhatsapp === false ? (
                          <Badge tone="danger">not on WA</Badge>
                        ) : (
                          <Badge tone="warning">unverified</Badge>
                        )}
                      </td>
                      <td className="px-4 py-4 text-right align-top">
                        <div className="flex justify-end gap-2">
                          {editingId !== c.id && (
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setEditingId(c.id);
                                setEditName(c.displayName);
                              }}
                            >
                              Rename
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            onClick={() => void handleDelete(c)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
