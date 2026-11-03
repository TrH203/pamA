// Endpoints of cloud workspace owners reach only the public internet (SSRF guard).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/client.ts";
import { classify } from "../../src/llm/check.ts";
import { EgressGuard } from "../../src/net/egress.ts";
import {
  assertPublicHost,
  isPublicAddress,
  NotPublicError,
  type ResolveFn,
} from "../../src/net/public-host.ts";
import { pglite } from "../helpers/db.ts";

const to =
  (...addresses: string[]): ResolveFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("isPublicAddress", () => {
  it("refuses loopback, private, link-local, CGNAT, unique-local and mapped forms", () => {
    for (const a of [
      "127.0.0.1",
      "10.0.0.5",
      "172.20.1.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:10.0.0.5",
      "::ffff:127.0.0.1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it("accepts public addresses", () => {
    for (const a of ["1.1.1.1", "54.251.85.246", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(a), a).toBe(true);
    }
  });
});

describe("assertPublicHost", () => {
  it("refuses single-label names such as compose services without resolving them", async () => {
    const resolve = vi.fn(to("172.18.0.2"));
    for (const h of ["db", "caddy", "server", "localhost"]) {
      await expect(assertPublicHost(h, resolve)).rejects.toBeInstanceOf(NotPublicError);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses names that resolve to a private or metadata address (wildcard DNS)", async () => {
    await expect(assertPublicHost("10.0.0.5.sslip.io", to("10.0.0.5"))).rejects.toBeInstanceOf(
      NotPublicError,
    );
    await expect(
      assertPublicHost("169.254.169.254.sslip.io", to("169.254.169.254")),
    ).rejects.toBeInstanceOf(NotPublicError);
    // One private address among public ones is enough to refuse.
    await expect(
      assertPublicHost("mixed.example.com", to("1.1.1.1", "10.0.0.1")),
    ).rejects.toBeInstanceOf(NotPublicError);
  });

  it("refuses IP literals and names that do not resolve", async () => {
    await expect(assertPublicHost("1.1.1.1", to("1.1.1.1"))).rejects.toBeInstanceOf(NotPublicError);
    await expect(
      assertPublicHost("nope.example.com", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toBeInstanceOf(NotPublicError);
  });

  it("accepts a name with only public addresses", async () => {
    await expect(assertPublicHost("api.example.com", to("93.184.216.34"))).resolves.toHaveLength(1);
  });
});

describe("EgressGuard.publicOnly", () => {
  let db: Db;
  beforeEach(async () => {
    db = await pglite.create();
  });
  afterEach(async () => {
    await db.close();
  });

  it("does not follow a redirect from a public endpoint", async () => {
    const base = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/" } }),
    );
    const g = new EgressGuard(db, { strict: false, declaredHosts: [] }, base);
    g.resolveHost = to("93.184.216.34");
    await expect(g.publicOnly().fetch("https://api.example.com/v1/chat")).rejects.toThrow(
      /redirect/,
    );
    expect(base).toHaveBeenCalledOnce();
    expect((base.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
  });

  it("never sends a request to a host that resolves inward", async () => {
    const base = vi.fn(async () => new Response("{}"));
    const g = new EgressGuard(db, { strict: false, declaredHosts: [] }, base);
    g.resolveHost = to("10.0.0.5");
    await expect(g.publicOnly().fetch("https://10.0.0.5.sslip.io/v1")).rejects.toBeInstanceOf(
      NotPublicError,
    );
    await expect(g.publicOnly().fetch("https://db:5432/")).rejects.toBeInstanceOf(NotPublicError);
    expect(base).not.toHaveBeenCalled();
    // The plain guard is unchanged for the operator's own endpoints.
    await g.fetch("http://10.0.0.5:11434/api/chat");
    expect(base).toHaveBeenCalledOnce();
  });
});

describe("classify for a workspace owner's endpoint", () => {
  it("never returns the raw error text", () => {
    const e = new Error("HTTP/1.1 400 Bad Request: redis_version:7.2.4 at 172.18.0.3");
    expect(classify(e).detail).toContain("redis_version");
    const item = classify(e, false);
    expect(item).toEqual({
      name: "reachable",
      ok: false,
      detail: "the endpoint did not answer as expected",
    });
    expect(
      classify(new TypeError("fetch failed", { cause: new NotPublicError("x") }), false),
    ).toMatchObject({ detail: "the endpoint is not a public internet address" });
  });
});
