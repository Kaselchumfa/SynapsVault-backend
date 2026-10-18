import "dotenv/config";
import { z } from "zod/v4";
import { StrKey } from "@stellar/stellar-sdk";
// Inlined from @synapsvault/registry-client (local package — avoids runtime resolution issues)
type StellarDeploymentNetwork = "testnet" | "mainnet";

const NETWORK_PRESETS = {
  testnet: {
    x402Network: "stellar:testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    usdcSacContractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  },
  mainnet: {
    x402Network: "stellar:pubnet",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    sorobanRpcUrl: "https://soroban.stellar.org",
    horizonUrl: "https://horizon.stellar.org",
    usdcSacContractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  },
} as const;

function resolveStellarNetwork(value: string | undefined): StellarDeploymentNetwork {
  const v = (value ?? "testnet").trim().toLowerCase();
  return v === "mainnet" || v === "pubnet" || v === "public" ? "mainnet" : "testnet";
}

function cleanEnvValue(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(["'])(.*)\1$/s);
  return (quoted ? quoted[2]! : trimmed).trim();
}

/** Public URLs commonly entered without a scheme (e.g. "app.vercel.app"). */
const SCHEME_DEFAULTED_URLS = ["WEB_APP_URL", "BASE_URL", "SUPABASE_URL", "SOROBAN_RPC_URL"] as const;

const stellarSecret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .refine(StrKey.isValidEd25519SecretSeed, `${name} must be a Stellar secret key (starts with S, 56 chars)`);

const stellarAccount = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .refine(StrKey.isValidEd25519PublicKey, `${name} must be a Stellar public key (starts with G, 56 chars)`);

const stellarContract = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .refine(StrKey.isValidContract, `${name} must be a Soroban contract id (starts with C, 56 chars)`);

const httpUrl = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .refine((v) => /^https?:\/\//i.test(v) && URL.canParse(v), `${name} must be an http(s) URL`);

function applyNetworkEnvDefaults(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Hosting dashboards (Railway, Vercel) make it easy to save a variable with
  // an empty value; treat those as unset so defaults apply and optional URL
  // fields (REDIS_URL, SENTRY_DSN) don't fail validation and crash the boot.
  // Values pasted with surrounding quotes or whitespace are cleaned up too.
  const env = Object.fromEntries(
    Object.entries(rawEnv)
      .map(([key, value]) => [key, value === undefined ? value : cleanEnvValue(value)] as const)
      .filter(([, value]) => value !== ""),
  ) as NodeJS.ProcessEnv;
  for (const key of SCHEME_DEFAULTED_URLS) {
    const value = env[key];
    if (value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) env[key] = `https://${value}`;
  }
  const network = resolveStellarNetwork(env.STELLAR_NETWORK);
  const preset = NETWORK_PRESETS[network];
  return {
    ...env,
    STELLAR_NETWORK: network,
    NETWORK: env.NETWORK ?? preset.x402Network,
    SOROBAN_RPC_URL: env.SOROBAN_RPC_URL ?? preset.sorobanRpcUrl,
    USDC_CONTRACT_ID: env.USDC_CONTRACT_ID ?? preset.usdcSacContractId,
    // Accept Supabase's own name for the key (used by docker-compose and CI).
    SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
    // Both names refer to the same vault-registry contract; accept either.
    REGISTRY_CONTRACT_ID: env.REGISTRY_CONTRACT_ID ?? env.VAULT_REGISTRY_CONTRACT_ID,
    VAULT_REGISTRY_CONTRACT_ID: env.VAULT_REGISTRY_CONTRACT_ID ?? env.REGISTRY_CONTRACT_ID,
  };
}

interface NetworkValidationIssue {
  field: string;
  message: string;
}

function inferNetworkFromX402(network: string): StellarDeploymentNetwork | undefined {
  const normalized = network.trim();
  if (normalized === "stellar:testnet") return "testnet";
  if (normalized === "stellar:pubnet" || normalized === "stellar:mainnet") return "mainnet";
  return undefined;
}

function inferNetworkFromRpcUrl(rpcUrl: string): StellarDeploymentNetwork | undefined {
  try {
    const host = new URL(rpcUrl).hostname.toLowerCase();
    if (host.includes("testnet")) return "testnet";
    if (host === "soroban.stellar.org" || host === "mainnet.sorobanrpc.com") return "mainnet";
  } catch {
    // invalid URL — reported below
  }
  return undefined;
}

/**
 * Catches cross-network misconfiguration (e.g. mainnet x402 network with a
 * testnet RPC). Custom RPC hosts whose network can't be inferred are allowed.
 */
function validateNetworkConfig(input: {
  stellarNetwork: StellarDeploymentNetwork;
  x402Network: string;
  sorobanRpcUrl: string;
}): NetworkValidationIssue[] {
  const issues: NetworkValidationIssue[] = [];

  const x402Network = inferNetworkFromX402(input.x402Network);
  if (!x402Network) {
    issues.push({
      field: "NETWORK",
      message: `Unsupported x402 network "${input.x402Network}". Use stellar:testnet or stellar:pubnet.`,
    });
  } else if (x402Network !== input.stellarNetwork) {
    issues.push({
      field: "NETWORK",
      message: `NETWORK=${input.x402Network} does not match STELLAR_NETWORK=${input.stellarNetwork}.`,
    });
  }

  if (!URL.canParse(input.sorobanRpcUrl)) {
    issues.push({ field: "SOROBAN_RPC_URL", message: "SOROBAN_RPC_URL is not a valid URL." });
  } else {
    const rpcNetwork = inferNetworkFromRpcUrl(input.sorobanRpcUrl);
    if (rpcNetwork && rpcNetwork !== input.stellarNetwork) {
      issues.push({
        field: "SOROBAN_RPC_URL",
        message: `SOROBAN_RPC_URL points to ${rpcNetwork} but STELLAR_NETWORK=${input.stellarNetwork}.`,
      });
    }
  }

  return issues;
}

/** Parses "true"/"false"/"1"/"0" env flags (z.coerce.boolean treats "false" as true). */
const envFlag = (defaultValue: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? defaultValue : v === "true" || v === "1" || v === "yes"));
import { rootLogger } from "./lib/logger.js";

const envWithDefaults = applyNetworkEnvDefaults(process.env);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4021),
  TRUST_PROXY: z.coerce.number().int().nonnegative().optional(),
  BASE_URL: z.string().default("http://localhost:4021"),
  WEB_APP_URL: z.string().url().or(z.literal("")).default("http://localhost:5173"),
  ALLOWED_ORIGINS: z.string().optional(),

  // Stellar / x402 — STELLAR_NETWORK selects preset defaults; individual vars may override.
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NETWORK: z.string().min(1),
  FACILITATOR_URL: z.string().default("https://www.x402.org/facilitator"),
  PAY_TO: stellarAccount("PAY_TO (platform wallet address)"),
  AGENT_SECRET_KEY: stellarSecret("AGENT_SECRET_KEY (platform agent secret)"),
  USDC_CONTRACT_ID: z.string().min(1),

  // Soroban / vault-registry
  SOROBAN_RPC_URL: z.string().min(1, "SOROBAN_RPC_URL is required"),
  VAULT_REGISTRY_CONTRACT_ID: stellarContract("VAULT_REGISTRY_CONTRACT_ID / REGISTRY_CONTRACT_ID"),

  // OpenRouter
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_MODEL: z.string().default("anthropic/claude-sonnet-4"),

  // Supabase
  DATABASE_URL: z
    .string({ error: "DATABASE_URL (Postgres connection string) is required" })
    .refine(
      (v) => /^postgres(ql)?:\/\//i.test(v) && URL.canParse(v),
      "DATABASE_URL must be a postgres:// or postgresql:// URL (URL-encode special characters in the password)",
    ),
  SUPABASE_URL: httpUrl("SUPABASE_URL"),
  SUPABASE_SERVICE_KEY: z.string().min(1, "SUPABASE_SERVICE_KEY is required"),
  SUPABASE_STORAGE_BUCKET: z.string().default("resources"),

  // Limits
  MAX_FILE_SIZE_MB: z.coerce.number().default(50),
  // Explicit JSON body limit for express.json() (e.g. "1mb", "512kb").
  MAX_JSON_BODY_SIZE: z.string().default("1mb"),
  // Comma-separated allowlist of accepted upload content types (#87).
  ALLOWED_UPLOAD_MIME_TYPES: z
    .string()
    .default(
      "application/pdf,image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,application/json,application/zip,video/mp4,audio/mpeg",
    ),

  // Soroban registry
  REGISTRY_CONTRACT_ID: stellarContract("REGISTRY_CONTRACT_ID / VAULT_REGISTRY_CONTRACT_ID"),
  REGISTRY_SECRET_KEY: stellarSecret("REGISTRY_SECRET_KEY (deployer / owner secret)"),

  // Metrics endpoint token — if set, requests to /metrics must supply it via
  // Bearer auth. If unset, the endpoint is disabled.
  METRICS_TOKEN: z.string().optional(),

  // Sentry error tracking — when DSN is set, unhandled errors are reported.
  SENTRY_DSN: z.string().url().optional().or(z.literal("")),

  // Verification
  VERIFICATION_PRICE: z.string().default("0.10"),
  // OpenRouter token pricing (USD per 1M tokens) used to estimate the cost of
  // each verification (#283). Defaults track anthropic/claude-sonnet-4 list
  // pricing; override per model if you change OPENROUTER_MODEL.
  VERIFICATION_PROMPT_COST_PER_1M: z.coerce.number().nonnegative().default(3),
  VERIFICATION_COMPLETION_COST_PER_1M: z.coerce.number().nonnegative().default(15),

  // Rate limiting (verify-content + publish)
  RATE_LIMIT_VERIFY_IP_MAX: z.coerce.number().default(10),
  RATE_LIMIT_VERIFY_IP_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_VERIFY_WALLET_MAX: z.coerce.number().default(5),
  RATE_LIMIT_VERIFY_WALLET_WINDOW_MS: z.coerce.number().default(3_600_000),
  RATE_LIMIT_PUBLISH_IP_MAX: z.coerce.number().default(20),
  RATE_LIMIT_PUBLISH_IP_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_PUBLISH_WALLET_MAX: z.coerce.number().default(10),
  RATE_LIMIT_PUBLISH_WALLET_WINDOW_MS: z.coerce.number().default(3_600_000),

  // Publisher rate limiting defaults (per publisher, requests per minute).
  PUBLISHER_RATE_LIMIT_RPM_DEFAULT: z.coerce.number().default(60),
  PUBLISHER_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  PUBLISHER_RATE_LIMIT_MAX_RPM: z.coerce.number().default(10_000),

  // Webhook delivery
  WEBHOOK_TIMEOUT_MS: z.coerce.number().default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().default(3),

  // Retry worker (#85): max items processed per tick and per-item timeout so a
  // slow RPC can't make a tick run into the next one.
  RETRY_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).default(25),
  RETRY_WORKER_ITEM_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),

  // Optional Redis URL for a shared sliding-window rate-limit store (multi-instance).
  REDIS_URL: z.string().url().optional(),

  // Background workers (event listener + retry worker). When multiple replicas
  // run, only one should execute them: either set WORKERS_ENABLED=false on all
  // but one instance, or leave it true everywhere and let the Postgres advisory
  // lock (WORKER_LEADER_LOCK_ID) elect a single leader.
  WORKERS_ENABLED: envFlag(true),
  // Advisory lock key used to elect the single worker leader across replicas.
  WORKER_LEADER_LOCK_ID: z.coerce.number().int().default(4_021_001),

  // Optional HMAC-SHA256 request signatures for publisher mutations (off by default).
  REQUIRE_REQUEST_SIGNATURE: envFlag(false),
  // Legacy register flow where the server signs with the platform registry key
  // on the creator's behalf (#80). Off by default; clients must send signedXdr.
  ALLOW_LEGACY_REGISTER: envFlag(false),
  // Max clock skew for X-Timestamp when signatures are required (default 5 minutes).
  SIGNATURE_MAX_SKEW_MS: z.coerce.number().default(300_000),

  // Per-request timeout — slow upstreams (RPC, facilitator) return 503 instead
  // of hanging the connection.
  REQUEST_TIMEOUT_MS: z.coerce.number().default(30_000),
  // Max time to drain in-flight requests on SIGTERM/SIGINT before forcing exit.
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().default(10_000),
  // How long a publish Idempotency-Key is remembered so retries return the
  // original result instead of creating a duplicate (default 24h).
  IDEMPOTENCY_TTL_MS: z.coerce.number().default(86_400_000),
  // Short-lived cache for catalog/preview reads to cut DB load. Kept low so
  // newly published/delisted resources surface quickly.
  CATALOG_CACHE_TTL_MS: z.coerce.number().default(10_000),
  // Max distinct filter/sort/pagination combinations cached for the catalog
  // (#316). Bounds key cardinality; oldest entries are evicted (FIFO).
  CATALOG_CACHE_MAX_KEYS: z.coerce.number().int().min(1).default(200),

  // Postgres connection pool tuning.
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  DB_POOL_CONNECT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(10_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
});

const parsed = envSchema.safeParse(envWithDefaults);

if (!parsed.success) {
  rootLogger.error(
    { event: "config_invalid", issues: parsed.error.format() },
    "invalid environment variables",
  );
  // Plain-text summary so the offending variables are obvious in host logs.
  for (const issue of parsed.error.issues) {
    console.error(`[config] ${issue.path.join(".") || "(env)"}: ${issue.message}`);
  }
  process.exit(1);
}

const stellarNetwork = resolveStellarNetwork(parsed.data.STELLAR_NETWORK);
const networkIssues = validateNetworkConfig({
  stellarNetwork,
  x402Network: parsed.data.NETWORK,
  sorobanRpcUrl: parsed.data.SOROBAN_RPC_URL,
});

if (networkIssues.length > 0) {
  rootLogger.error(
    { event: "config_network_mismatch", issues: networkIssues },
    "inconsistent Stellar network configuration",
  );
  for (const issue of networkIssues) {
    console.error(`[config] ${issue.field}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;