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
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { env } from '../../config/env.js';
import { isUserJid, phoneFromJid } from '../../lib/jid.js';
import { logger } from '../../lib/logger.js';
import * as contactsService from '../contacts/service.js';
import {
  getConnection,
  listRestorable,
  resetOrphanQrPending,
  upsertStatus,
} from './service.js';
import type { SessionEvent, WaSnapshot, WaStatus } from './types.js';

// 7 attempts is a 1,2,4,8,16,32,60s ladder ≈ 123s, which also makes the
// Math.min(60_000, …) cap below reachable — at 5 attempts it topped out at 16s
// and the cap was dead config. Exhausting the ladder is no longer terminal:
// the supervisor keeps retrying on a much slower clock.
const MAX_RECONNECT_ATTEMPTS = 7;

// restartRequired (515) is an instruction, not a failure, so it must not spend
// a rung of the ladder above. Capped anyway so a server that keeps asking for
// a restart can't spin us in a tight open/close loop. The cap only bounds
// *consecutive* 515s, so it needs both halves below to be a real bound: a
// non-zero floor on the retry, and a budget that only refills once a connection
// has actually held (see STABLE_CONNECTION_MS). Without those, an
// open→515-close flap reconnects at delay 0 forever.
const MAX_IMMEDIATE_RESTARTS = 3;
const IMMEDIATE_RESTART_DELAY_MS = 1_000;

// How long a connection must stay open before it counts as "held" rather than
// part of a flap. Used to decide when the 515 budget refills and when the
// down-clock below is allowed to reset.
const STABLE_CONNECTION_MS = 60_000;

// The supervisor is the backstop for every path that could otherwise strand a
// session: a missed close event, a reconnect timer lost to a process death, a
// ladder that ran out. It reconciles DB intent against live sockets once a
// minute, on a deliberately slow backoff so it can never become a hot loop.
const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_BASE_BACKOFF_MS = 60_000;
const RECONCILE_MAX_BACKOFF_MS = 15 * 60_000;
// A session down longer than this is the signal that was missing entirely
// during the production incident: WhatsApp was dead for 1h15m behind a green
// health check because nothing ever logged the gap.
const SESSION_DOWN_WARN_MS = 5 * 60_000;
// How often to re-warn about a session that stays down. Some causes (440
// replaced, missing creds) wait on a human indefinitely, so the warning has to
// keep firing to stay useful — just not once a minute forever.
const SESSION_DOWN_WARN_INTERVAL_MS = 15 * 60_000;

// Baileys' file auth state is created by this process well after boot, by which
// point main.ts's process.umask(0o077) is in force, so every one of those files
// is 0600 at birth — verified against rc14, which writes them with a plain
// writeFile and no atomic rename that could bypass the umask. The
// full-directory sweep only exists to fix files written before that guarantee — and in production one auth dir holds ~10k pre-key files,
// where the sweep measured 801ms and ~18.5MB of allocation per run at roughly
// 6 runs/hour. That churn is a prime suspect for the heap-limit aborts, so the
// sweep now runs at most once per directory per process.
const sweptAuthDirs = new Set<string>();

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
  immediateRestarts: number;
  // Epoch ms of the most recent 'open'; 0 until this handle has ever connected.
  // Distinguishes a connection that held from one that flapped, which is the
  // only way to tell a legitimate reconnect from a loop feeding itself.
  lastOpenAt: number;
  // Sockets this handle has deliberately abandoned. Their close/open/qr events
  // are inert: acting on one would null the pointer to the *live* socket, and a
  // 401 from a socket we already replaced would take wipeAuthState() to the
  // credentials the live socket is using. Weak so an abandoned socket is still
  // collectable.
  abandonedSocks: WeakSet<WASocket>;
  // Supervisor bookkeeping. nextReconcileAt is epoch ms; 0 means eligible now.
  // downSince is when this session was first *observed* down by a reconcile
  // tick, which is what the down-duration warning is measured from.
  reconcileAttempts: number;
  nextReconcileAt: number;
  downSince: number | null;
  lastDownWarnAt: number;
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
const CONTACT_SYNC_MAX_BUFFER = 200;

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
  private supervisorTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private supervisorStopped = false;
  // Set once by shutdown() and never cleared — the process is on its way out.
  // Distinct from supervisorStopped, which only gates the reconcile loop.
  private stopped = false;
  // Epoch ms of the last reconcile tick; 0 until the supervisor has run once.
  private lastReconcileAt = 0;

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
      immediateRestarts: 0,
      lastOpenAt: 0,
      abandonedSocks: new WeakSet<WASocket>(),
      reconcileAttempts: 0,
      nextReconcileAt: 0,
      downSince: null,
      lastDownWarnAt: 0,
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

    // Already in a productive state *and* actually driving a socket — no new
    // one needed. Gating on status as well as connectPromise closes the race
    // where a caller arrives after runConnect's finally-block nulled
    // connectPromise but the handle is already live, which would spawn a
    // duplicate. The `h.sock` conjunct is load-bearing: on boot the handles map
    // is empty and ensureHandle() seeds status straight from the DB row, so a
    // restored 'connected' row would otherwise short-circuit restoreAll() into
    // a no-op and leave every paired session socketless.
    if (h.sock && (h.status === 'connected' || h.status === 'qr_pending')) return;

    if (h.connectPromise) return h.connectPromise;

    // Status is 'connecting' without a live connectPromise — runConnect's
    // 15s settle guard resolved but the socket never transitioned. Wait for
    // the next settle event rather than racing a second Baileys socket.
    // Bounded by the same settle timeout: a reconnect ladder re-emits
    // 'connecting' on every attempt and can run to a 60s backoff, so an
    // unbounded wait would park the HTTP request for minutes and leak one
    // listener per impatient retry onto the same emitter the SSE streams use.
    //
    // The `h.sock` conjunct is load-bearing for the same reason as the block
    // above: with no socket nothing will ever emit a settle event, so this
    // would park for 15s and then resolve having done nothing. That is exactly
    // the shape of a 'connecting' row restored on boot (ensureHandle seeds
    // status from the DB, the handles map is empty), which would have made
    // restoreAll() silently useless for the rows it was extended to cover.
    // Falling through instead is safe: runOpenSocket clears any armed
    // reconnect timer, so a manual Connect during a long backoff opens now
    // rather than waiting out the ladder.
    if (h.status === 'connecting' && h.sock) {
      h.reconnectAttempts = 0;
      this.resetReconcileState(h);
      return new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          h.events.off('event', handler);
          resolve();
        };
        const handler = (ev: SessionEvent): void => {
          if (ev.type === 'status' && ev.value !== 'connecting') done();
        };
        const timer: NodeJS.Timeout = setTimeout(done, CONNECT_SETTLE_TIMEOUT_MS);
        h.events.on('event', handler);
      });
    }

    h.reconnectAttempts = 0;
    h.immediateRestarts = 0;
    this.resetReconcileState(h);
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
        // trySetStatus, not setStatus: this callback's rejection is unobserved
        // (the enclosing promise is already resolved by done()), so a SQLITE_BUSY
        // throw here would surface as an unhandledRejection — now fatal.
        this.trySetStatus(h, 'failed', { error: toMessage(err) });
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
    // Synchronous, before anything is created: an openSocket() suspended in one
    // of the awaits below when SIGTERM arrived would otherwise resume after
    // shutdown() has already walked the handles, leaving a live Baileys socket
    // with nothing left to close it. restoreAll() runs long before any shutdown,
    // so this cannot wedge a normal boot.
    if (this.stopped) return;

    h.intentionalClose = false;
    if (h.reconnectTimer) {
      clearTimeout(h.reconnectTimer);
      h.reconnectTimer = null;
    }

    // A socket is still attached. openPromise only dedupes opens that are still
    // in flight — it is nulled when the socket is *created*, not when it
    // connects — so a handle sitting at sock != null / status 'connecting'
    // passes every liveness check the supervisor makes and lands here. Two
    // Baileys sockets on one set of credentials is what WhatsApp treats as a
    // conflict, and it can invalidate the pairing, so the old one goes first.
    // Nulled before the await so nothing downstream can hand it out, and
    // recorded as abandoned so its close event stays inert (see
    // handleConnectionUpdate). A warn, not an info: reaching here means a guard
    // upstream let a duplicate through and that should be visible.
    if (h.sock) {
      const stale = h.sock;
      h.sock = null;
      h.abandonedSocks.add(stale);
      logger.warn(
        { userId: h.userId, status: h.status },
        'wa opening over an existing socket — closing the old one first',
      );
      try {
        await stale.end(undefined);
      } catch (err) {
        // A close that fails must not abort the reopen: the point of getting
        // here is that this handle needs a working socket.
        logger.warn({ err, userId: h.userId }, 'wa stale socket end() failed');
      }
    }

    await fs.mkdir(h.authStatePath, { recursive: true, mode: 0o700 });
    await fs.chmod(h.authStatePath, 0o700);

    const { state, saveCreds } = await useMultiFileAuthState(h.authStatePath);
    // Only creds.json needs hardening after a save; every other file in here
    // (pre-keys, sender keys) is written by this process under the 0077 umask.
    const secureSaveCreds = async () => {
      await saveCreds();
      await this.chmodAuthFile(h.authStatePath, 'creds.json');
    };
    await this.sweepAuthState(h.authStatePath);

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
      // Must not reject: an unhandled rejection is fatal to the process now,
      // and losing one creds write is far less bad than a restart loop that
      // never gets far enough to write them either.
      void secureSaveCreds().catch((err: unknown) => {
        logger.error({ err, userId: h.userId }, 'wa creds save failed');
      });
    });

    // The socket goes in with the update so the handler can tell whether the
    // event came from the socket this handle currently owns.
    sock.ev.on('connection.update', (u) => {
      this.handleConnectionUpdate(h, sock, u);
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

    // Hard cap on the buffer: the quiet window resets on every batch, and
    // Baileys streams the initial post-pair sync in batches faster than 2s
    // apart, so a pure debounce can be starved until the stream pauses. An
    // ungraceful exit in that window loses the whole address book, and a plain
    // reconnect won't re-emit it — only another re-pair would.
    if (h.pendingContacts.size >= CONTACT_SYNC_MAX_BUFFER) {
      this.flushPendingContacts(h);
      return;
    }

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

  // Same liveness predicate the supervisor uses, deliberately: counting status
  // alone would let /api/health report a session as connected when the handle
  // has no socket behind it — which is precisely the divergence the number was
  // added to expose.
  // 0 means the supervisor has not completed a tick yet. A value older than
  // RECONCILE_INTERVAL_MS by any real margin means the timer is wedged and
  // nothing is watching the sessions any more.
  getLastReconcileAt(): number {
    return this.lastReconcileAt;
  }

  getConnectedCount(): number {
    let n = 0;
    for (const h of this.handles.values()) {
      if (h.sock && h.status === 'connected') n += 1;
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

  // Every status write in here goes through trySetStatus. This whole function
  // runs inside Baileys' ev.emit, so a synchronous SQLITE_BUSY would propagate
  // into the socket's message processing — and with the process-level fatal
  // handlers in main.ts, an escaped rejection now ends the process. A missed
  // mirror write is recoverable; losing the socket or the process over it is not.
  private handleConnectionUpdate(
    h: Handle,
    sock: WASocket,
    u: Partial<ConnectionState>,
  ): void {
    // Nothing this socket says counts once the handle has moved on. A stale
    // close would null h.sock out from under the *live* socket, a stale open
    // would write 'connected' for a connection that no longer exists, and a
    // stale qr would put a code on screen that pairs nothing — but the one that
    // matters is a stale 401: it would reach wipeAuthState() and revoke the
    // credentials the live socket is still using, and there are no backups.
    // Only a *mismatched* owner is stale. h.sock === null is the ordinary
    // post-disconnect case, where intentionalClose is what stops the handler
    // below, exactly as before.
    if (h.abandonedSocks.has(sock) || (h.sock !== null && h.sock !== sock)) {
      // Only worth a line when the event would have done something. A socket
      // winding down still emits routine updates (isOnline and friends) that
      // carry neither a connection nor a qr, and warning on those would bury
      // the case that matters.
      if (u.connection || u.qr) {
        logger.warn(
          { userId: h.userId, connection: u.connection ?? null, hasQr: Boolean(u.qr) },
          'wa ignoring connection.update from a stale socket',
        );
      }
      return;
    }

    if (u.qr) {
      h.latestQr = u.qr;
      this.trySetStatus(h, 'qr_pending', { error: null });
      h.events.emit('event', {
        type: 'qr',
        value: u.qr,
      } satisfies SessionEvent);
    }

    if (u.connection === 'open') {
      const now = Date.now();
      h.reconnectAttempts = 0;
      // The 515 budget only refills once a connection has actually held.
      // Refilling on every 'open' is what let an open→515-close flap reconnect
      // at the immediate delay indefinitely: each open handed back the full
      // budget the next close spent. lastOpenAt === 0 is the first open of the
      // process, which is the post-pair 515 handshake completing — that one
      // does count as success.
      if (h.lastOpenAt === 0 || now - h.lastOpenAt >= STABLE_CONNECTION_MS) {
        h.immediateRestarts = 0;
      }
      h.lastOpenAt = now;
      // Backoff only, not the down clock: whether this session is still "down"
      // depends on how long this connection lasts, which reconcile() decides.
      this.resetReconcileBackoff(h);
      h.latestQr = null;
      const rawJid = sock.user?.id ?? null;
      const jid = rawJid ? normalizeOwnJid(rawJid) : null;
      this.trySetStatus(h, 'connected', {
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

      // A drop used to log nothing at all, which is why the production incident
      // could not be reconstructed after the fact: no statusCode, no timing, no
      // count. statusCode is undefined for an ordinary server-side close, so
      // this is often the only evidence the socket went away.
      logger.info(
        {
          userId: h.userId,
          statusCode,
          message,
          intentional: h.intentionalClose,
          attempts: h.reconnectAttempts,
        },
        'wa connection closed',
      );

      if (h.intentionalClose) return;

      if (isLoggedOut) {
        void this.wipeAuthState(h.authStatePath);
        h.latestQr = null;
        this.trySetStatus(h, 'logged_out', {
          error: 'Logged out from phone',
          jid: null,
        });
        return;
      }

      // 515 is WhatsApp instructing the client to restart — routine right after
      // pairing, not a failure. Reconnecting immediately without spending a rung
      // of the ladder keeps a fresh pair from burning half its retry budget on
      // protocol housekeeping.
      if (
        statusCode === DisconnectReason.restartRequired &&
        h.immediateRestarts < MAX_IMMEDIATE_RESTARTS
      ) {
        h.immediateRestarts += 1;
        // Not 0: a delay of 0 makes this a synchronous-in-practice loop, and the
        // budget above is the only thing standing between a server that keeps
        // asking for a restart and a hot reconnect spin. 1s is still far faster
        // than the ladder and costs a fresh pair nothing perceptible.
        this.scheduleReconnect(
          h,
          IMMEDIATE_RESTART_DELAY_MS,
          statusCode,
          message,
          'wa restart required',
        );
        return;
      }

      // 440: another WhatsApp Web login took this session over. Retrying now
      // actively fights the other session and repeated conflicts can get the
      // number flagged, so stop instead. 'disconnected' is deliberately not
      // supervisor-eligible, in memory or in the DB, so nothing auto-retries —
      // reclaiming the session is an explicit user action.
      if (statusCode === DisconnectReason.connectionReplaced) {
        h.latestQr = null;
        h.reconnectAttempts = 0;
        this.trySetStatus(h, 'disconnected', {
          error:
            'Session was replaced by another WhatsApp Web login. Press Connect to reclaim it.',
        });
        return;
      }

      h.reconnectAttempts += 1;
      if (h.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        logger.warn(
          { userId: h.userId, attempts: h.reconnectAttempts, statusCode, message },
          'wa fast reconnect ladder exhausted — handing off to supervisor',
        );
        this.trySetStatus(h, 'failed', {
          error: `Reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts: ${message ?? 'disconnected'}. Automatic retries continue in the background.`,
        });
        return;
      }
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, h.reconnectAttempts - 1));
      this.scheduleReconnect(h, delayMs, statusCode, message, 'wa reconnect scheduled');
    }
  }

  // Arms the retry *before* writing status, deliberately. setStatus →
  // upsertStatus is synchronous better-sqlite3, and a SQLITE_BUSY throw
  // propagates out through Baileys' ev.emit — in the old order that meant the
  // timer was never armed and the session sat stranded until a human pressed
  // Connect. The status write is the expendable half of this pair.
  private scheduleReconnect(
    h: Handle,
    delayMs: number,
    statusCode: number | undefined,
    message: string | null,
    reason: string,
  ): void {
    logger.info(
      { userId: h.userId, attempt: h.reconnectAttempts, delayMs, statusCode },
      reason,
    );
    if (h.reconnectTimer) clearTimeout(h.reconnectTimer);
    h.reconnectTimer = setTimeout(() => {
      h.reconnectTimer = null;
      void this.openSocket(h).catch((e: unknown) => {
        logger.error({ err: e, userId: h.userId }, 'wa reconnect failed');
        this.trySetStatus(h, 'failed', { error: toMessage(e) });
      });
    }, delayMs);
    this.trySetStatus(h, 'connecting', { error: message ?? 'disconnected' });
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
      // Let an in-flight open finish assigning h.sock before we tear down.
      // runOpenSocket awaits fetchLatestWaWebVersion() *before* `h.sock = sock`,
      // so a logout landing in that window would skip the `if (h.sock)` block
      // entirely — never calling sock.logout(), wiping the auth dir, and then
      // having the resolving handshake write the creds straight back and flip
      // the row to 'connected'. No deadlock: runOpenSocket never awaits us.
      h.intentionalClose = true;
      if (h.openPromise) {
        try {
          await h.openPromise;
        } catch {
          // open failed on its own — nothing left to tear down from it
        }
      }
      h.reconnectAttempts = 0;
      h.immediateRestarts = 0;
      this.resetReconcileState(h);
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
            await h.sock.end(undefined);
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
    const cleared = resetOrphanQrPending();
    if (cleared > 0) {
      logger.info({ cleared }, 'reset orphan wa rows left in qr_pending');
    }
    const rows = listRestorable();
    await Promise.allSettled(
      rows.map(async (row) => {
        if (!(await this.ensureAuthStatePresent(row.userId, 'boot restore'))) return;
        try {
          await this.connect(row.userId);
          // `from` is the whole point of the log line: a restore out of
          // 'connecting' or 'failed' is a recovery that used to be impossible,
          // and the only way to tell it happened is to see it here.
          logger.info(
            { userId: row.userId, from: row.status, to: this.getSnapshot(row.userId).status },
            'wa session restored',
          );
        } catch (err) {
          logger.error(
            { err, userId: row.userId, from: row.status },
            'wa session restore failed',
          );
        }
      }),
    );
  }

  startSupervisor(): void {
    if (this.supervisorTimer) return;
    this.supervisorStopped = false;
    this.supervisorTimer = setInterval(() => {
      void this.reconcile();
    }, RECONCILE_INTERVAL_MS);
    // No immediate tick: restoreAll() has just run, so the first useful pass is
    // one interval out.
    logger.info({ intervalMs: RECONCILE_INTERVAL_MS }, 'wa session supervisor started');
  }

  stopSupervisor(): void {
    this.supervisorStopped = true;
    if (!this.supervisorTimer) return;
    clearInterval(this.supervisorTimer);
    this.supervisorTimer = null;
    logger.info('wa session supervisor stopped');
  }

  // Reconciles desired state (the DB) against actual state (live sockets). The
  // DB is the input on purpose: it is what survives a process restart, and the
  // whole class of bug this exists for is an in-memory retry that vanished with
  // the process. Every skip below is a case where acting would be worse than
  // waiting.
  async reconcile(): Promise<void> {
    if (this.supervisorStopped || this.reconciling) return;
    this.reconciling = true;
    // A tick with nothing to do is silent, which makes a healthy supervisor
    // indistinguishable from a dead timer — the same shape of blind spot this
    // whole mechanism exists to close. Stamped here rather than logged so it
    // costs nothing per tick; /api/health surfaces it as wa.lastCheckAt.
    this.lastReconcileAt = Date.now();
    try {
      for (const row of listRestorable()) {
        if (this.supervisorStopped) break;
        const h = this.ensureHandle(row.userId);

        if (h.sock && h.status === 'connected') {
          // The down clock is only cleared once this connection has held for
          // the warn window. Clearing it on every healthy tick meant a
          // drop→recover cycle shorter than SESSION_DOWN_WARN_MS reset the
          // clock before it could fire, so a session flapping every few minutes
          // — the exact failure this warning exists for — never warned at all.
          // The cost is that downMs then spans the flap rather than a single
          // outage, which is the number you want when reading a flap anyway.
          if (h.lastOpenAt > 0 && Date.now() - h.lastOpenAt >= SESSION_DOWN_WARN_MS) {
            this.resetReconcileState(h);
          }
          continue;
        }

        // The down clock runs regardless of whether we are allowed to act on
        // this session. A session stuck waiting on a human for an hour is
        // exactly what went unnoticed in production, so it has to be visible
        // even in the cases we deliberately skip below.
        const now = Date.now();
        if (h.downSince === null) h.downSince = now;
        const downMs = now - h.downSince;
        // Re-warns on a slow clock rather than every tick. A session that needs
        // a human can stay down indefinitely, and the host has no Docker log
        // rotation configured, so a per-tick warn would write ~1.4k lines/day
        // into a file nothing ever truncates.
        if (
          downMs >= SESSION_DOWN_WARN_MS &&
          now - h.lastDownWarnAt >= SESSION_DOWN_WARN_INTERVAL_MS
        ) {
          h.lastDownWarnAt = now;
          logger.warn(
            {
              userId: h.userId,
              status: h.status,
              dbStatus: row.status,
              downMs,
              lastError: h.lastError,
            },
            'wa session has been down past the warning threshold',
          );
        }

        // Work already in flight, or a fast-ladder retry already armed —
        // opening a second socket would race it.
        if (this.isBusy(h)) continue;

        // In-memory status beats the DB row while this process lives. A DB row
        // still saying 'connected' here just means a status write lost a race,
        // not that we should reconnect.
        if (this.awaitsHuman(h)) continue;

        if (now < h.nextReconcileAt) continue;

        if (!(await this.ensureAuthStatePresent(h.userId, 'supervisor'))) continue;

        // Every guard above is re-evaluated after the await, not just
        // supervisorStopped. A close landing in that window arms reconnectTimer
        // and bumps reconnectAttempts, and resuming past it would zero the
        // ladder it just started and open a second socket alongside the armed
        // timer; a 440 in the same window moves the handle to 'disconnected',
        // where reconnecting fights the login that replaced us. Ahead of the
        // counter writes below, because those are the clobber. Nothing between
        // here and openSocket() awaits, so this check holds all the way down.
        if (this.supervisorStopped) break;
        if (this.isBusy(h) || this.awaitsHuman(h)) continue;

        // Cooldown is committed before the attempt, not after it, so a throw
        // anywhere below still costs a backoff step. Counting every attempt
        // (not just thrown ones) is what makes the ladder actually escalate:
        // openSocket resolves once the socket is *created*, so a session that
        // connects and drops again would otherwise retry at the base delay
        // forever. A genuine 'open' resets this to 0.
        h.reconcileAttempts += 1;
        h.nextReconcileAt = now + reconcileBackoffMs(h.reconcileAttempts);
        // The supervisor goes through openSocket() rather than connect(), so the
        // fast reconnect ladder is ours to clear: a session it revives must get a
        // fresh ladder, or the exhausted count from last time sends the very next
        // drop straight back to 'failed' with no quick retry at all.
        // immediateRestarts is deliberately NOT cleared here — it is spent by 515
        // flaps, and refilling it once a minute from out here would hand a
        // flapping session an unbounded supply of immediate retries. It refills
        // on a connection that holds, or when a human presses Connect.
        h.reconnectAttempts = 0;
        logger.warn(
          {
            userId: h.userId,
            status: h.status,
            dbStatus: row.status,
            attempt: h.reconcileAttempts,
            downMs,
          },
          'wa supervisor recovering stranded session',
        );

        try {
          await this.openSocket(h);
        } catch (err) {
          logger.error(
            { err, userId: h.userId, attempt: h.reconcileAttempts },
            'wa supervisor recovery attempt failed',
          );
          this.trySetStatus(h, 'failed', { error: toMessage(err) });
        }
      }
    } catch (err) {
      logger.error({ err }, 'wa supervisor reconcile error');
    } finally {
      this.reconciling = false;
    }
  }

  // Opening a socket with no creds on disk emits a QR nobody is watching and
  // spends a pairing attempt for nothing, so a missing auth dir is recorded as
  // a dead row instead. Returns false when the caller should skip this user.
  private async ensureAuthStatePresent(userId: string, context: string): Promise<boolean> {
    const credsPath = path.join(env.SESSIONS_DIR, userId, 'creds.json');
    try {
      await fs.access(credsPath, fsConstants.R_OK);
      return true;
    } catch (err) {
      // Only ENOENT means the credentials are gone. EACCES, EIO, EMFILE and
      // friends are transient or environmental, and 'disconnected' is
      // deliberately not restorable — writing it for a passing I/O blip would
      // drop the user out of auto-recovery until a human noticed, and overwrite
      // lastError with a cause that isn't true. Skip the attempt instead; the
      // next tick retries, and the row keeps whatever it already said.
      if (errnoCode(err) !== 'ENOENT') {
        logger.warn(
          { err, userId, credsPath, context },
          'wa auth state check failed — skipping this attempt',
        );
        return false;
      }
      // No `err`: a missing creds file is an expected, self-explanatory state,
      // and serializing the ENOENT stack on every supervisor tick buries the
      // signal in a log the host never rotates.
      logger.warn({ userId, credsPath, context }, 'wa auth state missing — not connecting');
      const h = this.ensureHandle(userId);
      this.resetReconcileState(h);
      // jid goes with the credentials: leaving it would show a paired phone
      // number next to a message saying there are no credentials.
      this.trySetStatus(h, 'disconnected', {
        jid: null,
        error: 'Stored WhatsApp credentials are missing. Press Connect to pair again.',
      });
      return false;
    }
  }

  async shutdown(): Promise<void> {
    // Before even stopping the supervisor: awaiting the in-flight opens below
    // is not enough on its own, because a caller that has not reached
    // runOpenSocket yet has no openPromise to await. This flag is what stops
    // that one — it is checked synchronously at the top of runOpenSocket, so a
    // socket created after this point is impossible rather than merely unlikely.
    this.stopped = true;

    // First, before anything else: a supervisor tick that started a socket
    // while we tear down would leave a live Baileys connection behind with
    // intentionalClose reset to false. reconcile() re-checks this flag with no
    // await between the check and openSocket(), so setting it here is enough.
    this.stopSupervisor();

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
          await h.sock.end(undefined);
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

  // Swallows a failed status write instead of throwing. Every call site is one
  // reached from inside a Baileys ev.emit handler, or from a callback whose
  // rejection nobody observes: upsertStatus is synchronous better-sqlite3, so a
  // SQLITE_BUSY there propagates into the socket's own event processing, and
  // with main.ts's fatal handlers an escaped rejection now ends the process. A
  // stale mirror row is recoverable — the next status write or a supervisor
  // tick corrects it — and losing the socket or the process over one is not.
  // setStatus stays raw where the caller owns the stack and can afford to fail:
  // connect/disconnect and runOpenSocket, whose throws are caught upstream.
  private trySetStatus(
    h: Handle,
    status: WaStatus,
    extra?: { jid?: string | null; error?: string | null; lastConnectedAt?: Date | null },
  ): void {
    try {
      this.setStatus(h, status, extra);
    } catch (err) {
      logger.error({ err, userId: h.userId, status }, 'wa setStatus failed');
    }
  }

  // Any of these means some other path already owns this handle's next socket.
  // Shared by both of reconcile()'s check sites — before and after its await —
  // so the two cannot drift apart, which is how a second socket got opened
  // alongside an armed reconnect timer.
  private isBusy(h: Handle): boolean {
    return Boolean(
      h.connectPromise || h.openPromise || h.disconnectPromise || h.reconnectTimer,
    );
  }

  // Statuses the supervisor must never act on: two need a human (qr_pending
  // wants a phone, logged_out had its credentials revoked) and one is an
  // explicit user choice — 'disconnected' is also where a 440 lands, and
  // reconnecting into that fights the WhatsApp Web login that replaced us.
  // Shared by reconcile()'s two check sites for the same reason as isBusy: a
  // close landing during the await can move a handle into any of them.
  private awaitsHuman(h: Handle): boolean {
    return (
      h.status === 'qr_pending' || h.status === 'logged_out' || h.status === 'disconnected'
    );
  }

  // Retry bookkeeping only. Split out from resetReconcileState because 'open'
  // earns a fresh backoff ladder immediately but does not yet earn a cleared
  // down clock — that takes a connection that holds. See reconcile().
  private resetReconcileBackoff(h: Handle): void {
    h.reconcileAttempts = 0;
    h.nextReconcileAt = 0;
  }

  private resetReconcileState(h: Handle): void {
    this.resetReconcileBackoff(h);
    h.downSince = null;
    h.lastDownWarnAt = 0;
  }

  // See sweptAuthDirs: historical files only, so once per directory per process.
  private async sweepAuthState(dir: string): Promise<void> {
    const key = path.resolve(dir);
    if (sweptAuthDirs.has(key)) return;
    try {
      const entries = await fs.readdir(dir);
      await Promise.all(
        entries.map((e) =>
          fs.chmod(path.join(dir, e), 0o600).catch((err: unknown) => {
            logger.warn({ err, entry: e }, 'chmod auth state file failed');
          }),
        ),
      );
      sweptAuthDirs.add(key);
    } catch (err) {
      // Not marked swept: a transient readdir failure shouldn't permanently
      // skip hardening. Retried on the next open, never per creds.update.
      logger.warn({ err, dir }, 'chmod auth state dir failed');
    }
  }

  private async chmodAuthFile(dir: string, name: string): Promise<void> {
    try {
      await fs.chmod(path.join(dir, name), 0o600);
    } catch (err) {
      logger.warn({ err, dir, name }, 'chmod auth state file failed');
    }
  }

  // Renames rather than deletes. Baileys only needs the directory gone from the
  // path it reads, and this deployment has no backups of any kind: an rm here
  // is the one operation in the process that permanently destroys a paired
  // session. The 401 that triggers it is not always trustworthy — it can arrive
  // from a socket we already replaced, or from a transient server-side state —
  // so the credentials are moved aside for a human instead of erased. Nothing
  // prunes the leftovers on purpose; silent deletion is the thing being removed.
  private async wipeAuthState(dir: string): Promise<void> {
    const target = `${dir}.revoked-${basicIsoStamp(new Date())}`;
    try {
      await fs.rename(dir, target);
      logger.warn({ dir, target }, 'wa auth state revoked — moved aside, not deleted');
    } catch (err) {
      // Never throws. Nothing to move (ENOENT) is the common case, and every
      // caller is mid-teardown: a wipe that does not happen is recoverable, a
      // throw escaping a Baileys event handler is not.
      logger.warn({ err, dir, target }, 'wipe auth state failed');
    }
  }
}

// Exponential, with up to 20% jitter on top so several stranded sessions that
// went down together don't retry in lockstep every tick. 2 ** n overflowing to
// Infinity is harmless — Math.min clamps it to the ceiling.
//
// The returned value is a *floor*, not a schedule: nextReconcileAt is only ever
// tested by a 60s tick, so each delay rounds up to the next tick boundary and
// the jitter pushes it past the boundary it would otherwise land on. Effective
// spacing between attempts is therefore roughly 120s, 180s, 300s, 600s, then
// the 15-minute ceiling (~16-18min) — one tick slower than the raw 60/120/240
// the constants suggest. Slower is the intent here; don't "fix" it by dropping
// the jitter.
function reconcileBackoffMs(attempts: number): number {
  const base = Math.min(
    RECONCILE_MAX_BACKOFF_MS,
    RECONCILE_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
  );
  return base + Math.floor(Math.random() * base * 0.2);
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// The errno off a Node fs rejection, or null if this isn't one. Callers need to
// separate "the file is not there" from "the filesystem is unhappy right now" —
// those have opposite correct responses.
function errnoCode(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : null;
}

// ISO 8601 basic, UTC, second precision: 20260814T031500Z. Basic form because
// this ends up in a directory name and the extended form's colons are hostile
// to shells and to anything that later tars the sessions directory.
function basicIsoStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
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
