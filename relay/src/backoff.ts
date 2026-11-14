/**
 * Exponential backoff with full jitter (AWS Architecture Blog): uniform in
 * [0, min(cap, base * 2^(attempt-1))]. Jitter keeps a relay from hammering a
 * marginal DSN pass in lock-step with its own retries.
 */
export function fullJitterMs(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const ceiling = Math.min(capMs, baseMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
}
