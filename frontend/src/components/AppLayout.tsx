import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { AppHeader } from './ui/AppHeader';
import { Spinner } from './ui/Spinner';

// AppHeader owns the WhatsApp event stream, so it has to outlive navigation.
// Rendered inside each page it was unmounted and remounted on every route
// change, tearing down and reopening the stream each time — a fresh long-lived
// handler on the backend per navigation, on a 384MB container. As a layout route
// it mounts once and the <Outlet/> swaps underneath it.
//
// The Suspense boundary lives here rather than around one route element so the
// header stays put while a lazily-loaded page (currently only /app/wa) fetches
// its chunk.
export function AppLayout() {
  return (
    <>
      <AppHeader />
      <Suspense
        fallback={
          <div className="flex min-h-[50vh] items-center justify-center text-ink-muted">
            <Spinner size={24} />
          </div>
        }
      >
        <Outlet />
      </Suspense>
    </>
  );
}
