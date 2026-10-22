import { describe, expect, it } from "vitest";
import { heuristicClassify, heuristicDigest } from "../../src/llm/heuristic.ts";

describe("heuristic fake digester", () => {
  it("extracts goal, decisions with reasons, outcome and modules from the transcript only", () => {
    const d = heuristicDigest(
      [
        "[user] Should refunds include the shipping fee?",
        "[tool read] src/refunds/service.ts",
        "[assistant] Decision: refunds will not include the shipping fee because the carrier fee is non-refundable.",
        "[assistant] Done. Open item: confirm the policy wording with support.",
      ].join("\n"),
    );
    expect(d.goal).toBe("Should refunds include the shipping fee?");
    expect(d.decisions[0]).toEqual({
      what: "refunds will not include the shipping fee",
      why: "the carrier fee is non-refundable.",
      alternatives: [],
    });
    expect(d.open_items).toEqual(["confirm the policy wording with support."]);
    expect(d.modules).toEqual(["refunds"]);
  });

  it("labels items by keywords", () => {
    expect(
      heuristicClassify("id: d1\ntext: rotate the database key\n---\nid: g\ntext: fix a typo")
        .items,
    ).toEqual([
      { id: "d1", labels: ["infra"] },
      { id: "g", labels: [] },
    ]);
  });
});
