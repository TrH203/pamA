// Digest → retrievable items. Ids are stable within a digest version: `<digest_id>#<local>`.
import type { ItemKind } from "../db/schema/digest.ts";
import type { SensitivityLabel, SessionDigest } from "../schema/digest.ts";

export interface DraftItem {
  /** Local id inside the digest: g, d1…, o, i1…, m. */
  local: string;
  kind: ItemKind;
  text: string;
  rationale: string | null;
  alternatives: string[];
}

const clip = (s: string) => (s.length > 1000 ? `${s.slice(0, 997)}...` : s);

export function itemsOf(d: SessionDigest): DraftItem[] {
  const items: DraftItem[] = [
    { local: "g", kind: "goal", text: clip(d.goal), rationale: null, alternatives: [] },
  ];
  for (const x of d.decisions) {
    items.push({
      local: `d${x.id}`,
      kind: "decision",
      text: clip(x.what),
      rationale: x.why || null,
      alternatives: x.alternatives ?? [],
    });
  }
  if (d.outcome) {
    items.push({
      local: "o",
      kind: "outcome",
      text: clip(d.outcome),
      rationale: null,
      alternatives: [],
    });
  }
  d.open_items.forEach((t, i) => {
    items.push({
      local: `i${i + 1}`,
      kind: "open_item",
      text: clip(t),
      rationale: null,
      alternatives: [],
    });
  });
  if (d.modules.length) {
    items.push({
      local: "m",
      kind: "module",
      text: clip(`Modules touched: ${d.modules.join(", ")}`),
      rationale: null,
      alternatives: [],
    });
  }
  return items;
}

/** Text that is embedded and searched for an item. */
export function itemSearchText(i: DraftItem): string {
  return [
    i.text,
    i.rationale,
    i.alternatives.length ? `Rejected: ${i.alternatives.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type LabelMap = Record<string, SensitivityLabel[]>;
