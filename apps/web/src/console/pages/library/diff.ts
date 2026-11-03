// A "diff-ish" comparison of two digest versions: per section, which lines only the newer has
// (added), only the older has (removed) or both share. Line order follows the newer version, with
// removed lines after it.
import type { DigestFull } from "./data.ts";

export type DiffMark = "added" | "removed" | "same";
export interface DiffSection {
  key: "goal" | "decisions" | "outcome" | "open_items" | "modules";
  lines: { mark: DiffMark; text: string }[];
}

type Content = DigestFull["content"];

function lines(c: Content, key: DiffSection["key"]): string[] {
  switch (key) {
    case "goal":
      return c.goal ? [c.goal] : [];
    case "outcome":
      return c.outcome ? [c.outcome] : [];
    case "decisions":
      return c.decisions.map((d) => (d.why ? `${d.what} — ${d.why}` : d.what));
    case "open_items":
      return c.open_items;
    case "modules":
      return c.modules;
  }
}

const KEYS: DiffSection["key"][] = ["goal", "decisions", "outcome", "open_items", "modules"];

export function diffDigests(older: Content, newer: Content): DiffSection[] {
  return KEYS.map((key) => {
    const a = lines(older, key);
    const b = lines(newer, key);
    const inA = new Set(a);
    const inB = new Set(b);
    return {
      key,
      lines: [
        ...b.map((text) => ({ text, mark: (inA.has(text) ? "same" : "added") as DiffMark })),
        ...a
          .filter((text) => !inB.has(text))
          .map((text) => ({ text, mark: "removed" as DiffMark })),
      ],
    };
  }).filter((s) => s.lines.length > 0);
}

export function hasChanges(sections: DiffSection[]): boolean {
  return sections.some((s) => s.lines.some((l) => l.mark !== "same"));
}
