import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

const mockQuery = vi.fn();
vi.mock('../db/client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../config.js', () => ({
  config: {
    contractId: 'C_CONTRACT',
    rpcUrl: 'https://rpc.example.com',
    networkPassphrase: 'Test SDF Network ; September 2015',
    eventPollIntervalMs: 5000,
    checkpointPath: '/tmp/checkpoint.json',
  },
}));

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock('../lib/logger.js', () => ({
  logger: mockLogger,
}));

const mockGetEvents = vi.fn();
const mockGetLatestLedger = vi.fn();

vi.mock('@stellar/stellar-sdk', () => {
  class Server {
    getEvents = mockGetEvents;
    getLatestLedger = mockGetLatestLedger;
  }
  return {
    rpc: {
      Server,
    },
    scValToNative: (val: unknown) => {
      if (val && typeof val === 'object' && '__native' in (val as Record<string, unknown>)) {
        return (val as Record<string, unknown>).__native;
      }
      return val;
    },
  };
});

import { startEventListener, stopEventListener } from './eventListener.js';

function makeEvent(type: string, value: unknown, ledger = 10) {
  return {
    type,
    ledger,
    txHash: 'txhash',
    contractId: 'C_CONTRACT',
    topic: [{ __native: type }],
    value: { __native: value },
  };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

describe('eventListener', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
    mockQuery.mockReset();
    mockGetEvents.mockReset();
    mockGetLatestLedger.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();

    mockQuery.mockResolvedValue({ rows: [] });
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 });
    mockGetEvents.mockResolvedValue({ events: [], latestLedger: 100 });
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockReturnValue(undefined);
    mockMkdirSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    stopEventListener();
    vi.useRealTimers();
  });

  describe('checkpointing', () => {
    it('writes lastLedger=1 and skips RPC on first poll with no tracker file', async () => {
      mockExistsSync.mockReturnValue(false);

      startEventListener();
      await flush();

      expect(mockWriteFileSync).toHaveBeenCalled();
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.lastLedger).toBe(1);
      expect(mockGetEvents).not.toHaveBeenCalled();
    });

    it('saves tracker to maxLedger+1 after processing events', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ lastLedger: 5 }));
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('register', { __native: 'GABC' }, 20)],
        latestLedger: 20,
      });

      startEventListener();
      await flush();

      const lastCall = mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1];
      const written = JSON.parse(lastCall[1] as string);
      expect(written.lastLedger).toBe(21);
    });

    it('leaves checkpoint unchanged on empty event list', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ lastLedger: 5 }));
      mockGetEvents.mockResolvedValue({ events: [], latestLedger: 5 });

      startEventListener();
      await flush();

      const lastCall = mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1];
      const written = JSON.parse(lastCall[1] as string);
      expect(written.lastLedger).toBe(5);
    });
  });

  describe('event handling', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ lastLedger: 5 }));
    });

    it('register updates onchainStatus when resource exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'res-1' }] });
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('register', { __native: 'GABC' }, 10)],
        latestLedger: 10,
      });

      startEventListener();
      await flush();

      const updateCall = mockQuery.mock.calls.find((c) =>
        String(c[0]).toLowerCase().includes('update'),
      );
      expect(updateCall).toBeDefined();
    });

    it('register is a no-op when resource is missing', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('register', { __native: 'GABC' }, 10)],
        latestLedger: 10,
      });

      startEventListener();
      await flush();

      const updateCall = mockQuery.mock.calls.find((c) =>
        String(c[0]).toLowerCase().includes('update'),
      );
      expect(updateCall).toBeUndefined();
    });

    it('setprice converts i128 value to USDC decimal and writes', async () => {
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('setprice', { __native: '10000000' }, 10)],
        latestLedger: 10,
      });

      startEventListener();
      await flush();

      const updateCall = mockQuery.mock.calls.find((c) =>
        String(c[0]).toLowerCase().includes('update'),
      );
      expect(updateCall).toBeDefined();
      const params = updateCall![1] as unknown[];
      expect(params).toContain(10);
    });

    it('transfer updates walletAddress', async () => {
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('transfer', { __native: 'GNEWWALLET' }, 10)],
        latestLedger: 10,
      });

      startEventListener();
      await flush();

      const updateCall = mockQuery.mock.calls.find((c) =>
        String(c[0]).toLowerCase().includes('update'),
      );
      expect(updateCall).toBeDefined();
      const params = updateCall![1] as unknown[];
      expect(params).toContain('GNEWWALLET');
    });

    it('setlisted true updates listed', async () => {
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('setlisted', { __native: true }, 10)],
        latestLedger: 10,
      });

      startEventListener();
      await flush();

      const updateCall = mockQuery.mock.calls.find((c) =>
        String(c[0]).toLowerCase().includes('update'),
      );
      expect(updateCall).toBeDefined();
      const params = updateCall![1] as unknown[];
      expect(params).toContain(true);
    });

    it('setlisted false updates listed', async () => {
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('setlisted', { __native: false }, 10)],
        latestLedger: 10,
      });

      startEventListener();
      await flush();

      const updateCall = mockQuery.mock.calls.find((c) =>
        String(c[0]).toLowerCase().includes('update'),
      );
      expect(updateCall).toBeDefined();
      const params = updateCall![1] as unknown[];
      expect(params).toContain(false);
    });

    it('updmeta does not write to DB', async () => {
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('updmeta', { __native: 'meta' }, 10)],
        latestLedger: 10,
      });

      startEventListener();
      await flush();

      const updateCall = mockQuery.mock.calls.find((c) =>
        String(c[0]).toLowerCase().includes('update'),
      );
      expect(updateCall).toBeUndefined();
    });

    it('settags does not write to DB', async () => {
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('settags', { __native: ['a', 'b'] }, 10)],
        latestLedger: 10,
      });

      startEventListener();
      await flush();

      const updateCall = mockQuery.mock.calls.find((c) =>
        String(c[0]).toLowerCase().includes('update'),
      );
      expect(updateCall).toBeUndefined();
    });

    it('unknown type only logs debug', async () => {
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('unknowntype', { __native: 'x' }, 10)],
        latestLedger: 10,
      });

      startEventListener();
      await flush();

      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalled();
    });
  });

  describe('error recovery', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ lastLedger: 5 }));
    });

    it('a throwing handler is logged and does not stop subsequent events', async () => {
      mockQuery
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ rows: [] });
      mockGetEvents.mockResolvedValue({
        events: [
          makeEvent('setprice', { __native: '10000000' }, 10),
          makeEvent('transfer', { __native: 'GNEWWALLET' }, 11),
        ],
        latestLedger: 11,
      });

      startEventListener();
      await flush();

      expect(mockLogger.error).toHaveBeenCalled();
      const updateCalls = mockQuery.mock.calls.filter((c) =>
        String(c[0]).toLowerCase().includes('update'),
      );
      expect(updateCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('a throwing getEvents is caught and logged', async () => {
      mockGetEvents.mockRejectedValue(new Error('rpc down'));

      startEventListener();
      await flush();

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('a corrupt tracker file falls back to 0', async () => {
      mockReadFileSync.mockReturnValue('not-json{');

      startEventListener();
      await flush();

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockGetEvents).toHaveBeenCalled();
      const call = mockGetEvents.mock.calls[0][0] as { startLedger: number };
      expect(call.startLedger).toBe(0);
    });

    it('a write failure is logged without throwing', async () => {
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });
      mockGetEvents.mockResolvedValue({
        events: [makeEvent('register', { __native: 'GABC' }, 10)],
        latestLedger: 10,
      });

      expect(() => startEventListener()).not.toThrow();
      await flush();

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});