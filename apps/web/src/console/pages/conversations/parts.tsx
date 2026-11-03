// Small pieces shared by the Conversations and Chat pages: the status chip of a turn and the
// citation chips that open the cited digest item in the Library.
import { useI18n } from "@pama/i18n";
import { cn, StatusPill } from "@pama/ui";
import { Link } from "@tanstack/react-router";
import { BookOpen, CircleCheck, CircleDot, MessageSquareReply, TriangleAlert } from "lucide-react";
import { type Citation, LIBRARY_SEARCH, librarySearchFor, turnTone } from "./api.ts";

export function TurnStatus({ status, replied }: { status: string; replied: boolean }) {
  const { t } = useI18n();
  const s = t.convo.status;
  const key = replied ? "owner_answered" : status;
  const icon = replied
    ? MessageSquareReply
    : status === "answered" || status === "drafted"
      ? CircleCheck
      : status === "forwarded"
        ? CircleDot
        : status === "refused"
          ? TriangleAlert
          : undefined;
  return (
    <StatusPill tone={turnTone(status, replied)} icon={icon}>
      {s[key] ?? status}
    </StatusPill>
  );
}

/** A label for a citation: the server's label, else the item kind and a short text. */
export function citationLabel(c: Citation): string {
  if (c.label) return c.label;
  const text = c.text ? (c.text.length > 60 ? `${c.text.slice(0, 57)}…` : c.text) : c.item_id;
  return c.kind ? `${c.kind.replace("_", " ")} · ${text}` : text;
}

export function CitationChips({
  citations,
  className,
}: {
  citations: Citation[];
  className?: string;
}) {
  const { t } = useI18n();
  const unique = citations.filter(
    (c, i) => citations.findIndex((x) => x.item_id === c.item_id) === i,
  );
  if (!unique.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-xs text-muted", className)}>
      <span>{t.convo.chat.sources}:</span>
      <ul className="contents">
        {unique.map((c, i) => (
          <li key={c.item_id} className="contents">
            <Link
              to={LIBRARY_SEARCH}
              search={{ q: librarySearchFor(c) }}
              title={c.text ?? t.convo.chat.openInLibrary}
              aria-label={`[${i + 1}] ${citationLabel(c)}. ${t.convo.chat.openInLibrary}`}
              className="inline-flex h-6 max-w-full items-center gap-1 truncate rounded-full border border-line bg-subtle px-2 font-medium text-muted transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-ring"
            >
              <BookOpen aria-hidden className="size-3 shrink-0" />
              <span className="truncate">
                [{i + 1}] {citationLabel(c)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
