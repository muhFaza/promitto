import { useEffect } from 'react';
import { cn } from '../lib/cn';
import type { Contact } from '../lib/types';
import { useContactsStore } from '../stores/contacts';

type Props = {
  selectedJid: string | null;
  // Null on a second click of the selected chip — aria-pressed advertises a
  // toggle, so it has to actually toggle.
  onSelect: (c: Contact | null) => void;
};

export function ContactQuickPick({ selectedJid, onSelect }: Props) {
  const recent = useContactsStore((s) => s.recent);
  const loaded = useContactsStore((s) => s.loaded);
  const load = useContactsStore((s) => s.load);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // A user with no pins and no interaction history sees the plain form.
  if (recent.length === 0) return null;

  return (
    <div>
      <div className="eyebrow mb-2">Recent</div>
      <ul className="flex flex-wrap gap-2" aria-label="Recent contacts">
        {recent.map((c) => {
          const selected = selectedJid === c.jid;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(selected ? null : c)}
                aria-pressed={selected}
                className={cn(
                  'inline-flex max-w-[14rem] items-center gap-1.5 rounded-sm border bg-paper-raised px-3 py-1.5 text-sm text-ink transition-colors hover:bg-paper-deep',
                  selected ? 'border-ink' : 'border-rule',
                )}
              >
                {c.pinnedAt !== null && (
                  <>
                    <span aria-hidden="true" className="text-accent">
                      ▪
                    </span>
                    <span className="sr-only">Pinned:</span>
                  </>
                )}
                <span className="truncate">{c.displayName}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
