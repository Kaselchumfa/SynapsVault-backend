import { Router, type Router as RouterType } from "express";
import type { z } from "zod/v4";
import { AppError } from "../lib/errors.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { publisherRateLimit } from "../middleware/rateLimiters.js";
import { validate } from "../middleware/validate.js";
import {
  publisherRegisterSchema,
  updateRateLimitSchema,
  updateWebhookConfigSchema,
} from "../schemas/requests.js";
import { registerPublisher, getPublisherResources } from "../services/publisherService.js";
import { deliver, webhookUrlProblem } from "../services/webhookService.js";
import { eq, inArray, sum, count, sql, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { publishers, resources, payments } from "../db/schema.js";
import { config } from "../config.js";

const router: RouterType = Router();

type UpdateWebhookConfig = z.infer<typeof updateWebhookConfigSchema>;

// POST /publishers — register a new publisher (public)
router.post("/publishers", validate(publisherRegisterSchema), async (req, res) => {
  try {
    const { publisher, apiKey } = await registerPublisher(req.body);
    res.status(201).json({
      id: publisher.id,
      name: publisher.name,
      email: publisher.email,
      walletAddress: publisher.walletAddress,
      apiKey, // shown once — store it securely
      createdAt: publisher.createdAt,
    });
  } catch (err: any) {
    // 23505 = unique_violation (drizzle wraps the driver error in `cause`).
    if (err?.code === "23505" || err?.cause?.code === "23505" || err?.message?.includes("unique")) {
      throw new AppError("CONFLICT", "Email already registered");
    }
    throw err;
  }
});

// GET /publishers/wallet/:address — look up publisher by wallet (public)
router.get("/publishers/wallet/:address", async (req, res) => {
  const address = req.params.address as string;
  const publisher = await db
    .select({
      id: publishers.id,
      name: publishers.name,
      walletAddress: publishers.walletAddress,
      createdAt: publishers.createdAt,
    })
    .from(publishers)
    .where(eq(publishers.walletAddress, address))
    .then((rows) => rows[0] ?? null);

  if (!publisher) {
    throw new AppError("NOT_FOUND", "No publisher found for this wallet");
  }

  res.json(publisher);
});

// GET /publishers/me — own profile (authenticated)
router.get("/publishers/me", apiKeyAuth, async (req, res) => {
  const pub = req.publisher!;
  res.json({
    id: pub.id,
    name: pub.name,
    email: pub.email,
    walletAddress: pub.walletAddress,
    createdAt: pub.createdAt,
  });
});

// GET /publishers/me/resources — own resources (authenticated)
router.get("/publishers/me/resources", apiKeyAuth, async (req, res) => {
  const resources = await getPublisherResources(req.publisher!.id);
  res.json(resources);
});

// GET /publishers/me/analytics — earnings and stats (authenticated)
router.get("/publishers/me/analytics", apiKeyAuth, async (req, res) => {
  const publisherId = req.publisher!.id;

  // Get all resources for this publisher
  const pubResources = await db
    .select({
      id: resources.id,
      title: resources.title,
      price: resources.price,
      verificationStatus: resources.verificationStatus,
      listed: resources.listed,
      createdAt: resources.createdAt,
    })
    .from(resources)
    .where(eq(resources.publisherId, publisherId));

  const resourceIds = pubResources.map((r) => r.id);
  const walletAddress = req.publisher!.walletAddress;

  // Aggregate per-resource stats in SQL (one query).
  let aggregateRows: { resourceId: string; totalSales: number; totalEarned: string | null }[] = [];
  if (resourceIds.length > 0) {
    aggregateRows = await db
      .select({
        resourceId: payments.resourceId,
        totalSales: count(payments.id),
        totalEarned: sum(payments.amount),
      })
      .from(payments)
      .where(
        sql`${payments.resourceId} IN ${resourceIds} AND ${payments.recipientAddress} = ${walletAddress}`,
      )
      .groupBy(payments.resourceId);
  }

  const aggregateByResource = new Map(aggregateRows.map((row) => [row.resourceId, row]));

  // Recent payments per resource, paginated in SQL (ORDER BY paid_at DESC LIMIT 5).
  const recentByResource = new Map<
    string,
    { payerAddress: string; amount: string; paidAt: Date }[]
  >();
  if (resourceIds.length > 0) {
    const recentRows = await db
      .select({
        resourceId: payments.resourceId,
        payerAddress: payments.payerAddress,
        amount: payments.amount,
        paidAt: payments.paidAt,
        rn: sql<number>`row_number() over (partition by ${payments.resourceId} order by ${payments.paidAt} desc)`.as(
          "rn",
        ),
      })
      .from(payments)
      .where(
        sql`${payments.resourceId} IN ${resourceIds} AND ${payments.recipientAddress} = ${walletAddress}`,
      )
      .orderBy(payments.resourceId, desc(payments.paidAt));

    for (const row of recentRows) {
      if (row.rn > 5) continue;
      const list = recentByResource.get(row.resourceId) ?? [];
      list.push({ payerAddress: row.payerAddress, amount: row.amount, paidAt: row.paidAt });
      recentByResource.set(row.resourceId, list);
    }
  }

  // Compute per-resource stats from the aggregate result.
  const resourceStats = pubResources.map((r) => {
    const agg = aggregateByResource.get(r.id);
    const totalSales = agg?.totalSales ?? 0;
    const totalEarned = agg?.totalEarned ? parseFloat(agg.totalEarned) : 0;
    return {
      id: r.id,
      title: r.title,
      price: r.price,
      accessUrl: `${config.BASE_URL}/resources/${r.id}`,
      verificationStatus: r.verificationStatus,
      listed: r.listed,
      createdAt: r.createdAt,
      totalSales,
      totalEarned: totalEarned.toFixed(4),
      recentPayments: recentByResource.get(r.id) ?? [],
    };
  });

  // Summary — derived from the same aggregate result.
  const totalEarned = aggregateRows.reduce(
    (acc, row) => acc + (row.totalEarned ? parseFloat(row.totalEarned) : 0),
    0,
  );
  const totalSales = aggregateRows.reduce((acc, row) => acc + row.totalSales, 0);
  const totalResources = pubResources.length;
  const listedResources = pubResources.filter((r) => r.listed).length;
  const verifiedResources = pubResources.filter((r) => r.verificationStatus === "verified").length;
  const rejectedResources = pubResources.filter((r) => r.verificationStatus === "rejected").length;
  const pendingResources = pubResources.filter((r) => r.verificationStatus === "pending").length;

  res.json({
    summary: {
      totalEarned: totalEarned.toFixed(4),
      currency: "USDC",
      totalSales,
      totalResources,
      listedResources,
      verification: {
        verified: verifiedResources,
        rejected: rejectedResources,
        pending: pendingResources,
      },
    },
    resources: resourceStats,
  });
});

// GET /publishers/me/rate-limit — effective per-publisher rate limit (authenticated)
router.get("/publishers/me/rate-limit", apiKeyAuth, publisherRateLimit, (req, res) => {
  res.json(rateLimitView(req.publisher!.rateLimitRpm));
});

// PATCH /publishers/me/rate-limit — set or reset (null) own rate-limit override
router.patch(
  "/publishers/me/rate-limit",
  apiKeyAuth,
  publisherRateLimit,
  validate(updateRateLimitSchema),
  async (req, res) => {
    const [updated] = await db
      .update(publishers)
      .set({ rateLimitRpm: req.body.rateLimitRpm })
      .where(eq(publishers.id, req.publisher!.id))
      .returning({ rateLimitRpm: publishers.rateLimitRpm });

    res.json(rateLimitView(updated.rateLimitRpm));
  },
);

// GET /publishers/me/webhooks — own webhook configuration (authenticated)
router.get("/publishers/me/webhooks", apiKeyAuth, publisherRateLimit, (req, res) => {
  res.json(webhookView(req.publisher!));
});

// PATCH /publishers/me/webhooks — update own webhook configuration (authenticated)
router.patch(
  "/publishers/me/webhooks",
  apiKeyAuth,
  publisherRateLimit,
  validate(updateWebhookConfigSchema),
  async (req, res) => {
    const pub = req.publisher!;
    const body = req.body as UpdateWebhookConfig;

    if (body.webhookUrl) {
      const problem = webhookUrlProblem(body.webhookUrl);
      if (problem) throw new AppError("VALIDATION_ERROR", problem);
    }
    const nextUrl = body.webhookUrl !== undefined ? body.webhookUrl : pub.webhookUrl;
    if (body.webhookEnabled && !nextUrl) {
      throw new AppError("VALIDATION_ERROR", "webhookUrl is required to enable webhooks");
    }

    const [updated] = await db
      .update(publishers)
      .set({
        ...(body.webhookUrl !== undefined ? { webhookUrl: body.webhookUrl } : {}),
        ...(body.webhookSecret !== undefined ? { webhookSecret: body.webhookSecret } : {}),
        ...(body.webhookEvents !== undefined ? { webhookEvents: body.webhookEvents } : {}),
        // Clearing the URL always disables delivery.
        ...(body.webhookUrl === null
          ? { webhookEnabled: false }
          : body.webhookEnabled !== undefined
            ? { webhookEnabled: body.webhookEnabled }
            : {}),
      })
      .where(eq(publishers.id, pub.id))
      .returning();

    res.json(webhookView(updated));
  },
);

// POST /publishers/me/webhooks/test — send a signed test event (authenticated)
router.post("/publishers/me/webhooks/test", apiKeyAuth, publisherRateLimit, async (req, res) => {
  const pub = req.publisher!;

  if (!pub.webhookUrl) {
    throw new AppError("VALIDATION_ERROR", "No webhook URL configured");
  }

  // Single attempt: the caller is waiting on this request.
  const result = await deliver(
    { url: pub.webhookUrl, secret: pub.webhookSecret ?? undefined },
    {
      event: "webhook.test",
      timestamp: new Date().toISOString(),
      data: { publisherId: pub.id },
    },
    { maxAttempts: 1 },
  );

  res.status(result.delivered ? 200 : 502).json(result);
});

// GET /publishers/leaderboard — public creator leaderboard
router.get("/publishers/leaderboard", async (_req, res) => {
  // Get all publishers with their resource and payment stats.
  // Only public columns are selected so secrets (apiKeyHash, webhookSecret) never leave the DB.
  const allPublishers = await db
    .select({
      id: publishers.id,
      name: publishers.name,
      walletAddress: publishers.walletAddress,
      createdAt: publishers.createdAt,
    })
    .from(publishers);
  const allResources = await db
    .select({
      id: resources.id,
      publisherId: resources.publisherId,
      price: resources.price,
      listed: resources.listed,
      verificationStatus: resources.verificationStatus,
    })
    .from(resources);
  const allPayments = await db
    .select({
      resourceId: payments.resourceId,
      recipientAddress: payments.recipientAddress,
      amount: payments.amount,
      paidAt: payments.paidAt,
    })
    .from(payments);

  const leaderboard = allPublishers.map((pub) => {
    const pubResources = allResources.filter((r) => r.publisherId === pub.id);
    const pubResourceIds = pubResources.map((r) => r.id);
    const pubPayments = allPayments.filter(
      (p) => pubResourceIds.includes(p.resourceId) && p.recipientAddress === pub.walletAddress,
    );

    const totalEarned = pubPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    return {
      id: pub.id,
      name: pub.name,
      walletAddress: pub.walletAddress,
      joinedAt: pub.createdAt,
      totalResources: pubResources.length,
      listedResources: pubResources.filter((r) => r.listed).length,
      verifiedResources: pubResources.filter((r) => r.verificationStatus === "verified").length,
      totalSales: pubPayments.length,
      totalEarned: totalEarned.toFixed(4),
    };
  });

  // Sort by earnings descending
  leaderboard.sort((a, b) => parseFloat(b.totalEarned) - parseFloat(a.totalEarned));

  res.json(leaderboard);
});

type Publisher = typeof publishers.$inferSelect;

function rateLimitView(override: number | null) {
  return {
    rateLimitRpm: Math.min(
      override ?? config.PUBLISHER_RATE_LIMIT_RPM_DEFAULT,
      config.PUBLISHER_RATE_LIMIT_MAX_RPM,
    ),
    override,
    defaultRpm: config.PUBLISHER_RATE_LIMIT_RPM_DEFAULT,
    maxRpm: config.PUBLISHER_RATE_LIMIT_MAX_RPM,
    windowMs: config.PUBLISHER_RATE_LIMIT_WINDOW_MS,
  };
}

function webhookView(pub: Publisher) {
  return {
    webhookUrl: pub.webhookUrl,
    webhookSecret: pub.webhookSecret ? maskSecret(pub.webhookSecret) : null,
    webhookEvents: pub.webhookEvents ?? [],
    webhookEnabled: pub.webhookEnabled,
  };
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) return "****";
  return `${"*".repeat(secret.length - 4)}${secret.slice(-4)}`;
}

export default router;
