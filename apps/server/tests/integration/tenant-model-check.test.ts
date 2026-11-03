// Settings → Connections on a cloud server: a workspace owner may check only the chat model, never
// probe the operator's network, and never overwrite the operator's last check.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { pglite } from "../helpers/db.ts";

async function signIn(t: TestCtx, email: string): Promise<string> {
  const res = await t.app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(204);
  const mail = t.mails.findLast((m) => m.to === email.toLowerCase());
  const url = new URL(
    /https?:\/\/\S+\/v1\/auth\/callback\?token=\S+/.exec(mail?.text ?? "")?.[0] as string,
  );
  const cb = await t.app.request(url.pathname + url.search);
  return (cb.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

describe("model check by a cloud workspace owner", () => {
  let t: TestCtx;
  let cookie: string;
  beforeEach(async () => {
    t = await makeCtx(pglite, { mode: "cloud" });
    cookie = await signIn(t, "a@acme.vn");
  });
  afterEach(() => t.close());

  const check = (body: unknown) =>
    t.app.request("/v1/models/check", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  it("gives a read-only result for roles the operator owns and refuses candidates for them", async () => {
    const before = await t.db.query("SELECT role, last_check FROM model_settings ORDER BY role");
    for (const role of ["small", "embed"]) {
      const res = await check({ role });
      expect(res.status).toBe(200);
      const b = (await res.json()) as { role: string; ok: boolean; items: unknown[] };
      expect(b).toMatchObject({ role, items: [] });
      const cand = await check({
        role,
        candidate: {
          provider: "openai-compatible",
          model: "m",
          baseUrl: "https://api.example.com/v1",
        },
      });
      expect(cand.status).toBe(403);
    }
    const after = await t.db.query("SELECT role, last_check FROM model_settings ORDER BY role");
    expect(after).toEqual(before);
  });

  it("answers every role for a paired device (what `pama model check` asks)", async () => {
    const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
      t.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...extra },
        body: JSON.stringify(body),
      });
    const s = (await (await post("/v1/auth/device/start", { device_name: "mbp" })).json()) as {
      device_code: string;
      user_code: string;
    };
    expect(
      (await post("/v1/auth/device/approve", { user_code: s.user_code }, { cookie })).status,
    ).toBe(200);
    const { token } = (await (
      await post("/v1/auth/device/token", { device_code: s.device_code })
    ).json()) as { token: string };
    expect(token).toMatch(/^pd_/);
    for (const role of ["chat", "small", "embed"]) {
      const res = await post("/v1/models/check", { role }, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
    }
  });

  it("checks the operator's chat model without its details or a stored result", async () => {
    const before = await t.db.query("SELECT role, last_check FROM model_settings ORDER BY role");
    const res = await check({ role: "chat" });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { ok: boolean; items: unknown[] };
    expect(b.items).toEqual([]);
    const after = await t.db.query("SELECT role, last_check FROM model_settings ORDER BY role");
    expect(after).toEqual(before);
  });

  it("never checks a candidate inside the operator's network", async () => {
    for (const baseUrl of ["https://127.0.0.1/v1", "https://10.0.0.5/v1", "http://llm.x.invalid"]) {
      const res = await check({
        role: "chat",
        candidate: { provider: "openai-compatible", model: "m", baseUrl, apiKey: "sk-test" },
      });
      expect(res.status).toBe(422);
    }
    const ollama = await check({ role: "chat", candidate: { provider: "ollama", model: "m" } });
    expect(ollama.status).toBe(422);
  });

  it("resolves the host: compose service names and wildcard DNS to private addresses are refused", async () => {
    const asked: string[] = [];
    t.deps.guard.resolveHost = async (h) => {
      asked.push(h);
      const ip = /^(\d+\.\d+\.\d+\.\d+)\.sslip\.io$/.exec(h)?.[1] ?? "93.184.216.34";
      return [{ address: ip, family: 4 }];
    };
    for (const baseUrl of [
      "https://db:5432/",
      "https://caddy/",
      "https://10.0.0.5.sslip.io/v1",
      "https://169.254.169.254.sslip.io/latest",
    ]) {
      const res = await check({
        role: "chat",
        candidate: { provider: "openai-compatible", model: "m", baseUrl, apiKey: "sk-test" },
      });
      expect(res.status, baseUrl).toBe(422);
    }
    // 10.0.0.5.sslip.io already fails the registry's local-host rule; the metadata name is
    // refused only once it is resolved.
    expect(asked).toEqual(["169.254.169.254.sslip.io"]);
    const save = await t.app.request("/v1/models/settings/chat", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        provider: "openai-compatible",
        model: "m",
        baseUrl: "https://10.0.0.5.sslip.io/v1",
        apiKey: "sk-test",
        confirm: ["unverified"],
      }),
    });
    expect(save.status).toBe(422);
  });
});
