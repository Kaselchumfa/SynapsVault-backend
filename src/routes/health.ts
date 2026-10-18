import { Router, type Router as RouterType } from "express";
import { getCachedProbes } from "../lib/probes.js";
import { overallReadinessStatus } from "../lib/readiness.js";
import { isAccepting } from "../lib/lifecycle.js";
import { pgClient } from "../db/client.js";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

const router: RouterType = Router();

// Liveness probe — is the service running?
router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "synapsvault",
    version: "1.0.0",
    network: config.NETWORK,
    timestamp: new Date().toISOString(),
  });
});

// Readiness probe — is the service ready to handle requests?
router.get("/health/ready", async (_req, res) => {
  if (!isAccepting()) {
    res.status(503).json({
      status: "shutting_down",
      service: "synapsvault",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const checks = await getCachedProbes();
  const status = overallReadinessStatus(checks);
  const statusCode = status === "ok" ? 200 : 503;

  res.status(statusCode).json({
    status,
    service: "synapsvault",
    checks,
    version: "1.0.0",
    network: config.NETWORK,
    timestamp: new Date().toISOString(),
  });
});

// Debug DB endpoint — exposes schema details, so never served in production.
router.get("/debug/db", async (_req, res) => {
  if (config.NODE_ENV === "production") {
    throw new AppError("NOT_FOUND", "Not found");
  }
  try {
    // Use raw postgres client to avoid drizzle abstraction
    const result = await pgClient`SELECT current_database() as db, current_schema() as schema, version() as pg_version`;
    const tables = await pgClient`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    const pubCount = await pgClient`SELECT count(*)::int as cnt FROM publishers`;
    const resCount = await pgClient`SELECT count(*)::int as cnt FROM resources`;
    res.json({
      connection: result[0],
      tables: tables.map((t: any) => t.table_name),
      publishers: pubCount[0].cnt,
      resources: resCount[0].cnt,
    });
  } catch {
    throw new AppError("INTERNAL_ERROR", "Database debug query failed");
  }
});

export default router;
