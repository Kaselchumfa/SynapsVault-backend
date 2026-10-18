import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envSchema, CONFIG_KEYS } from './config.js';

/**
 * Keys that are intentionally present in `.env.example` but are not validated
 * by the zod `envSchema`. These are documented extras (e.g. consumed by other
 * tooling or reserved for future use).
 */
const ALLOWED_NON_VALIDATED_EXTRAS: string[] = [];

function parseExampleKeys(content: string): string[] {
  const keys: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) {
      keys.push(match[1]);
    }
  }
  return keys;
}

type EnvSnapshot = Record<string, string | undefined>;

const MANAGED_KEYS = [
  'NODE_ENV',
  'PORT',
  'BASE_URL',
  'STELLAR_NETWORK',
  'NETWORK',
  'SOROBAN_RPC_URL',
  'USDC_CONTRACT_ID',
  'MAX_FILE_SIZE_MB',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX_REQUESTS',
  'REQUIRE_REQUEST_SIGNATURE',
  'PAY_TO',
  'AGENT_SECRET_KEY',
  'REGISTRY_SECRET_KEY',
  'REGISTRY_CONTRACT_ID',
  'VAULT_REGISTRY_CONTRACT_ID',
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENROUTER_API_KEY',
];

const VALID_STELLAR_SECRET = 'S' + 'A'.repeat(55);
const VALID_STELLAR_PUBLIC = 'G' + 'A'.repeat(55);
const VALID_CONTRACT_ID = 'C' + 'A'.repeat(55);

let savedEnv: EnvSnapshot;

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const key of MANAGED_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of MANAGED_KEYS) {
    const value = snap[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearManagedEnv(): void {
  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }
}

function setEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function baseValidEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    PAY_TO: VALID_STELLAR_PUBLIC,
    AGENT_SECRET_KEY: VALID_STELLAR_SECRET,
    REGISTRY_SECRET_KEY: VALID_STELLAR_SECRET,
    REGISTRY_CONTRACT_ID: VALID_CONTRACT_ID,
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_KEY: 'service-key',
    OPENROUTER_API_KEY: 'openrouter-key',
    ...overrides,
  };
}

async function loadConfig(): Promise<typeof import('./config.js')> {
  vi.resetModules();
  return import('./config.js');
}

async function loadConfigExpectingFailure(): Promise<{ message: string; exitCode: number | undefined }> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__EXIT__:${code ?? 0}`);
  }) as never);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  let message = '';
  let exitCode: number | undefined;

  try {
    await loadConfig();
    throw new Error('Expected config load to fail, but it succeeded');
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (errMessage.startsWith('__EXIT__:')) {
      exitCode = Number(errMessage.split(':')[1]);
      message = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    } else {
      message = errMessage;
    }
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }

  return { message, exitCode };
}

beforeEach(() => {
  savedEnv = snapshotEnv();
  clearManagedEnv();
});

afterEach(() => {
  restoreEnv(savedEnv);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('.env.example', () => {
  const examplePath = resolve(process.cwd(), '.env.example');
  const exampleContent = readFileSync(examplePath, 'utf8');
  const exampleKeys = parseExampleKeys(exampleContent);
  const schemaKeys = Object.keys(envSchema.shape);

  it('exports a CONFIG_KEYS array matching the schema shape', () => {
    expect([...CONFIG_KEYS].sort()).toEqual([...schemaKeys].sort());
  });

  it('includes every config schema key', () => {
    const missing = schemaKeys.filter((key) => !exampleKeys.includes(key));
    expect(missing, `Missing keys in .env.example: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not include keys absent from the schema (unless explicitly allowed)', () => {
    const allowed = new Set([...schemaKeys, ...ALLOWED_NON_VALIDATED_EXTRAS]);
    const unexpected = exampleKeys.filter((key) => !allowed.has(key));
    expect(
      unexpected,
      `Unexpected keys in .env.example not in schema: ${unexpected.join(', ')}`,
    ).toEqual([]);
  });

  it('does not contain duplicate keys', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const key of exampleKeys) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates, `Duplicate keys in .env.example: ${duplicates.join(', ')}`).toEqual([]);
  });
});

describe('config defaults', () => {
  it('applies default PORT, BASE_URL, STELLAR_NETWORK and MAX_FILE_SIZE_MB', async () => {
    setEnv(baseValidEnv());
    const { config } = await loadConfig();

    expect(config.PORT).toBe(3000);
    expect(config.BASE_URL).toBe('http://localhost:3000');
    expect(config.STELLAR_NETWORK).toBe('testnet');
    expect(config.MAX_FILE_SIZE_MB).toBe(10);
  });

  it('applies default rate-limit settings', async () => {
    setEnv(baseValidEnv());
    const { config } = await loadConfig();

    expect(config.RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
    expect(config.RATE_LIMIT_MAX_REQUESTS).toBeGreaterThan(0);
  });

  it('applies testnet presets for NETWORK, SOROBAN_RPC_URL and USDC_CONTRACT_ID', async () => {
    setEnv(baseValidEnv({ STELLAR_NETWORK: 'testnet' }));
    const { config } = await loadConfig();

    expect(config.NETWORK).toBe('testnet');
    expect(config.SOROBAN_RPC_URL).toContain('testnet');
    expect(config.USDC_CONTRACT_ID).toBeTruthy();
  });

  it('applies mainnet presets for NETWORK, SOROBAN_RPC_URL and USDC_CONTRACT_ID', async () => {
    setEnv(baseValidEnv({ STELLAR_NETWORK: 'mainnet' }));
    const { config } = await loadConfig();

    expect(config.NETWORK).toBe('mainnet');
    expect(config.SOROBAN_RPC_URL).toContain('mainnet');
    expect(config.USDC_CONTRACT_ID).toBeTruthy();
  });

  it('respects explicit overrides for defaults', async () => {
    setEnv(
      baseValidEnv({
        PORT: '8080',
        BASE_URL: 'https://api.example.com',
        MAX_FILE_SIZE_MB: '25',
        RATE_LIMIT_WINDOW_MS: '60000',
        RATE_LIMIT_MAX_REQUESTS: '42',
      }),
    );
    const { config } = await loadConfig();

    expect(config.PORT).toBe(8080);
    expect(config.BASE_URL).toBe('https://api.example.com');
    expect(config.MAX_FILE_SIZE_MB).toBe(25);
    expect(config.RATE_LIMIT_WINDOW_MS).toBe(60000);
    expect(config.RATE_LIMIT_MAX_REQUESTS).toBe(42);
  });
});

describe('envFlag parsing for REQUIRE_REQUEST_SIGNATURE', () => {
  const truthy = ['true', '1', 'yes'];
  const falsy = ['false', '0', 'no', ''];

  it.each(truthy)('parses %s as true', async (value) => {
    setEnv(baseValidEnv({ REQUIRE_REQUEST_SIGNATURE: value }));
    const { config } = await loadConfig();
    expect(config.REQUIRE_REQUEST_SIGNATURE).toBe(true);
  });

  it.each(falsy)('parses %s as false', async (value) => {
    setEnv(baseValidEnv({ REQUIRE_REQUEST_SIGNATURE: value }));
    const { config } = await loadConfig();
    expect(config.REQUIRE_REQUEST_SIGNATURE).toBe(false);
  });

  it('defaults to false when unset', async () => {
    setEnv(baseValidEnv());
    const { config } = await loadConfig();
    expect(config.REQUIRE_REQUEST_SIGNATURE).toBe(false);
  });
});

describe('required values', () => {
  const requiredFields: Array<[string, string]> = [
    ['PAY_TO', 'PAY_TO'],
    ['AGENT_SECRET_KEY', 'AGENT_SECRET_KEY'],
    ['REGISTRY_SECRET_KEY', 'REGISTRY_SECRET_KEY'],
    ['REGISTRY_CONTRACT_ID', 'REGISTRY_CONTRACT_ID'],
    ['DATABASE_URL', 'DATABASE_URL'],
    ['SUPABASE_URL', 'SUPABASE_URL'],
    ['SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_KEY'],
    ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  ];

  it.each(requiredFields)('fails with a readable message when %s is missing', async (field, expectedName) => {
    const env = baseValidEnv();
    delete env[field];
    setEnv(env);

    const { message } = await loadConfigExpectingFailure();
    expect(message.toLowerCase()).toContain(expectedName.toLowerCase());
  });

  it('fails when PAY_TO is not a valid Stellar public key', async () => {
    setEnv(baseValidEnv({ PAY_TO: 'not-a-valid-key' }));
    const { message } = await loadConfigExpectingFailure();
    expect(message.toLowerCase()).toContain('pay_to');
  });

  it('fails when AGENT_SECRET_KEY is not a valid Stellar secret key', async () => {
    setEnv(baseValidEnv({ AGENT_SECRET_KEY: 'not-a-valid-secret' }));
    const { message } = await loadConfigExpectingFailure();
    expect(message.toLowerCase()).toContain('agent_secret_key');
  });

  it('fails when REGISTRY_SECRET_KEY is not a valid Stellar secret key', async () => {
    setEnv(baseValidEnv({ REGISTRY_SECRET_KEY: 'not-a-valid-secret' }));
    const { message } = await loadConfigExpectingFailure();
    expect(message.toLowerCase()).toContain('registry_secret_key');
  });

  it('fails when REGISTRY_CONTRACT_ID is not a valid contract id', async () => {
    setEnv(baseValidEnv({ REGISTRY_CONTRACT_ID: 'not-a-contract' }));
    const { message } = await loadConfigExpectingFailure();
    expect(message.toLowerCase()).toContain('registry_contract_id');
  });

  it('fails when DATABASE_URL is not a postgres URL', async () => {
    setEnv(baseValidEnv({ DATABASE_URL: 'mysql://user:pass@localhost:3306/db' }));
    const { message } = await loadConfigExpectingFailure();
    expect(message.toLowerCase()).toContain('database_url');
  });
});

describe('network checks', () => {
  it('reports an issue when NETWORK mismatches STELLAR_NETWORK', async () => {
    setEnv(baseValidEnv({ STELLAR_NETWORK: 'testnet', NETWORK: 'mainnet' }));
    const { message } = await loadConfigExpectingFailure();
    expect(message.toLowerCase()).toContain('network');
  });

  it('reports an issue when SOROBAN_RPC_URL points at the wrong network', async () => {
    setEnv(
      baseValidEnv({
        STELLAR_NETWORK: 'testnet',
        SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      }),
    );
    const { message } = await loadConfigExpectingFailure();
    expect(message.toLowerCase()).toContain('soroban_rpc_url');
  });

  it('fails for an unsupported NETWORK value', async () => {
    setEnv(baseValidEnv({ NETWORK: 'futurenet' }));
    const { message } = await loadConfigExpectingFailure();
    expect(message.toLowerCase()).toContain('network');
  });

  it('allows custom RPC hosts', async () => {
    setEnv(
      baseValidEnv({
        STELLAR_NETWORK: 'testnet',
        NETWORK: 'testnet',
        SOROBAN_RPC_URL: 'https://rpc.example.com',
      }),
    );
    const { config } = await loadConfig();
    expect(config.SOROBAN_RPC_URL).toBe('https://rpc.example.com');
  });
});

describe('production-only checks', () => {
  it('loads successfully in test environment with valid config', async () => {
    setEnv(baseValidEnv({ NODE_ENV: 'test' }));
    const { config } = await loadConfig();
    expect(config).toBeDefined();
  });

  it('applies production-specific validation when NODE_ENV=production', async () => {
    setEnv(baseValidEnv({ NODE_ENV: 'production' }));
    const { config } = await loadConfig();
    expect(config).toBeDefined();
  });

  it('fails in production when production-only requirements are not met', async () => {
    setEnv(
      baseValidEnv({
        NODE_ENV: 'production',
        BASE_URL: 'http://localhost:3000',
      }),
    );
    const { message, exitCode } = await loadConfigExpectingFailure();
    expect(message.length).toBeGreaterThan(0);
    expect(exitCode).toBeDefined();
  });
});

describe('applyNetworkEnvDefaults behaviors', () => {
  it('treats empty values as unset and applies defaults', async () => {
    setEnv(
      baseValidEnv({
        STELLAR_NETWORK: '',
        NETWORK: '',
        SOROBAN_RPC_URL: '',
        USDC_CONTRACT_ID: '',
      }),
    );
    const { config } = await loadConfig();

    expect(config.STELLAR_NETWORK).toBe('testnet');
    expect(config.NETWORK).toBe('testnet');
    expect(config.SOROBAN_RPC_URL).toBeTruthy();
    expect(config.USDC_CONTRACT_ID).toBeTruthy();
  });

  it('cleans quoted values', async () => {
    setEnv(
      baseValidEnv({
        BASE_URL: '"https://api.example.com"',
        SUPABASE_URL: "'https://example.supabase.co'",
      }),
    );
    const { config } = await loadConfig();

    expect(config.BASE_URL).toBe('https://api.example.com');
    expect(config.SUPABASE_URL).toBe('https://example.supabase.co');
  });

  it('prefixes scheme-less URLs with https://', async () => {
    setEnv(
      baseValidEnv({
        BASE_URL: 'api.example.com',
        SUPABASE_URL: 'example.supabase.co',
      }),
    );
    const { config } = await loadConfig();

    expect(config.BASE_URL).toBe('https://api.example.com');
    expect(config.SUPABASE_URL).toBe('https://example.supabase.co');
  });

  it('supports SUPABASE_SERVICE_ROLE_KEY alias for SUPABASE_SERVICE_KEY', async () => {
    const env = baseValidEnv();
    delete env.SUPABASE_SERVICE_KEY;
    setEnv({ ...env, SUPABASE_SERVICE_ROLE_KEY: 'role-key' });
    const { config } = await loadConfig();

    expect(config.SUPABASE_SERVICE_KEY).toBe('role-key');
  });

  it('supports VAULT_REGISTRY_CONTRACT_ID alias for REGISTRY_CONTRACT_ID', async () => {
    const env = baseValidEnv();
    delete env.REGISTRY_CONTRACT_ID;
    setEnv({ ...env, VAULT_REGISTRY_CONTRACT_ID: VALID_CONTRACT_ID });
    const { config } = await loadConfig();

    expect(config.REGISTRY_CONTRACT_ID).toBe(VALID_CONTRACT_ID);
  });
});