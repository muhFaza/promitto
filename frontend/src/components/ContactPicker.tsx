import { useEffect, useId, useRef, useState } from 'react';
import * as contactsApi from '../api/contacts';
import type { Contact } from '../lib/types';
import { Input } from './ui/Input';

type Props = {
  value: Contact | null;
  onChange: (c: Contact | null) => void;
  placeholder?: string;
};

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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!value) setInput('');
  }, [value]);

  function query(v: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      contactsApi
        .list(v ? { search: v, limit: 20 } : { limit: 20 })
        .then((r) => setOptions(r.contacts))
        .catch(() => setOptions([]))
        .finally(() => setLoading(false));
    }, 200);
  }

  function handleInput(v: string) {
    setInput(v);
    query(v);
  }

  if (value) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-slate-300 bg-slate-50 px-3 py-2"
        aria-label="Selected recipient"
      >
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900">
            {value.displayName}
          </div>
          <div className="truncate font-mono text-xs text-slate-500">
            {value.phone}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-1 focus:ring-slate-500"
          aria-label="Change recipient"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        type="search"
        placeholder={placeholder}
        value={input}
        onFocus={() => {
          setOpen(true);
          if (options.length === 0) query(input);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => handleInput(e.target.value)}
        aria-controls={listId}
        aria-autocomplete="list"
      />
      {open && (
        <div
          id={listId}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg"
          role="listbox"
        >
          {loading && (
            <div className="px-3 py-2 text-xs text-slate-400">Searching…</div>
          )}
          {!loading && options.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-500">No matches.</div>
          )}
          {options.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={false}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(c);
                setInput('');
                setOpen(false);
              }}
            >
              <div className="font-medium text-slate-900">{c.displayName}</div>
              <div className="font-mono text-xs text-slate-500">{c.phone}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
