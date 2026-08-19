import { useEffect, useState } from 'react';

/**
 * Current epoch ms, re-rendered on an interval so relative times stay honest.
 *
 * 30s because the finest granularity anything renders is minutes — faster is
 * invisible churn. Call this **once** at the list or section level so a single
 * timer re-renders the whole block; per-row calls multiply timers for nothing.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
