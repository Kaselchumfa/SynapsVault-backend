import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { resources } from "../db/schema.js";
import {
  NETWORK_PASSPHRASE,
  registryClient,
  registryKeypair,
  resourceExists,
} from "../services/registryClient.js";
import { getLogger } from "../lib/logger.js";
import { config } from "../config.js";

const WORKER_INTERVAL_MS = 60_000;
const MAX_RETRY_ATTEMPTS = 3;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startRetryPendingWorker(): void {
  getLogger().info(
    { event: "retry_worker_start", intervalMs: WORKER_INTERVAL_MS },
    "starting retry-pending worker",
  );

  tick();
  intervalHandle = setInterval(tick, WORKER_INTERVAL_MS);
}

export function stopRetryPendingWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function tick(): Promise<void> {
  if (inFlight) {
    getLogger().debug(
      { event: "retry_worker_tick_skipped" },
      "previous retry worker tick still running; skipping",
    );
    return;
  }

  inFlight = true;
  try {
    const cutoff = sql`NOW() - INTERVAL '5 minutes'`;

    const stuck = await db
      .select()
      .from(resources)
      .where(and(eq(resources.onchainStatus, "pending"), lt(resources.createdAt, cutoff)))
      .limit(config.RETRY_WORKER_BATCH_SIZE);

    if (stuck.length === 0) return;

    getLogger().info(
      { event: "retry_worker_tick", stuckCount: stuck.length },
      "found stuck resources to retry",
    );

    for (const resource of stuck) {
      await withTimeout(
        retryResource(resource),
        config.RETRY_WORKER_ITEM_TIMEOUT_MS,
        resource.id,
      );
    }
  } catch (err) {
    getLogger().error({ event: "retry_worker_tick_error", err }, "retry worker tick failed");
  } finally {
    inFlight = false;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, resourceId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`retryResource timed out after ${ms}ms for ${resourceId}`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function retryResource(resource: typeof resources.$inferSelect): Promise<void> {
  const log = getLogger().child({ resourceId: resource.id });

  let attempts = 0;

  try {
    const [incremented] = await db
      .update(resources)
      .set({ onchainAttempts: sql`${resources.onchainAttempts} + 1` })
      .where(eq(resources.id, resource.id))
      .returning({ onchainAttempts: resources.onchainAttempts });

    attempts = incremented?.onchainAttempts ?? 0;

    if (attempts > MAX_RETRY_ATTEMPTS) {
      log.warn(
        { event: "retry_exhausted", attempts },
        "max retry attempts exhausted; marking as failed",
      );
      await db
        .update(resources)
        .set({ onchainStatus: "failed" })
        .where(eq(resources.id, resource.id));
      return;
    }

    const exists = await resourceExists(resource.id);
    if (exists) {
      log.info(
        { event: "retry_already_registered" },
        "resource already registered on-chain; updating DB",
      );
      await db
        .update(resources)
        .set({ onchainStatus: "registered" })
        .where(eq(resources.id, resource.id));
      return;
    }

    log.info(
      { event: "retry_attempt", attempt: attempts, maxAttempts: MAX_RETRY_ATTEMPTS },
      "re-attempting on-chain registration",
    );

    const priceStroops = Math.round(parseFloat(resource.price) * 10_000_000);
    const metadata = JSON.stringify({
      title: resource.title,
      description: resource.description ?? "",
      contentHash: resource.contentHash,
    });

    const tx = await registryClient.register({
      creator: registryKeypair.publicKey(),
      id: resource.id,
      price: BigInt(priceStroops),
      metadata,
      tags: [],
    });

    const { Transaction } = await import("@stellar/stellar-sdk");
    const sent = await tx.signAndSend({
      signTransaction: async (xdr: string) => {
        const stellarTx = new Transaction(xdr, NETWORK_PASSPHRASE);
        stellarTx.sign(registryKeypair);
        return { signedTxXdr: stellarTx.toXDR() };
      },
    });
    const txHash = sent?.sendTransactionResponse?.hash ?? "";

    await db
      .update(resources)
      .set({
        onchainStatus: "registered",
        ...(txHash ? { onchainTxHash: txHash } : {}),
      })
      .where(eq(resources.id, resource.id));

    log.info(
      { event: "retry_success", txHash: txHash || undefined },
      "on-chain registration retry succeeded",
    );
  } catch (err: any) {
    log.error(
      { event: "retry_error", err: err?.message ?? String(err) },
      "on-chain registration retry failed",
    );

    if (attempts > MAX_RETRY_ATTEMPTS) {
      log.warn(
        { event: "retry_exhausted_on_error", attempts },
        "max retry attempts exhausted after error; marking as failed",
      );
      await db
        .update(resources)
        .set({ onchainStatus: "failed" })
        .where(eq(resources.id, resource.id));
    }
  }
}
