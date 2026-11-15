// DSN uplink health, computed from the batches Earth received. Pure, so it is
// unit-tested from the repo's test suite.

export interface LinkBatch {
  batchId: string;
  /** When Mission Control received the batch (epoch ms). */
  receivedAt: number;
  /** When the spacecraft relay built it (epoch ms). */
  createdAt: number;
  entries: number;
  bytes: number;
  conflicts: number;
}

export interface LinkSummary {
  batches: number;
  entries: number;
  bytes: number;
  conflicts: number;
  lastContactAt: number | null;
  /** Spacecraft clock → Earth receipt: light time plus relay/DSN queuing. */
  medianTransitMs: number | null;
  maxTransitMs: number | null;
  /** Longest stretch with no contact inside [from, now], including the open one up to now. */
  longestGap: { from: number; to: number; ms: number; open: boolean } | null;
}

export function summarizeLink(all: LinkBatch[], from: number, now: number): LinkSummary {
  const inRange = all.filter((b) => b.receivedAt >= from && b.receivedAt <= now).sort((a, b) => a.receivedAt - b.receivedAt);
  // Transit can't be negative; a small spacecraft clock skew is clamped to 0.
  const transits = inRange.map((b) => Math.max(0, b.receivedAt - b.createdAt)).sort((a, b) => a - b);
  const mid = transits.length >> 1;
  const median =
    transits.length === 0 ? null : transits.length % 2 ? transits[mid]! : (transits[mid - 1]! + transits[mid]!) / 2;

  // A gap needs contact on its left edge. Contact before the window counts (the
  // gap is then clipped to the window); with no earlier contact at all, the time
  // before the first batch is the start of history, not a loss of contact.
  const before = all.filter((b) => b.receivedAt < from).reduce<number | null>((m, b) => (m === null || b.receivedAt > m ? b.receivedAt : m), null);
  const marks = [...(before === null ? [] : [before]), ...inRange.map((b) => b.receivedAt)];
  let gap: LinkSummary["longestGap"] = null;
  for (let i = 1; i < marks.length; i++) {
    const g = { from: Math.max(marks[i - 1]!, from), to: marks[i]!, open: false };
    if (!gap || g.to - g.from > gap.ms) gap = { ...g, ms: g.to - g.from };
  }
  const last = marks.at(-1);
  if (last !== undefined) {
    const openGap = { from: Math.max(last, from), to: now, open: true };
    if (!gap || openGap.to - openGap.from > gap.ms) gap = { ...openGap, ms: openGap.to - openGap.from };
  }

  const lastContact = inRange.at(-1)?.receivedAt ?? before;
  return {
    batches: inRange.length,
    entries: inRange.reduce((n, b) => n + b.entries, 0),
    bytes: inRange.reduce((n, b) => n + b.bytes, 0),
    conflicts: inRange.reduce((n, b) => n + b.conflicts, 0),
    lastContactAt: lastContact ?? null,
    medianTransitMs: median,
    maxTransitMs: transits.at(-1) ?? null,
    longestGap: gap !== null && gap.ms > 0 ? gap : null,
  };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
