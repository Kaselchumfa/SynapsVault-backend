/**
 * SynapsVault — Circuit Breaker
 * Wraps outbound service calls to prevent cascade failures on Stellar RPC.
 */
import { getLogger } from "../lib/logger.js";

type State = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private state: State = "CLOSED";
  private failures = 0;
  private successes = 0;
  private nextAttempt = 0;
  private readonly log = getLogger();

  constructor(
    private readonly name: string,
    private readonly threshold = 5,
    private readonly successThreshold = 2,
    private readonly timeout = 30_000,
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() < this.nextAttempt) {
        throw new Error(`Circuit [${this.name}] is OPEN — rejecting call`);
      }
      this.state = "HALF_OPEN";
      this.log.warn({ circuit: this.name }, "circuit HALF_OPEN — trying probe");
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === "HALF_OPEN") {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.state = "CLOSED";
        this.successes = 0;
        this.log.info({ circuit: this.name }, "circuit CLOSED");
      }
    }
  }

  private onFailure(): void {
    this.successes = 0;
    this.failures++;
    if (this.failures >= this.threshold || this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.nextAttempt = Date.now() + this.timeout;
      this.log.error({ circuit: this.name, next: new Date(this.nextAttempt).toISOString() }, "circuit OPEN");
    }
  }

  getState(): State { return this.state; }
}

/**
 * Shared breaker for outbound Soroban/Stellar RPC calls. Kept as a module-level
 * singleton so that failures observed by one request trip the breaker for all.
 */
export const sorobanCircuitBreaker = new CircuitBreaker("soroban-rpc");

/**
 * Run an outbound Soroban RPC call through the shared circuit breaker.
 * Use this for every call that talks to the Stellar/Soroban RPC endpoint.
 */
export function callSorobanRpc<T>(fn: () => Promise<T>): Promise<T> {
  return sorobanCircuitBreaker.call(fn);
}
