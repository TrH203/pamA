// Branch names can carry secrets or personal data (spec 002 FR-014): they must be masked in the
// stored digest, in session_branches and in everything handed to the sync worker.
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  classifyReply,
  DIGEST_REPLY,
  makeCtx,
  routeFake,
  type TestCtx,
  transcriptInput,
} from "../helpers/ctx.ts";
import { pglite } from "../helpers/db.ts";

const SECRET_BRANCH = "acme-corp/AKIAZ7Q4PL2XWN3VB5KD-deal";
const PII_BRANCH = "fix/lan.tran@acme-corp.vn-escalation";
const RAW = ["AKIAZ7Q4PL2XWN3VB5KD", "lan.tran@acme-corp.vn"];

let t: TestCtx;
beforeEach(async () => {
  t = await makeCtx(pglite);
  routeFake(t.fake, { digest: () => DIGEST_REPLY, classify: classifyReply });
});
afterEach(() => t.close());

async function ingest() {
  const res = await t.req("/v1/transcripts/digest", {
    json: transcriptInput({
      bundle_key: SECRET_BRANCH,
      git: {
        branch: SECRET_BRANCH,
        branches: [
          { name: PII_BRANCH, events: 2 },
          { name: SECRET_BRANCH, events: 5 },
        ],
      },
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { digest_id: string; session_id: string; bundle_id: string };
}
const noRaw = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const r of RAW) expect(json).not.toContain(r);
};

it("masks branch names in the stored digest and in session_branches", async () => {
  const d = await ingest();
  const [row] = await t.db.query<{ content: unknown }>(
    "SELECT content FROM digests WHERE id = $1",
    [d.digest_id],
  );
  noRaw(row?.content);
  expect(JSON.stringify(row?.content)).toContain("[SECRET:aws-access-token]");
  expect(JSON.stringify(row?.content)).toContain("[PII:email]");
  const names = await t.db.query("SELECT name FROM session_branches WHERE session_id = $1", [
    d.session_id,
  ]);
  noRaw(names);
  expect(JSON.stringify(names)).toContain("[SECRET:aws-access-token]");
});

it("masks branch and bundle names in what the sync worker receives", async () => {
  const d = await ingest();
  const pending = async () =>
    (await (await t.req("/v1/sync/pending")).json()) as {
      digests: { bundle_name: string; digest: unknown }[];
      tombstones: { source_key: string; source_type: string }[];
    };
  // Sync is off by default: nothing is listed at all.
  expect(await pending()).toEqual({ digests: [], tombstones: [] });

  await t.req(`/v1/digests/${d.digest_id}/approve`, { json: {} });
  const [p] = await t.db.query<{ id: string }>("SELECT id FROM projects");
  await t.req(`/v1/projects/${p?.id}`, {
    method: "PATCH",
    json: { sync_enabled: true, sync_target: "https://pama.acme.vn" },
  });
  // The owner may name a bundle after the branch, secret included.
  await t.req(`/v1/bundles/${d.bundle_id}`, {
    method: "PATCH",
    json: { name: "Rotate AKIAZ7Q4PL2XWN3VB5KD for lan.tran@acme-corp.vn" },
  });
  const out = await pending();
  expect(out.digests).toHaveLength(1);
  noRaw(out);
  expect(out.digests[0]?.bundle_name).toBe("Rotate [SECRET:aws-access-token] for [PII:email]");

  // A bundle tombstone names the bundle by key: masked the same way as the replica's key.
  await t.req(`/v1/bundles/${d.bundle_id}`, { method: "PATCH", json: { sync_enabled: false } });
  const after = await pending();
  noRaw(after);
  expect(after.tombstones).toEqual([
    expect.objectContaining({
      source_type: "bundle",
      source_key: "github.com/acme/shop#acme-corp/[SECRET:aws-access-token]-deal",
    }),
  ]);
});
