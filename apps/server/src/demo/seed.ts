// Approved digests in two projects so Ask Link tests do not depend on capture (US2 independent
// of US1). Project B and its secrets must never show up through a link scoped to project A.
import { ulid } from "ulid";
import type { LabelMap } from "../pipeline/items.ts";
import type { SessionDigest } from "../schema/digest.ts";
import { assignBundle } from "../services/bundles.ts";
import { type PipelineDeps, storeVersion } from "../services/digests.ts";
import { upsertProject } from "../services/projects.ts";

export interface Seeded {
  projectA: string;
  projectB: string;
  bundleRefund: string;
  bundleCheckout: string;
  bundleSandbox: string;
  sessions: Record<string, string>;
  /** Item ids per session name. */
  items: Record<string, string[]>;
}

function digest(
  session: string,
  projectKey: string,
  bundle: string,
  over: Partial<SessionDigest>,
): SessionDigest {
  return {
    schema_version: 1,
    source: {
      agent: "claude_code",
      agent_session_id: session,
      project_key: projectKey,
      bundle_key: bundle,
      ended_at: "2026-10-20T09:00:00Z",
    },
    goal: "",
    decisions: [],
    outcome: "",
    open_items: [],
    modules: [],
    redactions: { secret: 0, pii: 0 },
    ...over,
  };
}

const SESSIONS: {
  name: string;
  project: "A" | "B";
  bundle: string;
  d: Partial<SessionDigest>;
  labels?: LabelMap;
}[] = [
  {
    name: "refund-1",
    project: "A",
    bundle: "feat/refund-shipping",
    d: {
      goal: "Decide whether refunds include the shipping fee.",
      decisions: [
        {
          id: 1,
          what: "Refunds do not include the shipping fee.",
          why: "The carrier fee is already paid to the carrier and is non-refundable.",
          alternatives: ["Refund the shipping fee only for damaged items"],
        },
        {
          id: 2,
          what: "Refund requests are processed within 3 business days.",
          why: "Support needs time to check the returned parcel.",
        },
      ],
      outcome: "The refund service excludes shipping; unit tests cover damaged and normal returns.",
      open_items: ["Confirm the refund policy wording with the support team"],
      modules: ["refunds", "checkout"],
    },
  },
  {
    name: "refund-2",
    project: "A",
    bundle: "feat/refund-shipping",
    d: {
      goal: "Move refund processing to a background worker.",
      decisions: [
        {
          id: 1,
          what: "Run refunds on the internal worker cluster refund-worker-01 behind the VPN.",
          why: "The payment provider limits concurrent calls.",
        },
      ],
      outcome: "Refunds are queued and retried automatically.",
      modules: ["refunds", "worker"],
    },
    labels: { d1: ["infra"] },
  },
  {
    name: "checkout-1",
    project: "A",
    bundle: "fix/flaky-checkout-test",
    d: {
      goal: "Fix the flaky checkout test.",
      decisions: [
        {
          id: 1,
          what: "The checkout test waits for the payment mock to be ready instead of sleeping.",
          why: "Fixed sleeps failed on slow CI machines.",
          alternatives: ["Raise the timeout to 10 seconds"],
        },
        {
          id: 2,
          what: "Enterprise customers get a 15% discount on annual plans.",
          why: "Agreed with sales for the Q4 campaign.",
        },
      ],
      outcome: "The checkout test is stable across 50 CI runs.",
      modules: ["checkout", "tests"],
    },
    labels: { d2: ["business_sensitive"] },
  },
  {
    name: "sandbox-1",
    project: "B",
    bundle: "main",
    d: {
      goal: "Set up the payment-sandbox project for the partner integration.",
      decisions: [
        {
          id: 1,
          what: "payment-sandbox uses the partner test merchant account with webhook signing enabled.",
          why: "The partner requires signed webhooks.",
        },
      ],
      outcome: "payment-sandbox processes test payments end to end.",
      modules: ["payment-sandbox"],
    },
  },
];

export async function seed(deps: PipelineDeps): Promise<Seeded> {
  const ws = deps.workspaceId;
  const a = await upsertProject(deps.db, ws, "github.com/acme/shop", "shop");
  const b = await upsertProject(deps.db, ws, "github.com/acme/payment-sandbox", "payment-sandbox");
  const out: Seeded = {
    projectA: a.id,
    projectB: b.id,
    bundleRefund: "",
    bundleCheckout: "",
    bundleSandbox: "",
    sessions: {},
    items: {},
  };
  for (const s of SESSIONS) {
    const project = s.project === "A" ? a : b;
    const bundleId = await assignBundle(deps.db, ws, project.id, s.bundle);
    if (s.bundle === "feat/refund-shipping") out.bundleRefund = bundleId;
    if (s.bundle === "fix/flaky-checkout-test") out.bundleCheckout = bundleId;
    if (s.project === "B") out.bundleSandbox = bundleId;
    const sessionId = ulid();
    await deps.db.query(
      `INSERT INTO sessions (id, workspace_id, project_id, bundle_id, agent, agent_session_id, ended_at)
       VALUES ($1, $2, $3, $4, 'claude_code', $5, now())`,
      [sessionId, ws, project.id, bundleId, s.name],
    );
    const d = digest(s.name, project.repo_key, s.bundle, s.d);
    const { id } = await storeVersion(deps, {
      sessionId,
      bundleId,
      projectId: project.id,
      digest: d,
      labels: s.labels ?? {},
      status: "approved",
    });
    out.sessions[s.name] = sessionId;
    out.items[s.name] = (
      await deps.db.query<{ id: string }>(
        "SELECT id FROM digest_items WHERE digest_id = $1 ORDER BY id",
        [id],
      )
    ).map((r) => r.id);
  }
  return out;
}
