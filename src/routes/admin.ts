/**
 * SynapsVault — Admin Routes
 * Protected by X-Admin-Key header. Never expose to the public internet
 * without an additional layer (VPN / IP whitelist recommended).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { db } from "../db/client.js";
import { resources, publishers, payments } from "../db/schema.js";
import { desc, count, and, eq, gte, lte, type SQL } from "drizzle-orm";
import { getLogger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import { adminDelistResource } from "../services/resourceService.js";

const router = Router();

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time check of X-Admin-Key against ADMIN_API_KEY (disabled when unset). */
function adminAuth(req: Request, _res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_API_KEY;
  const key = req.headers["x-admin-key"];
  if (!expected || typeof key !== "string" || !timingSafeEqual(digest(key), digest(expected))) {
    throw new AppError("UNAUTHORIZED", "Unauthorized");
  }
  next();
}

/** GET /admin/stats */
router.get("/admin/stats", adminAuth, async (_req, res) => {
  const [[totalResources], [totalPublishers], [totalPayments]] = await Promise.all([
    db.select({ count: count() }).from(resources),
    db.select({ count: count() }).from(publishers),
    db.select({ count: count() }).from(payments),
  ]);

  res.json({
    resources:  totalResources.count,
    publishers: totalPublishers.count,
    payments:   totalPayments.count,
    uptime:     process.uptime(),
    timestamp:  new Date().toISOString(),
  });
});

/** POST /admin/delist/:id */
router.post("/admin/delist/:id", adminAuth, async (req, res) => {
  const id = req.params.id as string;
  const resource = await adminDelistResource(id);
  if (!resource) {
    throw new AppError("NOT_FOUND", "Resource not found");
  }
  getLogger().warn({ resourceId: id, event: "admin_delist" }, "resource delisted by admin");
  res.json({ success: true, id, delistedAt: new Date().toISOString() });
});

/** Parse an optional ISO date query param; throws VALIDATION_ERROR when invalid. */
function parseDateParam(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name} date`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name} date`);
  }
  return parsed;
}

/** GET /admin/audit */
router.get("/admin/audit", adminAuth, async (req, res) => {
  const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), 200);
  const page  = Math.max(Math.trunc(Number(req.query.page)) || 1, 1);
  const offset = (page - 1) * limit;

  const resourceId = typeof req.query.resourceId === "string" && req.query.resourceId !== ""
    ? req.query.resourceId
    : undefined;
  const payer = typeof req.query.payer === "string" && req.query.payer !== ""
    ? req.query.payer
    : undefined;
  const from = parseDateParam(req.query.from, "from");
  const to = parseDateParam(req.query.to, "to");

  const conditions: SQL[] = [];
  if (resourceId !== undefined) conditions.push(eq(payments.resourceId, resourceId));
  if (payer !== undefined) conditions.push(eq(payments.payerAddress, payer));
  if (from !== undefined) conditions.push(gte(payments.paidAt, from));
  if (to !== undefined) conditions.push(lte(payments.paidAt, to));

  const rows = await db
    .select({ id: payments.id, resourceId: payments.resourceId,
              payer: payments.payerAddress, amount: payments.amount, paidAt: payments.paidAt })
    .from(payments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(payments.paidAt))
    .limit(limit)
    .offset(offset);

  res.json({ page, limit, entries: rows });
});

export default router;
