import { describe, it, expect, beforeAll, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import fs from "node:fs";

// uploadGuards imports config; mock it so the test doesn't need a full env.
vi.mock("../config.js", () => ({
  config: {
    MAX_FILE_SIZE_MB: 1,
    ALLOWED_UPLOAD_MIME_TYPES: "application/pdf,image/png,text/plain",
  },
}));

import {
  singleFileUpload,
  validateUploadContentType,
  __getActiveUploadCount,
} from "./uploadGuards.js";

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildApp(): Express {
  const app = express();
  app.post("/upload", singleFileUpload("file"), validateUploadContentType, (req, res) => {
    res.status(201).json({ ok: true, mimetype: req.file?.mimetype ?? null });
  });
  return app;
}

describe("upload guards middleware", () => {
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });

  it("accepts an allow-listed file whose bytes match", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it("rejects a disallowed content type with 415", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("file", Buffer.from([0x50, 0x4b, 0x03, 0x04]), {
        filename: "a.zip",
        contentType: "application/zip",
      });
    expect(res.status).toBe(415);
  });

  it("rejects when declared type does not match detected bytes (415)", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("file", PNG, { filename: "fake.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/does not match/i);
  });

  it("rejects oversized uploads with 413", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41); // 2MB > 1MB limit
    const res = await request(app)
      .post("/upload")
      .attach("file", big, { filename: "big.txt", contentType: "text/plain" });
    expect(res.status).toBe(413);
  });

  it("passes through requests with no file", async () => {
    const res = await request(app).post("/upload").send();
    expect(res.status).toBe(201);
    expect(res.body.mimetype).toBeNull();
  });

  it("streams uploads to disk instead of buffering in memory", async () => {
    let capturedPath: string | undefined;
    let capturedBuffer: unknown;
    const probe = express();
    probe.post(
      "/upload",
      singleFileUpload("file"),
      validateUploadContentType,
      (req, res) => {
        capturedPath = req.file?.path;
        capturedBuffer = (req.file as unknown as { buffer?: unknown })?.buffer;
        res.status(201).json({ ok: true });
      },
    );

    const res = await request(probe)
      .post("/upload")
      .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(capturedBuffer).toBeUndefined();
    expect(typeof capturedPath).toBe("string");
    expect(capturedPath && fs.existsSync(capturedPath)).toBe(true);
  });

  it("keeps memory bounded during concurrent large uploads", async () => {
    const nearLimit = Buffer.alloc(900 * 1024, 0x41); // just under 1MB limit
    const concurrency = 6;

    // Warm up so one-off allocations don't skew the measurement.
    await request(app)
      .post("/upload")
      .attach("file", nearLimit, { filename: "warm.txt", contentType: "text/plain" });

    const before = process.memoryUsage().heapUsed;
    const responses = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        request(app)
          .post("/upload")
          .attach("file", nearLimit, {
            filename: `big-${i}.txt`,
            contentType: "text/plain",
          }),
      ),
    );
    const after = process.memoryUsage().heapUsed;

    for (const res of responses) {
      expect(res.status).toBe(201);
    }

    // If uploads were buffered in memory, heap would grow by ~concurrency * size.
    // Allow generous slack for GC noise but stay well below full buffering.
    const growth = after - before;
    const fullBuffering = concurrency * nearLimit.length;
    expect(growth).toBeLessThan(fullBuffering / 2);
  });

  it("caps the number of simultaneous uploads", async () => {
    const nearLimit = Buffer.alloc(900 * 1024, 0x41);
    const concurrency = 8;

    const pending = Array.from({ length: concurrency }, (_, i) =>
      request(app)
        .post("/upload")
        .attach("file", nearLimit, {
          filename: `cap-${i}.txt`,
          contentType: "text/plain",
        }),
    );

    // While requests are in flight the active count must never exceed the cap.
    let maxObserved = 0;
    const poll = setInterval(() => {
      maxObserved = Math.max(maxObserved, __getActiveUploadCount());
    }, 1);

    const responses = await Promise.all(pending);
    clearInterval(poll);

    for (const res of responses) {
      // Either accepted, or rejected with 503 when the limiter is saturated.
      expect([201, 503]).toContain(res.status);
    }
    expect(maxObserved).toBeLessThanOrEqual(__getActiveUploadCount() + 1);
    expect(__getActiveUploadCount()).toBe(0);
  });
});
