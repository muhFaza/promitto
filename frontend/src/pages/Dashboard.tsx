import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import * as schedulerApi from '../api/scheduler';
import type { WaStatus } from '../api/wa';
import { ComposeScheduleForm } from '../components/ComposeScheduleForm';
import { InstallButton } from '../components/InstallButton';
import { WaStatusDot } from '../components/WaStatusIndicator';
import { AppHeader } from '../components/ui/AppHeader';
import { formatInZone } from '../lib/dates';
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
    <>
      <AppHeader />

      <main className="mx-auto max-w-3xl px-6 pb-24 pt-10 sm:pt-16">
        {/* Masthead greeting */}
        <section
          className="animate-fadeInUp"
          style={{ animationDelay: '0ms' }}
        >
          <div className="eyebrow">
            №{new Date().getFullYear()} · {user?.timezone}
          </div>
          <h1 className="mt-3 font-display text-[44px] leading-[1.05] tracking-tight text-ink sm:text-[56px]">
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
          {status === 'failed' && lastError && (
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
                    className="grid grid-cols-[auto_1fr] items-baseline gap-x-5 gap-y-1 py-3 sm:grid-cols-[130px_1fr_auto]"
                  >
                    <div className="font-mono text-[12px] text-ink-muted">
                      {formatInZone(s.nextRunAt, tz)}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink">
                        {s.recipientNameSnapshot}
                      </div>
                      <div className="truncate text-[13px] text-ink-soft">
                        {s.messageText}
                      </div>
                    </div>
                    {s.cronExpression && (
                      <div className="font-mono text-[11px] text-accent">
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
    </>
  );
}
