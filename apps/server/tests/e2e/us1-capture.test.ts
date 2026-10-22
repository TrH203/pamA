// Quickstart Scenario 1 end to end: real `pama` binary, real server (PGlite, fake provider),
// a Claude Code transcript with a fake AWS key, hook → draft digest → review → approve.
// Needs `cargo build -p pama-cli` first; skipped otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");
const PAMA = join(ROOT, "target/debug", process.platform === "win32" ? "pama.exe" : "pama");
const SID = "7c1e2f30-0000-4a1b-9c2d-3e4f5a6b7c8d";
const FIXTURE = join(ROOT, "crates/pama-core/tests/fixtures/claude/2.1/-Users-dev-work-shop");

describe.skipIf(!existsSync(PAMA))("US1 capture → review (quickstart scenario 1)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pama-e2e-"));
  const project = join(tmp, "shop");
  const claudeDir = join(tmp, "claude");
  const env = {
    ...process.env,
    HOME: tmp,
    PAMA_HOME: join(tmp, ".pama"),
    CLAUDE_CONFIG_DIR: claudeDir,
    PAMA_SERVER_CMD: `node --import tsx ${join(ROOT, "apps/server/src/index.ts")}`,
    PAMA_CHAT_PROVIDER: "fake",
    PAMA_CHAT_MODEL: "fake",
    PAMA_EMBED_PROVIDER: "fake",
    PAMA_EMBED_MODEL: "fake",
    PAMA_RULES_DIR: join(ROOT, "rules"),
    PAMA_PORT: String(7500 + Math.floor(Math.random() * 200)),
  };
  const pama = (args: string[], input?: string) => {
    const r = spawnSync(PAMA, args, {
      env,
      input,
      encoding: "utf8",
      cwd: join(ROOT, "apps/server"),
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const json = (args: string[]) => {
    const r = pama([...args, "--json"]);
    expect(r.code, r.err).toBe(0);
    return JSON.parse(r.out);
  };

  /** Put a transcript where Claude Code would, with cwd pointing at our temp project. */
  function writeSession(id: string) {
    const dir = join(claudeDir, "projects", project.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const text = readFileSync(join(FIXTURE, `${SID}.jsonl`), "utf8")
      .replaceAll("/Users/dev/work/shop", project)
      .replaceAll(SID, id);
    writeFileSync(join(dir, `${id}.jsonl`), text);
    if (id === SID) cpSync(join(FIXTURE, SID), join(dir, id), { recursive: true });
    return join(dir, `${id}.jsonl`);
  }

  function hook(id: string, path: string) {
    const r = pama(
      ["hook", "claude"],
      JSON.stringify({
        session_id: id,
        transcript_path: path,
        cwd: project,
        hook_event_name: "SessionEnd",
        reason: "exit",
      }),
    );
    expect(r.code).toBe(0);
  }

  beforeAll(() => {
    mkdirSync(project, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "feat/refund-shipping"], { cwd: project });
  });

  afterAll(() => {
    pama(["server", "stop"]);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("init → hook → draft digest without secrets → approve", { timeout: 120_000 }, async () => {
    const init = json(["init", "--project", project, "--agent", "claude"]);
    expect(init.changes.join("\n")).toMatch(/SessionEnd hook/);
    expect(existsSync(join(project, ".claude/settings.local.json"))).toBe(true);

    hook(SID, writeSession(SID));
    const review = await vi.waitFor(
      () => {
        const r = json(["review"]);
        if (r.items.length < 1) throw new Error("no draft yet");
        return r;
      },
      { timeout: 90_000, interval: 1_000 },
    );
    const d = review.items[0];
    const raw = JSON.stringify(d);
    expect(raw).not.toContain("AKIA");
    expect(raw).not.toContain("S3cretPw0rd");
    expect(d.content.redactions.secret).toBeGreaterThanOrEqual(1);
    expect(d.content.decisions[0].why).toMatch(/carrier fee/);
    expect(d.bundle).toBe("feat/refund-shipping");

    // A second session on the same branch joins the same bundle.
    hook("second-session-0001", writeSession("second-session-0001"));
    const both = await vi.waitFor(
      () => {
        const r = json(["review"]);
        if (r.items.length < 2) throw new Error("waiting for the second draft");
        return r;
      },
      { timeout: 90_000, interval: 1_000 },
    );
    expect(new Set(both.items.map((i: { bundle_id: string }) => i.bundle_id)).size).toBe(1);

    const ok = json(["review", "--approve", d.id]);
    expect(ok.status).toBe("approved");
    expect(json(["review"]).items).toHaveLength(1);
  });
});
