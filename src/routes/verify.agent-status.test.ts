import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const verificationRows = [
  {
    id: "v1",
    resourceId: "r1",
    isOriginal: true,
    confidence: 0.9,
    flags: null,
    checkedAt: new Date("2026-01-03"),
  },
  {
    id: "v2",
    resourceId: "r2",
    isOriginal: false,
    confidence: 0.4,
    flags: JSON.stringify(["duplicate"]),
    checkedAt: new Date("2026-01-02"),
  },
  {
    id: "v3",
    resourceId: "r1",
    isOriginal: true,
    confidence: 0.95,
    flags: null,
    checkedAt: new Date("2026-01-01"),
  },
];

// r2 and r-missing are intentionally absent from resourceTitleRows to exercise the
// "Unknown" fallback and confirm a single query covers every distinct resourceId.
const resourceTitleRows = [{ id: "r1", title: "Resource One" }];

let resourceQueryCount = 0;
let lastResourceIdsArg: unknown;

const { VERIFICATIONS_MARKER, RESOURCES_MARKER, PAYMENTS_MARKER } = vi.hoisted(() => ({
  VERIFICATIONS_MARKER: { __table: "verifications" },
  RESOURCES_MARKER: { __table: "resources" },
  PAYMENTS_MARKER: { __table: "payments" },
}));

vi.mock("../db/schema.js", () => ({
  verifications: VERIFICATIONS_MARKER,
  resources: RESOURCES_MARKER,
  payments: PAYMENTS_MARKER,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    inArray: (column: unknown, values: unknown[]) => {
      lastResourceIdsArg = values;
      return actual.inArray(column as never, values);
    },
  };
});

vi.mock("../services/webhookService.js", () => ({ emitToPublisher: vi.fn() }));

// Payment rows keyed by verification id, with mixed outcomes. Only settled rows
// should contribute to stats.totalEarned.
const paymentRows = [
  { verificationId: "v1", status: "settled", amount: "0.10" },
  { verificationId: "v2", status: "rejected", amount: "0.10" },
  { verificationId: "v3", status: "settled", amount: "0.25" },
  { verificationId: "v3", status: "pending", amount: "0.25" },
];

vi.mock("../db/client.js", () => ({
  db: {
    select: (_cols: unknown) => ({
      from: (table: unknown) => {
        if (table === VERIFICATIONS_MARKER) {
          return { orderBy: () => Promise.resolve(verificationRows) };
        }
        if (table === RESOURCES_MARKER) {
          return {
            where: () => {
              resourceQueryCount++;
              return Promise.resolve(resourceTitleRows);
            },
          };
        }
        if (table === PAYMENTS_MARKER) {
          return {
            innerJoin: () => ({
              where: () => Promise.resolve(paymentRows),
            }),
          };
        }
        throw new Error("unexpected table in select().from()");
      },
    }),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../config.js", () => ({
  config: {
    PAY_TO: "GPLATFORM",
    NETWORK: "stellar:testnet",
    BASE_URL: "http://localhost:4021",
    VERIFICATION_PRICE: "0.10",
  },
}));

vi.mock("../lib/x402.js", () => ({
  network: "stellar:testnet",
  sharedX402ResourceServer: {},
}));

vi.mock("@x402/express", () => ({
  paymentMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../middleware/rateLimiters.js", () => ({
  verifyIpRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyWalletRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../services/verificationService.js", () => ({
  checkOriginality: vi.fn(),
}));

import verifyRouter from "./verify.js";
import { errorHandler } from "../middleware/errorHandler.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(verifyRouter);
  app.use(errorHandler);
  return app;
}

describe("GET /agent/status — batched resource title lookup (#286)", () => {
  beforeEach(() => {
    resourceQueryCount = 0;
    lastResourceIdsArg = undefined;
  });

  it("issues exactly one query for resource titles regardless of verification count", async () => {
    await request(createTestApp()).get("/agent/status");

    expect(resourceQueryCount).toBe(1);
  });

  it("batches all distinct resourceIds from the recent verifications into that query", async () => {
    await request(createTestApp()).get("/agent/status");

    expect(lastResourceIdsArg).toEqual(["r1", "r2"]);
  });

  it("preserves the response shape and falls back to 'Unknown' for missing titles", async () => {
    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(res.body.recentActivity).toEqual([
      {
        id: "v1",
        resourceTitle: "Resource One",
        isOriginal: true,
        confidence: 0.9,
        flags: [],
        checkedAt: verificationRows[0].checkedAt.toISOString(),
      },
      {
        id: "v2",
        resourceTitle: "Unknown",
        isOriginal: false,
        confidence: 0.4,
        flags: ["duplicate"],
        checkedAt: verificationRows[1].checkedAt.toISOString(),
      },
      {
        id: "v3",
        resourceTitle: "Resource One",
        isOriginal: true,
        confidence: 0.95,
        flags: [],
        checkedAt: verificationRows[2].checkedAt.toISOString(),
      },
    ]);
    expect(res.body.stats.totalVerifications).toBe(3);
  });
});

describe("GET /agent/status — totalEarned from settled payments (#99)", () => {
  beforeEach(() => {
    resourceQueryCount = 0;
    lastResourceIdsArg = undefined;
  });

  it("reports only settled payment amounts, ignoring rejected and unsettled rows", async () => {
    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    // Settled: 0.10 (v1) + 0.25 (v3) = 0.35. Rejected (v2) and pending (v3) excluded.
    expect(res.body.stats.totalEarned).toBeCloseTo(0.35, 10);
    // Not count × price (3 × 0.10 = 0.30).
    expect(res.body.stats.totalEarned).not.toBeCloseTo(0.3, 10);
  });
});
