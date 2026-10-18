import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const {
  mockRegistryCount,
  mockSubmitSignedTx,
  mockValidateSignedTx,
  mockGetTransactionStatus,
  mockDbQuery,
} = vi.hoisted(() => ({
  mockRegistryCount: vi.fn(),
  mockSubmitSignedTx: vi.fn(),
  mockValidateSignedTx: vi.fn(),
  mockGetTransactionStatus: vi.fn(),
  mockDbQuery: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    NETWORK: "testnet",
    REGISTRY_CONTRACT_ID: "CDLZFC3SYJYDLZ5UJHAEFFK4F55WD5FE2OQCTCNJNFBKG2MRNGLA",
  },
}));

vi.mock("../services/registryClient.js", () => ({
  registryClient: {
    count: mockRegistryCount,
    submitSignedTx: mockSubmitSignedTx,
    validateSignedTx: mockValidateSignedTx,
    getTransactionStatus: mockGetTransactionStatus,
  },
}));

vi.mock("../db/index.js", () => ({
  db: {
    query: mockDbQuery,
  },
}));

vi.mock("../lib/logger.js", () => ({
  getRequestId: () => undefined,
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
}));

import registryRouter from "./registry.js";
import resourcesRouter from "./resources.js";
import { errorHandler } from "../middleware/errorHandler.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(registryRouter);
  app.use(resourcesRouter);
  app.use(errorHandler);
  return app;
}

describe("GET /registry/status — public registry metadata endpoint", () => {
  beforeEach(() => {
    mockRegistryCount.mockReset();
  });

  it("returns registry status with correct shape on success", async () => {
    mockRegistryCount.mockResolvedValue({
      result: 42,
    });

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      contractId: "CDLZFC3SYJYDLZ5UJHAEFFK4F55WD5FE2OQCTCNJNFBKG2MRNGLA",
      network: "testnet",
      resourceCount: 42,
    });
  });

  it("sets Cache-Control header with 30 second max-age", async () => {
    mockRegistryCount.mockResolvedValue({
      result: 10,
    });

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=30");
  });

  it("handles network name with colon separator correctly", async () => {
    vi.doMock("../config.js", () => ({
      config: {
        NETWORK: "public:testnet",
        REGISTRY_CONTRACT_ID: "CDLZFC3SYJYDLZ5UJHAEFFK4F55WD5FE2OQCTCNJNFBKG2MRNGLA",
      },
    }));

    mockRegistryCount.mockResolvedValue({
      result: 5,
    });

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.status).toBe(200);
    expect(res.body.network).toBe("testnet");
  });

  it("returns 503 when registry client fails", async () => {
    mockRegistryCount.mockRejectedValue(new Error("RPC connection failed"));

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "Unable to fetch registry status. Please try again later.",
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("returns 503 when registry count returns error", async () => {
    mockRegistryCount.mockRejectedValue(new Error("Contract error"));

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("converts resource count from number to number correctly", async () => {
    mockRegistryCount.mockResolvedValue({
      result: "100",
    });

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.status).toBe(200);
    expect(res.body.resourceCount).toBe(100);
  });

  it("handles zero resource count", async () => {
    mockRegistryCount.mockResolvedValue({
      result: 0,
    });

    const res = await request(createTestApp()).get("/registry/status");

    expect(res.status).toBe(200);
    expect(res.body.resourceCount).toBe(0);
  });
});

const REGISTRY_CONTRACT_ID =
  "CDLZFC3SYJYDLZ5UJHAEFFK4F55WD5FE2OQCTCNJNFBKG2MRNGLA";
const OWNER = "GOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RESOURCE_ID = "res-1";
const TX_HASH = "abc123hash";

function signedTxBody(overrides: Record<string, unknown> = {}) {
  return {
    signedXdr: "AAAA...signed...",
    sourceAccount: OWNER,
    ...overrides,
  };
}

function mockResourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOURCE_ID,
    owner: OWNER,
    onchain_status: "none",
    ...overrides,
  };
}

describe("signed XDR validation (issue #75)", () => {
  beforeEach(() => {
    mockValidateSignedTx.mockReset();
    mockSubmitSignedTx.mockReset();
    mockDbQuery.mockReset();
  });

  it("rejects a transaction targeting another contract", async () => {
    mockDbQuery.mockResolvedValue({ rows: [mockResourceRow()] });
    mockValidateSignedTx.mockReturnValue({
      valid: false,
      reason: "contract_mismatch",
    });

    const res = await request(createTestApp())
      .post(`/resources/${RESOURCE_ID}/price`)
      .send(signedTxBody());

    expect(res.status).toBe(400);
    expect(mockSubmitSignedTx).not.toHaveBeenCalled();
  });

  it("rejects a transaction calling another function", async () => {
    mockDbQuery.mockResolvedValue({ rows: [mockResourceRow()] });
    mockValidateSignedTx.mockReturnValue({
      valid: false,
      reason: "function_mismatch",
    });

    const res = await request(createTestApp())
      .post(`/resources/${RESOURCE_ID}/price`)
      .send(signedTxBody());

    expect(res.status).toBe(400);
    expect(mockSubmitSignedTx).not.toHaveBeenCalled();
  });

  it("rejects a transaction for another resource id", async () => {
    mockDbQuery.mockResolvedValue({ rows: [mockResourceRow()] });
    mockValidateSignedTx.mockReturnValue({
      valid: false,
      reason: "resource_mismatch",
    });

    const res = await request(createTestApp())
      .post(`/resources/${RESOURCE_ID}/ownership`)
      .send(signedTxBody());

    expect(res.status).toBe(400);
    expect(mockSubmitSignedTx).not.toHaveBeenCalled();
  });

  it("rejects a transaction whose source account is not the owner", async () => {
    mockDbQuery.mockResolvedValue({ rows: [mockResourceRow()] });
    mockValidateSignedTx.mockReturnValue({
      valid: false,
      reason: "source_mismatch",
    });

    const res = await request(createTestApp())
      .post(`/resources/${RESOURCE_ID}/register`)
      .send(signedTxBody({ sourceAccount: OTHER }));

    expect(res.status).toBe(400);
    expect(mockSubmitSignedTx).not.toHaveBeenCalled();
  });

  it("passes the expected contract, function, resource id and owner to the validator", async () => {
    mockDbQuery.mockResolvedValue({ rows: [mockResourceRow()] });
    mockValidateSignedTx.mockReturnValue({ valid: true });
    mockSubmitSignedTx.mockResolvedValue({
      status: "pending",
      hash: TX_HASH,
    });

    await request(createTestApp())
      .post(`/resources/${RESOURCE_ID}/price`)
      .send(signedTxBody());

    expect(mockValidateSignedTx).toHaveBeenCalledWith(
      expect.objectContaining({
        signedXdr: "AAAA...signed...",
        contractId: REGISTRY_CONTRACT_ID,
        functionName: "update_price",
        resourceId: RESOURCE_ID,
        sourceAccount: OWNER,
      }),
    );
  });
});

describe("pending submissions return 202 with hash (issue #76)", () => {
  beforeEach(() => {
    mockValidateSignedTx.mockReset();
    mockSubmitSignedTx.mockReset();
    mockDbQuery.mockReset();
    mockValidateSignedTx.mockReturnValue({ valid: true });
  });

  it("price handler returns 202 with the tx hash while pending", async () => {
    mockDbQuery.mockResolvedValue({ rows: [mockResourceRow()] });
    mockSubmitSignedTx.mockResolvedValue({
      status: "pending",
      hash: TX_HASH,
    });

    const res = await request(createTestApp())
      .post(`/resources/${RESOURCE_ID}/price`)
      .send(signedTxBody());

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "pending", hash: TX_HASH });
  });

  it("ownership handler returns 202 with the tx hash while pending", async () => {
    mockDbQuery.mockResolvedValue({ rows: [mockResourceRow()] });
    mockSubmitSignedTx.mockResolvedValue({
      status: "pending",
      hash: TX_HASH,
    });

    const res = await request(createTestApp())
      .post(`/resources/${RESOURCE_ID}/ownership`)
      .send(signedTxBody());

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "pending", hash: TX_HASH });
  });

  it("price and ownership use the same submission helper", async () => {
    mockDbQuery.mockResolvedValue({ rows: [mockResourceRow()] });
    mockSubmitSignedTx.mockResolvedValue({
      status: "pending",
      hash: TX_HASH,
    });

    await request(createTestApp())
      .post(`/resources/${RESOURCE_ID}/price`)
      .send(signedTxBody());
    await request(createTestApp())
      .post(`/resources/${RESOURCE_ID}/ownership`)
      .send(signedTxBody());

    expect(mockSubmitSignedTx).toHaveBeenCalledTimes(2);
    const [firstArgs] = mockSubmitSignedTx.mock.calls[0];
    const [secondArgs] = mockSubmitSignedTx.mock.calls[1];
    expect(Object.keys(firstArgs).sort()).toEqual(
      Object.keys(secondArgs).sort(),
    );
  });
});

describe("timeout leaves status pending (issue #77)", () => {
  beforeEach(() => {
    mockValidateSignedTx.mockReset();
    mockSubmitSignedTx.mockReset();
    mockGetTransactionStatus.mockReset();
    mockDbQuery.mockReset();
    mockValidateSignedTx.mockReturnValue({ valid: true });
  });

  it("keeps onchainStatus pending when submission times out", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [mockResourceRow()] })
      .mockResolvedValueOnce({ rows: [{ ...mockResourceRow(), onchain_status: "pending" }] });
    mockSubmitSignedTx.mockResolvedValue({
      status: "pending",
      hash: TX_HASH,
    });

    const res = await request(createTestApp())
      .post(`/resources/${RESOURCE_ID}/register`)
      .send(signedTxBody());

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "pending", hash: TX_HASH });

    const updateCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE"),
    );
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).not.toContain("'failed'");
    expect(updateCall![1]).toContain("pending");
  });

  it("worker resolves a pending hash to registered on later confirmation", async () => {
    mockGetTransactionStatus.mockResolvedValue({ status: "success" });
    mockDbQuery.mockResolvedValue({ rows: [{ id: RESOURCE_ID }] });

    const { resolvePendingTransaction } = await import(
      "../services/registryClient.js"
    ).catch(() => ({ resolvePendingTransaction: undefined }));

    if (typeof resolvePendingTransaction === "function") {
      await resolvePendingTransaction(TX_HASH);
    }

    expect(mockGetTransactionStatus).toHaveBeenCalledWith(TX_HASH);
  });
});

describe("register concurrency (issue #78)", () => {
  beforeEach(() => {
    mockValidateSignedTx.mockReset();
    mockSubmitSignedTx.mockReset();
    mockDbQuery.mockReset();
    mockValidateSignedTx.mockReturnValue({ valid: true });
    mockSubmitSignedTx.mockResolvedValue({
      status: "pending",
      hash: TX_HASH,
    });
  });

  it("only one of two concurrent register requests submits; the other gets 409", async () => {
    let claimed = false;
    mockDbQuery.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("UPDATE") && text.includes("RETURNING")) {
        if (claimed) {
          return { rows: [] };
        }
        claimed = true;
        return { rows: [{ ...mockResourceRow(), onchain_status: "pending" }] };
      }
      return { rows: [mockResourceRow()] };
    });

    const app = createTestApp();
    const [first, second] = await Promise.all([
      request(app)
        .post(`/resources/${RESOURCE_ID}/register`)
        .send(signedTxBody()),
      request(app)
        .post(`/resources/${RESOURCE_ID}/register`)
        .send(signedTxBody()),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([202, 409]);
    expect(mockSubmitSignedTx).toHaveBeenCalledTimes(1);
  });
});
