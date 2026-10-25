// Doctor report for the console. Device state (capture, hooks, outbox) lives in the Rust CLI's
// store, so the local server runs `pama doctor --report` and relays its JSON.
import { execFile } from "node:child_process";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";

const TIMEOUT_MS = 15_000;

function runDoctor(bin: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Exit code 1 only means "some check failed"; the report is still on stdout.
    execFile(
      bin,
      ["doctor", "--report"],
      { timeout: TIMEOUT_MS, maxBuffer: 4_000_000 },
      (err, stdout) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            new HttpError(
              503,
              "doctor_unavailable",
              err ? `cannot run \`${bin} doctor\`: ${err.message}` : "doctor printed no report",
            ),
          );
        }
      },
    );
  });
}

// Each run is a fresh process that reads the OS keychain (a prompt unless "Always Allow"), so
// reuse a recent report; `?fresh=1` (the Re-run button) bypasses it.
const CACHE_MS = 60_000;
let inflight: Promise<unknown> | null = null;
let cached: { bin: string; at: number; report: unknown } | null = null;

export const doctorRoutes = new Hono<Env>().get("/doctor", async (c) => {
  if (c.get("deps").config.mode !== "local") {
    throw new HttpError(404, "not_found", "doctor is available on the owner's machine only");
  }
  const bin = process.env.PAMA_BIN ?? "pama";
  const fresh = c.req.query("fresh") === "1";
  if (cached?.bin === bin && !fresh && Date.now() - cached.at < CACHE_MS) {
    return c.json({ ...(cached.report as object), at: cached.at });
  }
  // Polling tabs share one child process.
  inflight ??= runDoctor(bin)
    .then((report) => {
      cached = { bin, at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inflight = null;
    });
  return c.json({ ...((await inflight) as object), at: Date.now() });
});
