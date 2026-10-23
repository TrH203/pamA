// Zod mirror of packages/types/schema/session-digest.schema.json (contract-tested against Ajv).
import { z } from "zod";

const DATE_TIME = z.iso.datetime({ offset: true });

export const AgentSchema = z.enum(["claude_code", "codex"]);
export const SensitivityLabelSchema = z.enum(["business_sensitive", "infra", "customer"]);
export type SensitivityLabel = z.infer<typeof SensitivityLabelSchema>;
export const SENSITIVITY_LABELS = SensitivityLabelSchema.options;

export const DecisionSchema = z.strictObject({
  id: z.int().min(1),
  what: z.string().min(1).max(1000),
  why: z.string().max(1000),
  alternatives: z.array(z.string().max(500)).max(10).optional(),
  labels: z
    .array(SensitivityLabelSchema)
    .refine((l) => new Set(l).size === l.length, "labels must be unique")
    .optional(),
});

/** One branch a session visited; the list is in first-seen order with unique names. */
export const BranchVisitSchema = z.strictObject({
  name: z.string().min(1).max(256),
  first_seen: DATE_TIME.optional(),
  last_seen: DATE_TIME.optional(),
  events: z.int().min(0).optional(),
});
export const MAX_BRANCHES = 20;
export const BranchListSchema = z
  .array(BranchVisitSchema)
  .max(MAX_BRANCHES)
  .refine((l) => new Set(l.map((b) => b.name)).size === l.length, "branch names must be unique");

export const SessionDigestSchema = z.strictObject({
  schema_version: z.literal(1),
  source: z.strictObject({
    agent: AgentSchema,
    agent_session_id: z.string().min(1).max(128),
    agent_version: z.string().max(64).optional(),
    project_key: z.string().max(256),
    bundle_key: z.string().max(256).optional(),
    git: z
      .strictObject({
        branch: z.string().max(256).optional(),
        branches: BranchListSchema.optional(),
        commits: z
          .array(z.string().regex(/^[0-9a-f]{7,40}$/))
          .max(50)
          .optional(),
      })
      .optional(),
    started_at: DATE_TIME.optional(),
    ended_at: DATE_TIME,
  }),
  goal: z.string().min(1).max(1000),
  decisions: z.array(DecisionSchema).max(30),
  outcome: z.string().max(1000),
  open_items: z.array(z.string().max(500)).max(20),
  modules: z.array(z.string().max(100)).max(30),
  redactions: z.strictObject({
    secret: z.int().min(0),
    pii: z.int().min(0),
    by_rule: z.record(z.string(), z.int().min(0)).optional(),
  }),
  provenance: z
    .strictObject({
      prompt_version: z.string().optional(),
      model: z.string().optional(),
      produced_at: DATE_TIME.optional(),
    })
    .optional(),
});

export type SessionDigest = z.infer<typeof SessionDigestSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
