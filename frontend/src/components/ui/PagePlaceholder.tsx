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
          <Link to="/app" className="text-xs text-ink-muted hover:underline">
            ← back
          </Link>
        </div>
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
        <div className="mt-6 border border-dashed border-rule bg-paper-raised p-6 text-sm text-ink-soft">
          Wired up in <span className="font-medium text-ink">{phase}</span>.
        </div>
      </main>
    </>
  );
}
