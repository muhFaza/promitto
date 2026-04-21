import type { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  type Contact as BaileysContact,
  type ConnectionState,
  type WASocket,
} from '@whiskeysockets/baileys';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { env } from '../../config/env.js';
import { isUserJid, phoneFromJid } from '../../lib/jid.js';
import { logger } from '../../lib/logger.js';
import * as contactsService from '../contacts/service.js';
import {
  clearOrphanConnecting,
  getConnection,
  listConnected,
  upsertStatus,
} from './service.js';
import type { SessionEvent, WaSnapshot, WaStatus } from './types.js';

const MAX_RECONNECT_ATTEMPTS = 5;

const baileysLogger = pino({
  level:
    env.BAILEYS_LOG_LEVEL !== 'silent'
      ? env.BAILEYS_LOG_LEVEL
      : env.NODE_ENV === 'development'
        ? 'debug'
        : 'silent',
});

type PendingContact = { jid: string; displayName: string; phone: string };

type Handle = {
  userId: string;
  sock: WASocket | null;
  status: WaStatus;
  jid: string | null;
  lastError: string | null;
  latestQr: string | null;
  events: EventEmitter;
  authStatePath: string;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  connectPromise: Promise<void> | null;
  disconnectPromise: Promise<void> | null;
  // In-flight openSocket() call. shutdown() awaits this so a SIGTERM during
  // restoreAll() can't race openSocket's `h.sock = sock` assignment and leak
  // a live Baileys connection.
  openPromise: Promise<void> | null;
  syncDebounceTimer: NodeJS.Timeout | null;
  pendingContacts: Map<string, PendingContact>;
  intentionalClose: boolean;
};

const CONNECT_SETTLE_TIMEOUT_MS = 15_000;
const CONTACT_SYNC_DEBOUNCE_MS = 2_000;

let cachedWaVersion: [number, number, number] | null = null;
let versionFetchPromise: Promise<[number, number, number] | null> | null = null;

async function getWaVersion(): Promise<[number, number, number] | null> {
  if (cachedWaVersion) return cachedWaVersion;
  if (versionFetchPromise) return versionFetchPromise;

  versionFetchPromise = fetchLatestWaWebVersion({})
    .then((r) => {
      cachedWaVersion = r.version as [number, number, number];
      logger.info({ version: cachedWaVersion }, 'fetched latest WA web version');
      return cachedWaVersion;
    })
    .catch((err: unknown) => {
      logger.warn({ err }, 'fetchLatestWaWebVersion failed — falling back to baileys default');
      return null;
    })
    .finally(() => {
      versionFetchPromise = null;
    });
  return versionFetchPromise;
}

class SessionManager {
  private readonly handles = new Map<string, Handle>();

  ensureHandle(userId: string): Handle {
    let h = this.handles.get(userId);
    if (h) return h;

    const existing = getConnection(userId);
    h = {
      userId,
      sock: null,
      status: existing?.status ?? 'disconnected',
      jid: existing?.jid ?? null,
      lastError: existing?.lastError ?? null,
      latestQr: null,
      events: new EventEmitter(),
      authStatePath: path.join(env.SESSIONS_DIR, userId),
      reconnectTimer: null,
      reconnectAttempts: 0,
      connectPromise: null,
      disconnectPromise: null,
      openPromise: null,
      syncDebounceTimer: null,
      pendingContacts: new Map(),
      intentionalClose: false,
    };
    h.events.setMaxListeners(32);
    this.handles.set(userId, h);
    return h;
  }

  getSnapshot(userId: string): WaSnapshot {
    const h = this.handles.get(userId);
    if (h) return { status: h.status, jid: h.jid, lastError: h.lastError };
    const row = getConnection(userId);
    if (row) return { status: row.status, jid: row.jid, lastError: row.lastError };
    return { status: 'disconnected', jid: null, lastError: null };
  }

  getLatestQr(userId: string): string | null {
    return this.handles.get(userId)?.latestQr ?? null;
  }

  subscribe(userId: string, listener: (ev: SessionEvent) => void): () => void {
    const h = this.ensureHandle(userId);
    h.events.on('event', listener);
    return () => h.events.off('event', listener);
  }

  async connect(userId: string): Promise<void> {
    const h = this.ensureHandle(userId);

    if (h.disconnectPromise) {
      try {
        await h.disconnectPromise;
      } catch {
        // ignored — we'll attempt a fresh connect below
      }
    }

    // Already in a productive state — no new socket needed. Gating on status
    // (not just connectPromise) closes the race where a caller arrives after
    // runConnect's finally-block nulled connectPromise but the handle is
    // already driving a live socket, which would otherwise spawn a duplicate.
    if (h.status === 'connected' || h.status === 'qr_pending') return;

    if (h.connectPromise) return h.connectPromise;

    // Status is 'connecting' without a live connectPromise — runConnect's
    // 15s settle guard resolved but the socket never transitioned. Wait for
    // the next settle event rather than racing a second Baileys socket.
    if (h.status === 'connecting') {
      return new Promise<void>((resolve) => {
        const handler = (ev: SessionEvent): void => {
          if (ev.type === 'status' && ev.value !== 'connecting') {
            h.events.off('event', handler);
            resolve();
          }
        };
        h.events.on('event', handler);
      });
    }

    h.reconnectAttempts = 0;
    h.connectPromise = this.runConnect(h);
    try {
      await h.connectPromise;
    } finally {
      h.connectPromise = null;
    }
  }

  // Resolves when the socket reaches a settled state (connected / qr_pending /
  // failed / logged_out / disconnected) or when CONNECT_SETTLE_TIMEOUT_MS
  // elapses. The Baileys `connection.update` event is what promotes the status
  // off 'connecting', so we listen to our own status events.
  private runConnect(h: Handle): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        h.events.off('event', onEvent);
        resolve();
      };
      const onEvent = (ev: SessionEvent): void => {
        if (ev.type === 'status' && ev.value !== 'connecting') done();
      };
      const timer: NodeJS.Timeout = setTimeout(done, CONNECT_SETTLE_TIMEOUT_MS);
      h.events.on('event', onEvent);

      this.openSocket(h).catch((err: unknown) => {
        logger.error({ err, userId: h.userId }, 'wa connect failed');
        this.setStatus(h, 'failed', { error: toMessage(err) });
        done();
      });
    });
  }

  // Public entrypoint: tracks the in-flight open so shutdown() can await it
  // and avoid leaking a Baileys socket if SIGTERM arrives mid-handshake.
  private openSocket(h: Handle): Promise<void> {
    if (h.openPromise) return h.openPromise;
    const promise = this.runOpenSocket(h).finally(() => {
      if (h.openPromise === promise) h.openPromise = null;
    });
    h.openPromise = promise;
    return promise;
  }

  private async runOpenSocket(h: Handle): Promise<void> {
    h.intentionalClose = false;
    if (h.reconnectTimer) {
      clearTimeout(h.reconnectTimer);
      h.reconnectTimer = null;
    }

    await fs.mkdir(h.authStatePath, { recursive: true, mode: 0o700 });
    await fs.chmod(h.authStatePath, 0o700);

    const { state, saveCreds } = await useMultiFileAuthState(h.authStatePath);
    const secureSaveCreds = async () => {
      await saveCreds();
      await this.chmodAuthState(h.authStatePath);
    };
    await this.chmodAuthState(h.authStatePath);

    this.setStatus(h, 'connecting', { error: null });

    const version = await getWaVersion();

    const sock = makeWASocket({
      auth: state,
      logger: baileysLogger,
      browser: ['Promitto', 'Desktop', '1.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      ...(version ? { version } : {}),
    });

    h.sock = sock;

    sock.ev.on('creds.update', () => {
      void secureSaveCreds();
    });

    sock.ev.on('connection.update', (u) => {
      this.handleConnectionUpdate(h, u);
    });

    sock.ev.on('contacts.upsert', (cs) => {
      this.handleContactsSync(h.userId, cs);
    });

    sock.ev.on('contacts.update', (cs) => {
      this.handleContactsSync(h.userId, cs);
    });
  }

  // Baileys emits contacts.upsert/update opportunistically with no "sync done"
  // event. We buffer incoming rows per-user and flush after a 2s quiet window
  // so one re-pair doesn't thrash SQLite with hundreds of single-row writes.
  private handleContactsSync(
    userId: string,
    cs: ReadonlyArray<Partial<BaileysContact>>,
  ): void {
    const h = this.handles.get(userId);
    if (!h) return;

    for (const c of cs) {
      const candidate = c.phoneNumber ?? c.id;
      if (!candidate || !isUserJid(candidate)) continue;
      const displayName = (c.name ?? c.notify ?? c.verifiedName ?? '').trim();
      if (!displayName) continue;
      const phone = phoneFromJid(candidate);
      if (!phone) continue;
      h.pendingContacts.set(candidate, { jid: candidate, displayName, phone });
    }

    if (h.pendingContacts.size === 0) return;

    if (h.syncDebounceTimer) clearTimeout(h.syncDebounceTimer);
    h.syncDebounceTimer = setTimeout(() => {
      this.flushPendingContacts(h);
    }, CONTACT_SYNC_DEBOUNCE_MS);
  }

  private flushPendingContacts(h: Handle): void {
    if (h.syncDebounceTimer) {
      clearTimeout(h.syncDebounceTimer);
      h.syncDebounceTimer = null;
    }
    if (h.pendingContacts.size === 0) return;

    const entries = Array.from(h.pendingContacts.values());
    h.pendingContacts.clear();

    for (const e of entries) {
      try {
        contactsService.upsertSynced({
          userId: h.userId,
          jid: e.jid,
          displayName: e.displayName,
          phone: e.phone,
        });
      } catch (err) {
        logger.warn(
          { err, userId: h.userId, jid: e.jid },
          'contacts upsertSynced failed',
        );
      }
    }
  }

  getConnectedCount(): number {
    let n = 0;
    for (const h of this.handles.values()) {
      if (h.status === 'connected') n += 1;
    }
    return n;
  }

  async sendText(
    userId: string,
    toJid: string,
    text: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const h = this.handles.get(userId);
    if (!h?.sock || h.status !== 'connected') {
      return { ok: false, error: 'wa_not_connected' };
    }
    try {
      await h.sock.sendMessage(toJid, { text });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async verifyOnWhatsapp(
    userId: string,
    phoneE164: string,
    timeoutMs: number,
  ): Promise<boolean | null> {
    const h = this.handles.get(userId);
    if (!h?.sock || h.status !== 'connected') return null;
    const sock = h.sock;
    try {
      const result = await Promise.race([
        sock.onWhatsApp(phoneE164),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]);
      if (!result || !Array.isArray(result)) return null;
      const first = result[0];
      return first ? first.exists === true : false;
    } catch (err) {
      logger.warn({ err, userId, phoneE164 }, 'onWhatsApp verify failed');
      return null;
    }
  }

  private handleConnectionUpdate(h: Handle, u: Partial<ConnectionState>): void {
    if (u.qr) {
      h.latestQr = u.qr;
      this.setStatus(h, 'qr_pending', { error: null });
      h.events.emit('event', {
        type: 'qr',
        value: u.qr,
      } satisfies SessionEvent);
    }

    if (u.connection === 'open') {
      h.reconnectAttempts = 0;
      h.latestQr = null;
      const rawJid = h.sock?.user?.id ?? null;
      const jid = rawJid ? normalizeOwnJid(rawJid) : null;
      this.setStatus(h, 'connected', {
        jid,
        error: null,
        lastConnectedAt: new Date(),
      });
    }

    if (u.connection === 'close') {
      const err = u.lastDisconnect?.error as Boom | Error | undefined;
      const statusCode =
        err && 'output' in err ? (err as Boom).output?.statusCode : undefined;
      const message = err?.message ?? null;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      h.sock = null;

      if (h.intentionalClose) return;

      if (isLoggedOut) {
        void this.wipeAuthState(h.authStatePath);
        h.latestQr = null;
        this.setStatus(h, 'logged_out', {
          error: 'Logged out from phone',
          jid: null,
        });
        return;
      }

      h.reconnectAttempts += 1;
      if (h.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        logger.warn(
          { userId: h.userId, attempts: h.reconnectAttempts, statusCode, message },
          'wa reconnect attempts exhausted — giving up',
        );
        this.setStatus(h, 'failed', {
          error: `Reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts: ${message ?? 'disconnected'}. Try Connect again or re-pair.`,
        });
        return;
      }
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, h.reconnectAttempts - 1));
      this.setStatus(h, 'connecting', { error: message ?? 'disconnected' });
      h.reconnectTimer = setTimeout(() => {
        h.reconnectTimer = null;
        void this.openSocket(h).catch((e: unknown) => {
          logger.error({ err: e, userId: h.userId }, 'wa reconnect failed');
          this.setStatus(h, 'failed', { error: toMessage(e) });
        });
      }, delayMs);
    }
  }

  async disconnect(userId: string, opts: { logout: boolean }): Promise<void> {
    const h = this.handles.get(userId);

    if (!h) {
      if (opts.logout) {
        await this.wipeAuthState(path.join(env.SESSIONS_DIR, userId));
      }
      upsertStatus({
        userId,
        status: opts.logout ? 'logged_out' : 'disconnected',
        jid: opts.logout ? null : undefined,
        lastError: null,
      });
      return;
    }

    if (h.disconnectPromise) return h.disconnectPromise;

    h.disconnectPromise = (async (): Promise<void> => {
      h.intentionalClose = true;
      h.reconnectAttempts = 0;
      if (h.reconnectTimer) {
        clearTimeout(h.reconnectTimer);
        h.reconnectTimer = null;
      }
      this.flushPendingContacts(h);

      if (h.sock) {
        try {
          if (opts.logout) {
            await h.sock.logout();
          } else {
            h.sock.end(undefined);
          }
        } catch (err) {
          logger.warn({ err, userId }, 'wa disconnect error');
        }
        h.sock = null;
      }

      if (opts.logout) {
        await this.wipeAuthState(h.authStatePath);
        h.latestQr = null;
        this.setStatus(h, 'logged_out', { error: null, jid: null });
      } else {
        this.setStatus(h, 'disconnected', { error: null });
      }
    })();

    try {
      await h.disconnectPromise;
    } finally {
      h.disconnectPromise = null;
    }
  }

  async restoreAll(): Promise<void> {
    const cleared = clearOrphanConnecting();
    if (cleared > 0) {
      logger.info({ cleared }, 'cleared orphan wa rows left in connecting/qr_pending');
    }
    const rows = listConnected();
    await Promise.allSettled(
      rows.map((row) =>
        this.connect(row.userId)
          .then(() => logger.info({ userId: row.userId }, 'wa session restored'))
          .catch((err: unknown) =>
            logger.error({ err, userId: row.userId }, 'wa session restore failed'),
          ),
      ),
    );
  }

  async shutdown(): Promise<void> {
    // Mark everything intentional first so any in-flight openSocket that
    // settles after this point won't trigger a reconnect loop via the close
    // handler.
    const inFlightOpens: Promise<void>[] = [];
    for (const h of this.handles.values()) {
      h.intentionalClose = true;
      if (h.reconnectTimer) {
        clearTimeout(h.reconnectTimer);
        h.reconnectTimer = null;
      }
      if (h.openPromise) inFlightOpens.push(h.openPromise);
    }

    // Wait for any openSocket() calls that are mid-handshake so their
    // `h.sock = sock` assignment happens before we try to close sockets.
    if (inFlightOpens.length > 0) {
      await Promise.allSettled(inFlightOpens);
    }

    for (const h of this.handles.values()) {
      // Explicit: flushPendingContacts clears this today, but the invariant
      // shouldn't depend on that — a dangling timer firing during exit would
      // try to write to a closing DB handle.
      if (h.syncDebounceTimer) {
        clearTimeout(h.syncDebounceTimer);
        h.syncDebounceTimer = null;
      }
      this.flushPendingContacts(h);
      if (h.sock) {
        try {
          h.sock.end(undefined);
        } catch (err) {
          logger.warn({ err, userId: h.userId }, 'shutdown: end() error');
        }
        h.sock = null;
      }
    }
  }

  private setStatus(
    h: Handle,
    status: WaStatus,
    extra?: {
      jid?: string | null;
      error?: string | null;
      lastConnectedAt?: Date | null;
    },
  ): void {
    h.status = status;
    if (extra?.jid !== undefined) h.jid = extra.jid;
    if (extra?.error !== undefined) h.lastError = extra.error;

    upsertStatus({
      userId: h.userId,
      status,
      jid: h.jid,
      lastError: h.lastError,
      lastConnectedAt: extra?.lastConnectedAt,
    });

    h.events.emit('event', {
      type: 'status',
      value: status,
      jid: h.jid,
      error: h.lastError,
    } satisfies SessionEvent);
  }

  private async chmodAuthState(dir: string): Promise<void> {
    try {
      await fs.chmod(dir, 0o700);
      const entries = await fs.readdir(dir);
      await Promise.all(
        entries.map((e) =>
          fs.chmod(path.join(dir, e), 0o600).catch((err: unknown) => {
            logger.warn({ err, entry: e }, 'chmod auth state file failed');
          }),
        ),
      );
    } catch (err) {
      logger.warn({ err, dir }, 'chmod auth state dir failed');
    }
  }

  private async wipeAuthState(dir: string): Promise<void> {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, dir }, 'wipe auth state failed');
    }
  }
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Baileys returns JIDs like "628xxxx:12@s.whatsapp.net"; strip the device suffix.
function normalizeOwnJid(raw: string): string {
  const at = raw.indexOf('@');
  const colon = raw.indexOf(':');
  const numEnd = colon > -1 && (at < 0 || colon < at) ? colon : at;
  if (numEnd <= 0) return raw;
  return '+' + raw.slice(0, numEnd);
}

export const sessionManager = new SessionManager();
