import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

const { PUBLISHERS_MARKER, RESOURCES_MARKER, PAYMENTS_MARKER } = vi.hoisted(() => ({
  PUBLISHERS_MARKER: { __table: "publishers" },
  RESOURCES_MARKER: { __table: "resources" },
  PAYMENTS_MARKER: { __table: "payments" },
}));

vi.mock("../db/schema.js", () => ({
  publishers: PUBLISHERS_MARKER,
  resources: RESOURCES_MARKER,
  payments: PAYMENTS_MARKER,
}));

// apiKeyAuth matches by sha256(key); precompute so tests can supply a known key/hash pair.
const VALID_API_KEY = "mv_test-key";
const VALID_API_KEY_HASH = createHash("sha256").update(VALID_API_KEY).digest("hex");

const authedPublisher = {
  id: "pub-1",
  name: "Alice",
  email: "alice@example.com",
  walletAddress: "GALICE",
  apiKeyHash: VALID_API_KEY_HASH,
  createdAt: new Date("2026-01-01"),
};

let publishersLookupRows: Array<typeof authedPublisher>;
let resourcesRows: any[];
let paymentsRows: any[];
// Rows returned by the GROUP BY aggregate query (per-resource totals).
let aggregateRows: any[];
// Rows returned by the paginated recent-payments query.
let recentPaymentsRows: any[];

vi.mock("../db/client.js", () => ({
  db: {
    select: (_cols: unknown) => ({
      from: (table: unknown) => {
        if (table === PUBLISHERS_MARKER) {
          return { where: () => Promise.resolve(publishersLookupRows) };
        }
        if (table === RESOURCES_MARKER) {
          return { where: () => Promise.resolve(resourcesRows) };
        }
        if (table === PAYMENTS_MARKER) {
          // Aggregate path: select(...).from(payments).where(...).groupBy(...)
          // Recent-payments path: select(...).from(payments).where(...).orderBy(...).limit(...).offset(...)
          const chain: any = {
            groupBy: () => Promise.resolve(aggregateRows),
            orderBy: () => chain,
            limit: () => chain,
            offset: () => Promise.resolve(recentPaymentsRows),
            then: (resolve: (rows: any[]) => unknown) =>
              Promise.resolve(paymentsRows).then(resolve),
          };
          return { where: () => chain };
        }
        throw new Error("unexpected table in select().from()");
      },
    }),
  },
}));

vi.mock("../config.js", () => ({
  config: { BASE_URL: "http://localhost:4021" },
}));

const { mockRegisterPublisher, mockGetPublisherResources } = vi.hoisted(() => ({
  mockRegisterPublisher: vi.fn(),
  mockGetPublisherResources: vi.fn(),
}));

vi.mock("../services/publisherService.js", () => ({
  registerPublisher: mockRegisterPublisher,
  getPublisherResources: mockGetPublisherResources,
}));

import publisherRouter from "./publishers.js";
import { errorHandler } from "../middleware/errorHandler.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(publisherRouter);
  app.use(errorHandler);
  return app;
}

describe("POST /publishers — registration (#294)", () => {
  beforeEach(() => {
    mockRegisterPublisher.mockReset();
  });

  it("registers a publisher and returns the one-time API key", async () => {
    mockRegisterPublisher.mockResolvedValue({
      publisher: {
        id: "pub-1",
        name: "Alice",
        email: "alice@example.com",
        walletAddress: "GALICE",
        createdAt: new Date("2026-01-01"),
      },
      apiKey: "mv_freshkey",
    });

    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "pub-1",
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
      apiKey: "mv_freshkey",
    });
    expect(mockRegisterPublisher).toHaveBeenCalledWith({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });
  });

  it("returns 400 for an invalid email", async () => {
    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "not-an-email",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(400);
    expect(mockRegisterPublisher).not.toHaveBeenCalled();
  });

  it("returns 400 when a required field is missing", async () => {
    const res = await request(createTestApp()).post("/publishers").send({
      email: "alice@example.com",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(400);
    expect(mockRegisterPublisher).not.toHaveBeenCalled();
  });

  it("returns 400 for unexpected extra fields (strict schema)", async () => {
    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
      isAdmin: true,
    });

    expect(res.status).toBe(400);
    expect(mockRegisterPublisher).not.toHaveBeenCalled();
  });

  it("returns 409 when the email is already registered", async () => {
    mockRegisterPublisher.mockRejectedValue(
      new Error("duplicate key value violates unique constraint"),
    );

    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Email already registered");
  });

  it("returns 409 for a drizzle-wrapped unique violation", async () => {
    mockRegisterPublisher.mockRejectedValue(
      Object.assign(new Error("Failed query: insert into publishers ..."), {
        cause: { code: "23505" },
      }),
    );

    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("rethrows unexpected errors from the service", async () => {
    mockRegisterPublisher.mockRejectedValue(new Error("database is down"));

    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(500);
  });
});

describe("GET /publishers/me — auth enforcement (#294)", () => {
  beforeEach(() => {
    publishersLookupRows = [];
  });

  it("returns 401 when the x-api-key header is missing", async () => {
    const res = await request(createTestApp()).get("/publishers/me");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing x-api-key header");
  });

  it("returns 401 when the API key does not match any publisher", async () => {
    publishersLookupRows = [];

    const res = await request(createTestApp())
      .get("/publishers/me")
      .set("x-api-key", "mv_wrong-key");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid API key");
  });

  it("returns the publisher profile for a valid API key", async () => {
    publishersLookupRows = [authedPublisher];

    const res = await request(createTestApp())
      .get("/publishers/me")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "pub-1",
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });
  });
});

describe("GET /publishers/me/resources — auth + happy path (#294)", () => {
  beforeEach(() => {
    publishersLookupRows = [authedPublisher];
    mockGetPublisherResources.mockReset();
  });

  it("returns 401 without a valid API key", async () => {
    publishersLookupRows = [];

    const res = await request(createTestApp())
      .get("/publishers/me/resources")
      .set("x-api-key", "mv_wrong-key");

    expect(res.status).toBe(401);
    expect(mockGetPublisherResources).not.toHaveBeenCalled();
  });

  it("returns the authenticated publisher's resources", async () => {
    mockGetPublisherResources.mockResolvedValue([{ id: "res-1", title: "Doc" }]);

    const res = await request(createTestApp())
      .get("/publishers/me/resources")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "res-1", title: "Doc" }]);
    expect(mockGetPublisherResources).toHaveBeenCalledWith("pub-1");
  });
});

describe("GET /publishers/me/analytics — auth + aggregation (#294)", () => {
  beforeEach(() => {
    publishersLookupRows = [authedPublisher];
    resourcesRows = [];
    paymentsRows = [];
    aggregateRows = [];
    recentPaymentsRows = [];
  });

  it("returns 401 without a valid API key", async () => {
    publishersLookupRows = [];

    const res = await request(createTestApp())
      .get("/publishers/me/analytics")
      .set("x-api-key", "mv_wrong-key");

    expect(res.status).toBe(401);
  });

  it("returns zeroed summary when the publisher has no resources", async () => {
    const res = await request(createTestApp())
      .get("/publishers/me/analytics")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      totalEarned: "0.0000",
      totalSales: 0,
      totalResources: 0,
      listedResources: 0,
    });
    expect(res.body.resources).toEqual([]);
  });

  it("aggregates earnings only from payments paid to the publisher's own wallet", async () => {
    resourcesRows = [
      {
        id: "res-1",
        title: "Doc",
        price: "5.00",
        verificationStatus: "verified",
        listed: true,
        createdAt: new Date("2026-01-01"),
      },
    ];
    // The SQL aggregate already filters by recipient wallet, so only the
    // publisher's own payment is reflected in the grouped totals.
    aggregateRows = [{ resourceId: "res-1", totalSales: 1, totalEarned: "5.00" }];
    recentPaymentsRows = [
      {
        id: "pay-1",
        resourceId: "res-1",
        payerAddress: "GBUYER",
        recipientAddress: "GALICE",
        amount: "5.00",
        paidAt: new Date("2026-01-02"),
      },
    ];

    const res = await request(createTestApp())
      .get("/publishers/me/analytics")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.summary.totalEarned).toBe("5.0000");
    expect(res.body.summary.totalSales).toBe(1);
    expect(res.body.resources).toHaveLength(1);
    expect(res.body.resources[0]).toMatchObject({
      id: "res-1",
      totalSales: 1,
      totalEarned: "5.0000",
    });
  });

  it("SQL aggregate totals match the previous in-memory implementation", async () => {
    resourcesRows = [
      {
        id: "res-1",
        title: "Doc",
        price: "5.00",
        verificationStatus: "verified",
        listed: true,
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "res-2",
        title: "Guide",
        price: "2.50",
        verificationStatus: "pending",
        listed: false,
        createdAt: new Date("2026-01-02"),
      },
      {
        id: "res-3",
        title: "Unpaid",
        price: "1.00",
        verificationStatus: "verified",
        listed: true,
        createdAt: new Date("2026-01-03"),
      },
    ];
    paymentsRows = [
      {
        id: "pay-1",
        resourceId: "res-1",
        payerAddress: "GBUYER",
        recipientAddress: "GALICE",
        amount: "5.00",
        paidAt: new Date("2026-01-04"),
      },
      {
        id: "pay-2",
        resourceId: "res-1",
        payerAddress: "GBUYER2",
        recipientAddress: "GALICE",
        amount: "5.00",
        paidAt: new Date("2026-01-05"),
      },
      {
        id: "pay-3",
        resourceId: "res-2",
        payerAddress: "GBUYER",
        recipientAddress: "GALICE",
        amount: "2.50",
        paidAt: new Date("2026-01-06"),
      },
      {
        id: "pay-4",
        resourceId: "res-2",
        payerAddress: "GBUYER3",
        recipientAddress: "GSOMEONE_ELSE",
        amount: "99.00",
        paidAt: new Date("2026-01-07"),
      },
    ];

    // Reference: the previous in-memory implementation.
    const ownPayments = paymentsRows.filter((p) => p.recipientAddress === "GALICE");
    const expectedByResource = new Map<string, { totalSales: number; totalEarned: number }>();
    for (const p of ownPayments) {
      const prev = expectedByResource.get(p.resourceId) ?? { totalSales: 0, totalEarned: 0 };
      expectedByResource.set(p.resourceId, {
        totalSales: prev.totalSales + 1,
        totalEarned: prev.totalEarned + Number(p.amount),
      });
    }
    const expectedTotalEarned = ownPayments
      .reduce((sum, p) => sum + Number(p.amount), 0)
      .toFixed(4);
    const expectedTotalSales = ownPayments.length;

    // SQL aggregate result for the same fixture data.
    aggregateRows = Array.from(expectedByResource.entries()).map(([resourceId, t]) => ({
      resourceId,
      totalSales: t.totalSales,
      totalEarned: t.totalEarned.toFixed(2),
    }));
    recentPaymentsRows = ownPayments.slice(0, 2);

    const res = await request(createTestApp())
      .get("/publishers/me/analytics")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.summary.totalEarned).toBe(expectedTotalEarned);
    expect(res.body.summary.totalSales).toBe(expectedTotalSales);
    expect(res.body.summary.totalResources).toBe(3);
    expect(res.body.summary.listedResources).toBe(2);

    const byId = new Map<string, any>(res.body.resources.map((r: any) => [r.id, r]));
    for (const [resourceId, expected] of expectedByResource) {
      expect(byId.get(resourceId)).toMatchObject({
        totalSales: expected.totalSales,
        totalEarned: expected.totalEarned.toFixed(4),
      });
    }
    // Resources with no payments report zeroed totals.
    expect(byId.get("res-3")).toMatchObject({ totalSales: 0, totalEarned: "0.0000" });
  });
});
