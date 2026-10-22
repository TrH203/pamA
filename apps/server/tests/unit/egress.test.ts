import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/client.ts";
import { EgressBlockedError, EgressGuard } from "../../src/net/egress.ts";
import { pglite } from "../helpers/db.ts";

describe("EgressGuard", () => {
  let db: Db;
  const ok = vi.fn(async () => new Response("ok"));

  beforeEach(async () => {
    db = await pglite.create();
    ok.mockClear();
  });
  afterEach(async () => {
    await db.close();
  });

  const log = () =>
    db.query<{ host: string; purpose: string; allowed: boolean; component: string }>(
      "SELECT host, purpose, allowed, component FROM network_log ORDER BY at, id",
    );

  it("logs every outbound request with host and purpose", async () => {
    const g = new EgressGuard(db, { strict: false, declaredHosts: [] }, ok);
    await g.fetch("https://api.anthropic.com/v1/messages", { method: "POST" }, "llm.answer");
    expect(ok).toHaveBeenCalledOnce();
    expect(await log()).toEqual([
      { host: "api.anthropic.com", purpose: "llm.answer", allowed: true, component: "server" },
    ]);
  });

  it("blocks undeclared hosts in strict mode and still logs them", async () => {
    const g = new EgressGuard(db, { strict: true, declaredHosts: ["ollama.lan"] }, ok);
    await expect(g.fetch("https://evil.example.net/x", {}, "llm.answer")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(ok).not.toHaveBeenCalled();
    expect(await log()).toEqual([
      { host: "evil.example.net", purpose: "llm.answer", allowed: false, component: "server" },
    ]);
  });

  it("allows declared hosts and loopback in strict mode", async () => {
    const g = new EgressGuard(db, { strict: true, declaredHosts: ["ollama.lan:11434"] }, ok);
    await g.fetch("http://ollama.lan:11434/api/chat", {}, "llm.digest");
    await g.fetch("http://127.0.0.1:11434/api/embed", {}, "llm.embed");
    await g.fetch("http://localhost:11434/api/embed", {}, "llm.embed");
    expect(ok).toHaveBeenCalledTimes(3);
    expect((await log()).every((r) => r.allowed)).toBe(true);
  });

  it("checks non-HTTP destinations such as SMTP", async () => {
    const g = new EgressGuard(db, { strict: true, declaredHosts: [] }, ok);
    await expect(g.assertAllowed("smtp.mailgun.org", "mail.otp")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    g.setPolicy({ strict: true, declaredHosts: ["smtp.mailgun.org"] });
    await expect(g.assertAllowed("smtp.mailgun.org", "mail.otp")).resolves.toBeUndefined();
  });
});
