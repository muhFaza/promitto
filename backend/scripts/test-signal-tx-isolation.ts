/**
 * Regression guard for the patched Baileys signal-key transaction store.
 *
 * patches/@whiskeysockets+baileys+7.0.0-rc14.patch hoists the transaction
 * AsyncLocalStorage in lib/Utils/auth-utils.js to module scope, because rc14
 * creates one per makeWASocket() and never disables it — every socket and every
 * reconnect leaks another live instance, and under Node's legacy async-context
 * propagation each one tags every pending async resource. Upstream PR #2666 /
 * #2722 fix it the same way; neither had landed when rc14 shipped.
 *
 * Sharing one ALS across stores is only safe because the value is a Map keyed by
 * a per-store Symbol. Assertion 2 is the whole reason that keying exists: with a
 * naively hoisted ALS, store B running inside store A's transaction sees A's
 * ambient context and commits B's writes into A's backing store. With one paired
 * user that never happens; with several it is a silent cross-account key write.
 *
 * Run after any Baileys version bump — if the patch stops applying or upstream
 * refactors this file, this is what tells you.
 *
 *   npx tsx scripts/test-signal-tx-isolation.ts
 */
import assert from 'node:assert/strict';
import { addTransactionCapability } from '@whiskeysockets/baileys/lib/Utils/auth-utils.js';

type Bucket = Record<string, Record<string, unknown>>;

const silent = (): any => ({
  level: 'silent',
  child: () => silent(),
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
});

const opts = { maxCommitRetries: 3, delayBetweenTriesMs: 5 };

const memoryStore = (): any => {
  const d: Bucket = {};
  return {
    async get(t: string, ids: string[]) {
      const b = d[t] ?? {};
      const o: Record<string, unknown> = {};
      for (const i of ids) if (i in b) o[i] = b[i];
      return o;
    },
    async set(x: Bucket) {
      for (const t in x) {
        d[t] = d[t] ?? {};
        for (const i in x[t]) {
          const v = x[t][i];
          if (v === null) delete d[t][i];
          else d[t][i] = v;
        }
      }
    },
  };
};

const key = (id: number) => ({ '1': { keyId: id } });
const TYPE = 'app-state-sync-key';
let passed = 0;

async function main(): Promise<void> {
  // 1 — a committed transaction reaches the backing store at all
  {
    const backing = memoryStore();
    const s = addTransactionCapability(backing, silent(), opts);
    await s.transaction(async () => { await s.set({ [TYPE]: key(1) } as never); }, TYPE);
    assert.deepEqual((await backing.get(TYPE, ['1']))['1'], { keyId: 1 });
    passed++;
  }

  // 2 — THE ONE THAT MATTERS. Two stores = two users' sockets. B nested inside
  // A's transaction must not write into A.
  {
    const A = memoryStore();
    const B = memoryStore();
    const a = addTransactionCapability(A, silent(), opts);
    const b = addTransactionCapability(B, silent(), opts);
    await a.transaction(async () => {
      await a.set({ [TYPE]: key(1) } as never);
      await b.transaction(async () => {
        assert.equal(a.isInTransaction(), true, 'a should still be in its transaction');
        assert.equal(b.isInTransaction(), true, 'b should see its own transaction');
        await b.set({ [TYPE]: key(2) } as never);
      }, TYPE);
    }, TYPE);
    assert.deepEqual((await A.get(TYPE, ['1']))['1'], { keyId: 1 }, "A must NOT receive B's write");
    assert.deepEqual((await B.get(TYPE, ['1']))['1'], { keyId: 2 }, 'B must keep its own write');
    passed++;
  }

  // 3 — a nested transaction on the SAME store reuses the context, so a read
  // inside it sees writes buffered but not yet committed
  {
    const s = addTransactionCapability(memoryStore(), silent(), opts);
    await s.transaction(async () => {
      assert.equal(s.isInTransaction(), true);
      await s.set({ [TYPE]: key(7) } as never);
      const buffered = await s.transaction(async () => s.get(TYPE, ['1']), TYPE);
      assert.deepEqual(buffered['1'], { keyId: 7 }, 'should read its own buffered write');
    }, TYPE);
    assert.equal(s.isInTransaction(), false, 'transaction must not leak past its scope');
    passed++;
  }

  // 4 — no ambient transaction outside a run scope, and crucially not one
  // inherited from some other store that happens to be mid-transaction
  {
    const s = addTransactionCapability(memoryStore(), silent(), opts);
    assert.equal(s.isInTransaction(), false);
    const other = addTransactionCapability(memoryStore(), silent(), opts);
    await other.transaction(async () => {
      assert.equal(s.isInTransaction(), false, 'a bystander store must see no transaction');
    }, TYPE);
    passed++;
  }

  // 5 — many stores stay independent. If the patch regressed to a per-store ALS
  // this still passes, so it is a sanity check rather than a leak assertion:
  // the leak itself is only observable as heap growth over time.
  {
    const stores = Array.from({ length: 200 }, () =>
      addTransactionCapability(memoryStore(), silent(), opts),
    );
    for (const s of stores) assert.equal(s.isInTransaction(), false);
    passed++;
  }

  console.log(`signal-tx-isolation: ${passed}/5 assertions passed`);
}

main().catch((err) => {
  console.error(`signal-tx-isolation FAILED after ${passed} assertion(s)`);
  console.error(err);
  process.exit(1);
});
