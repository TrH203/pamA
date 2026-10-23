// Layer-3 rule port: same corpus and golden outputs as crates/pama-core/tests/redaction_rules.rs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuleSet, shannon, translateRe2 } from "../../src/safety/rules.ts";

const rulesDir = join(import.meta.dirname, "../../../../rules");
const rs = loadRuleSet(rulesDir);

function cases(kind: "positives" | "negatives") {
  const dir = join(rulesDir, "tests", kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((name) => {
      const raw = readFileSync(join(dir, name), "utf8").replaceAll("{{}}", "");
      const secrets: string[] = [];
      const body: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("# secret: ")) secrets.push(line.slice("# secret: ".length));
        else body.push(line);
      }
      // Match Rust's `lines()` + join: a trailing newline does not create an extra line.
      if (body.at(-1) === "") body.pop();
      return { name, secrets, text: body.join("\n") };
    });
}

describe("rule loading", () => {
  it("translates every pama.toml rule to JavaScript", () => {
    expect(rs.report.untranslated.filter((u) => u.file === "pama.toml")).toEqual([]);
  });

  it("translates the vendored gitleaks rules", () => {
    expect(rs.report.untranslated).toEqual([]);
    expect(rs.report.compiled).toBeGreaterThanOrEqual(221);
  });
});

describe("RE2 → JS translation", () => {
  it("scopes a mid-pattern (?i) to the rest of the group, across alternatives", () => {
    expect(translateRe2("a(?i)b|c").source).toBe("a(?i:b)|(?i:c)");
    expect(translateRe2("(?i)^true|false$").source).toBe("(?i:^true)|(?i:false$)");
    expect(translateRe2("x(y(?i)z)w").source).toBe("x(y(?i:z))w");
  });

  it("maps RE2-only escapes and literal braces", () => {
    expect(translateRe2("abc\\z").source).toBe("abc$");
    expect(translateRe2("^\\$(?:\\d+|{\\d+})$").source).toBe("^\\$(?:\\d+|\\{\\d+\\})$");
    expect(translateRe2("a\\sb").source).toBe("a[\\t\\n\\f\\r ]b");
    expect(translateRe2("[[:alnum:]_]").source).toBe("[a-zA-Z0-9_]");
    expect(translateRe2("(?P<k>x)").source).toBe("(?<k>x)");
  });

  it("computes entropy like gitleaks", () => {
    expect(shannon("abcd")).toBeCloseTo(2);
    expect(shannon("aaaa")).toBe(0);
  });
});

describe("redaction corpus (parity with Rust golden outputs)", () => {
  for (const c of cases("positives")) {
    it(`positive ${c.name}`, () => {
      const out = rs.redact(c.text);
      for (const s of c.secrets) expect(out.text).not.toContain(s);
      const golden = readFileSync(join(rulesDir, "tests/expected", c.name), "utf8");
      expect(out.text).toBe(golden);
      const total = Object.values(out.counts.by_rule).reduce((a, b) => a + b, 0);
      expect(total).toBe(out.counts.secret + out.counts.pii);
    });
  }

  for (const c of cases("negatives")) {
    it(`negative ${c.name}`, () => {
      const out = rs.redact(c.text);
      expect(out.text).toBe(c.text);
      expect(out.counts.secret + out.counts.pii).toBe(0);
    });
  }
});
