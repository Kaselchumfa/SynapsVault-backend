import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig } from "@x402/core/server";
import { and, eq, desc, inArray, isNull, sum, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { resources, verifications, payments } from "../db/schema.js";
import { checkOriginality } from "../services/verificationService.js";
import { emitToPublisher } from "../services/webhookService.js";

import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { getLogger } from "../lib/logger.js";
import { businessEventsTotal, verificationCostUsd } from "../lib/metrics.js";
import { network, sharedX402ResourceServer } from "../lib/x402.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { verifyIpRateLimit, verifyWalletRateLimit } from "../middleware/rateLimiters.js";
import { validate } from "../middleware/validate.js";
import { verifyContentSchema } from "../schemas/requests.js";
import { hashFileResource, hashLinkResource } from "../utils/crypto.js";

const router: RouterType = Router();

const verifyRoutes: RoutesConfig = {
  "POST /verify-content": {
    accepts: {
      scheme: "exact" as const,
      network,
      payTo: config.PAY_TO,
      price: `$${config.VERIFICATION_PRICE}`,
    },
    description: "AI content originality verification",
  },
};

const verifyPaywall = paymentMiddleware(verifyRoutes, sharedX402ResourceServer);

/**
 * Only publishers may attach a verification to their own resource, so a
 * `resourceId` in the body requires `x-api-key`. Requests without one skip
 * this entirely and keep the anonymous paid check.
 */
function requireApiKeyForResource(req: Request, res: Response, next: NextFunction) {
  if (!req.body?.resourceId) return next();
  return apiKeyAuth(req, res, next);
}

/** True when `content` is exactly what the server stored for the resource. */
function contentMatchesResource(
  content: string,
  resource: { resourceType: "file" | "link"; title: string; contentHash: string | null },
): boolean {
  if (!resource.contentHash) return false;
  try {
    const computed =
      resource.resourceType === "link"
        ? hashLinkResource(content, resource.title)
        : hashFileResource(Buffer.from(content, "utf8"), resource.title);
    return computed === resource.contentHash;
  } catch {
    // hashLinkResource throws on a value that isn't a URL.
    return false;
  }
}

/**
 * Runs before the x402 paywall, so a request that would be refused is never
 * charged. Checks that the resource belongs to the caller, has not been
 * delisted by an admin, and that `content` hashes to the stored content_hash.
 */
async function checkResourceForVerification(req: Request, _res: Response, next: NextFunction) {
  const { resourceId, content } = req.body ?? {};
  if (!resourceId) return next();

  const [resource] = await db
    .select({
      publisherId: resources.publisherId,
      title: resources.title,
      resourceType: resources.resourceType,
      contentHash: resources.contentHash,
      adminDelistedAt: resources.adminDelistedAt,
    })
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);

  if (!resource) throw new AppError("NOT_FOUND", "Resource not found");
  if (resource.publisherId !== req.publisher?.id) {
    throw new AppError("FORBIDDEN", "Forbidden: you do not own this resource");
  }
  if (resource.adminDelistedAt) {
    throw new AppError("FORBIDDEN", "Resource was delisted by an administrator and cannot be relisted");
  }
  // Non-string content is rejected by validate() after payment; only hash-check real strings here.
  if (typeof content === "string" && !contentMatchesResource(content, resource)) {
    throw new AppError("CONFLICT", "Content does not match the resource's stored content");
  }
  next();
}

// POST /verify-content — AI originality check (x402 paywalled)
router.post(
  "/verify-content",
  verifyIpRateLimit,
  requireApiKeyForResource,
  checkResourceForVerification,
  verifyPaywall,
  verifyWalletRateLimit,
  validate(verifyContentSchema),
  async (req, res) => {
    const { content, resourceId } = req.body;

    const result = await checkOriginality(content, "text");
    const { usage } = result;

    // Record business metrics for the completed verification.
    businessEventsTotal.inc({
      event: "verification.completed",
      outcome: result.isOriginal ? "original" : "not_original",
    });
    verificationCostUsd.inc(usage.estimatedCostUsd);

    // Structured usage log so verification spend is visible (#283). No content
    // or secrets are logged — only token counts and the estimated cost.
    getLogger().info(
      {
        event: "verification_usage",
        resourceId: resourceId ?? null,
        model: config.OPENROUTER_MODEL,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
      },
      "verification token usage",
    );

    // If a resourceId is provided, save the verification result
    if (resourceId) {
      const [verification] = await db
        .insert(verifications)
        .values({
          resourceId,
          isOriginal: result.isOriginal,
          confidence: result.confidence,
          flags: JSON.stringify(result.flags),
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          estimatedCost: usage.estimatedCostUsd.toString(),
        })
        .returning();

      // Update resource status — listing is independent of on-chain registration.
      // Re-checks ownership and the admin delist so a change made since the
      // pre-payment check can't be overwritten.
      const [updated] = await db
        .update(resources)
        .set({
          verificationStatus: result.isOriginal ? "verified" : "rejected",
          verificationId: verification.id,
          listed: result.isOriginal,
        })
        .where(
          and(
            eq(resources.id, resourceId),
            eq(resources.publisherId, req.publisher!.id),
            isNull(resources.adminDelistedAt),
          ),
        )
        .returning({ publisherId: resources.publisherId, title: resources.title });

      if (updated && result.isOriginal) {
        void emitToPublisher(updated.publisherId, "resource.listed", {
          resourceId,
          title: updated.title,
        });
      }
    }

    res.json(result);
  },
);

// GET /agent/status — public agent stats
router.get("/agent/status", async (_req, res) => {
  // All verifications
  const allVerifications = await db
    .select({
      id: verifications.id,
      resourceId: verifications.resourceId,
      isOriginal: verifications.isOriginal,
      confidence: verifications.confidence,
      flags: verifications.flags,
      promptTokens: verifications.promptTokens,
      completionTokens: verifications.completionTokens,
      totalTokens: verifications.totalTokens,
      estimatedCost: verifications.estimatedCost,
      checkedAt: verifications.checkedAt,
    })
    .from(verifications)
    .orderBy(desc(verifications.checkedAt));

  // Get resource titles for recent activity in a single batched query
  const recentVerifications = allVerifications.slice(0, 10);
  const recentResourceIds = [...new Set(recentVerifications.map((v) => v.resourceId))];

  const titleRows =
    recentResourceIds.length > 0
      ? await db
          .select({ id: resources.id, title: resources.title })
          .from(resources)
          .where(inArray(resources.id, recentResourceIds))
      : [];
  const titleById = new Map(titleRows.map((r) => [r.id, r.title]));

  const recentWithTitles = recentVerifications.map((v) => ({
    id: v.id,
    resourceTitle: titleById.get(v.resourceId) || "Unknown",
    isOriginal: v.isOriginal,
    confidence: v.confidence,
    flags: v.flags ? JSON.parse(v.flags) : [],
    checkedAt: v.checkedAt,
  }));

  const totalVerifications = allVerifications.length;
  const verified = allVerifications.filter((v) => v.isOriginal).length;
  const rejected = allVerifications.filter((v) => !v.isOriginal).length;

  // Sum the amounts actually recorded for settled verification payments to the
  // agent's wallet. Rejected or unsettled calls are excluded, and historical
  // price changes are reflected because we sum recorded amounts, not list price.
  const [earningsRow] = await db
    .select({
      total: sum(sql<string>`cast(${payments.amount} as numeric)`),
    })
    .from(payments)
    .innerJoin(verifications, eq(payments.verificationId, verifications.id))
    .where(
      and(
        eq(payments.recipientAddress, config.PAY_TO),
        eq(payments.status, "settled"),
        eq(verifications.isOriginal, true),
      ),
    );

  const totalEarned = earningsRow?.total ? Number(earningsRow.total) : 0;

  const avgConfidence =
    totalVerifications > 0
      ? allVerifications.reduce((sum, v) => sum + v.confidence, 0) / totalVerifications
      : 0;

  // Aggregate model token usage + estimated spend across all verifications (#283).
  const totalPromptTokens = allVerifications.reduce((sum, v) => sum + (v.promptTokens ?? 0), 0);
  const totalCompletionTokens = allVerifications.reduce(
    (sum, v) => sum + (v.completionTokens ?? 0),
    0,
  );
  const totalTokens = allVerifications.reduce((sum, v) => sum + (v.totalTokens ?? 0), 0);
  const totalEstimatedCost = allVerifications.reduce(
    (sum, v) => sum + (v.estimatedCost ? Number(v.estimatedCost) : 0),
    0,
  );

  res.json({
    agent: {
      name: "SynapsVault Verification Agent",
      walletAddress: config.PAY_TO,
      network: config.NETWORK,
      endpoint: `${config.BASE_URL}/verify-content`,
      pricePerVerification: config.VERIFICATION_PRICE,
      currency: "USDC",
      status: "active",
    },
    stats: {
      totalVerifications,
      verified,
      rejected,
      totalEarned: totalEarned.toFixed(4),
      avgConfidence: avgConfidence.toFixed(2),
    },
    usage: {
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      estimatedCostUsd: totalEstimatedCost.toFixed(6),
      model: config.OPENROUTER_MODEL,
    },
    recentActivity: recentWithTitles,
  });
});

export default router;