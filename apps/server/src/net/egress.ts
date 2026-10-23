// Application-level egress control (research R13, FR-027): every outbound connection made by the
// server goes through this guard, is written to network_log, and is blocked in strict offline
// mode unless its host is declared. Loopback is always allowed: it never leaves the machine.
import { ulid } from "ulid";
import type { Db } from "../db/client.ts";

export interface EgressPolicy {
  strict: boolean;
  /** Hostnames, optionally with :port. */
  declaredHosts: string[];
}

export class EgressBlockedError extends Error {
  constructor(readonly host: string) {
    super(`strict offline mode: ${host} is not a declared host`);
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class EgressGuard {
  constructor(
    private readonly db: Db,
    private policy: EgressPolicy,
    private readonly baseFetch: FetchFn = globalThis.fetch,
    private readonly component: "server" | "desktop" | "cli" = "server",
  ) {}

  setPolicy(policy: EgressPolicy) {
    this.policy = policy;
  }

  isAllowed(host: string, port?: string): boolean {
    if (!this.policy.strict) return true;
    const h = host.toLowerCase();
    if (LOOPBACK.has(h)) return true;
    return this.policy.declaredHosts.some((d) => {
      const [dh, dp] = d.toLowerCase().split(":");
      return dh === h && (dp === undefined || dp === port);
    });
  }

  /** Check and log a non-HTTP destination (e.g. SMTP). */
  async assertAllowed(host: string, purpose: string, port?: string): Promise<void> {
    const allowed = this.isAllowed(host, port);
    await this.record(host, purpose, allowed);
    if (!allowed) throw new EgressBlockedError(host);
  }

  /** fetch() that is checked and logged. Pass it to every HTTP client (AI SDK providers etc). */
  fetch = async (input: string | URL | Request, init?: RequestInit, purpose = "http") => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    await this.assertAllowed(url.hostname, purpose, url.port || undefined);
    return this.baseFetch(input, init);
  };

  /** A fetch with a fixed purpose, in the plain fetch signature. */
  fetchFor(purpose: string): FetchFn {
    return (input, init) => this.fetch(input, init, purpose);
  }

  private async record(host: string, purpose: string, allowed: boolean) {
    await this.db.query(
      "INSERT INTO network_log (id, component, host, purpose, allowed) VALUES ($1, $2, $3, $4, $5)",
      [ulid(), this.component, host, purpose, allowed],
    );
  }
}
