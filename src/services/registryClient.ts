import {
  Keypair,
  TransactionBuilder,
  xdr,
  Address,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  Client,
  Errors,
  listResources,
  networkPassphraseForX402,
  type Resource,
} from "../../packages/registry-client/dist/index.js";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";

const NETWORK_PASSPHRASE = networkPassphraseForX402(config.NETWORK);

/**
 * Thrown when a signed XDR does not match the operation the caller expects.
 * Callers should reject the request before broadcasting.
 */
export class SignedTxValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "SignedTxValidationError";
  }
}

export type ExpectedSignedTx = {
  /** Contract id the transaction must invoke. Defaults to the registry contract. */
  contractId?: string;
  /** Contract function name that must be invoked. */
  functionName: "register" | "set_price" | "transfer_ownership";
  /** Resource id that must be the first argument of the invocation. */
  resourceId: string;
  /** Stellar account (G...) that must be the transaction source. */
  owner: string;
};

/**
 * Decode a signed transaction envelope and assert it invokes exactly the
 * expected registry contract, function, resource id, and source account.
 * Throws SignedTxValidationError on any mismatch.
 */
export function validateSignedTx(signedXdr: string, expected: ExpectedSignedTx): void {
  const expectedContractId = expected.contractId ?? config.REGISTRY_CONTRACT_ID;

  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  } catch (err) {
    throw new SignedTxValidationError(
      `Malformed signed transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Source account must be the resource owner.
  const source = tx.source;
  if (source !== expected.owner) {
    throw new SignedTxValidationError(
      `Transaction source account ${source} does not match resource owner ${expected.owner}`,
    );
  }

  // Must contain exactly one operation.
  const operations = tx.operations;
  if (operations.length !== 1) {
    throw new SignedTxValidationError(
      `Expected exactly one operation, found ${operations.length}`,
    );
  }

  const op = operations[0];
  if (op.type !== "invokeHostFunction") {
    throw new SignedTxValidationError(
      `Expected invokeHostFunction operation, found ${op.type}`,
    );
  }

  const hostFn = (op as any).func as xdr.HostFunction;
  if (!hostFn || hostFn.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new SignedTxValidationError("Expected an invokeContract host function");
  }

  const invokeContract = hostFn.invokeContract();
  const contractAddress = Address.fromScAddress(invokeContract.contractAddress()).toString();
  if (contractAddress !== expectedContractId) {
    throw new SignedTxValidationError(
      `Transaction targets contract ${contractAddress}, expected ${expectedContractId}`,
    );
  }

  const functionName = invokeContract.functionName().toString();
  if (functionName !== expected.functionName) {
    throw new SignedTxValidationError(
      `Transaction invokes function ${functionName}, expected ${expected.functionName}`,
    );
  }

  const args = invokeContract.args();
  if (args.length < 1) {
    throw new SignedTxValidationError("Transaction invocation has no arguments");
  }

  const resourceIdArg = scValToNative(args[0]);
  if (String(resourceIdArg) !== expected.resourceId) {
    throw new SignedTxValidationError(
      `Transaction resource id ${String(resourceIdArg)} does not match expected ${expected.resourceId}`,
    );
  }
}

export type TransactionStatus = "SUCCESS" | "FAILED" | "PENDING";

/**
 * Poll Soroban RPC getTransaction until the transaction reaches a terminal
 * state or the attempt budget is exhausted. Returns PENDING on timeout.
 */
export async function pollTransactionStatus(
  txHash: string,
  opts: { maxAttempts: number; intervalMs: number },
): Promise<{ status: TransactionStatus; txHash: string }> {
  const server = registryClient.options.rpcUrl;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));

    const statusResponse = await fetch(server, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: { hash: txHash },
      }),
    });

    const statusResult = await statusResponse.json();

    if (statusResult.error) {
      // Transaction not found yet, continue polling.
      continue;
    }

    const status = statusResult.result?.status;
    if (status === "SUCCESS") return { status: "SUCCESS", txHash };
    if (status === "FAILED") return { status: "FAILED", txHash };
    // NOT_FOUND / PENDING: continue polling.
  }

  return { status: "PENDING", txHash };
}

const keypair = Keypair.fromSecret(config.REGISTRY_SECRET_KEY);

export const registryClient = new Client({
  contractId: config.REGISTRY_CONTRACT_ID,
  rpcUrl: config.SOROBAN_RPC_URL,
  networkPassphrase: NETWORK_PASSPHRASE,
  publicKey: keypair.publicKey(),
});

export { NETWORK_PASSPHRASE, keypair as registryKeypair };
export type { Resource };

/**
 * Fetch a resource from the on-chain vault registry.
 * Returns the parsed Resource (creator, price, metadata) or null if not found.
 */
export async function getResource(id: string): Promise<Resource | null> {
  const tx = await registryClient.get({ id });
  const result = tx.result;
  if (result.isErr()) {
    const err = result.unwrapErr();
    if (err.message === Errors[2].message) return null; // NotFound
    throw new Error(`Contract error: ${err.message}`);
  }
  return result.unwrap();
}

/**
 * Check whether a resource with the given id is registered on-chain.
 */
export async function resourceExists(id: string): Promise<boolean> {
  const tx = await registryClient.exists({ id });
  return tx.result;
}

export async function getResourcePage(start: number, limit: number): Promise<Resource[]> {
  return listResources(registryClient, start, limit);
}

/**
 * Total number of resources ever registered on-chain.
 */
export async function resourceCount(): Promise<number> {
  const tx = await registryClient.count();
  return Number(tx.result);
}

/**
 * Convert a USDC decimal string (e.g. "0.50") to i128 stroops.
 * Stellar USDC uses 7 decimal places: 1 USDC = 10_000_000 stroops.
 */
export function usdcToStroops(usdc: string): bigint {
  return BigInt(Math.round(parseFloat(usdc) * 10_000_000));
}

/**
 * Build an unsigned set_price transaction for the resource owner to sign.
 * Returns the transaction XDR string.
 */
export async function setPrice(id: string, newPriceUsdc: string): Promise<string> {
  const tx = await (registryClient as any).set_price(
    { id, new_price: usdcToStroops(newPriceUsdc) },
    { simulate: false },
  );
  return tx.toXDR();
}

/**
 * Build an unsigned transfer_ownership transaction for the resource owner to sign.
 * Returns the transaction XDR string.
 */
export async function transferOwnership(id: string, newCreator: string): Promise<string> {
  const tx = await (registryClient as any).transfer_ownership(
    { id, new_creator: newCreator },
    { simulate: false },
  );
  return tx.toXDR();
}

/**
 * Build an unsigned register transaction for the resource creator to sign.
 * Returns the transaction XDR string.
 */
export async function buildRegisterTx(
  creator: string,
  id: string,
  priceUsdc: string,
  metadata: string,
): Promise<string> {
  const tx = await (registryClient as any).register(
    {
      creator,
      id,
      price: usdcToStroops(priceUsdc),
      metadata,
      tags: [],
    },
    { simulate: false },
  );
  return tx.toXDR();
}

/**
 * Delist a resource on the vault registry (set_listed(id, false)).
 *
 * The DELETE /resources/:id flow has no client wallet to sign with, so this
 * signs with the registry keypair — the same server-side signing pattern the
 * legacy on-chain register flow uses. It is best-effort by design: the caller
 * keeps the DB delist authoritative and treats on-chain failure as non-fatal.
 *
 * Resources that were never registered on-chain should not reach here (callers
 * guard on `onchainStatus`), but if one does the contract returns NotFound and
 * we surface it as a failed result rather than throwing.
 */
export async function delistOnChain(id: string): Promise<{
  txHash: string;
  success: boolean;
  error?: string;
}> {
  try {
    const tx = await (registryClient as any).delist({ id }, { simulate: true });

    const sentTx = await tx.signAndSend({
      signTransaction: async (xdr: string) => {
        const { Transaction } = await import("@stellar/stellar-sdk");
        const stellarTx = new Transaction(xdr, NETWORK_PASSPHRASE);
        stellarTx.sign(keypair);
        return stellarTx.toXDR();
      },
    });

    const txHash = sentTx?.sendTransactionResponse?.hash ?? "";
    getLogger().info(
      { event: "onchain_delist", resourceId: id, txHash, success: true },
      "on-chain resource delist succeeded",
    );
    return { txHash, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { event: "onchain_delist", resourceId: id, success: false, error: message },
      "on-chain resource delist failed",
    );
    return { txHash: "", success: false, error: message };
  }
}

export type SubmitSignedTxResult =
  | { state: "confirmed"; txHash: string }
  | { state: "failed"; txHash: string; error: string }
  | { state: "pending"; txHash: string };

/**
 * Validate, submit, and (briefly) poll a creator-signed XDR.
 *
 * Validation runs first and throws SignedTxValidationError on any mismatch so
 * the caller can reject before broadcasting. Submission errors return
 * `{ state: 'failed' }`. A timeout returns `{ state: 'pending' }` — the
 * transaction may still confirm, so the worker resolves it by hash later.
 */
export async function submitSignedTx(
  signedXdr: string,
  expected: ExpectedSignedTx,
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<SubmitSignedTxResult> {
  // Validate before broadcasting; throws SignedTxValidationError on mismatch.
  validateSignedTx(signedXdr, expected);

  try {
    const server = registryClient.options.rpcUrl;
    const response = await fetch(server, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: {
          transaction: signedXdr,
        },
      }),
    });

    const result = await response.json();

    if (result.error) {
      const message = result.error.message || "Transaction submission failed";
      getLogger().warn(
        { event: "onchain_submit", phase: "send", success: false, error: message },
        "signed transaction submission failed",
      );
      return { state: "failed", txHash: "", error: message };
    }

    const txHash: string = result.result.hash;
    getLogger().info(
      { event: "onchain_submit", phase: "sent", txHash },
      "signed transaction submitted",
    );

    const { status } = await pollTransactionStatus(txHash, {
      maxAttempts: opts.maxAttempts ?? 3,
      intervalMs: opts.intervalMs ?? 1000,
    });

    if (status === "SUCCESS") {
      getLogger().info(
        { event: "onchain_submit", phase: "confirmed", txHash, success: true },
        "signed transaction confirmed on-chain",
      );
      return { state: "confirmed", txHash };
    }

    if (status === "FAILED") {
      getLogger().warn(
        { event: "onchain_submit", phase: "confirmed", txHash, success: false },
        "signed transaction failed on-chain",
      );
      return { state: "failed", txHash, error: "Transaction failed on-chain" };
    }

    // PENDING: the transaction may still confirm; let the worker resolve it.
    getLogger().warn(
      { event: "onchain_submit", phase: "pending", txHash },
      "signed transaction still pending after poll window",
    );
    return { state: "pending", txHash };
  } catch (error) {
    getLogger().error(
      { event: "onchain_submit", phase: "error", err: error },
      "signed transaction submit failed",
    );
    return {
      state: "failed",
      txHash: "",
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}