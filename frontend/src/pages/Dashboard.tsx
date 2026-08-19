import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import * as schedulerApi from '../api/scheduler';
import type { WaStatus } from '../api/wa';
import { ComposeScheduleForm } from '../components/ComposeScheduleForm';
import { InstallButton } from '../components/InstallButton';
import { WaStatusDot } from '../components/WaStatusIndicator';
import { useNow } from '../hooks/useNow';
import { formatCountdown, formatFriendly, formatInZone } from '../lib/dates';
import type { ScheduledMessage } from '../lib/types';
import { useAuthStore } from '../stores/auth';
import { useWaStore } from '../stores/wa';

type NavItem = {
  to: string;
  label: string;
  hint: string;
  superuserOnly: boolean;
};

const nav: NavItem[] = [
  { to: '/app/contacts', label: 'Contacts', hint: 'people who get your promises', superuserOnly: false },
  { to: '/app/schedule', label: 'Promises', hint: 'upcoming, recurring, history', superuserOnly: false },
  { to: '/app/settings', label: 'Settings', hint: 'timezone, password', superuserOnly: false },
  { to: '/app/admin', label: 'Admin', hint: 'provision users', superuserOnly: true },
];

const STATUS_LABEL: Record<WaStatus, string> = {
  connected: 'Connected',
  connecting: 'Linking',
  qr_pending: 'Awaiting scan',
  disconnected: 'Disconnected',
  logged_out: 'Logged out',
  failed: 'Failed',
};

const STATUS_CTA: Record<WaStatus, string> = {
  connected: 'Manage →',
  connecting: 'Open →',
  qr_pending: 'Finish pairing →',
  disconnected: 'Connect →',
  logged_out: 'Connect →',
  failed: 'Reconnect →',
};

const STATUS_SUBTEXT: Record<WaStatus, string> = {
  connected: 'Ready to send scheduled messages.',
  connecting: 'Establishing link with WhatsApp…',
  qr_pending: 'Scan the QR code on the WhatsApp page.',
  disconnected: 'No active session. Pair a number to start.',
  logged_out: 'Session ended on the phone. Re-pair to continue.',
  failed: 'Connection could not be established.',
};

export function Dashboard() {
  const user = useAuthStore((s) => s.user);
  const status = useWaStore((s) => s.status);
  const jid = useWaStore((s) => s.jid);
  const lastError = useWaStore((s) => s.lastError);
  const items = useMemo(
    () => nav.filter((n) => !n.superuserOnly || user?.role === 'superuser'),
    [user?.role],
  );

  const tz = user?.timezone ?? 'UTC';
  // One timer for the whole list; per-row calls would multiply timers for nothing.
  const now = useNow();
  const [nextUp, setNextUp] = useState<ScheduledMessage[]>([]);
  const [totalUpcoming, setTotalUpcoming] = useState(0);

  const loadNext = useCallback(async () => {
    try {
      const r = await schedulerApi.list('upcoming');
      if (r.kind === 'scheduled') {
        setNextUp(r.items.slice(0, 3));
        setTotalUpcoming(r.items.length);
      }
    } catch {
      /* quiet */
    }
  }, []);

  useEffect(() => {
    void loadNext();
  }, [loadNext]);

  const hourOfDay = new Date().getHours();
  const greeting =
    hourOfDay < 5
      ? 'Up late'
      : hourOfDay < 12
        ? 'Good morning'
        : hourOfDay < 18
          ? 'Good afternoon'
          : 'Good evening';

  return (
    <main className="mx-auto max-w-3xl px-6 pb-24 pt-10 sm:pt-16">
      {/* Masthead greeting */}
      <section
        className="animate-fadeInUp"
        style={{ animationDelay: '0ms' }}
      >
        <div className="eyebrow">
          №{new Date().getFullYear()} · {user?.timezone}
        </div>
        {/* Explicitly italic because the roman Fraunces face is no longer
            shipped — it was 67KB of woff2 serving this one heading, and every
            other display element in the app was already italic. Without the
            keyword this still *renders* italic (font matching falls back to the
            only face in the family), but it would be italic by accident. The
            name below now differs from the greeting by colour, not by slant. */}
        <h1 className="mt-3 font-display text-[44px] italic leading-[1.05] tracking-tight text-ink sm:text-[56px]">
          {greeting},
          <br />
          <span className="italic text-ink-soft">{user?.email?.split('@')[0]}</span>.
        </h1>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-soft">
          Write a promise. Send it later.
          <br />
          <span className="text-ink-muted">
            Your self-hosted ledger of messages that haven't been sent yet.
          </span>
        </p>
        <div className="mt-4">
          <InstallButton />
        </div>
      </section>

      <hr className="mt-10" />

      {/* WhatsApp connection */}
      <section
        className="mt-10 animate-fadeInUp"
        style={{ animationDelay: '120ms' }}
        aria-label="WhatsApp connection status"
      >
        <div className="flex items-baseline justify-between">
          <div className="eyebrow">WhatsApp</div>
          <Link
            to="/app/wa"
            className="eyebrow border-b border-transparent transition-colors hover:border-ink hover:text-ink"
          >
            {STATUS_CTA[status]}
          </Link>
        </div>
        <div className="mt-3 flex items-start gap-4">
          <span className="mt-1.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-rule bg-paper-raised">
            <WaStatusDot status={status} size="md" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-display text-2xl italic leading-tight text-ink">
              {STATUS_LABEL[status]}
            </div>
            {jid ? (
              <div className="mt-1 truncate font-mono text-[12px] text-ink-muted">
                {jid}
              </div>
            ) : (
              <div className="mt-1 text-[13px] text-ink-soft">
                {STATUS_SUBTEXT[status]}
              </div>
            )}
          </div>
        </div>
        {/* Not just 'failed': a replaced session (440) and missing credentials
            both land on 'disconnected' with an actionable message, and compose
            lives on this page — a bland "Disconnected" while every send fails
            is the worst version of this. Same condition as the WhatsApp page. */}
        {lastError && status !== 'connected' && (
          <div className="mt-4 border-l-2 border-accent-warm bg-accent-warm-soft/40 px-4 py-2 text-[12px] text-accent-warm">
            {lastError}
          </div>
        )}
      </section>

      <hr className="mt-10" />

      {/* Compose */}
      <section
        id="compose"
        className="mt-10 animate-fadeInUp scroll-mt-24"
        style={{ animationDelay: '240ms' }}
      >
        <div className="mb-6 flex items-baseline justify-between">
          <div>
            <div className="eyebrow">Compose</div>
            <h2 className="mt-1 font-display text-3xl italic leading-tight text-ink">
              A new promise.
            </h2>
          </div>
        </div>
        <ComposeScheduleForm onCreated={() => void loadNext()} />
      </section>

      {nextUp.length > 0 && (
        <>
          <hr className="mt-14" />
          <section
            className="mt-10 animate-fadeInUp"
            style={{ animationDelay: '340ms' }}
          >
            <div className="mb-4 flex items-baseline justify-between">
              <div className="eyebrow">Next up</div>
              <Link
                to="/app/schedule"
                className="eyebrow border-b border-transparent transition-colors hover:border-ink hover:text-ink"
              >
                View all ({totalUpcoming}) →
              </Link>
            </div>
            <ul className="divide-y divide-rule border-t border-rule">
              {nextUp.map((s) => (
                <li
                  key={s.id}
                  className="grid grid-cols-1 gap-y-1 py-3 sm:grid-cols-[205px_1fr_auto] sm:items-baseline sm:gap-x-5"
                >
                  {/* Recipient first in the DOM, not the timestamp. Stacked in
                      one column on mobile, the old order put the lightest line
                      (12px ink-soft) first and the heaviest (the name) third,
                      so the row read bottom-heavy and the two halves ran
                      together. Leading with the name makes visual order and
                      DOM order agree — which is also what a screen reader and
                      keyboard focus follow.

                      On sm+ the ledger wants the timestamp back in the left
                      column, so the three cells are placed EXPLICITLY rather
                      than by document order. Using `order` instead would put
                      the visual/DOM mismatch on mobile, where the stacked
                      layout makes it most confusing. */}
                  <div className="min-w-0 sm:col-start-2 sm:row-start-1">
                    <div className="truncate text-sm font-medium text-ink">
                      {s.recipientNameSnapshot}
                    </div>
                    <div className="truncate text-[13px] text-ink-soft">
                      {s.messageText}
                    </div>
                  </div>
                  {/* No font-mono: "Tomorrow" is prose, and mono is reserved
                      for machine output. The exact timestamp stays one hover
                      away rather than being spelled out on every row. */}
                  <div
                    className="mt-1 sm:col-start-1 sm:row-start-1 sm:mt-0"
                    title={formatInZone(s.nextRunAt, tz)}
                  >
                    <div className="text-[12px] leading-snug text-ink-soft">
                      {formatFriendly(s.nextRunAt, tz, now)}
                    </div>
                    <div className="text-[11px] leading-snug text-ink-muted">
                      {formatCountdown(s.nextRunAt, now, tz)}
                    </div>
                  </div>
                  {s.cronExpression && (
                    <div className="font-mono text-[11px] text-accent sm:col-start-3 sm:row-start-1">
                      {s.cronExpression}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {/* Nav rail */}
      <hr className="mt-14" />
      <nav
        className="mt-10 animate-fadeInUp"
        style={{ animationDelay: '420ms' }}
        aria-label="App sections"
      >
        <div className="eyebrow mb-4">Elsewhere</div>
        <ul className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                className="group block border-l-2 border-transparent py-1 pl-4 transition-colors hover:border-ink"
              >
                <div className="font-display text-lg italic text-ink transition-colors group-hover:text-accent">
                  {item.label}
                </div>
                <div className="mt-0.5 text-[12px] text-ink-muted">
                  {item.hint}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-16 border-t border-rule pt-5 text-center">
        <div className="eyebrow">Promitto · self-hosted · one VPS</div>
      </div>
    </main>
  );
}
