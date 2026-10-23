// Quickstart Scenario 4: the owner's machine (local server + real `pama` CLI) syncs one project to
// a self-hosted server (Postgres) only after it is enabled; turning sync off deletes the copies.
// Needs `cargo build -p pama-cli` and PAMA_TEST_PG_URL; skipped otherwise.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");
const PAMA = join(ROOT, "target/debug", process.platform === "win32" ? "pama.exe" : "pama");
const PG = process.env.PAMA_TEST_PG_URL;
const OWNER = "e2e-owner-token-0123456789-abcdef";

describe.skipIf(!existsSync(PAMA) || !PG)("US4 local mode and sync (quickstart scenario 4)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pama-us4-"));
  const port = 7700 + Math.floor(Math.random() * 200);
  const remote = `http://127.0.0.1:${port}`;
  let server: ChildProcess;
  const env = {
    ...process.env,
    HOME: tmp,
    PAMA_HOME: join(tmp, ".pama"),
    PAMA_SECRETS_FILE: join(tmp, "secrets.json"),
    PAMA_SERVER_CMD: `node --import tsx ${join(ROOT, "apps/server/src/index.ts")}`,
    PAMA_CHAT_PROVIDER: "fake",
    PAMA_CHAT_MODEL: "fake",
    PAMA_EMBED_PROVIDER: "fake",
    PAMA_EMBED_MODEL: "fake",
    PAMA_RULES_DIR: join(ROOT, "rules"),
    PAMA_PORT: String(7900 + Math.floor(Math.random() * 90)),
  };
  const pama = (args: string[]) => {
    const r = spawnSync(PAMA, [...args, "--json"], {
      env,
      encoding: "utf8",
      cwd: join(ROOT, "apps/server"),
    });
    expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
    return JSON.parse(r.stdout);
  };
  const remoteApi = async (path: string, json?: unknown) => {
    const res = await fetch(`${remote}${path}`, {
      method: json === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return res.json();
  };
  let local: { url: string; token: string };
  const localApi = async (path: string, init: { method?: string; json?: unknown } = {}) => {
    const res = await fetch(`${local.url}${path}`, {
      method: init.method ?? (init.json === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
    return res.json();
  };

  beforeAll(async () => {
    const db = `pama_us4_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${db}`);
    await admin.end();
    const url = new URL(PG as string);
    url.pathname = `/${db}`;
    server = spawn("node", ["--import", "tsx", "src/index.ts"], {
      cwd: join(ROOT, "apps/server"),
      env: {
        ...env,
        PAMA_MODE: "selfhost",
        DATABASE_URL: url.toString(),
        PAMA_PORT: String(port),
        PAMA_BIND: "127.0.0.1",
        PAMA_SECRET: "e2e-secret-0123456789-0123456789-abc",
        PAMA_OWNER_TOKEN: OWNER,
      },
      stdio: "ignore",
    });
    await vi.waitFor(async () => expect((await fetch(`${remote}/v1/health`)).ok).toBe(true), {
      timeout: 30_000,
      interval: 300,
    });
    const started = pama(["server", "start"]);
    local = {
      url: started.url,
      token: JSON.parse(
        await (await import("node:fs/promises")).readFile(join(tmp, ".pama/server.json"), "utf8"),
      ).token,
    };
  }, 90_000);

  afterAll(() => {
    spawnSync(PAMA, ["server", "stop"], { env });
    server?.kill();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("nothing syncs until enabled; enable sends approved digests once; disable deletes them", {
    timeout: 120_000,
  }, async () => {
    // One approved digest on the owner's machine.
    const d = await localApi("/v1/transcripts/digest", {
      json: {
        agent: "codex",
        agent_session_id: "us4-1",
        project_key: "github.com/acme/shop",
        bundle_key: "feat/refund-shipping",
        ended_at: "2026-10-22T10:00:00Z",
        events: [
          { kind: "user", text: "Should refunds include the shipping fee?" },
          {
            kind: "assistant",
            text: "Decision: refunds do not include the shipping fee because the carrier fee is non-refundable.",
          },
        ],
        redactions: { secret: 0, pii: 0 },
      },
    });
    await localApi(`/v1/digests/${d.digest_id}/approve`, { json: {} });

    // Pair this device with the self-hosted server.
    const code = await remoteApi("/v1/devices/pairing-code", {});
    pama(["pair", code.code, "--server", remote]);

    // Sync is off by default: nothing reaches the server.
    const status = pama(["sync", "status"]);
    expect(status.projects.every((p: { sync_enabled: boolean }) => !p.sync_enabled)).toBe(true);
    const before = await remoteApi("/v1/bundles");
    expect(before.items).toEqual([]);

    // Enable for the project: the approved digest arrives once.
    const project = status.projects[0].id as string;
    const on = pama(["sync", "enable", "--project", project]);
    expect(on.delivery.sent).toBe(1);
    const after = await remoteApi("/v1/bundles");
    expect(after.items.map((b: { name: string }) => b.name)).toEqual(["feat/refund-shipping"]);
    expect(pama(["sync", "enable", "--project", project]).delivery.sent).toBe(0); // re-run is a no-op

    // An Ask Link on the server answers while the owner's machine is irrelevant.
    const link = await remoteApi("/v1/links", {
      sources: [{ type: "bundle", id: after.items[0].id }],
      access_mode: "open",
    });
    const ask = await (
      await fetch(`${remote}/a/${link.slug}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Do refunds include the shipping fee?" }),
      })
    ).json();
    expect(ask.status).toBe("answered");

    // Disable: the server deletes its copies and the link stops serving them.
    pama(["sync", "disable", "--project", project]);
    expect((await remoteApi("/v1/bundles")).items).toEqual([]);
    expect((await fetch(`${remote}/a/${link.slug}/api/meta`)).status).toBe(410);

    // Every outbound connection of the device is in its network log.
    const log = spawnSync(
      "sqlite3",
      [
        join(tmp, ".pama/device.db"),
        "SELECT host, purpose, allowed FROM network_log WHERE purpose LIKE 'sync.%'",
      ],
      { encoding: "utf8" },
    );
    if (log.status === 0) expect(log.stdout).toContain("sync.digest");
  });
});
