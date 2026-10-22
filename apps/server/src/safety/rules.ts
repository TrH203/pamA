// TypeScript port of the shared redaction rules (Layer 3 re-scan, and Layer 1 re-check at ingest).
// Mirrors crates/pama-core/src/redact; both runtimes are tested against rules/tests/expected.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export const RULE_FILES = ["gitleaks.toml", "pama.toml"] as const;

export type Category = "secret" | "pii";

export interface Counts {
  secret: number;
  pii: number;
  by_rule: Record<string, number>;
}

export interface Redacted {
  text: string;
  counts: Counts;
}

export interface CompileReport {
  compiled: number;
  untranslated: { file: string; id: string; reason: string }[];
}

interface Allowlist {
  regexes: RegExp[];
  stopwords: string[];
  paths: RegExp[];
  target: "secret" | "match" | "line";
  and: boolean;
}

interface Rule {
  id: string;
  regex: RegExp | null;
  path: RegExp | null;
  secretGroup: number | null;
  entropy: number | null;
  keywords: string[];
  allowlists: Allowlist[];
  category: Category;
}

export interface StructuralRule {
  id: string;
  tool: string;
  pathGlob: string[];
  commandRegex: RegExp | null;
  action: "drop_content" | "redact_all";
}

export class UntranslatableError extends Error {}

const RE2_SPACE = "\\t\\n\\f\\r ";
const POSIX: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  ascii: "\\x00-\\x7F",
  blank: "\\t ",
  cntrl: "\\x00-\\x1F\\x7F",
  digit: "0-9",
  graph: "!-~",
  lower: "a-z",
  print: " -~",
  punct: "!-\\/:-@\\[-`{-~",
  space: `${RE2_SPACE}\\v`,
  upper: "A-Z",
  word: "a-zA-Z0-9_",
  xdigit: "0-9A-Fa-f",
};

function isRepetition(p: string, i: number): string | null {
  const end = p.indexOf("}", i);
  if (end < 0) return null;
  const body = p.slice(i + 1, end);
  return /^\d+(,\d*)?$/.test(body) ? body : null;
}

/**
 * Translate an RE2 pattern to a JavaScript (non-`u`) RegExp source with the same meaning:
 * standalone flag groups `(?i)` are scoped to the rest of their group (re-opened after each `|`),
 * `\z` → `$`, `\A` → `^`, `\s` → ASCII whitespace, POSIX classes expanded, `(?P<` → `(?<`, and
 * braces that are not repetitions escaped.
 */
export function translateRe2(pattern: string): { source: string; flags: string } {
  const p = pattern;
  let out = "";
  // One frame per open group: flag scopes opened inside it that must close with it.
  const frames: string[][] = [[]];
  let prevRepeatable = false;
  let i = 0;
  const top = () => frames[frames.length - 1] as string[];
  const closeScopes = () => {
    out += ")".repeat(top().length);
  };
  const reopenScopes = () => {
    for (const f of top()) out += `(?${f}:`;
  };

  while (i < p.length) {
    const c = p[i] as string;
    if (c === "\\") {
      const n = p[i + 1];
      if (n === undefined) throw new UntranslatableError("trailing backslash");
      if (n === "z") out += "$";
      else if (n === "A") out += "^";
      else if (n === "s") out += `[${RE2_SPACE}]`;
      else if (n === "S") out += `[^${RE2_SPACE}]`;
      else if (n === "Q" || n === "p" || n === "P" || n === "C") {
        throw new UntranslatableError(`unsupported escape \\${n}`);
      } else if (n === "x" && p[i + 2] === "{") {
        const end = p.indexOf("}", i);
        const hex = p.slice(i + 3, end);
        if (hex.length > 2) throw new UntranslatableError("\\x{} above 0xFF");
        out += `\\x${hex.padStart(2, "0")}`;
        i = end + 1;
        prevRepeatable = true;
        continue;
      } else out += `\\${n}`;
      i += 2;
      prevRepeatable = true;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      let cls = "[";
      if (p[j] === "^") {
        cls += "^";
        j++;
      }
      if (p[j] === "]") {
        cls += "\\]";
        j++;
      }
      let hasS = false;
      let hasNotS = false;
      let body = "";
      while (j < p.length && p[j] !== "]") {
        const d = p[j] as string;
        if (d === "[" && p[j + 1] === ":") {
          const end = p.indexOf(":]", j + 2);
          const name = p.slice(j + 2, end);
          const exp = POSIX[name];
          if (end < 0 || exp === undefined) throw new UntranslatableError(`posix class ${name}`);
          body += exp;
          j = end + 2;
          continue;
        }
        if (d === "\\") {
          const n = p[j + 1] as string;
          if (n === "s") hasS = true;
          else if (n === "S") hasNotS = true;
          else if (n === "p" || n === "P") throw new UntranslatableError("unicode class");
          else body += `\\${n}`;
          j += 2;
          continue;
        }
        if (d === "[") body += "\\[";
        else body += d;
        j++;
      }
      if (j >= p.length) throw new UntranslatableError("unterminated class");
      i = j + 1;
      prevRepeatable = true;
      if (hasS && hasNotS) {
        out += `${cls}${body}\\s\\S]`;
        continue;
      }
      if (hasS) body += RE2_SPACE;
      if (hasNotS) {
        // [x\S] = x or any non-space; JS has no ASCII \S inside a class, so use an alternation.
        if (cls.startsWith("[^")) throw new UntranslatableError("\\S inside a negated class");
        out += body ? `(?:${cls}${body}]|[^${RE2_SPACE}])` : `[^${RE2_SPACE}]`;
        continue;
      }
      out += `${cls}${body}]`;
      continue;
    }
    if (c === "(") {
      if (p[i + 1] === "?") {
        const m = /^\(\?([a-zA-Z-]*)(\)|:)/.exec(p.slice(i));
        if (m && (m[1] as string).length > 0) {
          const flags = m[1] as string;
          if (/[^ims-]/.test(flags)) throw new UntranslatableError(`flags ${flags}`);
          if (m[2] === ")") {
            out += `(?${flags}:`;
            top().push(flags);
            i += m[0].length;
            prevRepeatable = false;
            continue;
          }
          out += `(?${flags}:`;
          frames.push([]);
          i += m[0].length;
          prevRepeatable = false;
          continue;
        }
        if (p.startsWith("(?P<", i)) {
          out += "(?<";
          frames.push([]);
          i += 4;
          prevRepeatable = false;
          continue;
        }
      }
      // Plain, non-capturing `(?:`, or named `(?<` group.
      const head = p.startsWith("(?:", i) ? "(?:" : p.startsWith("(?<", i) ? "(?<" : "(";
      out += head;
      frames.push([]);
      i += head.length;
      prevRepeatable = false;
      continue;
    }
    if (c === ")") {
      closeScopes();
      frames.pop();
      if (frames.length === 0) throw new UntranslatableError("unbalanced )");
      out += ")";
      i++;
      prevRepeatable = true;
      continue;
    }
    if (c === "|") {
      closeScopes();
      out += "|";
      reopenScopes();
      i++;
      prevRepeatable = false;
      continue;
    }
    if (c === "{") {
      const rep = isRepetition(p, i);
      if (rep !== null && prevRepeatable) {
        out += `{${rep}}`;
        i += rep.length + 2;
        prevRepeatable = false;
        continue;
      }
      out += "\\{";
      i++;
      prevRepeatable = true;
      continue;
    }
    if (c === "}") {
      out += "\\}";
      i++;
      prevRepeatable = true;
      continue;
    }
    out += c;
    i++;
    prevRepeatable = !"(|".includes(c);
  }
  if (frames.length !== 1) throw new UntranslatableError("unbalanced (");
  closeScopes();
  return { source: out, flags: "" };
}

function compile(pattern: string, global: boolean): RegExp {
  const { source } = translateRe2(pattern);
  return new RegExp(source, global ? "gd" : "");
}

/** Shannon entropy exactly like gitleaks: per-character counts over the UTF-8 byte length. */
export function shannon(data: string): number {
  if (data === "") return 0;
  const counts = new Map<string, number>();
  for (const ch of data) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const inv = 1 / Buffer.byteLength(data, "utf8");
  let e = 0;
  for (const n of counts.values()) {
    const f = n * inv;
    e -= f * Math.log2(f);
  }
  return e;
}

function placeholder(category: Category, id: string): string {
  return category === "pii" ? `[PII:${id}]` : `[SECRET:${id}]`;
}

const PLACEHOLDER = /\[(?:SECRET|PII):[A-Za-z0-9_-]*\]/g;

function placeholderRanges(s: string): [number, number][] {
  return [...s.matchAll(PLACEHOLDER)].map((m) => [m.index, m.index + m[0].length]);
}

function lineOf(s: string, a: number, b: number): string {
  const start = s.lastIndexOf("\n", a - 1) + 1;
  const nl = s.indexOf("\n", b);
  return s.slice(start, nl < 0 ? s.length : nl);
}

function allows(al: Allowlist, secret: string, matched: string, line: string, path?: string) {
  const hits: boolean[] = [];
  if (al.regexes.length) {
    const t = al.target === "match" ? matched : al.target === "line" ? line : secret;
    hits.push(al.regexes.some((r) => r.test(t)));
  }
  if (al.stopwords.length) {
    const lower = secret.toLowerCase();
    hits.push(al.stopwords.some((w) => lower.includes(w)));
  }
  if (al.paths.length) hits.push(path !== undefined && al.paths.some((r) => r.test(path)));
  if (!hits.length) return false;
  return al.and ? hits.every(Boolean) : hits.some(Boolean);
}

interface RawAllowlist {
  regexes?: string[];
  stopwords?: string[];
  paths?: string[];
  regexTarget?: string;
  condition?: string;
}

interface RawRule {
  id: string;
  regex?: string;
  path?: string;
  secretGroup?: number;
  entropy?: number;
  keywords?: string[];
  allowlists?: RawAllowlist[];
  category?: Category;
}

interface RawStructural {
  id: string;
  match: { tool: string; path_glob?: string[]; command_regex?: string };
  action: StructuralRule["action"];
}

function allowlist(raw: RawAllowlist): Allowlist {
  return {
    regexes: (raw.regexes ?? []).map((r) => compile(r, false)),
    stopwords: (raw.stopwords ?? []).map((w) => w.toLowerCase()),
    paths: (raw.paths ?? []).map((r) => compile(r, false)),
    target: raw.regexTarget === "match" ? "match" : raw.regexTarget === "line" ? "line" : "secret",
    and: raw.condition?.toUpperCase() === "AND",
  };
}

export class RuleSet {
  constructor(
    private readonly rules: Rule[],
    private readonly global: Allowlist[],
    readonly structural: StructuralRule[],
    readonly report: CompileReport,
  ) {}

  categoryOf(id: string): Category | undefined {
    return this.rules.find((r) => r.id === id)?.category;
  }

  redact(text: string, path?: string): Redacted {
    let cur = text;
    let lower = cur.toLowerCase();
    const counts: Counts = { secret: 0, pii: 0, by_rule: {} };
    for (const rule of this.rules) {
      if (!rule.regex) continue;
      if (rule.path && !(path !== undefined && rule.path.test(path))) continue;
      if (rule.keywords.length && !rule.keywords.some((k) => lower.includes(k))) continue;
      const spans = this.find(rule, rule.regex, cur, path);
      if (!spans.length) continue;
      const ph = placeholder(rule.category, rule.id);
      let next = "";
      let last = 0;
      for (const [a, b] of spans) {
        next += cur.slice(last, a) + ph;
        last = b;
      }
      next += cur.slice(last);
      counts[rule.category] += spans.length;
      counts.by_rule[rule.id] = (counts.by_rule[rule.id] ?? 0) + spans.length;
      cur = next;
      lower = cur.toLowerCase();
    }
    return { text: cur, counts };
  }

  private find(rule: Rule, re: RegExp, text: string, path?: string): [number, number][] {
    const spans: [number, number][] = [];
    const existing = placeholderRanges(text);
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const idx = m.indices;
      if (!idx) continue;
      const whole = idx[0] as [number, number];
      let sec: [number, number] | undefined;
      if (rule.secretGroup !== null) {
        sec = idx[rule.secretGroup];
        if (!sec) continue;
      } else {
        sec = whole;
        for (let g = 1; g < idx.length; g++) {
          const r = idx[g];
          if (r && r[1] > r[0]) {
            sec = r;
            break;
          }
        }
      }
      const [a, b] = sec;
      if (b <= a) continue;
      if (existing.some(([pa, pb]) => a < pb && pa < b)) continue;
      const secret = text.slice(a, b);
      if (rule.entropy !== null) {
        if (shannon(secret) <= rule.entropy) continue;
        if (rule.id.startsWith("generic") && !/[0-9]/.test(secret)) continue;
      }
      const matched = text.slice(whole[0], whole[1]);
      const line = lineOf(text, whole[0], whole[1]);
      if (
        [...this.global, ...rule.allowlists].some((al) => allows(al, secret, matched, line, path))
      )
        continue;
      const prev = spans.at(-1);
      if (prev && a < prev[1]) continue;
      spans.push([a, b]);
    }
    return spans;
  }
}

export function ruleSetFromSources(sources: [name: string, toml: string][]): RuleSet {
  const rules: Rule[] = [];
  const global: Allowlist[] = [];
  const structural: StructuralRule[] = [];
  const report: CompileReport = { compiled: 0, untranslated: [] };
  for (const [file, src] of sources) {
    const raw = parseToml(src) as {
      allowlist?: RawAllowlist;
      rules?: RawRule[];
      structural?: RawStructural[];
    };
    if (raw.allowlist) global.push(allowlist(raw.allowlist));
    for (const r of raw.rules ?? []) {
      try {
        rules.push({
          id: r.id,
          regex: r.regex ? compile(r.regex, true) : null,
          path: r.path ? compile(r.path, false) : null,
          secretGroup: r.secretGroup && r.secretGroup > 0 ? r.secretGroup : null,
          entropy: r.entropy && r.entropy > 0 ? r.entropy : null,
          keywords: (r.keywords ?? []).map((k) => k.toLowerCase()),
          allowlists: (r.allowlists ?? []).map(allowlist),
          category: r.category ?? "secret",
        });
        if (r.regex) report.compiled++;
      } catch (e) {
        // Untranslatable rules stay enforced by the Rust Layer 1 only (contracts/redaction-rules.md).
        report.untranslated.push({ file, id: r.id, reason: (e as Error).message });
      }
    }
    for (const s of raw.structural ?? []) {
      structural.push({
        id: s.id,
        tool: s.match.tool,
        pathGlob: s.match.path_glob ?? [],
        commandRegex: s.match.command_regex ? compile(s.match.command_regex, false) : null,
        action: s.action,
      });
    }
  }
  return new RuleSet(rules, global, structural, report);
}

export function loadRuleSet(dir: string): RuleSet {
  return ruleSetFromSources(RULE_FILES.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}
