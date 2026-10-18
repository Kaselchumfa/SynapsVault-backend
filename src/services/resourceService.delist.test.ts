import { describe, it, expect, beforeEach, vi } from "vitest";

// The row returned by the mocked `update(...).returning()` chain. Each test
// mutates this to drive the registered / unregistered / not-found branches.
let returnedRow: Record<string, unknown> | undefined;

vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(returnedRow ? [returnedRow] : []),
        }),
      }),
    }),
  },
}));

const deleteFile = vi.fn((_path: string) => Promise.resolve());
vi.mock("../storage/supabaseStorage.js", () => ({
  uploadFile: vi.fn(),
  deleteFile: (path: string) => deleteFile(path),
}));

// delistOnChain is the real default; we mock the module so importing
// resourceService doesn't construct a live Stellar client at load time.
const delistOnChain = vi.fn((_id: string) =>
  Promise.resolve<{ txHash: string; success: boolean; error?: string }>({
    txHash: "tx123",
    success: true,
  }),
);
vi.mock("./registryClient.js", () => ({
  delistOnChain: (id: string) => delistOnChain(id),
}));

vi.mock("../config.js", () => ({ config: { CATALOG_CACHE_TTL_MS: 60_000 } }));

// Spy on the logger so we can assert the storage cleanup failure is logged.
const loggerError = vi.fn();
const loggerWarn = vi.fn();
vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({
    error: (...args: unknown[]) => loggerError(...args),
    warn: (...args: unknown[]) => loggerWarn(...args),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Spy on the cleanup queue so we can assert a cleanup job was enqueued.
const enqueueCleanup = vi.fn((_path: string) => Promise.resolve());
vi.mock("./cleanupQueue.js", () => ({
  enqueueCleanup: (path: string) => enqueueCleanup(path),
}));

import { delistResource } from "./resourceService.js";

describe("delistResource on-chain sync (#218)", () => {
  beforeEach(() => {
    returnedRow = undefined;
    deleteFile.mockClear();
    deleteFile.mockImplementation(() => Promise.resolve());
    delistOnChain.mockClear();
    delistOnChain.mockResolvedValue({ txHash: "tx123", success: true });
    loggerError.mockClear();
    loggerWarn.mockClear();
    enqueueCleanup.mockClear();
    enqueueCleanup.mockImplementation(() => Promise.resolve());
  });

  it("returns null when the resource is missing or not owned by the caller", async () => {
    returnedRow = undefined;
    const result = await delistResource("missing", "pub1");
    expect(result).toBeNull();
    expect(delistOnChain).not.toHaveBeenCalled();
  });

  it("triggers an on-chain delist for resources registered on-chain", async () => {
    returnedRow = { id: "r1", onchainStatus: "registered", storagePath: null };
    const injected = vi.fn(() => Promise.resolve({ success: true }));

    const result = await delistResource("r1", "pub1", injected);

    expect(result).toMatchObject({ id: "r1" });
    expect(injected).toHaveBeenCalledWith("r1");
  });

  it("skips the on-chain delist for resources never registered on-chain", async () => {
    returnedRow = { id: "r2", onchainStatus: "none", storagePath: null };
    const injected = vi.fn(() => Promise.resolve({ success: true }));

    const result = await delistResource("r2", "pub1", injected);

    expect(result).toMatchObject({ id: "r2" });
    expect(injected).not.toHaveBeenCalled();
  });

  it("still resolves the DB delist when the on-chain delist fails", async () => {
    returnedRow = { id: "r3", onchainStatus: "registered", storagePath: null };
    const injected = vi.fn(() => Promise.resolve({ success: false, error: "rpc down" }));

    const result = await delistResource("r3", "pub1", injected);

    // DB delist remains authoritative even when the chain call reports failure.
    expect(result).toMatchObject({ id: "r3" });
    expect(injected).toHaveBeenCalledWith("r3");
  });

  it("deletes stored files for file resources before syncing on-chain", async () => {
    returnedRow = { id: "r4", onchainStatus: "registered", storagePath: "r4/file.pdf" };
    const injected = vi.fn(() => Promise.resolve({ success: true }));

    await delistResource("r4", "pub1", injected);

    expect(deleteFile).toHaveBeenCalledWith("r4/file.pdf");
    expect(injected).toHaveBeenCalledWith("r4");
  });

  it("still resolves the delist when storage deletion fails, logging and queueing cleanup", async () => {
    returnedRow = { id: "r5", onchainStatus: "registered", storagePath: "r5/file.pdf" };
    deleteFile.mockImplementation(() =>
      Promise.reject(new Error("storage unavailable")),
    );
    const injected = vi.fn(() => Promise.resolve({ success: true }));

    const result = await delistResource("r5", "pub1", injected);

    // The route would return 200: the delist resolves with the resource.
    expect(result).toMatchObject({ id: "r5" });
    expect(deleteFile).toHaveBeenCalledWith("r5/file.pdf");

    // The failed cleanup is logged.
    const logged = [...loggerError.mock.calls, ...loggerWarn.mock.calls];
    expect(logged.length).toBeGreaterThan(0);
    expect(
      logged.some((call) =>
        call.some(
          (arg) =>
            (typeof arg === "string" && /storage|cleanup|delete/i.test(arg)) ||
            (arg &&
              typeof arg === "object" &&
              /storage|cleanup|delete/i.test(JSON.stringify(arg))),
        ),
      ),
    ).toBe(true);

    // A cleanup job was enqueued for the orphaned file.
    expect(enqueueCleanup).toHaveBeenCalledWith("r5/file.pdf");

    // The on-chain sync still runs.
    expect(injected).toHaveBeenCalledWith("r5");
  });
});
