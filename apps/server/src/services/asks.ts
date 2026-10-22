// Asks: one question with its outcome; the audit log and the owner's inbox (FR-015, FR-017).
import { ulid } from "ulid";
import type { Deps } from "../app.ts";
import { HttpError } from "../http.ts";
import type { AnswerResult } from "../pipeline/answer.ts";

export async function recordAsk(
  deps: Pick<Deps, "db" | "workspaceId">,
  a: {
    origin: "link" | "hotkey";
    linkSlug?: string;
    visitorId?: string;
    question: string;
    result: AnswerResult;
  },
): Promise<string> {
  const id = ulid();
  const r = a.result;
  await deps.db.query(
    `INSERT INTO asks (id, workspace_id, origin, link_slug, visitor_id, question, language, status, reason, answer, citations, confidence, guard)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      deps.workspaceId,
      a.origin,
      a.linkSlug ?? null,
      a.visitorId ?? null,
      a.question,
      r.language,
      a.origin === "hotkey" ? "drafted" : r.status,
      r.reason ?? null,
      r.answer ?? null,
      JSON.stringify(
        r.citations.map(({ item_id, digest_id, digest_version }) => ({
          item_id,
          digest_id,
          digest_version,
        })),
      ),
      r.confidence,
      r.guard ? JSON.stringify(r.guard) : null,
    ],
  );
  return id;
}

export async function forwardAsk(
  deps: Pick<Deps, "db">,
  slug: string,
  visitorId: string,
  askId: string,
) {
  const [a] = await deps.db.query<{ status: string }>(
    "SELECT status FROM asks WHERE id = $1 AND link_slug = $2 AND visitor_id = $3",
    [askId, slug, visitorId],
  );
  if (!a) throw new HttpError(404, "not_found", "question not found");
  if (a.status !== "refused")
    throw new HttpError(409, "conflict", "This question was already forwarded or answered.");
  await deps.db.query("UPDATE asks SET status = 'forwarded' WHERE id = $1", [askId]);
}

export async function replyToAsk(
  deps: Pick<Deps, "db" | "workspaceId" | "mailer">,
  askId: string,
  text: string,
) {
  const [a] = await deps.db.query<{
    status: string;
    email: string | null;
    verified: boolean;
    question: string;
    title: string | null;
  }>(
    `UPDATE asks a SET status = 'owner_answered', owner_reply = $3, owner_replied_at = now()
     FROM (SELECT a2.id, v.email, v.verified_at IS NOT NULL AS verified, l.title
           FROM asks a2 LEFT JOIN visitors v ON v.id = a2.visitor_id LEFT JOIN ask_links l ON l.slug = a2.link_slug
           WHERE a2.id = $1 AND a2.workspace_id = $2) x
     WHERE a.id = x.id AND a.status IN ('forwarded', 'refused', 'owner_answered')
     RETURNING a.status, x.email, x.verified, a.question, x.title`,
    [askId, deps.workspaceId, text],
  );
  if (!a) throw new HttpError(404, "not_found", "no open question with this id");
  if (a.email && a.verified && deps.mailer.available) {
    await deps.mailer
      .send({
        to: a.email,
        subject: `Reply to your question${a.title ? ` about "${a.title}"` : ""}`,
        text: `You asked: ${a.question}\n\nReply from the owner:\n${text}`,
      })
      .catch(() => undefined); // the reply is on the link page either way
  }
}
