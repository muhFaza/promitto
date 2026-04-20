export function randomJitterMs(minMs = 2_000, maxMs = 8_000): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}
