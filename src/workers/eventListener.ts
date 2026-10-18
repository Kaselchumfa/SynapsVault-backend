import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { resources, ledgerCheckpoints } from "../db/schema.js";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";

const POLL_INTERVAL_MS = 30_000;
const EVENT_PAGE_LIMIT = 100;

const __dirname = dirname(fileURLToPath(import.meta.url));
// The ledger checkpoint is persisted in Postgres (table `ledger_checkpoints`,
// keyed by contract id) so it survives container recreation. The JSON file at
// LEDGER_TRACKER_PATH is kept only as a fallback for environments without a
// database (or when the DB read fails); it defaults to the project root.
const LEDGER_TRACKER_PATH =
  process.env.LEDGER_TRACKER_PATH ?? join(__dirname, "..", "..", "last-processed-ledger.json");

const CONTRACT_ID = config.REGISTRY_CONTRACT_ID;

// Event topic symbols (matching contract `symbol_short!`)
const EVENT_REGISTER = "register";
const EVENT_SET_PRICE = "setprice";
const EVENT_UPD_META = "updmeta";
const EVENT_SET_TAGS = "settags";
const EVENT_TRANSFER = "transfer";
const EVENT_SET_LISTED = "setlisted";

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

function loadLastLedgerFromFile(): number {
  try {
    if (existsSync(LEDGER_TRACKER_PATH)) {
      const data = JSON.parse(readFileSync(LEDGER_TRACKER_PATH, "utf-8"));
      return data.lastLedger ?? 0;
    }
  } catch {
    // ignore corrupt file
  }
  return 0;
}

function saveLastLedgerToFile(ledger: number): void {
  try {
    // Monotonic: never move the checkpoint backwards.
    const current = loadLastLedgerFromFile();
    if (ledger <= current) return;

    const dir = dirname(LEDGER_TRACKER_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(LEDGER_TRACKER_PATH, JSON.stringify({ lastLedger: ledger }));
  } catch (err) {
    getLogger().error({ event: "ledger_tracker_write_error", err }, "failed to save last ledger");
  }
}

async function loadLastLedgerFromDb(): Promise<number | null> {
  try {
    const row = await db
      .select({ lastLedger: ledgerCheckpoints.lastLedger })
      .from(ledgerCheckpoints)
      .where(eq(ledgerCheckpoints.contractId, CONTRACT_ID))
      .then((r) => r[0]);
    return row ? row.lastLedger : null;
  } catch (err) {
    getLogger().warn(
      { event: "ledger_checkpoint_db_read_error", err },
      "failed to read ledger checkpoint from db, falling back to file",
    );
    return null;
  }
}

async function saveLastLedgerToDb(ledger: number): Promise<void> {
  try {
    await db
      .insert(ledgerCheckpoints)
      .values({ contractId: CONTRACT_ID, lastLedger: ledger, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: ledgerCheckpoints.contractId,
        set: { lastLedger: ledger, updatedAt: new Date() },
      });
  } catch (err) {
    getLogger().error(
      { event: "ledger_checkpoint_db_write_error", err },
      "failed to save ledger checkpoint to db",
    );
  }
}

async function loadLastLedger(): Promise<number> {
  const fromDb = await loadLastLedgerFromDb();
  if (fromDb !== null) return fromDb;
  return loadLastLedgerFromFile();
}

async function saveLastLedger(ledger: number): Promise<void> {
  await saveLastLedgerToDb(ledger);
  // Keep the file in sync as a fallback for environments without a database.
  saveLastLedgerToFile(ledger);
}

interface SorobanEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  topic: string[];
  value: {
    type: string;
    value?: string;
    vec?: Array<{ type: string; value?: string; symbol?: string; vec?: unknown[] }>;
    map?: Array<{ key: { type: string; symbol?: string }; val: { type: string; value?: string } }>;
  };
}

function extractResourceId(topic: string[]): string | null {
  if (topic.length < 2) return null;
  const raw = topic[1];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string"
      ? parsed
      : typeof parsed?.value === "string"
        ? parsed.value
        : null;
  } catch {
    return raw;
  }
}

function extractAddress(val: { type: string; value?: string }): string | null {
  if (val.type === "address") return val.value ?? null;
  return null;
}

async function handleRegisterEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) return;

  const dbResource = await db
    .select({ id: resources.id })
    .from(resources)
    .where(eq(resources.id, id))
    .then((r) => r[0]);

  if (dbResource) {
    await db.update(resources).set({ onchainStatus: "registered" }).where(eq(resources.id, id));
    getLogger().info({ event: "event_register", resourceId: id }, "synced register event");
  }
}

async function handleSetPriceEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) return;

  if (event.value.type === "i128" || event.value.type === "string") {
    const rawPrice = event.value.value ?? "0";
    const stroops = BigInt(rawPrice);
    const usdc = (Number(stroops) / 10_000_000).toFixed(7).replace(/\.?0+$/, "");

    await db.update(resources).set({ price: usdc }).where(eq(resources.id, id));

    getLogger().info(
      { event: "event_setprice", resourceId: id, price: usdc },
      "synced set_price event",
    );
  }
}

async function handleTransferEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) return;

  const newCreator = extractAddress({ type: event.value.type, value: event.value.value });
  if (newCreator) {
    await db.update(resources).set({ walletAddress: newCreator }).where(eq(resources.id, id));

    getLogger().info(
      { event: "event_transfer", resourceId: id, newCreator },
      "synced transfer event",
    );
  }
}

async function handleSetListedEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) return;

  const listed = event.value.type === "bool" ? event.value.value === "true" : null;
  if (listed !== null) {
    await db.update(resources).set({ listed }).where(eq(resources.id, id));

    getLogger().info(
      { event: "event_setlisted", resourceId: id, listed },
      "synced set_listed event",
    );
  }
}

/**
 * Parse the `updmeta` event payload into title/description.
 *
 * The contract emits either a map with `title`/`description` keys or a JSON
 * string holding the same shape. Missing fields are left untouched.
 */
export function parseUpdMetaValue(value: SorobanEvent["value"]): {
  title?: string;
  description?: string;
} {
  const result: { title?: string; description?: string } = {};

  if (value.type === "map" && Array.isArray(value.map)) {
    for (const entry of value.map) {
      const key = entry.key?.symbol;
      const val = entry.val?.value;
      if (typeof val !== "string") continue;
      if (key === "title") result.title = val;
      else if (key === "description") result.description = val;
    }
    return result;
  }

  if (value.type === "string" && typeof value.value === "string") {
    try {
      const parsed = JSON.parse(value.value);
      if (typeof parsed?.title === "string") result.title = parsed.title;
      if (typeof parsed?.description === "string") result.description = parsed.description;
    } catch {
      // not JSON; nothing to update
    }
  }

  return result;
}

export async function handleUpdMetaEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) return;

  const { title, description } = parseUpdMetaValue(event.value);
  if (title === undefined && description === undefined) return;

  const patch: { title?: string; description?: string } = {};
  if (title !== undefined) patch.title = title;
  if (description !== undefined) patch.description = description;

  await db.update(resources).set(patch).where(eq(resources.id, id));

  getLogger().info(
    { event: "event_updmeta", resourceId: id, title, description },
    "synced upd_meta event",
  );
}

/**
 * Parse the `settags` event payload into a list of tag strings.
 */
export function parseSetTagsValue(value: SorobanEvent["value"]): string[] {
  if (value.type === "vec" && Array.isArray(value.vec)) {
    return value.vec
      .map((item) => (typeof item?.value === "string" ? item.value : undefined))
      .filter((t): t is string => typeof t === "string");
  }
  if (value.type === "string" && typeof value.value === "string") {
    try {
      const parsed = JSON.parse(value.value);
      if (Array.isArray(parsed)) {
        return parsed.filter((t): t is string => typeof t === "string");
      }
    } catch {
      // not JSON; nothing to update
    }
  }
  return [];
}

/**
 * Tags are not currently persisted: the `resources` table has no tags column,
 * so the database remains the source of truth for catalog metadata and this
 * event is logged and skipped. If tag persistence is added later, extend the
 * schema and update this handler.
 */
export async function handleSetTagsEvent(event: SorobanEvent): Promise<void> {
  const id = extractResourceId(event.topic);
  if (!id) return;

  const tags = parseSetTagsValue(event.value);

  getLogger().info(
    { event: "event_settags", resourceId: id, tags, persisted: false },
    "received set_tags event (tags are not persisted; database is source of truth)",
  );
}

async function pollEvents(): Promise<void> {
  if (pollInFlight) {
    getLogger().debug({ event: "event_listener_poll_skipped" }, "poll already in flight");
    return;
  }
  pollInFlight = true;

  try {
    await pollEventsInner();
  } finally {
    pollInFlight = false;
  }
}

async function pollEventsInner(): Promise<void> {
  const lastLedger = await loadLastLedger();
  if (lastLedger === 0) {
    await saveLastLedger(1);
    return;
  }

  try {
    const { rpc: StellarRpc } = await import("@stellar/stellar-sdk");
    const server = new StellarRpc.Server(config.SOROBAN_RPC_URL);

    const response: any = await server.getEvents({
      startLedger: lastLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
        },
      ],
      limit: EVENT_PAGE_LIMIT,
    });

    const events: SorobanEvent[] = response?.events ?? [];

    if (events.length === 0) return;

    // Only advance the checkpoint past events whose handlers completed.
    let lastSuccessfulLedger = lastLedger;

    for (const event of events) {
      const topicSymbols = event.topic.map((t: string) => {
        try {
          const parsed = JSON.parse(t);
          if (parsed?.symbol) return parsed.symbol;
          if (typeof parsed === "string") return parsed;
          return t;
        } catch {
          return t;
        }
      });

      const eventType = topicSymbols[0];

      try {
        switch (eventType) {
          case EVENT_REGISTER:
            await handleRegisterEvent(event);
            break;
          case EVENT_SET_PRICE:
            await handleSetPriceEvent(event);
            break;
          case EVENT_UPD_META:
            await handleUpdMetaEvent(event);
            break;
          case EVENT_SET_TAGS:
            await handleSetTagsEvent(event);
            break;
          case EVENT_TRANSFER:
            await handleTransferEvent(event);
            break;
          case EVENT_SET_LISTED:
            await handleSetListedEvent(event);
            break;
          default:
            getLogger().debug({ eventType }, "unknown event type from registry");
        }
      } catch (err) {
        getLogger().warn(
          { event: "event_handler_error", eventType, eventId: event.id, err },
          "failed to process event; stopping checkpoint before this event",
        );
        // Stop before the failed event so it is retried on the next poll.
        break;
      }

      if (event.ledger > lastSuccessfulLedger) lastSuccessfulLedger = event.ledger;
    }

    await saveLastLedger(lastSuccessfulLedger + 1);
  } catch (err) {
    getLogger().error({ event: "event_listener_poll_error", err }, "event polling failed");
  }
}

export function startEventListener(): void {
  getLogger().info(
    { event: "event_listener_start", intervalMs: POLL_INTERVAL_MS, contractId: CONTRACT_ID },
    "starting registry event listener",
  );

  pollEvents();
  intervalHandle = setInterval(pollEvents, POLL_INTERVAL_MS);
}

export function stopEventListener(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
