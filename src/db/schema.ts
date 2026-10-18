import {
  pgTable,
  text,
  real,
  integer,
  boolean,
  timestamp,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

export const resourceTypeEnum = pgEnum("resource_type", ["file", "link"]);

export const verificationStatusEnum = pgEnum("verification_status", [
  "pending",
  "verified",
  "rejected",
  "skipped",
]);

export const onchainStatusEnum = pgEnum("onchain_status_enum", [
  "none",
  "pending",
  "registered",
  "failed",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "settled",
  "failed",
]);

export const thumbnailStatusEnum = pgEnum("thumbnail_status_enum", [
  "none",
  "pending",
  "ready",
  "failed",
]);

// Publishers — humans or AI agents that publish resources
export const publishers = pgTable("publishers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  walletAddress: text("wallet_address").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  // Per-publisher rate limit in requests per minute. Null means the global
  // default applies.
  rateLimitRpm: integer("rate_limit_rpm"),
  // Webhook delivery configuration. Nullable so publishers can opt in later.
  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret"),
  // Subscribed WebhookEvent values; null/empty means all events.
  webhookEvents: text("webhook_events").array(),
  webhookEnabled: boolean("webhook_enabled").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Resources — digital assets published on the marketplace
export const resources = pgTable(
  "resources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id),
    title: text("title").notNull(),
    description: text("description"),
    price: text("price").notNull(),
    walletAddress: text("wallet_address").notNull(),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    storagePath: text("storage_path"),
    thumbnailPath: text("thumbnail_path"),
    // Thumbnail generation state so the background worker can pick up
    // resources that still need a thumbnail (#89).
    thumbnailStatus: thumbnailStatusEnum("thumbnail_status").notNull().default("none"),
    contentHash: text("content_hash"),
    externalUrl: text("external_url"),
    mimeType: text("mime_type"),
    verificationStatus: verificationStatusEnum("verification_status").notNull().default("pending"),
    verificationId: text("verification_id"),
    listed: boolean("listed").notNull().default(false),
    // Set when an administrator delists the resource. Publisher-initiated
    // delists leave it null. Blocks relisting via POST /verify-content (#18).
    adminDelistedAt: timestamp("admin_delisted_at"),
    onchainStatus: onchainStatusEnum("onchain_status").notNull().default("none"),
    onchainTxHash: text("onchain_tx_hash"),
    // Set when onchainStatus transitions to "pending". The retry worker uses
    // this (not createdAt) for its cutoff so a freshly pending old resource
    // isn't retried before a live registration can finish (#82).
    onchainPendingSince: timestamp("onchain_pending_since"),
    // Tags set on-chain via SET_TAGS events (#103). Null means never synced.
    tags: text("tags").array(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    catalogFilterSortIdx: index("idx_resources_catalog_filter_sort").on(
      table.listed,
      table.verificationStatus,
      table.createdAt,
    ),
    // Publisher dashboards list a single publisher's resources (#285).
    publisherIdx: index("idx_resources_publisher_id").on(table.publisherId),
    // Verification-status filters that aren't anchored to `listed` can't use the
    // composite catalog index, so they get their own (#285).
    verificationStatusIdx: index("idx_resources_verification_status").on(table.verificationStatus),
    // The thumbnail worker polls for resources awaiting generation (#89).
    thumbnailStatusIdx: index("idx_resources_thumbnail_status").on(table.thumbnailStatus),
  }),
);

// Pending cleanups — storage deletes that failed and must be retried later.
// Populated by `delistResource` when the DB update succeeds but the storage
// delete fails (#87).
export const pendingCleanup = pgTable(
  "pending_cleanup",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    storagePath: text("storage_path").notNull(),
    resourceId: text("resource_id").references(() => resources.id),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    // The cleanup worker drains the queue oldest-first.
    createdAtIdx: index("idx_pending_cleanup_created_at").on(table.createdAt),
  }),
);

// Verifications — AI originality check results
export const verifications = pgTable(
  "verifications",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    isOriginal: boolean("is_original").notNull(),
    confidence: real("confidence").notNull(), // 0.0 - 1.0
    flags: text("flags"), // JSON stringified array of issues
    // Token usage + estimated spend for the verification model call (#283).
    // Nullable so historical rows predating usage tracking remain valid.
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    estimatedCost: text("estimated_cost"), // USD, stringified for precision
    checkedAt: timestamp("checked_at").defaultNow().notNull(),
  },
  (table) => ({
    // Verification lookups by resource (#107).
    resourceIdIdx: index("idx_verifications_resource_id").on(table.resourceId),
  }),
);

// Payments — tracks x402 payments for resources
export const payments = pgTable(
  "payments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    payerAddress: text("payer_address").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    amount: text("amount").notNull(), // USDC amount
    // Settlement state of the payment. Only settled payments count toward
    // earnings (#99).
    status: paymentStatusEnum("status").notNull().default("pending"),
    paidAt: timestamp("paid_at").defaultNow().notNull(),
  },
  (table) => ({
    // Payment history is queried per payer wallet (#285).
    payerAddressIdx: index("idx_payments_payer_address").on(table.payerAddress),
    // Publisher analytics aggregate per resource (#100), and analytics and
    // delist lookups filter payments by resource (#107).
    resourceIdIdx: index("idx_payments_resource_id").on(table.resourceId),
    // Agent-status earnings sum per recipient (#99).
    recipientAddressIdx: index("idx_payments_recipient_address").on(table.recipientAddress),
  }),
);

// Failed events — on-chain events whose handler threw, kept for retry so the
// listener checkpoint can stop before them without losing the event (#101).
export const failedEvents = pgTable(
  "failed_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    eventId: text("event_id").notNull(),
    ledger: integer("ledger").notNull(),
    topic: text("topic").notNull(),
    payload: text("payload").notNull(), // JSON stringified event payload
    error: text("error").notNull(),
    attempts: integer("attempts").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    eventIdIdx: index("idx_failed_events_event_id").on(table.eventId),
    ledgerIdx: index("idx_failed_events_ledger").on(table.ledger),
  }),
);

// Ledger checkpoints — durable event-listener progress (#105).
// Stored in Postgres so the listener resumes from the last processed ledger
// even when the container is recreated without a persistent volume. The
// on-disk file remains only as a fallback.
export const ledgerCheckpoints = pgTable("ledger_checkpoints", {
  // Logical name of the checkpoint (e.g. "event_listener").
  id: text("id").primaryKey(),
  lastLedger: integer("last_ledger").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
