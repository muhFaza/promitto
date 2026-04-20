import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { ToastContainer } from './components/ui/ToastContainer';
import { Admin } from './pages/Admin';
import { Contacts } from './pages/Contacts';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Schedule } from './pages/Schedule';
import { Settings } from './pages/Settings';
import { WhatsApp } from './pages/WhatsApp';

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/app"
          element={
            <RequireAuth>
              <Dashboard />
            </RequireAuth>
          }
        />
        <Route
          path="/app/wa"
          element={
            <RequireAuth>
              <WhatsApp />
            </RequireAuth>
          }
        />
        <Route
          path="/app/contacts"
          element={
            <RequireAuth>
              <Contacts />
            </RequireAuth>
          }
        />
        <Route
          path="/app/schedule"
          element={
            <RequireAuth>
              <Schedule />
            </RequireAuth>
          }
        />
        <Route
          path="/app/settings"
          element={
            <RequireAuth>
              <Settings />
            </RequireAuth>
          }
        />
        <Route
          path="/app/admin"
          element={
            <RequireAuth requireSuperuser>
              <Admin />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
      <ToastContainer />
    </>
  );
}
