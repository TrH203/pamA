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

  it("refuses roles the operator owns", async () => {
    for (const role of ["small", "embed"]) expect((await check({ role })).status).toBe(403);
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
});
