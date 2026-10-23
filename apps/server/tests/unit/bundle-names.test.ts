import { expect, it } from "vitest";
import { suggestName } from "../../src/services/bundles.ts";

it("uses the goal, minus trailing punctuation", () => {
  expect(suggestName("Decide whether refunds include the shipping fee.")).toBe(
    "Decide whether refunds include the shipping fee",
  );
});

it("keeps at most 60 characters and cuts at a word boundary", () => {
  const goal =
    "Investigate and fix the flaky checkout integration test that fails on CI every other run";
  const name = suggestName(goal) ?? "";
  expect(name.length).toBeLessThanOrEqual(60);
  expect(goal.startsWith(name)).toBe(true);
  expect(goal[name.length]).toBe(" ");
  expect(name).not.toMatch(/[\s.,;:!?-]$/);
});

it("hard-cuts a single very long word", () => {
  expect(suggestName("x".repeat(100))).toBe("x".repeat(60));
});

it("uses only the first line and collapses whitespace", () => {
  expect(suggestName("  Add   refund\tflow \nsecond line is ignored")).toBe("Add refund flow");
});

it("returns null when there is nothing usable", () => {
  expect(suggestName("")).toBeNull();
  expect(suggestName("   \n  ")).toBeNull();
  expect(suggestName("...")).toBeNull();
});
