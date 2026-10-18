import type { Request, Response, NextFunction } from "express";
import { paymentMiddleware } from "@x402/express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { resources } from "../db/schema.js";
import type { RoutesConfig } from "@x402/core/server";
import { getLogger } from "../lib/logger.js";
import { network, sharedX402ResourceServer } from "../lib/x402.js";
import { getOnChainPrice, normalizeUsdcPrice, stroopsToUsdc } from "../lib/stellarRegistry.js";
import { createTtlCache } from "../lib/ttlCache.js";

const CACHE_TTL_MS = 60_000; // 1 minute
const MIDDLEWARE_CACHE_MAX_SIZE = 1000;

// Cache middleware instances by resource ID to avoid re-creating on every request.
// Expired entries are evicted and the cache size is bounded.
const middlewareCache = createTtlCache<ReturnType<typeof paymentMiddleware>>({
  ttlMs: CACHE_TTL_MS,
  maxSize: MIDDLEWARE_CACHE_MAX_SIZE,
});

export async function dynamicPaywall(req: Request, res: Response, next: NextFunction) {
  const resourceId = req.params.id as string;

  const resource = await db
    .select()
    .from(resources)
    .where(eq(resources.id, resourceId))
    .then((rows) => rows[0] ?? null);

  if (!resource) {
    res.status(404).json({ error: "Resource not found" });
    return;
  }

  if (!resource.listed) {
    res.status(404).json({ error: "Resource not listed" });
    return;
  }

  // Validate the DB price against the on-chain registry before serving a 402.
  // If they disagree we refuse the request rather than charge the wrong amount.
  let onChainPrice: string;
  let onChainCreator: string;
  try {
    const onChain = await getOnChainPrice(resourceId);
    onChainPrice = onChain.price;
    onChainCreator = onChain.creator;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    getLogger().error(
      {
        event: "paywall_chain_lookup_failed",
        resourceId,
        error: message,
        cause,
      },
      "on-chain price lookup failed",
    );
    res.status(503).json({
      error: "chain_unavailable",
      message: "Unable to verify resource price. Please try again later.",
      resourceId,
    });
    return;
  }

  const dbPriceNormalized = normalizeUsdcPrice(resource.price);
  if (dbPriceNormalized !== onChainPrice) {
    getLogger().warn(
      {
        event: "paywall_price_mismatch",
        resourceId,
        dbPrice: resource.price,
        chainPrice: onChainPrice,
        publisherWallet: resource.walletAddress,
        onChainCreator,
      },
      "price mismatch between database and on-chain registry",
    );
    res.status(409).json({
      error: "price_mismatch",
      message:
        "Resource price is temporarily unavailable due to a configuration issue. Please try again later.",
      resourceId,
    });
    return;
  }

  // Attach resource to request for the delivery handler
  (req as any).resource = resource;

  // Derive the final price from the on-chain price already fetched above
  // (cached per TTL), so each resource is looked up once per TTL window.
  let finalPrice = resource.price;
  if (resource.onchainStatus === "registered") {
    // Convert from stroops (7 decimals) to a fixed-decimal USDC string
    finalPrice = stroopsToUsdc(BigInt(onChainPrice));
  }

  // Check cache with final price as part of cache key
  const cacheKey = `${resourceId}:${finalPrice}`;
  const cached = middlewareCache.get(cacheKey);
  if (cached) {
    return cached(req, res, next);
  }

  // Build route config for this specific resource
  const routePath = `GET /resources/${resourceId}`;
  const routes: RoutesConfig = {
    [routePath]: {
      accepts: {
        scheme: "exact" as const,
        network,
        payTo: resource.walletAddress,
        price: finalPrice,
      },
      description: resource.title,
    },
  };

  const mw = paymentMiddleware(routes, sharedX402ResourceServer);

  // Cache it with the final price key
  middlewareCache.set(cacheKey, mw);

  return mw(req, res, next);
}
