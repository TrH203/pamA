import { relativeTime, summarizeBundle } from "@pama/ui";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-10-24T12:00:00Z");
const base = {
  name: "Refund shipping fee",
  key: "feat/refund-shipping",
  branches: ["a", "b"],
  session_count: 2,
  last_activity: "2026-10-24T11:30:00Z",
};

describe("summarizeBundle", () => {
  it("uses the name as title and falls back to the key", () => {
    expect(summarizeBundle(base, NOW).title).toBe("Refund shipping fee");
    expect(summarizeBundle({ ...base, name: "" }, NOW).title).toBe("feat/refund-shipping");
    expect(summarizeBundle({ ...base, name: "", key: null }, NOW).title).toBe("Untitled bundle");
  });

  it("shows at most 3 chips and counts the rest", () => {
    const s = summarizeBundle({ ...base, branches: ["a", "b", "c", "d", "e"] }, NOW);
    expect(s.chips).toEqual(["a", "b", "c"]);
    expect(s.overflow).toBe(2);
    expect(s.allBranches).toEqual(["a", "b", "c", "d", "e"]);
    expect(summarizeBundle({ ...base, branches: ["a", "b", "c"] }, NOW).overflow).toBe(0);
  });

  it("labels the session count", () => {
    expect(summarizeBundle({ ...base, session_count: 1 }, NOW).sessionsLabel).toBe("1 session");
    expect(summarizeBundle({ ...base, session_count: 4 }, NOW).sessionsLabel).toBe("4 sessions");
  });

  it("handles missing last activity", () => {
    expect(summarizeBundle({ ...base, last_activity: null }, NOW).lastActivityLabel).toBeNull();
  });
});

describe("relativeTime", () => {
  it.each([
    ["2026-10-24T11:59:40Z", "just now"],
    ["2026-10-24T11:30:00Z", "30 min ago"],
    ["2026-10-24T09:00:00Z", "3 h ago"],
    ["2026-10-22T12:00:00Z", "2 d ago"],
    ["2026-08-01T12:00:00Z", "2026-08-01"],
  ])("%s → %s", (iso, want) => {
    expect(relativeTime(iso, NOW)).toBe(want);
  });
});
