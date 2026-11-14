import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { loadConfig, type RelayConfig } from "./config.ts";
import { createEarthClient } from "./earth-client.ts";
import { runRelay, type Logger } from "./relay.ts";
import { createRelayStore, type Queryable } from "./store.ts";

const log: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};

function main(): void {
  let config: RelayConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    log("error", "config_invalid", { error: error instanceof Error ? error.message : String(error) });
    process.exit(78); // EX_CONFIG: a restart loop will not fix this
  }

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    keepAlive: true,
    application_name: "omni-relay",
  });
  // Without this, an idle client losing its connection (DB restart) would
  // crash the process with an unhandled 'error' event.
  pool.on("error", (error) => log("warn", "db_idle_client_error", { error: error.message }));

  const db: Queryable = {
    async query(text, params) {
      const result = await pool.query(text, params);
      return { rows: result.rows };
    },
  };

  const controller = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log("info", "shutdown_requested", { signal });
      controller.abort();
    });
  }
  process.on("unhandledRejection", (reason) => {
    log("error", "unhandled_rejection", { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
  });

  runRelay(
    {
      config,
      store: createRelayStore(db, config),
      earth: createEarthClient({
        baseUrl: config.uplinkUrl,
        spacecraftId: config.spacecraftId,
        secret: config.uplinkSecret,
        requestTimeoutMs: config.requestTimeoutMs,
        probeTimeoutMs: config.probeTimeoutMs,
      }),
      log,
      newBatchId: randomUUID,
      now: () => new Date(),
    },
    controller.signal,
    {
      heartbeat: () => writeFile(config.heartbeatPath, new Date().toISOString()),
      heartbeatEveryMs: 15_000,
    },
  )
    .catch((error: unknown) => {
      log("error", "relay_crashed", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => undefined));
}

main();
