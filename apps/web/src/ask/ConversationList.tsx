// The asker's conversations on this link (spec 008, US2): open one, or delete it. After email
// verification the list also holds conversations started on the asker's other devices.
import { useI18n } from "@pama/i18n";
import { Button, cn, Dialog, DialogContent, DialogTrigger, useConfirm, useToast } from "@pama/ui";
import { MessagesSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type ConversationSummary } from "./api.ts";

export function ConversationList({
  items,
  current,
  onOpen,
  onDeleted,
}: {
  items: ConversationSummary[];
  current: string | null;
  onOpen: (id: string) => Promise<unknown> | undefined;
  onDeleted: (id: string) => Promise<unknown> | undefined;
}) {
  const { t: all } = useI18n();
  const t = all.convo.ask;
  const confirm = useConfirm();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const shown = items.filter((c) => c.turns > 0 || c.id === current);

  const remove = async (c: ConversationSummary) => {
    const ok = await confirm({
      title: t.deleteTitle,
      description: t.deleteBody,
      confirmLabel: all.convo.detail.delete,
      danger: true,
    });
    if (!ok) return;
    setBusy(c.id);
    try {
      await api.deleteConversation(c.id);
      toast.success(t.deleted);
      await onDeleted(c.id);
    } catch {
      toast.error(t.deleteFailed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary">
          <MessagesSquare aria-hidden />
          {t.conversations}
          {shown.length > 0 && <span className="tabular-nums text-faint">{shown.length}</span>}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t.conversations}
        description={t.resumeHint}
        closeLabel={all.common.close}
      >
        {shown.length === 0 ? (
          <p className="text-ui text-muted">{t.noConversations}</p>
        ) : (
          <ul className="-mx-1 space-y-1">
            {shown.map((c) => {
              const title = c.title || t.untitled;
              const isCurrent = c.id === current;
              return (
                <li key={c.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-current={isCurrent ? "true" : undefined}
                    aria-label={t.open(title)}
                    onClick={async () => {
                      setOpen(false);
                      if (!isCurrent) await onOpen(c.id);
                    }}
                    className={cn(
                      "min-w-0 flex-1 rounded-control px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                      isCurrent ? "bg-accent-soft text-accent-ink" : "hover:bg-hover",
                    )}
                  >
                    <span className="block truncate text-sm font-medium">{title}</span>
                    <span className="block text-xs text-muted">
                      {new Date(c.last_at).toLocaleString()} · {all.convo.list.turns(c.turns)}
                      {isCurrent ? ` · ${t.current}` : ""}
                    </span>
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t.delete(title)}
                    loading={busy === c.id}
                    onClick={() => void remove(c)}
                  >
                    {busy !== c.id && <Trash2 aria-hidden />}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
