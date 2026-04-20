import { Link } from 'react-router-dom';
import { AppHeader } from './AppHeader';

type Props = {
  title: string;
  subtitle?: string;
  phase: string;
};

export function PagePlaceholder({ title, subtitle, phase }: Props) {
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-3xl p-6">
        <div className="mb-4">
          <Link to="/app" className="text-xs text-slate-500 hover:underline">
            ← back
          </Link>
        </div>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
          Wired up in <span className="font-medium text-slate-900">{phase}</span>.
        </div>
      </main>
    </>
  );
}
