import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db/client.js', () => {
  const select = vi.fn();
  const from = vi.fn();
  const where = vi.fn();
  const orderBy = vi.fn();
  const limit = vi.fn();
  const offset = vi.fn();
  const chain: any = {};
  chain.select = select;
  chain.from = from;
  chain.where = where;
  chain.orderBy = orderBy;
  chain.limit = limit;
  chain.offset = offset;
  select.mockReturnValue(chain);
  from.mockReturnValue(chain);
  where.mockReturnValue(chain);
  orderBy.mockReturnValue(chain);
  limit.mockReturnValue(chain);
  offset.mockReturnValue(chain);
  return {
    db: {
      select,
      from,
      where,
      orderBy,
      limit,
      offset,
    },
  };
});

vi.mock('../services/resourceService.js', () => ({
  adminDelistResource: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import * as dbClient from '../db/client.js';
import * as resourceService from '../services/resourceService.js';

const ORIGINAL_ENV = { ...process.env };

async function buildApp() {
  const { default: adminRouter } = await import('./admin.js');
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  // Mirror src/middleware/errorHandler.ts: map AppError to status code.
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    res.status(status).json({ error: err?.message ?? 'Internal Server Error' });
  });
  return app;
}

describe('admin routes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('auth check', () => {
    it('returns 401 when X-Admin-Key header is missing', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';
      const app = await buildApp();
      const res = await request(app).get('/admin/stats');
      expect(res.status).toBe(401);
    });

    it('returns 401 when X-Admin-Key is wrong', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';
      const app = await buildApp();
      const res = await request(app)
        .get('/admin/stats')
        .set('X-Admin-Key', 'wrong-key');
      expect(res.status).toBe(401);
    });

    it('returns 401 when ADMIN_API_KEY is unset', async () => {
      delete process.env.ADMIN_API_KEY;
      const app = await buildApp();
      const res = await request(app)
        .get('/admin/stats')
        .set('X-Admin-Key', 'anything');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/stats', () => {
    it('returns counts from the db plus uptime and timestamp', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';

      const db = dbClient.db as any;
      // Each select chain resolves to a count row.
      db.select.mockImplementation(() => {
        const chain: any = {};
        chain.from = vi.fn().mockResolvedValue([{ count: 7 }]);
        return chain;
      });

      const app = await buildApp();
      const res = await request(app)
        .get('/admin/stats')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('uptime');
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body).toHaveProperty('timestamp');
      expect(typeof res.body.timestamp).toBe('string');
      expect(res.body.counts).toBeDefined();
    });
  });

  describe('POST /admin/delist/:id', () => {
    it('returns success when adminDelistResource resolves', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';
      (resourceService.adminDelistResource as any).mockResolvedValue({
        id: 'res-1',
        delisted: true,
      });

      const app = await buildApp();
      const res = await request(app)
        .post('/admin/delist/res-1')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(200);
      expect(resourceService.adminDelistResource).toHaveBeenCalledWith('res-1');
    });

    it('returns 404 when adminDelistResource resolves null', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';
      (resourceService.adminDelistResource as any).mockResolvedValue(null);

      const app = await buildApp();
      const res = await request(app)
        .post('/admin/delist/missing')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/audit', () => {
    it('returns paginated entries', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';

      const db = dbClient.db as any;
      const entries = [
        { id: 'a1', action: 'delist', createdAt: new Date().toISOString() },
        { id: 'a2', action: 'delist', createdAt: new Date().toISOString() },
      ];
      const offsetMock = vi.fn().mockResolvedValue(entries);
      const limitMock = vi.fn().mockReturnValue({ offset: offsetMock });
      const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
      const fromMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
      db.select.mockReturnValue({ from: fromMock });

      const app = await buildApp();
      const res = await request(app)
        .get('/admin/audit')
        .set('X-Admin-Key', 'secret-key');

      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual(entries);
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('limit');
    });

    it('clamps limit to [1,200] and page to >=1', async () => {
      process.env.ADMIN_API_KEY = 'secret-key';

      const db = dbClient.db as any;
      const offsetMock = vi.fn().mockResolvedValue([]);
      const limitMock = vi.fn().mockReturnValue({ offset: offsetMock });
      const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
      const fromMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
      db.select.mockReturnValue({ from: fromMock });

      const app = await buildApp();

      // limit too high, page too low
      await request(app)
        .get('/admin/audit?limit=9999&page=0')
        .set('X-Admin-Key', 'secret-key');

      expect(limitMock).toHaveBeenLastCalledWith(200);
      expect(offsetMock).toHaveBeenLastCalledWith(0);

      // limit too low, page valid
      await request(app)
        .get('/admin/audit?limit=0&page=3')
        .set('X-Admin-Key', 'secret-key');

      expect(limitMock).toHaveBeenLastCalledWith(1);
      expect(offsetMock).toHaveBeenLastCalledWith(2);
    });
  });
});