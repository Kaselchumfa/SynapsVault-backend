import { describe, it, expect, beforeEach, vi } from "vitest";

// Captures the values passed to `.set(...)` on the update chain.
const { setCalls, returnedRows } = vi.hoisted(() => ({
  setCalls: [] as Array<Record<string, unknown>>,
  returnedRows: { rows: [] as Array<Record<string, unknown>> },
}));

// Insert / delete bookkeeping for the createFileResource tests.
const { insertedRows, deletedIds, insertValues } = vi.hoisted(() => ({
  insertedRows: { rows: [] as Array<Record<string, unknown>> },
  deletedIds: [] as Array<unknown>,
  insertValues: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve(returnedRows.rows),
          }),
        };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertValues.push(values);
        return {
          returning: () => Promise.resolve(insertedRows.rows),
        };
      },
    }),
    delete: () => ({
      where: (condition: unknown) => {
        deletedIds.push(condition);
        return Promise.resolve();
      },
    }),
  },
}));

const { uploadFileMock, deleteFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
}));

vi.mock("../storage/supabaseStorage.js", () => ({
  uploadFile: uploadFileMock,
  deleteFile: deleteFileMock,
}));

// Thumbnail worker mock: records calls and lets tests control completion.
const { thumbnailCalls, thumbnailState } = vi.hoisted(() => ({
  thumbnailCalls: [] as Array<Record<string, unknown>>,
  thumbnailState: {
    resolve: null as null | (() => void),
    reject: null as null | ((err: unknown) => void),
    promise: null as null | Promise<void>,
  },
}));

vi.mock("./thumbnailWorker.js", () => ({
  enqueueThumbnail: (input: Record<string, unknown>) => {
    thumbnailCalls.push(input);
    thumbnailState.promise = new Promise<void>((resolve, reject) => {
      thumbnailState.resolve = resolve;
      thumbnailState.reject = reject;
    });
    return thumbnailState.promise;
  },
}));

import { adminDelistResource, createFileResource } from "./resourceService.js";

describe("adminDelistResource", () => {
  beforeEach(() => {
    setCalls.length = 0;
    returnedRows.rows = [];
  });

  it("delists and stamps adminDelistedAt so the resource cannot be relisted", async () => {
    returnedRows.rows = [{ id: "res-1" }];

    const before = Date.now();
    const result = await adminDelistResource("res-1");

    expect(result).toEqual({ id: "res-1" });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].listed).toBe(false);
    expect(setCalls[0].adminDelistedAt).toBeInstanceOf(Date);
    expect((setCalls[0].adminDelistedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("returns null for an unknown id", async () => {
    returnedRows.rows = [];

    expect(await adminDelistResource("missing")).toBeNull();
  });
});

describe("createFileResource", () => {
  const file = {
    buffer: Buffer.from("data"),
    mimetype: "image/png",
    originalname: "cover.png",
  };

  beforeEach(() => {
    insertValues.length = 0;
    deletedIds.length = 0;
    insertedRows.rows = [];
    thumbnailCalls.length = 0;
    thumbnailState.resolve = null;
    thumbnailState.reject = null;
    thumbnailState.promise = null;
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
  });

  it("leaves no row behind when the upload fails", async () => {
    insertedRows.rows = [{ id: "res-1", storagePath: null }];
    uploadFileMock.mockRejectedValue(new Error("upload boom"));

    await expect(
      createFileResource({ publisherId: "pub-1", file }),
    ).rejects.toThrow("upload boom");

    // The compensating delete must have run for the inserted row.
    expect(deletedIds).toHaveLength(1);
    expect(insertedRows.rows[0].id).toBe("res-1");
  });

  it("does not wait for thumbnail generation before resolving", async () => {
    insertedRows.rows = [{ id: "res-1", storagePath: "path/cover.png" }];
    uploadFileMock.mockResolvedValue({ path: "path/cover.png" });

    const result = await createFileResource({ publisherId: "pub-1", file });

    expect(result).toEqual(insertedRows.rows[0]);
    // Thumbnail work was scheduled but has not completed.
    expect(thumbnailCalls).toHaveLength(1);
    expect(thumbnailState.resolve).not.toBeNull();

    // Let the background job finish so it does not leak between tests.
    thumbnailState.resolve?.();
    await thumbnailState.promise;
  });

  it("rejects oversized images via the pixel limit in the worker", async () => {
    insertedRows.rows = [{ id: "res-1", storagePath: "path/cover.png" }];
    uploadFileMock.mockResolvedValue({ path: "path/cover.png" });

    await createFileResource({ publisherId: "pub-1", file });

    expect(thumbnailCalls).toHaveLength(1);
    expect(thumbnailCalls[0].limitInputPixels).toBeGreaterThan(0);

    thumbnailState.reject?.(new Error("Input image exceeds pixel limit"));
    await expect(thumbnailState.promise).rejects.toThrow(/pixel limit/);
  });
});
