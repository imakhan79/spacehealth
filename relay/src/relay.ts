// The relay loop. One cycle = probe link, settle orphaned batches, send one
// batch. Every step is wrapped so that no failure (DB restart, DSN drop,
// Earth outage, malformed reply) can stop the loop or lose queued data:
// at worst a batch stays in_flight and is settled from Earth's receipts later.
import { PROTOCOL_VERSION, type UplinkEnvelope } from "../../packages/uplink-protocol/index.ts";
import { fullJitterMs } from "./backoff.ts";
import type { RelayConfig } from "./config.ts";
import type { EarthClient } from "./earth-client.ts";
import type { LinkStatus, RelayStore } from "./store.ts";

export type LogFields = Record<string, string | number | boolean | null>;
export type Logger = (level: "info" | "warn" | "error", event: string, fields?: LogFields) => void;

export interface RelayDeps {
  config: RelayConfig;
  store: RelayStore;
  earth: EarthClient;
  log: Logger;
  newBatchId: () => string;
  now: () => Date;
  random?: () => number;
}

export interface RelayState {
  linkFailures: number;
  /** Shrinks after a 413, grows back after successes. */
  batchEntryLimit: number;
  lastPurgeAt: number;
}

export function initialState(config: RelayConfig): RelayState {
  return { linkFailures: 0, batchEntryLimit: config.maxBatchEntries, lastPurgeAt: 0 };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordLinkSafely(
  deps: RelayDeps,
  status: LinkStatus,
  rttMs: number | null,
  error: string | null,
  contact: boolean,
  batchSent = false,
): Promise<void> {
  try {
    await deps.store.recordLink(status, rttMs, error, contact, batchSent);
  } catch (dbError) {
    deps.log("warn", "link_state_write_failed", { error: message(dbError) });
  }
}

function linkBackoff(state: RelayState, deps: RelayDeps): number {
  return fullJitterMs(state.linkFailures, deps.config.linkBackoffBaseMs, deps.config.linkBackoffCapMs, deps.random);
}

/** Ask Earth about batches still marked in_flight (e.g. after a crash). */
async function settleOrphans(deps: RelayDeps): Promise<void> {
  const orphans = await deps.store.inFlightBatches();
  if (orphans.length === 0) return;

  const ids = orphans.map((o) => o.batchId);
  const outcome = await deps.earth.receipts(ids);
  if (!outcome.ok) {
    deps.log("warn", "receipts_unavailable", { batches: ids.length, error: outcome.error });
    return;
  }

  const known = new Map(outcome.receipts.map((r) => [r.batch_id, r]));
  for (const id of ids) {
    const receipt = known.get(id);
    if (receipt !== undefined) {
      const counts = await deps.store.ackBatch(id, receipt.results);
      deps.log("info", "orphan_settled", { batch: id, ...counts });
    } else {
      // Earth never received it: back to the queue, no backoff penalty.
      const released = await deps.store.releaseBatch(id, "batch not received by Earth", false);
      deps.log("info", "orphan_released", { batch: id, released });
    }
  }
}

/** Runs one cycle and returns how long to wait before the next one. */
export async function runCycle(state: RelayState, deps: RelayDeps): Promise<number> {
  const { config, store, earth, log } = deps;

  // 1. Is Earth there?
  const probe = await earth.probe();
  if (!probe.ok) {
    state.linkFailures++;
    await recordLinkSafely(deps, "local_mode", null, probe.error, false);
    const wait = linkBackoff(state, deps);
    log("info", "link_down", { failures: state.linkFailures, retry_in_ms: wait, error: probe.error });
    return wait;
  }
  if (state.linkFailures > 0) log("info", "link_acquired", { rtt_ms: probe.rttMs, after_failures: state.linkFailures });
  state.linkFailures = 0;
  await recordLinkSafely(deps, "uplink_active", probe.rttMs, null, true);

  // 2. Settle anything left in flight by a previous cycle or process.
  try {
    await settleOrphans(deps);
  } catch (error) {
    log("warn", "orphan_settlement_failed", { error: message(error) });
  }

  // 3. Claim the next batch.
  const batchId = deps.newBatchId();
  const entries = await store.claimBatch(batchId, state.batchEntryLimit, config.maxBatchBytes);
  if (entries.length === 0) {
    if (Date.now() - state.lastPurgeAt >= config.purgeIntervalMs) {
      try {
        const purged = await store.purgeSynced();
        state.lastPurgeAt = Date.now();
        if (purged > 0) log("info", "queue_purged", { entries: purged });
      } catch (error) {
        log("warn", "purge_failed", { error: message(error) });
      }
    }
    return config.idlePollMs;
  }

  const envelope: UplinkEnvelope = {
    protocol: PROTOCOL_VERSION,
    spacecraft_id: config.spacecraftId,
    batch_id: batchId,
    created_at: deps.now().toISOString(),
    entries,
  };

  // 4. Transmit. From here on, any exit path must ack or release the batch;
  //    if even that fails, the batch stays in_flight for settleOrphans.
  const outcome = await earth.sendBatch(envelope);
  switch (outcome.kind) {
    case "verdict": {
      const counts = await store.ackBatch(batchId, outcome.response.results);
      await recordLinkSafely(deps, "uplink_active", probe.rttMs, null, true, true);
      state.batchEntryLimit = Math.min(config.maxBatchEntries, state.batchEntryLimit * 2);
      log("info", "batch_acknowledged", { batch: batchId, entries: entries.length, duplicate: outcome.response.duplicate, ...counts });
      if (counts.conflicted > 0) log("warn", "earth_reported_conflicts", { batch: batchId, conflicted: counts.conflicted });
      return 0; // drain the backlog while the window is open
    }
    case "too_large": {
      await store.releaseBatch(batchId, "batch too large for Earth endpoint; splitting", false);
      state.batchEntryLimit = Math.max(1, Math.floor(entries.length / 2));
      log("warn", "batch_too_large", { batch: batchId, entries: entries.length, new_limit: state.batchEntryLimit });
      return 0;
    }
    case "refused": {
      await store.releaseBatch(batchId, outcome.error, true);
      state.linkFailures++;
      await recordLinkSafely(deps, "degraded", probe.rttMs, outcome.error, true);
      const wait = linkBackoff(state, deps);
      log("error", "earth_refused_batch", { batch: batchId, error: outcome.error, retry_in_ms: wait });
      return wait;
    }
    case "retry": {
      await store.releaseBatch(batchId, outcome.error, true);
      state.linkFailures++;
      await recordLinkSafely(deps, "degraded", probe.rttMs, outcome.error, true);
      const wait = linkBackoff(state, deps);
      log("warn", "batch_send_failed", { batch: batchId, error: outcome.error, retry_in_ms: wait });
      return wait;
    }
  }
}

export interface LoopHooks {
  /** Called at least every `heartbeatEveryMs`, including while sleeping. */
  heartbeat: () => Promise<void>;
  heartbeatEveryMs: number;
}

async function sleepWithHeartbeat(ms: number, signal: AbortSignal, hooks: LoopHooks): Promise<void> {
  let remaining = ms;
  while (remaining > 0 && !signal.aborted) {
    const chunk = Math.min(remaining, hooks.heartbeatEveryMs);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, chunk);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    remaining -= chunk;
    await hooks.heartbeat().catch(() => undefined);
  }
}

export async function runRelay(deps: RelayDeps, signal: AbortSignal, hooks: LoopHooks): Promise<void> {
  const state = initialState(deps.config);
  deps.log("info", "relay_started", { spacecraft: deps.config.spacecraftId, uplink: deps.config.uplinkUrl });

  while (!signal.aborted) {
    await hooks.heartbeat().catch(() => undefined);
    let wait: number;
    try {
      wait = await runCycle(state, deps);
    } catch (error) {
      // Typically the local DB is restarting. Nothing is lost: queued rows
      // stay queued and in-flight batches get settled from receipts.
      wait = deps.config.idlePollMs;
      deps.log("error", "cycle_failed", { error: message(error), retry_in_ms: wait });
    }
    await sleepWithHeartbeat(wait, signal, hooks);
  }

  deps.log("info", "relay_stopped", {});
}
