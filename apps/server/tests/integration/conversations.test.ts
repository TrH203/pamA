// Conversations (spec 008b): public Ask Link conversations, owner conversations API, owner chat,
// hotkey draft history and per-workspace retention.
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyRetention } from "../../src/jobs/retention.ts";
import { createLink } from "../../src/services/links.ts";
import { type Seeded, seed } from "../fixtures/seed.ts";
import { makeCtx, type TestCtx } from "../helpers/ctx.ts";
import { describeEachDb } from "../helpers/db.ts";
import { visitor } from "../helpers/public.ts";

interface AskRes {
  ask_id: string;
  conversation_id: string;
  status: string;
  answer?: string;
  citations: { item_id: string; label: string }[];
}

describeEachDb("conversations", (f) => {
  let t: TestCtx;
  let s: Seeded;
  beforeEach(async () => {
    t = await makeCtx(f);
    s = await seed(t.deps);
  });
  afterEach(() => t.close());

  const openLink = () =>
    createLink(t.deps, {
      title: "Refunds",
      sources: [{ type: "bundle", id: s.bundleRefund }],
      access_mode: "open",
      suggested_questions: ["?"],
    });
  const answerPrompts = () => t.fake.calls.filter((c) => c.system.includes("# pamA answer"));

  it("ask without conversation_id starts one; with it, continues it with history", async () => {
    const l = await openLink();
    const v = visitor(t, l.slug);
    const r1 = (await (
      await v.call("/api/ask", { question: "Do refunds include the shipping fee?" })
    ).json()) as AskRes;
    expect(r1.status).toBe("answered");
    expect(r1.conversation_id).toBeTruthy();
    const r2res = await v.call("/api/ask", {
      question: "Why was that decided?",
      conversation_id: r1.conversation_id,
    });
    expect(r2res.status).toBe(200);
    const r2 = (await r2res.json()) as AskRes;
    expect(r2.conversation_id).toBe(r1.conversation_id);
    expect(answerPrompts().at(-1)?.user).toContain("asker: Do refunds include the shipping fee?");

    const list = (await (await v.call("/api/conversations")).json()) as {
      items: { id: string; title: string; turns: number }[];
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: r1.conversation_id,
      title: "Do refunds include the shipping fee?",
      turns: 2,
    });
    const conv = (await (await v.call(`/api/conversations/${r1.conversation_id}`)).json()) as {
      turns: { question: string; status: string; citations: { label: string }[] }[];
    };
    expect(conv.turns.map((x) => x.question)).toEqual([
      "Do refunds include the shipping fee?",
      "Why was that decided?",
    ]);
    expect(conv.turns[0]?.citations.length).toBeGreaterThan(0);
    expect(JSON.stringify(conv)).not.toContain("suggestion");
    expect(JSON.stringify(conv)).not.toContain("guard");
  });

  it("new chat, another visitor cannot read or continue it, delete hides it", async () => {
    const l = await openLink();
    const v = visitor(t, l.slug, "203.0.113.1");
    const created = await v.call("/api/conversations", {});
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    await v.call("/api/ask", {
      question: "Do refunds include the shipping fee?",
      conversation_id: id,
    });

    const other = visitor(t, l.slug, "203.0.113.2");
    expect((await other.call(`/api/conversations/${id}`)).status).toBe(404);
    expect((await other.call("/api/ask", { question: "Why?", conversation_id: id })).status).toBe(
      404,
    );
    expect((await other.call(`/api/conversations/${id}`, undefined, "DELETE")).status).toBe(404);
    const otherList = (await (await other.call("/api/conversations")).json()) as {
      items: unknown[];
    };
    expect(otherList.items).toHaveLength(0);

    expect((await v.call(`/api/conversations/${id}`, undefined, "DELETE")).status).toBe(204);
    expect((await v.call(`/api/conversations/${id}`)).status).toBe(404);
    expect((await v.call("/api/ask", { question: "Why?", conversation_id: id })).status).toBe(404);
    const owner = (await (await t.req("/v1/conversations")).json()) as { items: unknown[] };
    expect(owner.items).toHaveLength(0);
  });

  it("a conversation id from another link is not found", async () => {
    const a = await openLink();
    const b = await openLink();
    const va = visitor(t, a.slug);
    const r = (await (
      await va.call("/api/ask", { question: "Do refunds include the shipping fee?" })
    ).json()) as AskRes;
    const vb = visitor(t, b.slug);
    expect(
      (await vb.call("/api/ask", { question: "Why?", conversation_id: r.conversation_id })).status,
    ).toBe(404);
  });

  it("verified email resumes conversations on another device", async () => {
    const l = await createLink(t.deps, {
      title: "Refunds",
      sources: [{ type: "bundle", id: s.bundleRefund }],
      access_mode: "email_otp",
      suggested_questions: ["?"],
    });
    const verify = async (ip: string) => {
      const v = visitor(t, l.slug, ip);
      await v.call("/api/access", { email: "minh@example.com" });
      const code = /code is (\d{6})/.exec(t.mails.at(-1)?.text ?? "")?.[1];
      expect((await v.call("/api/access", { email: "minh@example.com", otp: code })).status).toBe(
        204,
      );
      return v;
    };
    const laptop = await verify("203.0.113.10");
    const r = (await (
      await laptop.call("/api/ask", { question: "Do refunds include the shipping fee?" })
    ).json()) as AskRes;
    const phone = await verify("203.0.113.11");
    const list = (await (await phone.call("/api/conversations")).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((x) => x.id)).toEqual([r.conversation_id]);
    const cont = await phone.call("/api/ask", {
      question: "How long do refund requests take?",
      conversation_id: r.conversation_id,
    });
    expect(cont.status).toBe(200);
    // A different email on the same link sees nothing.
    const v3 = visitor(t, l.slug, "203.0.113.12");
    await v3.call("/api/access", { email: "other@example.com" });
    const code = /code is (\d{6})/.exec(t.mails.at(-1)?.text ?? "")?.[1];
    await v3.call("/api/access", { email: "other@example.com", otp: code });
    const none = (await (await v3.call("/api/conversations")).json()) as { items: unknown[] };
    expect(none.items).toHaveLength(0);
  });

  it("asking for a code for another email drops the old verification (no borrowed resume)", async () => {
    const l = await createLink(t.deps, {
      title: "Refunds",
      sources: [{ type: "bundle", id: s.bundleRefund }],
      access_mode: "email_otp",
      suggested_questions: ["?"],
    });
    const codeOf = () => /code is (\d{6})/.exec(t.mails.at(-1)?.text ?? "")?.[1];
    const victim = visitor(t, l.slug, "203.0.113.20");
    await victim.call("/api/access", { email: "victim@example.com" });
    await victim.call("/api/access", { email: "victim@example.com", otp: codeOf() });
    const r = (await (
      await victim.call("/api/ask", { question: "Do refunds include the shipping fee?" })
    ).json()) as AskRes;
    expect(r.conversation_id).toBeTruthy();

    const attacker = visitor(t, l.slug, "203.0.113.21");
    await attacker.call("/api/access", { email: "attacker@example.com" });
    expect(
      (await attacker.call("/api/access", { email: "attacker@example.com", otp: codeOf() })).status,
    ).toBe(204);
    // Ask for the victim's code but never enter it.
    await attacker.call("/api/access", { email: "victim@example.com" });
    const list = (await (await attacker.call("/api/conversations")).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(0);
    expect((await attacker.call(`/api/conversations/${r.conversation_id}`)).status).toBe(404);
    expect(
      (
        await attacker.call("/api/ask", {
          question: "Why?",
          conversation_id: r.conversation_id,
        })
      ).status,
    ).toBe(404);
    expect(
      (await attacker.call(`/api/conversations/${r.conversation_id}`, undefined, "DELETE")).status,
    ).toBe(404);
  });

  it("new chat reuses an empty conversation; a failed ask leaves no conversation", async () => {
    const l = await openLink();
    const v = visitor(t, l.slug);
    const a = (await (await v.call("/api/conversations", {})).json()) as { id: string };
    const b = (await (await v.call("/api/conversations", {})).json()) as { id: string };
    expect(b.id).toBe(a.id);
    const [n] = await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM conversations");
    expect(n?.n).toBe(1);

    const failing = visitor(t, l.slug, "203.0.113.30");
    const saved = t.fake.handler;
    t.fake.handler = () => {
      throw new Error("model down");
    };
    const res = await failing.call("/api/ask", {
      question: "Do refunds include the shipping fee?",
    });
    t.fake.handler = saved;
    expect(res.status).toBeGreaterThanOrEqual(400);
    const [m] = await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM conversations");
    expect(m?.n).toBe(1);
  });

  it("owner: list, filter needs_reply, detail with citations, reply, archive, export, delete", async () => {
    const l = await openLink();
    const v = visitor(t, l.slug);
    const ok = (await (
      await v.call("/api/ask", { question: "Do refunds include the shipping fee?" })
    ).json()) as AskRes;
    const refused = (await (
      await v.call("/api/ask", {
        question: "What is the weather in Hanoi?",
        conversation_id: ok.conversation_id,
      })
    ).json()) as AskRes;
    expect(refused.status).toBe("refused");
    expect((await v.call(`/api/asks/${refused.ask_id}/forward`, {})).status).toBe(202);

    const all = (await (await t.req("/v1/conversations")).json()) as {
      items: { id: string; turns: number; needs_reply: number; link_title: string }[];
      next_offset: number | null;
    };
    expect(all.items).toHaveLength(1);
    expect(all.items[0]).toMatchObject({ turns: 2, needs_reply: 1, link_title: "Refunds" });
    expect(all.next_offset).toBeNull();
    const nr = (await (await t.req("/v1/conversations?status=needs_reply")).json()) as {
      items: unknown[];
    };
    expect(nr.items).toHaveLength(1);
    const byLink = (await (await t.req("/v1/conversations?link=nosuchlink")).json()) as {
      items: unknown[];
    };
    expect(byLink.items).toHaveLength(0);
    expect((await t.req("/v1/conversations?status=bogus")).status).toBe(422);

    const detail = (await (await t.req(`/v1/conversations/${ok.conversation_id}`)).json()) as {
      origin: string;
      turns: { status: string; citations: { item_id: string; text?: string }[] }[];
    };
    expect(detail.origin).toBe("link");
    expect(detail.turns.map((x) => x.status)).toEqual(["answered", "forwarded"]);
    expect(detail.turns[0]?.citations[0]?.text).toContain("shipping fee");

    const rep = await t.req(`/v1/conversations/${ok.conversation_id}/reply`, {
      json: { text: "It depends on the city, sorry!" },
    });
    expect(rep.status).toBe(200);
    expect(((await rep.json()) as { ask_id: string }).ask_id).toBe(refused.ask_id);
    const after = (await (await t.req("/v1/conversations?status=needs_reply")).json()) as {
      items: unknown[];
    };
    expect(after.items).toHaveLength(0);
    const seen = (await (await v.call(`/api/conversations/${ok.conversation_id}`)).json()) as {
      turns: { owner_reply: string | null }[];
    };
    expect(seen.turns[1]?.owner_reply).toBe("It depends on the city, sorry!");

    const arch = await t.req(`/v1/conversations/${ok.conversation_id}`, {
      method: "PATCH",
      json: { status: "archived" },
    });
    expect(arch.status).toBe(200);
    const archived = (await (await t.req("/v1/conversations?status=archived")).json()) as {
      items: unknown[];
    };
    expect(archived.items).toHaveLength(1);

    const csv = await t.req("/v1/conversations/export?format=csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\n")[0]).toContain("conversation_id");
    expect(text).toContain("What is the weather in Hanoi?");
    const json = (await (await t.req("/v1/conversations/export")).json()) as { items: unknown[] };
    expect(json.items).toHaveLength(2);

    expect(
      (await t.req(`/v1/conversations/${ok.conversation_id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await t.req(`/v1/conversations/${ok.conversation_id}`)).status).toBe(404);
    expect((await v.call(`/api/conversations/${ok.conversation_id}`)).status).toBe(404);
  });

  it("owner chat: multi-turn over all work or a scope, then an Ask Link from it", async () => {
    const r1 = await t.req("/v1/chat", {
      json: { question: "Do refunds include the shipping fee?" },
    });
    expect(r1.status).toBe(200);
    const a1 = (await r1.json()) as AskRes & { scope: unknown };
    expect(a1.status).toBe("answered");
    expect(a1.scope).toBeNull();
    const a2 = (await (
      await t.req("/v1/chat", {
        json: { question: "Why?", conversation_id: a1.conversation_id },
      })
    ).json()) as AskRes;
    expect(a2.conversation_id).toBe(a1.conversation_id);
    expect(answerPrompts().at(-1)?.user).toContain("<history>");
    expect(
      (
        await t.req("/v1/chat", {
          json: {
            question: "x",
            conversation_id: a1.conversation_id,
            scope: [{ type: "bundle", id: s.bundleCheckout }],
          },
        })
      ).status,
    ).toBe(422);

    const list = (await (await t.req("/v1/chat/conversations")).json()) as {
      items: { id: string; origin: string; turns: number }[];
    };
    expect(list.items).toEqual([
      expect.objectContaining({ id: a1.conversation_id, origin: "owner_chat", turns: 2 }),
    ]);

    // Chat over everything: the link covers the tasks the chat's answers cited.
    const link = await t.req(`/v1/chat/${a1.conversation_id}/link`, {
      json: { access_mode: "open", suggested_questions: ["?"] },
    });
    expect(link.status).toBe(201);
    const lb = (await link.json()) as { slug: string; sources: { type: string; id: string }[] };
    expect(lb.sources).toEqual([{ type: "bundle", id: s.bundleRefund }]);

    // A scoped chat keeps its scope and refuses outside it.
    const scoped = (await (
      await t.req("/v1/chat", {
        json: {
          question: "Do refunds include the shipping fee?",
          scope: [{ type: "bundle", id: s.bundleCheckout }],
        },
      })
    ).json()) as AskRes & { scope: unknown };
    expect(scoped.status).toBe("refused");
    expect(scoped.scope).toEqual([{ type: "bundle", id: s.bundleCheckout }]);
    const l2 = (await (
      await t.req(`/v1/chat/${scoped.conversation_id}/link`, {
        json: { access_mode: "open", suggested_questions: ["?"] },
      })
    ).json()) as { sources: unknown };
    expect(l2.sources).toEqual([{ type: "bundle", id: s.bundleCheckout }]);

    // Owner chat conversations are not Ask Link conversations: no visitor can reach them.
    const v = visitor(t, lb.slug);
    expect(
      (await v.call("/api/ask", { question: "Why?", conversation_id: a1.conversation_id })).status,
    ).toBe(404);
  });

  it("chat link needs a scope or a cited answer", async () => {
    const r = (await (
      await t.req("/v1/chat", { json: { question: "What is the weather in Hanoi?" } })
    ).json()) as AskRes;
    expect(r.status).toBe("refused");
    const l = await t.req(`/v1/chat/${r.conversation_id}/link`, { json: { access_mode: "open" } });
    expect(l.status).toBe(422);
  });

  it("hotkey drafts are recorded in a daily conversation and listed as recent", async () => {
    const d1 = (await (
      await t.req("/v1/draft", { json: { question: "Do refunds include the shipping fee?" } })
    ).json()) as { ask_id: string };
    await t.req("/v1/draft", { json: { question: "How was the flaky checkout test fixed?" } });
    const recent = (await (await t.req("/v1/draft/recent?limit=5")).json()) as {
      items: { ask_id: string; conversation_id: string; question: string; answer: string }[];
    };
    expect(recent.items.map((x) => x.question)).toEqual([
      "How was the flaky checkout test fixed?",
      "Do refunds include the shipping fee?",
    ]);
    expect(recent.items[1]?.ask_id).toBe(d1.ask_id);
    expect(recent.items[0]?.conversation_id).toBe(recent.items[1]?.conversation_id);
    const [c] = await t.db.query<{ origin: string; title: string }>(
      "SELECT origin, title FROM conversations WHERE id = $1",
      [recent.items[0]?.conversation_id],
    );
    expect(c?.origin).toBe("hotkey");
    expect(c?.title).toMatch(/^Drafts \d{4}-\d{2}-\d{2}$/);
  });

  it("retention follows the workspace setting and purges deleted conversations", async () => {
    expect(await (await t.req("/v1/settings/retention")).json()).toEqual({
      ask_retention_days: 180,
    });
    expect(
      (await t.req("/v1/settings/retention", { method: "PUT", json: { ask_retention_days: 0 } }))
        .status,
    ).toBe(422);
    const put = await t.req("/v1/settings/retention", {
      method: "PUT",
      json: { ask_retention_days: 30 },
    });
    expect(put.status).toBe(200);

    const l = await openLink();
    const v = visitor(t, l.slug);
    const old = (await (
      await v.call("/api/ask", { question: "Do refunds include the shipping fee?" })
    ).json()) as AskRes;
    const fresh = (await (
      await v.call("/api/ask", { question: "How long do refund requests take?" })
    ).json()) as AskRes;
    const gone = (await (
      await v.call("/api/ask", { question: "Do refunds include the shipping fee?" })
    ).json()) as AskRes;
    await t.db.query(
      "UPDATE asks SET created_at = now() - interval '40 days' WHERE conversation_id = $1",
      [old.conversation_id],
    );
    await t.db.query(
      "UPDATE conversations SET last_at = now() - interval '40 days', created_at = now() - interval '40 days' WHERE id = $1",
      [old.conversation_id],
    );
    await v.call(`/api/conversations/${gone.conversation_id}`, undefined, "DELETE");
    // An empty "new chat" older than a day is purged too.
    const empty = (await (await v.call("/api/conversations", {})).json()) as { id: string };
    await t.db.query("UPDATE conversations SET last_at = now() - interval '2 days' WHERE id = $1", [
      empty.id,
    ]);

    const r = await applyRetention(t.db);
    expect(r.conversations).toBe(3);
    const left = await t.db.query<{ id: string }>("SELECT id FROM conversations");
    expect(left.map((x) => x.id)).toEqual([fresh.conversation_id]);
    const asks = await t.db.query<{ conversation_id: string }>("SELECT conversation_id FROM asks");
    expect(asks.map((x) => x.conversation_id)).toEqual([fresh.conversation_id]);
  });
});
