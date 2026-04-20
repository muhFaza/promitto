import QRCode from 'qrcode';
import { useEffect, useRef } from 'react';
import { ApiError } from '../api/client';
import type { WaStatus } from '../api/wa';
import { AppHeader } from '../components/ui/AppHeader';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { useUiStore } from '../stores/ui';
import { useWaStore } from '../stores/wa';

const STATUS_TONES: Record<
  WaStatus,
  'neutral' | 'success' | 'warning' | 'danger' | 'info'
> = {
  disconnected: 'neutral',
  connecting: 'info',
  qr_pending: 'warning',
  connected: 'success',
  logged_out: 'neutral',
  failed: 'danger',
};

const STATUS_LABELS: Record<WaStatus, string> = {
  disconnected: 'disconnected',
  connecting: 'connecting',
  qr_pending: 'awaiting QR scan',
  connected: 'connected',
  logged_out: 'logged out',
  failed: 'failed',
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
      <main className="mx-auto max-w-2xl p-6">
        <header>
          <h1 className="text-2xl font-semibold text-slate-900">WhatsApp</h1>
          <p className="mt-1 text-sm text-slate-500">Pair one number per user.</p>
        </header>

        <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-xs text-slate-500">Status</div>
              <div className="mt-1">
                <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>
              </div>
            </div>
            {jid && (
              <div className="text-right">
                <div className="text-xs text-slate-500">Paired number</div>
                <div className="mt-1 font-mono text-sm text-slate-900">{jid}</div>
              </div>
            )}
          </div>

          {lastError && status !== 'connected' && (
            <div className="mt-4 rounded-md bg-red-50 p-3 text-xs text-red-800">
              {lastError}
            </div>
          )}

          <div className="mt-6">
            {status === 'disconnected' && (
              <Button onClick={handleConnect}>Connect WhatsApp</Button>
            )}

            {status === 'connecting' && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Spinner /> Connecting to WhatsApp…
                </div>
                <Button variant="secondary" onClick={handleDisconnect}>
                  Cancel
                </Button>
              </div>
            )}

            {status === 'qr_pending' && (
              <div className="space-y-4">
                <p className="text-sm text-slate-600">
                  Open WhatsApp on your phone → Settings → Linked Devices → Link a device →
                  scan this code.
                </p>
                <div className="inline-block rounded-lg border border-slate-200 bg-white p-3">
                  {latestQr ? (
                    <canvas ref={canvasRef} aria-label="WhatsApp pairing QR code" />
                  ) : (
                    <div className="flex h-[256px] w-[256px] items-center justify-center text-slate-400">
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
              <Button onClick={handleConnect}>Connect again</Button>
            )}
          </div>
        </section>

        <p className="mt-4 text-xs text-slate-500">
          One WhatsApp number per user. Auth state is stored server-side and survives
          restarts.
        </p>
      </main>
    </>
  );
}
