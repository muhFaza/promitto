import QRCode from 'qrcode';
import { useEffect, useRef } from 'react';
import { ApiError } from '../api/client';
import type { WaStatus } from '../api/wa';
import { WaStatusDot } from '../components/WaStatusIndicator';
import { AppHeader } from '../components/ui/AppHeader';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { useUiStore } from '../stores/ui';
import { useWaStore } from '../stores/wa';

const STATUS_LABELS: Record<WaStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Linking',
  qr_pending: 'Awaiting scan',
  connected: 'Connected',
  logged_out: 'Logged out',
  failed: 'Failed',
};

const STATUS_SUBS: Record<WaStatus, string> = {
  disconnected: 'No active session.',
  connecting: 'Negotiating with WhatsApp servers…',
  qr_pending: 'Scan the code below with your phone.',
  connected: 'Messages will dispatch on schedule.',
  logged_out: 'The session ended on the phone side.',
  failed: 'Something went wrong.',
};

export function WhatsApp() {
  const status = useWaStore((s) => s.status);
  const jid = useWaStore((s) => s.jid);
  const lastError = useWaStore((s) => s.lastError);
  const latestQr = useWaStore((s) => s.latestQr);
  const connect = useWaStore((s) => s.connect);
  const disconnect = useWaStore((s) => s.disconnect);
  const logout = useWaStore((s) => s.logout);
  const fetchStatus = useWaStore((s) => s.fetchStatus);
  const subscribe = useWaStore((s) => s.subscribe);
  const pushToast = useUiStore((s) => s.pushToast);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    void fetchStatus().catch(() => {});
    const unsub = subscribe();
    return () => unsub();
  }, [fetchStatus, subscribe]);

  useEffect(() => {
    if (!latestQr || !canvasRef.current) return;
    void QRCode.toCanvas(canvasRef.current, latestQr, {
      errorCorrectionLevel: 'L',
      margin: 1,
      width: 256,
      color: { dark: '#1A1A1A', light: '#FBF8F1' },
    }).catch(() => {});
  }, [latestQr]);

  async function handleConnect() {
    try {
      await connect();
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Connect failed',
        level: 'error',
      });
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect this session? Your pairing will remain.')) return;
    try {
      await disconnect();
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Disconnect failed',
        level: 'error',
      });
    }
  }

  async function handleLogout() {
    if (
      !confirm('Log out WhatsApp? This removes the pairing. You will need to scan again.')
    ) {
      return;
    }
    try {
      await logout();
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Logout failed',
        level: 'error',
      });
    }
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-2xl px-6 pb-24 pt-10">
        <header>
          <div className="eyebrow">Pairing</div>
          <h1 className="mt-2 font-display text-4xl italic leading-none text-ink">
            WhatsApp
          </h1>
          <p className="mt-3 text-sm text-ink-soft">
            One number per user. Auth state is server-side and survives restarts.
          </p>
        </header>

        <section className="mt-10 border-y border-rule py-8">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <span className="mt-1.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-rule bg-paper-raised">
                <WaStatusDot status={status} size="md" />
              </span>
              <div>
                <div className="font-display text-2xl italic leading-tight text-ink">
                  {STATUS_LABELS[status]}
                </div>
                <div className="mt-1 text-[13px] text-ink-soft">
                  {STATUS_SUBS[status]}
                </div>
              </div>
            </div>
            {jid && (
              <div className="text-right">
                <div className="eyebrow">Paired</div>
                <div className="mt-1 font-mono text-[12px] text-ink-soft">
                  {jid}
                </div>
              </div>
            )}
          </div>

          {lastError && status !== 'connected' && (
            <div className="mt-5 border-l-2 border-accent-warm bg-accent-warm-soft/40 px-4 py-2 text-[12px] text-accent-warm">
              {lastError}
            </div>
          )}

          <div className="mt-6">
            {status === 'disconnected' && (
              <Button onClick={handleConnect}>Connect WhatsApp →</Button>
            )}

            {status === 'connecting' && (
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 text-[13px] text-ink-soft">
                  <Spinner /> Connecting…
                </div>
                <Button variant="secondary" onClick={handleDisconnect}>
                  Cancel
                </Button>
              </div>
            )}

            {status === 'qr_pending' && (
              <div className="space-y-5">
                <ol className="space-y-1.5 text-[13px] text-ink-soft">
                  <li>
                    <span className="mr-2 font-mono text-[11px] text-ink-muted">
                      01
                    </span>
                    Open WhatsApp on your phone.
                  </li>
                  <li>
                    <span className="mr-2 font-mono text-[11px] text-ink-muted">
                      02
                    </span>
                    Settings → Linked Devices → Link a device.
                  </li>
                  <li>
                    <span className="mr-2 font-mono text-[11px] text-ink-muted">
                      03
                    </span>
                    Scan the code below.
                  </li>
                </ol>
                <div className="inline-block border border-rule bg-paper-raised p-4">
                  {latestQr ? (
                    <canvas ref={canvasRef} aria-label="WhatsApp pairing QR code" />
                  ) : (
                    <div className="flex h-[256px] w-[256px] items-center justify-center text-ink-muted">
                      <Spinner size={24} />
                    </div>
                  )}
                </div>
                <div>
                  <Button variant="secondary" onClick={handleDisconnect}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {status === 'connected' && (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={handleDisconnect}>
                  Disconnect
                </Button>
                <Button variant="danger" onClick={handleLogout}>
                  Log out
                </Button>
              </div>
            )}

            {(status === 'logged_out' || status === 'failed') && (
              <Button onClick={handleConnect}>Connect again →</Button>
            )}
          </div>
        </section>

        <p className="mt-6 text-[12px] text-ink-muted">
          One WhatsApp number per user. Auth state persists across container restarts.
        </p>
      </main>
    </>
  );
}
