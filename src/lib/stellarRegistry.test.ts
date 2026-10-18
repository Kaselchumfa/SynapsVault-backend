I need to see the current content of `src/lib/stellarRegistry.ts` to write accurate tests. However, since only the test file is being created, I'll write tests based on the described API surface (options `cache`, `now`, `ttlMs`, `fetcher`; functions `stroopsToUsdc`, `normalizeUsdcPrice`; error `OnChainLookupError`; `createCache()`).

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  createCache,
  stroopsToUsdc,
  normalizeUsdcPrice,
  OnChainLookupError,
} from "./stellarRegistry";

describe("stroopsToUsdc", () => {
  it("converts 1 stroop to 0.0000001", () => {
    expect(stroopsToUsdc(1n)).toBe("0.0000001");
  });

  it("converts 1 USDC (10000000 stroops) to 1.0000000", () => {
    expect(stroopsToUsdc(10_000_000n)).toBe("1.0000000");
  });

  it("converts the largest supported value", () => {
    const max = 2n ** 127n - 1n;
    // 2^127 - 1 = 170141183460469231731687303715884105727
    // divided by 1e7 => 17014118346046923173168730371588.4105727
    expect(stroopsToUsdc(max)).toBe(
      "17014118346046923173168730371588.4105727",
    );
  });

  it("handles zero", () => {
    expect(stroopsToUsdc(0n)).toBe("0.0000000");
  });

  it("handles negative values", () => {
    expect(stroopsToUsdc(-1n)).toBe("-0.0000001");
    expect(stroopsToUsdc(-10_000_000n)).toBe("-1.0000000");
  });
});

describe("normalizeUsdcPrice", () => {
  it("normalizes 0.5", () => {
    expect(normalizeUsdcPrice("0.5")).toBe("0.5000000");
  });

  it("normalizes 1", () => {
    expect(normalizeUsdcPrice("1")).toBe("1.0000000");
  });

  it("truncates excess precision in 1.00000001", () => {
    expect(normalizeUsdcPrice("1.00000001")).toBe("1.0000000");
  });

  it("rejects invalid strings", () => {
    expect(() => normalizeUsdcPrice("abc")).toThrow();
    expect(() => normalizeUsdcPrice("")).toThrow();
    expect(() => normalizeUsdcPrice("1.2.3")).toThrow();
  });
});

describe("price lookup cache TTL", () => {
  it("returns cached result within TTL without invoking the fetcher", async () => {
    const cache = createCache();
    const fetcher = vi.fn().mockResolvedValue("1.0000000");
    let currentTime = 1_000;
    const now = () => currentTime;
    const ttlMs = 5_000;

    const first = await lookupPrice({ cache, now, ttlMs, fetcher });
    expect(first.cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);

    currentTime += 1_000; // still within TTL
    const second = await lookupPrice({ cache, now, ttlMs, fetcher });
    expect(second.cached).toBe(true);
    expect(second.price).toBe("1.0000000");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetches after TTL expires", async () => {
    const cache = createCache();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("1.0000000")
      .mockResolvedValueOnce("2.0000000");
    let currentTime = 1_000;
    const now = () => currentTime;
    const ttlMs = 5_000;

    const first = await lookupPrice({ cache, now, ttlMs, fetcher });
    expect(first.cached).toBe(false);
    expect(first.price).toBe("1.0000000");

    currentTime += ttlMs + 1; // expired
    const second = await lookupPrice({ cache, now, ttlMs, fetcher });
    expect(second.cached).toBe(false);
    expect(second.price).toBe("2.0000000");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("price lookup error paths", () => {
  it("wraps fetcher errors in OnChainLookupError with cause", async () => {
    const cache = createCache();
    const original = new Error("rpc down");
    const fetcher = vi.fn().mockRejectedValue(original);

    await expect(
      lookupPrice({ cache, now: () => 0, ttlMs: 1_000, fetcher }),
    ).rejects.toBeInstanceOf(OnChainLookupError);

    try {
      await lookupPrice({ cache, now: () => 0, ttlMs: 1_000, fetcher });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OnChainLookupError);
      expect((err as OnChainLookupError).cause).toBe(original);
    }
  });

  it("throws OnChainLookupError with not-found message when fetcher returns null", async () => {
    const cache = createCache();
    const fetcher = vi.fn().mockResolvedValue(null);

    await expect(
      lookupPrice({ cache, now: () => 0, ttlMs: 1_000, fetcher }),
    ).rejects.toBeInstanceOf(OnChainLookupError);

    try {
      await lookupPrice({ cache, now: () => 0, ttlMs: 1_000, fetcher });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OnChainLookupError);
      expect((err as Error).message.toLowerCase()).toContain("not found");
    }
  });
});
```

Note: The test file references a `lookupPrice` function that must be exported from `stellarRegistry.ts` with the described options (`cache`, `now`, `ttlMs`, `fetcher`) and return shape (`{ price, cached }`). If the actual exported function has a different name or signature, adjust the import and calls accordingly.