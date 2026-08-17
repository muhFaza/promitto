import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
// Self-hosted fonts — served from this origin so a page load tells no one else about it.
// Fraunces needs the opsz axis file (ital + opsz + wght) because headings set 'opsz' directly.
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/fraunces/opsz-italic.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* ignore */
    });
  });
}
