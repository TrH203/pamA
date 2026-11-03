// Structured digest editor model and its validation against the shared digest schema
// (packages/types/schema/session-digest.schema.json). Limits are read from the schema itself so
// the editor and the server (Zod, same contract) agree.
import schema from "@pama/types/schema/session-digest.schema.json";
import type { DigestContent } from "./types.ts";

interface StrSchema {
  minLength?: number;
  maxLength?: number;
}
interface ArrSchema {
  maxItems?: number;
  items: StrSchema & { enum?: string[] };
}

const P = schema.properties;
const D = P.decisions.items.properties;

export const LIMITS = {
  goal: P.goal as StrSchema,
  outcome: P.outcome as StrSchema,
  decisions: { maxItems: P.decisions.maxItems },
  what: D.what as StrSchema,
  why: D.why as StrSchema,
  alternatives: D.alternatives as ArrSchema,
  labels: (D.labels as ArrSchema).items.enum ?? [],
  open_items: P.open_items as ArrSchema,
  modules: P.modules as ArrSchema,
};

export const LABELS: readonly string[] = LIMITS.labels;

export interface DecisionDraft {
  /** Stable React key; schema ids are renumbered 1..n on save. */
  key: string;
  what: string;
  why: string;
  /** One alternative per line. */
  alternatives: string;
  labels: string[];
}

export interface EditorModel {
  goal: string;
  decisions: DecisionDraft[];
  outcome: string;
  open_items: string[];
  modules: string[];
}

let seq = 0;
export const newKey = () => `d${++seq}`;

export function toModel(c: DigestContent): EditorModel {
  return {
    goal: c.goal,
    decisions: c.decisions.map((d) => ({
      key: newKey(),
      what: d.what,
      why: d.why ?? "",
      alternatives: (d.alternatives ?? []).join("\n"),
      labels: [...(d.labels ?? [])],
    })),
    outcome: c.outcome ?? "",
    open_items: [...c.open_items],
    modules: [...c.modules],
  };
}

const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);

/** The digest to send: the original with the edited fields; blank list entries are dropped. */
export function fromModel(m: EditorModel, original: DigestContent): DigestContent {
  return {
    ...original,
    goal: m.goal.trim(),
    decisions: m.decisions.map((d, i) => {
      const alternatives = clean(d.alternatives.split("\n"));
      return {
        id: i + 1,
        what: d.what.trim(),
        why: d.why.trim(),
        ...(alternatives.length ? { alternatives } : {}),
        ...(d.labels.length
          ? { labels: [...new Set(d.labels)] as DigestContent["decisions"][number]["labels"] }
          : {}),
      };
    }),
    outcome: m.outcome.trim(),
    open_items: clean(m.open_items),
    modules: clean(m.modules),
  };
}

export type FieldError =
  | { code: "required" }
  | { code: "tooLong"; max: number }
  | { code: "tooMany"; max: number };

/** Field path (`goal`, `decisions.0.what`, `open_items.2`, …) → error. Empty when valid. */
export type Errors = Record<string, FieldError>;

function text(errors: Errors, path: string, value: string, s: StrSchema, required = false) {
  const v = value.trim();
  if ((required || (s.minLength ?? 0) > 0) && !v) errors[path] = { code: "required" };
  else if (s.maxLength !== undefined && v.length > s.maxLength)
    errors[path] = { code: "tooLong", max: s.maxLength };
}

function list(errors: Errors, path: string, values: string[], s: ArrSchema) {
  const kept = values.map((v, i) => [v.trim(), i] as const).filter(([v]) => v);
  if (s.maxItems !== undefined && kept.length > s.maxItems)
    errors[path] = { code: "tooMany", max: s.maxItems };
  for (const [v, i] of kept) {
    if (s.items.maxLength !== undefined && v.length > s.items.maxLength)
      errors[`${path}.${i}`] = { code: "tooLong", max: s.items.maxLength };
  }
}

export function validate(m: EditorModel): Errors {
  const errors: Errors = {};
  text(errors, "goal", m.goal, LIMITS.goal, true);
  text(errors, "outcome", m.outcome, LIMITS.outcome);
  const max = LIMITS.decisions.maxItems;
  if (max !== undefined && m.decisions.length > max) errors.decisions = { code: "tooMany", max };
  m.decisions.forEach((d, i) => {
    text(errors, `decisions.${i}.what`, d.what, LIMITS.what, true);
    text(errors, `decisions.${i}.why`, d.why, LIMITS.why);
    const alts = d.alternatives.split("\n");
    const altErrors: Errors = {};
    list(altErrors, "a", alts, LIMITS.alternatives);
    const first = Object.values(altErrors)[0];
    if (first) errors[`decisions.${i}.alternatives`] = first;
  });
  list(errors, "open_items", m.open_items, LIMITS.open_items);
  list(errors, "modules", m.modules, LIMITS.modules);
  return errors;
}
