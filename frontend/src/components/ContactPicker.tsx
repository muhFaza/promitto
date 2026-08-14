import { useEffect, useId, useRef, useState } from 'react';
import * as contactsApi from '../api/contacts';
import type { Contact } from '../lib/types';
import { Input } from './ui/Input';

type Props = {
  value: Contact | null;
  onChange: (c: Contact | null) => void;
  placeholder?: string;
};

// Empty search box: offer the recent/pinned list rather than a blind
// alphabetical slice. Falls back to the alphabetical list when the user has
// no interaction history yet (and when /recent is unavailable).
async function fetchOptions(search: string): Promise<Contact[]> {
  if (search) {
    const r = await contactsApi.list({ search, limit: 20 });
    return r.contacts;
  }
  const recent = await contactsApi.recent(20).catch(() => null);
  if (recent && recent.contacts.length > 0) return recent.contacts;
  const r = await contactsApi.list({ limit: 20 });
  return r.contacts;
}

export function ContactPicker({
  value,
  onChange,
  placeholder = 'Search one contact…',
}: Props) {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState<Contact[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The empty-search branch chains up to two requests (recent → list fallback),
  // so a stale response can outlive a newer one. Only the latest query wins.
  const seqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!value) setInput('');
  }, [value]);

  // Close the dropdown on pointerdown outside the container. Replaces a
  // blur-based close that raced touch events on iOS Safari — blur would
  // fire before the option's onClick could register, unmounting the
  // dropdown and re-opening it on refocus.
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const el = containerRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  function query(v: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const seq = ++seqRef.current;
      setLoading(true);
      fetchOptions(v)
        .then((contacts) => {
          if (seq === seqRef.current) setOptions(contacts);
        })
        .catch(() => {
          if (seq === seqRef.current) setOptions([]);
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false);
        });
    }, 200);
  }

  function handleInput(v: string) {
    setInput(v);
    query(v);
  }

  function selectContact(c: Contact) {
    onChange(c);
    setInput('');
    setOpen(false);
  }

  if (value) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-sm border border-rule bg-paper-deep px-3 py-2"
        aria-label="Selected recipient"
      >
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">
            {value.displayName}
          </div>
          <div className="truncate font-mono text-[11px] text-ink-muted">
            {value.phone}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="eyebrow shrink-0 border-b border-transparent pb-0.5 transition-colors hover:border-ink hover:text-ink focus:outline-none"
          aria-label="Change recipient"
        >
          Change →
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        ref={inputRef}
        type="search"
        placeholder={placeholder}
        value={input}
        onFocus={() => {
          setOpen(true);
          if (options.length === 0) query(input);
        }}
        onChange={(e) => handleInput(e.target.value)}
        aria-controls={listId}
        aria-autocomplete="list"
      />
      {open && (
        <div
          id={listId}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-sm border border-rule bg-paper-raised shadow-hairline"
          role="listbox"
        >
          {loading && (
            <div className="eyebrow px-3 py-2">Searching…</div>
          )}
          {!loading && options.length === 0 && (
            <div className="px-3 py-3 text-sm text-ink-muted">No matches.</div>
          )}
          {options.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={false}
              className="block w-full border-b border-rule/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-paper-deep"
              onClick={() => selectContact(c)}
            >
              <div className="font-medium text-ink">
                {c.pinnedAt !== null && (
                  <>
                    <span aria-hidden="true" className="mr-1.5 text-accent">
                      ▪
                    </span>
                    <span className="sr-only">Pinned:</span>
                  </>
                )}
                {c.displayName}
              </div>
              <div className="font-mono text-[11px] text-ink-muted">{c.phone}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
