// Pure helpers for showing runs: labels, times, tones and the stage timeline.
import type { Locale, Messages } from "@pama/i18n";
import type { Tone } from "@pama/ui";
import type { DigestInfo, Run, RunStage, RunStatus } from "./api.ts";

export const STATUS_TONE: Record<RunStatus, Tone> = {
  queued: "neutral",
  running: "accent",
  succeeded: "success",
  failed: "danger",
};

/** "claude code · my-project · 3f2a91c4": what a person recognises a run by. */
export function runLabel(r: Pick<Run, "agent" | "project_key" | "agent_session_id">): string {
  const parts = [r.agent.replaceAll("_", " ")];
  if (r.project_key) parts.push(r.project_key);
  parts.push(r.agent_session_id.slice(0, 8));
  return parts.join(" · ");
}

/** Relative time in the viewer's language ("3 minutes ago", "3 phút trước"). */
export function ago(iso: string, locale: Locale, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const s = Math.round((at - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3_600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3_600), "hour");
  return rtf.format(Math.round(s / 86_400), "day");
}

export function absolute(iso: string, locale: Locale): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function duration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  if (ms < 1_000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

export function hintFor(code: string | null, t: Messages): string {
  if (!code) return t.pipeline.unknownHint;
  return t.pipeline.hints[code] ?? t.pipeline.unknownHint;
}

/** Codes fixed by changing a model or key: offer a direct link to Settings → Connections. */
export function isConfigError(code: string | null): boolean {
  return (
    code === "provider_auth" ||
    code === "provider_unreachable" ||
    code === "model_timeout" ||
    code === "invalid_model_output" ||
    code === "provider_error"
  );
}

export type StepState = "done" | "failed" | "current" | "pending" | "skipped";
export interface Step {
  key: string;
  state: StepState;
  device?: boolean;
}

const SERVER_STAGES: RunStage[] = ["received", "drafted", "classified", "embedded", "stored"];

/**
 * The full timeline of a run: device stages (done before the server ever saw the session),
 * server stages from `run.stage`/`run.status`, then approval and publishing from the digest.
 */
export function timeline(run: Run, digest?: DigestInfo | null): Step[] {
  const steps: Step[] = (["detected", "parsed", "redacted"] as const).map((key) => ({
    key,
    state: "done",
    device: true,
  }));
  const reached = SERVER_STAGES.indexOf(run.stage);
  SERVER_STAGES.forEach((key, i) => {
    let state: StepState;
    if (run.status === "succeeded") state = "done";
    else if (i <= reached) state = "done";
    else if (i === reached + 1)
      state = run.status === "failed" ? "failed" : run.status === "queued" ? "pending" : "current";
    else state = "pending";
    steps.push({ key, state });
  });
  const stored = run.status === "succeeded";
  const approved = digest?.status === "approved" || digest?.status === "superseded";
  steps.push({
    key: "approved",
    state: !stored ? "pending" : approved ? "done" : digest ? "current" : "pending",
  });
  // Publishing (local mode's one-way copy) is tracked per project in Library, not per run.
  steps.push({ key: "published", state: approved ? "skipped" : "pending" });
  return steps;
}
