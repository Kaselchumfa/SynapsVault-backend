// Must load before anything else so HTTP/Express/fetch instrumentation can
// patch those modules before they're used (#307). A `node --import` preload
// (see package.json) would guarantee strict ordering; this is the pragmatic
// version for a `tsx`-run dev/prod entrypoint.
import "./tracing.js";
import type { Server } from "node:http";
import { config } from "./config.js";
import { initSentry, captureServerException } from "./lib/sentry.js";
import { createApp } from "./app.js";
import { rootLogger } from "./lib/logger.js";
import { beginShutdown, whenDrained, inFlightCount } from "./lib/lifecycle.js";
import { pgClient } from "./db/client.js";
import { startPoolMetrics, stopPoolMetrics } from "./db/client.js";
import { startRetryPendingWorker, stopRetryPendingWorker } from "./workers/retryPendingWorker.js";
import { startEventListener, stopEventListener } from "./workers/eventListener.js";
import { closeRateLimitStore } from "./lib/rateLimit/index.js";

initSentry();

const app = createApp();

// Advisory lock key used to elect a single leader across replicas. Only the
// instance holding this lock runs the background workers, so scaling out does
// not duplicate RPC load or let replicas write the same rows concurrently.
const WORKER_LEADER_LOCK_ID = 0x53594e41; // "SYNA"

let workersStarted = false;
let leaderLockHeld = false;

/**
 * Try to become the worker leader by acquiring a session-level Postgres
 * advisory lock on a dedicated connection. The lock is held for the process
 * lifetime and released during graceful shutdown.
 *
 * Returns true when this instance acquired the lock and should run workers.
 */
async function tryAcquireWorkerLeaderLock(): Promise<boolean> {
  try {
    const client = await pgClient.connect();
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [WORKER_LEADER_LOCK_ID],
    );
    const locked = result.rows[0]?.locked === true;
    if (locked) {
      leaderLockHeld = true;
      // Keep the connection open for the process lifetime so the session-level
      // lock stays held. Release it explicitly on shutdown.
      client.on("error", (err) => {
        rootLogger.error({ event: "worker_leader_lock_error", err }, "worker leader lock connection error");
      });
      return true;
    }
    // Not the leader: return the connection to the pool.
    client.release();
    return false;
  } catch (err) {
    rootLogger.error({ event: "worker_leader_lock_error", err }, "failed to acquire worker leader lock");
    return false;
  }
}

async function releaseWorkerLeaderLock(): Promise<void> {
  if (!leaderLockHeld) return;
  leaderLockHeld = false;
  try {
    const client = await pgClient.connect();
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [WORKER_LEADER_LOCK_ID]);
    } finally {
      client.release();
    }
  } catch (err) {
    rootLogger.error({ event: "worker_leader_unlock_error", err }, "failed to release worker leader lock");
  }
}

async function startWorkersIfLeader(): Promise<void> {
  if (!config.WORKERS_ENABLED) {
    rootLogger.info(
      { event: "workers_disabled" },
      "WORKERS_ENABLED is false; skipping background workers",
    );
    return;
  }

  const isLeader = await tryAcquireWorkerLeaderLock();
  if (!isLeader) {
    rootLogger.info(
      { event: "workers_skipped_not_leader" },
      "another instance holds the worker leader lock; skipping background workers",
    );
    return;
  }

  workersStarted = true;
  rootLogger.info({ event: "workers_started_as_leader" }, "acquired worker leader lock; starting background workers");
  startRetryPendingWorker();
  startEventListener();
}

const server: Server = app.listen(config.PORT, () => {
  rootLogger.info(
    {
      event: "server_start",
      port: config.PORT,
      network: config.NETWORK,
      healthUrl: `http://localhost:${config.PORT}/health`,
    },
    "SynapsVault server started",
  );

  startPoolMetrics();
  void startWorkersIfLeader();
});

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (workersStarted) {
    stopRetryPendingWorker();
    stopEventListener();
  }
  stopPoolMetrics();

  // Stop passing readiness checks so load balancers drain us before we close.
  beginShutdown();
  rootLogger.info(
    { event: "shutdown_start", signal, inFlight: inFlightCount() },
    "graceful shutdown started",
  );

  // Stop accepting new connections; existing ones keep being served.
  server.close();

  // Wait for in-flight requests to finish, bounded by the configured grace period.
  let timedOut = false;
  let drainTimer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => {
    drainTimer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, config.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  });

  await Promise.race([whenDrained(), deadline]);
  clearTimeout(drainTimer!);

  if (timedOut && inFlightCount() > 0) {
    rootLogger.warn(
      { event: "shutdown_drain_timeout", inFlight: inFlightCount() },
      "drain timed out with requests still in flight; forcing close",
    );
  }

  try {
    await closeRateLimitStore();
    await releaseWorkerLeaderLock();
    await pgClient.end({ timeout: 5 });
    const forced = timedOut && inFlightCount() > 0;
    rootLogger.info({ event: "shutdown_complete", signal, forced }, "graceful shutdown complete");
    process.exit(forced ? 1 : 0);
  } catch (err) {
    rootLogger.error({ event: "shutdown_error", err }, "error closing database pool");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  rootLogger.error({ event: "unhandled_rejection", reason }, "unhandled promise rejection");
  captureServerException(reason instanceof Error ? reason : new Error(String(reason)));
});

process.on("uncaughtException", (err) => {
  rootLogger.error({ event: "uncaught_exception", err }, "uncaught exception");
  captureServerException(err);
});
