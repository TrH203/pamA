// Layer 3 (Constitution II): every outgoing answer is re-scanned; any failure refuses.
import { describe, expect, it } from "vitest";
import { checkAnswer, type Judge } from "../../src/pipeline/guard.ts";
import { RULES } from "../helpers/ctx.ts";

const items = [
  {
    id: "dg#d1",
    text: "Refunds do not include the shipping fee.",
    rationale: "Carrier fee is non-refundable.",
  },
];
const clean: Judge = async () => ({ leak: false, off_scope: false, unsupported_claims: false });

describe("answer guard", () => {
  it("passes a clean, supported answer", async () => {
    const r = await checkAnswer({
      answer: "No, shipping is not refunded.",
      items,
      denyTopics: [],
      rules: RULES,
      judge: clean,
    });
    expect(r).toMatchObject({
      ok: true,
      guard: { leak: false, off_scope: false, unsupported_claims: false, rule_hits: [] },
    });
  });

  it("refuses when a rule matches (secret or personal data in the answer)", async () => {
    const r = await checkAnswer({
      answer: "Use key AKIAZ7Q4PL2XWN3VB5KD or mail lan.tran@acme-corp.vn",
      items,
      denyTopics: [],
      rules: RULES,
      judge: clean,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("guard_failed");
    expect(r.guard.rule_hits).toEqual(expect.arrayContaining(["aws-access-token", "email"]));
    expect(r.guard.leak).toBe(true);
  });

  it("refuses denied topics", async () => {
    const r = await checkAnswer({
      answer: "The Pricing for enterprise is 15% off.",
      items,
      denyTopics: ["pricing"],
      rules: RULES,
      judge: clean,
    });
    expect(r).toMatchObject({ ok: false, reason: "denied_topic" });
  });

  it("refuses what the judge flags", async () => {
    for (const flag of ["leak", "off_scope", "unsupported_claims"] as const) {
      const judge: Judge = async () => ({
        leak: false,
        off_scope: false,
        unsupported_claims: false,
        [flag]: true,
      });
      const r = await checkAnswer({
        answer: "Shipping is not refunded.",
        items,
        denyTopics: [],
        rules: RULES,
        judge,
      });
      expect(r).toMatchObject({ ok: false, reason: "guard_failed" });
      expect(r.guard[flag]).toBe(true);
    }
  });

  it("fails closed when the judge errors", async () => {
    const judge: Judge = async () => {
      throw new Error("model down");
    };
    const r = await checkAnswer({
      answer: "Shipping is not refunded.",
      items,
      denyTopics: [],
      rules: RULES,
      judge,
    });
    expect(r).toMatchObject({ ok: false, reason: "guard_failed" });
  });
});
