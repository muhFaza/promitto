import { Link } from 'react-router-dom';
import { InstallButton } from '../components/InstallButton';
import { AppHeader } from '../components/ui/AppHeader';
import { WaStatusDot } from '../components/WaStatusIndicator';
import type { WaStatus } from '../api/wa';
import { useAuthStore } from '../stores/auth';
import { useWaStore } from '../stores/wa';

type NavItem = {
  to: string;
  label: string;
  hint: string;
  superuserOnly: boolean;
};

const nav: NavItem[] = [
  { to: '/app/wa', label: 'WhatsApp', hint: 'pair your number', superuserOnly: false },
  { to: '/app/contacts', label: 'Contacts', hint: 'synced + manual', superuserOnly: false },
  { to: '/app/schedule', label: 'Schedule', hint: 'one-time & recurring', superuserOnly: false },
  { to: '/app/settings', label: 'Settings', hint: 'profile + timezone', superuserOnly: false },
  { to: '/app/admin', label: 'Admin', hint: 'user management', superuserOnly: true },
];

const LABEL: Record<WaStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  qr_pending: 'Scan QR',
  disconnected: 'Disconnected',
  logged_out: 'Logged out',
  failed: 'Failed',
};

const CTA: Record<WaStatus, string> = {
  connected: 'Manage',
  connecting: 'Open',
  qr_pending: 'Finish pairing',
  disconnected: 'Connect',
  logged_out: 'Connect',
  failed: 'Reconnect',
};

const SUBTEXT: Record<WaStatus, string> = {
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
  const items = nav.filter((n) => !n.superuserOnly || user?.role === 'superuser');

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-4xl p-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">
              Hello, <span className="text-slate-600">{user?.email}</span>
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Self-hosted WhatsApp scheduler.
            </p>
          </div>
          <InstallButton />
        </header>

        <section
          className="mt-6 rounded-xl border border-slate-200 bg-white p-5"
          aria-label="WhatsApp connection status"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100">
                <WaStatusDot status={status} size="md" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-900">WhatsApp</span>
                  <span className="text-xs text-slate-400">·</span>
                  <span className="text-sm text-slate-700">{LABEL[status]}</span>
                </div>
                {jid ? (
                  <div className="truncate font-mono text-xs text-slate-500">{jid}</div>
                ) : (
                  <div className="truncate text-xs text-slate-500">{SUBTEXT[status]}</div>
                )}
              </div>
            </div>
            <Link
              to="/app/wa"
              className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              {CTA[status]}
            </Link>
          </div>
          {status === 'failed' && lastError && (
            <div className="mt-4 rounded-md bg-red-50 p-3 text-xs text-red-800">
              {lastError}
            </div>
          )}
        </section>

        <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                className="block rounded-xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-sm"
              >
                <div className="text-sm font-medium text-slate-900">{item.label}</div>
                <div className="text-xs text-slate-500">{item.hint}</div>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
