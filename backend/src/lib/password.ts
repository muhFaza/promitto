import argon2 from 'argon2';

// Argon2id is *designed* to be memory-hard: node-argon2's default `memoryCost`
// is 64 MiB per operation, allocated natively (outside the V8 heap, so
// --max-old-space-size does nothing to bound it). node-argon2 runs on libuv's
// threadpool, which defaults to 4 threads — so four concurrent hashes can ask
// for ~256 MiB on a container capped at 384 MiB.
//
// That is not theoretical here. Both password entry points are reachable
// unauthenticated: POST /api/auth/login (20 burst per IP) and POST
// /api/invite/:token (10 burst). Bursting either can push the container past
// its cgroup limit, and a SIGKILL is the one failure this box cannot absorb —
// useMultiFileAuthState writes creds.json with a plain writeFile and no atomic
// rename, so a kill mid-write truncates a live WhatsApp pairing, and there are
// no backups.
//
// Capping concurrency at 2 bounds peak Argon2 residency at ~128 MiB and leaves
// the rest of the 384 MiB for the Node baseline, SQLite and the Baileys WASM
// heap. Excess work queues rather than being rejected: these are login and
// invite paths where a slower answer is fine and a dropped one is not. The
// queue's depth is bounded in practice by the two rate limiters in front of it.
//
// Raise this only together with `mem_limit` in docker-compose.prod.yml.
const MAX_CONCURRENT_HASHES = 2;

let active = 0;
const waiting: (() => void)[] = [];

// The check-then-increment below is atomic because there is no await between
// them — do not "tidy" it into a helper that awaits first.
async function withHashSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_HASHES) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await run();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return withHashSlot(() => argon2.hash(plain, { type: argon2.argon2id }));
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return withHashSlot(async () => {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  });
}
