import { PerformanceObserver, constants as perfConstants } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { logger } from './logger.js';

// 5 minutes = 288 lines/day, which sits comfortably inside the 10m x 5 json-file
// rotation now configured in docker-compose.prod.yml. Do not make this more
// frequent: the point is a multi-day trend line, and the failure mode this whole
// module exists to catch took ~72h to develop.
const TICK_MS = 300_000;

// The Aug 2026 aborts were preceded by GC eating ~40% of wall-clock
// (`average mu = 0.594` in the V8 death rattle). 0.25 is deliberately well below
// that: by the time you are at 0.4 the process is already dying, so the warning
// has to fire while there is still time to look.
const HEAP_USED_PCT_WARN = 0.85;
const GC_PCT_WARN = 0.25;
// One bad tick is noise — a single large GC pass inside a 5-minute window can
// clear 0.25 without meaning anything. Two consecutive ticks is a trend.
const GC_WARN_CONSECUTIVE_TICKS = 2;

const BYTES_PER_MB = 1024 * 1024;

// These lines are meant to be read by a human scanning a log at 3am, not just
// piped through jq — raw byte counts are unreadable at a glance.
function mb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

function frac(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// A GC entry carries `detail: { kind, flags }` at runtime, but @types/node's
// PerformanceEntry does not declare `detail` at all (only PerformanceMark and
// PerformanceMeasure do, and there it is `any`, which this repo's lint bans).
// Narrowed structurally from `unknown` rather than cast, so a future runtime
// that stops emitting `kind` degrades to "not major" instead of throwing.
function gcKindOf(entry: unknown): number | undefined {
  if (typeof entry !== 'object' || entry === null || !('detail' in entry)) {
    return undefined;
  }
  const { detail } = entry;
  if (typeof detail !== 'object' || detail === null || !('kind' in detail)) {
    return undefined;
  }
  const { kind } = detail;
  return typeof kind === 'number' ? kind : undefined;
}

/** Compact snapshot for /api/health. Cheap enough to call per request. */
export function memorySnapshot(): {
  rssMb: number;
  heapUsedMb: number;
  heapUsedPct: number;
} {
  const mem = process.memoryUsage();
  const heap = getHeapStatistics();
  return {
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    heapUsedPct: frac(mem.heapUsed / heap.heap_size_limit),
  };
}

// Answers three questions that could previously only be guessed at: is heapUsed
// trending monotonically up across days or sawtoothing (retention vs. churn), is
// GC pressure climbing toward the crash signature, and what does each additional
// paired WhatsApp session actually cost. All three need a time series, which is
// why this emits on a fixed interval rather than on an event.
class MemoryMonitor {
  private timer: NodeJS.Timeout | null = null;
  private observer: PerformanceObserver | null = null;
  // Injected rather than imported. lib/ never reaches into modules/ anywhere
  // else in this codebase, and a direct import of sessionManager here would put
  // a cycle one careless import away — manager.ts already imports lib/logger.
  private waSessionCount: () => number = () => 0;

  // Zeroed every tick on purpose: gcPct must describe *this* interval. A
  // since-boot average converges to a flat line and would have shown nothing as
  // the process degraded over 72h.
  private gcMs = 0;
  private gcMajorMs = 0;
  private gcCount = 0;
  private gcMajorCount = 0;
  private windowStart = 0;

  // Warnings are armed/re-armed per metric so a sustained bad state produces one
  // line, not one line every 5 minutes into a log that until now was never
  // rotated at all.
  private heapWarned = false;
  private gcWarned = false;
  private gcHighTicks = 0;

  start(waSessionCount: () => number): void {
    if (this.timer) return;
    this.waSessionCount = waSessionCount;
    this.windowStart = Date.now();

    // We only ever sum durations off these entries and drop them; retaining the
    // entry objects would make the leak detector a leak. `buffered` is off for
    // the same reason.
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.gcMs += entry.duration;
        this.gcCount += 1;
        if (gcKindOf(entry) === perfConstants.NODE_PERFORMANCE_GC_MAJOR) {
          this.gcMajorMs += entry.duration;
          this.gcMajorCount += 1;
        }
      }
    });
    this.observer.observe({ entryTypes: ['gc'] });

    this.timer = setInterval(() => {
      this.tick();
    }, TICK_MS);
    // Observability must never be the reason the process refuses to exit.
    // PerformanceObserver has no unref() (verified on node 20) but does not hold
    // the loop open by itself — a process with nothing but a GC observer exits
    // immediately — so unref'ing the timer is the whole of what is needed here.
    this.timer.unref();

    // No immediate tick: the first window would be a few milliseconds long and
    // gcPct over it is meaningless.
    logger.info({ intervalMs: TICK_MS }, 'memory monitor started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    logger.info('memory monitor stopped');
  }

  private tick(): void {
    // Telemetry must never be able to take down the process it is watching.
    try {
      const now = Date.now();
      const windowMs = now - this.windowStart;
      const gcMs = this.gcMs;
      const gcMajorMs = this.gcMajorMs;
      const gcCount = this.gcCount;
      const gcMajorCount = this.gcMajorCount;
      this.gcMs = 0;
      this.gcMajorMs = 0;
      this.gcCount = 0;
      this.gcMajorCount = 0;
      this.windowStart = now;

      const mem = process.memoryUsage();
      const heap = getHeapStatistics();
      const heapUsedPct = mem.heapUsed / heap.heap_size_limit;
      // Guard the first tick and any clock oddity; a zero window would divide
      // by zero and emit Infinity into the series.
      const gcPct = windowMs > 0 ? gcMs / windowMs : 0;

      logger.info(
        {
          rssMb: mb(mem.rss),
          heapUsedMb: mb(mem.heapUsed),
          heapTotalMb: mb(mem.heapTotal),
          externalMb: mb(mem.external),
          arrayBuffersMb: mb(mem.arrayBuffers),
          heapSizeLimitMb: mb(heap.heap_size_limit),
          mallocedMb: mb(heap.malloced_memory),
          peakMallocedMb: mb(heap.peak_malloced_memory),
          // The classic retention tell. A context that stays detached across
          // ticks is garbage V8 cannot collect because something still points at
          // it; a number that only ever climbs is the proof of a real leak that
          // the "memory is always reclaimed" reading of the Aug 2026 crashes
          // could not rule in or out.
          detachedContexts: heap.number_of_detached_contexts,
          heapUsedPct: frac(heapUsedPct),
          // Fraction of THIS window spent in GC. Major GC is the half that
          // matters — minor (scavenge) time is normal churn.
          gcPct: frac(gcPct),
          gcMajorPct: frac(windowMs > 0 ? gcMajorMs / windowMs : 0),
          gcCount,
          gcMajorCount,
          // Correlates memory against paired sessions, which is the only way to
          // price the next friend added to this box.
          waSessions: this.waSessionCount(),
          uptimeSec: Math.round(process.uptime()),
          windowSec: Math.round(windowMs / 1000),
        },
        'memory telemetry',
      );

      this.evaluate(heapUsedPct, gcPct);
    } catch (err) {
      logger.error({ err }, 'memory monitor tick failed');
    }
  }

  private evaluate(heapUsedPct: number, gcPct: number): void {
    const reasons: string[] = [];

    if (heapUsedPct > HEAP_USED_PCT_WARN) {
      if (!this.heapWarned) {
        this.heapWarned = true;
        reasons.push('heapUsedPct');
      }
    } else {
      this.heapWarned = false;
    }

    if (gcPct > GC_PCT_WARN) {
      this.gcHighTicks += 1;
      if (this.gcHighTicks >= GC_WARN_CONSECUTIVE_TICKS && !this.gcWarned) {
        this.gcWarned = true;
        reasons.push('gcPct');
      }
    } else {
      this.gcHighTicks = 0;
      this.gcWarned = false;
    }

    if (reasons.length === 0) return;

    logger.warn(
      {
        reasons,
        heapUsedPct: frac(heapUsedPct),
        gcPct: frac(gcPct),
        heapUsedPctThreshold: HEAP_USED_PCT_WARN,
        gcPctThreshold: GC_PCT_WARN,
      },
      'memory pressure — this is the shape that preceded the Aug 2026 heap aborts',
    );
  }
}

export const memoryMonitor = new MemoryMonitor();
