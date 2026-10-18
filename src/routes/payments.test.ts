import express from 'express';
import request from 'supertest';

jest.mock('../db', () => ({
  getPaymentById: jest.fn(),
  getPaymentsByBuyer: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  requireWalletSignature: jest.fn(),
  requirePublisherApiKey: jest.fn(),
}));

import * as db from '../db';
import { requireWalletSignature, requirePublisherApiKey } from '../middleware/auth';
import paymentsRouter from './payments';

const mockedDb = db as jest.Mocked<typeof db>;
const mockedRequireWalletSignature = requireWalletSignature as jest.Mock;
const mockedRequirePublisherApiKey = requirePublisherApiKey as jest.Mock;

const PAYER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const PAYMENT_ID = 'pay_123';

const basePayment = {
  id: PAYMENT_ID,
  payer: PAYER,
  recipient: RECIPIENT,
  amount: '1000000',
  asset: 'USDC',
  status: 'completed',
  createdAt: '2024-01-01T00:00:00.000Z',
  txHash: '0xabc',
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/payments', paymentsRouter);
  return app;
}

function walletAuthAs(address: string) {
  mockedRequireWalletSignature.mockImplementation((req: any, _res: any, next: any) => {
    req.walletAddress = address;
    next();
  });
}

function walletAuthMissing() {
  mockedRequireWalletSignature.mockImplementation((_req: any, res: any) => {
    res.status(401).json({ error: 'Missing or invalid wallet signature' });
  });
}

function walletAuthInvalid() {
  mockedRequireWalletSignature.mockImplementation((_req: any, res: any) => {
    res.status(401).json({ error: 'Missing or invalid wallet signature' });
  });
}

function publisherAuthAs(address: string) {
  mockedRequirePublisherApiKey.mockImplementation((req: any, _res: any, next: any) => {
    req.publisherAddress = address;
    next();
  });
}

function publisherAuthMissing() {
  mockedRequirePublisherApiKey.mockImplementation((_req: any, res: any) => {
    res.status(401).json({ error: 'Missing or invalid API key' });
  });
}

describe('GET /payments/:id/receipt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the receipt for the payer with a valid wallet signature', async () => {
    walletAuthAs(PAYER);
    mockedDb.getPaymentById.mockResolvedValue(basePayment as any);

    const res = await request(createApp()).get(`/payments/${PAYMENT_ID}/receipt`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: PAYMENT_ID,
      payer: PAYER,
      recipient: RECIPIENT,
      amount: '1000000',
      asset: 'USDC',
      status: 'completed',
    });
    expect(mockedDb.getPaymentById).toHaveBeenCalledWith(PAYMENT_ID);
  });

  it('returns the receipt for the recipient with a valid publisher API key', async () => {
    publisherAuthAs(RECIPIENT);
    mockedDb.getPaymentById.mockResolvedValue(basePayment as any);

    const res = await request(createApp())
      .get(`/payments/${PAYMENT_ID}/receipt`)
      .set('x-api-key', 'valid-key');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: PAYMENT_ID, recipient: RECIPIENT });
    expect(mockedDb.getPaymentById).toHaveBeenCalledWith(PAYMENT_ID);
  });

  it('returns 401 when no auth is provided', async () => {
    walletAuthMissing();
    publisherAuthMissing();

    const res = await request(createApp()).get(`/payments/${PAYMENT_ID}/receipt`);

    expect(res.status).toBe(401);
    expect(mockedDb.getPaymentById).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is neither the payer nor the recipient', async () => {
    walletAuthAs(OTHER);
    mockedDb.getPaymentById.mockResolvedValue(basePayment as any);

    const res = await request(createApp()).get(`/payments/${PAYMENT_ID}/receipt`);

    expect(res.status).toBe(403);
  });

  it('returns 404 when the payment does not exist', async () => {
    walletAuthAs(PAYER);
    mockedDb.getPaymentById.mockResolvedValue(null as any);

    const res = await request(createApp()).get(`/payments/unknown/receipt`);

    expect(res.status).toBe(404);
  });
});

describe('GET /buyers/:address/payments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns payment history for the buyer with a valid wallet signature', async () => {
    walletAuthAs(PAYER);
    mockedDb.getPaymentsByBuyer.mockResolvedValue([basePayment] as any);

    const res = await request(createApp()).get(`/buyers/${PAYER}/payments`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: PAYMENT_ID, payer: PAYER });
    expect(mockedDb.getPaymentsByBuyer).toHaveBeenCalledWith(PAYER);
  });

  it('returns 401 when the wallet signature is missing', async () => {
    walletAuthMissing();

    const res = await request(createApp()).get(`/buyers/${PAYER}/payments`);

    expect(res.status).toBe(401);
    expect(mockedDb.getPaymentsByBuyer).not.toHaveBeenCalled();
  });

  it('returns 401 when the wallet signature is invalid', async () => {
    walletAuthInvalid();

    const res = await request(createApp())
      .get(`/buyers/${PAYER}/payments`)
      .set('x-wallet-signature', 'invalid');

    expect(res.status).toBe(401);
    expect(mockedDb.getPaymentsByBuyer).not.toHaveBeenCalled();
  });
});