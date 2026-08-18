import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { RequireAuth } from './components/RequireAuth';
import { ToastContainer } from './components/ui/ToastContainer';
import { Admin } from './pages/Admin';
import { Contacts } from './pages/Contacts';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Privacy } from './pages/Privacy';
import { Schedule } from './pages/Schedule';
import { Settings } from './pages/Settings';

// The sole import site of `qrcode` (~10 kB gzipped), which otherwise parsed on
// first paint for everyone, /login included. Deliberately the only split route:
// splitting the other six measured at 3.5 kB gzip, not worth six more chunks to
// wait on mid-navigation.
const WhatsApp = lazy(() =>
  import('./pages/WhatsApp').then((m) => ({ default: m.WhatsApp })),
);

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/app" element={<Dashboard />} />
          <Route path="/app/wa" element={<WhatsApp />} />
          <Route path="/app/contacts" element={<Contacts />} />
          <Route path="/app/schedule" element={<Schedule />} />
          <Route path="/app/settings" element={<Settings />} />
          {/* Gated from inside the shared layout instead of getting its own
              superuser-gated layout route: a second <AppLayout/> element would
              remount AppHeader — and its event stream — on every trip in and out
              of /app/admin. The outer guard has already settled the session, so
              this one effectively only adds the role check. */}
          <Route
            path="/app/admin"
            element={
              <RequireAuth requireSuperuser>
                <Admin />
              </RequireAuth>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
      <ToastContainer />
    </>
  );
}
