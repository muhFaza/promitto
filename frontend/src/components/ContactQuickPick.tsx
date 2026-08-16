import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';
import type { Contact } from '../lib/types';
import { useContactsStore } from '../stores/contacts';

type Props = {
  selectedJid: string | null;
  // Null on a second tap of the selected row — aria-pressed advertises a
  // toggle, so it has to actually toggle.
  onSelect: (c: Contact | null) => void;
};

// First letter of the first two words. One-word names get one letter, and a
// name that is entirely whitespace gets none — an empty circle behind the photo
// is fine. Array.from takes the first *code point*, not the first UTF-16 unit,
// so a name starting outside the BMP (an emoji, say) doesn't render as half a
// surrogate pair.
function initials(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? '')
    .join('')
    .toUpperCase();
}

// Material Symbols `push_pin`, filled — inlined rather than pulling in an icon
// package for one glyph. The path is drawn upright (head at the top, needle
// straight down); WhatsApp's pinned-chat marker is that pin tilted, so the call
// site rotates it. Upright at this size it reads as a generic marker, which is
// why the tilt isn't decoration.
function PinIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
    </svg>
  );
}

// The initials sit *behind* the photo rather than replacing it on error, so a
// slow or missing avatar never flashes a broken-image glyph. The endpoint 404s
// for no photo, privacy-blocked, and WA-disconnected alike — all silent here.
function ContactAvatar({ contact }: { contact: Contact }) {
  const [failed, setFailed] = useState(false);

  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-rule bg-paper-deep">
      <span
        aria-hidden="true"
        className="text-[11px] font-medium tracking-wide text-ink-soft"
      >
        {initials(contact.displayName)}
      </span>
      {!failed && (
        <img
          src={`/api/contacts/${contact.id}/avatar`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}

export function ContactQuickPick({ selectedJid, onSelect }: Props) {
  const recent = useContactsStore((s) => s.recent);
  const loaded = useContactsStore((s) => s.loaded);
  const load = useContactsStore((s) => s.load);
  const hasMore = useContactsStore((s) => s.hasMore);
  const loadingMore = useContactsStore((s) => s.loadingMore);
  const showMore = useContactsStore((s) => s.showMore);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // A user with no interaction history sees the plain form.
  if (recent.length === 0) return null;

  return (
    <div>
      <div className="eyebrow mb-2">Recent contacts</div>
      <ul
        className="grid grid-cols-1 border-t border-rule sm:grid-cols-2 sm:gap-x-8"
        aria-label="Recent contacts"
      >
        {recent.map((c) => {
          const selected = selectedJid === c.jid;
          return (
            <li key={c.id} className="border-b border-rule/60">
              <button
                type="button"
                onClick={() => onSelect(selected ? null : c)}
                aria-pressed={selected}
                className={cn(
                  // The transparent left border is the padding compensation:
                  // selecting swaps its colour, it never changes the box.
                  'flex w-full items-center gap-3 rounded-sm border-l-2 px-3 py-2.5 text-left transition-colors hover:bg-paper-deep',
                  selected
                    ? 'border-accent bg-paper-deep'
                    : 'border-transparent',
                )}
              >
                <ContactAvatar contact={c} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {c.waPinnedAt !== null && (
                      <>
                        <PinIcon className="mr-1.5 inline-block h-3 w-3 -rotate-45 align-[-0.1em] text-ink-muted" />
                        <span className="sr-only">Pinned on WhatsApp:</span>
                      </>
                    )}
                    {c.displayName}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-ink-muted">
                    {c.phone}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {/* Below the list, continuing the hairline rhythm — the rows above just
          keep growing down the page. */}
      {hasMore && (
        <button
          type="button"
          onClick={() => void showMore()}
          disabled={loadingMore}
          className="eyebrow w-full border-b border-rule/60 py-2 text-center transition-colors hover:text-ink disabled:hover:text-ink-muted"
        >
          {loadingMore ? 'Loading…' : 'Show more ↓'}
        </button>
      )}
    </div>
  );
}
