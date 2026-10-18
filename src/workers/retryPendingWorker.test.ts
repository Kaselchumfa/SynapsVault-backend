import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();

vi.mock('../db/client.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}));

const mockResourceExists = vi.fn();
const mockRegister = vi.fn();
const mockRegistryKeypair = vi.fn();
const mockNetPassphrase = 'Test SDF Network ; September 2015';

vi.mock('../services/registryClient.js', () => ({
  resourceExists: (...args: unknown[]) => mockResourceExists(...args),
  registryClient: {
    register: (...args: unknown[]) => mockRegister(...args),
  },
  registryKeypair: () => mockRegistryKeypair(),
  NETWORK_PASSPHRASE: mockNetPassphrase,
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../lib/logger.js', () => ({
  logger: mockLogger,
}));

const mockSignAndSend = vi.fn();

vi.mock('@stellar/stellar-sdk', () => {
  class Transaction {
    sign = vi.fn();
    signAndSend = (...args: unknown[]) => mockSignAndSend(...args);
    constructor(public xdr: string) {}
  }
  return {
    Transaction,
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; September 2015',
    },
  };
});

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import {
  startRetryPendingWorker,
  stopRetryPendingWorker,
} from './retryPendingWorker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TICK_INTERVAL_MS = 60_000;

/**
 * Advance fake timers by one tick interval and flush pending microtasks so the
 * async tick handler completes before assertions run.
 */
async function runTick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
  // Flush any remaining microtasks queued by the async tick.
  await Promise.resolve();
  await Promise.resolve();
}

function makeStuckRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    name: 'Test Resource',
    url: 'https://example.com',
    description: 'desc',
    category: 'tools',
    stellar_address: 'GABC123',
    onchain_status: 'pending',
    onchain_tx_hash: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retryPendingWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockRegistryKeypair.mockReturnValue({
      publicKey: () => 'GREGISTRY',
      secret: () => 'SREGISTRY',
    });
  });

  afterEach(() => {
    stopRetryPendingWorker();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('does nothing when there are no stuck resources', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    startRetryPendingWorker();
    await runTick();

    // Only the SELECT should have run; no UPDATE.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/SELECT/i);
    expect(mockResourceExists).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('marks resource as registered when it already exists on-chain', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeStuckRow()] }) // SELECT stuck
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    mockResourceExists.mockResolvedValueOnce(true);

    startRetryPendingWorker();
    await runTick();

    expect(mockResourceExists).toHaveBeenCalledWith('GABC123');
    expect(mockRegister).not.toHaveBeenCalled();

    const updateCall = mockQuery.mock.calls.find((c) =>
      /UPDATE/i.test(String(c[0])),
    );
    expect(updateCall).toBeDefined();
    // Status transition: pending -> registered
    expect(updateCall![1]).toContain('registered');
  });

  it('registers successfully and sets status registered with tx hash', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeStuckRow()] }) // SELECT stuck
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    mockResourceExists.mockResolvedValueOnce(false);
    mockRegister.mockResolvedValueOnce({ xdr: 'xdr-payload' });
    mockSignAndSend.mockResolvedValueOnce({ hash: 'tx-hash-123' });

    startRetryPendingWorker();
    await runTick();

    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockSignAndSend).toHaveBeenCalledTimes(1);

    const updateCall = mockQuery.mock.calls.find((c) =>
      /UPDATE/i.test(String(c[0])),
    );
    expect(updateCall).toBeDefined();
    // Status transition: pending -> registered with onchain tx hash
    expect(updateCall![1]).toContain('registered');
    expect(updateCall![1]).toContain('tx-hash-123');
  });

  it('logs error and leaves status unchanged when register fails within retry limit', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeStuckRow()] }) // SELECT stuck
      .mockResolvedValueOnce({ rows: [] }); // UPDATE (retry count increment)

    mockResourceExists.mockResolvedValueOnce(false);
    mockRegister.mockRejectedValueOnce(new Error('register boom'));

    startRetryPendingWorker();
    await runTick();

    expect(mockLogger.error).toHaveBeenCalled();

    // Status must NOT transition to failed while attempts <= MAX_RETRY_ATTEMPTS.
    const failedUpdate = mockQuery.mock.calls.find(
      (c) => /UPDATE/i.test(String(c[0])) && c[1]?.includes?.('failed'),
    );
    expect(failedUpdate).toBeUndefined();
  });

  it('marks resource as failed when attempts exceed MAX_RETRY_ATTEMPTS (pre-attempt branch)', async () => {
    // Simulate a resource whose retry count is already at/over the max.
    mockQuery
      .mockResolvedValueOnce({
        rows: [makeStuckRow({ retry_count: 100 })],
      }) // SELECT stuck
      .mockResolvedValueOnce({ rows: [] }); // UPDATE -> failed

    startRetryPendingWorker();
    await runTick();

    // Should not even attempt registry calls once over the limit.
    expect(mockResourceExists).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();

    const updateCall = mockQuery.mock.calls.find((c) =>
      /UPDATE/i.test(String(c[0])),
    );
    expect(updateCall).toBeDefined();
    // Status transition: pending -> failed
    expect(updateCall![1]).toContain('failed');
  });

  it('marks resource as failed when register fails and attempts exceed MAX_RETRY_ATTEMPTS (catch branch)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeStuckRow()] }) // SELECT stuck
      .mockResolvedValueOnce({ rows: [] }) // UPDATE retry count
      .mockResolvedValueOnce({ rows: [] }); // UPDATE -> failed

    mockResourceExists.mockResolvedValueOnce(false);
    mockRegister.mockRejectedValueOnce(new Error('register boom'));

    // Drive the retry count past the limit across ticks.
    startRetryPendingWorker();

    // First tick: register fails, count increments, status unchanged.
    await runTick();

    // Subsequent ticks: keep failing until the catch branch flips to failed.
    mockResourceExists.mockResolvedValue(false);
    mockRegister.mockRejectedValue(new Error('register boom'));

    // Run enough ticks to exceed MAX_RETRY_ATTEMPTS.
    for (let i = 0; i < 10; i++) {
      await runTick();
    }

    const failedUpdate = mockQuery.mock.calls.find(
      (c) => /UPDATE/i.test(String(c[0])) && c[1]?.includes?.('failed'),
    );
    expect(failedUpdate).toBeDefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('stopRetryPendingWorker clears the interval and retry counts', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    startRetryPendingWorker();
    await runTick();
    const callsAfterStart = mockQuery.mock.calls.length;

    stopRetryPendingWorker();

    // Advancing time after stop must not trigger further ticks.
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 5);
    expect(mockQuery.mock.calls.length).toBe(callsAfterStart);
  });

  it('catches and logs DB errors during a tick', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));

    startRetryPendingWorker();
    await runTick();

    expect(mockLogger.error).toHaveBeenCalled();
    // Worker should remain alive; a subsequent successful tick still runs.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const callsBefore = mockQuery.mock.calls.length;
    await runTick();
    expect(mockQuery.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});