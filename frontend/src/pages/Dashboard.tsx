import { Link } from 'react-router-dom';
import { InstallButton } from '../components/InstallButton';
import { AppHeader } from '../components/ui/AppHeader';
import { useAuthStore } from '../stores/auth';

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

export function Dashboard() {
  const user = useAuthStore((s) => s.user);
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

        <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
